/**
 * 一次性匯入測試：把 chiuchangru/litdb（獨立文獻/專利知識庫）併進隨身記，
 * 成為單一產品的一部分。刻意只搬文字紀錄，不下載任何 PDF、不建附件。
 *
 * 用假的 global.fetch 模擬 litdb 三個收藏的 papers.json，假 D1 只認這支端點
 * 實際會下的語句，驗證冪等、分頁、資料夾建立、欄位/內文組裝、以及「絕對
 * 不碰附件/R2」這個核心限制。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function fakePaper(overrides = {}) {
  return {
    id: "P01", title: "示範論文", authors: "作者", year: "2024", venue: "期刊",
    doc_type: "期刊論文", tags: ["TPU", "親水塗層"], purpose: "測試用",
    abstract_note: "這是摘要全文", value_to_project: "對專案的價值",
    links: { doi: "https://doi.org/x" },
    ...overrides,
  };
}

function stubFetch(byUrl) {
  globalThis.fetch = async (url) => {
    const match = Object.entries(byUrl).find(([key]) => String(url).includes(key));
    if (!match) return { ok: false, status: 404 };
    const [, respond] = match;
    if (respond.status && respond.status !== 200) return { ok: false, status: respond.status };
    return { ok: true, json: async () => respond };
  };
}

function makeDB() {
  const tables = { folders: [], entries: [], categories: [], history: [] };
  const nextId = { folders: 1, entries: 1, categories: 1, history: 1 };
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
    if (q === "SELECT id FROM categories WHERE kind = '_seeded' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_seeded");
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q.includes("VALUES ('_seeded'")) {
      insert("categories", { kind: "_seeded", level: 0, name: "seeded", created_at: args[0] });
      return { results: [], changes: 1 };
    }

    if (q.startsWith("INSERT OR IGNORE INTO categories")) {
      const clash = tables.categories.some((c) => c.kind === "folder_type" && c.level === 1 && c.name === "文獻庫");
      if (clash) return none;
      insert("categories", { kind: "folder_type", level: 1, name: "文獻庫", created_at: args[0] });
      return { results: [], changes: 1 };
    }
    if (q === "SELECT id FROM folders WHERE type = '文獻庫' AND parent_id IS NULL AND name = ?") {
      const row = tables.folders.find((f) => f.type === "文獻庫" && f.parent_id === null && f.name === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id FROM folders WHERE type = '文獻庫' AND parent_id = ? AND name = ?") {
      const row = tables.folders.find((f) => f.type === "文獻庫" && f.parent_id === args[0] && f.name === args[1]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)") {
      const id = insert("folders", { name: args[0], type: args[1], parent_id: args[2], created_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id FROM entries WHERE json_extract(fields_json, '$.litdb_id') = ?") {
      const row = tables.entries.find((e) => JSON.parse(e.fields_json).litdb_id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "INSERT INTO entries (folder_id, title, fields_json, body, created_at) VALUES (?, ?, ?, ?, ?)") {
      const id = insert("entries", { folder_id: args[0], title: args[1], fields_json: args[2], body: args[3], created_at: args[4] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q.startsWith("INSERT INTO history")) {
      insert("history", { entry_id: args[0], folder_id: args[1], action: args[2], detail: args[3], created_at: args[4] });
      return { results: [], changes: 1 };
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

async function call(env, path, options = {}) {
  const req = new Request(`https://x/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-pin": "pin", ...(options.headers || {}) },
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("匯入三個收藏各一筆：建母資料夾＋三個子資料夾，欄位與內文都組起來", async () => {
  stubFetch({
    "coating/papers.json": { papers: [fakePaper({ id: "P01", title: "親水塗層配方" })] },
    "biopsy_patents.json": { papers: [fakePaper({ id: "B01", title: "活檢針擊發機構", tags: ["彈簧"] })] },
    "packaging/papers.json": { papers: [fakePaper({ id: "K01", title: "包裝滅菌驗證" })] },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(res.data.imported, 3);
  assert.equal(res.data.skipped, 0);
  assert.equal(res.data.total, 3);
  assert.equal(res.data.next_offset, null);

  const root = env.DB.tables.folders.find((f) => f.name === "LitDB 文獻庫" && f.parent_id === null);
  assert.ok(root, "母資料夾要建起來");
  const subNames = env.DB.tables.folders.filter((f) => f.parent_id === root.id).map((f) => f.name);
  assert.deepEqual(subNames.sort(), ["活檢針機構", "親水塗層文獻", "醫材包裝技術"].sort());

  const entry = env.DB.tables.entries.find((e) => e.title === "親水塗層配方");
  const fields = JSON.parse(entry.fields_json);
  assert.equal(fields.litdb_id, "coating:P01");
  assert.equal(fields["作者"], "作者");
  assert.match(entry.body, /對專案的價值/);
  assert.match(entry.body, /摘要\n這是摘要全文/);
  assert.match(entry.body, /本次匯入不下載 PDF/);

  assert.deepEqual(env.DB.unhandled, [], "不該下出預期外的 SQL");
});

test("冪等：同一筆資料再跑一次不會重複建立", async () => {
  stubFetch({
    "coating/papers.json": { papers: [fakePaper({ id: "P01" })] },
    "biopsy_patents.json": { papers: [] },
    "packaging/papers.json": { papers: [] },
  });
  const env = makeEnv();
  await call(env, "/admin/import-litdb", { method: "POST" });
  const secondRun = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(secondRun.data.imported, 0);
  assert.equal(secondRun.data.skipped, 1);
  assert.equal(env.DB.tables.entries.length, 1, "不該重複建立記事");
});

test("分頁：limit/offset 正確切總表，next_offset 指到下一批", async () => {
  stubFetch({
    "coating/papers.json": { papers: [fakePaper({ id: "P01" }), fakePaper({ id: "P02" })] },
    "biopsy_patents.json": { papers: [fakePaper({ id: "B01" })] },
    "packaging/papers.json": { papers: [] },
  });
  const env = makeEnv();
  const first = await call(env, "/admin/import-litdb?limit=2&offset=0", { method: "POST" });
  assert.equal(first.data.processed, 2);
  assert.equal(first.data.imported, 2);
  assert.equal(first.data.total, 3);
  assert.equal(first.data.next_offset, 2);

  const second = await call(env, `/admin/import-litdb?limit=2&offset=${first.data.next_offset}`, { method: "POST" });
  assert.equal(second.data.processed, 1);
  assert.equal(second.data.imported, 1);
  assert.equal(second.data.next_offset, null);
  assert.equal(env.DB.tables.entries.length, 3);
});

test("單一收藏讀取失敗時，其他收藏仍正常匯入", async () => {
  stubFetch({
    "coating/papers.json": { papers: [fakePaper({ id: "P01" })] },
    "biopsy_patents.json": { status: 500 },
    "packaging/papers.json": { papers: [] },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(res.data.imported, 1);
  assert.deepEqual(res.data.collections_failed, [{ key: "biopsy", error: "HTTP 500" }]);
});

test("三個收藏全部讀取失敗時回 502，不建立任何資料夾", async () => {
  stubFetch({
    "coating/papers.json": { status: 500 },
    "biopsy_patents.json": { status: 500 },
    "packaging/papers.json": { status: 500 },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(res.status, 502);
  assert.equal(env.DB.tables.folders.length, 0);
});

test("絕不下載附件：不呼叫 R2、不寫 attachments 表，連結留在 body 裡當文字", async () => {
  stubFetch({
    "coating/papers.json": {
      papers: [fakePaper({ id: "P01", links: { pdf: "https://litdb.example/P01.pdf", doi: "https://doi.org/x" } })],
    },
    "biopsy_patents.json": { papers: [] },
    "packaging/papers.json": { papers: [] },
  });
  const env = makeEnv();
  const putCalls = [];
  env.FILES = { put: async (...args) => putCalls.push(args) };
  const res = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(putCalls.length, 0, "不該呼叫 R2 put");
  assert.equal(env.DB.tables.entries.length, 1);
  assert.match(env.DB.tables.entries[0].body, /https:\/\/litdb\.example\/P01\.pdf/, "PDF 連結只留文字，不下載");
});

test("沒有任何資料時（三個收藏都空）不建母資料夾，回應 imported=0", async () => {
  stubFetch({
    "coating/papers.json": { papers: [] },
    "biopsy_patents.json": { papers: [] },
    "packaging/papers.json": { papers: [] },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/import-litdb", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(res.data.imported, 0);
  assert.equal(res.data.total, 0);
  assert.equal(env.DB.tables.folders.length, 0, "沒有資料就不該建空資料夾");
});

test("沒帶正確 PIN 會被擋下來", async () => {
  stubFetch({ "coating/papers.json": { papers: [fakePaper()] }, "biopsy_patents.json": { papers: [] }, "packaging/papers.json": { papers: [] } });
  resetSchemaCacheForTests();
  const env = { FIELD_PIN: "pin", DB: makeDB() };
  const req = new Request("https://x/api/admin/import-litdb", { method: "POST" });
  const res = await fieldlogWorker.fetch(req, env);
  assert.equal(res.status, 401);
});
