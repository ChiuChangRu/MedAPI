/**
 * v234 冷啟動加速：資料表結構版本號一樣時只查 1 次 settings，不再逐一送 54 道升級指令；
 * 結構改變（雜湊不同）時照常跑完整建表與升級。用 node:sqlite 實跑。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { currentSchemaVersion, ensureSchema, resetSchemaCacheForTests, SCHEMA_VERSION_KEY } from "../fieldlog/src/lib/schema.js";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  let count = 0;
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { count++; return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { count++; return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { count++; const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    sqlite, get count() { return count; }, reset() { count = 0; },
    prepare: (sql) => stmt(sql),
    async batch(list) { return Promise.all(list.map((s) => s.run())); },
  };
}

test("第一次冷啟動跑完整升級並記版本；之後冷啟動只查 1 次", async () => {
  const db = d1();
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-11-06 00:00:00Z");
  assert.ok(db.count > 50, `第一次要跑完整升級（${db.count}）`);
  assert.equal(db.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SCHEMA_VERSION_KEY).value, currentSchemaVersion());
  db.reset();
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-11-06 00:01:00Z");
  assert.equal(db.count, 1, "版本一樣只查一次");
});

test("資料庫裡的版本不同（結構有改）時重新跑完整升級", async () => {
  const db = d1();
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-11-06 00:00:00Z");
  db.sqlite.prepare("UPDATE settings SET value = 'old' WHERE key = ?").run(SCHEMA_VERSION_KEY);
  db.reset();
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-11-06 00:02:00Z");
  assert.ok(db.count > 50);
  assert.equal(db.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SCHEMA_VERSION_KEY).value, currentSchemaVersion());
});
