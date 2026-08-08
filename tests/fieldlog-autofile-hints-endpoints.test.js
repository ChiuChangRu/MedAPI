/**
 * /auto-file/hints* 端點——讓自動歸類的判斷規則能自己長，但一定要人核准
 * 才會生效。也測 PUT /entries/:id 在「使用者把 AI 分錯的記事手動搬走」
 * 時，會把 🤖 標記清掉並記一筆修正，供每天的排程彙整候選規則。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB() {
  const tables = { folders: [], entries: [], autofile_hints: [], autofile_corrections: [], history: [] };
  const nextId = { autofile_hints: 1, autofile_corrections: 1, history: 1 };
  const unhandled = [];

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };
    if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q) || /^DROP INDEX/i.test(q)) return none;

    if (q === "SELECT id FROM folders WHERE id = ?") {
      const row = tables.folders.find((f) => f.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q === "SELECT * FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q.startsWith("UPDATE entries SET title = ?, body = ?, fields_json = ?, folder_id = ?, body_format = ?, auto_filed_at = ?, auto_filed_reason = ?, updated_at = ?")) {
      const [title, body, fields_json, folder_id, body_format, auto_filed_at, auto_filed_reason, updated_at, id] = args;
      const row = tables.entries.find((e) => e.id === id);
      if (row) Object.assign(row, { title, body, fields_json, folder_id, body_format, auto_filed_at, auto_filed_reason, updated_at });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q.startsWith("INSERT INTO history")) {
      tables.history.push({ id: nextId.history++, entry_id: args[0], folder_id: args[1], action: args[2], detail: args[3] });
      return { results: [], changes: 1 };
    }

    if (q === "INSERT INTO autofile_hints (folder_id, keyword, status, note, created_at) VALUES (?, ?, ?, ?, ?)") {
      const id = nextId.autofile_hints++;
      tables.autofile_hints.push({ id, folder_id: args[0], keyword: args[1], status: args[2], note: args[3], created_at: args[4] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT * FROM autofile_hints ORDER BY id DESC") {
      return { results: [...tables.autofile_hints].sort((a, b) => b.id - a.id) };
    }
    if (q === "SELECT * FROM autofile_hints WHERE status = ? ORDER BY id DESC") {
      return { results: tables.autofile_hints.filter((h) => h.status === args[0]).sort((a, b) => b.id - a.id) };
    }
    if (q === "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'suggested' ORDER BY id") {
      return { results: tables.autofile_hints.filter((h) => h.status === "suggested") };
    }
    if (q === "UPDATE autofile_hints SET keyword = ?, status = 'active' WHERE id = ? AND status = 'suggested'") {
      const row = tables.autofile_hints.find((h) => h.id === args[1] && h.status === "suggested");
      if (row) { row.keyword = args[0]; row.status = "active"; }
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM autofile_hints WHERE id = ?") {
      const before = tables.autofile_hints.length;
      tables.autofile_hints = tables.autofile_hints.filter((h) => h.id !== args[0]);
      return { results: [], changes: before - tables.autofile_hints.length };
    }
    if (q === "SELECT DISTINCT folder_id FROM autofile_hints WHERE status IN ('active', 'suggested') AND (keyword = '' OR keyword IS NULL)") {
      const ids = [...new Set(tables.autofile_hints.filter((h) => !h.keyword).map((h) => h.folder_id))];
      return { results: ids.map((folder_id) => ({ folder_id })) };
    }
    if (q === "INSERT INTO autofile_corrections (entry_id, from_folder_id, to_folder_id, keyword_guess, created_at) VALUES (?, ?, ?, ?, ?)") {
      const id = nextId.autofile_corrections++;
      tables.autofile_corrections.push({
        id, entry_id: args[0], from_folder_id: args[1], to_folder_id: args[2], keyword_guess: args[3], created_at: args[4], reviewed_at: "",
      });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id FROM autofile_corrections WHERE COALESCE(reviewed_at, '') = ''") {
      return { results: tables.autofile_corrections.filter((c) => !c.reviewed_at) };
    }
    if (q === "SELECT to_folder_id, keyword_guess FROM autofile_corrections") {
      return { results: tables.autofile_corrections };
    }
    if (q === "UPDATE autofile_corrections SET reviewed_at = ? WHERE id = ?") {
      const row = tables.autofile_corrections.find((c) => c.id === args[1]);
      if (row) row.reviewed_at = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }

    unhandled.push(q);
    return none;
  }

  const db = {
    tables, unhandled,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
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

test("POST /auto-file/hints：手動新增一條規則，folder_id 或 keyword 缺一個都要 400", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 1, name: "親水塗層", type: "專案" });

  assert.equal((await call(env, "/auto-file/hints", { method: "POST", body: JSON.stringify({ keyword: "UV膠" }) })).status, 400);
  assert.equal((await call(env, "/auto-file/hints", { method: "POST", body: JSON.stringify({ folder_id: 1 }) })).status, 400);
  assert.equal((await call(env, "/auto-file/hints", { method: "POST", body: JSON.stringify({ folder_id: 999, keyword: "x" }) })).status, 404);

  const res = await call(env, "/auto-file/hints", { method: "POST", body: JSON.stringify({ folder_id: 1, keyword: "UV膠" }) });
  assert.equal(res.status, 200);
  assert.equal(db.tables.autofile_hints[0].status, "active");
  assert.equal(db.tables.history.some((h) => h.action === "新增分類規則"), true, "新增規則要留歷程");
});

test("GET /auto-file/hints：可以用 status 篩選候選 vs 已生效", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.autofile_hints.push({ id: 1, folder_id: 1, keyword: "A", status: "active" });
  db.tables.autofile_hints.push({ id: 2, folder_id: 2, keyword: "", status: "suggested" });

  const all = await call(env, "/auto-file/hints");
  assert.equal(all.data.hints.length, 2);
  const suggested = await call(env, "/auto-file/hints?status=suggested");
  assert.equal(suggested.data.hints.length, 1);
  assert.equal(suggested.data.hints[0].id, 2);
});

test("POST /auto-file/hints/:id/approve：候選規則要帶關鍵字才能採用，沒帶回 400", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.autofile_hints.push({ id: 5, folder_id: 1, keyword: "", status: "suggested", note: "候選" });

  const noKeyword = await call(env, "/auto-file/hints/5/approve", { method: "POST", body: JSON.stringify({}) });
  assert.equal(noKeyword.status, 400);

  const ok = await call(env, "/auto-file/hints/5/approve", { method: "POST", body: JSON.stringify({ keyword: "親水塗層" }) });
  assert.equal(ok.status, 200);
  assert.equal(db.tables.autofile_hints[0].status, "active");
  assert.equal(db.tables.autofile_hints[0].keyword, "親水塗層");

  const again = await call(env, "/auto-file/hints/5/approve", { method: "POST", body: JSON.stringify({ keyword: "x" }) });
  assert.equal(again.status, 404, "已經採用過的候選規則不能重複採用");
});

test("DELETE /auto-file/hints/:id：候選或已生效的規則都能刪，刪不存在的回 404", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.autofile_hints.push({ id: 7, folder_id: 1, keyword: "A", status: "active" });

  const res = await call(env, "/auto-file/hints/7", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(db.tables.autofile_hints.length, 0);

  const again = await call(env, "/auto-file/hints/7", { method: "DELETE" });
  assert.equal(again.status, 404);
});

test("POST /auto-file/hints/review：手動觸發彙整候選規則，不用等每天的排程", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.autofile_corrections.push(
    { id: 1, entry_id: 1, from_folder_id: 9, to_folder_id: 20, keyword_guess: "A", created_at: "t", reviewed_at: "" },
    { id: 2, entry_id: 2, from_folder_id: 9, to_folder_id: 20, keyword_guess: "B", created_at: "t", reviewed_at: "" },
  );
  const res = await call(env, "/auto-file/hints/review", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(res.data.suggested, 1);
  assert.equal(db.tables.autofile_hints.length, 1);
  assert.equal(db.tables.autofile_hints[0].status, "suggested");
});

test("PUT /entries/:id：把 AI 分類的記事手動搬走時，清掉 🤖 標記並記一筆修正", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({
    id: 50, folder_id: 9, title: "UV膠測試", body: "", fields_json: "{}",
    auto_filed_at: "2026-08-01T00:00:00Z", auto_filed_reason: "AI 依內容判斷",
  });

  const res = await call(env, "/entries/50", { method: "PUT", body: JSON.stringify({ folder_id: 20 }) });
  assert.equal(res.status, 200);
  const row = db.tables.entries.find((e) => e.id === 50);
  assert.equal(row.folder_id, 20);
  assert.equal(row.auto_filed_at, "", "手動修正後要清掉舊的 🤖 標記，不留過時的理由");
  assert.equal(row.auto_filed_reason, "");
  assert.equal(db.tables.autofile_corrections.length, 1, "要留下這次修正供排程彙整");
  assert.equal(db.tables.autofile_corrections[0].to_folder_id, 20);
  assert.equal(db.tables.autofile_corrections[0].keyword_guess, "UV膠測試");
});

test("PUT /entries/:id：auto_filed_at 是 'failed'（AI 本來就沒分出來）的記事被移動，不算修正", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({
    id: 51, folder_id: 9, title: "沒人分得出來的", body: "", fields_json: "{}",
    auto_filed_at: "failed", auto_filed_reason: "AI 判斷不出合適的資料夾，留在暫存區",
  });

  await call(env, "/entries/51", { method: "PUT", body: JSON.stringify({ folder_id: 20 }) });
  assert.equal(db.tables.autofile_corrections.length, 0, "'failed' 不是 AI 分錯，是本來就沒分，不該算修正");
});

test("PUT /entries/:id：一般記事（從沒被 AI 動過）搬資料夾，不會誤記成修正", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 52, folder_id: 9, title: "使用者自己歸檔的", body: "", fields_json: "{}" });

  await call(env, "/entries/52", { method: "PUT", body: JSON.stringify({ folder_id: 20 }) });
  assert.equal(db.tables.autofile_corrections.length, 0);
});
