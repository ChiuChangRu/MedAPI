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
  assert.match(html, /最近開啟的 5 筆/);
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

test("最近目錄桌機一列五筆、手機改為可讀的單欄", () => {
  assert.match(css, /\.recent-folder-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 719px\) \{[\s\S]*\.recent-folder-list\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.recent-folder-copy strong,[\s\S]*text-overflow:\s*ellipsis/,
    "過長名稱或路徑不能撐破卡片");
});
