/**
 * 2026-08-07 的七點回報，逐條把「有沒有真的接上線」變成測試。
 *
 * 這裡跟專案既有的前端測試同一套做法：沒有瀏覽器可以真的跑 Quill／DOM，
 * 所以檢查原始碼裡的關鍵接線在不在——防的是「改了一半、另一半忘了接」，
 * 那種缺漏在畫面上看起來跟「功能沒做」一模一樣。
 *
 * 對照 BUG-LIST.md。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ---------- (2) 四層資料夾下的文件都能搬，已歸類的也能搬 ----------

test("(2) 有一個共用的樹狀資料夾選擇器，四層都選得到、每列標出層級", async () => {
  const app = await read("../fieldlog/public/app.js");
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="folder-picker-overlay"/, "要有選擇器的容器");
  assert.match(app, /function folderTreeOrdered\(\)/, "要照樹狀順序攤平，不是一串平的清單");
  assert.match(app, /function openFolderPicker\(/);
  const render = app.match(/function renderFolderPickerList[\s\S]*?\n}/)[0];
  assert.match(render, /depth \* 18/, "縮排要反映層級");
  assert.match(render, /第\$\{depth \+ 1\}層/, "每一列要看得出是第幾層");
});

test("(2) 單一檔案有「移動」入口，走既有的 /attachments/:id/move", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /id="file-move-action"/, "檔案詳情要有移動按鈕");
  assert.match(app, /\$\("file-move-action"\)\.onclick/);
  assert.match(app, /\/attachments\/\$\{attachmentId\}\/move/, "要重用既有的搬移端點，不是另外寫一套");
});

test("(2) 已經歸檔的記事也能改位置——歸檔那一列不再只給收件匣草稿看", async () => {
  const app = await read("../fieldlog/public/app.js");
  const openEntry = app.match(/async function openEntry\(id\)[\s\S]*?\n}\n/)[0];
  assert.match(openEntry, /id="e-move"/, "記事詳情要有移動按鈕");
  assert.doesNotMatch(openEntry, /\$\{!folder \? `<div class="archive-row"/, "不該再用「只有收件匣才顯示」的條件包住");
  assert.match(openEntry, /pendingFolderId/, "移動要跟儲存一起送出，避免沖掉正在編輯的內容");
});

test("(2) 資料夾本身也能搬（含子資料夾），後端會擋掉超過四層與搬進自己底下", async () => {
  const [app, worker, attachments] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/src/worker.js"),
    read("../fieldlog/src/lib/attachments.js"),
  ]);
  assert.match(app, /async function moveFolder\(id\)/);
  assert.match(app, /excludeSubtreeOf: id/, "選擇器不能讓人選到自己或自己的子孫");
  assert.match(attachments, /export async function subtreeHeight/);
  assert.match(attachments, /export async function isDescendantOf/);
  assert.match(worker, /不能把資料夾搬到自己的子資料夾底下/);
  assert.match(worker, /parentDepth \+ height > MAX_FOLDER_DEPTH/, "要連被搬的整棵子樹有多高一起算");
});

test("(2) 合併資料夾時子資料夾跟著進目標，不再被丟回上層", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const merge = worker.match(/const mergeFolderMatch[\s\S]*?return json\(\{ ok: true, moved, moved_children[^\n]*\n/)[0];
  assert.match(merge, /UPDATE folders SET parent_id = \? WHERE parent_id = \?"\)\.bind\(targetId, sourceId\)/,
    "子資料夾的新家是目標資料夾（舊行為是 source.parent_id，會把同一批資料劈成兩半）");
  assert.match(merge, /isDescendantOf/, "不能合併到自己的子資料夾");
  assert.match(merge, /超過 \$\{MAX_FOLDER_DEPTH\} 層上限/, "層數會爆掉時要擋下並說清楚");
});

// ---------- (3)(7) 貼 MD 不跑版、蠟筆重點 ----------

test("(3) 貼上 Markdown 會先轉成 HTML 再交給 Quill，而且搶在 Quill 之前處理", async () => {
  const src = await read("../fieldlog/public/richtext-editor.js");
  assert.match(src, /function mdToHtml\(/);
  assert.match(src, /function looksLikeMarkdown\(/);
  assert.match(src, /addEventListener\("paste"[\s\S]*?\}, true\)/,
    "要用捕獲階段，否則 Quill 會先把 Markdown 貼成一堆純文字");
  assert.match(src, /dangerouslyPasteHTML\(range\.index, mdToHtml\(text\), "user"\)/);
});

test("(3) 轉出來的標籤都在後端白名單內（貼進來看到什麼，存檔後就是什麼）", async () => {
  const [editor, richtext] = await Promise.all([
    read("../fieldlog/public/richtext-editor.js"),
    read("../fieldlog/src/lib/richtext.js"),
  ]);
  const allowed = richtext.match(/const ALLOWED_TAGS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const allowedTags = new Set([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "hr", "blockquote", "ul", "ol", "li"]) {
    assert.ok(allowedTags.has(tag), `Markdown 會產生 <${tag}>，白名單少了它就等於存檔時被吃掉`);
  }
  // 表格刻意轉成 <pre>：Quill 沒有表格格式，硬轉表格標籤在貼上時會被拆成散文字
  const mdToHtml = editor.match(/function mdToHtml\(src\)[\s\S]*?\n  \}/)[0];
  assert.match(mdToHtml, /\| 表格 \|/);
  assert.doesNotMatch(mdToHtml, /<table/, "不要輸出白名單外的表格標籤");
});

test("(7) 蠟筆重點存成 class 而不是行內 style（style 一律會被後端剝掉）", async () => {
  const [editor, css] = await Promise.all([
    read("../fieldlog/public/richtext-editor.js"),
    read("../fieldlog/public/style.css"),
  ]);
  assert.match(editor, /attributors\/class\/background/, "要註冊 class 版的 background attributor");
  assert.match(editor, /\{ background: HIGHLIGHT_COLORS \}/, "工具列要有蠟筆");
  assert.match(editor, /🖍 蠟筆重點/, "按鈕要有看得懂的中文說明");
  for (const color of ["yellow", "green", "blue", "pink", "orange"]) {
    assert.match(css, new RegExp(`\\.rich-editor \\.ql-editor \\.ql-bg-${color}`),
      `ql-bg-${color} 要有自己的 CSS（index.html 先載 style.css 再載 quill.snow.css，特異度不夠會被蓋掉）`);
  }
});

// ---------- (4) 新檔案在最上面 ----------

test("(4) 資料夾內的檔案預設新到舊，可切回檔名排序", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /let FILE_SORT = localStorage\.getItem\("fieldlog_file_sort"\) \|\| "new"/, "預設要是新到舊");
  const sort = app.match(/function sortFolderFiles[\s\S]*?\n}/)[0];
  assert.match(sort, /b\.attachment\.created_at/, "新到舊要用建立時間比");
  assert.match(sort, /Number\(b\.attachment\.id\) - Number\(a\.attachment\.id\)/, "同一秒建立的用 id 當第二鍵，順序才穩定");
  assert.match(app, /id="btn-file-sort"|\$\("btn-file-sort"\)/, "要有切換鈕");
});

// ---------- (5) AI 背景資訊預設摺疊 ----------

test("(5) 來歷、逐字稿全文、AI 動過哪裡、操作履歷全部預設收合", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /<details class="ai-fold prov-fold">/, "「這筆資料的來歷」整段要收合");
  assert.match(app, /<details class="ai-fold"><summary>展開逐字稿全文/, "合併逐字稿要收合");
  assert.match(app, /<details class="ai-fold"><summary class="prov-sub">AI 對這筆做過什麼/);
  assert.match(app, /<details class="ai-fold"><summary class="prov-sub">操作履歷/);
  // 收著的區塊沒有理由先打一趟 API
  assert.match(app, /provFold\.addEventListener\("toggle"/, "履歷要等到展開才載入");
  for (const details of app.matchAll(/<details class="ai-fold[^"]*"/g)) {
    assert.doesNotMatch(details[0], /open/, "預設不能是展開的");
  }
});

// ---------- (6) 收件匣改最近作業＋暫存區＋自動歸類 ----------

test("(6) 首頁有一個永遠看得到的待處理清單，不會空了就整個消失", async () => {
  // 面板名稱與範圍在 2026-08-09 調整過一次（見 tests/fieldlog-days-and-folder-sort.test.js
  // 的 (e) 那組）：這裡只鎖「面板存在且永遠可見」這個不變的行為，標題文字與
  // 「列什麼」交給那組測試把關，避免同一件事分散在兩個檔案各鎖一半、改名時
  // 要記得兩邊都改。
  const [app, html] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
  ]);
  assert.match(html, /id="inbox-panel"/);
  assert.match(app, /async function loadRecent\(\)/);
  assert.match(app, /api\("\/entries\/recent\?limit=25"\)/);
  const load = app.match(/async function loadRecent[\s\S]*?\n}/)[0];
  assert.match(load, /\$\("inbox-panel"\)\.style\.display = "block"/,
    "舊行為是「沒東西就 display:none」，於是沒分類的東西直接從畫面上消失");
  assert.match(app, /function entryLocationLabel\(/, "每一列要標出現在待在哪裡");
});

test("(6) 採集時就先分類：資料夾 chip 有暫存區選項，錄音也有歸類鈕", async () => {
  const [app, html] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
  ]);
  assert.match(app, /async function stagingFolderId\(\)/);
  assert.match(app, /很急，先放暫存區/, "採集畫面上要有一鍵丟暫存區");
  assert.match(html, /id="audio-folder-btn"/, "錄音沒有全螢幕畫面，浮動列上要有歸類鈕");
  const ensure = app.match(/async function ensureEntryForCapture[\s\S]*?\n}/)[0];
  assert.match(ensure, /await stagingFolderId\(\)/, "首頁開始的採集要落在看得見的暫存區，不是看不見的收件匣");
});

test("(6) AI 歸的位置一定看得出來，而且可以確認或改掉", async () => {
  const [app, worker] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/src/worker.js"),
  ]);
  assert.match(app, /🤖 AI 分類/, "AI 分的要有標記");
  assert.match(app, /🤖 待人工/, "AI 判斷不出來的也要標出來");
  assert.match(app, /confirm-filing/, "要能確認分類正確、拿掉標記");
  assert.match(worker, /const confirmFiledMatch = path\.match\(\/\^\\\/entries\\\/\(\\d\+\)\\\/confirm-filing\$\/\)/);
});

test("(6) cron 除了同步之外也會跑自動歸類，而且兩者互不拖累", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const scheduled = worker.match(/async scheduled\([\s\S]*?\n  \},/)[0];
  assert.match(scheduled, /syncSources/);
  assert.match(scheduled, /autoFileStagedEntries/);
  assert.match(scheduled, /try \{[\s\S]*catch/, "自動歸類要自己 try，掛掉不能連帶讓同步整個失敗（反之亦然）");
});

test("(6) 暫存區用 role 欄位辨識，不是用名字", async () => {
  const [schema, autofile] = await Promise.all([
    read("../fieldlog/src/lib/schema.js"),
    read("../fieldlog/src/lib/autofile.js"),
  ]);
  assert.match(schema, /ALTER TABLE folders ADD COLUMN role TEXT DEFAULT ''/);
  assert.match(schema, /ALTER TABLE entries ADD COLUMN auto_filed_at TEXT DEFAULT ''/);
  assert.match(autofile, /SELECT \* FROM folders WHERE role = \? LIMIT 1/, "改名之後還要找得到");
});
