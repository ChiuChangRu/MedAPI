/**
 * 2026-08-09 追加需求：
 *   (a) 暫存區放幾天後 AI 自動歸類，改成使用者自己在畫面上就能調，不再是
 *       只有進 Cloudflare Dashboard 改環境變數才能動的硬性規定
 *   (b) 資料夾清單（首頁根層、每一層子資料夾）加上「時間排序／名稱排序」
 *       切換，不再只有檔案列表能切換排序
 *
 * 跟 tests/fieldlog-ui-requests-2026-08-07.test.js 同一套做法：檢查原始碼裡
 * 的關鍵接線在不在，防的是「改了一半、另一半忘了接」。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ---------- (a) 天數可由使用者自訂 ----------

test("(a) 後端有一個獨立的 settings 表，天數設定不是只能靠環境變數", async () => {
  const schema = await read("../fieldlog/src/lib/schema.js");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS settings/);
});

test("(a) resolveAutoFileDays 以使用者設定優先，saveAutoFileDays 夾在合理範圍", async () => {
  const autofile = await read("../fieldlog/src/lib/autofile.js");
  assert.match(autofile, /export async function resolveAutoFileDays\(db, env = \{\}\)/);
  assert.match(autofile, /export async function saveAutoFileDays\(db, days, timestamp\)/);
  const resolve = autofile.match(/export async function resolveAutoFileDays[\s\S]*?\n\}/)[0];
  assert.match(resolve, /getSetting\(db, AUTO_FILE_DAYS_SETTING_KEY\)/, "要先查使用者存過的設定");
  assert.match(resolve, /return autoFileDays\(env\);/, "沒設定過才退回環境變數／預設值");
});

test("(a) worker 的天數讀取全部走 resolveAutoFileDays，不再直接呼叫舊的 autoFileDays(env)", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  // 舊的 autoFileDays(env) 呼叫要全部換成 await resolveAutoFileDays(db, env)——
  // 只 import 常數，不 import 這支函式本身，才不會有人漏改又寫回舊路徑
  assert.doesNotMatch(worker, /\bautoFileDays\(/, "worker.js 不該再直接呼叫 autoFileDays()，一律走 resolveAutoFileDays");
  const occurrences = [...worker.matchAll(/resolveAutoFileDays\(db, env\)|resolveAutoFileDays\(env\.DB, env\)/g)];
  assert.ok(occurrences.length >= 4, "/staging、/auto-file/status、/auto-file/run、cron 四處都要用到");
});

test("(a) 有一支 PUT 端點讓使用者存天數，並擋掉範圍外的值", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const route = worker.match(/if \(path === "\/settings\/auto-file-days" && method === "PUT"\) \{[\s\S]*?\n  \}/)[0];
  assert.match(route, /AUTO_FILE_DAYS_MIN/);
  assert.match(route, /AUTO_FILE_DAYS_MAX/);
  assert.match(route, /saveAutoFileDays\(db, requested, now\(\)\)/);
});

test("(a) 首頁有輸入框可以直接調天數，兩種狀態（已歸類完/還有東西）都看得到", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function autoFileDaysControlHtml\(days\)/);
  assert.match(app, /id="auto-file-days-input"/);
  assert.match(app, /id="btn-save-auto-file-days"/);
  const status = app.match(/async function loadStagingStatus\(\)[\s\S]*?\n\}/)[0];
  // 兩個分支（!status.waiting 與有東西待處理）都要嵌入天數控制項，不能只有其中一個看得到
  const controlUses = [...status.matchAll(/autoFileDaysControlHtml\(status\.days\)/g)];
  assert.equal(controlUses.length, 2, "已歸類完與還有東西待處理兩種狀態都要能調天數");
  assert.match(status, /bindAutoFileDaysControl\(\)/);
});

test("(a) 套用天數會呼叫 PUT /settings/auto-file-days，並擋掉範圍外的輸入", async () => {
  const app = await read("../fieldlog/public/app.js");
  const bind = app.match(/function bindAutoFileDaysControl\(\)[\s\S]*?\n\}/)[0];
  assert.match(bind, /api\("\/settings\/auto-file-days", \{ method: "PUT"/);
  assert.match(bind, /days < AUTO_FILE_DAYS_MIN \|\| days > AUTO_FILE_DAYS_MAX/, "前端也要擋，不能只靠後端 400");
  assert.match(bind, /AUTO_FILE_DAYS = result\.days/, "存成功後要更新全域狀態，其他地方（採集 chip、快速備忘文案）才會馬上反映新天數");
});

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
  const renderFolders = app.match(/function renderFolders\(\)[\s\S]*?\n\}/)[0];
  assert.match(renderFolders, /\.sort\(folderComparator\(\)\)/, "首頁根層資料夾");
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

test("(c) AI 自動歸類的 UPDATE 不寫 updated_at，不會讓舊記事因為被排程掃到就跳回最近作業最上面", async () => {
  const autofile = await read("../fieldlog/src/lib/autofile.js");
  // SQL 字串本身不含 updated_at，且 .bind() 只傳 4 個參數（folder_id／auto_filed_at／
  // auto_filed_reason／id）——只檢查註解文字裡有沒有提到 updated_at 沒有意義
  // （註解本來就在解釋「為什麼不寫」，當然會提到這個詞），所以直接鎖 SQL 與 bind。
  assert.match(autofile, /UPDATE entries SET folder_id = \?, auto_filed_at = \?, auto_filed_reason = \? WHERE id = \?/);
  assert.match(autofile, /\.bind\(choice\.folderId, at, choice\.reason \|\| "AI 依內容判斷", entry\.id\)\.run\(\);/);
});

test("(c) 「最近作業」顯示的日期要跟排序依據一致（updated_at 優先），不是永遠顯示 created_at", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function entryRowHtml\(e, \{ showRecency = false \} = \{\}\)/);
  const fn = app.match(/function entryRowHtml[\s\S]*?\n\}/)[0];
  assert.match(fn, /showRecency\s*\n?\s*\?\s*`[\s\S]*?e\.updated_at \|\| e\.created_at/, "showRecency 開著時要顯示 updated_at（沒有才退回 created_at）");
  const loadRecent = app.match(/async function loadRecent\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadRecent, /entryRowHtml\(e, \{ showRecency: true \}\)/, "最近作業列表要帶 showRecency，跟它實際的排序依據（updated_at）對上");
});

// ---------- (d) 「再做一個 0 天的！全部歸檔！」----------

test("(d) 天數下限開放到 0：後端 AUTO_FILE_DAYS_MIN 是 0，不是 1", async () => {
  const autofile = await read("../fieldlog/src/lib/autofile.js");
  assert.match(autofile, /export const AUTO_FILE_DAYS_MIN = 0;/);
  const clamp = autofile.match(/function clampDays\([\s\S]*?\n\}/)[0];
  assert.match(clamp, /n < 0/, "只有負數才當打錯字退回預設值，0 是合法輸入");
  assert.doesNotMatch(clamp, /n <= 0/, "不能再把 0 當成無效值擋掉");
});

test("(d) 前端天數下限跟後端同步開放到 0", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /const AUTO_FILE_DAYS_MIN = 0;/);
});

test("(d) 天數講成人看得懂的話，0 不會顯示成「放滿 0 天」", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function autoFileDaysPhrase\(days\)/);
  const fn = app.match(/function autoFileDaysPhrase[\s\S]*?\n\}/)[0];
  assert.match(fn, /days === 0/);
  assert.match(fn, /不等待/, "0 要講成「不等待」，不是印出「放滿 0 天」這種看起來像打錯字的字串");
  // 四個使用者看得到天數說明的地方都要透過這支講人話，不能有漏接的
  const usages = [...app.matchAll(/autoFileDaysPhrase\(/g)];
  assert.ok(usages.length >= 4, "快速備忘標題、暫存區歸檔說明、採集 chip、套用後的 toast 都要用這支");
});
