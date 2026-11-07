/**
 * v246 Face ID 登入（WebAuthn passkey）。用 WebCrypto 產生真正的 P-256 金鑰，
 * 模擬 iPhone 的註冊與簽章，node:sqlite 當 D1，完整跑 Worker。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { b64urlDecode, b64urlEncode, derSignatureToRaw } from "../fieldlog/src/lib/passkey.js";

const HOST = "mywiki.example.dev";
const ORIGIN = `https://${HOST}`;
const PIN = "1234";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { sqlite, prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
}

async function call(env, path, { method = "POST", body, host = HOST, headers = {} } = {}) {
  const res = await fieldlogWorker.fetch(new Request(`https://${host}${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { FIELD_PIN: PIN, ...env });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: res.headers.get("set-cookie") || "" };
}
const authed = { "x-pin": PIN };

/** DER 編碼的 ECDSA 簽章（WebCrypto 給的是 raw r||s，要轉成 WebAuthn 用的 DER）。 */
function rawToDer(raw) {
  const part = (bytes) => {
    let v = Array.from(bytes); while (v.length > 1 && v[0] === 0) v.shift();
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const r = part(raw.slice(0, 32)); const s = part(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); }

async function makeAuthenticator() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const id = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const clientData = (type, challenge, origin = ORIGIN) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const authData = async ({ rpId = HOST, flags = 0x05 } = {}) => {
    const d = new Uint8Array(37); d.set(await sha256(new TextEncoder().encode(rpId)), 0); d[32] = flags; return d;
  };
  return {
    id, spki, pair,
    async register(options, { origin = ORIGIN } = {}) {
      return { id, clientDataJSON: b64urlEncode(clientData("webauthn.create", options.challenge, origin)), publicKey: b64urlEncode(spki), transports: ["internal"], label: "iPhone（測試）" };
    },
    async assert(options, { origin = ORIGIN, rpId = HOST, flags = 0x05, type = "webauthn.get", challenge, tamper = false } = {}) {
      const cd = clientData(type, challenge ?? options.challenge, origin);
      const ad = await authData({ rpId, flags });
      const toSign = new Uint8Array(ad.length + 32); toSign.set(ad, 0); toSign.set(await sha256(cd), ad.length);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, toSign));
      if (tamper) raw[5] ^= 0xff;
      return { id, clientDataJSON: b64urlEncode(cd), authenticatorData: b64urlEncode(ad), signature: b64urlEncode(rawToDer(raw)) };
    },
  };
}

async function enroll(env, auth) {
  const opt = await call(env, "/api/passkey/register/options", { headers: authed, body: {} });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  const reg = await call(env, "/api/passkey/register", { headers: authed, body: await auth.register(opt.body.options) });
  return { opt, reg };
}
async function loginOptions(env) { return (await call(env, "/api/passkey/login/options", { body: {} })); }

test("derSignatureToRaw：補零與前導零都正確還原成 64 bytes", () => {
  const raw = new Uint8Array(64); raw.fill(0x11, 0, 32); raw[0] = 0x00; raw[1] = 0x80; raw.fill(0xfe, 32);
  assert.deepEqual(derSignatureToRaw(rawToDer(raw)), raw);
});

test("註冊＋登入：Face ID 簽章通過後拿到跟 PIN 登入相同的 Session cookie", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  // 還沒註冊：登入選項被拒絕
  assert.equal((await loginOptions(env)).status, 404);
  const { opt, reg } = await enroll(env, auth);
  assert.equal(opt.body.options.rp.id, HOST);
  assert.equal(opt.body.options.authenticatorSelection.userVerification, "required");
  assert.deepEqual(opt.body.options.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));

  const lo = await loginOptions(env);
  assert.equal(lo.status, 200);
  assert.equal(lo.body.options.userVerification, "required");
  const login = await call(env, "/api/passkey/login", { body: await auth.assert(lo.body.options) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.match(login.cookie, /^__Host-myw_session=.+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict/);
  // 拿到的 Session 真的能打 API
  const session = login.cookie.split(";")[0];
  const folders = await call(env, "/api/folders", { method: "GET", headers: { cookie: session } });
  assert.equal(folders.status, 200);
  assert.ok(env.DB.sqlite.prepare("SELECT last_used_at FROM passkeys").get().last_used_at);
});

test("挑戰碼只能用一次：同一份簽章重放會失敗", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  await enroll(env, auth);
  const lo = await loginOptions(env);
  const payload = await auth.assert(lo.body.options);
  assert.equal((await call(env, "/api/passkey/login", { body: payload })).status, 200);
  const replay = await call(env, "/api/passkey/login", { body: payload });
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /挑戰碼無效或已過期/);
  assert.equal(replay.cookie, "", "重放不給 cookie");
});

test("攻擊情境：錯的網站、錯的 rpId、沒驗證臉部、被竄改簽章、未知 Passkey、沒發過的挑戰碼，一律不給 Session", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  await enroll(env, auth);
  const attempts = [
    ["釣魚網站的 origin", (o) => auth.assert(o, { origin: "https://evil.example.com" }), /來源網址不符/],
    ["別的網站 rpId", (o) => auth.assert(o, { rpId: "evil.example.com" }), /網站識別不符/],
    ["沒有臉部／密碼驗證（UV=0）", (o) => auth.assert(o, { flags: 0x01 }), /沒有通過臉部／密碼驗證/],
    ["沒有使用者在場（UP=0）", (o) => auth.assert(o, { flags: 0x04 }), /沒有使用者在場/],
    ["簽章被竄改", (o) => auth.assert(o, { tamper: true }), /簽章驗證失敗/],
    ["註冊用的 type 拿來登入", (o) => auth.assert(o, { type: "webauthn.create" }), /驗證類型不符/],
    ["伺服器沒發過的挑戰碼", (o) => auth.assert(o, { challenge: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))) }), /挑戰碼無效/],
  ];
  for (const [name, make, expected] of attempts) {
    const lo = await loginOptions(env);
    const res = await call(env, "/api/passkey/login", { body: await make(lo.body.options) });
    assert.equal(res.status, 401, `${name}：${JSON.stringify(res.body)}`);
    assert.match(res.body.error, expected, name);
    assert.equal(res.cookie, "", `${name} 不可發 cookie`);
  }
  // 沒註冊過的 Passkey（別人的金鑰）。前面 7 次失敗已接近鎖定門檻，先清掉計數再測
  env.DB.sqlite.exec("DELETE FROM auth_attempts");
  const stranger = await makeAuthenticator();
  const lo = await loginOptions(env);
  const res = await call(env, "/api/passkey/login", { body: await stranger.assert(lo.body.options) });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /找不到這個 Passkey/);
});

test("挑戰碼過期就不能用", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  await enroll(env, auth);
  const lo = await loginOptions(env);
  env.DB.sqlite.prepare("UPDATE webauthn_challenges SET expires_at = ?").run(Date.now() - 1000);
  const res = await call(env, "/api/passkey/login", { body: await auth.assert(lo.body.options) });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /挑戰碼無效或已過期/);
});

test("失敗過多會鎖定（跟 PIN 一樣），鎖定後連正確簽章也要等", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  await enroll(env, auth);
  let last;
  for (let i = 0; i < 8; i++) {
    const lo = await loginOptions(env);
    last = await call(env, "/api/passkey/login", { body: await auth.assert(lo.body.options, { tamper: true }) });
  }
  assert.equal(last.status, 429);
  const lo = await loginOptions(env);
  assert.equal(lo.status, 429, "鎖定期間連選項都不給");
});

test("註冊必須已登入；AI（MCP 主機）不能註冊、列出或移除；未登入也不能列出", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  assert.equal((await call(env, "/api/passkey/register/options", { body: {} })).status, 401, "沒有 PIN／Session 不能註冊");
  assert.equal((await call(env, "/api/passkeys", { method: "GET" })).status, 401);
  assert.equal((await call(env, "/api/passkey/register/options", { host: "fieldlog.internal", headers: authed, body: {} })).status, 403);
  assert.equal((await call(env, "/api/passkey/login/options", { host: "fieldlog.internal", body: {} })).status, 403, "AI 不能走登入端點");
  const { reg } = await enroll(env, auth);
  const id = reg.body.id;
  assert.equal((await call(env, "/api/passkeys", { method: "GET", host: "fieldlog.internal", headers: authed })).status, 403);
  assert.equal((await call(env, `/api/passkeys/${id}`, { method: "DELETE", host: "fieldlog.internal", headers: authed })).status, 403);
  const list = await call(env, "/api/passkeys", { method: "GET", headers: authed });
  assert.equal(list.body.passkeys.length, 1);
  assert.equal(list.body.passkeys[0].public_key, undefined, "列表不外洩公鑰");
  assert.equal((await call(env, `/api/passkeys/${id}`, { method: "DELETE", headers: authed })).body.ok, true);
  assert.equal((await loginOptions(env)).status, 404, "移除後 Face ID 登入失效");
});

test("註冊驗證：錯的 origin、重複註冊、壞公鑰、挑戰碼重用都被擋", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const auth = await makeAuthenticator();
  const o1 = (await call(env, "/api/passkey/register/options", { headers: authed, body: {} })).body.options;
  const bad = await call(env, "/api/passkey/register", { headers: authed, body: await auth.register(o1, { origin: "https://evil.example.com" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /來源網址不符/);
  const o2 = (await call(env, "/api/passkey/register/options", { headers: authed, body: {} })).body.options;
  const garbage = { ...(await auth.register(o2)), publicKey: b64urlEncode(new Uint8Array([1, 2, 3])) };
  assert.equal((await call(env, "/api/passkey/register", { headers: authed, body: garbage })).status, 400);
  const o3 = (await call(env, "/api/passkey/register/options", { headers: authed, body: {} })).body.options;
  const good = await auth.register(o3);
  assert.equal((await call(env, "/api/passkey/register", { headers: authed, body: good })).status, 200);
  const again = await call(env, "/api/passkey/register", { headers: authed, body: good });
  assert.equal(again.status, 400, "同一個挑戰碼／憑證不能重複註冊");
  const o4 = (await call(env, "/api/passkey/register/options", { headers: authed, body: {} })).body;
  assert.equal(o4.options.excludeCredentials.length, 1, "已註冊的裝置會被排除，避免重複建立");
});

test("前端：登入畫面有 Face ID 按鈕、首頁有啟用設定，且 PIN 登入保留", async () => {
  const [html, app] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js")]);
  assert.match(html, /id="btn-passkey-login"[^>]*hidden/);
  assert.match(html, /id="btn-login"/, "PIN 登入保留當備援");
  assert.match(html, /id="passkey-settings"[^>]*hidden/);
  assert.match(app, /isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(app, /userVerification: o\.userVerification/);
  assert.match(app, /getPublicKey/);
});
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
