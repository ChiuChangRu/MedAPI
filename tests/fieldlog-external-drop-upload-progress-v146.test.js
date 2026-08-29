import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("外部檔案拖入首頁、資料夾頁與側欄都會觸發上傳", () => {
  assert.match(app, /setupFileDropZone\(\$\("view-home"\), uploadDroppedFilesToCurrentLocation\)/);
  assert.match(app, /setupFileDropZone\(\$\("view-folder"\), uploadDroppedFilesToCurrentLocation\)/);
  assert.match(app, /setupFileDropZone\(\$\("desktop-explorer-nav"\), uploadDroppedFilesToCurrentLocation\)/);
  assert.match(app, /includes\("Files"\)/);
});

test("整批上傳顯示小型進度視窗並防止重複批次", () => {
  assert.match(html, /id="upload-loading-overlay"/);
  assert.match(html, /id="upload-loading-bar-fill"/);
  assert.match(app, /let UPLOAD_BATCH_ACTIVE = false/);
  assert.match(app, /showUploadProgress\(files\.length, destination\)/);
  assert.match(app, /updateUploadProgress\(index, files\.length, file\.name\)/);
  assert.match(app, /hideUploadProgress\(\)/);
  assert.match(css, /\.upload-loading-overlay/);
});

test("手機首頁可選相簿既有照片與多個檔案，不會被 capture 強制開相機", () => {
  const input = html.match(/<input id="home-upload-file-input"[\s\S]*?>/)?.[0] || "";
  assert.ok(input, "首頁要有獨立的選檔輸入");
  assert.match(input, /accept="[^"]*image\/\*/);
  assert.match(input, /\bmultiple\b/);
  assert.doesNotMatch(input, /\bcapture\b/);
  assert.match(html, /id="btn-home-upload"/);
  assert.match(app, /async function uploadFilesFromHome\(files\)[\s\S]*stagingFolderId\(\)[\s\S]*destination: "「待分類」"/);
  assert.match(app, /\$\("btn-home-upload"\)\.onclick = \(\) => homeUploadInput\.click\(\)/);
});
