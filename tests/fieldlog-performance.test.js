import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("登入／已有 PIN 的啟動流程重用第一次 /folders 回應，不重複查同一份資料", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /const folders = await api\("\/folders"\);[\s\S]*?boot\(folders\)/,
    "登入驗證取得的資料夾要交給 boot 重用");
  assert.match(app, /api\("\/folders"\)\.then\(\(folders\) => boot\(folders\)\)/,
    "已有 PIN 的啟動同樣要重用第一次回應");
  assert.match(app, /async function boot\(preloadedFolders = null\)/);
  assert.match(app, /loadFolders\(preloadedFolders\)/);
});

test("/folders 用一次分組統計取代每個資料夾各跑相關子查詢", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const route = worker.match(/if \(path === "\/folders" && method === "GET"\)[\s\S]*?return json\(results\);/)?.[0] || "";
  assert.match(route, /LEFT JOIN \([\s\S]*GROUP BY folder_id/);
  assert.match(route, /LEFT JOIN \([\s\S]*GROUP BY parent_id/);
  assert.doesNotMatch(route, /SELECT COUNT\(\*\) FROM entries e WHERE e\.folder_id = f\.id/,
    "不可隨資料夾數量重複掃 entries");
});

test("資料夾內容 API 不傳回逐字稿、OCR、AI 分析與記事全文", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const routeStart = worker.indexOf('if (path === "/entries" && method === "GET")');
  const routeEnd = worker.indexOf('if (path === "/entries" && method === "POST")', routeStart);
  const route = worker.slice(routeStart, routeEnd);
  assert.doesNotMatch(route, /SELECT e\.\*/,
    "資料夾清單只需摘要，不可把每筆記事全文一起傳回");
  assert.doesNotMatch(route, /SELECT \* FROM attachments WHERE entry_id IN/,
    "附件清單不可把逐字稿、OCR、AI 分析等大型欄位一起傳回");
  assert.match(route, /SELECT id, entry_id, kind, filename, key, mime, created_at, offset_secs,/);
});

test("首頁與檔案總管熱路徑有 active partial indexes", async () => {
  const schema = await read("../fieldlog/src/lib/schema.js");
  for (const name of [
    "idx_folders_parent_active",
    "idx_entries_folder_root_active",
    "idx_entries_recent_active",
  ]) assert.match(schema, new RegExp(`CREATE INDEX IF NOT EXISTS ${name}`));
});
