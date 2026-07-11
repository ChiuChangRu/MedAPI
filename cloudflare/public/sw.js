// 離線快取：讓網站在完全沒有網路時也能開啟（展場訊號不穩的保險）
// 策略：網路優先、失敗時退回快取（確保有網路時永遠拿到最新版）
const CACHE = "medtec-shell-v1";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/config.js", "/data/exhibitors.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API 一律走網路（不快取共筆資料，避免看到過期內容而不自知）
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((m) => m || caches.match("/index.html"))
      )
  );
});
