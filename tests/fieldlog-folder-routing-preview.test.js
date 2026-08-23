import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("資料夾頁外部拖放直接使用 CURRENT_FOLDER，首頁才進待分類", async () => {
  const app = await read("../fieldlog/public/app.js");
  const route = app.match(/async function uploadDroppedFilesToCurrentLocation[\s\S]*?\n}/)?.[0] || "";
  assert.match(route, /if \(CURRENT_FOLDER\)/);
  assert.match(route, /uploadStandaloneFiles\(files, Number\(CURRENT_FOLDER\.id\)/);
  assert.match(route, /await stagingFolderId\(\)/);
  assert.doesNotMatch(app, /setupFileDropZone\(\$\("view-folder"\), uploadDroppedFilesToPending\)/);
});

test("資料夾內錄音沿用目前資料夾，首頁錄音才進待分類", async () => {
  const app = await read("../fieldlog/public/app.js");
  const capture = app.match(/async function ensureEntryForCapture[\s\S]*?\n}/)?.[0] || "";
  assert.match(capture, /const folderId = CURRENT_FOLDER \? CURRENT_FOLDER\.id : await stagingFolderId\(\)/);
  assert.match(app, /\$\("btn-audio-f"\)\.onclick = \(\) => startAudio\(null\)/);
});

test("桌機預覽延遲載入且 HTML 使用 sandbox", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="folder-preview"/);
  assert.match(app, /async function showFilePreview/);
  assert.match(app, /<iframe class="folder-preview-frame" sandbox src=/);
  assert.match(app, /async function fetchTextPreview/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.folder-preview/);
});

test("HTML 原檔伺服器端也有 CSP sandbox 與 nosniff", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const fileRoute = worker.match(/const fileMatch = path\.match[\s\S]*?\/\/ 手動整理既有附件名稱/)?.[0] || "";
  assert.match(fileRoute, /"x-content-type-options": "nosniff"/);
  assert.match(fileRoute, /headers\["content-security-policy"\] = "sandbox;/);
  assert.match(fileRoute, /form-action 'none'/);
});

test("單檔與資料包都保留移動入口", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /id="file-move-action"/);
  assert.match(app, /class="record-group-move"/);
  assert.match(app, /class="entry-move"/);
});

test("右側單檔可以拖到左側資料夾並提供復原", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /application\/x-fieldlog-attachment/);
  const tree = app.match(/function renderDesktopFolderTree[\s\S]*?\n}/)?.[0] || "";
  assert.match(tree, /types\.includes\("application\/x-fieldlog-attachment"\)/);
  assert.match(tree, /moveAttachmentToFolder\(payload, targetId\)/);
  const move = app.match(/async function moveAttachmentToFolder[\s\S]*?\n}/)?.[0] || "";
  assert.match(move, /actionLabel: "復原"/);
  assert.match(move, /folder_id: sourceId/);
});

test("預覽可開關、可調欄寬並記住設定", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="btn-toggle-preview"/);
  assert.match(html, /id="folder-preview-resize"[^>]*role="separator"/);
  assert.match(app, /fieldlog_preview_enabled/);
  assert.match(app, /fieldlog_preview_width/);
  assert.match(app, /function initPreviewLayout/);
  assert.match(css, /--preview-width:/);
  assert.match(css, /\.folder-workspace\.preview-off/);
});

test("桌機點選筆記先在右欄唯讀閱讀，另有編輯與全欄寬模式", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="folder-preview-edit"/);
  assert.match(html, /id="folder-preview-expand"/);
  assert.match(html, /id="folder-preview-close"/);
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /function setReaderFullscreen\(enabled\)/);
  assert.match(app, /entry-reader-body/);
  assert.match(css, /body\.reader-fullscreen/);
  assert.match(css, /\.entry-reader/);
});

test("一般記事在右欄直接編輯，週報才沿用專用表單", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css"),
  ]);
  const preview = app.match(/async function showEntryPreview\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  const inline = app.match(/async function showEntryInlineEditor\(entryId, loadedEntry = null\)[\s\S]*?\n}\n\nfunction reopenEntryAfterCapture/)?.[0] || "";
  assert.match(preview, /fields\._kind === "weekly_report"/);
  assert.match(preview, /showEntryInlineEditor\(entryId, entry\)/);
  assert.match(inline, /id="reader-editor-title"/);
  assert.match(inline, /id="reader-editor-rich"/);
  assert.match(inline, /id="reader-editor-save"/);
  assert.match(inline, /id="reader-editor-cancel"/);
  assert.match(inline, /📎 上傳／插圖/);
  assert.match(inline, /📷 拍照/);
  assert.match(inline, /🎙 錄音/);
  assert.match(inline, /🎥 錄影/);
  assert.doesNotMatch(inline, /合併逐字稿|e-folder-path|e-provenance|e-relations/);
  assert.match(app, /function reopenEntryAfterCapture\(entryId\)/);
  assert.match(app, /showEntryPreview\(entryId\)\.catch/);
  assert.match(css, /\.entry-inline-editor/);
});
