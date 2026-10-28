// PDCA 網頁的 StepFun 轉送：只接受 GitHub Pages 的 Origin、目的地寫死、key 只轉送。
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

const ORIGIN = "https://chiuchangru.github.io";
const call = (path, init = {}) => worker.fetch(new Request(`https://x${path}`, init), {});

test("預檢：允許的 Origin 回 204 與 CORS header；其他 Origin 拒絕", async () => {
  const ok = await call("/relay/stepfun/v1/chat/completions", { method: "OPTIONS", headers: { origin: ORIGIN } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(ok.headers.get("access-control-allow-headers"), /authorization/);
  const bad = await call("/relay/stepfun/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("POST：原樣轉給 StepFun，回應補 CORS；沒有 key 不轉", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, auth: init.headers.authorization, body: new TextDecoder().decode(init.body) }); return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); };
  try {
    const res = await call("/relay/stepfun-cn/v1/chat/completions", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer sk-x", "content-type": "application/json" }, body: '{"model":"step-3.5-flash"}' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(seen, [{ url: "https://api.stepfun.com/v1/chat/completions", auth: "Bearer sk-x", body: '{"model":"step-3.5-flash"}' }]);
    const noKey = await call("/relay/stepfun/v1/chat/completions", { method: "POST", headers: { origin: ORIGIN }, body: "{}" });
    assert.equal(noKey.status, 401);
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("只有寫死的兩個路徑會轉送", async () => {
  const res = await call("/relay/other/v1/chat/completions", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer x" } });
  assert.equal(res.status, 404);
});
