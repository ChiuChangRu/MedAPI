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

const OLD_V43_ACTIONS = '<button class="folder-file-doodle" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="在 PDF 上塗鴉並另存新附件">✍️ 塗鴉</button><button class="folder-file-manage" type="button" data-entry-id="${entryId}" title="管理附件、OCR 與刪除" aria-label="管理附件">⋯</button>';
const OLD_DETAIL_ACTION = '<button class="folder-file-manage" type="button" data-entry-id="${entryId}">詳情</button>';
const V49_ACTION = '<button class="folder-file-manage" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="管理這一份檔案" aria-label="管理這一份檔案">⋯</button>';

const OLD_UPLOAD_SUCCESS = `            } else {
              uploadedCount++;
            }`;
const NEW_UPLOAD_SUCCESS = `            } else {
              uploadedCount++;
              if (result && result.id) {
                await api("/attachments/" + result.id + "/normalize-name", { method: "POST", body: "{}" }).catch(() => {});
              }
            }`;

const SINGLE_FILE_UI = [
  ';(() => {',
  '  if (window.__fieldlogSingleFileV49) return;',
  '  window.__fieldlogSingleFileV49 = true;',
  '',
  '  const VERSION = "v49";',
  '  let focused = null;',
  '  const originalOpenEntry = openEntry;',
  '  const originalCloseEntry = closeEntry;',
  '  const originalOpenFolder = openFolder;',
  '',
  '  const style = document.createElement("style");',
  '  style.id = "fieldlog-v49-style";',
  '  style.textContent = [',
  '    ".folder-file-row{display:grid!important;grid-template-columns:28px minmax(0,1fr) auto 38px!important;align-items:center!important;gap:10px!important}",',
  '    ".folder-file-manage{grid-column:4!important;grid-row:1!important;justify-self:end!important;white-space:nowrap!important;min-width:38px!important}",',
  '    ".folder-file-meta{grid-column:3!important;grid-row:1!important;white-space:nowrap!important}",',
  '    ".folder-file-name{grid-column:2!important;grid-row:1!important;min-width:0!important;overflow-wrap:anywhere!important}",',
  '    ".folder-file-icon{grid-column:1!important;grid-row:1!important}",',
  '    ".fieldlog-version-v49{position:fixed;right:10px;bottom:10px;z-index:9999;background:#0f766e;color:#fff;border-radius:999px;padding:4px 9px;font:12px/1.2 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.18);opacity:.88}",',
  '    "@media(max-width:719px){.folder-file-row{grid-template-columns:26px minmax(0,1fr) auto 38px!important;gap:7px!important}.folder-file-meta{font-size:12px!important}}"',
  '  ].join("");',
  '  document.head.appendChild(style);',
  '',
  '  function addVersionBadge() {',
  '    if (document.querySelector(".fieldlog-version-v49")) return;',
  '    const badge = document.createElement("div");',
  '    badge.className = "fieldlog-version-v49";',
  '    badge.textContent = "Fieldlog " + VERSION;',
  '    document.body.appendChild(badge);',
  '  }',
  '',
  '  async function openSingleFile(entryId, attachmentId) {',
  '    entryId = Number(entryId || 0);',
  '    attachmentId = Number(attachmentId || 0);',
  '    if (!entryId || !attachmentId) return;',
  '    focused = { entryId, attachmentId };',
  '    const entry = await api("/entries/" + entryId);',
  '    const attachment = (entry.attachments || []).find((item) => Number(item.id) === attachmentId);',
  '    if (!attachment) {',
  '      showToast("這份檔案已不存在");',
  '      focused = null;',
  '      originalCloseEntry();',
  '      if (CURRENT_FOLDER) await originalOpenFolder(CURRENT_FOLDER.id);',
  '      return;',
  '    }',
  '',
  '    const modal = document.getElementById("entry-modal");',
  '    const originalName = attachment.original_filename && attachment.original_filename !== attachment.filename',
  '      ? "<p class=\"sub\">原始檔名：" + esc(attachment.original_filename) + "</p>" : "";',
  '    modal.innerHTML = [',
  '      "<div class=\"modal-close-float\"><button class=\"btn small ghost\" id=\"v49-close\" type=\"button\" aria-label=\"關閉檔案\" title=\"關閉檔案\">✕</button></div>",',
  '      "<div class=\"detail-head\"><h2 style=\"margin:0;overflow-wrap:anywhere\">" + esc(attachment.filename) + "</h2></div>",',
  '      originalName,',
  '      "<p class=\"sub\">只顯示目前選取的這一份檔案。</p>",',
  '      "<div class=\"upload-row\"><button class=\"btn small\" id=\"v49-normalize\" type=\"button\">🏷 整理中文檔名</button><span id=\"e-upload-status\" class=\"sub\"></span></div>",',
  '      "<div id=\"e-attachments\" class=\"att-list\">" + attHtml(attachment, entry.attachments || []) + "</div>"',
  '    ].join("");',
  '    document.getElementById("entry-overlay").classList.add("open");',
  '    lockBodyScroll();',
  '    document.getElementById("v49-close").onclick = closeEntry;',
  '    bindAttActions(entryId);',
  '',
  '    const normalizeButton = document.getElementById("v49-normalize");',
  '    normalizeButton.onclick = async () => {',
  '      normalizeButton.disabled = true;',
  '      normalizeButton.textContent = "整理中…";',
  '      try {',
  '        const result = await api("/attachments/" + attachmentId + "/normalize-name", { method: "POST", body: "{}" });',
  '        showToast(result.renamed ? "已更新中文檔名" : (result.incomplete_year ? "尚未確認年份，先擷取文字或執行深度處理" : "檔名已是目前可確認的格式"));',
  '        await openSingleFile(entryId, attachmentId);',
  '        if (CURRENT_FOLDER) await originalOpenFolder(CURRENT_FOLDER.id);',
  '      } catch (error) {',
  '        showToast("整理檔名失敗：" + error.message);',
  '        normalizeButton.disabled = false;',
  '        normalizeButton.textContent = "🏷 整理中文檔名";',
  '      }',
  '    };',
  '  }',
  '',
  '  openEntry = async function fieldlogV49OpenEntry(id) {',
  '    const numericId = Number(id || 0);',
  '    if (focused && focused.entryId === numericId) {',
  '      return openSingleFile(focused.entryId, focused.attachmentId);',
  '    }',
  '    return originalOpenEntry(numericId);',
  '  };',
  '',
  '  closeEntry = function fieldlogV49CloseEntry() {',
  '    focused = null;',
  '    return originalCloseEntry();',
  '  };',
  '',
  '  function bindManageButtons() {',
  '    document.querySelectorAll(".folder-file-manage").forEach((button) => {',
  '      if (!button.dataset.attId) return;',
  '      button.textContent = "⋯";',
  '      button.title = "管理這一份檔案";',
  '      button.onclick = (event) => {',
  '        event.preventDefault();',
  '        event.stopPropagation();',
  '        openSingleFile(button.dataset.entryId, button.dataset.attId).catch((error) => showToast("開啟檔案失敗：" + error.message));',
  '      };',
  '    });',
  '  }',
  '',
  '  openFolder = async function fieldlogV49OpenFolder(id) {',
  '    const result = await originalOpenFolder(id);',
  '    bindManageButtons();',
  '    return result;',
  '  };',
  '',
  '  addVersionBadge();',
  '  bindManageButtons();',
  '  new MutationObserver(() => { addVersionBadge(); bindManageButtons(); }).observe(document.documentElement, { childList: true, subtree: true });',
  '})();',
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-fieldlog-version": "v49" },
  });
}

function authorized(request, env) {
  const url = new URL(request.url);
  const expected = String(env.FIELD_PIN || "").trim();
  const supplied = String(request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
  return Boolean(expected) && supplied === expected;
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
  const org = match[1].toUpperCase().replace(/[\s_-]+ISO$/, "_ISO").replace(/[\s_-]*\/[\s_-]*/g, "_").replace(/\s+/g, "_");
  const number = match[2].toUpperCase();
  let year = match[3] || "";
  if (!year && att.ocr_text) {
    const escapedOrg = org.replace(/_/g, "[\\s_-]+");
    const escapedNumber = number.replace(/-/g, "[\\s_-]*-[\\s_-]*");
    const exact = String(att.ocr_text).match(new RegExp(escapedOrg + "[\\s_:\\-]*" + escapedNumber + "[\\s_:\\-]*((?:19|20)\\d{2})", "i"));
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
  if ((att.mime || "") !== "application/pdf" && !String(att.filename || "").toLowerCase().endsWith(".pdf")) {
    return { ok: true, renamed: false, filename: att.filename };
  }
  const standard = parseStandard(att);
  if (!standard) return { ok: true, renamed: false, filename: att.filename };
  if (!standard.year) return { ok: true, renamed: false, incomplete_year: true, filename: att.filename };
  const title = STANDARD_TITLES.get(standard.key) || existingChineseTitle(att) || "標準文件";
  const next = `${standard.org}_${standard.number}_${standard.year}_${cleanPart(title, 150)}.pdf`;
  if (next === att.filename) return { ok: true, renamed: false, filename: next };
  await env.DB.prepare(
    "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
  ).bind(next, attachmentId).run();
  await env.DB.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, NULL, '自動重新命名', ?, ?)"
  ).bind(att.entry_id, `${att.filename} → ${next}`.slice(0, 200), new Date().toISOString()).run().catch(() => {});
  return { ok: true, renamed: true, filename: next };
}

function noStoreResponse(body, response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("x-fieldlog-version", "v49");
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/version") {
      return json({ ok: true, version: "fieldlog-v49" });
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
      let html = await response.text();
      html = html
        .replace(/app\.js\?v=\d+/g, "app.js?v=49")
        .replace(/style\.css\?v=\d+/g, "style.css?v=49");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      let source = await response.text();
      source = source.split(OLD_V43_ACTIONS).join(V49_ACTION);
      source = source.split(OLD_DETAIL_ACTION).join(V49_ACTION);
      source = source.replace(OLD_UPLOAD_SUCCESS, NEW_UPLOAD_SUCCESS);
      return noStoreResponse(`${source}\n${SINGLE_FILE_UI}`, response, "application/javascript; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
