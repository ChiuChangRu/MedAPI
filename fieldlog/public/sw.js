// 隨身記 Service Worker：快取 UI 資源，斷網時介面照常開啟
// （raw data 的離線保底走 app.js 的 IndexedDB 佇列，這裡只管殼）
// 換 CACHE 名稱＝舊快取全部作廢（activate 時會刪掉名稱不符的）。
// ASSETS 裡的查詢字串要跟 index.html 上的一致，否則預快取的是另一個 URL、
// 等於沒快取到（斷網時開不起來，而且不會有任何錯誤提示）。
const CACHE = "fieldlog-v256-kg-domains";
const ASSETS = ["./", "index.html", "app.js?v=256", "file-selection.js?v=256", "inspector.js?v=256", "graph3d.js?v=256", "graph-view.js?v=256", "entity-graph.js?v=256", "lab.js?v=256", "style.css?v=256", "home.css?v=256", "pdf-editor.js?v=256", "richtext-editor.js?v=256", "wiki.html", "help.html?v=256", "patrol.html", "pm.html", "manifest.json", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

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

