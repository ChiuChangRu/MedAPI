/**
 * v236 重新整理回到原本位置：開資料夾、右欄選取項目時把位置寫進網址（replaceState），
 * 回首頁／待分類時清掉；啟動時照網址開回資料夾與右欄項目。舊的 ?entry=&folder= 連結照舊。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("瀏覽時寫入網址、啟動時還原", async () => {
  const [app, inspector] = await Promise.all([read("../fieldlog/public/app.js"), read("../fieldlog/public/inspector.js")]);
  assert.match(app, /function setLocationState\(/);
  assert.match(app, /history\.replaceState\(/, "不增加上一頁紀錄");
  assert.match(app, /async function restoreLocationState\(params\)/);
  const open = app.match(/async function openFolder\(id\)[\s\S]*?\n}\n/)[0];
  assert.match(open, /setLocationState\(\{ folder: id \}\)/);
  const home = app.match(/async function backHome\([\s\S]*?\n}\n/)[0];
  assert.match(home, /setLocationState\(\)/);
  const pending = app.match(/async function openPendingFromDesktop\(\)[\s\S]*?\n}\n/)[0];
  assert.match(pending, /setLocationState\(\)/);
  assert.match(inspector, /setLocationState\(\{ folder: CURRENT_FOLDER\.id, att: item\.id, entry: item\.entryId \}\)/);
  assert.match(inspector, /setLocationState\(\{ folder: CURRENT_FOLDER\.id, note: item\.id \}\)/);
  const linked = app.match(/async function openLinkedKnowledgeRecord\(\)[\s\S]*?\n}\n/)[0];
  assert.match(linked, /!params\.has\("entry"\) && params\.has\("folder"\)/, "舊的 ?entry= 連結走原本流程");
});
