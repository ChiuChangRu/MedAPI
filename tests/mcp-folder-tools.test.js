/**
 * MCP 資料夾整理工具（2026-08-08 分類重整新增）：update_folder／move_folder／
 * move_entry／delete_folder。這四支是 MCP 第一次拿到會造成 UPDATE／DELETE
 * 效果的能力，範圍限定在資料夾結構與記事的歸檔位置，全部透過 FIELDLOG
 * Service Binding 打 fieldlog 自己既有的 PUT／DELETE /api/folders、
 * /api/entries——這裡只測 MCP 這層的參數驗證、代理呼叫是否正確、以及
 * fieldlog 端錯誤有沒有被誠實帶出來，不重測 fieldlog 那邊的巢狀深度／
 * 防循環邏輯（那些在 tests/fieldlog-folder-edit.test.js／其他 fieldlog
 * 測試裡已經覆蓋）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

function makeDB({ folders = [], entries = [] } = {}) {
  const stmt = (sql) => ({ bind: (...args) => stmt2(sql, args) });
  const stmt2 = (sql, args) => ({
    first: async () => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q === "SELECT id, name, category, sort_order FROM folders WHERE id = ?") {
        return folders.find((f) => f.id === args[0]) || null;
      }
      if (q === "SELECT id, name, parent_id FROM folders WHERE id = ?") {
        return folders.find((f) => f.id === args[0]) || null;
      }
      if (q === "SELECT id, name FROM folders WHERE id = ?") {
        return folders.find((f) => f.id === args[0]) || null;
      }
      if (q === "SELECT id, title, folder_id FROM entries WHERE id = ?") {
        return entries.find((e) => e.id === args[0]) || null;
      }
      return null;
    },
  });
  return { prepare: stmt };
}

function makeFieldlogBinding(routes) {
  return {
    async fetch(url, init) {
      const u = new URL(url);
      const key = `${(init?.method || "GET")} ${u.pathname}`;
      const handler = routes[key];
      if (!handler) return new Response(JSON.stringify({ error: `no route for ${key}` }), { status: 404 });
      return handler(init);
    },
  };
}

async function callTool(env, name, args = {}) {
  const req = new Request("https://x/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin", ...env });
  return (await res.json()).result;
}

// ---------- update_folder ----------

test("update_folder：成功設定 category／sort_order，回應帶出更新後的值", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ folders: [{ id: 16, name: "文獻庫｜親水塗層", category: "literature", sort_order: 1 }] }),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/folders/16": async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    FIELD_PIN: "fieldpin",
  };
  const result = await callTool(env, "update_folder", { id: 16, category: "literature", sort_order: 1 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0].text, /literature/);
  assert.match(result.content[0].text, /sort_order=1/);
});

test("update_folder：什麼欄位都不給要報錯，不會白打一次 fieldlog", async () => {
  let called = false;
  const env = {
    DB_FIELDLOG: makeDB({}),
    FIELDLOG: makeFieldlogBinding({ "PUT /api/folders/16": async () => { called = true; return new Response("{}", { status: 200 }); } }),
  };
  const result = await callTool(env, "update_folder", { id: 16 });
  assert.ok(result.isError);
  assert.equal(called, false, "沒有任何欄位要改就不該打 fieldlog");
});

test("update_folder：fieldlog 回錯（例如 category 不合法）要如實帶出訊息", async () => {
  const env = {
    DB_FIELDLOG: makeDB({}),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/folders/16": async () => new Response(JSON.stringify({ error: "category 只能是 project／qa_reg／literature／training／admin／misc 其中之一，或留空清除分類" }), { status: 400 }),
    }),
  };
  const result = await callTool(env, "update_folder", { id: 16, category: "not-real" });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /category 只能是/);
});

// ---------- move_folder ----------

test("move_folder：成功搬到新的上層資料夾", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ folders: [{ id: 11, name: "課程", parent_id: 13 }] }),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/folders/11": async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  };
  const result = await callTool(env, "move_folder", { id: 11, parent_id: 13 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0].text, /folder 13/);
});

test("move_folder：parent_id 填 0 代表搬回最上層", async () => {
  let sentBody;
  const env = {
    DB_FIELDLOG: makeDB({ folders: [{ id: 11, name: "課程", parent_id: null }] }),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/folders/11": async (init) => { sentBody = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
    }),
  };
  const result = await callTool(env, "move_folder", { id: 11, parent_id: 0 });
  assert.ok(!result.isError);
  assert.equal(sentBody.parent_id, null, "parent_id=0 要轉成 null（最上層）才送給 fieldlog");
  assert.match(result.content[0].text, /最上層/);
});

test("move_folder：不給 parent_id 要報錯，不會誤搬", async () => {
  const env = { DB_FIELDLOG: makeDB({}), FIELDLOG: makeFieldlogBinding({}) };
  const result = await callTool(env, "move_folder", { id: 11 });
  assert.ok(result.isError);
});

test("move_folder：搬超過深度上限時，fieldlog 的錯誤訊息要原樣帶出來", async () => {
  const env = {
    DB_FIELDLOG: makeDB({}),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/folders/11": async () => new Response(JSON.stringify({ error: "搬過去會變成第 5 層，超過 4 層上限（這個資料夾底下還有 1 層）" }), { status: 400 }),
    }),
  };
  const result = await callTool(env, "move_folder", { id: 11, parent_id: 40 });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /超過 4 層上限/);
});

// ---------- move_entry ----------

test("move_entry：成功搬到新資料夾，不動標題內文", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ entries: [{ id: 262, title: "FMEA 課程筆記", folder_id: 35 }] }),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/entries/262": async (init) => {
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body), ["folder_id"], "只能送 folder_id，不能連帶送 title／body");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
  const result = await callTool(env, "move_entry", { id: 262, folder_id: 35 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0].text, /FMEA 課程筆記/);
  assert.match(result.content[0].text, /folder 35/);
});

test("move_entry：folder_id 填 0 代表搬回收件匣", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ entries: [{ id: 262, title: "x", folder_id: null }] }),
    FIELDLOG: makeFieldlogBinding({
      "PUT /api/entries/262": async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  };
  const result = await callTool(env, "move_entry", { id: 262, folder_id: 0 });
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /收件匣/);
});

test("move_entry：不給 folder_id 要報錯", async () => {
  const env = { DB_FIELDLOG: makeDB({}), FIELDLOG: makeFieldlogBinding({}) };
  const result = await callTool(env, "move_entry", { id: 262 });
  assert.ok(result.isError);
});

// ---------- delete_folder ----------

test("delete_folder：成功刪除，回應帶出移走的記事數", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ folders: [{ id: 26, name: "其他｜月報與周報" }] }),
    FIELDLOG: makeFieldlogBinding({
      "DELETE /api/folders/26": async () => new Response(JSON.stringify({ ok: true, moved: 0 }), { status: 200 }),
    }),
  };
  const result = await callTool(env, "delete_folder", { id: 26 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0].text, /其他｜月報與周報/);
  assert.match(result.content[0].text, /底下沒有記事/);
});

test("delete_folder：找不到資料夾時直接報錯，不會白打 fieldlog", async () => {
  let called = false;
  const env = {
    DB_FIELDLOG: makeDB({ folders: [] }),
    FIELDLOG: makeFieldlogBinding({ "DELETE /api/folders/999": async () => { called = true; return new Response("{}", { status: 200 }); } }),
  };
  const result = await callTool(env, "delete_folder", { id: 999 });
  assert.ok(result.isError);
  assert.equal(called, false);
});

test("delete_folder：有記事被移走時，訊息要講清楚搬到哪裡", async () => {
  const env = {
    DB_FIELDLOG: makeDB({ folders: [{ id: 11, name: "其他專案｜課程" }] }),
    FIELDLOG: makeFieldlogBinding({
      "DELETE /api/folders/11": async () => new Response(JSON.stringify({ ok: true, moved: 3 }), { status: 200 }),
    }),
  };
  const result = await callTool(env, "delete_folder", { id: 11 });
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /3 筆記事已搬到上一層／收件匣/);
});
