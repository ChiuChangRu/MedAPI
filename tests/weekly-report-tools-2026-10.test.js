/**
 * 2026-10 週報流程改版：
 *   1. create_weekly_report：依日期／週次建立固定格式週報，同一週重複呼叫回傳既有那份。
 *   2. get_weekly_report：用週次讀週報，並附上一週內容方便比對。
 *   3. update_weekly_report：可用 week 指定；覆寫前先存版本（entry_versions）。
 *   4. 前台「本週周報」與工作週報資料夾裡的「新紀錄」走同一套 lib/weekly-report.js。
 *   5. append_daily_log：每天附加到當週週報的「每日紀錄」，同一段不會重複附加。
 *
 * 全部用真實 SQLite（node:sqlite）跑 SCHEMA／MIGRATIONS，經由 MCP 與 fieldlog 的
 * 實際 fetch 入口呼叫，不是只測函式。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import mcpWorker from "../mcp/src/worker.js";
import fieldlogWorker from "../fieldlog/src/worker.js";
import { MIGRATIONS, SCHEMA, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  appendToDailyLog, getOrCreateWeeklyReport, isoWeekFromDate, isoWeekFromKey, previousReportWeek,
  resolveReportWeek, taipeiIsoWeek, weeklyReportTitle,
} from "../fieldlog/src/lib/weekly-report.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1FromSqlite(sqlite) {
  const statement = (sql) => {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() {
        const result = sqlite.prepare(sql).run(...args);
        return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid || 0) } };
      },
    };
  };
  return {
    prepare: statement,
    async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
  };
}

function makeDb(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const sql of SCHEMA) sqlite.exec(sql);
  for (const sql of MIGRATIONS) { try { sqlite.exec(sql); } catch { /* duplicate column */ } }
  return { sqlite, db: d1FromSqlite(sqlite) };
}

async function callTool(db, name, args = {}) {
  const res = await mcpWorker.fetch(new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { MCP_PIN: "testpin", DB_FIELDLOG: db });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text || body.error?.message || "";
  if (body.result?.isError || body.error) throw new Error(text);
  return text;
}

const reports = (sqlite) => sqlite.prepare(
  "SELECT id, title, folder_id, fields_json, body FROM entries WHERE json_extract(fields_json, '$._kind') = 'weekly_report' AND COALESCE(deleted_at, '') = '' ORDER BY id"
).all().map((row) => ({ ...row, fields: JSON.parse(row.fields_json) }));

test("週次計算：日期與週次互轉、台北時區、跨年第 53 週", () => {
  const w41 = isoWeekFromDate("2026-10-06");
  assert.equal(w41.key, "2026-W41");
  assert.equal(w41.start, "2026-10-05");
  assert.equal(w41.end, "2026-10-09");
  assert.equal(weeklyReportTitle(w41), "2026-W41 工作週報（10/05–10/09）");
  assert.deepEqual(isoWeekFromKey("2026-W41").start, "2026-10-05");
  assert.equal(isoWeekFromKey("2026-w41").key, "2026-W41");
  // UTC 週日 17:00 = 台北週一 01:00，要算進新的一週
  assert.equal(taipeiIsoWeek(new Date("2026-10-04T17:00:00Z")).key, "2026-W41");
  assert.equal(isoWeekFromDate("2027-01-01").key, "2026-W53");
  assert.equal(isoWeekFromKey("2026-W53").start, "2026-12-28");
  assert.throws(() => isoWeekFromKey("2027-W53"), /沒有第 53 週/);
  assert.throws(() => isoWeekFromDate("2026-02-30"), /沒有/);
  assert.equal(previousReportWeek(isoWeekFromKey("2026-W01")).key, "2025-W52");
  assert.throws(() => resolveReportWeek({ week: "2026-W41", date: "2026-10-20" }), /不一致/);
});

test("create_weekly_report：固定格式，同一週重複呼叫回傳既有那一份", async (t) => {
  const { sqlite, db } = makeDb(t);
  const first = await callTool(db, "create_weekly_report", { date: "2026-10-06" });
  assert.match(first, /已建立 \[entry \d+\] 2026-W41 工作週報（10\/05–10\/09）/);
  const again = await callTool(db, "create_weekly_report", { week: "2026-W41" });
  assert.match(again, /沿用既有/);
  const rows = reports(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields["週次"], "2026-W41");
  assert.equal(rows[0].fields["期間"], "2026-10-05–2026-10-09");
  assert.match(rows[0].fields["中長期規劃"], /檢體針開發/);
  const folder = sqlite.prepare("SELECT name, role FROM folders WHERE id = ?").get(rows[0].folder_id);
  assert.deepEqual({ ...folder }, { name: "工作週報", role: "weekly_reports" });
});

test("一週一檔：週報被搬到別的資料夾，仍認得是同一週，不會再建一份", async (t) => {
  const { sqlite, db } = makeDb(t);
  const { entry } = await getOrCreateWeeklyReport(db, { week: "2026-W41", timestamp: "t1" });
  sqlite.prepare("INSERT INTO folders (id, name, type, created_at) VALUES (99, '別處', '其他', 't')").run();
  sqlite.prepare("UPDATE entries SET folder_id = 99 WHERE id = ?").run(entry.id);
  const second = await getOrCreateWeeklyReport(db, { week: "2026-W41", timestamp: "t2" });
  assert.equal(second.created, false);
  assert.equal(Number(second.entry.id), Number(entry.id));
  assert.equal(reports(sqlite).length, 1);
});

test("前台「本週周報」與 MCP 建立的是同一份、同一格式", async (t) => {
  const { sqlite, db } = makeDb(t);
  resetSchemaCacheForTests();
  const res = await fieldlogWorker.fetch(
    new Request("https://x/api/weekly-reports/current", { method: "POST", headers: { "x-pin": "pin" } }),
    { FIELD_PIN: "pin", DB: db },
  );
  assert.equal(res.status, 200);
  const created = await res.json();
  const week = taipeiIsoWeek().key;
  assert.equal(created.week, week);
  assert.match(created.title, new RegExp(`^${week} 工作週報（\\d{2}/\\d{2}–\\d{2}/\\d{2}）$`));
  const viaMcp = await callTool(db, "create_weekly_report", {});
  assert.match(viaMcp, new RegExp(`沿用既有 \\[entry ${created.id}\\]`));
  assert.equal(reports(sqlite).length, 1);
});

test("update_weekly_report：用 week 指定、覆寫前備份上一版、內容相同不重寫", async (t) => {
  const { sqlite, db } = makeDb(t);
  await callTool(db, "create_weekly_report", { week: "2026-W41" });
  const firstWrite = await callTool(db, "update_weekly_report", { week: "2026-W41", weekly_report: "1. 第一版" });
  assert.doesNotMatch(firstWrite, /備份/, "空白模板第一次寫入不需要備份");
  const secondWrite = await callTool(db, "update_weekly_report", { week: "2026-W41", weekly_report: "1. 第二版", next_week_plan: "下週計畫" });
  assert.match(secondWrite, /已備份上一版（版本 #\d+）/);

  const [report] = reports(sqlite);
  assert.equal(report.fields["本週工作報告"], "1. 第二版");
  assert.equal(report.fields["下週重要工作計畫"], "下週計畫");
  assert.match(report.body, /二、本週工作報告\n1\. 第二版/);
  const versions = sqlite.prepare("SELECT entry_id, fields_json FROM entry_versions ORDER BY id").all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].entry_id, report.id);
  assert.equal(JSON.parse(versions[0].fields_json)["本週工作報告"], "1. 第一版", "版本要存的是覆寫前的內容");

  const same = await callTool(db, "update_weekly_report", { week: "2026-W41", weekly_report: "1. 第二版" });
  assert.match(same, /沒有寫入/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM entry_versions").get().n, 1);
});

test("update_weekly_report：仍只能改週報模板，週次不存在或對不上時明確報錯", async (t) => {
  const { sqlite, db } = makeDb(t);
  sqlite.prepare("INSERT INTO entries (id, title, fields_json, body, created_at) VALUES (423, '2026-W40工作周報', '{}', '手寫', 't')").run();
  await assert.rejects(callTool(db, "update_weekly_report", { entry_id: 423, weekly_report: "x" }), /不是 MyWiki 週報模板/);
  await assert.rejects(callTool(db, "update_weekly_report", { week: "2026-W40", weekly_report: "x" }), /還沒有週報，請先呼叫 create_weekly_report/);
  await callTool(db, "create_weekly_report", { week: "2026-W41" });
  const id = reports(sqlite)[0].id;
  await assert.rejects(callTool(db, "update_weekly_report", { entry_id: id, week: "2026-W40", weekly_report: "x" }), /不是 2026-W40/);
  await assert.rejects(callTool(db, "update_weekly_report", { weekly_report: "x" }), /week|entry_id/);
  assert.equal(sqlite.prepare("SELECT body FROM entries WHERE id = 423").get().body, "手寫", "一般記事不能被動到");
  const [report] = reports(sqlite);
  assert.equal(report.title, "2026-W41 工作週報（10/05–10/09）", "標題不會被改");
});

test("get_weekly_report：回傳本週與上一週內容，並列出提到該週的舊手寫記事", async (t) => {
  const { sqlite, db } = makeDb(t);
  await callTool(db, "create_weekly_report", { week: "2026-W40" });
  await callTool(db, "update_weekly_report", { week: "2026-W40", weekly_report: "上週：檢體針時程會議" });
  await callTool(db, "create_weekly_report", { week: "2026-W41" });
  await callTool(db, "update_weekly_report", { week: "2026-W41", weekly_report: "本週：檢體針驗收" });
  sqlite.prepare("INSERT INTO entries (title, fields_json, body, created_at) VALUES ('2026-W40工作周報', '{}', '舊', 't')").run();

  const out = await callTool(db, "get_weekly_report", { week: "2026-W41" });
  const [current, previous] = out.split("\n---\n");
  assert.match(current, /# 本週：2026-W41（2026-10-05–2026-10-09）/);
  assert.match(current, /本週：檢體針驗收/);
  assert.match(previous, /# 上一週：2026-W40（2026-09-28–2026-10-02）/);
  assert.match(previous, /上週：檢體針時程會議/);
  assert.match(previous, /2026-W40工作周報/, "舊手寫記事要被點出來");

  const missing = await callTool(db, "get_weekly_report", { week: "2026-W45" });
  assert.match(missing, /這一週還沒有系統週報模板/);
  assert.match(missing, /create_weekly_report（week: "2026-W45"）/);
});

test("append_daily_log：依日期分段附加、不覆寫、重複送出不重複，週報不存在時自動建立", async (t) => {
  const { sqlite, db } = makeDb(t);
  await callTool(db, "append_daily_log", { date: "2026-10-05", text: "檢體針時程會議" });
  await callTool(db, "append_daily_log", { date: "2026-10-05", text: "UV膠請購" });
  const dup = await callTool(db, "append_daily_log", { date: "2026-10-05", text: "UV膠請購" });
  assert.match(dup, /沒有重複附加/);
  await callTool(db, "append_daily_log", { date: "2026-10-06", text: "點膠治具驗收" });
  const rows = reports(sqlite);
  assert.equal(rows.length, 1, "同一週只會有一份週報");
  assert.equal(rows[0].fields["每日紀錄"], "【10/05（一）】\n檢體針時程會議\nUV膠請購\n\n【10/06（二）】\n點膠治具驗收");
  assert.equal(rows[0].fields["本週工作報告"], "", "不能動到正式週報欄位");
  assert.match(rows[0].body, /（附）每日紀錄\n【10\/05（一）】/);
});

test("appendToDailyLog：補寫較早的日期時插在該日段落內，不會跑到別天底下", () => {
  const existing = "【10/05（一）】\nA\n\n【10/06（二）】\nB";
  assert.equal(appendToDailyLog(existing, "【10/05（一）】", "A2").value, "【10/05（一）】\nA\nA2\n\n【10/06（二）】\nB");
  assert.throws(() => appendToDailyLog(existing, "【10/05（一）】", "  "), /text 為必填/);
});

test("前台週報：每日紀錄可在畫面上編輯並存回；工作週報資料夾的新紀錄改開本週週報", async (t) => {
  const { sqlite, db } = makeDb(t);
  await callTool(db, "create_weekly_report", { week: "2026-W41" });
  const id = reports(sqlite)[0].id;
  resetSchemaCacheForTests();
  const res = await fieldlogWorker.fetch(new Request(`https://x/api/entries/${id}`, {
    method: "PUT",
    headers: { "x-pin": "pin", "content-type": "application/json" },
    body: JSON.stringify({ title: "改名", fields: { "每日紀錄": "【10/05（一）】\n手動補記", "週次": "2099-W01" } }),
  }), { FIELD_PIN: "pin", DB: db });
  assert.equal(res.status, 200);
  const [report] = reports(sqlite);
  assert.equal(report.fields["每日紀錄"], "【10/05（一）】\n手動補記");
  assert.equal(report.fields["週次"], "2026-W41", "週次由系統固定");
  assert.equal(report.title, "2026-W41 工作週報（10/05–10/09）", "週報檔名由系統固定");

  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /data-key="每日紀錄"/);
  assert.match(app, /if \(CURRENT_FOLDER\.role === "weekly_reports"\) return openCurrentWeeklyReport\(\);/);
});

test("MCP：新工具都有標題、寫入工具標為非唯讀、伺服器說明已更新", async () => {
  const res = await mcpWorker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }), { MCP_PIN: "testpin" });
  const { result } = await res.json();
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  for (const name of ["create_weekly_report", "update_weekly_report", "append_daily_log"]) {
    assert.equal(byName[name]?.annotations.readOnlyHint, false, `${name} 是寫入工具`);
  }
  assert.equal(byName.get_weekly_report?.annotations.readOnlyHint, true);
  assert.equal(byName.create_weekly_report.title, "建立工作週報");
  const mcp = await read("../mcp/src/worker.js");
  assert.match(mcp, /append_daily_log 只會把當天紀錄附加到週報的每日紀錄/);
});
