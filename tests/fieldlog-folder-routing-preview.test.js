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
