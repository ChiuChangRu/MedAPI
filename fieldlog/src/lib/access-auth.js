const jwksCache = new Map();

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  return bytes;
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function allowedEmails(env) {
  return new Set(String(env.ACCESS_ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

async function getJwks(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
  if (!response.ok) throw new Error("無法取得 Cloudflare Access 公鑰");
  const data = await response.json();
  const keys = data.keys || [];
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + 60 * 60 * 1000 });
  return keys;
}

export async function verifyAccessRequest(request, env) {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = String(env.ACCESS_AUD || "").trim();
  if (!teamDomain || !audience) return { configured: false };

  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const parts = token.split(".");
  if (parts.length !== 3) return { configured: true, ok: false, error: "缺少 Cloudflare Access 身分" };
  try {
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== `https://${teamDomain}` || !audiences.includes(audience) || payload.exp <= now || payload.nbf > now + 60) {
      return { configured: true, ok: false, error: "Cloudflare Access 憑證無效或已過期" };
    }
    const jwk = (await getJwks(teamDomain)).find((item) => item.kid === header.kid);
    if (!jwk || header.alg !== "RS256") return { configured: true, ok: false, error: "Cloudflare Access 簽章金鑰無效" };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return { configured: true, ok: false, error: "Cloudflare Access 簽章驗證失敗" };
    const email = String(payload.email || "").trim().toLowerCase();
    const allow = allowedEmails(env);
    if (!email || (allow.size && !allow.has(email))) return { configured: true, ok: false, error: "此帳號不在 MyWiki 白名單" };
    return { configured: true, ok: true, email, payload };
  } catch {
    return { configured: true, ok: false, error: "Cloudflare Access 憑證格式錯誤" };
  }
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createLegacySession(secret, maxAgeSeconds = 43200) {
  const payload = btoa(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyLegacySession(request, secret) {
  const cookie = request.headers.get("cookie") || "";
  const value = cookie.split(/;\s*/).find((item) => item.startsWith("__Host-myw_session="))?.split("=").slice(1).join("=") || "";
  const [payload, signature] = value.split(".");
  if (!payload || !signature || signature !== await hmacHex(secret, payload)) return false;
  try {
    const data = decodeJson(payload);
    return data.v === 1 && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

export function securityHeaders(headers = new Headers()) {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(self), microphone=(self), geolocation=()");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return headers;
}
