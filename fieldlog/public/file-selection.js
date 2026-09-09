// Selection belongs to one visible list. Drag data is a snapshot, never live DOM state.
const FILE_SELECTION_MIME = "application/x-fieldlog-selection";
const FILE_SELECTION_ROW = ".folder-file-row[data-att-id], .entry-row[data-id], .record-group-card[data-id], .child-folder-card[data-id]";
const FILE_SELECTION_SCOPE = ".folder-content-list, .entry-list, .child-folder-list";
const FILE_SELECTION = { scope: null, keys: new Set(), anchor: null, focus: null, busy: false };
let FILE_MARQUEE = null;
let FILE_MARQUEE_CLICK_UNTIL = 0;

function marqueePoint(scope, x, y) {
  const bounds = scope.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(scope.scrollWidth, x - bounds.left + scope.scrollLeft)),
    y: Math.max(0, Math.min(scope.scrollHeight, y - bounds.top + scope.scrollTop)),
  };
}

function marqueeScrollParent(scope) {
  for (let node = scope; node && node !== document.body; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

function updateFileMarquee() {
  const state = FILE_MARQUEE;
  if (!state?.active) return;
  if (!state.scope.isConnected || !state.scope.getClientRects().length || FILE_SELECTION.scope !== state.scope) {
    finishFileMarquee(true); return;
  }
  const bounds = state.scope.getBoundingClientRect();
  const point = marqueePoint(state.scope, state.x, state.y);
  const box = { left: Math.min(state.start.x, point.x), right: Math.max(state.start.x, point.x),
    top: Math.min(state.start.y, point.y), bottom: Math.max(state.start.y, point.y) };
  const keys = new Set(state.base);
  const rows = selectionRows();
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const left = rect.left - bounds.left + state.scope.scrollLeft;
    const top = rect.top - bounds.top + state.scope.scrollTop;
    if (left < box.right && left + rect.width > box.left && top < box.bottom && top + rect.height > box.top) keys.add(selectionItem(row).key);
  }
  FILE_SELECTION.keys = keys;
  const selected = rows.filter((row) => keys.has(selectionItem(row).key));
  FILE_SELECTION.anchor = selected.length ? selectionItem(selected[0]).key : null;
  FILE_SELECTION.focus = selected.length ? selectionItem(selected[selected.length - 1]).key : null;
  renderFileSelection();
  // Clip the visual box to the content and viewport, while hit-testing in scroll coordinates.
  const left = Math.max(0, bounds.left, bounds.left + box.left - state.scope.scrollLeft);
  const top = Math.max(0, bounds.top, bounds.top + box.top - state.scope.scrollTop);
  const right = Math.min(window.innerWidth, bounds.right, bounds.left + box.right - state.scope.scrollLeft);
  const bottom = Math.min(window.innerHeight, bounds.bottom, bounds.top + box.bottom - state.scope.scrollTop);
  Object.assign(state.box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
}

function fileMarqueeFrame() {
  const state = FILE_MARQUEE;
  if (!state?.active) return;
  const root = state.scrollParent;
  const viewport = root === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : root.getBoundingClientRect();
  const bounds = state.scope.getBoundingClientRect();
  const top = Math.max(0, viewport.top), bottom = Math.min(window.innerHeight, viewport.bottom);
  if (state.x >= bounds.left && state.x <= bounds.right) {
    const delta = state.y < top + 36 ? -12 : state.y > bottom - 36 ? 12 : 0;
    if (delta) root.scrollTop += delta;
  }
  updateFileMarquee();
  if (FILE_MARQUEE === state) state.frame = requestAnimationFrame(fileMarqueeFrame);
}

function finishFileMarquee(cancel = false) {
  const state = FILE_MARQUEE;
  if (!state) return;
  FILE_MARQUEE = null;
  cancelAnimationFrame(state.frame);
  state.box?.remove();
  document.body.classList.remove("file-marquee-active");
  if (state.scope.hasPointerCapture?.(state.pointerId)) state.scope.releasePointerCapture(state.pointerId);
  if (cancel && FILE_SELECTION.scope === state.scope) {
    FILE_SELECTION.keys = new Set(state.previous);
    FILE_SELECTION.anchor = state.previousAnchor;
    FILE_SELECTION.focus = state.previousFocus;
    renderFileSelection();
  }
  if (state.active) {
    FILE_MARQUEE_CLICK_UNTIL = Date.now() + 350;
    if (FILE_SELECTION.scope === state.scope) selectionRows().find((row) => selectionItem(row).key === FILE_SELECTION.focus)?.focus({ preventScroll: true });
  }
}

function initFileMarquee() {
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || FILE_SELECTION.busy) return;
    const target = event.target;
    // Starting on a row keeps native dragging. Only the surrounding blank area starts a box.
    if (target.closest(`${FILE_SELECTION_ROW}, button, a, input, textarea, select, [contenteditable='true'], .overlay.open`)) return;
    const scope = target.closest(FILE_SELECTION_SCOPE) || target.closest(".folder-workspace-main")?.querySelector("#folder-entries");
    if (!scope || !scope.querySelector(FILE_SELECTION_ROW)) return;
    const bounds = scope.getBoundingClientRect();
    if (event.clientX >= bounds.left + scope.clientWidth || event.clientX < bounds.left) return;
    finishFileMarquee(true);
    if (FILE_SELECTION.scope !== scope) clearFileSelection();
    FILE_SELECTION.scope = scope;
    const previous = new Set(FILE_SELECTION.keys);
    FILE_MARQUEE = {
      scope, pointerId: event.pointerId, start: marqueePoint(scope, event.clientX, event.clientY),
      downX: event.clientX, downY: event.clientY, x: event.clientX, y: event.clientY,
      previous, previousAnchor: FILE_SELECTION.anchor, previousFocus: FILE_SELECTION.focus,
      base: event.ctrlKey || event.metaKey || event.shiftKey ? previous : new Set(),
      active: false, frame: 0, scrollParent: marqueeScrollParent(scope),
    };
    scope.tabIndex = -1;
    scope.focus({ preventScroll: true });
    scope.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, true);
  document.addEventListener("pointermove", (event) => {
    const state = FILE_MARQUEE;
    if (!state || event.pointerId !== state.pointerId) return;
    if (!(event.buttons & 1)) { finishFileMarquee(); return; }
    state.x = event.clientX; state.y = event.clientY;
    if (!state.active) {
      if (Math.hypot(state.x - state.downX, state.y - state.downY) < 5) return;
      state.active = true;
      state.box = document.createElement("div");
      state.box.className = "file-selection-marquee";
      state.box.setAttribute("aria-hidden", "true");
      document.body.appendChild(state.box);
      document.body.classList.add("file-marquee-active");
      state.frame = requestAnimationFrame(fileMarqueeFrame);
    }
    event.preventDefault();
    updateFileMarquee();
  }, true);
  document.addEventListener("pointerup", (event) => {
    const state = FILE_MARQUEE;
    if (!state || event.pointerId !== state.pointerId) return;
    if (state.active) { state.x = event.clientX; state.y = event.clientY; updateFileMarquee(); }
    else if (!event.ctrlKey && !event.metaKey && !event.shiftKey) clearFileSelection();
    finishFileMarquee();
  }, true);
  document.addEventListener("pointercancel", (event) => { if (event.pointerId === FILE_MARQUEE?.pointerId) finishFileMarquee(true); }, true);
  document.addEventListener("lostpointercapture", (event) => { if (event.pointerId === FILE_MARQUEE?.pointerId) finishFileMarquee(true); }, true);
  window.addEventListener("blur", () => finishFileMarquee(true));
}

function selectionItem(row) {
  const attachment = row.dataset.attId;
  const type = attachment ? "attachment" : row.classList.contains("child-folder-card") ? "folder" : "entry";
  return {
    key: `${type}:${attachment || row.dataset.id}`,
    type,
    id: Number(attachment || row.dataset.id),
    title: row.dataset.filename || row.querySelector(".entry-title, strong")?.textContent || "未命名",
  };
}

function selectionRows() {
  return Array.from(FILE_SELECTION.scope?.querySelectorAll(FILE_SELECTION_ROW) || [])
    .filter((row) => row.getClientRects().length);
}

function selectedFileItems() {
  return selectionRows().map(selectionItem).filter((item) => FILE_SELECTION.keys.has(item.key));
}

function renderFileSelection() {
  const items = selectedFileItems();
  FILE_SELECTION.keys = new Set(items.map((item) => item.key));
  document.querySelectorAll(FILE_SELECTION_ROW).forEach((row) => {
    const selected = row.closest(FILE_SELECTION_SCOPE) === FILE_SELECTION.scope && FILE_SELECTION.keys.has(selectionItem(row).key);
    row.classList.toggle("file-selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
  const bar = document.getElementById("file-selection-bar");
  if (bar) {
    bar.hidden = !items.length;
    document.getElementById("file-selection-count").textContent = FILE_SELECTION.busy ? "處理中…" : `已選 ${items.length} 項`;
    bar.querySelectorAll("button").forEach((button) => { button.disabled = FILE_SELECTION.busy; });
  }
  const label = document.getElementById("desktop-trash-label");
  if (label) label.textContent = items.length ? `刪除 ${items.length} 項` : "垃圾桶";
}

function clearFileSelection() {
  finishFileMarquee();
  FILE_SELECTION.keys.clear();
  FILE_SELECTION.scope = null;
  FILE_SELECTION.anchor = FILE_SELECTION.focus = null;
  renderFileSelection();
}

function prepareFileSelection(wrap) {
  if (!wrap) return;
  wrap.querySelectorAll(FILE_SELECTION_ROW).forEach((row) => {
    row.tabIndex = 0;
    row.draggable = true;
    row.title = selectionItem(row).title;
    row.setAttribute("role", "option");
    const scope = row.closest(FILE_SELECTION_SCOPE);
    scope?.setAttribute("role", "listbox");
    scope?.setAttribute("aria-multiselectable", "true");
    scope?.setAttribute("aria-label", "檔案與資料夾；單擊選取、雙擊開啟；Ctrl 多選，Shift 連續選取");
  });
  renderFileSelection();
}

function selectFileRow(row, { range = false, toggle = false } = {}) {
  const scope = row.closest(FILE_SELECTION_SCOPE);
  if (!scope) return;
  if (FILE_SELECTION.scope !== scope) clearFileSelection();
  FILE_SELECTION.scope = scope;
  const key = selectionItem(row).key;
  const keys = selectionRows().map((item) => selectionItem(item).key);
  if (range && keys.includes(FILE_SELECTION.anchor)) {
    const from = keys.indexOf(FILE_SELECTION.anchor), to = keys.indexOf(key);
    if (!toggle) FILE_SELECTION.keys.clear();
    keys.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((item) => FILE_SELECTION.keys.add(item));
  } else {
    if (!toggle) FILE_SELECTION.keys.clear();
    if (toggle && FILE_SELECTION.keys.has(key)) FILE_SELECTION.keys.delete(key);
    else FILE_SELECTION.keys.add(key);
    FILE_SELECTION.anchor = key;
  }
  FILE_SELECTION.focus = key;
  renderFileSelection();
}

function invalidFolderDestination(items, folder) {
  if (!folder) return false;
  const selected = new Set(items.filter((item) => item.type === "folder").map((item) => Number(item.id)));
  const seen = new Set();
  let id = Number(folder.id);
  while (id && !seen.has(id)) {
    if (selected.has(id)) return true;
    seen.add(id);
    id = Number(FOLDERS.find((item) => Number(item.id) === id)?.parent_id || 0);
  }
  return false;
}

async function openSelectionRow(row, event) {
  const item = selectionItem(row);
  try {
    if (item.type === "folder") await openFolder(item.id);
    else if (item.type === "attachment") {
      if (usesDesktopRightPane()) await showFilePreview(filePreviewArgsFromRow(row));
      else await openFileDetail(Number(row.dataset.entryId), item.id);
    } else if (row.onclick) await row.onclick(event);
  } catch (error) { showToast("開啟失敗：" + error.message); }
}

async function runFileBatch(items, folder = null) {
  if (FILE_SELECTION.busy || !items.length) return;
  if (invalidFolderDestination(items, folder)) { showToast("不能把資料夾移到自己或自己的子資料夾內"); return; }
  const action = folder ? `移至「${folder.name}」` : "移到垃圾桶（含資料夾內全部內容，保留 60 天）";
  const names = items.slice(0, 8).map((item) => item.title).join("\n");
  if (!confirm(`將 ${items.length} 項${action}？\n\n${names}${items.length > 8 ? "\n…" : ""}`)) return;
  FILE_SELECTION.busy = true;
  renderFileSelection();
  const failed = [];
  let completed = 0;
  try {
    // Each item settles separately so a network failure never reports the whole batch as successful.
    for (const item of items) {
      try {
        if (folder) {
          await api(item.type === "folder" ? `/folders/${item.id}` : item.type === "attachment" ? `/attachments/${item.id}/move` : `/entries/${item.id}`, {
            method: item.type === "attachment" ? "POST" : "PUT",
            body: JSON.stringify(item.type === "folder" ? { parent_id: folder.id } : { folder_id: folder.id }),
          });
        } else {
          await api(item.type === "folder" ? `/folders/${item.id}` : item.type === "attachment" ? `/attachments/${item.id}/trash` : `/entries/${item.id}`, {
            method: item.type === "attachment" ? "POST" : "DELETE",
          });
        }
        completed++;
      } catch (error) { failed.push({ ...item, error: error.message }); }
    }
    const scopeId = FILE_SELECTION.scope?.id;
    clearFileSelection();
    try { await refreshFolderView(); }
    catch (error) { showToast("操作已處理，清單更新失敗：" + error.message); }
    if (failed.length && scopeId) {
      FILE_SELECTION.scope = document.getElementById(scopeId);
      FILE_SELECTION.keys = new Set(failed.map((item) => item.key));
    }
    showToast(`${completed} 項已${folder ? "移動" : "移到垃圾桶"}${failed.length ? `；${failed.length} 項未完成：${failed[0].title}（${failed[0].error}）` : ""}`);
  } finally {
    FILE_SELECTION.busy = false;
    renderFileSelection();
  }
}

function selectionDropItems(event) {
  try {
    const items = JSON.parse(event.dataTransfer.getData(FILE_SELECTION_MIME));
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter((item) => {
      if (!item || !["attachment", "entry", "folder"].includes(item.type) || !Number.isSafeInteger(item.id) || item.id < 1) return false;
      item.key = `${item.type}:${item.id}`;
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
  } catch { return []; }
}

function selectionDropTarget(event) {
  const target = event.target.closest("#desktop-trash, .desktop-tree-row[data-id], .child-folder-card[data-id], .folder-card[data-id], .recent-folder-card[data-id]");
  if (!target) return null;
  if (target.id === "desktop-trash") return { node: target, folder: null };
  const folder = FOLDERS.find((item) => Number(item.id) === Number(target.dataset.id));
  return folder ? { node: target, folder } : null;
}

function endFileDrag() {
  document.body.classList.remove("entry-dragging");
  document.querySelectorAll(".file-batch-target, .file-batch-dragging").forEach((node) => node.classList.remove("file-batch-target", "file-batch-dragging"));
  document.getElementById("file-drag-badge")?.remove();
}

function initFileSelection() {
  initFileMarquee();
  document.getElementById("file-selection-clear").onclick = clearFileSelection;
  document.getElementById("file-selection-trash").onclick = () => runFileBatch(selectedFileItems());
  document.getElementById("file-selection-move").onclick = async () => {
    const items = selectedFileItems();
    const folder = await openFolderPicker({ title: `移動 ${items.length} 項`, allowInbox: false });
    if (folder) await runFileBatch(items, { id: folder.id, name: folder.name || FOLDERS.find((item) => item.id === folder.id)?.name || "資料夾" });
  };
  document.addEventListener("click", (event) => {
    if (Date.now() < FILE_MARQUEE_CLICK_UNTIL && event.detail !== 0) {
      FILE_MARQUEE_CLICK_UNTIL = 0;
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event.target.closest("#desktop-trash") && selectedFileItems().length) {
      event.preventDefault(); event.stopImmediatePropagation();
      runFileBatch(selectedFileItems());
      return;
    }
    const row = event.target.closest(FILE_SELECTION_ROW);
    if (!row || !row.closest(FILE_SELECTION_SCOPE)) return;
    if (event.target.closest("button, input, textarea, select")) return;
    if (FILE_SELECTION.busy) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    selectFileRow(row, { range: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
    row.focus({ preventScroll: true });
    if (event.shiftKey || event.ctrlKey || event.metaKey || matchMedia("(hover: hover) and (pointer: fine)").matches) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (FILE_MARQUEE) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finishFileMarquee(true); }
      return;
    }
    if (event.target.closest("input, textarea, select, button, [contenteditable='true'], .overlay.open")) return;
    const row = event.target.closest(FILE_SELECTION_ROW);
    if (row?.closest(FILE_SELECTION_SCOPE) && !FILE_SELECTION.busy && FILE_SELECTION.scope !== row.closest(FILE_SELECTION_SCOPE)) selectFileRow(row);
    const rows = selectionRows();
    if (!rows.length || FILE_SELECTION.busy) return;
    if (!row && event.target !== document.body) return;
    const key = event.key;
    if (key === "Enter" && row) { event.preventDefault(); openSelectionRow(row, event); return; }
    if (key === "Escape") { clearFileSelection(); return; }
    if (key === "Delete") { event.preventDefault(); runFileBatch(selectedFileItems()); return; }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a") {
      event.preventDefault(); FILE_SELECTION.keys = new Set(rows.map((item) => selectionItem(item).key)); renderFileSelection(); return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", " "].includes(key)) return;
    event.preventDefault();
    if (key === " " && row) { selectFileRow(row, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }); return; }
    let index = Math.max(0, rows.findIndex((item) => selectionItem(item).key === FILE_SELECTION.focus));
    if (key === "Home") index = 0;
    else if (key === "End") index = rows.length - 1;
    else {
      let step = 1;
      if ((key === "ArrowUp" || key === "ArrowDown") && FILE_SELECTION.scope.classList.contains("grid-view")) {
        const top = rows[index].offsetTop;
        const next = rows.map((item, i) => ({ item, i })).filter(({ item }) => key === "ArrowDown" ? item.offsetTop > top : item.offsetTop < top);
        next.sort((a, b) => Math.abs(a.item.offsetTop - top) - Math.abs(b.item.offsetTop - top) || Math.abs(a.item.offsetLeft - rows[index].offsetLeft) - Math.abs(b.item.offsetLeft - rows[index].offsetLeft));
        step = next.length ? Math.abs(next[0].i - index) : 0;
      }
      index = Math.max(0, Math.min(rows.length - 1, index + (["ArrowUp", "ArrowLeft"].includes(key) ? -step : step)));
    }
    selectFileRow(rows[index], { range: event.shiftKey, toggle: event.shiftKey && (event.ctrlKey || event.metaKey) });
    rows[index].focus({ preventScroll: true });
    rows[index].scrollIntoView({ block: "nearest" });
  }, true);
  document.addEventListener("dblclick", (event) => {
    const row = event.target.closest(FILE_SELECTION_ROW);
    if (!row?.closest(FILE_SELECTION_SCOPE) || event.target.closest("button, input, textarea, select")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey || FILE_SELECTION.busy) return;
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) openSelectionRow(row, event);
  }, true);
  document.addEventListener("dragstart", (event) => {
    const row = event.target.closest(FILE_SELECTION_ROW);
    if (!row || !row.closest(FILE_SELECTION_SCOPE)) return;
    if (FILE_SELECTION.busy) { event.preventDefault(); return; }
    if (!FILE_SELECTION.keys.has(selectionItem(row).key) || FILE_SELECTION.scope !== row.closest(FILE_SELECTION_SCOPE)) selectFileRow(row);
    const items = selectedFileItems();
    event.stopImmediatePropagation();
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FILE_SELECTION_MIME, JSON.stringify(items));
    // Preserve the established single-entry nesting and create-folder drop targets.
    if (items.length === 1 && items[0].type === "entry") {
      event.dataTransfer.setData("application/x-fieldlog-entry", String(items[0].id));
      event.dataTransfer.setData("application/x-fieldlog-entry-title", items[0].title);
      event.dataTransfer.setData("application/x-fieldlog-entry-folder", row.dataset.folderId || String(CURRENT_FOLDER?.id || ""));
      document.body.classList.add("entry-dragging");
    }
    const badge = document.createElement("div");
    badge.id = "file-drag-badge"; badge.textContent = `📄 ${items.length} 項`;
    document.body.appendChild(badge);
    event.dataTransfer.setDragImage(badge, 20, 20);
    selectionRows().filter((item) => FILE_SELECTION.keys.has(selectionItem(item).key)).forEach((item) => item.classList.add("file-batch-dragging"));
  }, true);
  document.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes(FILE_SELECTION_MIME)) return;
    const target = selectionDropTarget(event);
    if (!target && Array.from(event.dataTransfer.types).includes("application/x-fieldlog-entry")) return;
    event.stopImmediatePropagation();
    document.querySelectorAll(".file-batch-target").forEach((node) => node.classList.remove("file-batch-target"));
    event.dataTransfer.dropEffect = target && !FILE_SELECTION.busy ? "move" : "none";
    if (target && !FILE_SELECTION.busy) { event.preventDefault(); target.node.classList.add("file-batch-target"); }
  }, true);
  document.addEventListener("drop", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes(FILE_SELECTION_MIME)) return;
    const target = selectionDropTarget(event), items = selectionDropItems(event);
    if (!target && items.length === 1 && items[0].type === "entry") return;
    event.preventDefault(); event.stopImmediatePropagation();
    endFileDrag();
    if (target) runFileBatch(items, target.folder);
  }, true);
  document.addEventListener("dragend", endFileDrag, true);
}
