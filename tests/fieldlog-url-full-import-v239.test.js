/**
 * v239 網址完整下載：網頁文字＋圖片＋影片都存進同一筆紀錄。
 * 抽取邏輯是純函式直接測；端點用 node:sqlite 當 D1、假 R2、假 fetch 實跑。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  bestSrcsetUrl, extractPageResources, extractPageText, mediaExtension, mediaFilename, mediaKind,
} from "../fieldlog/src/lib/page-extract.js";

const BASE = "https://news.example.org/post/1";
const HTML = `<!doctype html><html><head>
<title>測試文章 | 站名</title>
<meta property="og:title" content="測試文章">
<meta property="og:image" content="/img/cover.jpg">
<meta property="og:video" content="https://cdn.example.org/clip.mp4">
<script>var x = "<img src='/img/in-script.jpg'>";</script>
</head><body><nav>選單不要</nav><article>
<h1>標題</h1><p>第一段內容。</p>
<img src="/img/a.jpg" alt="圖A" width="800">
<img data-src="/img/lazy.png" src="data:image/gif;base64,R0lGOD">
<img srcset="/img/s-400.jpg 400w, /img/s-1200.jpg 1200w" src="/img/s-400.jpg">
<img src="/img/pixel.gif" width="1" height="1">
<img src="/img/logo.svg">
<picture><source srcset="/img/pic-2x.webp 2x, /img/pic-1x.webp 1x"><img src="/img/pic-1x.jpg"></picture>
<video src="/v/local.mp4" poster="/img/poster.jpg"></video>
<video><source src="/v/second.webm" type="video/webm"></video>
<a href="/files/demo.mov">下載示範</a>
<iframe src="https://www.youtube.com/embed/abc123"></iframe>
<noscript><img src="/img/noscript.jpg"></noscript>
<p>第二段內容。</p></article><footer>頁尾不要</footer></body></html>`;

test("extractPageResources：圖片、影片、內嵌影片、標題與過濾", () => {
  const r = extractPageResources(HTML, BASE, { maxVideos: 10 });
  const imgs = r.images.map((i) => i.url);
  assert.equal(r.title, "測試文章", "優先用 og:title");
  assert.equal(imgs[0], "https://news.example.org/img/cover.jpg", "og:image 排最前面");
  assert.ok(imgs.includes("https://news.example.org/img/a.jpg"));
  assert.ok(imgs.includes("https://news.example.org/img/lazy.png"), "懶載入 data-src");
  assert.ok(imgs.includes("https://news.example.org/img/s-1200.jpg"), "srcset 取最大張");
  assert.ok(!imgs.includes("https://news.example.org/img/s-400.jpg"));
  assert.ok(imgs.includes("https://news.example.org/img/pic-2x.webp"), "picture/source");
  assert.ok(imgs.includes("https://news.example.org/img/poster.jpg"), "video poster");
  assert.ok(imgs.includes("https://news.example.org/img/noscript.jpg"), "noscript 內的圖");
  assert.ok(!imgs.some((u) => /pixel|logo\.svg|in-script/.test(u)), "追蹤像素、svg、script 內字串不抓");
  assert.ok(!imgs.some((u) => u.startsWith("data:")));
  const vids = r.videos.map((v) => v.url);
  assert.deepEqual(vids.sort(), [
    "https://cdn.example.org/clip.mp4", "https://news.example.org/files/demo.mov",
    "https://news.example.org/v/local.mp4", "https://news.example.org/v/second.webm",
  ].sort());
  assert.deepEqual(r.embeds.map((e) => e.url), ["https://www.youtube.com/embed/abc123"]);
});

test("extractPageResources：影片預設最多 3 支", () => {
  assert.equal(extractPageResources(HTML, BASE).videos.length, 3);
  assert.equal(extractPageResources(HTML, BASE).skipped.videos, 1);
});

test("extractPageResources：數量上限與 srcset 解析", () => {
  const many = Array.from({ length: 40 }, (_, i) => `<img src="/i/${i}.jpg">`).join("");
  const r = extractPageResources(`<body>${many}</body>`, BASE, { maxImages: 30 });
  assert.equal(r.images.length, 30);
  assert.equal(r.skipped.images, 10);
  assert.equal(extractPageResources(`<body>${many}</body>`, BASE).images.length, 40, "預設上限 50，專利圖面多");
  assert.equal(bestSrcsetUrl("a.jpg 1x, b.jpg 2x, c.jpg 3x"), "c.jpg");
  assert.equal(bestSrcsetUrl("only.jpg"), "only.jpg");
});

test("extractPageText：取文章正文，去掉導覽、頁尾與 script", () => {
  const text = extractPageText(HTML);
  assert.match(text, /第一段內容。/);
  assert.match(text, /第二段內容。/);
  assert.doesNotMatch(text, /選單不要|頁尾不要|in-script/);
});

test("mediaExtension／mediaKind／mediaFilename", () => {
  assert.equal(mediaExtension("image/jpeg; charset=x", "https://a/b"), "jpg");
  assert.equal(mediaExtension("application/octet-stream", "https://a/b/c.mp4?x=1"), "mp4");
  assert.equal(mediaExtension("text/html", "https://a/b.jpg"), "", "實際 mime 是網頁就不收");
  assert.equal(mediaKind("webm"), "video");
  assert.equal(mediaKind("png"), "photo");
  assert.equal(mediaFilename("photo", 3, "jpg", "x"), "圖片-003.jpg");
  assert.equal(mediaFilename("video", 1, "mp4", "https://a/b/%E7%A4%BA%E7%AF%84%E5%BD%B1%E7%89%87.mp4"), "示範影片.mp4");
  assert.equal(mediaFilename("video", 2, "mp4", "https://a/b/v1.mp4"), "影片-2.mp4", "檔名太短就用編號");
});

// ---------- 端點 ----------
function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { sqlite, prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
}
function bytes(n, seed) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; }

function installFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), referer: init.headers?.referer });
    const hit = routes[String(url)];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status || 200, headers: hit.headers });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function runImport(db, body, extraEnv = {}) {
  const puts = [];
  const env = { DB: db, FIELD_PIN: "1234", FILES: { async put(key, value) { puts.push({ key, size: value.byteLength }); }, async delete() {} }, ...extraEnv };
  const res = await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/import-url/full", {
    method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json(), puts };
}

test("import-url/full：文字存進內文，圖片與影片存成附件，內嵌影片只留連結", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  db.sqlite.exec("SELECT 1");
  const html = `<html><head><title>範例頁</title></head><body><article><p>正文內容</p>
    <img src="/a.jpg"><img src="/b.png"><img src="/a.jpg"><img src="/tiny.gif"><img src="/broken.jpg">
    <video src="/clip.mp4"></video><iframe src="https://www.youtube.com/embed/xyz"></iframe></article></body></html>`;
  const fx = installFetch({
    "https://site.example.org/page": { body: html, headers: { "content-type": "text/html; charset=utf-8" } },
    "https://site.example.org/a.jpg": { body: bytes(5000, 1), headers: { "content-type": "image/jpeg" } },
    "https://site.example.org/b.png": { body: bytes(6000, 2), headers: { "content-type": "image/png" } },
    "https://site.example.org/tiny.gif": { body: bytes(200, 3), headers: { "content-type": "image/gif" } },
    "https://site.example.org/clip.mp4": { body: bytes(20000, 4), headers: { "content-type": "video/mp4" } },
  });
  try {
    await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/folders", {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify({ name: "資料夾", category: "misc" }),
    }), { DB: db, FIELD_PIN: "1234" });
    const folderId = db.sqlite.prepare("SELECT id FROM folders LIMIT 1").get().id;
    const r = await runImport(db, { url: "https://site.example.org/page", folder_id: folderId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, "範例頁");
    assert.equal(r.body.saved.images, 2, "a.jpg 與 b.png；重複的、太小的、404 的不算");
    assert.equal(r.body.saved.videos, 1);
    assert.deepEqual(r.body.embeds.map((e) => e.url), ["https://www.youtube.com/embed/xyz"]);
    assert.ok(r.body.failures.some((f) => /broken\.jpg/.test(f.url)), "失敗項目有列出");
    assert.ok(!r.body.failures.some((f) => /tiny\.gif/.test(f.url)), "太小的圖不當成失敗");

    const atts = db.sqlite.prepare("SELECT kind, filename, mime, source_url FROM attachments ORDER BY id").all();
    assert.deepEqual(atts.map((a) => [a.kind, a.filename]), [["photo", "圖片-001.jpg"], ["photo", "圖片-002.png"], ["video", "clip.mp4"]]);
    assert.equal(atts[2].mime, "video/mp4");
    const entry = db.sqlite.prepare("SELECT * FROM entries WHERE id = ?").get(r.body.entry_id);
    assert.equal(entry.folder_id, folderId);
    assert.match(entry.body, /正文內容/);
    assert.match(entry.body, /已下載：2 張圖片、1 支影片/);
    assert.match(entry.body, /youtube\.com\/embed\/xyz/);
    const fields = JSON.parse(entry.fields_json);
    assert.equal(fields.source, "url_full_import");
    assert.equal(fields.image_count, 2);
    // 圖片請求帶 Referer，避免防盜連
    assert.ok(fx.calls.filter((c) => /\.jpg$/.test(c.url)).every((c) => c.referer === "https://site.example.org/page"));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM history WHERE action = '網址完整下載'").get().n, 1);
  } finally { fx.restore(); }
});

test("import-url/full：每個子資源都過公開網址檢查（內網、本機圖片不會被抓）", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const html = `<html><head><title>內網測試</title></head><body><p>文字</p>
    <img src="http://127.0.0.1/secret.jpg"><img src="http://169.254.169.254/latest/meta.jpg"><img src="https://ok.example.org/ok.jpg"></body></html>`;
  const fx = installFetch({
    "https://site.example.org/p": { body: html, headers: { "content-type": "text/html" } },
    "https://ok.example.org/ok.jpg": { body: bytes(5000, 9), headers: { "content-type": "image/jpeg" } },
  });
  try {
    await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/folders", {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify({ name: "F", category: "misc" }),
    }), { DB: db, FIELD_PIN: "1234" });
    const folderId = db.sqlite.prepare("SELECT id FROM folders LIMIT 1").get().id;
    const r = await runImport(db, { url: "https://site.example.org/p", folder_id: folderId });
    assert.equal(r.body.saved.images, 1);
    assert.ok(!fx.calls.some((c) => /127\.0\.0\.1|169\.254/.test(c.url)), "內網網址完全沒有被連線");
    assert.equal(r.body.failures.length, 2);
  } finally { fx.restore(); }
});

test("import-url/full：整頁沒有任何內容時不留下空紀錄；找不到資料夾回 404", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const fx = installFetch({ "https://site.example.org/empty": { body: "<html><head></head><body></body></html>", headers: { "content-type": "text/html" } } });
  try {
    await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/folders", {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify({ name: "F", category: "misc" }),
    }), { DB: db, FIELD_PIN: "1234" });
    const folderId = db.sqlite.prepare("SELECT id FROM folders LIMIT 1").get().id;
    const empty = await runImport(db, { url: "https://site.example.org/empty", folder_id: folderId });
    assert.equal(empty.status, 422);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM entries").get().n, 0);
    assert.equal((await runImport(db, { url: "https://site.example.org/empty", folder_id: 9999 })).status, 404);
    assert.equal((await runImport(db, { url: "http://localhost/x", folder_id: folderId })).status, 400);
  } finally { fx.restore(); }
});

test("import-url/full：網址本身是影片檔時直接存成一個影片附件", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const fx = installFetch({ "https://cdn.example.org/demo.mp4": { body: bytes(9000, 7), headers: { "content-type": "video/mp4" } } });
  try {
    await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/folders", {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify({ name: "F", category: "misc" }),
    }), { DB: db, FIELD_PIN: "1234" });
    const folderId = db.sqlite.prepare("SELECT id FROM folders LIMIT 1").get().id;
    const r = await runImport(db, { url: "https://cdn.example.org/demo.mp4", folder_id: folderId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved.videos, 1);
    assert.equal(db.sqlite.prepare("SELECT kind, filename FROM attachments").get().kind, "video");
  } finally { fx.restore(); }
});

// ---------- v240 專利／圖庫：優先抓高清圖與 PDF 原檔 ----------
const PATENT = `<html><head><title>US123 - 某專利</title>
<meta name="citation_pdf_url" content="https://patentimages.storage.example.org/ab/US123.pdf">
</head><body><section>
<ul>
<li itemprop="images"><img itemprop="thumbnail" src="https://patentimages.storage.example.org/ab/US123-thumb-1.png"><meta itemprop="full" content="https://patentimages.storage.example.org/ab/US123-drawings-page-1.png"></li>
<li itemprop="images"><img itemprop="thumbnail" src="https://patentimages.storage.example.org/ab/US123-thumb-2.png"><meta itemprop="full" content="https://patentimages.storage.example.org/ab/US123-drawings-page-2.png"></li>
</ul>
<a href="/big/photo-large.jpg"><img src="/small/photo-small.jpg"></a>
<img src="/x/zoom-thumb.jpg" data-zoom-image="/x/zoom-full.jpg">
</section></body></html>`;

test("專利頁：取 itemprop=full 高清圖、略過縮圖、找出 citation_pdf_url", () => {
  const r = extractPageResources(PATENT, "https://patents.example.org/patent/US123");
  const urls = r.images.map((i) => i.url);
  assert.deepEqual(urls.slice(0, 2), [
    "https://patentimages.storage.example.org/ab/US123-drawings-page-1.png",
    "https://patentimages.storage.example.org/ab/US123-drawings-page-2.png",
  ], "高清圖排最前面、依頁序");
  assert.ok(!urls.some((u) => /thumb-[12]/.test(u)), "有高清版的縮圖不抓");
  assert.ok(urls.includes("https://patents.example.org/big/photo-large.jpg"), "<a href=大圖><img 縮圖> 取連結的大圖");
  assert.ok(!urls.includes("https://patents.example.org/small/photo-small.jpg"));
  assert.ok(urls.includes("https://patents.example.org/x/zoom-full.jpg"), "data-zoom-image 優先");
  assert.ok(!urls.includes("https://patents.example.org/x/zoom-thumb.jpg"));
  assert.deepEqual(r.pdfs.map((p) => p.url), ["https://patentimages.storage.example.org/ab/US123.pdf"]);
});

test("import-url/full：專利頁下載高清圖與 PDF 原檔，不再另外轉整頁 PDF", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...bytes(6000, 5)]);
  const fx = installFetch({
    "https://patents.example.org/patent/US123": { body: PATENT.replace(/<a href="\/big[^]*?<\/a>/, ""), headers: { "content-type": "text/html" } },
    "https://patentimages.storage.example.org/ab/US123-drawings-page-1.png": { body: bytes(8000, 1), headers: { "content-type": "image/png" } },
    "https://patentimages.storage.example.org/ab/US123-drawings-page-2.png": { body: bytes(9000, 2), headers: { "content-type": "image/png" } },
    "https://patentimages.storage.example.org/ab/US123.pdf": { body: pdf, headers: { "content-type": "application/pdf" } },
    "https://patents.example.org/x/zoom-full.jpg": { body: bytes(7000, 3), headers: { "content-type": "image/jpeg" } },
  });
  let browserCalls = 0;
  try {
    await fieldlogWorker.fetch(new Request("https://fieldlog.example.dev/api/folders", {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify({ name: "專利", category: "misc" }),
    }), { DB: db, FIELD_PIN: "1234" });
    const folderId = db.sqlite.prepare("SELECT id FROM folders LIMIT 1").get().id;
    const r = await runImport(db, { url: "https://patents.example.org/patent/US123", folder_id: folderId }, { BROWSER: { quickAction: async () => { browserCalls++; return new Response("x", { status: 500 }); } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved.images, 3);
    assert.equal(r.body.saved.source_pdfs, 1);
    assert.equal(browserCalls, 0, "已有 PDF 原檔就不再轉整頁 PDF");
    const atts = db.sqlite.prepare("SELECT kind, filename, mime FROM attachments ORDER BY id").all();
    assert.deepEqual(atts.map((a) => a.kind), ["photo", "photo", "photo", "file"]);
    assert.equal(atts[3].mime, "application/pdf");
    assert.match(atts[3].filename, /\.pdf$/);
    assert.match(db.sqlite.prepare("SELECT body FROM entries").get().body, /1 份 PDF 原檔/);
  } finally { fx.restore(); }
});
