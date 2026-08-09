/**
 * FIELDLOG service binding 回錯時，要把 fieldlog 的原始錯誤文字帶出來，
 * 不能整段蓋成同一句「檢查 FIELD_PIN 是否一致」。
 *
 * 背景（2026-08-03）：get_fieldlog_image／list_wiki_pages 全部 401，兩邊
 * 的錯誤訊息都是同一句通用文字，看不出是哪一種：
 *
 *   1. fieldlog 自己的 FIELD_PIN 這個 Secret 不見了
 *      → fieldlog 回「尚未設定 FIELD_PIN」，要去 fieldlog Worker 補
 *   2. fieldlog 的 Secret 沒事，是 medapi-mcp 這邊存的那份 FIELD_PIN
 *      跟 fieldlog 對不上（例如只有其中一邊在 2026-08-02 那次 Secret
 *      被部署清掉的事故後補回來，另一邊沒人記得也要補）
 *      → fieldlog 回「PIN 錯誤或未提供」，要去 medapi-mcp Worker 補
 *
 * 兩種原因、兩個完全不同的 Worker 要去改，蓋成同一句只會讓人兩邊都要猜。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

function fieldlogBindingReturning(status, body) {
  return { fetch: async () => new Response(JSON.stringify(body), { status }) };
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

test("list_wiki_pages：fieldlog 自己沒設 FIELD_PIN，錯誤訊息要指名是 fieldlog 那邊", async () => {
  const env = { FIELDLOG: fieldlogBindingReturning(401, { error: "尚未設定 FIELD_PIN：請至 Worker Settings → Variables and Secrets 新增" }) };
  const result = await callTool(env, "list_wiki_pages");
  assert.ok(result.isError);
  const text = result.content[0].text;
  assert.match(text, /尚未設定 FIELD_PIN/, "要把 fieldlog 的原始錯誤文字帶出來，不能整句蓋掉");
});

test("list_wiki_pages：medapi-mcp 這邊的 FIELD_PIN 跟 fieldlog 對不上，訊息要跟上面那種分得開", async () => {
  const env = { FIELDLOG: fieldlogBindingReturning(401, { error: "PIN 錯誤或未提供" }) };
  const result = await callTool(env, "list_wiki_pages");
  assert.ok(result.isError);
  const text = result.content[0].text;
  assert.match(text, /PIN 錯誤或未提供/);
  assert.doesNotMatch(text, /尚未設定 FIELD_PIN/,
    "這是「兩邊對不上」不是「fieldlog 沒設定」，兩種訊息不能混在一起，否則看不出要去哪個 Worker 改");
});

test("get_fieldlog_image：同一套錯誤穿透，且 404 才提示可能是舊版部署", async () => {
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (sql.includes("FROM attachments") && args[0] === 1
          ? { id: 1, entry_id: 5, mime: "image/jpeg", filename: "x.jpg", size: 1000, created_at: "2026-08-03" }
          : null),
      }),
    }),
  };
  const env = { DB_FIELDLOG: db, FIELDLOG: fieldlogBindingReturning(401, { error: "PIN 錯誤或未提供" }), FIELD_PIN: "x" };
  const result = await callTool(env, "get_fieldlog_image", { id: 1 });
  assert.ok(result.isError);
  const text = result.content[0].text;
  assert.match(text, /PIN 錯誤或未提供/);
  assert.doesNotMatch(text, /commit 5c784dd/, "401 不該顯示『可能是舊版部署』——那是 404 的可能原因，混進來會誤導排查方向");
});
