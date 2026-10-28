// Word（.docx）排版預覽：在瀏覽器裡依原檔版面畫出段落、表格、標題、頁首頁尾與圖片。
// 函式庫自架在 vendor/，檔案不會送到外部服務。畫在 shadow root 裡，
// 避免 app 的 CSS 把 Word 版面擠歪，也避免 Word 的樣式漏到 app。
let libraryPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`無法載入 ${src}`));
    document.head.appendChild(script);
  });
}

function loadLibrary() {
  // docx-preview 的 UMD 版本讀全域 JSZip，所以要先載 JSZip
  libraryPromise ||= (async () => {
    if (!window.JSZip) await loadScript("./vendor/jszip.min.js");
    if (!window.docx?.renderAsync) await loadScript("./vendor/docx-preview-0.4.1.min.js");
    if (!window.docx?.renderAsync) throw new Error("Word 預覽元件載入失敗");
    return window.docx;
  })().catch((error) => { libraryPromise = null; throw error; });
  return libraryPromise;
}

// Word 內的超連結只保留 http/https/mailto 與文件內錨點，其他協定（javascript: 等）一律拿掉
function sanitizeLinks(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    try {
      const url = new URL(href, location.href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) { a.removeAttribute("href"); return; }
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } catch { a.removeAttribute("href"); }
  });
}

export async function renderDocxPreview(url, body, filename) {
  const abort = new AbortController();
  let disposed = false;
  body.innerHTML = `<section class="docx-preview" aria-label="Word 排版預覽">
    <p class="docx-preview-status" role="status">正在載入 Word 排版…</p>
    <div class="docx-preview-stage"></div>
    <p class="docx-preview-note">排版預覽；文字方塊、追蹤修訂、特殊欄位與精確字型可能與 Word 不同，請以原檔為準。純文字請切換至「文字內容」。</p>
  </section>`;
  const status = body.querySelector(".docx-preview-status");
  const stage = body.querySelector(".docx-preview-stage");
  const shadow = stage.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host { display: block; }
    .docx-wrapper { background: #E9E4DA !important; padding: 16px 8px !important; }
    .docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(31,41,51,.18) !important; margin-bottom: 16px !important; }
    img { max-width: 100%; height: auto; }
  </style><div class="docx-styles"></div><div class="docx-body"></div>`;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    if (body._previewCleanup === cleanup) body._previewCleanup = null;
  };
  body._previewCleanup = cleanup;
  try {
    const [docx, response] = await Promise.all([
      loadLibrary(),
      fetch(url, { credentials: "same-origin", signal: abort.signal }),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (disposed) return;
    await docx.renderAsync(buffer, shadow.querySelector(".docx-body"), shadow.querySelector(".docx-styles"), {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: false,
      renderComments: false,
      // altChunk 是內嵌的整份 HTML，可能夾帶腳本，不渲染
      renderAltChunks: false,
      useBase64URL: true,
      experimental: false,
    });
    if (disposed) return;
    sanitizeLinks(shadow);
    fitToWidth(stage, shadow);
    stage.setAttribute("aria-label", `${filename} 排版預覽`);
    status.textContent = "";
    status.hidden = true;
  } catch (error) {
    if (disposed) return;
    status.textContent = "無法產生 Word 排版預覽。可重試、開啟原檔，或切換至「文字內容」看純文字。";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn small"; retry.textContent = "重新載入預覽";
    retry.onclick = () => { cleanup(); return renderDocxPreview(url, body, filename); };
    status.append(" ", retry);
  }
}

// 右欄比 A4 窄時整份等比例縮小，不出現左右捲軸
function fitToWidth(stage, shadow) {
  const wrapper = shadow.querySelector(".docx-wrapper");
  if (!wrapper) return;
  const apply = () => {
    wrapper.style.zoom = "";
    const page = wrapper.querySelector("section.docx");
    const natural = (page?.offsetWidth || 0) + 16;
    const available = stage.clientWidth;
    if (natural > 0 && available > 0 && natural > available) wrapper.style.zoom = String(Math.max(0.6, available / natural));
  };
  apply();
  if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(stage);
}
