import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TRASH_RETENTION_DAYS, trashPurgeAfter } from "../fieldlog/src/lib/trash.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("垃圾桶期限固定為 60 天，精確跨月計算", () => {
  assert.equal(TRASH_RETENTION_DAYS, 60);
  assert.equal(trashPurgeAfter("2026-08-14T00:00:00.000Z"), "2026-10-13T00:00:00.000Z");
});

test("桌機有資料夾樹、三種內容模式、待分類與垃圾桶快捷；手機強制清單", async () => {
  const [html, app, css] = await Promise.all([
    read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="desktop-folder-tree"/);
  assert.match(html, /id="desktop-pending"/);
  assert.match(html, /id="desktop-trash"/);
  assert.match(html, /id="btn-inner-grid"/);
  assert.match(html, /id="btn-inner-list"/);
  assert.match(html, /id="btn-inner-details"/);
  assert.match(app, /matchMedia\("\(max-width: 719px\)"\)\.matches \? "list" : INNER_FOLDER_VIEW/);
  assert.match(css, /@media \(min-width: 720px\)[\s\S]*\.desktop-explorer-nav/);
});

test("資料夾內頁使用單一內容區，不再拆成檔案、錄音資料包、筆記三段", async () => {
  const [html, app, css] = await Promise.all([
    read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(app, /const explorerItems = \[/);
  assert.match(app, /sortExplorerItems\(explorerItems\)/);
  assert.match(app, /folder-entries"\)\.className = `folder-content-list \$\{activeView\}-view`/);
  assert.doesNotMatch(app, /<div class="archive-section-label">錄音與多檔案紀錄<\/div>/);
  assert.doesNotMatch(app, /<div class="archive-section-label">筆記<\/div>/);
  assert.match(css, /\.folder-content-list\.grid-view/);
  assert.match(html, /id="btn-folder-sort-inner"[^>]*hidden/);
});

test("站內紀錄拖放先辨識自訂 MIME；外部檔案落在既有紀錄會附加", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /application\/x-fieldlog-entry/);
  assert.match(app, /types\.includes\("application\/x-fieldlog-entry"\)[\s\S]*nestEntry/);
  assert.match(app, /types\.includes\("Files"\)[\s\S]*uploadFiles\(Number\(el\.dataset\.id\), files\)/);
  assert.match(app, /setupFileDropZone\(\$\("desktop-explorer-nav"\), uploadDroppedFilesToPending\)/);
});

test("資料夾與紀錄刪除走完整子樹垃圾桶，不再安全上移", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /moveFolderTreeToTrash\(db, folder, now\(\)\)/);
  assert.match(worker, /moveEntryTreeToTrash\(db, old, now\(\)\)/);
  assert.match(worker, /purgeExpiredTrash\(env\.DB, env\.FILES, now\(\)\)/);
});

test("永久刪除先 claim、R2 全成功後才批次刪 D1，失敗會留下狀態供重試", async () => {
  const trash = await read("../fieldlog/src/lib/trash.js");
  const claim = trash.indexOf("SET state = 'purging'");
  const r2 = trash.indexOf("Promise.allSettled");
  const d1 = trash.indexOf("await runStatements(db, statements)", r2);
  assert.ok(claim >= 0 && r2 > claim && d1 > r2);
  assert.match(trash, /SET state = 'trashed', attempts = attempts \+ 1, last_error = \?/);
  assert.match(trash, /if \(attachments\.length && !files\) throw new Error/);
  assert.match(trash, /function chunks\(items, size = 80\)/);
});
