/**
 * D1 schema 落後時的自我修復。
 *
 * 背景（2026-08-01 實際發生）：fieldlog 與 MCP 是兩個獨立 Worker，綁同一個 D1，
 * 但只有 fieldlog 帶 migration，而它的 ensureSchema 只在「帶正確 PIN 的 /api/*
 * 請求」進來時才跑。MCP 直接讀 D1、不經過那條路徑，所以 fieldlog 部署了含新欄位
 * 的版本之後，只要沒有人真的打開過隨身記 App，MCP 就會一直看到 no such column。
 * 當時 search_fieldlog 100% 失敗，而錯誤訊息完全看不出「去開一次 App 就好」。
 *
 * 這裡驗證：遇到 no such column 會主動戳 fieldlog 觸發 ensureSchema 再重試一次，
 * 且正常路徑不會多打任何一支請求。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

// 第一次查詢缺欄位；被「補過 schema」之後才回正常結果，模擬 migration 跑完
function makeDB({ missingUntilMigrated = true, state }) {
  function exec(sql) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT canonical, aliases_json, codes_json FROM synonyms")) {
      return { results: [] };
    }
    if (missingUntilMigrated && !state.migrated) {
      throw new Error("D1_ERROR: no such column: e.body_format at offset 43: SQLITE_ERROR");
    }
    if (q.startsWith("SELECT f.id, f.name, f.type, f.parent_id")) {
      return { results: [{ id: 7, name: "測試資料夾", type: "實驗", parent_id: null, status: "進行中", created_at: "2026-08-01", entry_count: 1 }] };
    }
    return { results: [] };
  }
  const stmt = (sql) => ({
    bind: () => stmt(sql),
    all: async () => exec(sql),
    first: async () => exec(sql).results[0] ?? null,
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { prepare: stmt };
}

function makeFieldlogBinding(state, { ok = true } = {}) {
  return {
    fetch: async (u) => {
      state.calls.push(u);
      // 只有真的通過 PIN 閘門（200）才代表 ensureSchema 跑過了
      if (!ok) return new Response(JSON.stringify({ error: "PIN 錯誤或未提供" }), { status: 401 });
      state.migrated = true;
      return new Response(JSON.stringify({ uploads: true }), { status: 200 });
    },
  };
}

async function callTool(env, name, args = {}) {
  const req = new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, env);
  return (await res.json()).result;
}

test("欄位缺失時會觸發 fieldlog 補 schema 並重試成功", async () => {
  const state = { migrated: false, calls: [] };
  const env = {
    MCP_PIN: "testpin",
    FIELD_PIN: "fieldpin",
    DB_FIELDLOG: makeDB({ state }),
    FIELDLOG: makeFieldlogBinding(state),
  };
  const result = await callTool(env, "list_fieldlog_folders");
  assert.ok(!result.isError, `不該回錯誤，實得：${result.content?.[0]?.text}`);
  assert.equal(state.calls.length, 1, "應該只戳 fieldlog 一次");
  assert.match(state.calls[0], /\/api\/config/, "要打 /api/* 才會走到 ensureSchema");
  assert.match(state.calls[0], /pin=fieldpin/, "要帶 FIELD_PIN，否則被 401 擋在 ensureSchema 之前");
});

test("正常查詢不會多打 fieldlog（自我修復只在出錯時啟動）", async () => {
  const state = { migrated: true, calls: [] };
  const env = {
    MCP_PIN: "testpin",
    FIELD_PIN: "fieldpin",
    DB_FIELDLOG: makeDB({ missingUntilMigrated: false, state }),
    FIELDLOG: makeFieldlogBinding(state),
  };
  const result = await callTool(env, "list_fieldlog_folders");
  assert.ok(!result.isError);
  assert.equal(state.calls.length, 0, "沒出錯就不該有任何額外請求");
});

test("補不成 schema 時，錯誤訊息要講出下一步怎麼做", async () => {
  const state = { migrated: false, calls: [] };
  const env = {
    MCP_PIN: "testpin",
    FIELD_PIN: "fieldpin",
    DB_FIELDLOG: makeDB({ state }),
    FIELDLOG: makeFieldlogBinding(state, { ok: false }), // PIN 對不上 → 補不了
  };
  const result = await callTool(env, "list_fieldlog_folders");
  assert.ok(result.isError, "應該回報錯誤");
  const text = result.content[0].text;
  assert.match(text, /no such column/, "要保留原始錯誤，方便對照");
  assert.match(text, /隨身記 App|ensureSchema/, "要講出人可以怎麼處理，不能只丟 SQL 錯誤");
});

test("沒有 FIELDLOG binding 時不會炸掉，照樣回可讀的錯誤", async () => {
  const state = { migrated: false, calls: [] };
  const env = {
    MCP_PIN: "testpin",
    FIELD_PIN: "fieldpin",
    DB_FIELDLOG: makeDB({ state }),
    // 故意不給 FIELDLOG
  };
  const result = await callTool(env, "list_fieldlog_folders");
  assert.ok(result.isError);
  assert.match(result.content[0].text, /no such column/);
});
