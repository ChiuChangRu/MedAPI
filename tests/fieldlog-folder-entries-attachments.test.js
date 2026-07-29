/**
 * GET /entries?folder_id=:id&include=attachments
 *
 * 背景：資料夾內頁原本先拿 /entries?folder_id=X 的摘要，再對每一筆有附件的
 * 記事各發一支 /entries/:id 補附件——資料夾裡記事、附件越多，開資料夾要
 * 打的 API 數就跟著等比例變多，使用者反映「開啟隨身記速度變慢」。這支端點
 * 加了 include=attachments，一次用 IN 查完全部附件塞回去，前端（openFolder）
 * 改成只打這一支。這裡測的是後端這支端點本身：附件要分組分對、預設（不帶
 * include）行為要維持不變。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB() {
  const tables = { entries: [], attachments: [] };
  const nextId = { entries: 1, attachments: 1 };
  const unhandled = [];

  function insert(table, row) {
    const id = nextId[table]++;
    tables[table].push({ id, ...row });
    return id;
  }

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q) || /^DROP INDEX/i.test(q)) return none;

    if (q === "SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count FROM entries e WHERE e.folder_id = ? ORDER BY e.id DESC") {
      const rows = tables.entries
        .filter((e) => e.folder_id === args[0])
        .map((e) => ({ ...e, att_count: tables.attachments.filter((a) => a.entry_id === e.id).length }))
        .sort((a, b) => b.id - a.id);
      return { results: rows, changes: 0 };
    }
    if (q === "SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count FROM entries e WHERE e.folder_id IS NULL ORDER BY e.id DESC") {
      const rows = tables.entries
        .filter((e) => e.folder_id == null)
        .map((e) => ({ ...e, att_count: tables.attachments.filter((a) => a.entry_id === e.id).length }))
        .sort((a, b) => b.id - a.id);
      return { results: rows, changes: 0 };
    }
    if (/^SELECT \* FROM attachments WHERE entry_id IN \([?,]+\) ORDER BY id$/.test(q)) {
      const ids = new Set(args);
      const rows = tables.attachments.filter((a) => ids.has(a.entry_id)).sort((a, b) => a.id - b.id);
      return { results: rows, changes: 0 };
    }

    unhandled.push(q);
    return none;
  }

  const db = {
    tables, unhandled,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const copy = (row) => (row && typeof row === "object" ? { ...row } : row);
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results.map(copy) }; },
        async first() { return copy(exec(sql, args).results[0]) || null; },
        async run() {
          const r = exec(sql, args);
          return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? r.results.length } };
        },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db = makeDB()) {
  resetSchemaCacheForTests();
  return { FIELD_PIN: "pin", DB: db };
}

async function call(env, path) {
  const req = new Request(`https://x/api${path}`, { headers: { "x-pin": "pin" } });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

function assertNoUnexpectedSql(db) {
  const unexpected = db.unhandled.filter((q) => !/\b(categories|sources)\b/i.test(q));
  assert.deepEqual(unexpected, [], "不該下出預期外的 SQL（schema 種子除外）");
}

test("include=attachments：一次把附件分組塞回每筆記事，不用再逐筆補打 API", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: 5, title: "分段錄音", body: "", fields_json: "{}", created_at: "t1" });
  db.tables.entries.push({ id: 2, folder_id: 5, title: "單張照片", body: "", fields_json: "{}", created_at: "t2" });
  db.tables.entries.push({ id: 3, folder_id: 5, title: "純文字筆記", body: "沒有附件", fields_json: "{}", created_at: "t3" });
  db.tables.attachments.push({ id: 10, entry_id: 1, kind: "audio", filename: "seg1.webm", key: "k10" });
  db.tables.attachments.push({ id: 11, entry_id: 1, kind: "audio", filename: "seg2.webm", key: "k11" });
  db.tables.attachments.push({ id: 12, entry_id: 2, kind: "photo", filename: "a.jpg", key: "k12" });

  const res = await call(env, "/entries?folder_id=5&include=attachments");
  assert.equal(res.status, 200);
  assert.equal(res.data.length, 3);

  const byId = Object.fromEntries(res.data.map((e) => [e.id, e]));
  assert.equal(byId[1].attachments.length, 2, "分段錄音的兩個附件都要在，且不能跑到別筆記事底下");
  assert.deepEqual(byId[1].attachments.map((a) => a.id), [10, 11]);
  assert.equal(byId[2].attachments.length, 1);
  assert.equal(byId[2].attachments[0].id, 12);
  assert.deepEqual(byId[3].attachments, [], "沒有附件的記事要回空陣列，不是 undefined");

  assertNoUnexpectedSql(db);
});

test("不帶 include 參數：行為維持原樣，不會多回傳 attachments 欄位", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: 5, title: "單張照片", body: "", fields_json: "{}", created_at: "t1" });
  db.tables.attachments.push({ id: 10, entry_id: 1, kind: "photo", filename: "a.jpg", key: "k10" });

  const res = await call(env, "/entries?folder_id=5");
  assert.equal(res.status, 200);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].att_count, 1);
  assert.equal(res.data[0].attachments, undefined, "沒帶 include 就不用多查一次附件");

  assertNoUnexpectedSql(db);
});

test("include=attachments 對收件匣（inbox=1）一樣有效", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "草稿", body: "", fields_json: "{}", created_at: "t1" });
  db.tables.attachments.push({ id: 10, entry_id: 1, kind: "photo", filename: "a.jpg", key: "k10" });

  const res = await call(env, "/entries?inbox=1&include=attachments");
  assert.equal(res.status, 200);
  assert.equal(res.data[0].attachments.length, 1);
  assert.equal(res.data[0].attachments[0].filename, "a.jpg");

  assertNoUnexpectedSql(db);
});

test("資料夾裡完全沒有記事時，include=attachments 不會多打附件查詢", async () => {
  const db = makeDB();
  const env = makeEnv(db);

  const res = await call(env, "/entries?folder_id=5&include=attachments");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, []);
  assertNoUnexpectedSql(db);
});
