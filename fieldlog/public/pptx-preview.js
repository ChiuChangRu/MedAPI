// Visual PPTX preview. The original attachment stays behind the existing file API.
// Keep the renderer in a shadow root so application CSS cannot reflow slide text.
export async function renderPptxPreview(url, body, filename) {
  const abort = new AbortController();
  let viewer, disposed = false, busy = false, renderWarning = "";
  body.innerHTML = `<section class="pptx-preview" aria-label="投影片預覽">
    <div class="pptx-preview-nav" aria-label="投影片翻頁">
      <button type="button" class="btn small" data-prev disabled>上一頁</button>
      <label>第 <input data-page type="number" min="1" value="1" aria-label="投影片頁碼" disabled> / <span data-count>…</span> 頁</label>
      <button type="button" class="btn small" data-next disabled>下一頁</button>
    </div>
    <p class="pptx-preview-status" role="status">正在載入投影片畫面…大型簡報首次開啟需要一些時間。</p>
    <div class="pptx-preview-stage" tabindex="0" aria-label="投影片畫面，可用左右方向鍵翻頁"></div>
    <p class="pptx-preview-note">投影片靜態畫面預覽；動畫、內嵌影片、轉場及精確字型請用 PowerPoint 開啟原檔。</p>
  </section>`;
  const root = body.querySelector(".pptx-preview");
  const status = root.querySelector(".pptx-preview-status");
  const prev = root.querySelector("[data-prev]"), next = root.querySelector("[data-next]");
  const page = root.querySelector("[data-page]"), count = root.querySelector("[data-count]");
  const stage = root.querySelector(".pptx-preview-stage");
  const shadow = stage.attachShadow({ mode: "open" });
  shadow.innerHTML = '<style>:host{display:block;color:#000;font:16px Arial,"Microsoft JhengHei",sans-serif}*{box-sizing:border-box}.slides{width:100%;min-width:0}video,audio{max-width:100%}</style><div class="slides"></div>';
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    viewer?.destroy();
    if (body._previewCleanup === cleanup) body._previewCleanup = null;
  };
  body._previewCleanup = cleanup;
  const update = () => {
    const index = viewer?.currentSlideIndex || 0;
    prev.disabled = busy || !viewer || index === 0;
    next.disabled = busy || !viewer || index >= viewer.slideCount - 1;
    page.disabled = busy || !viewer;
    page.value = String(index + 1);
    if (viewer) { count.textContent = String(viewer.slideCount); page.max = String(viewer.slideCount); }
  };
  const navigate = async (index) => {
    if (disposed || busy || !viewer || !Number.isFinite(index)) return;
    busy = true; update();
    status.textContent = "載入投影片中…";
    try {
      await viewer.goToSlide(Math.max(0, Math.min(viewer.slideCount - 1, Math.trunc(index))));
      if (!disposed) status.textContent = renderWarning;
    } catch (error) {
      if (!disposed) status.textContent = "此頁無法完整顯示，請嘗試其他頁或開啟原檔。";
    } finally { busy = false; if (!disposed) update(); }
  };
  prev.onclick = () => navigate(viewer.currentSlideIndex - 1);
  next.onclick = () => navigate(viewer.currentSlideIndex + 1);
  page.onchange = () => navigate(Number(page.value) - 1);
  stage.onkeydown = (event) => {
    if (event.target !== stage || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    navigate((viewer?.currentSlideIndex || 0) + (event.key === "ArrowRight" ? 1 : -1));
  };
  try {
    const [{ PptxViewer, RECOMMENDED_ZIP_LIMITS }, response] = await Promise.all([
      import("./vendor/pptx-renderer-1.2.4.js"),
      fetch(url, { credentials: "same-origin", signal: abort.signal }),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (disposed) return;
    viewer = new PptxViewer(shadow.querySelector(".slides"), {
      fitMode: "contain", lazyMedia: true, lazySlides: true,
      zipLimits: RECOMMENDED_ZIP_LIMITS, pdfjs: false,
      onRenderStart: () => { renderWarning = ""; },
      onNodeError: () => { renderWarning = "此頁部分物件無法顯示，請開啟原檔查看完整內容。"; if (!disposed) status.textContent = renderWarning; },
      onSlideError: () => { renderWarning = "此頁無法顯示，請切換其他頁或開啟原檔。"; if (!disposed) status.textContent = renderWarning; },
      onSlideChange: () => { if (!disposed) update(); },
    });
    await viewer.open(buffer, { renderMode: "slide", signal: abort.signal });
    if (disposed) { viewer.destroy(); return; }
    if (!viewer.slideCount) throw new Error("No slides");
    stage.setAttribute("aria-label", `${filename} 投影片畫面，可用左右方向鍵翻頁`);
    status.textContent = renderWarning;
    update();
  } catch (error) {
    if (disposed) return;
    viewer?.destroy(); viewer = null;
    status.textContent = "無法產生投影片畫面。可重試或開啟原檔；擷取文字請切換至「文字內容」。";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn small"; retry.textContent = "重新載入預覽";
    retry.onclick = () => { cleanup(); return renderPptxPreview(url, body, filename); };
    status.append(" ", retry);
    update();
  }
}
