/** OAuth discovery, PKCE flow, and legacy PIN compatibility. */
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../mcp/src/worker.js";

class OAuthDb {
  constructor() { this.codes = new Map(); this.attempts = new Map(); }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return {
      async first() {
        if (sql.includes("FROM mcp_oauth_attempts")) return db.attempts.get(args[0]) || null;
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO mcp_oauth_codes")) {
          if (db.codes.has(args[0])) throw new Error("duplicate code");
          db.codes.set(args[0], { expires_at: args[1], used_at: null });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE mcp_oauth_codes")) {
          const row = db.codes.get(args[1]);
          if (!row || row.used_at !== null || row.expires_at < args[2]) return { meta: { changes: 0 } };
          row.used_at = args[0];
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO mcp_oauth_attempts")) {
          const old = db.attempts.get(args[0]);
          db.attempts.set(args[0], old && old.window_started_at >= args[2]
            ? { ...old, attempts: old.attempts + 1 }
            : { window_started_at: args[1], attempts: 1 });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM mcp_oauth_attempts")) {
          db.attempts.delete(args[0]);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    }; } };
  }
  async batch() { return []; }
}

const ENV = { MCP_PIN: "right-pin", DB_FIELDLOG: new OAuthDb() };
function initialize(url = "https://x/mcp", headers = {}) {
  return worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  }), ENV);
}

test("未授權可探索 MCP 工具，但資料工具仍會要求 OAuth", async () => {
  const res = await initialize();
  assert.equal(res.status, 200);
  const call = await worker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_fieldlog_folders", arguments: {} } }),
  }), ENV);
  assert.equal(call.status, 401);
  assert.match(call.headers.get("www-authenticate") || "", /oauth-protected-resource/);
  assert.equal((await call.json()).error, "unauthorized");
});

test("OAuth discovery 公布 resource、DCR、PKCE 與 public-client token method", async () => {
  const resource = await worker.fetch(new Request("https://x/.well-known/oauth-protected-resource"), ENV);
  assert.equal(resource.status, 200);
  assert.deepEqual((await resource.json()).authorization_servers, ["https://x"]);
  const auth = await worker.fetch(new Request("https://x/.well-known/oauth-authorization-server"), ENV);
  assert.equal(auth.status, 200);
  const metadata = await auth.json();
  assert.equal(metadata.registration_endpoint, "https://x/register");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
});

test("DCR 只接受 public PKCE client 與安全 redirect URI", async () => {
  const bad = await worker.fetch(new Request("https://x/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
  }), ENV);
  assert.equal(bad.status, 400);
  const ok = await worker.fetch(new Request("https://x/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/test"], token_endpoint_auth_method: "none" }),
  }), ENV);
  assert.equal(ok.status, 201);
  const client = await ok.json();
  assert.ok(client.client_id);
  assert.equal(client.token_endpoint_auth_method, "none");
});

test("完整 authorization-code + PKCE 流程可換 token，code 不可重放", async () => {
  const register = await worker.fetch(new Request("https://x/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/test"] }),
  }), ENV);
  const { client_id: clientId } = await register.json();
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const authorizeUrl = new URL("https://x/authorize");
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/test", state: "state-1",
    code_challenge: challenge, code_challenge_method: "S256", resource: "https://x/mcp",
    scope: "mywiki:read mywiki:write" })) authorizeUrl.searchParams.set(key, value);

  const consent = await worker.fetch(new Request(authorizeUrl), ENV);
  assert.equal(consent.status, 200);
  const consentCookie = consent.headers.get("set-cookie") || "";
  assert.match(consentCookie, /SameSite=None/i);
  assert.match(consentCookie, /Partitioned/i);
  const html = await consent.text();
  const requestToken = html.match(/name="request_token" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(requestToken && csrf);
  assert.doesNotMatch(html, /right-pin/);

  const approved = await worker.fetch(new Request("https://x/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `__Host-MYWIKI_OAUTH_CSRF=${csrf}`, "cf-connecting-ip": "203.0.113.9" },
    body: new URLSearchParams({ request_token: requestToken, csrf_token: csrf, pin: "right-pin", decision: "allow" }),
  }), ENV);
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  const code = callback.searchParams.get("code");
  assert.ok(code);
  assert.equal(callback.searchParams.get("state"), "state-1");

  const exchangeBody = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/test", resource: "https://x/mcp", code, code_verifier: verifier });
  const exchange = () => worker.fetch(new Request("https://x/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: exchangeBody,
  }), ENV);
  const first = await exchange();
  assert.equal(first.status, 200);
  const tokens = await first.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await initialize("https://x/mcp", { authorization: `Bearer ${tokens.access_token}` })).status, 200);
  const replay = await exchange();
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
});

test("ChatGPT CIMD 可免 DCR 授權，Cookie 被擋時同源 POST 仍可完成", async () => {
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientId = "https://chatgpt.com/oauth/client.json";
  const env = {
    MCP_PIN: "right-pin",
    DB_FIELDLOG: new OAuthDb(),
    OAUTH_CLIENT_METADATA_FETCH: async (url) => {
      assert.equal(url, clientId);
      return new Response(JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }), { headers: { "content-type": "application/json" } });
    },
  };
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const authorizeUrl = new URL("https://x/authorize");
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId,
    redirect_uri: redirectUri, state: "cimd-state", code_challenge: challenge,
    code_challenge_method: "S256", resource: "https://x/mcp", scope: "mywiki:read" })) {
    authorizeUrl.searchParams.set(key, value);
  }

  const consent = await worker.fetch(new Request(authorizeUrl), env);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const requestToken = html.match(/name="request_token" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(requestToken && csrf);

  const approved = await worker.fetch(new Request("https://x/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://x",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: new URLSearchParams({ request_token: requestToken, csrf_token: csrf, pin: "right-pin", decision: "allow" }),
  }), env);
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "cimd-state");
  assert.equal(callback.searchParams.get("iss"), "https://x");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const exchange = await worker.fetch(new Request("https://x/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      redirect_uri: redirectUri, resource: "https://x/mcp", code, code_verifier: verifier }),
  }), env);
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.ok(tokens.access_token);
  const mcp = await worker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  }), env);
  assert.equal(mcp.status, 200);
});

test("授權表單沒有 Cookie 且不是同源 POST 時仍拒絕", async () => {
  const register = await worker.fetch(new Request("https://x/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/test"] }),
  }), ENV);
  const { client_id: clientId } = await register.json();
  const challenge = "a".repeat(43);
  const authorizeUrl = new URL("https://x/authorize");
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/test", state: "state-x",
    code_challenge: challenge, code_challenge_method: "S256", resource: "https://x/mcp",
    scope: "mywiki:read" })) authorizeUrl.searchParams.set(key, value);
  const consent = await worker.fetch(new Request(authorizeUrl), ENV);
  const html = await consent.text();
  const requestToken = html.match(/name="request_token" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const rejected = await worker.fetch(new Request("https://x/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: new URLSearchParams({ request_token: requestToken, csrf_token: csrf, pin: "right-pin", decision: "allow" }),
  }), ENV);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error_description, "CSRF validation failed");
});

test("既有三種 PIN 方式保持相容，未設定 secret 仍 fail-closed", async () => {
  for (const res of [await initialize("https://x/mcp?pin=right-pin"),
    await initialize("https://x/mcp", { "x-pin": "right-pin" }),
    await initialize("https://x/mcp", { authorization: "Bearer right-pin" })]) assert.equal(res.status, 200);
  const missing = await worker.fetch(new Request("https://x/mcp", { method: "POST" }), {});
  assert.equal(missing.status, 401);
  assert.match((await missing.json()).error_description, /MCP_PIN/);
});

test("健康檢查頁報工具數且不洩漏工具名", async () => {
  const res = await worker.fetch(new Request("https://x/"), ENV);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /工具數：\d+/);
  assert.doesNotMatch(text, /get_fieldlog|search_fieldlog/);
});

test("tools/list 可在 OAuth 前探索，並提供 ChatGPT 所需的標題、安全 annotations 與 OAuth scheme", async () => {
  const res = await worker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }), ENV);
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.tools.length, 28);
  for (const tool of result.tools) {
    assert.ok(tool.title, `${tool.name} 缺少 title`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} 的 inputSchema 無效`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} 缺少 readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} 缺少 destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} 缺少 openWorldHint`);
    assert.equal(tool.securitySchemes?.[0]?.type, "oauth2", `${tool.name} 缺少 OAuth security scheme`);
    assert.deepEqual(tool._meta?.securitySchemes, tool.securitySchemes, `${tool.name} 缺少相容的 _meta.securitySchemes`);
  }
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.search_fieldlog.annotations.readOnlyHint, true);
  assert.equal(byName.create_fieldlog_entry.annotations.readOnlyHint, false);
  assert.equal(byName.delete_folder.annotations.destructiveHint, true);
});
