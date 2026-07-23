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

const OLD_FILE_ACTIONS = '<button class="folder-file-doodle" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="在 PDF 上塗鴉並另存新附件">✍️ 塗鴉</button><button class="folder-file-manage" type="button" data-entry-id="${entryId}" title="管理附件、OCR 與刪除" aria-label="管理附件">⋯</button>';
const NEW_FILE_ACTIONS = '${isPdfAtt(a) ? `<button class="folder-file-deep" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="逐頁轉圖並執行深度文字辨識">🧠 分析</button><button class="folder-file-doodle" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="在 PDF 上塗鴉並另存新附件">✍️ 塗鴉</button>` : ""}<button class="folder-file-manage" type="button" data-entry-id="${entryId}" title="管理附件、OCR 與刪除" aria-label="管理附件">⋯</button>';

const OLD_UPLOAD_SUCCESS = `            } else {
              uploadedCount++;
            }`;
const NEW_UPLOAD_SUCCESS = `            } else {
              uploadedCount++;
              if (result && result.id) {
                await api("/attachments/" + result.id + "/normalize-name", { method: "POST", body: "{}" }).catch(() => {});
              }
            }`;

const FOLDER_DEEP_UI = [
  ';(() => {',
  '  if (window.__fieldlogFolderDeepV47) return;',
  '  window.__fieldlogFolderDeepV47 = true;',
  '',
  '  const style = document.createElement("style");',
  '  style.id = "fieldlog-folder-deep-v47-style";',
  '  style.textContent = [',
  '    ".folder-file-row{grid-template-columns:28px minmax(0,1fr) auto auto auto 38px!important}",',
  '    ".folder-file-deep,.folder-file-doodle{white-space:nowrap;justify-self:end}",',
  '    ".folder-file-list.grid-view .folder-file-row{grid-template-columns:minmax(0,1fr) auto auto 38px!important}",',
  '    ".folder-file-list.grid-view .folder-file-icon,.folder-file-list.grid-view .folder-file-name{grid-column:1 / 5!important}",',
  '    ".folder-file-list.grid-view .folder-file-meta{grid-column:1!important}",',
  '    ".folder-file-list.grid-view .folder-file-deep{grid-column:2!important}",',
  '    ".folder-file-list.grid-view .folder-file-doodle{grid-column:3!important}",',
  '    ".folder-file-list.grid-view .folder-file-manage{grid-column:4!important}",',
  '    "@media(max-width:719px){.folder-file-list.grid-view .folder-file-row,.folder-file-row{grid-template-columns:26px minmax(0,1fr) auto auto 38px!important}.folder-file-list.grid-view .folder-file-icon,.folder-file-list.grid-view .folder-file-name{grid-column:auto!important}}"',
  '  ].join("");',
  '  document.head.appendChild(style);',
  '',
  '  async function runFolderDeep(button) {',
  '    if (button.dataset.running === "1") return;',
  '    const entryId = Number(button.dataset.entryId || 0);',
  '    const attachmentId = Number(button.dataset.attId || 0);',
  '    const folderId = CURRENT_FOLDER ? Number(CURRENT_FOLDER.id) : 0;',
  '    if (!entryId || !attachmentId) return;',
  '    button.dataset.running = "1";',
  '    const originalLabel = button.textContent;',
  '    try {',
  '      let entry = await api("/entries/" + entryId);',
  '      let pdfAtt = (entry.attachments || []).find((item) => Number(item.id) === attachmentId);',
  '      if (!pdfAtt) throw new Error("找不到 PDF 附件");',
  '',
  '      if (!pdfAtt.ocr_at) {',
  '        button.disabled = true;',
  '        button.textContent = "讀取標準資訊…";',
  '        await api("/attachments/" + attachmentId + "/ocr", { method: "POST", body: "{}" });',
  '        await api("/attachments/" + attachmentId + "/normalize-name", { method: "POST", body: "{}" }).catch(() => {});',
  '        entry = await api("/entries/" + entryId);',
  '        pdfAtt = (entry.attachments || []).find((item) => Number(item.id) === attachmentId);',
  '      }',
  '',
  '      button.disabled = false;',
  '      button.textContent = originalLabel;',
  '      const existingPages = (entry.attachments || []).filter((item) => Number(item.source_pdf_id) === attachmentId);',
  '      await deepProcessPdf(entryId, pdfAtt, button, existingPages);',
  '      const normalized = await api("/attachments/" + attachmentId + "/normalize-name", { method: "POST", body: "{}" }).catch(() => null);',
  '      if (document.getElementById("entry-overlay")?.classList.contains("open") && typeof closeEntry === "function") closeEntry();',
  '      if (folderId && CURRENT_FOLDER && Number(CURRENT_FOLDER.id) === folderId) await openFolder(folderId);',
  '      if (normalized && normalized.renamed) showToast("深度分析完成，已更新中文檔名");',
  '    } catch (error) {',
  '      showToast("深度分析失敗：" + error.message);',
  '    } finally {',
  '      button.dataset.running = "0";',
  '      button.disabled = false;',
  '      button.textContent = originalLabel;',
  '    }',
  '  }',
  '',
  '  function bindFolderDeep() {',
  '    document.querySelectorAll(".folder-file-deep").forEach((button) => {',
  '      if (button.dataset.bound === "1") return;',
  '      button.dataset.bound = "1";',
  '      button.addEventListener("click", (event) => {',
  '        event.preventDefault();',
  '        event.stopPropagation();',
  '        runFolderDeep(button);',
  '      });',
  '    });',
  '  }',
  '',
  '  bindFolderDeep();',
  '  new MutationObserver(bindFolderDeep).observe(document.documentElement, { childList: true, subtree: true });',
  '})();',
].join("\n");

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
  if (!standard.year) {
    return { ok: true, renamed: false, incomplete_year: true, filename: att.filename };
  }
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
  headers.set("cache-control", "no-store, max-age=0");
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
        .replace(/app\.js\?v=\d+/g, "app.js?v=47")
        .replace(/style\.css\?v=\d+/g, "style.css?v=47");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      let source = await response.text();
      source = source.replace(OLD_FILE_ACTIONS, NEW_FILE_ACTIONS);
      source = source.replace(OLD_UPLOAD_SUCCESS, NEW_UPLOAD_SUCCESS);
      return noStoreResponse(`${source}\n${FOLDER_DEEP_UI}`, response, "application/javascript; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
