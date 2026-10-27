// PDCA品質輔助系統匿名使用紀錄：POST /pdca/hit 只收白名單事件與短字串，
// 來源只留網域；pdca_usage_stats 在沒綁庫或沒資料時誠實說明。
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";
import { PDCA_TOOL } from "../mcp/src/pdca.js";

function fakeDB() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return { bind: (...p) => ({ run: async () => { if (/^INSERT/.test(sql)) rows.push(p); return {}; }, all: async () => ({ results: [] }) }) };
    },
  };
}
const hit = (env, body, method = "POST") => worker.fetch(new Request("https://x/pdca/hit", { method, headers: { "content-type": "text/plain" }, body: method === "POST" ? body : undefined }), env);

test("/pdca/hit：合法事件寫入一列，來源只留網域、不留查詢字串", async () => {
  const db = fakeDB();
  const res = await hit({ DB_PDCA: db }, JSON.stringify({ ev: "open", sid: "abc", host: "chiuchangru.github.io", ref: "https://www.google.com/search?q=secret", src: "訓練課", dev: "m" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(db.rows.length, 1);
  const r = db.rows[0];
  assert.equal(r[2], "open");
  assert.equal(r[7], "www.google.com");
  assert.equal(r[8], "訓練課");
  assert.equal(r[10], "m");
});

test("/pdca/hit：未知事件、過大內容、壞 JSON 都拒絕且不寫入", async () => {
  const db = fakeDB();
  assert.equal((await hit({ DB_PDCA: db }, JSON.stringify({ ev: "case_data", x: 1 }))).status, 400);
  assert.equal((await hit({ DB_PDCA: db }, "x".repeat(3000))).status, 413);
  assert.equal((await hit({ DB_PDCA: db }, "{")).status, 400);
  assert.equal((await hit({ DB_PDCA: db }, "", "GET")).status, 405);
  assert.equal(db.rows.length, 0);
});

test("/pdca/hit：CORS 預檢放行", async () => {
  const res = await worker.fetch(new Request("https://x/pdca/hit", { method: "OPTIONS" }), {});
  assert.equal(res.status, 204);
});

test("pdca_usage_stats：沒綁庫或沒資料時講清楚", async () => {
  assert.match(await PDCA_TOOL.handler({}, {}), /DB_PDCA/);
  assert.match(await PDCA_TOOL.handler({ DB_PDCA: fakeDB() }, { days: 7 }), /最近 7 天沒有/);
});
