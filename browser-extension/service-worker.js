const DEFAULT_MYWIKI_URL = "https://fieldlog.gogoyankee.workers.dev";
const PDF_LIMIT_BYTES = 15 * 1024 * 1024;

function pageSnapshot() {
  const absolute = (value, base) => {
    try { return new URL(value, base).href; } catch { return ""; }
  };
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("script,noscript,iframe,object,embed,form,dialog,button,input,select,textarea").forEach((el) => el.remove());
  clone.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "nonce") el.removeAttribute(attr.name);
    }
    for (const name of ["href", "src", "poster"]) {
      if (el.hasAttribute(name)) {
        const next = absolute(el.getAttribute(name), document.baseURI);
        if (next) el.setAttribute(name, next); else el.removeAttribute(name);
      }
    }
    if (el.hasAttribute("srcset")) el.removeAttribute("srcset");
  });
  const head = clone.querySelector("head");
  if (head) {
    head.querySelectorAll("meta[http-equiv],link[rel=preload],link[rel=prefetch]").forEach((el) => el.remove());
    const base = document.createElement("base");
    base.href = document.baseURI;
    head.prepend(base);
  }
  const article = document.querySelector("article") || document.querySelector("main") || document.body;
  return {
    title: document.title || location.hostname,
    url: location.href,
    text: String(article?.innerText || document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 300000),
    html: `<!doctype html>\n${clone.outerHTML}`,
  };
}

async function printTabToPdf(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    if (!result?.data) throw new Error("瀏覽器沒有產生 PDF");
    const estimatedBytes = Math.floor(result.data.length * 0.75);
    if (estimatedBytes > PDF_LIMIT_BYTES) throw new Error("PDF 超過 15MB，改存 HTML");
    return result.data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function notify(message) {
  await chrome.runtime.sendMessage({ type: "clip-progress", ...message }).catch(() => {});
}

async function saveClip() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("這個頁面不能剪藏；請開啟一般 http／https 網頁");
  await notify({ phase: "read", text: "正在整理網頁內容…", percent: 18 });
  const [{ result: snapshot }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSnapshot });
  let pdfBase64 = "";
  let pdfError = "";
  await notify({ phase: "pdf", text: "正在建立 PDF…", percent: 42 });
  try { pdfBase64 = await printTabToPdf(tab.id); } catch (error) { pdfError = error.message || String(error); }

  const config = await chrome.storage.sync.get({ mywikiUrl: DEFAULT_MYWIKI_URL, pin: "" });
  const baseUrl = String(config.mywikiUrl || DEFAULT_MYWIKI_URL).replace(/\/$/, "");
  await notify({ phase: "upload", text: pdfBase64 ? "正在上傳 PDF 與正文…" : "PDF 無法建立，正在改存 HTML…", percent: 72 });
  const response = await fetch(`${baseUrl}/api/clips`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...(config.pin ? { "x-pin": config.pin } : {}) },
    body: JSON.stringify({ ...snapshot, pdf_base64: pdfBase64 }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error("MyWiki 尚未登入。請先開啟 MyWiki 完成登入，再重新 Clip");
    throw new Error(result.error || `MyWiki 回傳 HTTP ${response.status}`);
  }
  await notify({ phase: "done", text: result.format === "pdf" ? "已存成 PDF 並加入待分類" : "已改存 HTML 並加入待分類", percent: 100, result, pdfError });
  return { ...result, pdfError };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save-clip") return false;
  saveClip().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
