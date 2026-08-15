/**
 * 2026-08-09 追加需求：
 *   (b) 資料夾清單（首頁根層、每一層子資料夾）加上「時間排序／名稱排序」
 *       切換，不再只有檔案列表能切換排序
 *
 * 跟 tests/fieldlog-ui-requests-2026-08-07.test.js 同一套做法：檢查原始碼裡
 * 的關鍵接線在不在，防的是「改了一半、另一半忘了接」。
 *
 * （原本這裡還有 (a)「暫存區放幾天後 AI 自動歸類」與 (d)「天數下限開放到 0」
 * 兩段——2026-08-09 當天稍晚該功能整個被拿掉，測試隨之刪除，見
 * fieldlog/src/lib/autofile.js 開頭的說明。）
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ---------- (b) 每個階層都能切換時間／名稱排序 ----------

test("(b) 有一個全域排序開關，同時套用在根層與子層，不是每層各自記各自的", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /let FOLDER_SORT = localStorage\.getItem\("fieldlog_folder_sort"\)/);
  assert.match(app, /function compareFoldersByTime\(/);
  assert.match(app, /function folderComparator\(\)/);
  const comparator = app.match(/function folderComparator\(\)[\s\S]*?\n\}/)[0];
  assert.match(comparator, /FOLDER_SORT === "time" \? compareFoldersByTime : compareFolders/);
});

test("(b) 排序新規則要保留暫存區置頂——不能因為改排序模式讓暫存區被排到後面", async () => {
  const app = await read("../fieldlog/public/app.js");
  const byTime = app.match(/function compareFoldersByTime\([\s\S]*?\n\}/)[0];
  assert.match(byTime, /role === "staging"/, "時間排序模式一樣要把暫存區排在最前面");
});

test("(b) 根層、每一層子資料夾、搬移選擇器都改用 folderComparator()，不再寫死 compareFolders", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.doesNotMatch(app, /\.sort\(compareFolders\)/, "不該再有地方寫死用 compareFolders 排序——要透過 folderComparator() 才會吃到使用者選的排序模式");
  // 2026-08-09 起首頁根層改用 visibleFolderRows()（可展開／收合的縮排樹狀
  // 清單）——它內部呼叫 folderTreeOrdered() 取得排序好的整棵樹再依展開狀態
  // 過濾，排序邏輯只在 folderTreeOrdered() 裡出現一次，renderFolders() 跟
  // visibleFolderRows() 都不用也不該重複寫排序，下面另一個斷言已經確認
  // folderTreeOrdered() 本身有用 folderComparator()。
  const renderFolders = app.match(/function renderFolders\(\)[\s\S]*?\n\}/)[0];
  assert.match(renderFolders, /visibleFolderRows\(\)/, "首頁根層資料夾改用可展開的縮排樹狀清單");
  const visibleRows = app.match(/function visibleFolderRows\(\)[\s\S]*?\n\}/)[0];
  assert.match(visibleRows, /folderTreeOrdered\(\)/, "可見列的過濾要建立在 folderTreeOrdered() 已經排序好的結果上");
  const folderTree = app.match(/function folderTreeOrdered\(\)[\s\S]*?\n\}/)[0];
  assert.match(folderTree, /\.sort\(folderComparator\(\)\)/, "搬移選擇器與採集 chip 共用的樹狀展開");
  const renderChild = app.match(/function renderChildFolders\(parentId\)[\s\S]*?\n\}/)[0];
  assert.match(renderChild, /\.sort\(folderComparator\(\)\)/, "子資料夾清單（每一層都會呼叫這支）");
});

test("(b) 首頁與資料夾內頁各有一顆切換鈕，且都綁同一支 toggleFolderSort", async () => {
  const [app, html] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
  ]);
  assert.match(html, /id="btn-folder-sort-home"/);
  assert.match(html, /id="btn-folder-sort-inner"/);
  assert.match(app, /\$\("btn-folder-sort-home"\)\.onclick = toggleFolderSort/);
  assert.match(app, /\$\("btn-folder-sort-inner"\)\.onclick = toggleFolderSort/);
  assert.match(app, /function toggleFolderSort\(\)/);
});

test("(b) 切換排序時，開著的資料夾內頁要跟著重新排列，不用手動重新整理", async () => {
  const app = await read("../fieldlog/public/app.js");
  const setFolderSort = app.match(/function setFolderSort\(sort\)[\s\S]*?\n\}/)[0];
  assert.match(setFolderSort, /renderFolders\(\);/);
  assert.match(setFolderSort, /if \(CURRENT_FOLDER\) renderChildFolders\(CURRENT_FOLDER\.id\);/);
});

// ---------- (c) 2026-08-09 回報：設定天數後最近作業還是一堆舊資料在最上面 ----------

test("(c) 「最近作業」顯示的日期要跟排序依據一致（updated_at 優先），不是永遠顯示 created_at", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function entryRowHtml\(e, \{ showRecency = false \} = \{\}\)/);
  const fn = app.match(/function entryRowHtml[\s\S]*?\n\}/)[0];
  assert.match(fn, /showRecency\s*\n?\s*\?\s*`[\s\S]*?e\.updated_at \|\| e\.created_at/, "showRecency 開著時要顯示 updated_at（沒有才退回 created_at）");
  const loadRecent = app.match(/async function loadRecent\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadRecent, /entryRowHtml\(e, \{ showRecency: true \}\)/, "最近作業列表要帶 showRecency，跟它實際的排序依據（updated_at）對上");
});

// ---------- (e) 2026-08-09 回報：套用 0 天後，待處理清單最上面還是一堆已歸檔的舊資料 ----------

test("(e) 「最近作業」改回只列還沒真正歸檔的：收件匣、暫存區、AI 待確認的", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const route = worker.match(/if \(path === "\/entries\/recent" && method === "GET"\) \{[\s\S]*?\n  \}/)[0];
  assert.match(route, /WHERE e\.folder_id IS NULL/, "收件匣（folder_id 空）要在裡面");
  assert.match(route, /f\.role = 'staging'/, "暫存區要在裡面");
  assert.match(route, /COALESCE\(e\.auto_filed_at, ''\) <> '' AND e\.auto_filed_at <> 'failed'/,
    "AI 剛歸類、使用者還沒確認的也要在裡面，不然 🤖 標記／confirm-filing 那套審查機制會完全沒有入口");
});

test("(e) 首頁面板統一叫「待分類」，不再叫「最近作業」", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /⏳ 待分類/);
  assert.doesNotMatch(html, /🕒 最近作業/, "舊名字會讓人誤以為這裡列的是不分歸檔狀態的全部最近動作");
});

test("(e) 待分類清單全部清空時留白，不印制式訊息（標題旁的數字歸零就是訊號）", async () => {
  const app = await read("../fieldlog/public/app.js");
  const loadRecent = app.match(/async function loadRecent\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadRecent, /: ""/, "全部處理完時 inbox-list 應該留白");
  assert.doesNotMatch(loadRecent, /目前沒有還沒歸檔的東西/, "2026-08-09 拿掉了這句多餘的文案");
});
