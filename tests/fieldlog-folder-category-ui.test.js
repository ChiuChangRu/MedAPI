/**
 * P3（2026-08-08 分類重整）：資料夾清單依 category 上色分組＋排序。
 * 跟 tests/fieldlog-days-and-folder-sort.test.js 同一套做法：檢查原始碼裡
 * 的關鍵接線在不在，不用真的跑 DOM。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("FOLDER_CATEGORY_META 涵蓋六個 category，顏色跟規格 §B2 一致", async () => {
  const app = await read("../fieldlog/public/app.js");
  const meta = app.match(/const FOLDER_CATEGORY_META = \{[\s\S]*?\n\};/)[0];
  const expected = {
    project: "#FFE5E5",
    qa_reg: "#FFEDD5",
    literature: "#DBEAFE",
    training: "#DCFCE7",
    admin: "#FEF9C3",
    misc: "transparent",
  };
  for (const [key, bg] of Object.entries(expected)) {
    assert.match(meta, new RegExp(`${key}: \\{ label: "[^"]+", bg: "${bg.replace("#", "#")}", rank: \\d+ \\}`),
      `${key} 的顏色要跟規格一致`);
  }
  assert.match(app, /function categoryRankOf\(category\)/);
});

test("compareFolders：category 排序優先於 status／type，且 sort_order 有納入", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function compareFolders\(a, b\)[\s\S]*?\n\}/)[0];
  const stagingIdx = fn.indexOf("role === \"staging\"");
  const categoryIdx = fn.indexOf("categoryRankOf(a.category)");
  const statusIdx = fn.indexOf("status === \"進行中\"");
  const sortOrderIdx = fn.indexOf("a.sort_order");
  assert.ok(stagingIdx >= 0 && categoryIdx > stagingIdx, "暫存區永遠第一，category 排序緊接在後");
  assert.ok(statusIdx > categoryIdx, "category 排序要比進行中／已完成優先");
  assert.ok(sortOrderIdx > statusIdx, "sort_order 要在 status 之後、type 之前納入比較");
});

test("renderFolders／renderChildFolders 都套用了 category 底色與徽章", async () => {
  const app = await read("../fieldlog/public/app.js");
  // renderFolders() 2026-08-09 起要跟樹狀縮排的 margin-left 合併成同一個
  // style 屬性（同一個元素兩個 style 屬性時瀏覽器只認第一個，這正是樹狀
  // 清單上線那次把顏色弄不見的原因），所以這裡呼叫的是只回傳色碼的
  // folderCategoryBg(f)，不是自帶 style="..." 包裝的 folderCategoryStyle(f)。
  const renderFolders = app.match(/function renderFolders\(\)[\s\S]*?\n\}/)[0];
  assert.match(renderFolders, /folderCategoryBg\(f\)/);
  assert.match(renderFolders, /folderCategoryChipHtml\(f\)/);
  const renderChild = app.match(/function renderChildFolders\(parentId\)[\s\S]*?\n\}/)[0];
  assert.match(renderChild, /folderCategoryStyle\(f\)/);
  assert.match(renderChild, /folderCategoryChipHtml\(f\)/);
});

test("folderCategoryChipHtml／folderCategoryBg 對未分類與 misc 都不上色，避免每張卡片都掛暫存徽章", async () => {
  const app = await read("../fieldlog/public/app.js");
  const chip = app.match(/function folderCategoryChipHtml\(f\)[\s\S]*?\n\}/)[0];
  assert.match(chip, /f\.category === "misc"/);
  // folderCategoryStyle(f) 2026-08-09 起改成薄包一層 folderCategoryBg(f)，
  // 真正的 misc／未分類判斷邏輯搬進了 folderCategoryBg 裡
  const bg = app.match(/function folderCategoryBg\(f\)[\s\S]*?\n\}/)[0];
  assert.match(bg, /f\.category === "misc"/);
});

test("style.css 有 .folder-category／.folder-type-group，且 .folder-card-main 的 4 欄 grid 沒被破壞", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /\.folder-category\s*\{/);
  assert.match(css, /\.folder-type-group\s*\{/);
  // list-view 的 grid 欄數維持 4 欄（type-group／name／count／date），
  // 新增分類徽章是包進 type-group 裡，不是多一個直屬欄位
  assert.match(css, /grid-template-columns: auto minmax\(0, 1fr\) auto auto;/);
});

test("後端 GET /folders 與 MCP list_fieldlog_folders 都改用 FOLDER_CATEGORY_RANK_SQL 排序", async () => {
  const [worker, mcpWorker, schema] = await Promise.all([
    read("../fieldlog/src/worker.js"),
    read("../mcp/src/worker.js"),
    read("../fieldlog/src/lib/schema.js"),
  ]);
  assert.match(schema, /export const FOLDER_CATEGORY_RANK_SQL =/);
  assert.match(worker, /import \{ FOLDER_CATEGORIES, FOLDER_CATEGORY_RANK_SQL,/);
  assert.match(worker, /ORDER BY \$\{FOLDER_CATEGORY_RANK_SQL\}, f\.status = '進行中' DESC, f\.sort_order, f\.id DESC/);
  assert.match(mcpWorker, /import \{ FOLDER_CATEGORY_RANK_SQL \} from "\.\.\/\.\.\/fieldlog\/src\/lib\/schema\.js";/);
  assert.match(mcpWorker, /ORDER BY \$\{FOLDER_CATEGORY_RANK_SQL\}, f\.status = '進行中' DESC, f\.sort_order, f\.id DESC/);
});
