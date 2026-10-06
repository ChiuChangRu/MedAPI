/**
 * 2026-10-06 實際回報：右欄一直停在「載入中…」，整個系統有越用越慢的趨勢。
 *
 * 這裡鎖住四項優化，每一項都必須「行為不變、只是更快／不會卡死」：
 *   1. 冷啟動：ensureSchema 套用成功後記下指紋，之後冷啟動只查 1 次，不再
 *      每次依序跑 ~59 次 D1；指紋不符或有非預期的 migration 失敗時照舊完整跑。
 *   2. 資料夾清單：附件 IN 查詢分批，資料夾超過 100 筆記事不會因 D1 參數上限整個打不開。
 *   3. 右欄：記事不再重複抓兩次；讀取有逾時，卡住時顯示「重試」而不是永遠「載入中…」。
 *   4. Excel 程式庫改成第一次開 Excel 才載入，不再擋住每次開頁。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";

import fieldlogWorker from "../fieldlog/src/worker.js";
import {
  MIGRATIONS, SCHEMA, SCHEMA_FINGERPRINT_KEY,
  currentSchemaFingerprint, ensureSchema, resetSchemaCacheForTests,
} from "../fieldlog/src/lib/schema.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// D1-like adapter over real SQLite that logs every statement and enforces D1's 100-parameter cap.
function d1FromSqlite(sqlite, { failSql = null } = {}) {
  const log = [];
  const statement = (sql) => {
    let args = [];
    const exec = (fn) => {
      log.push(sql);
      if (args.length > 100) throw new Error("D1_ERROR: too many SQL variables");
      if (failSql && failSql(sql)) throw new Error("D1_ERROR: simulated outage");
      return fn(sqlite.prepare(sql));
    };
    return {
      bind(...values) { args = values; return this; },
      async all() { return { results: exec((s) => s.all(...args)) }; },
      async first() { return exec((s) => s.get(...args)) || null; },
      async run() {
        const result = exec((s) => s.run(...args));
        return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid || 0) } };
      },
    };
  };
  return {
    log,
    prepare: statement,
    async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
  };
}

test("冷啟動：第一次完整套用並記下指紋，之後冷啟動只查 1 次", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1FromSqlite(sqlite);

  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 00:00:00Z");
  const firstRun = db.log.length;
  assert.ok(firstRun > MIGRATIONS.length, "全新資料庫要跑完整流程");
  const stored = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SCHEMA_FINGERPRINT_KEY);
  assert.equal(stored?.value, await currentSchemaFingerprint());

  db.log.length = 0;
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 01:00:00Z");
  assert.deepEqual(db.log, ["SELECT value FROM settings WHERE key = ?"], "指紋相同時只能查這 1 次");

  db.log.length = 0;
  await ensureSchema(db, "2026-10-06 01:00:01Z");
  assert.equal(db.log.length, 0, "同一個 Worker 內第二次呼叫完全不查");
});

test("冷啟動：指紋不符（程式改版）時照舊跑完整流程並更新指紋", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1FromSqlite(sqlite);
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 00:00:00Z");
  sqlite.prepare("UPDATE settings SET value = 'older-build' WHERE key = ?").run(SCHEMA_FINGERPRINT_KEY);

  db.log.length = 0;
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 02:00:00Z");
  assert.ok(db.log.filter((sql) => /^ALTER TABLE/.test(sql)).length === MIGRATIONS.filter((sql) => /^ALTER TABLE/.test(sql)).length,
    "每一筆 migration 都要重新嘗試");
  const stored = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SCHEMA_FINGERPRINT_KEY);
  assert.equal(stored.value, await currentSchemaFingerprint());
});

test("冷啟動：有非預期的 migration 失敗時不寫指紋，下次冷啟動仍會重試", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const flaky = MIGRATIONS.find((sql) => /ADD COLUMN embedding_error/.test(sql) && /entries/.test(sql));
  const db = d1FromSqlite(sqlite, { failSql: (sql) => sql === flaky });
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 00:00:00Z");
  const stored = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SCHEMA_FINGERPRINT_KEY);
  assert.equal(stored, undefined, "沒全部成功就不能宣告已套用");
});

test("冷啟動：全新資料庫（還沒有 settings 表）一樣能正常建立", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1FromSqlite(sqlite);
  resetSchemaCacheForTests();
  await ensureSchema(db, "2026-10-06 00:00:00Z");
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ["entries", "attachments", "folders", "settings"]) assert.ok(tables.includes(name), `${name} 要建立`);
});

test("資料夾清單：超過 100 筆記事時附件查詢分批，全部附件都要回來", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const sql of SCHEMA) sqlite.exec(sql);
  for (const sql of MIGRATIONS) { try { sqlite.exec(sql); } catch { /* duplicate column */ } }
  sqlite.prepare("INSERT INTO folders (id, name, type, created_at) VALUES (5, '大資料夾', '其他', 't')").run();
  const insertEntry = sqlite.prepare("INSERT INTO entries (id, folder_id, title, created_at) VALUES (?, 5, ?, 't')");
  const insertAtt = sqlite.prepare("INSERT INTO attachments (entry_id, kind, filename, key, created_at) VALUES (?, 'photo', ?, ?, 't')");
  for (let id = 1; id <= 205; id++) {
    insertEntry.run(id, `記事 ${id}`);
    insertAtt.run(id, `p${id}.jpg`, `k${id}`);
  }
  const db = d1FromSqlite(sqlite);
  resetSchemaCacheForTests();
  const res = await fieldlogWorker.fetch(
    new Request("https://x/api/entries?folder_id=5&include=attachments", { headers: { "x-pin": "pin" } }),
    { FIELD_PIN: "pin", DB: db },
  );
  assert.equal(res.status, 200);
  const entries = await res.json();
  assert.equal(entries.length, 205);
  for (const entry of entries) {
    assert.equal(entry.attachments.length, 1, `記事 ${entry.id} 的附件不能掉`);
    assert.equal(entry.attachments[0].filename, `p${entry.id}.jpg`);
  }
});

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

test("右欄：讀取逾時會丟出可重試的錯誤；沒給 timeoutMs 的呼叫完全照舊", async () => {
  const app = await read("../fieldlog/public/app.js");
  const code = [
    extractFunction(app, "async function api(path, options = {})"),
    extractFunction(app, "async function apiFetch(path, options)"),
  ].join("\n");
  const seen = [];
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    pin: () => "pin", showLogin() {},
    fetch: (url, init) => {
      seen.push(init);
      if (url.includes("hang")) {
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
  });
  vm.runInContext(code, context);

  await assert.rejects(context.api("/hang", { timeoutMs: 20 }), /連線逾時/);
  assert.deepEqual(await context.api("/fine"), { ok: true });
  assert.equal(seen.at(-1).signal, undefined, "沒指定逾時的請求不能被加上 signal");
  assert.equal("timeoutMs" in seen.at(-1), false);
});

test("右欄：記事只抓一次，同一份資料直接交給編輯器；三個唯讀讀取都有逾時", async () => {
  const app = await read("../fieldlog/public/app.js");
  const inspector = await read("../fieldlog/public/inspector.js");
  const renderInspectorEntry = extractFunction(inspector, "async function renderInspectorEntry(item, tab)");
  assert.match(renderInspectorEntry, /api\(`\/entries\/\$\{item\.id\}`, \{ timeoutMs: INSPECTOR_READ_TIMEOUT_MS \}\)/);
  assert.match(renderInspectorEntry, /await renderEntryEditor\(entry\.id, entry\);/);
  assert.match(app, /async function renderEntryEditor\(entryId, preloadedEntry = null\) \{\n  const entry = preloadedEntry \|\| await api\(`\/entries\/\$\{entryId\}`, \{ timeoutMs: INSPECTOR_READ_TIMEOUT_MS \}\);/);
  assert.match(extractFunction(app, "async function attachmentWithText("), /\{ timeoutMs: INSPECTOR_READ_TIMEOUT_MS \}/);
});

test("Excel 程式庫：首頁不再同步載入，第一次開 Excel 才載入且只載入一次", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.doesNotMatch(html, /xlsx\.full\.min\.js/, "不能再擋在 app.js 前面");
  const app = await read("../fieldlog/public/app.js");
  assert.match(extractFunction(app, "async function fetchXlsxWorkbook(url)"), /await loadXlsxLibrary\(\);/);

  const appended = [];
  const context = vm.createContext({
    window: {},
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild: (script) => { appended.push(script); } },
    },
  });
  vm.runInContext(`${app.match(/const XLSX_LIBRARY_URL = .*\n/)[0]}let XLSX_LIBRARY_LOADING = null;\n${extractFunction(app, "function loadXlsxLibrary()")}`, context);
  const first = context.loadXlsxLibrary();
  const second = context.loadXlsxLibrary();
  assert.equal(appended.length, 1, "同時開兩份 Excel 只能插一次 script");
  appended[0].onload();
  await Promise.all([first, second]);

  // A failed CDN load must be retryable on the next click.
  const retryContext = vm.createContext({ window: {}, document: context.document });
  appended.length = 0;
  vm.runInContext(`${app.match(/const XLSX_LIBRARY_URL = .*\n/)[0]}let XLSX_LIBRARY_LOADING = null;\n${extractFunction(app, "function loadXlsxLibrary()")}`, retryContext);
  const failed = retryContext.loadXlsxLibrary();
  appended[0].onerror();
  await assert.rejects(failed, /載入失敗/);
  retryContext.loadXlsxLibrary();
  assert.equal(appended.length, 2, "失敗後再點一次要重新載入");
});
