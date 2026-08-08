/**
 * get_fieldlog_image_base64：讀原始位元組、以 type:text 回傳。
 *
 * 背景（2026-08-08）：使用者要驗證 get_fieldlog_image 回傳的 base64
 * 是不是完整、合法，設想的驗證方式是「複製 data 貼進 create_fieldlog_attachment
 * 重新上傳，比對兩邊位元組」。但 get_fieldlog_image 回的是 type:image，
 * 一旦回傳就被轉成 MCP ImageContent 塞進模型的輸入——Claude 看到的是
 * 解碼後的圖，不是那串字元本身，沒有管道能把它當文字複製出來，這個驗證
 * 方式在那支工具上天生做不到。
 *
 * 這支工具就是為了補這個缺口而加的：純新增、不改 get_fieldlog_image／
 * 其他既有工具，回傳 type:text，讓 base64 字元真的進得了模型可以讀寫的
 * 文字內容裡；同時刻意不做 get_fieldlog_image 那套自動縮圖——這支要的
 * 就是跟來源一模一樣的位元組，縮圖只會讓位元組對不起來，違背這支工具
 * 存在的目的。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

function makeDB(attachment) {
  const stmt = (sql) => ({ bind: (...args) => stmt2(sql, args) });
  const stmt2 = (sql, args) => ({
    first: async () => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q === "SELECT * FROM attachments WHERE id = ?") {
        return args[0] === attachment.id ? attachment : null;
      }
      if (q === "SELECT id, title FROM entries WHERE id = ?") {
        return { id: attachment.entry_id, title: "測試紀錄" };
      }
      return null;
    },
  });
  return { prepare: stmt };
}

function makeFieldlogBinding(base64, mimeType, sizeBytes) {
  return {
    fetch: async () => new Response(JSON.stringify({
      data: base64, mime_type: mimeType, size_bytes: sizeBytes,
    }), { status: 200 }),
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

test("回傳的第一個內容區塊是 type:text，且原封不動帶出 raw 端點的 base64（不縮圖、不改動一個字元）", async () => {
  // 刻意用一段不是合法圖片編碼、但看起來像 base64 的字串——這支工具不解碼、
  // 不驗證圖片內容，只負責把 raw 端點給的東西原樣轉手交出去
  const rawBase64 = "SGVsbG8sIOmAmeaYr+S4gOauteWBh+eahCBiYXNlNjTlhoXlrrnjgIJ0ZXN0";
  const attachment = { id: 353, entry_id: 255, mime: "image/jpeg", filename: "現場照.jpg", size: 40, created_at: "2026-08-03" };
  const env = {
    DB_FIELDLOG: makeDB(attachment),
    FIELDLOG: makeFieldlogBinding(rawBase64, "image/jpeg", 40),
    FIELD_PIN: "fieldpin",
  };
  const result = await callTool(env, "get_fieldlog_image_base64", { id: 353 });
  assert.ok(!result.isError, `不該報錯：${JSON.stringify(result)}`);
  assert.equal(result.content[0].type, "text", "第一段一定是 text，不能是 image——不然又落回同一個複製不出來的問題");
  assert.equal(result.content[0].text, rawBase64, "要跟 raw 端點回傳的 base64 逐字元一致，不能被縮圖或重新編碼動過");
  assert.ok(!result.content.some((c) => c.type === "image"), "不應該出現 image 區塊");
  const metaText = result.content[1].text;
  assert.match(metaText, /現場照\.jpg/);
  assert.match(metaText, /image\/jpeg/);
  assert.match(metaText, new RegExp(`${rawBase64.length} 字元`));
});

test("非圖片附件要拒絕，指路去 get_fieldlog_attachment", async () => {
  const attachment = { id: 400, entry_id: 1, mime: "application/pdf", filename: "型錄.pdf", size: 1000, created_at: "2026-08-03" };
  const env = { DB_FIELDLOG: makeDB(attachment) };
  const result = await callTool(env, "get_fieldlog_image_base64", { id: 400 });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /不是圖片/);
  assert.match(result.content[0].text, /get_fieldlog_attachment/);
});

test("超過 4MB 直接拒絕，不做任何分段——跟 get_fieldlog_image 用同一個上限", async () => {
  const attachment = { id: 401, entry_id: 1, mime: "image/jpeg", filename: "原圖.jpg", size: 5 * 1024 * 1024, created_at: "2026-08-03" };
  const env = { DB_FIELDLOG: makeDB(attachment) };
  const result = await callTool(env, "get_fieldlog_image_base64", { id: 401 });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /超過 inline 上限 4MB/);
});

test("找不到附件時明確報錯，不是靜默回空", async () => {
  const env = { DB_FIELDLOG: makeDB({ id: -1 }) };
  const result = await callTool(env, "get_fieldlog_image_base64", { id: 999 });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /找不到附件 999/);
});
