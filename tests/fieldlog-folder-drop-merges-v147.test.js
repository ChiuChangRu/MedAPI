import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("資料夾拖到資料夾呼叫 merge API，來源資料夾不再保留", () => {
  assert.match(app, /async function mergeFolderDirect\(sourceId, targetId\)/);
  assert.match(app, /api\(`\/folders\/\$\{sourceId\}\/merge`/);
  assert.match(app, /JSON\.stringify\(\{ target_id: targetId \}\)/);
  assert.doesNotMatch(app, /async function moveFolderDirect/);
  assert.match(app, /完成後來源資料夾會消失/);
});

test("左側主目錄仍是搬遷，資料夾目標明示合併", () => {
  assert.match(app, /async function moveFolderToSection\(folderId, section\)/);
  assert.match(app, /body: JSON\.stringify\(\{ parent_id: null, category: section \}\)/);
  assert.match(app, /hasFolderDrag\(event\) \? "folder-merge-target"/);
  assert.match(css, /content: "合併至此"/);
});
