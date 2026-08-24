/**
 * P3（2026-08-08 分類重整）：資料夾清單依 category 上色分組＋排序。
 * 跟 tests/fieldlog-days-and-folder-sort.test.js 同一套做法：檢查原始碼裡
 * 的關鍵接線在不在，不用真的跑 DOM。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("FOLDER_CATEGORY_META 涵蓋八個工作分類，且前臺只稱法規", async () => {
  const app = await read("../fieldlog/public/app.js");
  const meta = app.match(/const FOLDER_CATEGORY_META = \{[\s\S]*?\n\};/)[0];
  const expected = {
    project: "#FEE2E2",
    training: "#DCFCE7",
    admin: "#FEF9C3",
    literature: "#DBEAFE",
    routine_report: "#EDE9FE",
    ai_adoption: "#CCFBF1",
    qa_reg: "#FFEDD5",
    misc: "transparent",
  };
  for (const [key, bg] of Object.entries(expected)) {
    assert.match(meta, new RegExp(`${key}: \\{ label: "[^"]+", icon: "[^"]+", bg: "${bg.replace("#", "#")}", accent: "#[A-F0-9]+", rank: \\d+ \\}`),
      `${key} 的顏色要跟規格一致`);
  }
  assert.match(meta, /qa_reg: \{ label: "法規"/);
  assert.doesNotMatch(meta, /品保法規|品保與法規/);
  assert.match(app, /function categoryRankOf\(category\)/);
});

test("compareFolders：category 排序優先於 status／type，且 sort_order 有納入", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function compareFolders\(a, b\)[\s\S]*?\n\}/)[0];
  const stagingIdx = fn.indexOf("role === \"staging\"");
  const categoryIdx = fn.indexOf("categoryRankOf(folderSectionKey(a))");
  const statusIdx = fn.indexOf("status === \"進行中\"");
  const sortOrderIdx = fn.indexOf("a.sort_order");
  assert.ok(stagingIdx >= 0 && categoryIdx > stagingIdx, "暫存區永遠第一，category 排序緊接在後");
  assert.ok(statusIdx > categoryIdx, "category 排序要比進行中／已完成優先");
  assert.ok(sortOrderIdx > statusIdx, "sort_order 要在 status 之後、type 之前納入比較");
});

test("renderFolders 套用 category 底色（不重複掛文字徽章）；renderChildFolders 沒有底色可借，兩者都掛", async () => {
  const app = await read("../fieldlog/public/app.js");
  // renderFolders() 2026-08-09 起要跟樹狀縮排的 margin-left 合併成同一個
  // style 屬性（同一個元素兩個 style 屬性時瀏覽器只認第一個，這正是樹狀
  // 清單上線那次把顏色弄不見的原因），所以這裡呼叫的是只回傳色碼的
  // folderCategoryBg(f)，不是自帶 style="..." 包裝的 folderCategoryStyle(f)。
  // 2026-08-09：拿掉 folderCategoryChipHtml(f)——卡片本身已經是該 category
  // 的底色，再掛一個白底文字重複講一次分類名稱沒有意義。
  const homeRow = app.match(/function homeFolderRowHtml[\s\S]*?\n\}/)[0];
  assert.match(homeRow, /folderCategoryBg\(f\)/);
  assert.doesNotMatch(homeRow, /folderCategoryChipHtml\(f\)/);
  const renderChild = app.match(/function childFolderHtml\(f\)[\s\S]*?\n\}/)[0];
  assert.match(renderChild, /folderCategoryStyle\(f\)/);
  assert.match(renderChild, /folderCategoryChipHtml\(f\)/);
});

test("folderCategoryChipHtml／folderCategoryBg 對未分類與 misc 都不上色，避免每張卡片都掛暫存徽章", async () => {
  const app = await read("../fieldlog/public/app.js");
  const chip = app.match(/function folderCategoryChipHtml\(f\)[\s\S]*?\n\}/)[0];
  assert.match(chip, /section === "misc"/);
  // folderCategoryStyle(f) 2026-08-09 起改成薄包一層 folderCategoryBg(f)，
  // 真正的 misc／未分類判斷邏輯搬進了 folderCategoryBg 裡
  const bg = app.match(/function folderCategoryBg\(f\)[\s\S]*?\n\}/)[0];
  assert.match(bg, /section === "misc"/);
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
