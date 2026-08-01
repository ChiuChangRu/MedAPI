/**
 * 401 要讓人看得出下一步該做什麼。
 *
 * 2026-08-01：claude.ai 的連接器中斷後重連不上，客戶端只顯示「需要重新授權
 * ／token 過期」這種泛用訊息。查下去發現 401 沒有帶 WWW-Authenticate，客戶端
 * 拿不到任何線索，只能猜；而 body 裡的訊息是「PIN 錯誤或未提供」——兩種原因
 * 合在一句，看到的人兩邊都要試。
 *
 * 這支端點的 PIN 是掛在 URL 上的（claude.ai 自訂連接器不能自帶 header），
 * 所以「重連時整條網址沒貼完整」是最常見的失敗，訊息必須直接講出這件事。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

function call({ pin, headers = {} } = {}) {
  const url = pin === undefined ? "https://x/mcp" : `https://x/mcp?pin=${pin}`;
  return worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  }), { MCP_PIN: "right-pin" });
}

test("沒帶 PIN 與帶錯 PIN 要給不同訊息（決定要修網址還是對 PIN 值）", async () => {
  const missing = await call();
  const wrong = await call({ pin: "nope" });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  const a = (await missing.json()).error;
  const b = (await wrong.json()).error;
  assert.notEqual(a, b, "兩種原因不能共用同一句訊息");
  assert.match(a, /\?pin=/, "沒帶 PIN 時要直接寫出網址該長什麼樣");
  assert.match(b, /MCP_PIN/, "帶錯時要指出去哪裡對值");
  assert.match(b, /FIELD_PIN/, "要提醒別跟 FIELD_PIN 搞混——兩個 PIN 刻意不同值");
});

test("401 一定要帶 WWW-Authenticate，否則客戶端沒有任何線索", async () => {
  const res = await call();
  const header = res.headers.get("www-authenticate");
  assert.ok(header, "少了這個 header，客戶端只能顯示泛用的『需要重新授權』");
  assert.match(header, /^Bearer /);
  assert.match(header, /error_description=/);
});

test("WWW-Authenticate 只能有 ASCII（HTTP header 不是 UTF-8 通道）", async () => {
  // 中文屬於 obs-text，可能被客戶端或中間代理拒掉——那會把「PIN 沒帶對」
  // 變成整條連線失敗，比不加這個 header 還糟。中文說明放 JSON body。
  for (const res of [await call(), await call({ pin: "nope" })]) {
    const header = res.headers.get("www-authenticate") || "";
    const nonAscii = [...header].filter((c) => c.charCodeAt(0) > 127);
    assert.deepEqual(nonAscii, [], `header 出現非 ASCII 字元：${nonAscii.join("")}`);
  }
});

test("MCP_PIN 未設定時仍 fail-closed，且說得出要去哪裡設", async () => {
  const res = await worker.fetch(new Request("https://x/mcp?pin=whatever", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  }), {});
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /尚未設定 MCP_PIN/);
  assert.ok(res.headers.get("www-authenticate"));
});

test("健康檢查頁要報工具數，好從外部判斷部署有沒有生效", async () => {
  // 不然連接器連不上時，分不清是「Worker 沒部署到新版」還是「客戶端把工具
  // 清單快取住了」——這兩件事的處理方式完全不同
  const res = await worker.fetch(new Request("https://x/"), {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /工具數：\d+/, "看不到工具數就沒辦法從外部確認部署版本");
  assert.doesNotMatch(text, /get_fieldlog|search_fieldlog/, "工具名不用列，不擴大暴露面");
});

test("三種帶 PIN 的方式都還能正常連上（沒有被這次改動弄壞）", async () => {
  const ok = async (res) => {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, "medapi-mcp");
  };
  await ok(await call({ pin: "right-pin" }));
  await ok(await call({ headers: { "x-pin": "right-pin" } }));
  await ok(await call({ headers: { authorization: "Bearer right-pin" } }));
});
