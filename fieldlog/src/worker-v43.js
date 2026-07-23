import previousWorker from "./worker-v40.js";

const OLD_MANAGE = '<button class="folder-file-manage" type="button" data-entry-id="${entryId}">詳情</button>';
const NEW_MANAGE = '<button class="folder-file-doodle" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="在 PDF 上塗鴉並另存新附件">✍️ 塗鴉</button><button class="folder-file-manage" type="button" data-entry-id="${entryId}" title="管理附件、OCR 與刪除" aria-label="管理附件">⋯</button>';
const OLD_NOTE_FILTER = 'return !(e.attachments || []).length || fields || (body && body !== (e.title || "").trim());';
const NEW_NOTE_FILTER = 'return !(e.attachments || []).length;';

const ARCHIVE_UI = String.raw`
;(() => {
  if (window.__fieldlogArchiveCoreV43) return;
  window.__fieldlogArchiveCoreV43 = true;

  const style = document.createElement("style");
  style.id = "fieldlog-archive-core-v43-style";
  style.textContent = [
    ".folder-file-row{grid-template-columns:28px minmax(0,1fr) auto auto 38px!important;align-items:center!important;min-height:0!important}",
    ".folder-file-doodle{white-space:nowrap;justify-self:end}",
    ".folder-file-manage{min-width:38px!important;width:38px!important;height:34px!important;padding:4px 7px!important;font-size:20px!important;line-height:1!important;white-space:nowrap!important;justify-self:end}",
    ".archive-section-label{margin:14px 0 8px;color:var(--text-muted,#64748b);font-size:13px;font-weight:700;letter-spacing:.04em}",
    ".archive-note-list{display:flex;flex-direction:column;gap:6px;width:100%}",
    ".archive-note-list .entry-drag,.archive-note-list .entry-move,.archive-note-list .entry-del{display:none!important}",
    ".archive-note-list .entry-row::before{content:'📝';font-size:18px}",
    ".folder-file-list.grid-view .folder-file-row{grid-template-columns:minmax(0,1fr) auto 38px!important}",
    ".folder-file-list.grid-view .folder-file-icon,.folder-file-list.grid-view .folder-file-name{grid-column:1 / 4!important}",
    ".folder-file-list.grid-view .folder-file-meta{grid-column:1!important}",
    ".folder-file-list.grid-view .folder-file-doodle{grid-column:2!important}",
    ".folder-file-list.grid-view .folder-file-manage{grid-column:3!important}",
    "@media(max-width:719px){.folder-file-list.grid-view .folder-file-row,.folder-file-row{grid-template-columns:26px minmax(0,1fr) auto 38px!important}.folder-file-list.grid-view .folder-file-icon,.folder-file-list.grid-view .folder-file-name{grid-column:auto!important}.folder-file-meta{display:none!important}}"
  ].join("");
  document.head.appendChild(style);

  let applying = false;
  function setHeading(selector, text) {
    const heading = document.querySelector(selector);
    if (!heading || heading.dataset.v43Title === text) return;
    const count = heading.querySelector(".count");
    heading.textContent = text;
    if (count) heading.append(" ", count);
    heading.dataset.v43Title = text;
  }

  function addLabel(target, text) {
    if (!target || target.previousElementSibling?.dataset?.archiveLabel === text) return;
    const label = document.createElement("div");
    label.className = "archive-section-label";
    label.dataset.archiveLabel = text;
    label.textContent = text;
    target.before(label);
  }

  function applyArchiveUi() {
    if (applying) return;
    applying = true;
    try {
      setHeading("#inbox-panel h2", "📥 收件匣｜待整理");
      setHeading(".folders-panel h2", "📂 已歸檔資料夾");
      const root = document.getElementById("folder-entries");
      if (!root) return;

      root.querySelectorAll(".folder-file-manage").forEach((button) => {
        if (button.textContent !== "⋯") button.textContent = "⋯";
        button.title = "管理附件、OCR 與刪除";
        button.setAttribute("aria-label", "管理附件");
      });

      root.querySelectorAll(".archive-section-label").forEach((node) => node.remove());
      const fileList = root.querySelector(".folder-file-list");
      if (fileList) addLabel(fileList, "已歸檔檔案");

      const noteList = root.querySelector(".folder-note-list, .archive-note-list");
      if (noteList) {
        noteList.classList.remove("folder-note-list");
        noteList.classList.add("archive-note-list");
        noteList.querySelectorAll(".entry-row").forEach((row) => {
          const meta = row.querySelector(".entry-meta")?.textContent || "";
          if (meta.includes("📎")) row.remove();
          else row.querySelectorAll(".entry-drag,.entry-move,.entry-del").forEach((node) => node.remove());
        });
        if (noteList.querySelector(".entry-row")) addLabel(noteList, "已歸檔筆記");
        else noteList.remove();
      }
    } finally {
      applying = false;
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyArchiveUi();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
`;

function noStoreResponse(body, response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, max-age=0");
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const html = (await response.text())
        .replace("style.css?v=34", "style.css?v=43")
        .replace("app.js?v=34", "app.js?v=43");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method !== "GET" || url.pathname !== "/app.js") {
      return previousWorker.fetch(request, env, ctx);
    }

    const response = await previousWorker.fetch(request, env, ctx);
    if (!response.ok) return response;
    let source = await response.text();
    source = source.replace(OLD_MANAGE, NEW_MANAGE);
    source = source.replace(OLD_NOTE_FILTER, NEW_NOTE_FILTER);
    return noStoreResponse(`${source}\n${ARCHIVE_UI}`, response, "application/javascript; charset=utf-8");
  },
};
