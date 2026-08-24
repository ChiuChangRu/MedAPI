import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("PDF 預覽可縮小、放大、符合寬度，欄寬改變會重新排版", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  const preview = app.match(/async function renderPdfPreview[\s\S]*?\n}\n\nfunction safeHtmlPreviewDocument/)?.[0] || "";
  assert.match(preview, /data-zoom="out"/);
  assert.match(preview, /data-zoom="in"/);
  assert.match(preview, /data-zoom="fit"/);
  assert.match(preview, /Math\.max\(0\.5, Math\.min\(3,/);
  assert.match(preview, /new ResizeObserver/);
  assert.match(preview, /canvas\.style\.width/);
  assert.match(css, /\.pdf-sidebar-canvas-wrap canvas \{[^}]*max-width: none;/);
});

test("HTML 改為抓取後安全清理，不直接執行上傳內容", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function safeHtmlPreviewDocument\(source\)/);
  assert.match(app, /script,iframe,frame,frameset,object,embed,form/);
  assert.match(app, /name\.startsWith\("on"\)/);
  assert.match(app, /frame\.setAttribute\("sandbox", ""\)/);
  assert.match(app, /frame\.srcdoc = safeHtmlPreviewDocument\(text\)/);
  assert.match(app, /else if \(html\) await renderHtmlPreview/);
  assert.doesNotMatch(app, /else if \(html\) body\.innerHTML = `<iframe/);
});

test("舊檔 MIME 依副檔名補正，涵蓋 HTML、圖片、影音與 Office", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const fileRoute = worker.match(/const fileMatch = path\.match[\s\S]*?\/\/ 後臺整理既有附件名稱/)?.[0] || "";
  for (const mime of [
    "text/html; charset=utf-8", "image/jpeg", "image/png", "image/svg+xml",
    "audio/mpeg", "video/mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]) assert.ok(fileRoute.includes(mime), `缺少 ${mime}`);
  assert.match(fileRoute, /application\/xhtml\+xml/);
  assert.match(fileRoute, /image\/svg\+xml/);
});

test("全螢幕編輯隱藏資料夾操作列並補滿垂直空間", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /body\.reader-fullscreen \.folder-actions \{ display: none; \}/);
  assert.match(css, /body\.reader-fullscreen \.folder-preview \{[\s\S]*?top: 70px;[\s\S]*?height: calc\(100vh - 86px\);/);
});

test("常用純文字與程式檔都走文字預覽", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /"yaml", "yml", "ini", "cfg", "log", "sql", "js", "ts", "css", "py", "sh"/);
});

test("圖片、音訊、影片即使舊 MIME 錯誤也會依副檔名預覽", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /\["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"\]\.includes\(ext\)/);
  assert.match(app, /\["mp3", "m4a", "wav", "ogg", "aac", "flac", "opus"\]\.includes\(ext\)/);
  assert.match(app, /\["mp4", "webm", "mov", "m4v"\]\.includes\(ext\)/);
});
