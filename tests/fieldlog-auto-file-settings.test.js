/**
 * PUT /settings/auto-file-days —— 使用者自己在畫面上調整「暫存區放幾天後
 * AI 自動歸類」，不用進 Cloudflare Dashboard 改環境變數。
 *
 * 走完整的 fieldlogWorker.fetch()，確認：設定會真的存進去、範圍外的值會被擋、
 * /staging 與 /auto-file/status 讀到的天數會反映剛存的設定。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";

function makeFieldlogDB() {
  const folders = [];
  const entries = [];
  const settings = new Map();
  const history = [];
  let nextFolderId = 1;

  function exec(sql, args) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql) || /^ALTER TABLE/i.test(sql) || /^DROP/i.test(sql)) {
      return { results: [] };
    }
    // categories／sources 的種子流程：一律當「已經種過」，這份測試不關心分類字典
    if (sql.includes("SELECT id FROM categories WHERE kind = '_seeded'")) return { results: [{ id: 1 }] };
    if (sql.includes("SELECT id FROM categories WHERE kind = '_sources_seeded'")) return { results: [{ id: 1 }] };

    if (sql === "SELECT value FROM settings WHERE key = ?") {
      return { results: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
    }
    if (sql === "SELECT key FROM settings WHERE key = ?") {
      return { results: settings.has(args[0]) ? [{ key: args[0] }] : [] };
    }
    if (sql === "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)") {
      settings.set(args[0], args[1]);
      return { results: [], changes: 1 };
    }
    if (sql === "UPDATE settings SET value = ?, updated_at = ? WHERE key = ?") {
      settings.set(args[2], args[0]);
      return { results: [], changes: 1 };
    }

    if (sql === "SELECT * FROM folders WHERE role = ? LIMIT 1") {
      const row = folders.find((f) => f.role === args[0]);
      return { results: row ? [row] : [] };
    }
    if (sql === "INSERT INTO folders (name, type, parent_id, role, created_at) VALUES (?, ?, NULL, ?, ?)") {
      const row = { id: nextFolderId++, name: args[0], type: args[1], parent_id: null, role: args[2], created_at: args[3] };
      folders.push(row);
      return { results: [], lastRowId: row.id, changes: 1 };
    }
    if (sql.includes("FROM entries") && sql.includes("COUNT(*)")) {
      // /auto-file/status 的兩支計數查詢，這份測試不放任何 entries，回 0 即可
      return { results: [{ count: 0 }] };
    }
    if (sql.startsWith("INSERT INTO history")) { history.push(args); return { results: [] }; }

    return { results: [] };
  }

  return {
    folders, entries, settings, history,
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: exec(sql, args).results }; },
            async first() { return exec(sql, args).results[0] || null; },
            async run() { const r = exec(sql, args); return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? r.results.length } }; },
          };
        },
        async all() { return { results: exec(sql, []).results }; },
        async first() { return exec(sql, []).results[0] || null; },
        async run() { const r = exec(sql, []); return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? 0 } }; },
      };
    },
  };
}

async function call(env, path, options = {}) {
  const req = new Request(`https://x/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-pin": "pin", ...(options.headers || {}) },
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("PUT /settings/auto-file-days：存進去之後 /staging 與 /auto-file/status 都讀得到新值", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB() };

  const before = await call(env, "/staging", { method: "POST", body: "{}" });
  assert.equal(before.data.days, 4, "還沒設定過時用預設值");

  const put = await call(env, "/settings/auto-file-days", { method: "PUT", body: JSON.stringify({ days: 2 }) });
  assert.equal(put.status, 200);
  assert.equal(put.data.days, 2);

  const staging = await call(env, "/staging", { method: "POST", body: "{}" });
  assert.equal(staging.data.days, 2, "/staging 要反映剛存的設定，不是還在用預設值");

  const status = await call(env, "/auto-file/status");
  assert.equal(status.data.days, 2, "/auto-file/status 也要反映剛存的設定");
});

test("PUT /settings/auto-file-days：範圍外或非數字的值一律 400，不會被存進去", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB() };

  for (const bad of [0, -1, 31, 999, "abc", null]) {
    const res = await call(env, "/settings/auto-file-days", { method: "PUT", body: JSON.stringify({ days: bad }) });
    assert.equal(res.status, 400, `days=${JSON.stringify(bad)} 應該被拒絕`);
  }

  const staging = await call(env, "/staging", { method: "POST", body: "{}" });
  assert.equal(staging.data.days, 4, "全部都被拒絕了，天數要還是預設值");
});

test("PUT /settings/auto-file-days：邊界值 1 與 30 要能存", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB() };
  const min = await call(env, "/settings/auto-file-days", { method: "PUT", body: JSON.stringify({ days: 1 }) });
  assert.equal(min.status, 200);
  assert.equal(min.data.days, 1);
  const max = await call(env, "/settings/auto-file-days", { method: "PUT", body: JSON.stringify({ days: 30 }) });
  assert.equal(max.status, 200);
  assert.equal(max.data.days, 30);
});

test("沒帶 PIN 一律 401，設定端點不能被繞過", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB() };
  const req = new Request("https://x/api/settings/auto-file-days", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ days: 2 }),
  });
  const res = await fieldlogWorker.fetch(req, env);
  assert.equal(res.status, 401);
});
