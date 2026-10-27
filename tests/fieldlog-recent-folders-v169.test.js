import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const [app, html, css] = await Promise.all([
  read("../fieldlog/public/app.js"),
  read("../fieldlog/public/index.html"),
  read("../fieldlog/public/home.css"),
]);

test("首頁在待分類之前顯示最近使用目錄，且保留五筆容器", () => {
  const recent = html.indexOf('id="recent-folders-panel"');
  const inbox = html.indexOf('id="inbox-panel"');
  assert.ok(recent >= 0, "首頁要有最近使用目錄區塊");
  assert.ok(recent < inbox, "最近使用目錄應放在待分類之前，回首頁即可立即看到");
  assert.match(html, /id="recent-folder-list"/);
  assert.match(html, /最近開啟的 5 個目錄＋5 筆檔案/);
});

test("最近目錄以 id 去重、最近一筆置頂並限制五筆", () => {
  assert.match(app, /const RECENT_FOLDER_STORAGE_KEY = "fieldlog_recent_folder_ids"/);
  assert.match(app, /const RECENT_FOLDER_LIMIT = 5/);
  const reader = app.match(/function readRecentFolderIds\(\)[\s\S]*?\n}/)?.[0] || "";
  const remember = app.match(/function rememberRecentFolder\(id\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(reader, /ids\.indexOf\(id\) === index/, "讀取時要清掉歷史重複 id");
  assert.match(reader, /slice\(0, RECENT_FOLDER_LIMIT\)/, "讀取時最多保留五筆");
  assert.match(remember, /\[numericId, \.\.\.readRecentFolderIds\(\)\.filter\(\(storedId\) => storedId !== numericId\)\]/,
    "重新開啟同一目錄時應移到第一筆，而不是新增重複資料");
  assert.match(remember, /slice\(0, RECENT_FOLDER_LIMIT\)/);
});

test("只在資料夾內容成功載入後記錄，刪除、改名與搬移皆以目前 FOLDERS 重算", () => {
  const opener = app.match(/async function openFolder\(id\)[\s\S]*?\n}\n\n\/\/ 多檔案記事/)?.[0] || "";
  assert.ok(opener, "應能定位完整 openFolder 流程");
  const fetched = opener.indexOf("const entries = await api(`/entries?folder_id=${id}&include=attachments`)");
  const remembered = opener.indexOf("rememberRecentFolder(id)");
  assert.ok(fetched >= 0 && remembered > fetched, "API 成功回來後才可記成最近使用");

  const resolver = app.match(/function recentFolders\(\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(resolver, /new Map\(FOLDERS\.map/);
  assert.match(resolver, /filter\(Boolean\)/, "不存在的資料夾 id 要自動剔除");
  assert.match(resolver, /saveRecentFolderIds\(validIds\)/, "剔除後要同步清理持久化資料");
  assert.match(app, /function renderRecentFolders\(\)[\s\S]*folderDisplayPath\(folder\)/,
    "名稱與路徑必須由目前資料夾資料即時計算");
  assert.match(app, /async function loadFolders[\s\S]*renderFolders\(\);\s*renderRecentFolders\(\);/,
    "資料夾清單更新後要同步刷新最近目錄");
});

test("v208 最近使用便利貼：桌機固定小方卡、手機一列三張", () => {
  assert.match(css, /\.recent-folder-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fill, minmax\(128px, 148px\)\)/);
  assert.match(css, /@media \(max-width: 719px\) \{[\s\S]*\.recent-folder-list \{ grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.recent-folder-copy strong,[\s\S]*text-overflow:\s*ellipsis/,
    "過長名稱或路徑不能撐破卡片");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.sticky-note/);
});

test("v205 最近使用混合目錄與檔案，依開啟時間排序；記事在開啟成功後才記錄", () => {
  assert.match(app, /const RECENT_ENTRY_LIMIT = 5/);
  const remember = app.match(/function rememberRecentEntry\(entry\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(remember, /filter\(\(other\) => Number\(other\.id\) !== id\)/, "重新開啟同一筆移到最前面，不重複");
  assert.match(app, /const e = await api\(`\/entries\/\$\{id\}`\);\n  rememberRecentEntry\(e\);/);
  const render = app.match(/function renderRecentFolders\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(render, /sort\(\(a, b\) => b\.at - a\.at\)/);
  assert.match(render, /forgetRecentEntry\(id\)/, "已刪除的記事點了要自動移除");
});

test("v208 待分類預設清單、可切換便利貼；AI 已分類未確認的直接顯示位置並可一鍵確認", () => {
  assert.match(app, /localStorage\.getItem\(INBOX_VIEW_STORAGE_KEY\) \|\| "list"/);
  assert.match(html, /id="btn-inbox-sticky"/);
  const sticky = app.match(/function inboxStickyHtml\(e\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(sticky, /AI 已分到/);
  assert.match(sticky, /class="sticky-confirm"/);
  assert.match(sticky, /class="entry-move"/, "改位置沿用既有移動流程（後端會清掉 AI 標記）");
  assert.match(app, /\/entries\/\$\{Number\(btn\.dataset\.id\)\}\/confirm-filing/);
});

test("v210 首頁比照 PDCA：深色頁首、最新情報區塊、首頁區塊標題不用 emoji", async () => {
  assert.match(html, /<header class="home-app-head masthead">/);
  assert.match(html, /id="news-panel"/);
  assert.match(app, /api\("\/intel\/latest"\)/);
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /path === "\/intel\/latest"/);
  assert.match(worker, /title LIKE '【每日情報】%'/);
  const titles = [...html.matchAll(/<h2 class="home-section-title"[^>]*>([^<]*)/g)].map((m) => m[1]);
  assert.ok(titles.length >= 6);
  for (const t of titles) assert.doesNotMatch(t, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `區塊標題不應含 emoji：${t}`);
});

test("v213 桌機首頁版面：一欄／兩欄＋拖曳，存伺服器；手機不套用", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /path === "\/home-layout"/);
  const allowed = worker.match(/const ALLOWED = \[([\s\S]*?)\];/)?.[1] || "";
  for (const id of ["input-panel", "search-panel", "recent-folders-panel", "inbox-panel", "news-panel", "tools-panel", "usage-details"]) {
    assert.match(allowed, new RegExp(`"${id}"`), `只接受已知區塊 id：缺 ${id}`);
  }
  assert.match(html, /id="btn-layout-edit"/);
  assert.match(html, /id="layout-toolbar" hidden/);
  assert.match(html, /id="tools-panel"/);
  assert.match(app, /const HOME_LAYOUT_MIN_WIDTH = 1000/);
  const apply = app.match(/function applyHomeLayout\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(apply, /if \(!homeLayoutActive\(\)\)/, "窄螢幕要放回原本順序");
  assert.match(css, /\.layout-edit-btn \{ display: none; \}/, "編輯按鈕預設隱藏，只有寬螢幕顯示");
  assert.match(css, /@media \(min-width: 1000px\) \{\s*\.home-app-head\.masthead \.layout-edit-btn \{ display: inline-block; \}/);
});

test("v214 除頁首外全部可移動（v218 起輸入與草稿在頁首，不參與排版）；搜尋結果跟著檢索走，搜尋時只收起其他區塊", () => {
  assert.match(html, /<header class="home-app-head masthead">\s*<!--[^>]*-->\s*<section class="home-section home-input-section" id="input-panel"/);
  assert.match(html, /id="search-panel"/);
  assert.match(app, /const HOME_LAYOUT_TOP_DEFAULT = \["search-panel"\]/);
  assert.doesNotMatch(app, /HOME_LAYOUT_SECTIONS = \[[^\]]*"input-panel"/);
  assert.match(app, /layout\.left\.unshift\(\.\.\.missingTop\)/, "v213 舊排版沒有輸入／檢索時要補在最上面");
  assert.match(app, /document\.body\.classList\.toggle\("home-searching", active && inColumns\)/);
  assert.match(css, /body\.home-searching \.home-col:not\(:has\(#search-panel\)\) \{ display: none; \}/);
});
