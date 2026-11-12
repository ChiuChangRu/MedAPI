/**
 * v250 MyLab／藥品櫃：到期狀態、清冊 CRUD 與修改紀錄、COA、AI 只能讀。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { cleanLabInput, diffReagent, labSummary, nextReagentCode, reagentStatus, taipeiToday } from "../fieldlog/src/lib/lab.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

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

function r2() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) { store.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType }); },
    async get(key) { const v = store.get(key); return v ? { body: v.bytes, httpMetadata: { contentType: v.type } } : null; },
    async delete(key) { store.delete(key); },
  };
}

async function call(env, path, { method = "GET", body, raw, headers = {}, host = "mywiki.example.dev" } = {}) {
  const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
    method, headers: { "x-pin": "1234", ...(raw ? {} : { "content-type": "application/json" }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), { FIELD_PIN: "1234", ...env });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
}

test("reagentStatus：取最早的期限；90 天內＝即將到期；只有年月時月底才算過期；沒有日期＝期限待確認", () => {
  const today = "2026-11-12";
  assert.equal(reagentStatus({ expiry_date: "2026-12-06", remaining_qty: 5, location: "A" }, { today }).state, "soon", "CH-006 二水合氯化鈣");
  assert.equal(reagentStatus({ expiry_date: "2031-07-13", remaining_qty: 5, location: "A" }, { today }).state, "ok");
  assert.equal(reagentStatus({ retest_date: "2026-11-11" }, { today }).text, "已過複驗日");
  assert.equal(reagentStatus({ expiry_date: "2026-11-11" }, { today }).text, "已過期");
  const month = reagentStatus({ retest_month: "2026-11" }, { today });
  assert.equal(month.state, "soon", "本月還沒過完，不算過期，但已在提醒期");
  assert.equal(month.deadline.display, "2026-11");
  assert.equal(reagentStatus({ retest_month: "2029-02" }, { today }).text, "期限內（僅載年月）");
  const unknown = reagentStatus({ released_date: "2024-11-05" }, { today });
  assert.equal(unknown.state, "unknown");
  assert.deepEqual(unknown.flags, ["待盤點", "位置待補"]);
  assert.equal(reagentStatus({ expiry_date: "2032-01-01", retest_date: "2026-12-01", remaining_qty: 1, location: "A" }, { today }).deadline.kind, "retest", "兩個都有時取較早的");
  assert.equal(reagentStatus({ expiry_date: "2027-01-20" }, { today, warnDays: 30 }).state, "ok", "提醒天數可調");
  assert.match(taipeiToday(Date.parse("2026-11-12T17:00:00Z")), /2026-11-13/, "台北時間");
});

test("cleanLabInput：「待確認」存成空值、日期與數字驗證、單位白名單；編號與差異", () => {
  const { values, errors } = cleanLabInput({ brand: "待確認", cas: " 7647-14-5 ", remaining_qty: "1,250.5", expiry_date: "2031/7/13", retest_month: "2029-2", unit: "mL" });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { cas: "7647-14-5", brand: null, remaining_qty: 1250.5, unit: "mL", expiry_date: "2031-07-13", retest_month: "2029-02" });
  assert.equal(cleanLabInput({ expiry_date: "2026-02-30" }).errors.length, 1);
  assert.equal(cleanLabInput({ remaining_qty: "-1" }).errors.length, 1);
  assert.equal(cleanLabInput({ unit: "桶" }).errors.length, 1);
  assert.equal(nextReagentCode(["CH-001", "CH-013", "X"]), "CH-014");
  assert.equal(nextReagentCode([]), "CH-001");
  assert.deepEqual(diffReagent({ remaining_qty: null, location: "A" }, { remaining_qty: 3, location: "A" }), { remaining_qty: [null, 3] });
  assert.equal(labSummary([{ expiry_date: "2026-12-06" }, {}], { today: "2026-11-12" }).need_inventory, 2);
});

test("API：新增（自動編號）→ 盤點（留紀錄）→ 列表含狀態與摘要 → 軟刪除", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  const created = await call(env, "/lab/reagents", { method: "POST", body: { name_zh: "二水合氯化鈣", cas: "10035-04-8", expiry_date: "2026-12-06", brand: "待確認" } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.reagent.code, "CH-001");
  assert.equal(created.body.reagent.brand, null);
  assert.equal(created.body.reagent.unit, "g");
  const id = created.body.reagent.id;
  assert.equal((await call(env, "/lab/reagents", { method: "POST", body: { code: "CH-001", name_zh: "重複" } })).status, 409);
  assert.equal((await call(env, "/lab/reagents", { method: "POST", body: { cas: "1" } })).status, 400, "名稱必填");
  const inv = await call(env, `/lab/reagents/${id}`, { method: "PUT", body: { remaining_qty: "420", location: "B 櫃第 2 層", log_note: "11/20 盤點" } });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.reagent.remaining_qty, 420);
  const same = await call(env, `/lab/reagents/${id}`, { method: "PUT", body: { remaining_qty: 420 } });
  assert.equal(same.body.unchanged, true, "沒變就不留紀錄");
  const log = await call(env, `/lab/reagents/${id}/log`);
  assert.deepEqual(log.body.log.map((l) => l.action), ["inventory", "create"]);
  assert.deepEqual(log.body.log[0].changes.remaining_qty, [null, 420]);
  assert.equal(log.body.log[0].note, "11/20 盤點");
  const list = await call(env, "/lab/reagents");
  assert.equal(list.body.warn_days, 90);
  assert.equal(list.body.reagents[0].status.deadline.kind, "expiry");
  assert.equal(list.body.summary.total, 1);
  assert.equal((await call(env, "/lab/settings", { method: "PUT", body: { warn_days: 7 } })).body.warn_days, 7);
  assert.equal((await call(env, "/lab/reagents")).body.warn_days, 7);
  assert.equal((await call(env, `/lab/reagents/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(env, "/lab/reagents")).body.reagents.length, 0);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM lab_reagents").get().n, 1, "軟刪除，資料還在");
});

test("COA：上傳、下載、更換時刪掉舊檔；AI（MCP）只能讀不能改", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1(), FILES: r2() };
  const id = (await call(env, "/lab/reagents", { method: "POST", body: { name_zh: "尿素" } })).body.reagent.id;
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
  const up = await call(env, `/lab/reagents/${id}/coa`, { method: "POST", raw: pdf, headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent("尿素 COA.pdf") } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual(up.body.reagent.coa, { filename: "尿素 COA.pdf", size: 8 });
  assert.equal(up.body.reagent.coa_key, undefined, "不外露儲存位置");
  const down = await call(env, `/lab/reagents/${id}/coa`);
  assert.equal(down.headers.get("content-type"), "application/pdf");
  assert.deepEqual([...down.body], [...pdf]);
  await call(env, `/lab/reagents/${id}/coa`, { method: "POST", raw: new Uint8Array([9]), headers: { "content-type": "application/pdf", "x-filename": "v2.pdf" } });
  assert.equal(env.FILES.store.size, 1, "舊 COA 已刪除");
  const ai = "fieldlog.internal";
  assert.equal((await call(env, "/lab/reagents", { host: ai })).status, 200, "AI 可以讀");
  assert.equal((await call(env, "/lab/reagents", { method: "POST", body: { name_zh: "x" }, host: ai })).status, 403);
  assert.equal((await call(env, `/lab/reagents/${id}`, { method: "PUT", body: { remaining_qty: 1 }, host: ai })).status, 403);
  assert.equal((await call(env, `/lab/reagents/${id}`, { method: "DELETE", host: ai })).status, 403);
});

test("前端：側欄 MyLab／藥品櫃、首頁提醒卡、藥品櫃視窗", async () => {
  const [html, lab, sw] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/lab.js"), read("../fieldlog/public/sw.js")]);
  assert.match(html, /<p class="desktop-side-heading">MyLab<\/p>/);
  assert.match(html, /id="desktop-lab-reagents"/);
  // v252：MyLab 放在左欄最下面（在 spacer 之後），不要太顯眼
  assert.ok(html.indexOf('class="desktop-nav-spacer"') < html.indexOf('class="desktop-mylab"'), "MyLab 在左欄最下面");
  assert.ok(html.indexOf('id="desktop-new-folder"') < html.indexOf('class="desktop-mylab"'));
  assert.match(html, /id="lab-home"/);
  assert.match(html, /id="lab-overlay"/);
  assert.match(lab, /\/lab\/reagents/);
  assert.match(lab, /\/coa`/);
  assert.match(sw, /lab\.js\?v=/);
});

test("v251 批次上傳 COA：依「資料來源：PDF 第 N 頁」拆頁對應，超出頁數或沒寫頁碼的不處理", async () => {
  const lab = await read("../fieldlog/public/lab.js");
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="lab-bulk-coa-file"[^>]*accept="application\/pdf"/);
  const fnSrc = lab.match(/function coaPageMap\(reagents, pageCount\) \{[\s\S]*?\n  \}\n/)[0];
  const coaPageMap = new Function(`${fnSrc}; return coaPageMap;`)();
  const { mapped, unmatched } = coaPageMap([
    { code: "CH-001", source: "PDF 第1頁" }, { code: "CH-012", source: "PDF 第12頁" },
    { code: "CH-013", source: "使用者補充（2026/11/12）" }, { code: "CH-020", source: "PDF 第 20 頁" },
  ], 12);
  assert.deepEqual(mapped.map((m) => [m.reagent.code, m.page]), [["CH-001", 1], ["CH-012", 12]]);
  assert.deepEqual(unmatched.map((r) => r.code), ["CH-013", "CH-020"]);
  assert.match(lab, /copyPages\(source, \[page - 1\]\)/, "每份只拷貝一頁");
  assert.match(lab, /confirm\(msg\)/, "上傳前先列出對應讓使用者確認");
});
