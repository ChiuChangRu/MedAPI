/**
 * GET /api/usage 的「查詢時間」vs「帳單資料本身是哪天的」。
 *
 * 之前只有 AI 那一項算了 dataLagDays，其他六項（D1／R2／Workers）完全沒算，
 * 而且面板最下面只印「更新：<剛剛的時間>」，把「Worker 剛問完 Cloudflare」跟
 * 「帳單資料本身是哪天的」混成一句話——這正是使用者會誤會「剛更新＝資料最新」
 * 的原因。這裡鎖住：全部項目都要有落後天數，且回應要有一個獨立的
 * billingDataDate／billingDataLagDays 給前端做總覽用。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeEmptyDB() {
  const none = { results: [] };
  const stmt = () => ({
    bind: () => stmt(),
    async all() { return none; },
    async first() { return null; },
    async run() { return { meta: { last_row_id: 1, changes: 0 } }; },
  });
  return { async batch(list) { return Promise.all(list.map((s) => s.run())); }, prepare: () => stmt() };
}

// 模擬 Cloudflare billable/usage 回應：D1 讀取列數是兩天前的資料，
// AI Neurons 是一天前的資料——刻意讓兩者不同，才驗得出「各項分開算」。
function billableResponse(today) {
  const twoDaysAgo = new Date(new Date(today).getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const oneDayAgo = new Date(new Date(today).getTime() - 1 * 86400000).toISOString().slice(0, 10);
  return {
    success: true,
    result: [
      {
        x_ProductFamilyName: "D1", x_BillableMetricName: "Rows Read",
        ConsumedQuantity: 3_000_000_000, ConsumedUnit: "rows",
        EffectiveCost: 0, BillingCurrency: "USD",
        ChargePeriodStart: `${twoDaysAgo}T00:00:00Z`,
      },
      {
        x_ProductFamilyName: "Workers AI", x_BillableMetricName: "Neurons",
        ConsumedQuantity: 500, ConsumedUnit: "neurons",
        EffectiveCost: 0.02, BillingCurrency: "USD",
        ChargePeriodStart: `${oneDayAgo}T00:00:00Z`,
      },
    ],
  };
}

async function callUsage(env) {
  const req = new Request("https://x/api/usage", { headers: { "x-pin": "pin" } });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

test("每個項目都各自算落後天數，不是只有 AI 有", async () => {
  resetSchemaCacheForTests();
  const today = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async () => ({ ok: true, json: async () => billableResponse(today) });
  const env = { FIELD_PIN: "pin", DB: makeEmptyDB(), CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok" };

  const { status, data } = await callUsage(env);
  assert.equal(status, 200);

  const d1 = data.limits.find((item) => item.key === "d1-read");
  const ai = data.limits.find((item) => item.key === "ai");
  assert.ok(d1, "D1 讀取列數要出現在 limits 裡");
  assert.equal(d1.dataLagDays, 2, "D1 的資料是兩天前的，落後天數要是 2");
  assert.equal(ai.dataLagDays, 1, "AI 的資料是一天前的，落後天數要是 1");
});

test("回應要有獨立的 billingDataDate／billingDataLagDays 給前端做總覽", async () => {
  resetSchemaCacheForTests();
  const today = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async () => ({ ok: true, json: async () => billableResponse(today) });
  const env = { FIELD_PIN: "pin", DB: makeEmptyDB(), CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok" };

  const { data } = await callUsage(env);
  const oneDayAgo = new Date(new Date(today).getTime() - 1 * 86400000).toISOString().slice(0, 10);
  assert.equal(data.billingDataDate, oneDayAgo, "整批資料裡最新的一天（AI 那筆）");
  assert.equal(data.billingDataLagDays, 1);
  assert.ok(data.updatedAt, "查詢時間（Worker 執行當下）要單獨存在，不跟帳單日期混在同一個欄位");
  assert.notEqual(data.updatedAt.slice(0, 10), data.billingDataDate, "這個情境下查詢時間跟帳單日期本來就該是不同的兩天");
});

test("完全查不到日期時（例如帳單 API 回空清單）落後天數是 null，不是誤導成 0", async () => {
  resetSchemaCacheForTests();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  const env = { FIELD_PIN: "pin", DB: makeEmptyDB(), CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok" };

  const { data } = await callUsage(env);
  assert.equal(data.billingDataDate, "");
  assert.equal(data.billingDataLagDays, null);
  const ai = data.limits.find((item) => item.key === "ai");
  assert.equal(ai.dataLagDays, null);
});
