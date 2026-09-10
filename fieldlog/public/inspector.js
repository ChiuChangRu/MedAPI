// A single right pane owns navigation, pending renders, and unsaved changes.
const INSPECTOR = { item: null, tab: null, seq: 0, queue: Promise.resolve(),
  baseline: "", snapshot: null, persist: null, saving: null, prompt: null,
  selection: null, selectionSignature: "", loaded: false };

function inspectorHasUnsaved() {
  return !!INSPECTOR.snapshot && INSPECTOR.snapshot() !== INSPECTOR.baseline;
}

function inspectorStatus(message) {
  const status = document.getElementById("inspector-save-status");
  if (status) status.textContent = message || (inspectorHasUnsaved() ? "尚未儲存" : INSPECTOR.persist ? "已儲存" : "");
}

function resetInspectorEditor() {
  INSPECTOR.snapshot = INSPECTOR.persist = null;
  INSPECTOR.baseline = "";
  inspectorStatus("");
}

function inspectorTrack(snapshot, persist) {
  INSPECTOR.snapshot = snapshot;
  INSPECTOR.baseline = snapshot();
  INSPECTOR.persist = persist;
  const save = $("folder-preview-save");
  save.hidden = false; save.disabled = false; save.textContent = "儲存";
  save.onclick = () => saveInspector();
  inspectorStatus();
}

async function saveInspector() {
  if (INSPECTOR.saving) return INSPECTOR.saving;
  if (!INSPECTOR.persist || !inspectorHasUnsaved()) return true;
  const snapshot = INSPECTOR.snapshot, persist = INSPECTOR.persist;
  const submitted = snapshot();
  $("folder-preview-save").disabled = true;
  inspectorStatus("儲存中…");
  INSPECTOR.saving = (async () => {
    try {
      if (await persist() === false) throw new Error("請檢查欄位或連線後重試");
      if (INSPECTOR.snapshot === snapshot) INSPECTOR.baseline = submitted;
      inspectorStatus();
      return true;
    } catch (error) {
      inspectorStatus("儲存失敗，修改仍保留");
      showToast("儲存失敗：" + error.message);
      return false;
    } finally { INSPECTOR.saving = null; $("folder-preview-save").disabled = false; }
  })();
  return INSPECTOR.saving;
}

async function inspectorMayLeave() {
  if (INSPECTOR.saving && !await INSPECTOR.saving) return false;
  if (!inspectorHasUnsaved()) return true;
  if (INSPECTOR.prompt) return INSPECTOR.prompt;
  const dialog = $("inspector-unsaved");
  INSPECTOR.prompt = new Promise((resolve) => {
    const done = (allowed) => { dialog.close(); INSPECTOR.prompt = null; resolve(allowed); };
    $("inspector-unsaved-save").onclick = async () => {
      const buttons = Array.from(dialog.querySelectorAll("button"));
      buttons.forEach((button) => { button.disabled = true; });
      const saved = await saveInspector();
      buttons.forEach((button) => { button.disabled = false; });
      if (saved && !inspectorHasUnsaved()) done(true);
      else $("inspector-unsaved-message").textContent = "尚未儲存成功，修改仍保留。請重試、放棄修改或取消切換。";
    };
    $("inspector-unsaved-discard").onclick = () => { resetInspectorEditor(); done(true); };
    $("inspector-unsaved-cancel").onclick = () => done(false);
    dialog.oncancel = (event) => { event.preventDefault(); done(false); };
    $("inspector-unsaved-message").textContent = "目前的修改尚未儲存，要如何處理？";
    dialog.showModal();
    $("inspector-unsaved-cancel").focus();
  });
  return INSPECTOR.prompt;
}

async function inspectorGuardAction() {
  await INSPECTOR.queue;
  const editor = INSPECTOR.snapshot, item = INSPECTOR.item, tab = INSPECTOR.tab;
  if (!await inspectorMayLeave()) return false;
  // Discard must also restore the displayed values if a later picker is cancelled.
  if (editor && !INSPECTOR.snapshot && item) return openInspector(item, tab, { reload: true });
  return true;
}

async function inspectorNavigate(action) {
  if (!await inspectorGuardAction()) return false;
  try { return await action(); } catch (error) { showToast(error.message); return false; }
}

function inspectorSelectionSnapshot() {
  return { scope: FILE_SELECTION.scope, keys: new Set(FILE_SELECTION.keys), anchor: FILE_SELECTION.anchor, focus: FILE_SELECTION.focus };
}

function restoreInspectorSelection(selection) {
  if (!selection) return;
  FILE_SELECTION.scope = selection.scope;
  FILE_SELECTION.keys = new Set(selection.keys);
  FILE_SELECTION.anchor = selection.anchor; FILE_SELECTION.focus = selection.focus;
  INSPECTOR.selectionSignature = selectedFileItems().map((item) => item.key).join(",");
  renderFileSelection(false);
}

function syncInspectorSelection() {
  if (!usesDesktopRightPane() || !CURRENT_FOLDER || FILE_MARQUEE) return;
  const items = selectedFileItems();
  const signature = items.map((item) => item.key).join(",");
  if (signature === INSPECTOR.selectionSignature) return;
  INSPECTOR.selectionSignature = signature;
  const previous = INSPECTOR.selection;
  const selection = inspectorSelectionSnapshot();
  const item = items.length === 1 ? items[0] : { type: "selection", id: signature, items };
  openInspector(item, "preview", { selection, onCancel: () => restoreInspectorSelection(previous) });
}

async function openInspector(item, tab = "preview", { selection, onCancel, reload = false } = {}) {
  const key = `${item.type}:${item.id}`;
  const seq = ++INSPECTOR.seq;
  const transition = async () => {
    if (seq !== INSPECTOR.seq) return false;
    if (!await inspectorMayLeave()) { ++INSPECTOR.seq; restoreInspectorSelection(INSPECTOR.selection); onCancel?.(); return false; }
    if (seq !== INSPECTOR.seq) return false;
    resetInspectorEditor();
    INSPECTOR.item = { ...item, key }; INSPECTOR.tab = tab; INSPECTOR.loaded = false;
    INSPECTOR.selection = selection || inspectorSelectionSnapshot();
    const body = $("folder-preview-body"), pane = $("folder-preview");
    if (typeof body._previewCleanup === "function") body._previewCleanup();
    body._previewCleanup = null;
    clearFolderPreviewEditorToolbar();
    setFolderPreviewTitle(item.title || "載入中…");
    for (const id of ["folder-preview-save", "folder-preview-edit", "folder-preview-manage", "folder-preview-open"]) $(id).hidden = true;
    body.innerHTML = '<p class="folder-preview-empty">載入中…</p>';
    pane.setAttribute("aria-busy", "true");
    body.inert = true;
    pane.dataset.entryId = String(item.entryId || (item.type === "entry" ? item.id : ""));
    pane.dataset.attachmentId = item.type === "attachment" ? String(item.id) : "";
    try {
      if (item.type === "selection") renderInspectorBatch(item.items);
      else if (item.type === "folder") renderInspectorFolder(item.id);
      else if (item.type === "attachment") await renderInspectorFile(item, tab);
      else await renderInspectorEntry(item, tab);
      if (seq !== INSPECTOR.seq) return false;
      installInspectorTabs(item, tab);
      INSPECTOR.loaded = true;
      return true;
    } catch (error) {
      if (seq === INSPECTOR.seq) {
        resetInspectorEditor();
        body.innerHTML = `<p class="folder-preview-empty">載入失敗：${esc(error.message)}</p><button class="btn" id="inspector-retry">重試</button>`;
        $("inspector-retry").onclick = () => openInspector(item, tab, { reload: true });
      }
      return false;
    } finally {
      if (seq === INSPECTOR.seq) { body.inert = false; pane.setAttribute("aria-busy", "false"); }
    }
  };
  INSPECTOR.queue = INSPECTOR.queue.then(transition, transition);
  return INSPECTOR.queue;
}

function installInspectorTabs(item, tab) {
  const hasTabs = ["attachment", "entry"].includes(item.type);
  $("file-preview-mode-toggle").hidden = !hasTabs;
  for (const mode of ["preview", "content", "info"]) {
    const button = $(`file-preview-mode-${mode}`);
    button.disabled = mode === tab;
    button.setAttribute("aria-selected", String(mode === tab));
    button.setAttribute("aria-pressed", String(mode === tab));
    button.onclick = () => openInspector(item, mode);
  }
  $("folder-preview-edit").hidden = true;
  $("folder-preview-transcribe").hidden = true;
  $("folder-preview-manage").hidden = !hasTabs;
  $("folder-preview-manage").disabled = !hasTabs;
  $("folder-preview-manage").onclick = () => openInspector(item, "info");
  inspectorStatus();
}

function inspectorMetadata(entry, attachment) {
  const folder = FOLDERS.find((item) => Number(item.id) === Number(entry.folder_id));
  return `<dl class="inspector-metadata"><div><dt>所在位置</dt><dd>${esc(folder?.name || "待分類")}</dd></div>
    <div><dt>建立日期</dt><dd>${esc(localDateTime(attachment?.created_at || entry.created_at))}</dd></div>
    ${attachment ? `<div><dt>檔案大小</dt><dd>${esc(fmtBytes(Number(attachment.size) || 0))}</dd></div><div><dt>格式</dt><dd>${esc(attachment.mime || attachment.kind || "未記錄")}</dd></div>` : `<div><dt>附件</dt><dd>${(entry.attachments || []).filter((a) => !a.source_pdf_id).length} 份</dd></div>`}</dl>`;
}

function inspectorFormSnapshot(form) {
  return JSON.stringify(Array.from(form.querySelectorAll("input,textarea,select")).map((input) => [input.id, input.value]));
}

function inspectorBindForm(form, persist) {
  inspectorTrack(() => inspectorFormSnapshot(form), persist);
  form.onsubmit = (event) => { event.preventDefault(); saveInspector(); };
}

async function renderInspectorFile(item, tab) {
  const { entry, attachment: a } = await attachmentWithText(item.entryId, item.id);
  INSPECTOR.item.entryId = entry.id;
  const body = $("folder-preview-body");
  setFolderPreviewTitle(a.filename);
  if (tab === "preview") {
    await renderFilePreview({ entryId: entry.id, attachmentId: a.id, filename: a.filename, key: a.key, mime: a.mime || "", kind: a.kind || "" });
    if (isImageAtt(a)) body.querySelector(".folder-preview-image")?.addEventListener("click", () => openImageViewer(fileUrlForKey(a.key), a.filename, a.id, a.rotation || 0));
    return;
  }
  $("folder-preview-open").hidden = false;
  $("folder-preview-open").href = fileUrlForKey(a.key);
  $("folder-preview-open").textContent = "開啟原檔"; $("folder-preview-open").onclick = null;
  $("folder-preview-open").removeAttribute("download");
  if (tab === "content") {
    await renderInspectorAttachmentText(entry, [a]);
    return;
  }
  const primaryAttachments = (entry.attachments || []).filter((attachment) => !attachment.source_pdf_id);
  const note = String(a.note || "") || (primaryAttachments.length === 1 ? String(entry.body || "") : "");
  body.innerHTML = `<form class="preview-editor" id="inspector-info-form">
    <label for="inspector-name">檔案名稱</label><input id="inspector-name" maxlength="240" value="${esc(a.filename)}" required>
    <label for="inspector-category">醫療器材分類</label><select id="inspector-category" disabled><option>讀取中…</option></select>
    <label for="inspector-note">備註</label><textarea id="inspector-note">${esc(note)}</textarea>
    ${inspectorMetadata(entry, a)}
    <div class="preview-management-actions"><button class="btn small" type="button" id="inspector-move">移動</button><button class="btn small" type="button" id="inspector-share">唯讀分享</button>
    <button class="btn small" type="button" id="inspector-normalize">整理中文檔名</button>${isPdfAtt(a) ? '<button class="btn small" type="button" id="inspector-doodle">PDF 塗鴉</button>' : ""}
    <button class="btn small danger" type="button" id="inspector-trash">移到垃圾桶</button></div></form>`;
  const category = $("inspector-category");
  let savedCategory = "";
  try {
    const data = await api(`/attachments/${a.id}/category`);
    savedCategory = data.category || "";
    const names = [...new Set([...(data.categories || []), savedCategory].filter(Boolean))];
    category.innerHTML = `<option value="">未分類</option>${names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
    category.value = savedCategory; category.disabled = false;
  } catch { category.innerHTML = '<option>分類讀取失敗，保留原分類</option>'; }
  let savedName = a.filename, savedNote = note;
  inspectorBindForm($("inspector-info-form"), async () => {
    const name = $("inspector-name").value.trim(), nextNote = $("inspector-note").value;
    if (!name) throw new Error("檔案名稱不可空白");
    if (name !== savedName) { const result = await api(`/attachments/${a.id}`, { method: "PUT", body: JSON.stringify({ filename: name }) }); savedName = result.filename || name; }
    if (nextNote !== savedNote) { await api(`/attachments/${a.id}/note`, { method: "PUT", body: JSON.stringify({ note: nextNote }) }); savedNote = nextNote; }
    if (!category.disabled && category.value !== savedCategory) { await api(`/attachments/${a.id}/category`, { method: "PUT", body: JSON.stringify({ category: category.value }) }); savedCategory = category.value; }
    updateInspectorFilename(a.id, savedName);
  });
  $("inspector-move").onclick = () => inspectorNavigate(async () => {
    const folder = await openFolderPicker({ title: "移動檔案", currentId: entry.folder_id });
    if (folder) await runFileBatch([{ ...item, title: savedName }], folder);
  });
  $("inspector-trash").onclick = () => inspectorNavigate(() => runFileBatch([{ ...item, title: savedName }]));
  $("inspector-share").onclick = () => inspectorNavigate(() => createReadOnlyShare(entry.id, a.id));
  $("inspector-normalize").onclick = () => inspectorNavigate(async () => {
    await api(`/attachments/${a.id}/normalize-name`, { method: "POST", body: "{}" });
    await openInspector(item, "info", { reload: true });
  });
  if ($("inspector-doodle")) $("inspector-doodle").onclick = () => inspectorNavigate(() => window.fieldlogOpenPdfEditor(entry.id, a));
}

function updateInspectorFilename(id, filename) {
  setFolderPreviewTitle(filename);
  document.querySelectorAll(`.folder-file-row[data-att-id="${id}"]`).forEach((row) => {
    row.dataset.filename = filename; row.title = filename;
    const name = row.querySelector(".folder-file-name"); if (name) name.textContent = filename;
  });
}

async function renderInspectorAttachmentText(entry, attachments, { append = false } = {}) {
  const body = $("folder-preview-body");
  const source = attachments.map((a) => ({ ...a, text: a.kind === "audio" ? String(a.transcript || "") : String(a.ocr_text || "") ||
    (entry.attachments || []).filter((page) => Number(page.source_pdf_id) === Number(a.id)).sort((a, b) => Number(a.page_no) - Number(b.page_no)).map((page) => page.ocr_text || "").join("\n\n") }));
  const html = `<form id="inspector-text-form" class="preview-editor"><p class="sub">原始辨識文字／逐字稿，可修正與複製。修改不會改動原始檔案；記事中的 AI 整理保留原有標示。</p>
    ${source.map((a) => `<section class="inspector-text-section"><label for="inspector-text-${a.id}">${esc(a.filename)} · ${a.kind === "audio" ? "逐字稿" : "辨識文字"}</label>
      <div class="preview-processing-actions"><button type="button" class="btn small" data-copy="${a.id}">複製</button>${TRANSCRIBE_ENABLED && (a.kind === "audio" || isImageAtt(a) || isPdfAtt(a) || isNativeDocAtt(a)) ? `<button type="button" class="btn small" data-extract="${a.id}">${a.text ? "重新辨識" : "辨識文字"}</button>` : ""}${TRANSCRIBE_ENABLED && isPdfAtt(a) ? `<button type="button" class="btn small" data-deep="${a.id}">逐頁深度擷取</button>` : ""}</div>
      <textarea class="preview-index-text" id="inspector-text-${a.id}" placeholder="尚無辨識文字，可手動貼上或按辨識文字。">${esc(a.text)}</textarea></section>`).join("") || '<p class="sub">沒有可辨識的附件。</p>'}</form>`;
  if (append) body.insertAdjacentHTML("beforeend", html); else body.innerHTML = html;
  const form = $("inspector-text-form");
  const persist = async () => {
    for (const a of source) {
      const value = $(`inspector-text-${a.id}`).value;
      if (value === a.text) continue;
      await api(`/attachments/${a.id}`, { method: "PUT", body: JSON.stringify(a.kind === "audio" ? { transcript: value } : { ocr_text: value }) });
      a.text = value;
    }
  };
  const previousSnapshot = INSPECTOR.snapshot, previousPersist = INSPECTOR.persist;
  let previousBaseline = INSPECTOR.baseline;
  if (append && previousSnapshot) inspectorTrack(() => previousSnapshot() + inspectorFormSnapshot(form), async () => {
    const submitted = previousSnapshot();
    if (submitted !== previousBaseline) {
      if (await previousPersist() === false) return false;
      previousBaseline = submitted;
    }
    await persist();
  });
  else inspectorBindForm(form, persist);
  form.onsubmit = (event) => { event.preventDefault(); saveInspector(); };
  form.querySelectorAll("[data-deep]").forEach((button) => { button.onclick = () => inspectorNavigate(async () => {
    const a = source.find((item) => String(item.id) === button.dataset.deep);
    const currentItem = { ...INSPECTOR.item };
    const pages = (entry.attachments || []).filter((page) => Number(page.source_pdf_id) === Number(a.id));
    await deepProcessPdf(entry.id, a, button, pages, async () => {
      if (INSPECTOR.item?.key === currentItem.key) await openInspector(currentItem, "content", { reload: true });
    });
  }); });
  form.querySelectorAll("[data-copy]").forEach((button) => { button.onclick = async () => {
    try { await navigator.clipboard.writeText($(`inspector-text-${button.dataset.copy}`).value); showToast("文字已複製"); }
    catch { showToast("無法自動複製，請在文字框內全選複製"); }
  }; });
  form.querySelectorAll("[data-extract]").forEach((button) => { button.onclick = () => inspectorNavigate(async () => {
    const a = source.find((item) => String(item.id) === button.dataset.extract);
    if (a.text && !confirm("重新辨識會覆蓋這份附件的文字，確定繼續？")) return;
    const currentItem = { ...INSPECTOR.item };
    button.disabled = true;
    try { await api(`/attachments/${a.id}/${a.kind === "audio" ? "transcribe" : "ocr"}`, { method: "POST", body: "{}" }); if (INSPECTOR.item?.key === currentItem.key) await openInspector(currentItem, "content", { reload: true }); }
    catch (error) { button.disabled = false; showToast("辨識失敗：" + error.message); }
  }); });
}

async function renderInspectorEntry(item, tab) {
  const entry = await api(`/entries/${item.id}`);
  const attachments = (entry.attachments || []).filter((a) => !a.source_pdf_id);
  const body = $("folder-preview-body");
  setFolderPreviewTitle(entry.title || "未命名");
  if (tab === "content") {
    await renderEntryEditor(entry.id);
    const form = $("entry-preview-editor"), originalSave = form.onsubmit;
    inspectorTrack(() => JSON.stringify({ title: $("folder-preview-title").textContent, form: inspectorFormSnapshot(form), rich: $("preview-entry-rich") ? window.fieldlogRichEditor?.getHtml($("preview-entry-rich")) : "" }), () => originalSave({ preventDefault() {} }));
    form.onsubmit = (event) => { event.preventDefault(); saveInspector(); };
    if (attachments.length) await renderInspectorAttachmentText(entry, attachments, { append: true });
    return;
  }
  if (tab === "preview") {
    body.innerHTML = `<div class="inspector-entry-preview">${attachments.map((a) => {
      const url = fileUrlForKey(a.key);
      return `<section><h3>${esc(a.filename)}</h3>${a.kind === "audio" ? `<audio controls preload="metadata" src="${url}"></audio>` : a.kind === "video" ? `<video controls preload="metadata" src="${url}"></video>` : isImageAtt(a) ? `<img class="folder-preview-image" src="${url}" alt="${esc(a.filename)}">` : ""}<div><a class="btn small" href="${url}" download="${esc(a.filename)}">下載原檔</a><button class="btn small" data-inspect="${a.id}">檢視檔案</button></div></section>`;
    }).join("")}</div>`;
    if (entry.body) {
      const frame = document.createElement("iframe"); frame.className = "folder-preview-frame"; frame.title = "記事內容（保留 AI 整理標示）"; frame.setAttribute("sandbox", "");
      frame.srcdoc = safeHtmlPreviewDocument(entry.body_format === "html" ? entry.body : `<pre>${esc(entry.body)}</pre>`); body.appendChild(frame);
    } else if (!attachments.length && !visibleEntryFields(entry).length) body.innerHTML = '<p class="folder-preview-empty">尚無內容，可切到「文字內容」編輯。</p>';
    const fields = visibleEntryFields(entry);
    if (fields.length) body.insertAdjacentHTML("beforeend", `<dl class="inspector-metadata">${fields.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value ?? ""))}</dd></div>`).join("")}</dl>`);
    body.querySelectorAll("[data-inspect]").forEach((button) => { button.onclick = () => openInspector({ type: "attachment", id: Number(button.dataset.inspect), entryId: entry.id }, "preview"); });
    return;
  }
  body.innerHTML = `<form class="preview-editor" id="inspector-entry-info"><label for="inspector-entry-name">名稱</label><input id="inspector-entry-name" value="${esc(entry.title || "")}" required maxlength="240">${inspectorMetadata(entry)}
    <p class="sub">記事與逐字稿請到「文字內容」編輯。</p><div class="preview-management-actions"><button class="btn small" type="button" id="inspector-entry-move">移動</button><button class="btn small danger" type="button" id="inspector-entry-trash">移到垃圾桶</button>${attachments.some((a) => a.kind === "audio") ? '<button class="btn small" type="button" id="inspector-recording-actions">錄音操作</button>' : ""}</div></form>`;
  inspectorBindForm($("inspector-entry-info"), async () => {
    const title = $("inspector-entry-name").value.trim(); if (!title) throw new Error("名稱不可空白");
    await api(`/entries/${entry.id}`, { method: "PUT", body: JSON.stringify({ title }) }); setFolderPreviewTitle(title);
    updateInspectorEntryTitle(entry.id, title);
  });
  $("inspector-entry-move").onclick = () => inspectorNavigate(() => openMoveEntryDialog(entry.id, { currentFolderId: entry.folder_id, title: entry.title }));
  $("inspector-entry-trash").onclick = () => inspectorNavigate(() => runFileBatch([{ type: "entry", id: entry.id, title: entry.title }]));
  if ($("inspector-recording-actions")) $("inspector-recording-actions").onclick = () => inspectorNavigate(() => openRecordingActions(entry.id));
}

function renderInspectorFolder(id) {
  const folder = FOLDERS.find((item) => Number(item.id) === Number(id));
  if (!folder) throw new Error("資料夾已不存在");
  setFolderPreviewTitle(folder.name);
  $("folder-preview-body").innerHTML = `<div class="inspector-summary"><h3>資料夾摘要</h3><p>${esc(folder.type || "")}</p><p>${Number(folder.entry_count || 0)} 筆記事 · ${Number(folder.child_count || 0)} 個子資料夾</p><p class="sub">雙擊資料夾可進入；Ctrl 或框選可多選。</p><button class="btn" id="inspector-folder-open">開啟資料夾</button></div>`;
  $("inspector-folder-open").onclick = () => openFolder(id);
}

function renderInspectorBatch(items) {
  setFolderPreviewTitle(items.length ? `已選 ${items.length} 項` : "預覽");
  $("folder-preview-body").innerHTML = items.length ? `<div class="inspector-summary"><h3>已選 ${items.length} 項</h3><p>多選時只提供批次操作。</p><div class="preview-management-actions"><button class="btn" id="inspector-batch-move">移動</button><button class="btn danger" id="inspector-batch-trash">移到垃圾桶</button><button class="btn" id="inspector-batch-clear">取消選取</button></div><ul>${items.map((item) => `<li>${esc(item.title)}</li>`).join("")}</ul></div>` : '<p class="folder-preview-empty">單擊檔案可預覽；空白處拖曳可框選。</p>';
  if (!items.length) return;
  $("inspector-batch-move").onclick = () => $("file-selection-move").onclick();
  $("inspector-batch-trash").onclick = () => runFileBatch(items);
  $("inspector-batch-clear").onclick = () => clearFileSelection();
}

function resetInspectorPane() {
  ++INSPECTOR.seq;
  INSPECTOR.item = null; INSPECTOR.tab = null; INSPECTOR.loaded = false;
  INSPECTOR.selection = null; INSPECTOR.selectionSignature = "";
  resetInspectorEditor();
  $("folder-preview-body").inert = false;
  $("folder-preview").setAttribute("aria-busy", "false");
}

async function inspectorPrepareNavigation() {
  await INSPECTOR.queue;
  if (!await inspectorMayLeave()) return false;
  clearFileSelection(false);
  clearFilePreview();
  return true;
}

async function inspectSingleItem(item, tab) {
  if (!await openInspector(item, tab)) return false;
  const row = Array.from(document.querySelectorAll(FILE_SELECTION_ROW)).find((row) => {
    const current = selectionItem(row); return current.type === item.type && current.id === item.id;
  });
  if (row) {
    const key = selectionItem(row).key;
    FILE_SELECTION.scope = row.closest(FILE_SELECTION_SCOPE);
    FILE_SELECTION.keys = new Set([key]); FILE_SELECTION.anchor = FILE_SELECTION.focus = key;
    INSPECTOR.selectionSignature = key; INSPECTOR.selection = inspectorSelectionSnapshot();
    renderFileSelection(false);
  }
  return true;
}

function updateInspectorEntryTitle(id, title) {
  document.querySelectorAll(`.entry-row[data-id="${id}"] .entry-title, .record-group-card[data-id="${id}"] > strong`).forEach((node) => { node.textContent = title; });
}

function initInspector() {
  $("folder-preview").addEventListener("input", () => inspectorStatus());
  $("folder-preview").addEventListener("change", () => inspectorStatus());
  window.addEventListener("beforeunload", (event) => {
    if (inspectorHasUnsaved() || INSPECTOR.saving) { event.preventDefault(); event.returnValue = ""; }
  });
}
