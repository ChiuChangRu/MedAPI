import previousWorker from "./worker-v41.js";

const ARCHIVE_FIX_V42 = String.raw`
;(() => {
  if (window.__fieldlogArchiveFixV42) return;
  window.__fieldlogArchiveFixV42 = true;

  const style = document.createElement("style");
  style.id = "fieldlog-archive-fix-v42";
  style.textContent = `
    .folder-file-row{
      grid-template-columns:28px minmax(0,1fr) auto auto 38px!important;
      align-items:center!important;
    }
    .folder-file-doodle{white-space:nowrap;justify-self:end}
    .folder-file-manage{
      min-width:38px!important;width:38px!important;height:34px!important;
      padding:4px 7px!important;font-size:20px!important;line-height:1!important;
      white-space:nowrap!important;justify-self:end
    }
    .archive-section-label{
      margin:14px 0 8px;color:var(--text-muted,#64748b);
      font-size:13px;font-weight:700;letter-spacing:.04em
    }
    .archive-note-list{display:grid;gap:8px;margin-top:10px;width:100%}
    .archive-note-list .entry-row{
      display:grid;grid-template-columns:28px minmax(0,1fr) auto;
      align-items:center;gap:10px;padding:12px 14px;
      border:1px solid #dce5e1;border-radius:12px;background:#fff;cursor:pointer
    }
    .archive-note-list .entry-row::before{content:"📝";font-size:19px;line-height:1}
    .archive-note-list .entry-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
    .archive-note-list .entry-meta{white-space:nowrap;color:var(--text-muted,#64748b);font-size:13px}
    .archive-note-list .entry-drag,.archive-note-list .entry-move,.archive-note-list .entry-del{display:none!important}
    .folder-file-list.grid-view .folder-file-row{
      grid-template-columns:minmax(0,1fr) auto 38px!important
    }
    .folder-file-list.grid-view .folder-file-icon,
    .folder-file-list.grid-view .folder-file-name{grid-column:1 / 4!important}
    .folder-file-list.grid-view .folder-file-meta{grid-column:1!important}
    .folder-file-list.grid-view .folder-file-doodle{grid-column:2!important}
    .folder-file-list.grid-view .folder-file-manage{grid-column:3!important}
    @media(max-width:719px){
      .folder-file-list.grid-view .folder-file-row,.folder-file-row{
        grid-template-columns:26px minmax(0,1fr) auto 38px!important
      }
      .folder-file-list.grid-view .folder-file-icon,
      .folder-file-list.grid-view .folder-file-name{grid-column:auto!important}
      .folder-file-meta{display:none!important}
      .archive-note-list .entry-row{grid-template-columns:26px minmax(0,1fr)}
      .archive-note-list .entry-meta{grid-column:2;font-size:12px}
    }
  `;
  document.head.appendChild(style);

  let applying = false;
  function setHeading(selector, text) {
    const heading = document.querySelector(selector);
    if (!heading) return;
    const count = heading.querySelector(".count");
    heading.textContent = text;
    if (count) heading.append(" ", count);
  }

  function addLabel(root, target, text) {
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
        button.textContent = "⋯";
        button.title = "管理附件、OCR 與刪除";
        button.setAttribute("aria-label", "管理附件");
      });

      root.querySelectorAll(".archive-section-label").forEach((label) => label.remove());
      const fileList = root.querySelector(".folder-file-list");
      if (fileList) addLabel(root, fileList, "已歸檔檔案");

      const noteList = root.querySelector(".folder-note-list, .archive-note-list");
      if (noteList) {
        noteList.classList.remove("folder-note-list");
        noteList.classList.add("archive-note-list");
        noteList.querySelectorAll(".entry-row").forEach((row) => {
          const meta = row.querySelector(".entry-meta")?.textContent || "";
          if (meta.includes("📎")) {
            row.remove();
            return;
          }
          row.querySelectorAll(".entry-drag,.entry-move,.entry-del").forEach((node) => node.remove());
        });
        if (noteList.querySelector(".entry-row")) addLabel(root, noteList, "已歸檔筆記");
        else noteList.remove();
      }
    } finally {
      applying = false;
    }
  }

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyArchiveUi();
    });
  }

  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleApply();
})();
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/app.js") {
      return previousWorker.fetch(request, env, ctx);
    }
    const response = await previousWorker.fetch(request, env, ctx);
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/javascript; charset=utf-8");
    headers.set("cache-control", "no-store, max-age=0");
    return new Response(`${await response.text()}\n${ARCHIVE_FIX_V42}`, {
      status: response.status,
      headers,
    });
  },
};
