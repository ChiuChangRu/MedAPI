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
  assert.match(app, /frame\.className = "folder-preview-frame html-safe-frame"/);
  assert.match(app, /frame\.setAttribute\("sandbox", ""\)/);
  assert.match(app, /async function fetchTextPreview/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.folder-preview/);
});

test("HTML 原檔伺服器端也有 CSP sandbox 與 nosniff", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /"x-content-type-options": "nosniff"/);
  assert.match(worker, /headers\["content-security-policy"\] = "sandbox;/);
  assert.match(worker, /form-action 'none'/);
});

test("所有記事與單一附件管理頁都保留移動入口", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /id="file-move-action"/);
  assert.match(app, /class="entry-move"/);
  assert.match(app, /class="folder-file-manage"/);
  assert.match(app, /class="record-group-move"/);
});

test("右側統一記事可以拖到左側資料夾並提供復原", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /application\/x-fieldlog-entry/);
  assert.match(app, /types\.includes\("application\/x-fieldlog-entry"\)/);
  assert.match(app, /moveInboxEntry\(entryId, targetId, Number\(event\.dataTransfer\.getData\("application\/x-fieldlog-entry-folder"\)\) \|\| null\)/);
  const move = app.match(/async function moveInboxEntry[\s\S]*?\n}/)?.[0] || "";
  assert.match(move, /actionLabel: "上一動"/);
  assert.match(move, /folder_id: folderId/);
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

test("桌機點選筆記直接使用同一個 Word 文件畫面", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="folder-preview-edit"/);
  assert.match(html, /id="folder-preview-expand"/);
  assert.match(html, /id="folder-preview-close"/);
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /function setReaderFullscreen\(enabled\)/);
  const preview = app.match(/async function showEntryPreview\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(preview, /return showEntryEditor\(entryId\)/);
  assert.doesNotMatch(app, /async function renderEntryPreview/);
  assert.doesNotMatch(app, /entry-side-preview/);
  assert.match(app, /preview-editor/);
  assert.match(css, /body\.reader-fullscreen/);
  assert.match(css, /\.preview-editor/);
});

test("一般記事與週報都統一在右欄編輯，週報欄位由 fields_json 判定", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  const editor = app.match(/async function renderEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function showRecordingPreview/)?.[0] || "";
  assert.match(editor, /_kind === "weekly_report"/);
  assert.match(editor, /id="preview-entry-title"/);
  assert.match(editor, /id="preview-entry-rich"/);
  assert.match(editor, /fieldlogRichEditor\?\.init/);
  assert.match(html, /id="folder-preview-save"/);
  assert.match(editor, /\$\("folder-preview-save"\)\.onclick = \(\) => \$\("entry-preview-editor"\)\.requestSubmit\(\)/);
  assert.match(editor, /\$\("folder-preview-edit"\)\.textContent = "還原"/);
  assert.match(editor, /showEntryEditor\(entryId\)/);
  assert.doesNotMatch(editor, /showEntryPreview\(entryId\)/);
  assert.match(css, /\.preview-editor/);
});
