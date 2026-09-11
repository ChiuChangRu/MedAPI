// 隨身記 Service Worker：快取 UI 資源，斷網時介面照常開啟
// （raw data 的離線保底走 app.js 的 IndexedDB 佇列，這裡只管殼）
// 換 CACHE 名稱＝舊快取全部作廢（activate 時會刪掉名稱不符的）。
// ASSETS 裡的查詢字串要跟 index.html 上的一致，否則預快取的是另一個 URL、
// 等於沒快取到（斷網時開不起來，而且不會有任何錯誤提示）。
const CACHE = "fieldlog-v184-mobile-nav-1";
const ASSETS = ["./", "index.html", "app.js?v=184", "file-selection.js?v=184", "inspector.js?v=184", "style.css?v=184", "home.css?v=184", "pdf-editor.js?v=184", "richtext-editor.js?v=184", "mobile-navigation.js?v=184-nav1", "wiki.html", "help.html?v=184", "patrol.html", "manifest.json", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

function withMobileNavigation(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return Promise.resolve(response);
  return response.text().then((html) => {
    if (html.includes("mobile-navigation.js")) {
      return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const tag = '<script src="mobile-navigation.js?v=184-nav1"></script>';
    const patched = html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : `${html}\n${tag}`;
    return new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API 永遠走網路
  if (url.pathname.startsWith("/wiki/")) return; // wiki 內容受 PIN 保護，不進快取
  // 網路優先、失敗退回快取：確保拿到最新版 UI，但斷網也開得起來
  e.respondWith(
    fetch(e.request)
      .then((res) => (e.request.mode === "navigate" ? withMobileNavigation(res) : res))
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((res) => {
        if (!res) return res;
        return e.request.mode === "navigate" ? withMobileNavigation(res) : res;
      }))
  );
});
