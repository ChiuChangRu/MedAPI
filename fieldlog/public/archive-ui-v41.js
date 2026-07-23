;(() => {
  if (window.__fieldlogArchiveUiV41) return;
  window.__fieldlogArchiveUiV41 = true;

  function addStyles() {
    if (document.getElementById("fieldlog-archive-ui-v41-style")) return;
    const style = document.createElement("style");
    style.id = "fieldlog-archive-ui-v41-style";
    style.textContent = `
      .folder-file-manage{min-width:38px;width:38px;padding:6px 8px;font-size:20px;line-height:1;white-space:nowrap}
      .archive-section-label{margin:14px 0 8px;color:var(--text-muted,#64748b);font-size:13px;font-weight:700;letter-spacing:.04em}
      .archive-note-list{display:grid;gap:8px;margin-top:10px}
      .archive-note-list .entry-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px 14px;border:1px solid #dce5e1;border-radius:12px;background:#fff;cursor:pointer}
      .archive-note-list .entry-row::before{content:"📝";font-size:19px;line-height:1}
      .archive-note-list .entry-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
      .archive-note-list .entry-meta{white-space:nowrap;color:var(--text-muted,#64748b);font-size:13px}
      .archive-note-list .entry-drag,.archive-note-list .entry-move,.archive-note-list .entry-del{display:none!important}
      @media(max-width:720px){
        .archive-note-list .entry-row{grid-template-columns:26px minmax(0,1fr);padding:11px 12px}
        .archive-note-list .entry-meta{grid-column:2;font-size:12px}
      }
    `;
    document.head.appendChild(style);
  }

  function renameWorkspaceSections() {
    const inboxTitle = document.querySelector("#inbox-panel h2");
    if (inboxTitle) {
      const count = document.getElementById("inbox-count");
      inboxTitle.childNodes[0].textContent = "📥 收件匣｜待整理 ";
      if (count && count.parentNode !== inboxTitle) inboxTitle.appendChild(count);
    }
    const folderTitle = document.querySelector(".folders-panel h2");
    if (folderTitle) folderTitle.textContent = "📂 已歸檔資料夾";
  }

  function refineArchiveView() {
    const root = document.getElementById("folder-entries");
    if (!root) return;

    root.querySelectorAll(".folder-file-manage").forEach((button) => {
      button.textContent = "⋯";
      button.title = "管理附件、OCR 與刪除";
      button.setAttribute("aria-label", "管理附件");
    });

    const fileList = root.querySelector(".folder-file-list");
    const noteList = root.querySelector(".folder-note-list");

    root.querySelectorAll(".archive-section-label").forEach((node) => node.remove());
    if (fileList) {
      const label = document.createElement("div");
      label.className = "archive-section-label";
      label.textContent = "已歸檔檔案";
      fileList.before(label);
    }
    if (noteList) {
      noteList.classList.remove("folder-note-list");
      noteList.classList.add("archive-note-list");
      const label = document.createElement("div");
      label.className = "archive-section-label";
      label.textContent = "已歸檔筆記";
      noteList.before(label);
      noteList.querySelectorAll(".entry-row").forEach((row) => {
        row.querySelectorAll(".entry-drag,.entry-move,.entry-del").forEach((node) => node.remove());
      });
    }
  }

  addStyles();
  renameWorkspaceSections();

  const originalLoadInbox = typeof loadInbox === "function" ? loadInbox : null;
  if (originalLoadInbox) {
    loadInbox = async function fieldlogV41LoadInbox() {
      const result = await originalLoadInbox();
      renameWorkspaceSections();
      return result;
    };
  }

  const originalLoadFolders = typeof loadFolders === "function" ? loadFolders : null;
  if (originalLoadFolders) {
    loadFolders = async function fieldlogV41LoadFolders() {
      const result = await originalLoadFolders();
      renameWorkspaceSections();
      return result;
    };
  }

  const originalOpenFolder = typeof openFolder === "function" ? openFolder : null;
  if (originalOpenFolder) {
    openFolder = async function fieldlogV41OpenFolder(id) {
      const result = await originalOpenFolder(id);
      refineArchiveView();
      return result;
    };
  }

  setTimeout(() => {
    renameWorkspaceSections();
    refineArchiveView();
  }, 0);
})();
