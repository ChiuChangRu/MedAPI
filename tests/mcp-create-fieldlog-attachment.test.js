/**
 * create_fieldlog_attachment：透過 MCP 把檔案（Word／Excel／PDF…）上傳進隨身記。
 *
 * 這支工具跟 create_fieldlog_entry／create_relation 不一樣，不是直接 INSERT
 * DB_FIELDLOG——MCP 這個 Worker 沒有綁 R2，檔案本體只能透過 FIELDLOG Service
 * Binding 打 fieldlog 自己的 POST /api/upload，跟 App 上傳走同一條路徑。這裡
 * 要驗證：該擋的輸入真的被擋下（沒打到 FIELDLOG）、成功時帶的 header／body
 * 是對的、409 去重回傳友善訊息而不是 isError、其他錯誤照樣把 fieldlog 的原始
 * 錯誤文字帶出來。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

function base64Of(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function makeFieldlogBinding({ status = 200, body = {} } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    },
  };
}

function makeDB(entries) {
  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => {
          if (sql.includes("SELECT id, title FROM entries WHERE id = ?")) {
            return entries.find((e) => e.id === args[0]) || null;
          }
          return null;
        },
      }),
    }),
  };
}

async function callTool(env, args) {
  const req = new Request("https://x/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_fieldlog_attachment", arguments: args } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin", ...env });
  return (await res.json()).result;
}

test("缺必填欄位一律報錯，且完全不會打到 FIELDLOG", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  for (const args of [
    { filename: "a.pdf", mime_type: "application/pdf", data_base64: base64Of("x") },
    { entry_id: 1, mime_type: "application/pdf", data_base64: base64Of("x") },
    { entry_id: 1, filename: "a.pdf", mime_type: "application/pdf" },
  ]) {
    const result = await callTool(env, args);
    assert.ok(result.isError, `應該報錯：${JSON.stringify(args)}`);
  }
  assert.equal(fieldlog.calls.length, 0, "缺欄位就該擋下，不該打到 FIELDLOG");
});

test("mime_type 選填，不給就退回 application/octet-stream（跟 fieldlog /api/upload 自己的預設值一致）", async () => {
  const fieldlog = makeFieldlogBinding({ status: 200, body: { ok: true, id: 88 } });
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 1, filename: "unknown.bin", data_base64: base64Of("x") });
  assert.ok(!result.isError, `不該報錯：${JSON.stringify(result)}`);
  assert.equal(fieldlog.calls[0].init.headers["content-type"], "application/octet-stream");
});

test("data_base64 不是合法 base64 要報錯，不打到 FIELDLOG", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 1, filename: "a.pdf", mime_type: "application/pdf", data_base64: "不是 base64！！！" });
  assert.ok(result.isError);
  assert.equal(fieldlog.calls.length, 0);
});

test("超過 8MB 上限要報錯，不打到 FIELDLOG", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const big = base64Of("x".repeat(9 * 1024 * 1024));
  const result = await callTool(env, { entry_id: 1, filename: "big.pdf", mime_type: "application/pdf", data_base64: big });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /8MB/);
  assert.equal(fieldlog.calls.length, 0);
});

test("entry_id 查無此記事要報錯，不打到 FIELDLOG", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 999, filename: "a.pdf", mime_type: "application/pdf", data_base64: base64Of("x") });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /999/);
  assert.equal(fieldlog.calls.length, 0);
});

test("成功上傳：帶對的 header／body 打到 fieldlog 的 /api/upload，回傳附件 id", async () => {
  const fieldlog = makeFieldlogBinding({ status: 200, body: { ok: true, id: 77, key: "1/x-a.pdf" } });
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 1, filename: "測試報告.pdf", mime_type: "application/pdf", data_base64: base64Of("pdf 內容") });
  assert.ok(!result.isError, `不該報錯：${JSON.stringify(result)}`);
  assert.match(result.content[0].text, /測試報告\.pdf/);
  assert.match(result.content[0].text, /77/);
  assert.match(result.content[0].text, /測試記事/);

  assert.equal(fieldlog.calls.length, 1);
  const { url, init } = fieldlog.calls[0];
  assert.match(url, /\/api\/upload\?pin=fieldpin$/);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/pdf");
  assert.equal(init.headers["x-entry-id"], "1");
  assert.equal(init.headers["x-filename"], encodeURIComponent("測試報告.pdf"));
  assert.equal(Buffer.from(init.body).toString("utf8"), "pdf 內容");
});

test("fieldlog 回 409 duplicate：友善訊息，不是 isError", async () => {
  const fieldlog = makeFieldlogBinding({ status: 409, body: { ok: true, duplicate: true, id: 55 } });
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 1, filename: "重複檔.pdf", mime_type: "application/pdf", data_base64: base64Of("x") });
  assert.ok(!result.isError, "重複上傳不該當成錯誤，是正常的去重行為");
  assert.match(result.content[0].text, /55/);
  assert.match(result.content[0].text, /略過/);
});

test("fieldlog 回其他錯誤（例如 401）：把原始錯誤文字帶出來，同一套 fieldlogErrorDetail", async () => {
  const fieldlog = makeFieldlogBinding({ status: 401, body: { error: "PIN 錯誤或未提供" } });
  const env = { DB_FIELDLOG: makeDB([{ id: 1, title: "測試記事" }]), FIELDLOG: fieldlog, FIELD_PIN: "fieldpin" };
  const result = await callTool(env, { entry_id: 1, filename: "a.pdf", mime_type: "application/pdf", data_base64: base64Of("x") });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /PIN 錯誤或未提供/);
});
