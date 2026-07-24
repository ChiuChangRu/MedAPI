import previousWorker from "./worker-v46.js";

const STANDARD_TITLES = new Map([
  ["ISO_7886-1", "無菌皮下注射器－第1部：手動使用注射器"],
  ["ISO_7886-2", "無菌皮下注射器－第2部：動力驅動注射泵用注射器"],
  ["ISO_7886-3", "無菌皮下注射器－第3部：固定劑量免疫用自毀式注射器"],
  ["ISO_7886-4", "無菌皮下注射器－第4部：具防止重複使用功能的注射器"],
  ["ISO_8536-12", "醫療用輸液器具－第12部：單次使用止回閥"],
  ["ISO_8536-14", "醫療用輸液器具－第14部：非接液式輸血與輸液器具用夾具及流量調節器"],
  ["ISO_10555-1", "血管內導管－無菌及單次使用導管－第1部：一般要求"],
  ["ISO_10555-8", "血管內導管－無菌及單次使用導管－第8部：體外血液處理用導管"],
  ["ISO_10993-4", "醫療器材生物性評估－第4部：與血液交互作用試驗選擇"],
]);

const SAFE_DEFAULT_YEARS = new Map([
  ["ISO_7886-1", "2017"],
  ["ISO_7886-2", "2020"],
  ["ISO_7886-3", "2020"],
  ["ISO_7886-4", "2018"],
  ["ISO_8536-14", "2016"],
]);

let noteSchemaReady = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const url = new URL(request.url);
  const expected = String(env.FIELD_PIN || "").trim();
  const supplied = String(request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
  return Boolean(expected) && supplied === expected;
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function ensureAttachmentNoteSchema(env) {
  if (noteSchemaReady || !env.DB) return;
  await env.DB.prepare("ALTER TABLE attachments ADD COLUMN note TEXT DEFAULT ''").run().catch(() => {});
  noteSchemaReady = true;
}

async function logHistory(env, entryId, folderId, action, detail) {
  await env.DB.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(entryId || null, folderId || null, action, String(detail || "").slice(0, 200), timestamp()).run().catch(() => {});
}

function cleanPart(value, max = 150) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|#]+/g, " ")
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function parseStandard(att) {
  const filenameSource = `${att.original_filename || ""}\n${att.filename || ""}`;
  const fullSource = `${filenameSource}\n${att.ocr_text || ""}`;
  const pattern = /\b(EN[\s_-]+ISO|ISO(?:[\s_-]*\/[\s_-]*(?:TS|TR))?|IEC|ASTM|JIS)[\s_:\-]*([A-Z]?\d{3,6}(?:-\d{1,3})?)(?:[\s_:\-]*((?:19|20)\d{2}))?/i;
  const match = filenameSource.match(pattern) || fullSource.match(pattern);
  if (!match) return null;
  const org = match[1].toUpperCase()
    .replace(/[\s_-]+ISO$/, "_ISO")
    .replace(/[\s_-]*\/[\s_-]*/g, "_")
    .replace(/\s+/g, "_");
  const number = match[2].toUpperCase();
  let year = match[3] || "";
  if (!year && att.ocr_text) {
    const escapedOrg = org.replace(/_/g, "[\\s_-]+");
    const escapedNumber = number.replace(/-/g, "[\\s_-]*-[\\s_-]*");
    const exact = String(att.ocr_text).match(
      new RegExp(escapedOrg + "[\\s_:\\-]*" + escapedNumber + "[\\s_:\\-]*((?:19|20)\\d{2})", "i")
    );
    if (exact) year = exact[1];
  }
  const key = `${org}_${number}`;
  if (!year) year = SAFE_DEFAULT_YEARS.get(key) || "";
  return { org, number, year, key };
}

function existingChineseTitle(att) {
  const stem = cleanPart(att.filename || "");
  const parts = stem.split("_");
  const index = parts.findIndex((part) => /[\u3400-\u9fff]/.test(part));
  return index >= 0 ? cleanPart(parts.slice(index).join("_"), 150) : "";
}

async function normalizeAttachmentName(env, attachmentId) {
  const att = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first();
  if (!att) return { error: "找不到附件", status: 404 };
  const isPdf = (att.mime || "") === "application/pdf" || String(att.filename || "").toLowerCase().endsWith(".pdf");
  if (!isPdf) return { ok: true, renamed: false, filename: att.filename };
  const standard = parseStandard(att);
  if (!standard) return { ok: true, renamed: false, filename: att.filename };
  if (!standard.year) return { ok: true, renamed: false, incomplete_year: true, filename: att.filename };
  const title = STANDARD_TITLES.get(standard.key) || existingChineseTitle(att) || "標準文件";
  const next = `${standard.org}_${standard.number}_${standard.year}_${cleanPart(title, 150)}.pdf`;
  if (next === att.filename) return { ok: true, renamed: false, filename: next };
  await env.DB.prepare(
    "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
  ).bind(next, attachmentId).run();
  await logHistory(env, att.entry_id, null, "自動重新命名", `${att.filename} → ${next}`);
  return { ok: true, renamed: true, filename: next };
}

async function moveAttachment(env, attachmentId, folderId) {
  const target = await env.DB.prepare("SELECT id, name FROM folders WHERE id = ?").bind(folderId).first();
  if (!target) return { error: "找不到目標資料夾", status: 404 };

  const attachment = await env.DB.prepare(
    `SELECT a.*, e.folder_id AS source_folder_id, e.title AS entry_title
     FROM attachments a JOIN entries e ON e.id = a.entry_id
     WHERE a.id = ?`
  ).bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };
  if (attachment.source_pdf_id) return { error: "處理用頁面不能單獨移動", status: 400 };
  if (Number(attachment.source_folder_id || 0) === Number(folderId)) {
    return { ok: true, moved: false, entry_id: attachment.entry_id, folder_id: folderId };
  }

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ? AND source_pdf_id IS NULL"
  ).bind(attachment.entry_id).first();
  const primaryCount = Number(countRow?.count || 0);

  if (primaryCount <= 1) {
    await env.DB.prepare(
      "UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?"
    ).bind(folderId, timestamp(), attachment.entry_id).run();
    await logHistory(env, attachment.entry_id, folderId, "移動檔案", `${attachment.filename} → ${target.name}`);
    return { ok: true, moved: true, split: false, entry_id: attachment.entry_id, folder_id: folderId };
  }

  const title = String(attachment.filename || "檔案").replace(/\.[^.]+$/, "").slice(0, 120);
  const created = timestamp();
  const inserted = await env.DB.prepare(
    "INSERT INTO entries (folder_id, title, fields_json, body, created_at, updated_at) VALUES (?, ?, '{}', '', ?, ?)"
  ).bind(folderId, title, created, created).run();
  const newEntryId = Number(inserted.meta.last_row_id);

  try {
    await env.DB.prepare(
      "UPDATE attachments SET entry_id = ? WHERE id = ? OR source_pdf_id = ?"
    ).bind(newEntryId, attachmentId, attachmentId).run();
  } catch (error) {
    await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(newEntryId).run().catch(() => {});
    throw error;
  }

  await logHistory(env, attachment.entry_id, attachment.source_folder_id, "移出附件", attachment.filename);
  await logHistory(env, newEntryId, folderId, "移入檔案", `${attachment.filename} → ${target.name}`);
  return { ok: true, moved: true, split: true, entry_id: newEntryId, folder_id: folderId };
}

async function deleteAttachment(env, attachmentId) {
  const attachment = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };

  const { results: pages } = await env.DB.prepare(
    "SELECT id, key FROM attachments WHERE source_pdf_id = ?"
  ).bind(attachmentId).all();

  if (env.FILES) {
    for (const page of pages || []) {
      await env.FILES.delete(page.key).catch(() => {});
    }
    await env.FILES.delete(attachment.key).catch(() => {});
  }

  for (const page of pages || []) {
    await env.DB.prepare("DELETE FROM ai_usage_reservations WHERE attachment_id = ?")
      .bind(page.id).run().catch(() => {});
  }
  await env.DB.prepare("DELETE FROM ai_usage_reservations WHERE attachment_id = ?")
    .bind(attachmentId).run().catch(() => {});
  await env.DB.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(attachmentId).run();
  await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachmentId).run();
  await logHistory(env, attachment.entry_id, null, "刪除附件", attachment.filename);

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ?"
  ).bind(attachment.entry_id).first();

  let entryRemoved = false;
  if (Number(remaining?.count || 0) === 0) {
    const entry = await env.DB.prepare(
      "SELECT body, fields_json FROM entries WHERE id = ?"
    ).bind(attachment.entry_id).first();
    let hasFields = false;
    try {
      hasFields = Object.values(JSON.parse(entry?.fields_json || "{}")).some((value) => String(value || "").trim());
    } catch {
      hasFields = true;
    }
    if (!String(entry?.body || "").trim() && !hasFields) {
      await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(attachment.entry_id).run();
      entryRemoved = true;
    }
  }

  return { ok: true, entry_removed: entryRemoved, pages_removed: (pages || []).length };
}

const SINGLE_FILE_UI = String.raw`
;(() => {
  if (window.__fieldlogSingleAttachmentMoveDelete) return;
  window.__fieldlogSingleAttachmentMoveDelete = true;

  let focusedFile = null;
  const originalOpenEntry = openEntry;
  const originalCloseEntry = closeEntry;
  const originalOpenFolder = openFolder;

  const style = document.createElement("style");
  style.id = "fieldlog-single-attachment-style";
  style.textContent = [
    ".folder-file-row{display:grid!important;grid-template-columns:28px minmax(0,1fr) auto 40px 40px!important;align-items:center!important;gap:8px!important}",
    ".folder-file-row[draggable=true]{cursor:grab}",
    ".folder-file-row.dragging{opacity:.42}",
    ".folder-file-icon{grid-column:1!important;grid-row:1!important;cursor:grab}",
    ".folder-file-name{grid-column:2!important;grid-row:1!important;min-width:0!important;overflow-wrap:anywhere!important}",
    ".folder-file-meta{grid-column:3!important;grid-row:1!important;white-space:nowrap!important}",
    ".folder-file-delete{grid-column:4!important;grid-row:1!important;min-width:40px!important;color:#b91c1c!important}",
    ".folder-file-manage{grid-column:5!important;grid-row:1!important;justify-self:end!important;min-width:40px!important;white-space:nowrap!important}",
    ".child-folder-card.file-drop-target{outline:3px solid #0f766e!important;outline-offset:2px;background:#ecfdf9!important}",
    ".file-note-box{margin:14px 0}",
    ".file-note-box textarea{min-height:130px}",
    ".file-detail-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 14px}",
    ".file-detail-danger{margin-top:22px;padding-top:14px;border-top:1px solid #fecaca;text-align:right}",
    "@media(max-width:719px){.folder-file-row{grid-template-columns:26px minmax(0,1fr) 38px 38px!important;gap:6px!important}.folder-file-meta{display:none!important}.folder-file-delete{grid-column:3!important}.folder-file-manage{grid-column:4!important}}"
  ].join("");
  document.head.appendChild(style);

  folderFileHtml = function singleAttachmentFolderRow(a, entryId) {
    const url = "/api/file/" + encodeURIComponent(a.key) + "?pin=" + encodeURIComponent(pin());
    const ext = String(a.filename || "").split(".").pop().toLowerCase();
    const icon = isPdfAtt(a) ? "📕" : a.kind === "photo" ? "🖼️" : a.kind === "audio" ? "🎙️"
      : ["doc", "docx"].includes(ext) ? "📘" : ["xls", "xlsx", "csv"].includes(ext) ? "📊"
        : ["ppt", "pptx"].includes(ext) ? "📙" : "📄";
    return '<div class="folder-file-row" draggable="true" data-entry-id="' + entryId + '" data-att-id="' + a.id + '" data-filename="' + esc(a.filename) + '">' +
      '<span class="folder-file-icon" title="拖曳到上方子資料夾">' + icon + '</span>' +
      '<a class="folder-file-name" href="' + url + '" target="_blank" rel="noopener">' + esc(a.filename) + '</a>' +
      '<span class="folder-file-meta">' + esc(String(a.created_at || "").slice(5, 16)) + '</span>' +
      '<button class="folder-file-delete" type="button" data-entry-id="' + entryId + '" data-att-id="' + a.id + '" title="刪除這份檔案" aria-label="刪除這份檔案">🗑</button>' +
      '<button class="folder-file-manage" type="button" data-entry-id="' + entryId + '" data-att-id="' + a.id + '" title="管理這一份檔案" aria-label="管理這一份檔案">⋯</button>' +
      '</div>';
  };

  async function refreshFolderView() {
    await loadFolders();
    if (CURRENT_FOLDER) await openFolder(CURRENT_FOLDER.id);
    else await loadInbox();
  }

  async function removeOneFile(entryId, attachmentId, filename, closeDetail) {
    if (!confirm("確定刪除「" + filename + "」？只會刪除這一份檔案。")) return;
    await api("/attachments/" + attachmentId, { method: "DELETE" });
    showToast("檔案已刪除");
    if (closeDetail) {
      focusedFile = null;
      originalCloseEntry();
    }
    await refreshFolderView();
  }

  async function openFileDetail(entryId, attachmentId) {
    entryId = Number(entryId || 0);
    attachmentId = Number(attachmentId || 0);
    if (!entryId || !attachmentId) return;
    focusedFile = { entryId, attachmentId };

    const entry = await api("/entries/" + entryId);
    const sourceAttachments = (entry.attachments || []).filter((item) => !item.source_pdf_id);
    const attachment = sourceAttachments.find((item) => Number(item.id) === attachmentId);
    if (!attachment) {
      focusedFile = null;
      originalCloseEntry();
      showToast("這份檔案已不存在");
      await refreshFolderView();
      return;
    }

    const legacyNote = sourceAttachments.length === 1 ? String(entry.body || "").trim() : "";
    const noteValue = String(attachment.note || "").trim() || legacyNote;
    const originalName = attachment.original_filename && attachment.original_filename !== attachment.filename
      ? '<p class="sub">原始檔名：' + esc(attachment.original_filename) + '</p>' : '';
    const modal = document.getElementById("entry-modal");
    modal.innerHTML = [
      '<div class="modal-close-float"><button class="btn small ghost" id="file-detail-close" type="button" aria-label="關閉檔案" title="關閉檔案">✕</button></div>',
      '<div class="detail-head"><h2 style="margin:0;overflow-wrap:anywhere">' + esc(attachment.filename) + '</h2></div>',
      '<p class="sub">' + esc(attachment.created_at || entry.created_at || "") + (CURRENT_FOLDER ? '｜' + esc(CURRENT_FOLDER.name) : '') + '</p>',
      originalName,
      '<div class="file-note-box"><label for="file-note">此檔案的附屬記事</label><textarea id="file-note" placeholder="只屬於這一份檔案的記事">' + esc(noteValue) + '</textarea></div>',
      '<div class="file-detail-actions"><button class="btn primary" id="file-note-save" type="button">儲存記事</button><button class="btn small" id="file-normalize-name" type="button">🏷 整理中文檔名</button><span id="e-upload-status" class="sub"></span></div>',
      '<h3 class="section-title">檔案處理</h3>',
      '<div id="e-attachments" class="att-list">' + attHtml(attachment, entry.attachments || []) + '</div>',
      '<div class="file-detail-danger"><button class="btn entry-delete" id="file-delete" type="button">🗑 刪除這份檔案</button><p class="sub">只刪除目前檔案，不刪除其他附件。</p></div>'
    ].join("");

    document.getElementById("entry-overlay").classList.add("open");
    lockBodyScroll();
    document.getElementById("file-detail-close").onclick = closeEntry;
    bindAttActions(entryId);

    document.getElementById("file-note-save").onclick = async () => {
      const button = document.getElementById("file-note-save");
      button.disabled = true;
      try {
        await api("/attachments/" + attachmentId + "/note", {
          method: "PUT",
          body: JSON.stringify({ note: document.getElementById("file-note").value.trim() })
        });
        showToast("附屬記事已儲存");
      } catch (error) {
        showToast("記事儲存失敗：" + error.message);
      } finally {
        button.disabled = false;
      }
    };

    document.getElementById("file-normalize-name").onclick = async () => {
      const button = document.getElementById("file-normalize-name");
      button.disabled = true;
      button.textContent = "整理中…";
      try {
        const result = await api("/attachments/" + attachmentId + "/normalize-name", { method: "POST", body: "{}" });
        showToast(result.renamed ? "已更新中文檔名" : (result.incomplete_year ? "尚未確認年份，請先擷取文字或深度處理" : "檔名已是目前可確認的格式"));
        await refreshFolderView();
        await openFileDetail(entryId, attachmentId);
      } catch (error) {
        showToast("整理檔名失敗：" + error.message);
        button.disabled = false;
        button.textContent = "🏷 整理中文檔名";
      }
    };

    document.getElementById("file-delete").onclick = () => {
      removeOneFile(entryId, attachmentId, attachment.filename, true)
        .catch((error) => showToast("刪除失敗：" + error.message));
    };
  }

  openEntry = async function singleAttachmentAwareOpenEntry(id) {
    const entryId = Number(id || 0);
    if (focusedFile && focusedFile.entryId === entryId) {
      return openFileDetail(focusedFile.entryId, focusedFile.attachmentId);
    }
    return originalOpenEntry(entryId);
  };

  closeEntry = function singleAttachmentCloseEntry() {
    focusedFile = null;
    return originalCloseEntry();
  };

  function bindFileRows() {
    document.querySelectorAll(".folder-file-row[data-att-id]").forEach((row) => {
      if (row.dataset.fileBound === "1") return;
      row.dataset.fileBound = "1";

      const manage = row.querySelector(".folder-file-manage");
      if (manage) {
        manage.textContent = "⋯";
        manage.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          openFileDetail(manage.dataset.entryId, manage.dataset.attId)
            .catch((error) => showToast("開啟檔案失敗：" + error.message));
        };
      }

      const deleteButton = row.querySelector(".folder-file-delete");
      if (deleteButton) {
        deleteButton.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          removeOneFile(
            deleteButton.dataset.entryId,
            deleteButton.dataset.attId,
            row.dataset.filename || "這份檔案",
            false
          ).catch((error) => showToast("刪除失敗：" + error.message));
        };
      }

      row.ondragstart = (event) => {
        row.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-fieldlog-attachment", JSON.stringify({
          attachmentId: Number(row.dataset.attId),
          entryId: Number(row.dataset.entryId),
          filename: row.dataset.filename || "檔案"
        }));
      };
      row.ondragend = () => {
        row.classList.remove("dragging");
        document.querySelectorAll(".child-folder-card.file-drop-target").forEach((card) => card.classList.remove("file-drop-target"));
      };
    });
  }

  function hasAttachmentDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes("application/x-fieldlog-attachment");
  }

  function bindFolderDropTargets() {
    document.querySelectorAll(".child-folder-card[data-id]").forEach((card) => {
      if (card.dataset.fileDropBound === "1") return;
      card.dataset.fileDropBound = "1";
      card.ondragover = (event) => {
        if (!hasAttachmentDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        card.classList.add("file-drop-target");
      };
      card.ondragleave = () => card.classList.remove("file-drop-target");
      card.ondrop = async (event) => {
        if (!hasAttachmentDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("file-drop-target");
        let payload;
        try {
          payload = JSON.parse(event.dataTransfer.getData("application/x-fieldlog-attachment"));
        } catch {
          showToast("無法讀取拖曳的檔案");
          return;
        }
        const targetId = Number(card.dataset.id || 0);
        const targetName = card.querySelector("strong")?.textContent?.trim() || "子資料夾";
        if (!payload?.attachmentId || !targetId) return;
        if (!confirm("將「" + payload.filename + "」移入「" + targetName + "」？")) return;
        try {
          await api("/attachments/" + payload.attachmentId + "/move", {
            method: "POST",
            body: JSON.stringify({ folder_id: targetId })
          });
          showToast("已移入「" + targetName + "」");
          await refreshFolderView();
        } catch (error) {
          showToast("移動失敗：" + error.message);
        }
      };
    });
  }

  function bindAll() {
    bindFileRows();
    bindFolderDropTargets();
  }

  openFolder = async function singleAttachmentOpenFolder(id) {
    const result = await originalOpenFolder(id);
    bindAll();
    return result;
  };

  bindAll();
  new MutationObserver(bindAll).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

function noStoreResponse(body, response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      await ensureAttachmentNoteSchema(env);
    }

    const moveMatch = url.pathname.match(/^\/api\/attachments\/(\d+)\/move$/);
    if (moveMatch && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      const body = await request.json().catch(() => ({}));
      const folderId = Number(body.folder_id || 0);
      if (!folderId) return json({ error: "請指定目標資料夾" }, 400);
      try {
        const result = await moveAttachment(env, Number(moveMatch[1]), folderId);
        return json(result, result.status || 200);
      } catch (error) {
        return json({ error: `移動檔案失敗：${error.message}` }, 500);
      }
    }

    const deleteMatch = url.pathname.match(/^\/api\/attachments\/(\d+)$/);
    if (deleteMatch && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        const result = await deleteAttachment(env, Number(deleteMatch[1]));
        return json(result, result.status || 200);
      } catch (error) {
        return json({ error: `刪除檔案失敗：${error.message}` }, 500);
      }
    }

    const noteMatch = url.pathname.match(/^\/api\/attachments\/(\d+)\/note$/);
    if (noteMatch && request.method === "PUT") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      const id = Number(noteMatch[1]);
      const body = await request.json().catch(() => ({}));
      const note = String(body.note || "").trim().slice(0, 50000);
      const attachment = await env.DB.prepare("SELECT id, entry_id, filename FROM attachments WHERE id = ?").bind(id).first();
      if (!attachment) return json({ error: "找不到附件" }, 404);
      await env.DB.prepare("UPDATE attachments SET note = ? WHERE id = ?").bind(note, id).run();
      await logHistory(env, attachment.entry_id, null, "更新附件記事", `${attachment.filename}：${note.slice(0, 120)}`);
      return json({ ok: true });
    }

    const normalizeMatch = url.pathname.match(/^\/api\/attachments\/(\d+)\/normalize-name$/);
    if (normalizeMatch && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        const result = await normalizeAttachmentName(env, Number(normalizeMatch[1]));
        return json(result, result.status || 200);
      } catch (error) {
        return json({ error: `檔名整理失敗：${error.message}` }, 500);
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const html = (await response.text())
        .replace(/app\.js\?v=[^"' ]+/g, "app.js?v=49-files")
        .replace(/style\.css\?v=[^"' ]+/g, "style.css?v=49-files");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      return noStoreResponse(`${await response.text()}\n${SINGLE_FILE_UI}`, response, "application/javascript; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
