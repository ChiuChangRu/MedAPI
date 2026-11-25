/**
 * v258 藥品櫃「用於實驗」標註，以及藥品櫃／儀器設備的 Excel 下載與分享。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { cleanLabInput, splitTags } from "../fieldlog/src/lib/lab.js";

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
async function call(env, method, path, body = null, host = "mywiki.example.dev") {
  const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
    method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }), { FIELD_PIN: "1234", ...env });
  return { status: res.status, body: await res.json() };
}
async function loadExport() {
  const sandbox = { globalThis: {}, File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts?.type; } }, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await read("../fieldlog/public/lab-export.js"), sandbox);
  return { LabExport: sandbox.LabExport, sandbox };
}

test("標籤清理：「、」「,」「;」換行都能分；去空白去重（不分大小寫）；最多 12 個；空值存成空", () => {
  assert.deepEqual(splitTags(" 抗結痂－人工尿液、 抗結痂－人工尿液 ,HPLC;\n黏度測試 "), ["抗結痂－人工尿液", "HPLC", "黏度測試"]);
  assert.deepEqual(splitTags("hplc、HPLC、Hplc"), ["hplc"]);
  assert.deepEqual(splitTags(null), []);
  assert.deepEqual(cleanLabInput({ used_in: "抗結痂－人工尿液, 塗層試驗" }).values, { used_in: "抗結痂－人工尿液、塗層試驗" });
  assert.deepEqual(cleanLabInput({ used_in: "  " }).values, { used_in: null });
  const many = Array.from({ length: 20 }, (_, i) => `實驗${i}`).join("、");
  assert.equal(cleanLabInput({ used_in: many }).values.used_in.split("、").length, 12);
});

test("API：新增／修改「用於實驗」並留紀錄；讀回來是整理過的格式；AI 可讀不可寫", async () => {
  resetSchemaCacheForTests();
  const db = d1(); const env = { DB: db };
  const a = await call(env, "POST", "/lab/reagents", { name_zh: "氯化鈉", name_en: "Sodium chloride", used_in: "抗結痂－人工尿液 , 抗結痂－人工尿液" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.reagent.used_in, "抗結痂－人工尿液");
  const id = a.body.reagent.id;
  const b = await call(env, "PUT", `/lab/reagents/${id}`, { used_in: "抗結痂－人工尿液、塗層浸泡試驗", log_note: "補用途" });
  assert.equal(b.body.reagent.used_in, "抗結痂－人工尿液、塗層浸泡試驗");
  const log = await call(env, "GET", `/lab/reagents/${id}/log`);
  assert.deepEqual(log.body.log[0].changes.used_in, ["抗結痂－人工尿液", "抗結痂－人工尿液、塗層浸泡試驗"]);
  assert.equal(log.body.log[0].note, "補用途");
  assert.equal((await call(env, "GET", "/lab/reagents", null, "fieldlog.internal")).body.reagents[0].used_in, "抗結痂－人工尿液、塗層浸泡試驗", "AI 讀得到用途");
  assert.equal((await call(env, "PUT", `/lab/reagents/${id}`, { used_in: "x" }, "fieldlog.internal")).status, 403);
});

test("匯出內容：藥品與儀器的欄位、日期狀態文字、用於實驗；篩選條件寫進第二張表與檔名", async () => {
  const { LabExport } = await loadExport();
  const rows = LabExport.reagentRows([
    { code: "CH-001", name_zh: "氯化鎂", remaining_qty: 120.5, unit: "g", used_in: "抗結痂－人工尿液", location: null, status: { text: "30 天後到期", deadline: { label: "有效期限", display: "2026-12-25" } } },
    { code: "CH-002", name_zh: "氯化鈉", remaining_qty: null, unit: "g", used_in: null, status: { text: "期限待確認", deadline: null } },
  ]);
  assert.equal(rows[0].length, 25);
  assert.equal(rows[0][22], "用於實驗");
  assert.equal(rows[1][0], "CH-001");
  assert.equal(rows[1][12], 120.5, "數字維持數字，Excel 才能計算");
  assert.equal(rows[1][21], "30 天後到期 （有效期限 2026-12-25）");
  assert.equal(rows[1][22], "抗結痂－人工尿液");
  assert.equal(rows[2][12], "", "待盤點是空白，不是 0");
  assert.equal(rows[2][21], "期限待確認");
  const inst = LabExport.instrumentRows([
    { code: "EQ-001", name_zh: "流量計", calibration_required: 1, calibration_cycle_months: 12, status: { text: "已逾校正日 3 天", due: { date: "2026-11-20", derived: true } } },
    { code: "EQ-002", name_zh: "工作台", calibration_required: 0, status: { text: "不需校正", due: null } },
  ]);
  assert.equal(inst[1][LabExport.INSTRUMENT_COLUMNS.findIndex(([k]) => k === "__due")], "2026-11-20（由上次＋週期推算）");
  assert.equal(inst[1][LabExport.INSTRUMENT_COLUMNS.findIndex(([k]) => k === "__required")], "是");
  assert.equal(inst[2][LabExport.INSTRUMENT_COLUMNS.findIndex(([k]) => k === "__required")], "否");
  const info = LabExport.infoRows({ title: "MyLab｜藥品櫃", count: 3, total: 14, filterLabel: "即將到期＋抗結痂－人工尿液", query: "", today: "2026-11-25" });
  assert.deepEqual(JSON.parse(JSON.stringify(info.find((r) => r[0] === "匯出筆數"))), ["匯出筆數", "3／全部 14"]);
  assert.deepEqual(JSON.parse(JSON.stringify(info.find((r) => r[0] === "篩選"))), ["篩選", "即將到期＋抗結痂－人工尿液"]);
  assert.equal(LabExport.fileName("藥品櫃", "2026-11-25", "全部", "xlsx"), "藥品櫃_2026-11-25.xlsx");
  assert.equal(LabExport.fileName("藥品櫃", "2026-11-25", "需注意＋a/b", "xlsx"), "藥品櫃_2026-11-25_需注意＋a_b.xlsx", "檔名裡的非法字元被換掉");
});

test("沒有 SheetJS 時退成 CSV：UTF-8 含 BOM，逗號、引號、換行都正確跳脫", async () => {
  const { LabExport } = await loadExport();
  const csv = LabExport.toCsv([["編號", "備註"], ["CH-001", 'a,b "c"\n第二行']]);
  assert.ok(csv.startsWith("﻿"));
  assert.equal(csv.slice(1), '編號,備註\r\nCH-001,"a,b ""c""\n第二行"');
  const file = LabExport.buildFile({ title: "藥品櫃", sheetName: "藥品櫃", rows: [["a"]], info: [["b"]], today: "2026-11-25", filterLabel: "全部" });
  assert.equal(file.name, "藥品櫃_2026-11-25.csv");
});

test("前端：兩個清冊都有「⬇ Excel」與「分享」；藥品櫃有用途欄位與篩選；匯出模組在 lab.js 之前載入；版本一致", async () => {
  const html = await read("../fieldlog/public/index.html");
  const lab = await read("../fieldlog/public/lab.js");
  const inst = await read("../fieldlog/public/instruments.js");
  const worker = await read("../fieldlog/src/worker.js");
  const app = await read("../fieldlog/public/app.js");
  const sw = await read("../fieldlog/public/sw.js");
  for (const id of ["lab-export", "lab-share", "inst-export", "inst-share", "lab-exp", "lab-exp-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<script src="lab-export\.js\?v=\d+"><\/script>\s*<script src="lab\.js/);
  assert.match(lab, /\$\("lab-export"\)\.onclick = \(\) => exportExcel\("download"\)/);
  assert.match(lab, /state\.exp === "__none"/);
  assert.match(lab, /tagsOf\(r\)\.map\(\(t\) => `<span class="lab-tag">/);
  assert.match(inst, /\$\("inst-share"\)\.onclick = \(\) => exportExcel\("share"\)/);
  assert.match(lab, /state\.data\.reagents\.filter\(matches\)/, "匯出的是畫面上顯示中的項目");
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 258);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
  assert.match(sw, /"lab-export\.js\?v=\d+"/);
});
