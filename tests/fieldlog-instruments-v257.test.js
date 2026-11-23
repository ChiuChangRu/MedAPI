/**
 * v257 MyLab／儀器設備：清冊、校正期限燈號、修改紀錄、校正證書；AI 只能讀。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  addMonths, calibrationDue, cleanInstrumentInput, diffInstrument, instrumentStatus, instrumentSummary, nextInstrumentCode,
} from "../fieldlog/src/lib/lab-instruments.js";

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
function fakeR2() {
  const store = new Map();
  return { store, async put(key, bytes, opts) { store.set(key, { bytes, opts }); }, async get(key) { const o = store.get(key); return o ? { body: o.bytes } : null; }, async delete(key) { store.delete(key); } };
}
async function call(env, method, path, body = null, { host = "mywiki.example.dev", headers = {} } = {}) {
  const isBin = body instanceof Uint8Array;
  const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
    method, headers: { "x-pin": "1234", ...(isBin ? {} : { "content-type": "application/json" }), ...headers }, body: body ? (isBin ? body : JSON.stringify(body)) : undefined,
  }), { FIELD_PIN: "1234", ...env });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.arrayBuffer() };
}

const TODAY = "2026-11-23";

test("日期加月：月底往前收、跨年", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-23", 12), "2027-11-23");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29", "閏年");
  assert.equal(addMonths("壞日期", 1), null);
});

test("校正期限與燈號：用下次校正日；沒填就由上次＋週期推算；停用、維修中、不需校正不提醒", () => {
  const opts = { today: TODAY, warnDays: 30 };
  assert.deepEqual(calibrationDue({ next_calibration_date: "2027-01-01", last_calibrated_date: "2026-01-01", calibration_cycle_months: 12 }), { date: "2027-01-01", derived: false }, "手填的優先");
  assert.deepEqual(calibrationDue({ last_calibrated_date: "2025-11-20", calibration_cycle_months: 12 }), { date: "2026-11-20", derived: true });
  assert.equal(calibrationDue({ last_calibrated_date: "2025-11-20" }), null, "沒有週期就推算不出來");
  const st = (row) => instrumentStatus({ location: "A1", ...row }, opts);
  assert.equal(st({ next_calibration_date: "2026-11-20" }).state, "expired");
  assert.equal(st({ next_calibration_date: "2026-11-20" }).text, "已逾校正日 3 天");
  assert.equal(st({ next_calibration_date: "2026-12-10" }).state, "soon");
  assert.equal(st({ next_calibration_date: "2026-12-10" }).text, "17 天後須校正");
  assert.equal(st({ next_calibration_date: "2026-11-23" }).text, "今天須校正");
  assert.equal(st({ next_calibration_date: "2027-03-01" }).state, "ok");
  assert.equal(st({}).state, "unknown");
  assert.equal(st({ calibration_required: 0 }).state, "na");
  assert.equal(st({ use_status: "維修中", next_calibration_date: "2020-01-01" }).state, "repair", "維修中不算逾期");
  assert.equal(st({ use_status: "停用", next_calibration_date: "2020-01-01" }).state, "inactive");
  assert.equal(st({ use_status: "報廢" }).text, "已報廢");
  assert.deepEqual(instrumentStatus({ next_calibration_date: "2027-03-01" }, opts).flags, ["位置待補"]);
  const sum = instrumentSummary([
    { location: "a", next_calibration_date: "2026-11-01" }, { location: "a", next_calibration_date: "2026-12-01" },
    { location: "a", calibration_required: 0 }, { use_status: "停用" }, {},
  ], opts);
  assert.deepEqual({ total: sum.total, expired: sum.expired, soon: sum.soon, na: sum.na, inactive: sum.inactive, unknown: sum.unknown, need_location: sum.need_location }, { total: 5, expired: 1, soon: 1, na: 1, inactive: 1, unknown: 1, need_location: 2 });
});

test("輸入清理：待確認存成空值；日期、週期、類別、狀態都驗證；編號與差異", () => {
  const { values, errors } = cleanInstrumentInput({ name_zh: " 黏度計 ", brand: "待確認", serial_no: "", last_calibrated_date: "2026/6/1", calibration_cycle_months: "12", category: "量測", use_status: "", calibration_required: "否" });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { name_zh: "黏度計", brand: null, serial_no: null, last_calibrated_date: "2026-06-01", calibration_cycle_months: 12, category: "量測", use_status: "使用中", calibration_required: 0 });
  for (const bad of [{ last_calibrated_date: "2026-13-40" }, { calibration_cycle_months: "0" }, { calibration_cycle_months: "1.5" }, { category: "亂寫" }, { use_status: "亂寫" }, { calibration_required: "也許" }, { nope: "x" }]) {
    const r = cleanInstrumentInput(bad);
    if ("nope" in bad) assert.deepEqual(r.values, {}, "未知欄位被忽略");
    else assert.equal(r.errors.length, 1, JSON.stringify(bad));
  }
  assert.equal(nextInstrumentCode(["EQ-001", "EQ-009", "EQ-x", "CH-050"]), "EQ-010");
  assert.equal(nextInstrumentCode([]), "EQ-001");
  assert.deepEqual(diffInstrument({ location: "A", brand: "B" }, { location: "A", brand: "C" }), { brand: ["B", "C"] });
});

test("API：新增（自動編號）、重複編號 409、修改留紀錄、只改校正記為「校正」、軟刪除、證書上傳與取回", async () => {
  resetSchemaCacheForTests();
  const db = d1(); const FILES = fakeR2();
  const env = { DB: db, FILES };
  const a = await call(env, "POST", "/lab/instruments", { name_zh: "黏度計", name_en: "Brookfield DV2T", brand: "Brookfield", model: "DV2T", location: "實驗室 A", last_calibrated_date: "2026-06-01", calibration_cycle_months: 12 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.instrument.code, "EQ-001");
  assert.equal(a.body.instrument.use_status, "使用中");
  assert.equal(a.body.instrument.calibration_required, 1, "預設需要校正");
  assert.equal(a.body.instrument.status.due.date, "2027-06-01", "上次＋週期推算");
  const b = await call(env, "POST", "/lab/instruments", { name_zh: "流量計" });
  assert.equal(b.body.instrument.code, "EQ-002");
  assert.equal((await call(env, "POST", "/lab/instruments", { name_zh: "x", code: "eq-001" })).status, 409);
  assert.equal((await call(env, "POST", "/lab/instruments", { brand: "只有品牌" })).status, 400, "名稱至少填一個");

  const id = a.body.instrument.id;
  const cal = await call(env, "PUT", `/lab/instruments/${id}`, { last_calibrated_date: "2026-11-20", calibration_vendor: "校正實驗室", log_note: "送校回來" });
  assert.equal(cal.status, 200);
  assert.equal(cal.body.instrument.status.due.date, "2027-11-20");
  const upd = await call(env, "PUT", `/lab/instruments/${id}`, { location: "實驗室 B" });
  assert.equal(upd.body.instrument.location, "實驗室 B");
  assert.equal((await call(env, "PUT", `/lab/instruments/${id}`, { location: "實驗室 B" })).body.unchanged, true);
  const log = await call(env, "GET", `/lab/instruments/${id}/log`);
  assert.deepEqual(log.body.log.map((l) => l.action), ["update", "calibration", "create"]);
  assert.equal(log.body.log[1].note, "送校回來");

  const cert = new TextEncoder().encode("%PDF-1.4 fake");
  const up = await call(env, "POST", `/lab/instruments/${id}/cert`, cert, { headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent("DV2T 校正證書.pdf") } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.instrument.cert.filename, "DV2T 校正證書.pdf");
  assert.equal(up.body.instrument.cert_key, undefined, "不把 R2 路徑給前端");
  const got = await call(env, "GET", `/lab/instruments/${id}/cert`);
  assert.equal(got.status, 200);
  const up2 = await call(env, "POST", `/lab/instruments/${id}/cert`, cert, { headers: { "content-type": "application/pdf", "x-filename": "new.pdf" } });
  assert.equal(up2.status, 200);
  assert.equal(FILES.store.size, 1, "更換證書時舊檔被刪掉");

  const list = await call(env, "GET", "/lab/instruments");
  assert.equal(list.body.instruments.length, 2);
  assert.equal(list.body.summary.total, 2);
  assert.equal(list.body.warn_days, 30);
  const del = await call(env, "DELETE", `/lab/instruments/${b.body.instrument.id}`);
  assert.equal(del.status, 200);
  assert.equal((await call(env, "GET", "/lab/instruments")).body.instruments.length, 1);
  assert.equal((await call(env, "PUT", `/lab/instruments/${b.body.instrument.id}`, { location: "x" })).status, 404, "已刪除的不能改");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM lab_instrument_log WHERE instrument_id = ?").get(b.body.instrument.id).n, 2, "刪除也留紀錄");
});

test("提醒天數可調；AI（MCP）只能讀、不能新增或修改；藥品櫃不受影響", async () => {
  resetSchemaCacheForTests();
  const db = d1(); const env = { DB: db, FILES: fakeR2() };
  await call(env, "POST", "/lab/instruments", { name_zh: "天平", next_calibration_date: "2026-12-31" });
  assert.equal((await call(env, "GET", "/lab/instruments")).body.instruments[0].status.state, "ok", "40 天後、預設提醒 30 天");
  assert.equal((await call(env, "PUT", "/lab/instruments/settings", { warn_days: 60 })).status, 200);
  assert.equal((await call(env, "GET", "/lab/instruments")).body.instruments[0].status.state, "soon");
  assert.equal((await call(env, "PUT", "/lab/instruments/settings", { warn_days: 0 })).status, 400);
  const mcp = { host: "fieldlog.internal" };
  assert.equal((await call(env, "GET", "/lab/instruments", null, mcp)).status, 200, "AI 可以讀");
  assert.equal((await call(env, "POST", "/lab/instruments", { name_zh: "x" }, mcp)).status, 403);
  assert.equal((await call(env, "PUT", "/lab/instruments/1", { location: "x" }, mcp)).status, 403);
  assert.equal((await call(env, "DELETE", "/lab/instruments/1", null, mcp)).status, 403);
  assert.equal((await call(env, "PUT", "/lab/instruments/settings", { warn_days: 10 }, mcp)).status, 403);
  assert.equal((await call(env, "GET", "/lab/reagents")).status, 200, "藥品櫃照常");
});

test("前端：左欄藥品櫃下面有「儀器設備」；首頁有校正提醒；視窗與版本", async () => {
  const html = await read("../fieldlog/public/index.html");
  const js = await read("../fieldlog/public/instruments.js");
  const lab = await read("../fieldlog/public/lab.js");
  const worker = await read("../fieldlog/src/worker.js");
  const app = await read("../fieldlog/public/app.js");
  const sw = await read("../fieldlog/public/sw.js");
  const reagents = html.indexOf('id="desktop-lab-reagents"'), instruments = html.indexOf('id="desktop-lab-instruments"');
  assert.ok(reagents > 0 && instruments > reagents, "儀器設備在藥品櫃下面");
  assert.match(html, /<span>儀器設備<\/span><span class="lab-side-badge" id="inst-alert-badge" hidden>/);
  assert.match(html, /id="inst-overlay"/);
  assert.match(html, /id="inst-home" hidden/);
  assert.match(html, /<script src="instruments\.js\?v=\d+"><\/script>/);
  assert.match(js, /window\.openInstruments = openInstruments/);
  assert.match(js, /window\.loadInstrumentsHome = loadInstrumentsHome/);
  assert.match(lab, /window\.loadInstrumentsHome\?\.\(\)/, "首頁載入藥品櫃提醒時一併載入儀器");
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 257);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
  assert.match(sw, /"instruments\.js\?v=\d+"/);
  assert.doesNotMatch(html, new RegExp(`\\?v=${Number(version) - 1}"`));
});
