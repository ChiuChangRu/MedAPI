// 隨身記 Service Worker：快取 UI 資源，斷網時介面照常開啟
// （raw data 的離線保底走 app.js 的 IndexedDB 佇列，這裡只管殼）
const CACHE = "fieldlog-v29";
const ASSETS = ["./", "index.html", "app.js?v=29", "style.css?v=29", "wiki.html", "manifest.json", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

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

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API 永遠走網路
  if (url.pathname.startsWith("/wiki/")) return; // wiki 內容受 PIN 保護，不進快取
  // 網路優先、失敗退回快取：確保拿到最新版 UI，但斷網也開得起來
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
