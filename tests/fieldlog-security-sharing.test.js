import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createLegacySession, securityHeaders, verifyLegacySession } from "../fieldlog/src/lib/access-auth.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("PIN Session 使用 HttpOnly Cookie 所需的簽名資料，過期或竄改會失效", async () => {
  const token = await createLegacySession("secret", 60);
  const valid = new Request("https://x/api/folders", { headers: { cookie: `__Host-myw_session=${token}` } });
  assert.equal(await verifyLegacySession(valid, "secret"), true);
  assert.equal(await verifyLegacySession(valid, "wrong-secret"), false);
  const tampered = new Request("https://x/api/folders", { headers: { cookie: `__Host-myw_session=${token}x` } });
  assert.equal(await verifyLegacySession(tampered, "secret"), false);
});

test("私人站補齊基本安全標頭", () => {
  const headers = securityHeaders();
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("strict-transport-security"), /max-age=31536000/);
});

test("前端不再把完整 PIN 放進檔案或匯出網址", async () => {
  const [app, pdf] = await Promise.all([read("../fieldlog/public/app.js"), read("../fieldlog/public/pdf-editor.js")]);
  assert.doesNotMatch(app, /\/api\/file\/[^\n]*\?pin=/);
  assert.doesNotMatch(app, /\/api\/export\/[^\n]*\?pin=/);
  assert.doesNotMatch(pdf, /\?pin=/);
  assert.match(app, /localStorage\.removeItem\("fieldlog_pin"\)/);
});

test("分享採不可逆 token_hash、可到期撤銷，公開 Worker 只允許 GET/HEAD", async () => {
  const [fieldlog, share] = await Promise.all([read("../fieldlog/src/worker.js"), read("../share/src/worker.js")]);
  assert.match(fieldlog, /token_hash/);
  assert.match(fieldlog, /randomShareToken\(\)/);
  assert.match(fieldlog, /sha256Hex\(token\)/);
  assert.match(fieldlog, /revoked_at/);
  assert.match(share, /expires_at > \?/);
  assert.match(share, /request\.method !== "GET" && request\.method !== "HEAD"/);
  assert.match(share, /x-robots-tag/);
  assert.match(share, /frame-ancestors 'none'/);
});

test("Access 白名單與 JWT 簽章驗證程式已接到私人 Worker", async () => {
  const [worker, auth] = await Promise.all([read("../fieldlog/src/worker.js"), read("../fieldlog/src/lib/access-auth.js")]);
  assert.match(worker, /verifyAccessRequest/);
  assert.match(auth, /ACCESS_ALLOWED_EMAILS/);
  assert.match(auth, /RSASSA-PKCS1-v1_5/);
  assert.match(auth, /payload\.iss/);
  assert.match(auth, /audiences\.includes\(audience\)/);
});
