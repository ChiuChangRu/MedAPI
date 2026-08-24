import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalFolderLocalName,
  findSiblingFolderNameConflict,
  normalizeExistingChildFolderNames,
} from "../fieldlog/src/lib/folder-names.js";
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
    try { sqlite.exec(sql); } catch { /* 跟 ensureSchema 相同：重複遷移忽略 */ }
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

test("子資料夾名稱只保留本層，支援既有的全／半形路徑分隔符", () => {
  assert.equal(canonicalFolderLocalName("專案｜檢體針｜拉拔試驗"), "拉拔試驗");
  assert.equal(canonicalFolderLocalName(" 品保法規 / 驗證測試 / UV膠 "), "UV膠");
  assert.equal(canonicalFolderLocalName("專案\\檢體針\\原料資訊"), "原料資訊");
  assert.equal(canonicalFolderLocalName("  設計   輸入  "), "設計 輸入");
});

test("真實 SQLite：只正規化第二層以下；同層同名不改、不合併", async (t) => {
  const { sqlite, DB } = makeDb();
  t.after(() => sqlite.close());
  const insert = sqlite.prepare("INSERT INTO folders (id, name, type, parent_id, created_at) VALUES (?, ?, '其他', ?, '2026-08-24')");
  insert.run(1, "專案｜檢體針", null);
  insert.run(2, "專案｜檢體針｜拉拔試驗", 1);
  insert.run(3, "品保法規／驗證測試／UV膠", 1);
  insert.run(4, "A｜同名", 1);
  insert.run(5, "B｜同名", 1);
  insert.run(6, "專案｜檢體針｜拉拔試驗｜2026", 2);

  const history = [];
  const result = await normalizeExistingChildFolderNames(DB, {
    timestamp: () => "2026-08-24 12:00:00Z",
    logHistory: async (_db, _entryId, folderId, action, detail) => history.push({ folderId, action, detail }),
  });

  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 1").get().name, "專案｜檢體針", "第一層不可改");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 2").get().name, "拉拔試驗");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 3").get().name, "UV膠");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 6").get().name, "2026");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 4").get().name, "A｜同名");
  assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 5").get().name, "B｜同名");
  assert.equal(result.renamed_count, 3);
  assert.equal(result.conflict_count, 2);
  assert.equal(history.length, 3);
});

test("同一上層以正規化後名稱檢查重複", async (t) => {
  const { sqlite, DB } = makeDb();
  t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO folders (id, name, type, parent_id, created_at) VALUES (1, '根', '其他', NULL, 'x')").run();
  sqlite.prepare("INSERT INTO folders (id, name, type, parent_id, created_at) VALUES (2, '專案｜拉拔試驗', '其他', 1, 'x')").run();
  const conflict = await findSiblingFolderNameConflict(DB, { parentId: 1, name: "拉拔試驗" });
  assert.equal(conflict.id, 2);
  sqlite.prepare("INSERT INTO folders (id, name, type, parent_id, created_at) VALUES (3, '行政｜拉拔試驗', '其他', NULL, 'x')").run();
  assert.equal(await findSiblingFolderNameConflict(DB, { parentId: null, name: "專案｜拉拔試驗" }), null,
    "第一層的分類前綴是名稱的一部分，不能只看最後一段就誤判同名");
});

test("v143 前端不在資料夾清單重複顯示目前路徑，後台部署會觸發一次性整理", async () => {
  const [app, worker, workflow] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/src/worker.js"),
    read("../.github/workflows/deploy-fieldlog.yml"),
  ]);
  assert.match(app, /const location = explorer \? "" :/);
  assert.match(worker, /kind === "normalize_folder_names_v143"/);
  assert.match(worker, /canonicalFolderLocalName\(requestedName\)/);
  assert.match(workflow, /"kind":"normalize_folder_names_v143"/);
});
