/**
 * v246 Face ID／Touch ID 登入（WebAuthn passkey）。
 *
 * 設計：
 * - 只有「已登入」的人能註冊 passkey（註冊端點走原本的 PIN／Session 驗證）；
 *   註冊後的 passkey 只能用來換一個跟 PIN 登入一模一樣的 12 小時 Session cookie。
 * - 登入要求使用者驗證（userVerification=required，iPhone 上就是 Face ID／密碼）。
 * - 挑戰碼單次使用、5 分鐘過期，存在 D1，用 DELETE 的 changes 判斷，避免重放。
 * - 只支援 ES256（P-256），iPhone／Mac／Android 的平台 passkey 都是這個演算法。
 * - 驗證 clientDataJSON 的 type／challenge／origin，以及 authenticatorData 的
 *   rpIdHash、UP、UV 旗標，再驗簽章。簽章計數器不強制（iCloud 鑰匙圈同步的 passkey 計數器恆為 0）。
 * - AI（MCP，主機 fieldlog.internal）不能註冊或刪除 passkey。
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const USER_HANDLE = "mywiki-owner";

export function b64urlEncode(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** WebAuthn 的 ECDSA 簽章是 ASN.1 DER，WebCrypto 要 raw r||s（各 32 bytes）。 */
export function derSignatureToRaw(der) {
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  if (b[0] !== 0x30) throw new Error("簽章格式錯誤");
  let i = 2;
  if (b[1] & 0x80) i = 2 + (b[1] & 0x7f);
  const readInt = () => {
    if (b[i] !== 0x02) throw new Error("簽章格式錯誤");
    const length = b[i + 1];
    let value = b.slice(i + 2, i + 2 + length);
    i += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("簽章格式錯誤");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

export function expectedRelyingParty(url) {
  return { rpId: url.hostname, origin: url.origin };
}

export async function issueChallenge(db, kind) {
  const challenge = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(Date.now()).run().catch(() => {});
  await db.prepare("INSERT INTO webauthn_challenges (challenge, kind, expires_at) VALUES (?, ?, ?)")
    .bind(challenge, kind, Date.now() + CHALLENGE_TTL_MS).run();
  return challenge;
}

/** 挑戰碼只能用一次：DELETE 成功（changes=1）才算有效。 */
async function consumeChallenge(db, challenge, kind) {
  const result = await db.prepare("DELETE FROM webauthn_challenges WHERE challenge = ? AND kind = ? AND expires_at >= ?")
    .bind(challenge, kind, Date.now()).run();
  return Number(result?.meta?.changes || 0) === 1;
}

function parseClientData(clientDataJSON, expectedType, { origin }) {
  let data;
  try { data = JSON.parse(new TextDecoder().decode(clientDataJSON)); } catch { throw new Error("clientData 格式錯誤"); }
  if (data.type !== expectedType) throw new Error("驗證類型不符");
  if (data.origin !== origin) throw new Error("來源網址不符");
  if (data.crossOrigin === true) throw new Error("不接受跨來源驗證");
  return data;
}

export function registrationOptions(challenge, url, { excludeIds = [] } = {}) {
  const { rpId } = expectedRelyingParty(url);
  return {
    challenge,
    rp: { name: "MyWiki 隨身記", id: rpId },
    user: { id: b64urlEncode(new TextEncoder().encode(USER_HANDLE)), name: "owner", displayName: "MyWiki" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    timeout: 60000,
    excludeCredentials: excludeIds.map((id) => ({ type: "public-key", id })),
  };
}

export function loginOptions(challenge, url) {
  return { challenge, rpId: expectedRelyingParty(url).rpId, userVerification: "required", timeout: 60000 };
}

/** 註冊：驗 clientData（類型、挑戰碼、來源），確認公鑰是 P-256，存起來。 */
export async function verifyRegistration(db, body, url, { label = "" } = {}) {
  const clientDataJSON = b64urlDecode(body.clientDataJSON);
  const data = parseClientData(clientDataJSON, "webauthn.create", expectedRelyingParty(url));
  if (!await consumeChallenge(db, data.challenge, "register")) throw new Error("挑戰碼無效或已過期，請重新操作");
  const credentialId = String(body.id || "");
  if (!credentialId || credentialId.length > 1024) throw new Error("缺少憑證 ID");
  const spki = b64urlDecode(body.publicKey);
  // 只接受 ES256：實際匯入一次確認格式正確
  await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const exists = await db.prepare("SELECT id FROM passkeys WHERE credential_id = ?").bind(credentialId).first();
  if (exists) throw new Error("這個 Passkey 已經註冊過了");
  const now = new Date().toISOString();
  const result = await db.prepare(
    "INSERT INTO passkeys (credential_id, public_key, label, transports, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, '')"
  ).bind(credentialId, b64urlEncode(spki), String(label || "").slice(0, 60), JSON.stringify(body.transports || []).slice(0, 200), now).run();
  return { id: Number(result.meta.last_row_id), credential_id: credentialId };
}

/** 登入：驗 clientData、authenticatorData（rpIdHash／UP／UV）與簽章。成功回傳 passkey 紀錄。 */
export async function verifyAssertion(db, body, url) {
  const clientDataJSON = b64urlDecode(body.clientDataJSON);
  const authData = b64urlDecode(body.authenticatorData);
  const signature = b64urlDecode(body.signature);
  const rp = expectedRelyingParty(url);
  const data = parseClientData(clientDataJSON, "webauthn.get", rp);
  const credential = await db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").bind(String(body.id || "")).first();
  if (!credential) throw new Error("找不到這個 Passkey，請改用 PIN 登入");
  if (authData.byteLength < 37) throw new Error("authenticatorData 格式錯誤");
  if (!equalBytes(authData.slice(0, 32), await sha256(new TextEncoder().encode(rp.rpId)))) throw new Error("網站識別不符");
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Error("沒有使用者在場確認");
  if (!(flags & 0x04)) throw new Error("沒有通過臉部／密碼驗證");
  const key = await crypto.subtle.importKey("spki", b64urlDecode(credential.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signedData = new Uint8Array(authData.byteLength + 32);
  signedData.set(authData, 0);
  signedData.set(await sha256(clientDataJSON), authData.byteLength);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignatureToRaw(signature), signedData);
  if (!valid) throw new Error("簽章驗證失敗");
  // 簽章通過才消耗挑戰碼（避免亂送的請求把真正的挑戰碼用掉）
  if (!await consumeChallenge(db, data.challenge, "login")) throw new Error("挑戰碼無效或已過期，請重新操作");
  await db.prepare("UPDATE passkeys SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), credential.id).run();
  return credential;
}
