// MyWiki 手機導覽：只處理頁面歷史與左右滑動，不碰錄音、相機或上傳流程。
// 目標：手機右滑＝上一頁；左滑＝回到剛才退回前的下一頁。
(() => {
  "use strict";

  const isMobile = () => window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
  if (!isMobile()) return;

  const navState = () => {
    try {
      if (typeof CURRENT_FOLDER !== "undefined" && CURRENT_FOLDER?.id) {
        return { mywiki: true, view: "folder", folderId: Number(CURRENT_FOLDER.id) };
      }
    } catch (_) {}
    return { mywiki: true, view: "home" };
  };

  let restoring = false;
  let suppressPush = false;

  // 把目前畫面變成可由 browser history 回復的狀態。
  try {
    if (!history.state?.mywiki) history.replaceState(navState(), "", location.href);
  } catch (_) {}

  // 之後每次開資料夾，都建立一筆瀏覽歷史。這讓 iOS/Android 原生邊緣滑動
  // 自然變成「上一頁／下一頁」，不必搶瀏覽器自己的手勢事件。
  if (typeof openFolder === "function") {
    const originalOpenFolder = openFolder;
    openFolder = async function mobileHistoryOpenFolder(id, ...args) {
      if (!restoring && !suppressPush) {
        const nextId = Number(id);
        const current = navState();
        if (!(current.view === "folder" && current.folderId === nextId)) {
          history.pushState({ mywiki: true, view: "folder", folderId: nextId }, "", location.href);
        }
      }
      return originalOpenFolder.call(this, id, ...args);
    };
  }

  if (typeof openWorkSectionRoot === "function") {
    const originalOpenWorkSectionRoot = openWorkSectionRoot;
    openWorkSectionRoot = async function mobileHistoryOpenSection(sectionKey, ...args) {
      if (!restoring && !suppressPush) {
        history.pushState({ mywiki: true, view: "section", sectionKey: String(sectionKey || "") }, "", location.href);
      }
      return originalOpenWorkSectionRoot.call(this, sectionKey, ...args);
    };
  }

  async function restoreState(state) {
    if (!state?.mywiki) return;
    restoring = true;
    suppressPush = true;
    try {
      if (state.view === "folder" && state.folderId && typeof openFolder === "function") {
        await openFolder(Number(state.folderId));
      } else if (state.view === "section" && state.sectionKey && typeof openWorkSectionRoot === "function") {
        await openWorkSectionRoot(state.sectionKey);
      } else {
        // 回首頁：沿用現有 UI 狀態，不碰 boot/錄音設定。
        try { CURRENT_FOLDER = null; } catch (_) {}
        const folderView = document.getElementById("view-folder");
        const homeView = document.getElementById("view-home");
        if (folderView) folderView.style.display = "none";
        if (homeView) homeView.style.display = "block";
        try { if (typeof renderDesktopFolderTree === "function") renderDesktopFolderTree(); } catch (_) {}
      }
    } finally {
      suppressPush = false;
      restoring = false;
    }
  }

  window.addEventListener("popstate", (event) => {
    restoreState(event.state).catch(() => {});
  });

  // 安裝成 PWA 時有些瀏覽器不提供完整的原生邊緣前進/後退手勢。
  // 只在 standalone 模式補一層邊緣滑動；Safari/Chrome 一般瀏覽模式交給原生手勢，
  // 避免一次滑動觸發兩次。
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (!standalone) return;

  const EDGE = 32;
  const TRIGGER = 72;
  const MAX_VERTICAL = 70;
  let startX = null;
  let startY = null;
  let edge = null;

  window.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    edge = startX <= EDGE ? "left" : (startX >= window.innerWidth - EDGE ? "right" : null);
  }, { passive: true });

  window.addEventListener("touchend", (event) => {
    if (!edge || startX === null || startY === null || event.changedTouches.length !== 1) {
      startX = startY = edge = null;
      return;
    }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    if (dy <= MAX_VERTICAL) {
      if (edge === "left" && dx >= TRIGGER) history.back();
      if (edge === "right" && dx <= -TRIGGER) history.forward();
    }
    startX = startY = edge = null;
  }, { passive: true });
})();
