/**
 * MyWiki MCP OAuth 2.1 authorization server.
 *
 * This is intentionally self-contained: the existing MCP_PIN remains the only
 * secret. It is used to authenticate the owner on the consent page and as the
 * HMAC key for short-lived OAuth artifacts. Rotating MCP_PIN invalidates all
 * clients and tokens, which is the desired emergency-revocation behavior for
 * this single-owner service.
 */

const SCOPES = ["mywiki:read", "mywiki:write"];
const CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CONSENT_COOKIE = "__Host-MYWIKI_OAUTH_CSRF";
const CHATGPT_CIMD_PATTERN = /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[A-Za-z0-9_-]+\/client\.json)$/;

// ChatGPT may open the OAuth consent page inside a partitioned browser context.
// SameSite=Lax cookies are then omitted from the form POST, which makes the
// double-submit CSRF check fail even though the user stayed on the same page.
// Partitioned + SameSite=None keeps the cookie scoped to that top-level client
// while allowing the consent POST to carry it.
function consentCookie(value, maxAge) {
  return `${CONSENT_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=None; Partitioned; Max-Age=${maxAge}`;
}

const OAUTH_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...OAUTH_CORS,
      ...extraHeaders,
    },
  });
}

function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status);
}

function authorizationErrorPage(message, status = 500) {
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MyWiki 授權失敗</title><style>body{font-family:system-ui,sans-serif;background:#f3f6f5;color:#123;margin:0;padding:32px}.card{max-width:520px;margin:8vh auto;background:#fff;border:1px solid #d8e1df;border-radius:16px;padding:28px}h1{color:#a33}.error{background:#fff1f0;border-radius:9px;padding:14px}a{color:#087f72}</style></head><body><main class="card"><h1>MyWiki 授權沒有完成</h1><p class="error">${safeMessage}</p><p>請關閉此頁，回到 ChatGPT 後重新連接。若再次出現，請截圖這段錯誤訊息；不要截入或貼出 PIN。</p></main></body></html>`;
  return new Response(html, { status, headers: securityHeaders() });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value))));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(value))));
}

function constantTimeEqual(left, right) {
  const a = utf8(left);
  const b = utf8(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  return diff === 0;
}

async function signPayload(payload, secret) {
  const encoded = base64url(utf8(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

async function verifyPayload(token, secret, expectedType) {
  if (!token || !secret) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = await hmac(encoded, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(encoded)));
    if (payload.typ !== expectedType || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function serverInfo(request) {
  const origin = new URL(request.url).origin;
  return {
    origin,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
  };
}

function pinSecret(env) {
  return String(env.MCP_PIN || "").trim();
}

function validRedirectUri(value) {
  try {
    const uri = new URL(value);
    return uri.protocol === "https:" || (uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname));
  } catch {
    return false;
  }
}

function normalizeScopes(raw) {
  if (!raw) return [...SCOPES];
  const requested = [...new Set(String(raw).split(/\s+/).filter(Boolean))];
  return requested.length > 0 && requested.every((scope) => SCOPES.includes(scope)) ? requested : null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function isSameOriginFormPost(request) {
  const origin = request.headers.get("origin") || "";
  return origin === new URL(request.url).origin;
}

function securityHeaders(setCookie) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  };
}

async function clientMetadata(clientId, secret, env) {
  const client = await verifyPayload(clientId, secret, "client");
  if (client && Array.isArray(client.redirect_uris) && client.redirect_uris.length > 0) return client;

  // ChatGPT now prefers Client ID Metadata Documents (CIMD). Only fetch the
  // exact official ChatGPT metadata URL shapes so client_id can never become
  // an arbitrary SSRF target. DCR remains available for older clients.
  if (!CHATGPT_CIMD_PATTERN.test(clientId)) return null;
  try {
    const fetchMetadata = env?.OAUTH_CLIENT_METADATA_FETCH || fetch;
    const response = await fetchMetadata(clientId, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) return null;
    const metadata = await response.json();
    const redirectUris = Array.isArray(metadata.redirect_uris)
      ? metadata.redirect_uris.filter(validRedirectUri)
      : [];
    const authMethods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? metadata.token_endpoint_auth_methods_supported
      : [metadata.token_endpoint_auth_method].filter(Boolean);
    if (redirectUris.length === 0 || !authMethods.includes("none")) return null;
    return {
      client_id: clientId,
      client_name: String(metadata.client_name || "ChatGPT").slice(0, 120),
      redirect_uris: redirectUris,
      cimd: true,
    };
  } catch (error) {
    console.error("OAuth CIMD fetch failed", error?.message || error);
    return null;
  }
}

async function ensureOAuthTables(env) {
  if (!env.DB_FIELDLOG) throw new Error("DB_FIELDLOG binding is required for OAuth");
  await env.DB_FIELDLOG.batch([
    env.DB_FIELDLOG.prepare(`CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      jti_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`),
    env.DB_FIELDLOG.prepare(`CREATE TABLE IF NOT EXISTS mcp_oauth_attempts (
      attempt_key TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )`),
  ]);
}

async function attemptKey(request) {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  return sha256(address.split(",")[0].trim());
}

async function isRateLimited(request, env) {
  await ensureOAuthTables(env);
  const key = await attemptKey(request);
  const since = Math.floor(Date.now() / 1000) - 600;
  const row = await env.DB_FIELDLOG.prepare(
    "SELECT window_started_at, attempts FROM mcp_oauth_attempts WHERE attempt_key = ?",
  ).bind(key).first();
  return Boolean(row && Number(row.window_started_at) >= since && Number(row.attempts) >= 8);
}

async function recordFailedAttempt(request, env) {
  const key = await attemptKey(request);
  const now = Math.floor(Date.now() / 1000);
  const since = now - 600;
  await env.DB_FIELDLOG.prepare(`INSERT INTO mcp_oauth_attempts (attempt_key, window_started_at, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(attempt_key) DO UPDATE SET
      window_started_at = CASE WHEN window_started_at < ? THEN excluded.window_started_at ELSE window_started_at END,
      attempts = CASE WHEN window_started_at < ? THEN 1 ELSE attempts + 1 END`).bind(key, now, since, since).run();
}

async function clearFailedAttempts(request, env) {
  const key = await attemptKey(request);
  await env.DB_FIELDLOG.prepare("DELETE FROM mcp_oauth_attempts WHERE attempt_key = ?").bind(key).run();
}

async function registerClient(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: OAUTH_CORS });
  if (request.method !== "POST") return oauthError("invalid_request", "registration requires POST", 405);
  const secret = pinSecret(env);
  if (!secret) return oauthError("server_error", "OAuth is not configured", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "request body must be JSON");
  }
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || !body.redirect_uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must contain valid HTTPS URLs");
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "only public PKCE clients are supported");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientId = await signPayload({
    typ: "client",
    iat: issuedAt,
    exp: issuedAt + 3650 * 24 * 60 * 60,
    redirect_uris: [...new Set(body.redirect_uris)],
    client_name: String(body.client_name || "MCP client").slice(0, 120),
  }, secret);
  return json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: [...new Set(body.redirect_uris)],
    client_name: String(body.client_name || "MCP client").slice(0, 120),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

async function authorizationGet(request, env) {
  const secret = pinSecret(env);
  if (!secret) return oauthError("server_error", "OAuth is not configured", 503);
  const url = new URL(request.url);
  const info = serverInfo(request);
  const clientId = url.searchParams.get("client_id") || "";
  const client = await clientMetadata(clientId, secret, env);
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const scopes = normalizeScopes(url.searchParams.get("scope"));
  const resource = url.searchParams.get("resource") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  if (!client) return oauthError("invalid_client", "unknown or expired client_id");
  if (!client.redirect_uris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri does not match the registered client");
  if (url.searchParams.get("response_type") !== "code") return oauthError("unsupported_response_type", "response_type must be code");
  if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return oauthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (resource !== info.resource) return oauthError("invalid_target", "resource does not match this MCP server");
  if (!scopes) return oauthError("invalid_scope", "unsupported scope requested");
  const csrf = randomToken();
  const requestToken = await signPayload({
    typ: "request",
    exp: Math.floor(Date.now() / 1000) + 600,
    client_id: clientId,
    redirect_uri: redirectUri,
    state: url.searchParams.get("state") || "",
    code_challenge: codeChallenge,
    resource,
    scope: scopes.join(" "),
    csrf_hash: await sha256(csrf),
  }, secret);
  const clientName = escapeHtml(client.client_name || "MCP client");
  const scopeText = escapeHtml(scopes.join("、"));
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授權 MyWiki</title><style>body{font-family:system-ui,sans-serif;background:#f3f6f5;color:#123;margin:0;padding:32px}.card{max-width:520px;margin:6vh auto;background:#fff;border:1px solid #d8e1df;border-radius:16px;padding:28px;box-shadow:0 12px 35px #1232}h1{margin-top:0;color:#087f72}label{display:block;margin:18px 0 8px;font-weight:700}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #9aa;border-radius:9px;font-size:16px}.scope{background:#eef7f5;padding:12px;border-radius:9px}.actions{display:flex;gap:10px;margin-top:22px}button{border:0;border-radius:9px;padding:12px 18px;font-size:16px;cursor:pointer}.allow{background:#087f72;color:white}.deny{background:#e7eceb;color:#234}.note{color:#526;font-size:14px}</style></head><body><main class="card"><h1>授權連接 MyWiki</h1><p><strong>${clientName}</strong> 要求存取你的私人 MyWiki。</p><p class="scope">權限：${scopeText}</p><form method="post" action="/authorize"><input type="hidden" name="request_token" value="${escapeHtml(requestToken)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label for="pin">MyWiki MCP PIN</label><input id="pin" name="pin" type="password" autocomplete="current-password" required><p class="note">PIN 只在此安全頁面驗證，不會傳給 ChatGPT。</p><div class="actions"><button class="allow" name="decision" value="allow" type="submit">允許</button><button class="deny" name="decision" value="deny" type="submit" formnovalidate>取消</button></div></form></main></body></html>`;
  return new Response(html, {
    headers: securityHeaders(consentCookie(csrf, 600)),
  });
}

async function authorizationPost(request, env) {
  const secret = pinSecret(env);
  if (!secret) return oauthError("server_error", "OAuth is not configured", 503);
  let form;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "invalid form body");
  }
  const requestToken = String(form.get("request_token") || "");
  const authRequest = await verifyPayload(requestToken, secret, "request");
  if (!authRequest) return oauthError("invalid_request", "authorization request expired; start again");
  const csrf = String(form.get("csrf_token") || "");
  const csrfSigned = csrf && authRequest.csrf_hash
    && constantTimeEqual(await sha256(csrf), authRequest.csrf_hash);
  const csrfCookie = csrf && constantTimeEqual(csrf, cookieValue(request, CONSENT_COOKIE));
  // Some embedded browsers discard even Partitioned cookies. A genuine form
  // submission from this authorization page still carries a same-origin
  // Origin header, so accept either proof while rejecting cross-site posts.
  if (!csrfSigned || (!csrfCookie && !isSameOriginFormPost(request))) {
    return oauthError("invalid_request", "CSRF validation failed");
  }
  const redirect = new URL(authRequest.redirect_uri);
  if (form.get("decision") !== "allow") {
    redirect.searchParams.set("error", "access_denied");
    if (authRequest.state) redirect.searchParams.set("state", authRequest.state);
    redirect.searchParams.set("iss", serverInfo(request).origin);
    return Response.redirect(redirect.toString(), 302);
  }
  if (await isRateLimited(request, env)) return oauthError("temporarily_unavailable", "too many attempts; try again later", 429);
  const given = String(form.get("pin") || "");
  const [givenHash, expectedHash] = await Promise.all([sha256(given), sha256(secret)]);
  if (!constantTimeEqual(givenHash, expectedHash)) {
    await recordFailedAttempt(request, env);
    return oauthError("access_denied", "PIN 不正確；請回到連接器重新授權", 403);
  }
  await clearFailedAttempts(request, env);
  const now = Math.floor(Date.now() / 1000);
  const jti = randomToken();
  await ensureOAuthTables(env);
  await env.DB_FIELDLOG.prepare(
    "INSERT INTO mcp_oauth_codes (jti_hash, expires_at, used_at) VALUES (?, ?, NULL)",
  ).bind(await sha256(jti), now + CODE_TTL_SECONDS).run();
  const code = await signPayload({
    typ: "code",
    iat: now,
    exp: now + CODE_TTL_SECONDS,
    jti,
    client_id: authRequest.client_id,
    redirect_uri: authRequest.redirect_uri,
    code_challenge: authRequest.code_challenge,
    resource: authRequest.resource,
    scope: authRequest.scope,
  }, secret);
  redirect.searchParams.set("code", code);
  if (authRequest.state) redirect.searchParams.set("state", authRequest.state);
  redirect.searchParams.set("iss", serverInfo(request).origin);
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString(),
      "cache-control": "no-store",
      "set-cookie": consentCookie("", 0),
    },
  });
}

async function issueTokens(secret, clientId, resource, scope) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signPayload({
    typ: "access", iat: now, exp: now + ACCESS_TTL_SECONDS, client_id: clientId, aud: resource, scope,
  }, secret);
  const refreshToken = await signPayload({
    typ: "refresh", iat: now, exp: now + REFRESH_TTL_SECONDS, jti: randomToken(), client_id: clientId, aud: resource, scope,
  }, secret);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope };
}

async function tokenEndpoint(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: OAUTH_CORS });
  if (request.method !== "POST") return oauthError("invalid_request", "token endpoint requires POST", 405);
  const secret = pinSecret(env);
  if (!secret) return oauthError("server_error", "OAuth is not configured", 503);
  let form;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "invalid token request");
  }
  const grantType = String(form.get("grant_type") || "");
  const clientId = String(form.get("client_id") || "");
  const client = await clientMetadata(clientId, secret, env);
  if (!client) return oauthError("invalid_client", "unknown or expired client_id", 401);
  const info = serverInfo(request);
  const resource = String(form.get("resource") || "");
  if (resource !== info.resource) return oauthError("invalid_target", "resource does not match this MCP server");

  if (grantType === "authorization_code") {
    const code = await verifyPayload(String(form.get("code") || ""), secret, "code");
    if (!code || code.client_id !== clientId || code.redirect_uri !== String(form.get("redirect_uri") || "") || code.resource !== resource) {
      return oauthError("invalid_grant", "authorization code is invalid or expired");
    }
    const verifier = String(form.get("code_verifier") || "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantTimeEqual(await sha256(verifier), code.code_challenge)) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    await ensureOAuthTables(env);
    const used = await env.DB_FIELDLOG.prepare(
      "UPDATE mcp_oauth_codes SET used_at = ? WHERE jti_hash = ? AND used_at IS NULL AND expires_at >= ?",
    ).bind(Math.floor(Date.now() / 1000), await sha256(code.jti), Math.floor(Date.now() / 1000)).run();
    if (Number(used?.meta?.changes || 0) !== 1) return oauthError("invalid_grant", "authorization code was already used");
    return json(await issueTokens(secret, clientId, resource, code.scope));
  }

  if (grantType === "refresh_token") {
    const refresh = await verifyPayload(String(form.get("refresh_token") || ""), secret, "refresh");
    if (!refresh || refresh.client_id !== clientId || refresh.aud !== resource) {
      return oauthError("invalid_grant", "refresh token is invalid or expired");
    }
    const tokens = await issueTokens(secret, clientId, resource, refresh.scope);
    return json(tokens);
  }
  return oauthError("unsupported_grant_type", "supported grants: authorization_code, refresh_token");
}

export async function handleOAuthRoute(request, env) {
  const url = new URL(request.url);
  const info = serverInfo(request);
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json({
      resource: info.resource,
      authorization_servers: [info.origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: `${info.origin}/`,
    });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: info.origin,
      authorization_endpoint: `${info.origin}/authorize`,
      token_endpoint: `${info.origin}/token`,
      registration_endpoint: `${info.origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (url.pathname === "/register") {
    try {
      return await registerClient(request, env);
    } catch (error) {
      console.error("OAuth client registration failed", error?.message || error);
      return oauthError("server_error", "MyWiki 無法建立 OAuth 用戶端，請稍後重試", 500);
    }
  }
  if (url.pathname === "/authorize") {
    try {
      if (request.method === "GET") return await authorizationGet(request, env);
      if (request.method === "POST") return await authorizationPost(request, env);
    } catch (error) {
      console.error("OAuth authorization failed", error?.message || error);
      return authorizationErrorPage(`伺服器處理授權時發生錯誤：${error?.message || "未知錯誤"}`);
    }
    return oauthError("invalid_request", "authorize supports GET and POST", 405);
  }
  if (url.pathname === "/token") {
    try {
      return await tokenEndpoint(request, env);
    } catch (error) {
      console.error("OAuth token exchange failed", error?.message || error);
      return oauthError("server_error", "MyWiki 無法完成 token 交換，請重新授權", 500);
    }
  }
  return null;
}

export async function authorizeMcpRequest(request, env) {
  const secret = pinSecret(env);
  if (!secret) return { ok: false, reason: "尚未設定 MCP_PIN" };
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const legacy = String(request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
  if (legacy) {
    const [actual, expected] = await Promise.all([sha256(legacy), sha256(secret)]);
    return { ok: constantTimeEqual(actual, expected), legacy: true, reason: "PIN 不正確" };
  }
  if (bearer) {
    // Keep Authorization: Bearer <MCP_PIN> working for existing non-OAuth clients.
    const [actual, expected] = await Promise.all([sha256(bearer), sha256(secret)]);
    if (constantTimeEqual(actual, expected)) return { ok: true, legacy: true };
    const token = await verifyPayload(bearer, secret, "access");
    const info = serverInfo(request);
    if (token && token.aud === info.resource && normalizeScopes(token.scope)) return { ok: true, oauth: true, token };
    return { ok: false, reason: "OAuth access token 無效或已過期" };
  }
  return { ok: false, reason: "需要 OAuth 授權或既有 PIN" };
}

export function oauthUnauthorized(request, description) {
  const info = serverInfo(request);
  return json({ error: "unauthorized", error_description: description }, 401, {
    "www-authenticate": `Bearer resource_metadata="${info.resourceMetadata}", scope="${SCOPES.join(" ")}"`,
  });
}
