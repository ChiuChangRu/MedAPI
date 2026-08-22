/**
 * 沒對應到的路徑，404 一定要回 JSON body，不能是純文字。
 *
 * 2026-08-02：Claude Code CLI（HTTP MCP transport）連 medapi 一直失敗，PIN
 * 也確認是對的（直接 curl POST /mcp 拿到正確的 200 initialize 回應）。挖出
 * Claude Code 自己的 debug log 才看到真正原因：
 *
 *   HTTP 404: Invalid OAuth error response: SyntaxError: JSON Parse error:
 *   Unexpected identifier "Not". Raw body: Not found
 *
 * Claude Code 的 HTTP MCP client 對任何伺服器都會先做一次 OAuth discovery
 * （去戳 /.well-known/oauth-*），這台故意讓那些路徑落到「其餘路徑一律 404」
 * 的 catch-all——這個防線本身是對的（見 mcp-auth-diagnostics.test.js 裡
 * WWW-Authenticate 那次教訓），但那時 catch-all 回的 body 是純文字
 * `"Not found"`。Claude Code 拿到 404 後會嘗試把 body 當 JSON 解析（OAuth
 * 規範的錯誤回應本來就該是 JSON），解析純文字直接拋 SyntaxError，整個
 * 連線判定失敗——不是它不支援無 OAuth 的伺服器，是它處理「格式不對的
 * 404」失敗，而這是我們能在自己這端避開的。
 *
 * 改成 JSON body 之後，同一支 catch-all 對「.well-known 探測」跟「其他任何
 * 未知路徑」都適用，不用另外為 OAuth 路徑寫特例。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

const ENV = { MCP_PIN: "testpin" };

async function get(path) {
  return worker.fetch(new Request(`https://x${path}`), ENV);
}

test("未知路徑 404 的 body 必須是合法 JSON，OAuth discovery 則已啟用", async () => {
  for (const path of [
    "/some-random-path",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.doesNotThrow(() => JSON.parse(text), `${path} 的 404 body 不是合法 JSON：${text}`);
    assert.match(res.headers.get("content-type") || "", /application\/json/,
      `${path} 的 content-type 也要標成 JSON，不能是 text/plain`);
  }
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
  }
});

test("正常端點（/、/mcp）不受這次改動影響", async () => {
  const health = await get("/");
  assert.equal(health.status, 200);

  const mcp = await worker.fetch(new Request("https://x/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  }), ENV);
  assert.equal(mcp.status, 200);
});
