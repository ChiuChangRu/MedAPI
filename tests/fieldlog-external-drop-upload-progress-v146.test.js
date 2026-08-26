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
