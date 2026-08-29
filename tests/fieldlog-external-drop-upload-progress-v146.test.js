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

test("手機首頁相簿與檔案分開，相簿只接受既有影像且不強制開相機", () => {
  const album = html.match(/<input id="home-album-input"[\s\S]*?>/)?.[0] || "";
  const files = html.match(/<input id="home-file-input"[\s\S]*?>/)?.[0] || "";
  assert.ok(album, "首頁要有獨立的相簿輸入");
  assert.match(album, /accept="image\/\*"/);
  assert.match(album, /\bmultiple\b/);
  assert.doesNotMatch(album, /\bcapture\b/);
  assert.ok(files, "一般文件要有另一個輸入");
  assert.doesNotMatch(files, /image\/\*/);
  assert.match(html, /id="btn-home-album"[^>]*>[\s\S]*?<span>相簿<\/span>/);
  assert.match(html, /id="btn-home-file"[^>]*>[\s\S]*?<span>檔案<\/span>/);
  assert.match(app, /async function uploadFilesFromHome\(files, buttonId\)[\s\S]*stagingFolderId\(\)[\s\S]*destination: "「待分類」"/);
  assert.match(app, /\$\("btn-home-album"\)\.onclick = \(\) => homeAlbumInput\.click\(\)/);
});
