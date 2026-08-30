import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { normalizeExistingWorkSections, workSectionProposal } from "../fieldlog/src/lib/work-sections.js";
import { MIGRATIONS, SCHEMA } from "../fieldlog/src/lib/schema.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid || 0) } };
        },
      };
    },
  };
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) sqlite.exec(sql);
  for (const sql of MIGRATIONS) {
    try { sqlite.exec(sql); } catch { /* 跟 ensureSchema 一樣忽略重複遷移 */ }
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

test("工作分類規則：法規只顯示法規，ISO／IFU／年度風險評估在其下", () => {
  assert.deepEqual(workSectionProposal({ name: "品保法規｜ISO標準", category: "qa_reg" }), { name: "ISO", category: "qa_reg" });
  assert.deepEqual(workSectionProposal({ name: "品保法規｜IFU", category: "qa_reg" }), { name: "IFU", category: "qa_reg" });
  assert.deepEqual(workSectionProposal({ name: "品保法規", category: "qa_reg" }), { name: "一般法規", category: "qa_reg" });
  assert.deepEqual(workSectionProposal({ name: "年度風險評估", category: "misc" }), { name: "年度風險評估", category: "qa_reg" });
  assert.deepEqual(workSectionProposal({ name: "專案｜Pigtail｜親水塗層", category: "project" }), { name: "Pigtail｜親水塗層", category: "project" }, "專案根只去掉第一段，不破壞名稱內部結構");
  assert.deepEqual(workSectionProposal({ name: "行政｜週報月報KPI", category: "admin" }), { name: "週報月報KPI", category: "routine_report" });
});

test("真實 SQLite：v144 只正規化根名稱與 category，不搬動記事或子資料夾", async (t) => {
  const { sqlite, DB } = makeDb();
  t.after(() => sqlite.close());
  const insert = sqlite.prepare(
    "INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (?, ?, '其他', ?, ?, ?, '2026-08-24')"
  );
  insert.run(1, "專案｜檢體針", "project", null, "");
  insert.run(2, "品保法規｜ISO標準", "qa_reg", null, "");
  insert.run(3, "品保法規｜IFU", "qa_reg", null, "");
  insert.run(4, "年度風險評估", "qa_reg", null, "");
  insert.run(5, "行政｜週報月報KPI", "admin", null, "");
  insert.run(6, "拉拔試驗", "qa_reg", 1, "");
  insert.run(7, "待分類", "misc", null, "staging");
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, created_at) VALUES (101, 6, '已分類內容', '2026-08-24')").run();

  const beforeParent = sqlite.prepare("SELECT parent_id FROM folders WHERE id = 6").get().parent_id;
  const beforeEntryFolder = sqlite.prepare("SELECT folder_id FROM entries WHERE id = 101").get().folder_id;
  const result = await normalizeExistingWorkSections(DB, { timestamp: () => "2026-08-24 12:00:00Z" });

  const normalizedRoots = sqlite.prepare("SELECT name, category FROM folders WHERE id BETWEEN 1 AND 5 ORDER BY id")
    .all().map((row) => ({ ...row }));
  assert.deepEqual(normalizedRoots, [
    { name: "檢體針", category: "project" },
    { name: "ISO", category: "qa_reg" },
    { name: "IFU", category: "qa_reg" },
    { name: "年度風險評估", category: "qa_reg" },
    { name: "週報月報KPI", category: "routine_report" },
  ]);
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 6").get().name, "拉拔試驗", "子資料夾名稱不可再改");
  assert.equal(sqlite.prepare("SELECT parent_id FROM folders WHERE id = 6").get().parent_id, beforeParent, "parent_id 不可改");
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 101").get().folder_id, beforeEntryFolder, "記事不可搬動");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 7").get().name, "待分類", "待分類系統容器不可改");
  assert.equal(result.checked, 5);
});

test("v144 前後臺與部署接線完整，其他分類不會成為 AI 自動歸檔目的地", async () => {
  const [app, css, worker, schema, autofile, workflow, index, sw] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
    read("../fieldlog/src/worker.js"),
    read("../fieldlog/src/lib/schema.js"),
    read("../fieldlog/src/lib/autofile.js"),
    read("../.github/workflows/deploy-fieldlog.yml"),
    read("../fieldlog/public/index.html"),
    read("../fieldlog/public/sw.js"),
  ]);
  assert.match(schema, /"routine_report",\s*"ai_adoption",\s*"qa_reg",\s*"misc"/);
  assert.match(app, /const WORK_SECTION_ORDER = \["project", "training", "admin", "literature", "routine_report", "ai_adoption", "qa_reg", "misc"\]/);
  assert.match(app, /desktop-tree-section-head/);
  assert.match(app, /COLLAPSED_FOLDER_SECTIONS/);
  assert.match(app, /renderDesktopFolderTree\(\);/);
  assert.match(css, /\.desktop-tree-row\.active[\s\S]*box-shadow: inset 4px 0 0 var\(--section-accent\)/);
  assert.match(css, /\.desktop-tree-row\[data-depth\][\s\S]*::before/);
  assert.match(worker, /kind === "normalize_work_sections_v144"/);
  assert.match(worker, /maintenance\.work_sections_v144/);
  assert.match(workflow, /"kind":"normalize_work_sections_v144"/);
  assert.match(autofile, /COALESCE\(category, 'misc'\) <> 'misc'/);
  assert.match(worker, /"routine_report", WEEKLY_REPORT_FOLDER_ROLE/);
  assert.match(app, /const APP_VERSION = "166"/);
  assert.match(worker, /const UI_VERSION = "166"/);
  assert.match(index, /app\.js\?v=166/);
  assert.match(sw, /fieldlog-v166-nonblocking-startup/);
});
