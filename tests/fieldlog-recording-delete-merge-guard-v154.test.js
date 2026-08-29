import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");

test("每一段錄音都有獨立刪除入口，刪除後重新讀取資料包", () => {
  assert.match(app, /class="btn small danger recording-audio-delete"[^>]*data-audio-id="\$\{item\.id\}"/);
  assert.match(app, /recording-audio-delete[\s\S]*\/attachments\/\$\{button\.dataset\.audioId\}[\s\S]*method: "DELETE"/);
  assert.match(app, /只刪除這一段音訊及其逐字稿；同一資料包的速記、照片和其他錄音不受影響/);
  assert.match(app, /const fresh = await api\(`\/entries\/\$\{entryId\}`\)/);
});

test("整個錄音資料包仍可移到垃圾桶", () => {
  assert.match(app, /recording-edit-delete[\s\S]*\/entries\/\$\{entryId\}[\s\S]*method: "DELETE"/);
});

test("資料夾合併先驗證垃圾桶狀態與同名子資料夾衝突", () => {
  assert.match(worker, /來源或目標資料夾已在垃圾桶，無法合併/);
  assert.match(worker, /JOIN folders t ON t\.parent_id = \? AND LOWER\(TRIM\(t\.name\)\) = LOWER\(TRIM\(s\.name\)\)/);
  assert.match(worker, /請先重新命名或先合併這兩個子資料夾/);
});
