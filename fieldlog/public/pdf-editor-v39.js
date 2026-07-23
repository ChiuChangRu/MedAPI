;(() => {
  if (window.__fieldlogPdfEditorV39) return;
  window.__fieldlogPdfEditorV39 = true;

  const state = {
    entryId: 0,
    attachment: null,
    sourceBytes: null,
    pdf: null,
    pageNo: 1,
    pageCount: 0,
    scale: 1.5,
    drawing: false,
    lastPoint: null,
    histories: new Map(),
    historyIndex: new Map(),
  };

  function notify(message) {
    if (typeof showToast === "function") showToast(message);
    else console.info(message);
  }

  function ensurePdfLib() {
    if (window.PDFLib?.PDFDocument) return Promise.resolve(window.PDFLib);
    if (window.__fieldlogPdfLibPromise) return window.__fieldlogPdfLibPromise;
    window.__fieldlogPdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
      script.onload = () => window.PDFLib?.PDFDocument ? resolve(window.PDFLib) : reject(new Error("PDF 存檔程式庫載入失敗"));
      script.onerror = () => reject(new Error("PDF 存檔程式庫下載失敗，請確認網路後重試"));
      document.head.appendChild(script);
    });
    return window.__fieldlogPdfLibPromise;
  }

  function addStyles() {
    if (document.getElementById("fieldlog-pdf-editor-style")) return;
    const style = document.createElement("style");
    style.id = "fieldlog-pdf-editor-style";
    style.textContent = `
      .pdf-edit-overlay{position:fixed;inset:0;z-index:10020;background:rgba(15,23,42,.88);display:none;flex-direction:column;overscroll-behavior:contain}
      .pdf-edit-overlay.open{display:flex}
      .pdf-edit-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:#fff;border-bottom:1px solid #d7dfdc;box-shadow:0 2px 10px rgba(0,0,0,.16)}
      .pdf-edit-toolbar .spacer{flex:1}
      .pdf-edit-toolbar button,.pdf-edit-toolbar select,.pdf-edit-toolbar input{min-height:38px}
      .pdf-edit-toolbar button{border:1px solid #cfd8d4;border-radius:9px;background:#fff;padding:7px 12px;font-size:15px;cursor:pointer}
      .pdf-edit-toolbar button.primary{background:#0f766e;color:#fff;border-color:#0f766e}
      .pdf-edit-toolbar button:disabled{opacity:.5;cursor:not-allowed}
      .pdf-edit-page{color:#334155;font-variant-numeric:tabular-nums;white-space:nowrap}
      .pdf-edit-stage-wrap{flex:1;overflow:auto;padding:18px;touch-action:none}
      .pdf-edit-stage{position:relative;margin:0 auto;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);width:max-content;line-height:0}
      .pdf-edit-stage canvas{display:block}
      #pdf-edit-draw{position:absolute;inset:0;touch-action:none;cursor:crosshair}
      .att-pdf-doodle{margin-left:10px}
      @media(max-width:720px){.pdf-edit-toolbar{gap:6px;padding:8px}.pdf-edit-toolbar button{padding:6px 9px;font-size:14px}.pdf-edit-stage-wrap{padding:8px}}
    `;
    document.head.appendChild(style);
  }

  function addModal() {
    if (document.getElementById("pdf-edit-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "pdf-edit-overlay";
    overlay.className = "pdf-edit-overlay";
    overlay.innerHTML = `
      <div class="pdf-edit-toolbar">
        <button id="pdf-edit-close" type="button">✕ 關閉</button>
        <button id="pdf-edit-prev" type="button">‹ 上一頁</button>
        <span class="pdf-edit-page" id="pdf-edit-page">第 1 / 1 頁</span>
        <button id="pdf-edit-next" type="button">下一頁 ›</button>
        <label>筆色 <input id="pdf-edit-color" type="color" value="#e11d48" aria-label="筆色"></label>
        <label>粗細 <select id="pdf-edit-width" aria-label="筆畫粗細"><option value="2">細</option><option value="5" selected>中</option><option value="10">粗</option><option value="18">特粗</option></select></label>
        <button id="pdf-edit-undo" type="button">↶ 復原</button>
        <button id="pdf-edit-clear" type="button">清除本頁</button>
        <span class="spacer"></span>
        <button id="pdf-edit-save" class="primary" type="button">💾 存回 Fieldlog</button>
      </div>
      <div class="pdf-edit-stage-wrap" id="pdf-edit-stage-wrap">
        <div class="pdf-edit-stage" id="pdf-edit-stage">
          <canvas id="pdf-edit-base"></canvas>
          <canvas id="pdf-edit-draw"></canvas>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById("pdf-edit-close").onclick = closeEditor;
    document.getElementById("pdf-edit-prev").onclick = () => changePage(-1);
    document.getElementById("pdf-edit-next").onclick = () => changePage(1);
    document.getElementById("pdf-edit-undo").onclick = undoPage;
    document.getElementById("pdf-edit-clear").onclick = clearPage;
    document.getElementById("pdf-edit-save").onclick = savePdf;

    const canvas = document.getElementById("pdf-edit-draw");
    canvas.addEventListener("pointerdown", beginStroke);
    canvas.addEventListener("pointermove", continueStroke);
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
  }

  function drawCanvas() { return document.getElementById("pdf-edit-draw"); }

  function pageHistory(pageNo = state.pageNo) {
    if (!state.histories.has(pageNo)) state.histories.set(pageNo, [null]);
    if (!state.historyIndex.has(pageNo)) state.historyIndex.set(pageNo, 0);
    return state.histories.get(pageNo);
  }

  function currentSnapshot(pageNo = state.pageNo) {
    const history = pageHistory(pageNo);
    return history[state.historyIndex.get(pageNo) || 0] || null;
  }

  function pushSnapshot(snapshot = drawCanvas().toDataURL("image/png")) {
    const history = pageHistory();
    const currentIndex = state.historyIndex.get(state.pageNo) || 0;
    history.splice(currentIndex + 1);
    history.push(snapshot);
    state.historyIndex.set(state.pageNo, history.length - 1);
    updateUndoButton();
  }

  async function restoreSnapshot(snapshot) {
    const canvas = drawCanvas();
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!snapshot) return;
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = snapshot;
    });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  function updateUndoButton() {
    const index = state.historyIndex.get(state.pageNo) || 0;
    document.getElementById("pdf-edit-undo").disabled = index <= 0;
  }

  function canvasPoint(event) {
    const canvas = drawCanvas();
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
  }

  function beginStroke(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const canvas = drawCanvas();
    canvas.setPointerCapture?.(event.pointerId);
    state.drawing = true;
    state.lastPoint = canvasPoint(event);
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.arc(state.lastPoint.x, state.lastPoint.y, Number(document.getElementById("pdf-edit-width").value) / 2, 0, Math.PI * 2);
    ctx.fillStyle = document.getElementById("pdf-edit-color").value;
    ctx.fill();
  }

  function continueStroke(event) {
    if (!state.drawing) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const ctx = drawCanvas().getContext("2d");
    ctx.beginPath();
    ctx.moveTo(state.lastPoint.x, state.lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.strokeStyle = document.getElementById("pdf-edit-color").value;
    ctx.lineWidth = Number(document.getElementById("pdf-edit-width").value);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    state.lastPoint = point;
  }

  function endStroke(event) {
    if (!state.drawing) return;
    event?.preventDefault?.();
    state.drawing = false;
    state.lastPoint = null;
    pushSnapshot();
  }

  async function renderPage() {
    const page = await state.pdf.getPage(state.pageNo);
    const wrap = document.getElementById("pdf-edit-stage-wrap");
    const baseViewport = page.getViewport({ scale: 1 });
    const available = Math.max(320, Math.min(1200, wrap.clientWidth - 24));
    state.scale = Math.min(2, Math.max(0.75, available / baseViewport.width));
    const viewport = page.getViewport({ scale: state.scale });
    const base = document.getElementById("pdf-edit-base");
    const draw = drawCanvas();
    base.width = Math.ceil(viewport.width);
    base.height = Math.ceil(viewport.height);
    draw.width = base.width;
    draw.height = base.height;
    document.getElementById("pdf-edit-stage").style.width = base.width + "px";
    document.getElementById("pdf-edit-stage").style.height = base.height + "px";
    await page.render({ canvasContext: base.getContext("2d"), viewport }).promise;
    await restoreSnapshot(currentSnapshot());
    document.getElementById("pdf-edit-page").textContent = `第 ${state.pageNo} / ${state.pageCount} 頁`;
    document.getElementById("pdf-edit-prev").disabled = state.pageNo <= 1;
    document.getElementById("pdf-edit-next").disabled = state.pageNo >= state.pageCount;
    updateUndoButton();
    wrap.scrollTop = 0;
    wrap.scrollLeft = Math.max(0, (base.width - wrap.clientWidth) / 2);
  }

  async function changePage(delta) {
    const next = state.pageNo + delta;
    if (next < 1 || next > state.pageCount || state.drawing) return;
    state.pageNo = next;
    await renderPage();
  }

  async function undoPage() {
    const index = state.historyIndex.get(state.pageNo) || 0;
    if (index <= 0) return;
    state.historyIndex.set(state.pageNo, index - 1);
    await restoreSnapshot(currentSnapshot());
    updateUndoButton();
  }

  async function clearPage() {
    const canvas = drawCanvas();
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    pushSnapshot(null);
  }

  function hasInk(snapshot) {
    return typeof snapshot === "string" && snapshot.startsWith("data:image/png") && snapshot.length > 300;
  }

  async function uploadAnnotatedPdf(blob, filename) {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-pin": typeof pin === "function" ? pin() : (localStorage.getItem("fieldlog_pin") || ""),
        "x-entry-id": String(state.entryId),
        "x-filename": encodeURIComponent(filename),
      },
      body: blob,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `上傳失敗（HTTP ${response.status}）`);
    return body;
  }

  async function savePdf() {
    const changedPages = [...state.histories.keys()].filter((pageNo) => hasInk(currentSnapshot(pageNo)));
    if (!changedPages.length) {
      notify("目前沒有塗鴉內容，不需要存檔");
      return;
    }
    const saveButton = document.getElementById("pdf-edit-save");
    saveButton.disabled = true;
    saveButton.textContent = "合成並上傳中…";
    try {
      const { PDFDocument } = await ensurePdfLib();
      const pdfDoc = await PDFDocument.load(state.sourceBytes, { ignoreEncryption: false });
      const pages = pdfDoc.getPages();
      for (const pageNo of changedPages) {
        const snapshot = currentSnapshot(pageNo);
        const pngBytes = await fetch(snapshot).then((r) => r.arrayBuffer());
        const image = await pdfDoc.embedPng(pngBytes);
        const page = pages[pageNo - 1];
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
      const savedBytes = await pdfDoc.save({ useObjectStreams: true });
      if (savedBytes.byteLength > 50 * 1024 * 1024) throw new Error("塗鴉後 PDF 超過 50MB，無法上傳");
      const stem = String(state.attachment.filename || "PDF文件").replace(/\.pdf$/i, "").replace(/_塗鴉(?:_\d{8}-\d{4})?$/i, "");
      const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
      const filename = `${stem}_塗鴉_${stamp}.pdf`;
      const savedEntryId = state.entryId;
      await uploadAnnotatedPdf(new Blob([savedBytes], { type: "application/pdf" }), filename);
      notify(`已存成新附件：${filename}`);
      closeEditor();
      if (typeof openEntry === "function") await openEntry(savedEntryId);
    } catch (error) {
      notify("PDF 塗鴉存檔失敗：" + error.message);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "💾 存回 Fieldlog";
    }
  }

  function closeEditor() {
    document.getElementById("pdf-edit-overlay")?.classList.remove("open");
    state.entryId = 0;
    state.attachment = null;
    state.sourceBytes = null;
    state.pdf = null;
    state.histories.clear();
    state.historyIndex.clear();
    state.drawing = false;
  }

  async function openPdfEditor(entryId, attachment) {
    if (!window.pdfjsLib) {
      notify("PDF 顯示程式庫尚未載入，請重新整理頁面後再試");
      return;
    }
    addStyles();
    addModal();
    const overlay = document.getElementById("pdf-edit-overlay");
    overlay.classList.add("open");
    document.getElementById("pdf-edit-page").textContent = "正在下載 PDF…";
    document.getElementById("pdf-edit-save").disabled = true;
    try {
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      }
      const key = encodeURIComponent(attachment.key);
      const accessPin = typeof pin === "function" ? pin() : (localStorage.getItem("fieldlog_pin") || "");
      const response = await fetch(`/api/file/${key}?pin=${encodeURIComponent(accessPin)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`下載失敗（HTTP ${response.status}）`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      state.entryId = Number(entryId);
      state.attachment = attachment;
      state.sourceBytes = bytes.slice();
      state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      state.pageNo = 1;
      state.pageCount = state.pdf.numPages;
      state.histories.clear();
      state.historyIndex.clear();
      await renderPage();
      document.getElementById("pdf-edit-save").disabled = false;
    } catch (error) {
      closeEditor();
      notify("無法開啟 PDF 塗鴉：" + error.message);
    }
  }

  const originalAttHtml = typeof attHtml === "function" ? attHtml : null;
  if (originalAttHtml) {
    attHtml = function fieldlogV39AttHtml(attachment, siblings) {
      let html = originalAttHtml(attachment, siblings);
      const isPdf = (attachment.mime || "") === "application/pdf" || /\.pdf$/i.test(attachment.filename || "");
      if (isPdf) {
        html = html.replace(
          `<a href="#" class="att-delete" data-id="${attachment.id}">刪除</a>`,
          `<a href="#" class="att-pdf-doodle" data-id="${attachment.id}">✍️ 塗鴉</a><a href="#" class="att-delete" data-id="${attachment.id}">刪除</a>`
        );
      }
      return html;
    };
  }

  const originalBindAttActions = typeof bindAttActions === "function" ? bindAttActions : null;
  if (originalBindAttActions) {
    bindAttActions = function fieldlogV39BindAttActions(entryId) {
      originalBindAttActions(entryId);
      document.querySelectorAll(".att-pdf-doodle").forEach((element) => {
        element.onclick = async (event) => {
          event.preventDefault();
          try {
            const entry = await api(`/entries/${entryId}`);
            const attachment = (entry.attachments || []).find((item) => String(item.id) === element.dataset.id);
            if (!attachment) throw new Error("找不到 PDF 附件");
            await openPdfEditor(entryId, attachment);
          } catch (error) {
            notify("開啟塗鴉失敗：" + error.message);
          }
        };
      });
    };
  }
})();
