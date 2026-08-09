/**
 * 401 要讓人看得出下一步該做什麼——但不能透過 WWW-Authenticate 傳。
 *
 * 這裡有兩次踩坑，順序記著：
 *
 * 1. 一開始 401 body 寫「PIN 錯誤或未提供」，兩種原因合一句，連不上時
 *    兩邊都要試。改成把「沒帶 PIN」跟「PIN 帶錯」拆開講。
 * 2. 拆開之後，一度覺得「RFC 7235 要求 401 帶 WWW-Authenticate」，加了
 *    `WWW-Authenticate: Bearer ...`。結果直接把 claude.ai 的連接器弄壞：
 *    MCP 的 Authorization 規範把「看到 Bearer」當成「這台伺服器支援 OAuth」
 *    的訊號，客戶端因此去戳 /.well-known/oauth-*（見 fetch() 裡的路由，
 *    這台故意全部 404，因為這裡從頭到尾只用 PIN），註冊失敗，跳出
 *    「Couldn't register with sign-in service」——而且不管 PIN 對不對都會
 *    卡在這步，比原本沒有這個 header 還糟。
 *
 * 結論：這支端點的認證訊息只能放 JSON body，不能透過任何 auth challenge
 * header 傳遞。下面的測試會擋住這個 header 再被加回來。
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

test("401 絕對不能帶 WWW-Authenticate（會被 claude.ai 誤判成支援 OAuth）", async () => {
  // 這是回歸測試，不是「應該有但還沒做」——2026-08-01 真的加過又拿掉，
  // 別再因為想符合 RFC 7235 而加回來
  for (const res of [await call(), await call({ pin: "nope" })]) {
    assert.equal(res.headers.get("www-authenticate"), null,
      "任何值都會觸發 claude.ai 的 OAuth 探測，讓連接器連不上，跟 PIN 對不對無關");
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
  assert.equal(res.headers.get("www-authenticate"), null);
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
