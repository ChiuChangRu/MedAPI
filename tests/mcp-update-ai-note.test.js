/**
 * update_ai_note：MCP 把摘要寫進錄音記事的「✨ AI 整理筆記」欄位。
 *
 * 寫入走 fieldlog 自己的 PUT /api/entries/:id/ai-note，MCP 這邊只負責：
 * 擋掉不合法的輸入（且完全不打到 FIELDLOG）、算出跟 fieldlog 一致的
 * transcript_revision、把 fieldlog 的錯誤原樣帶出來。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker from "../mcp/src/worker.js";

const DONE = "2026-09-20 10:00:00Z";

function makeFieldlogBinding({ status = 200, body = { ok: true, ai_note: { source: "mcp_api", updated_at: "2026-09-23 01:00:00Z" } } } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    },
  };
}

function makeDB({ entries = [], audio = {}, attachments = {}, aiNotes = {} } = {}) {
  return {
    prepare: (sql) => {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        bind: (...args) => ({
          first: async () => {
            if (q.startsWith("SELECT id, title FROM entries WHERE id = ?")
              || q.startsWith("SELECT * FROM entries WHERE id = ?")) {
              return entries.find((e) => e.id === args[0]) || null;
            }
            if (q.includes("FROM entry_ai_notes WHERE entry_id = ?")) return aiNotes[args[0]] || null;
            return null;
          },
          all: async () => {
            if (q.startsWith("SELECT id, transcript, transcribed_at FROM attachments")) return { results: audio[args[0]] || [] };
            if (q.startsWith("SELECT * FROM attachments WHERE entry_id = ?")) return { results: attachments[args[0]] || [] };
            return { results: [] };
          },
        }),
      };
    },
  };
}

async function callTool(env, name, args) {
  const req = new Request("https://x/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin", FIELD_PIN: "fieldpin", ...env });
  return (await res.json()).result;
}

const text = (result) => result.content.map((c) => c.text || "").join("\n");

const RECORDING = { id: 7, title: "錄音逐字稿" };
const RECORDING_AUDIO = [
  { id: 11, transcript: "第一段內容", transcribed_at: DONE },
  { id: 12, transcript: "第二段", transcribed_at: DONE },
];

test("缺 entry_id、空白或超長的 ai_note 一律報錯，且不打到 FIELDLOG", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB({ entries: [RECORDING], audio: { 7: RECORDING_AUDIO } }), FIELDLOG: fieldlog };
  for (const args of [
    { ai_note: "摘要" },
    { entry_id: 7, ai_note: "   \n " },
    { entry_id: 7, ai_note: "x".repeat(500001) },
  ]) {
    const result = await callTool(env, "update_ai_note", args);
    assert.ok(result.isError, `應該報錯：${JSON.stringify(args).slice(0, 80)}`);
  }
  assert.equal(fieldlog.calls.length, 0);
});

test("不存在的 entry_id 回傳明確錯誤，不打到 FIELDLOG（不會建立新記事）", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB({ entries: [RECORDING] }), FIELDLOG: fieldlog };
  const result = await callTool(env, "update_ai_note", { entry_id: 999, ai_note: "摘要" });
  assert.ok(result.isError);
  assert.match(text(result), /找不到記事 999/);
  assert.equal(fieldlog.calls.length, 0);
});

test("非錄音記事沒有 AI 整理筆記欄位：報錯並建議改用 create_fieldlog_entry＋create_relation", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB({ entries: [{ id: 8, title: "文字記事" }] }), FIELDLOG: fieldlog };
  const result = await callTool(env, "update_ai_note", { entry_id: 8, ai_note: "摘要" });
  assert.ok(result.isError);
  assert.match(text(result), /不是錄音記事/);
  assert.match(text(result), /create_relation/);
  assert.equal(fieldlog.calls.length, 0);
});

test("逐字稿還有段落在轉錄中（processing／auto_failed）就不寫入", async () => {
  for (const state of ["processing", "auto_failed", ""]) {
    const fieldlog = makeFieldlogBinding();
    const audio = [RECORDING_AUDIO[0], { id: 12, transcript: "", transcribed_at: state }];
    const env = { DB_FIELDLOG: makeDB({ entries: [RECORDING], audio: { 7: audio } }), FIELDLOG: fieldlog };
    const result = await callTool(env, "update_ai_note", { entry_id: 7, ai_note: "摘要" });
    assert.ok(result.isError, `transcribed_at=${JSON.stringify(state)} 應該擋下`);
    assert.match(text(result), /1\/2 段/);
    assert.equal(fieldlog.calls.length, 0);
  }
});

test("成功：PUT fieldlog 的 ai-note 端點，來源 mcp_api、帶 fieldlog 算法一致的 transcript_revision、不送 force", async () => {
  const fieldlog = makeFieldlogBinding();
  const env = { DB_FIELDLOG: makeDB({ entries: [RECORDING], audio: { 7: RECORDING_AUDIO } }), FIELDLOG: fieldlog };
  const note = "## 會議重點\n- 第一項";
  const result = await callTool(env, "update_ai_note", { entry_id: 7, ai_note: note });
  assert.ok(!result.isError, text(result));

  assert.equal(fieldlog.calls.length, 1);
  const { url, init } = fieldlog.calls[0];
  const u = new URL(url);
  assert.equal(u.pathname, "/api/entries/7/ai-note");
  assert.equal(u.searchParams.get("pin"), "fieldpin");
  assert.equal(init.method, "PUT");

  const body = JSON.parse(init.body);
  assert.equal(body.markdown, note);
  assert.equal(body.source, "mcp_api");
  assert.ok(!("force" in body), "force 會繞過人工修改保護，MCP 絕不能送");
  const expected = createHash("sha256")
    .update(JSON.stringify(RECORDING_AUDIO.map((a) => [a.id, a.transcribed_at, a.transcript.length])))
    .digest("hex");
  assert.equal(body.transcript_revision, expected);

  const out = text(result);
  assert.match(out, /entry 7/);
  assert.match(out, new RegExp(`字數：${note.length}`));
  assert.match(out, /mcp_api/);
});

test("fieldlog 拒絕（例如人工改過的筆記 409）時，原因原樣帶出來", async () => {
  const fieldlog = makeFieldlogBinding({ status: 409, body: { error: "人工修改過的整理筆記不可由 Agent 覆蓋" } });
  const env = { DB_FIELDLOG: makeDB({ entries: [RECORDING], audio: { 7: RECORDING_AUDIO } }), FIELDLOG: fieldlog };
  const result = await callTool(env, "update_ai_note", { entry_id: 7, ai_note: "摘要" });
  assert.ok(result.isError);
  assert.match(text(result), /HTTP 409/);
  assert.match(text(result), /人工修改過的整理筆記不可由 Agent 覆蓋/);
});

test("transcript_revision 算法沒有跟 fieldlog 分歧（fieldlog 改了這裡會先失敗）", async () => {
  const fieldlog = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const mcp = await readFile(new URL("../mcp/src/worker.js", import.meta.url), "utf8");
  const hint = "fieldlog 的逐字稿版本算法改了：請同步更新 mcp/src/worker.js 的 recordingTranscriptState()";
  assert.match(fieldlog, /\[item\.id, item\.transcribed_at \|\| "", String\(item\.transcript \|\| ""\)\.length\]/, hint);
  assert.match(fieldlog, /\["processing", "auto_failed"\]\.includes\(state\)/, hint);
  assert.match(fieldlog, /WHERE entry_id = \? AND kind = 'audio' AND source_pdf_id IS NULL\s+ORDER BY COALESCE\(offset_secs, 0\), id/, hint);
  assert.match(mcp, /\[a\.id, a\.transcribed_at \|\| "", String\(a\.transcript \|\| ""\)\.length\]/);
  assert.match(mcp, /\["processing", "auto_failed"\]\.includes\(state\)/);
});

test("get_fieldlog_entry：錄音記事呈現目前的 AI 整理筆記與來源；沒有時標示尚未整理；非錄音記事不出現", async () => {
  const entries = [
    { id: 7, title: "錄音逐字稿", created_at: DONE, fields_json: "{}" },
    { id: 9, title: "另一段錄音", created_at: DONE, fields_json: "{}" },
    { id: 8, title: "文字記事", created_at: DONE, fields_json: "{}" },
  ];
  const audioAtt = (id, entryId) => ({ id, entry_id: entryId, kind: "audio", filename: "a.m4a", transcript: "內容", source_pdf_id: null });
  const db = makeDB({
    entries,
    attachments: { 7: [audioAtt(11, 7)], 9: [audioAtt(21, 9)] },
    aiNotes: { 7: { markdown: "## 重點\n- 甲", source: "mcp_api", manually_edited: 0, updated_at: "2026-09-23 01:00:00Z" } },
  });

  const withNote = text(await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 7 }));
  assert.match(withNote, /AI 整理筆記（AI 產出，非原始紀錄）｜來源：mcp_api/);
  assert.match(withNote, /## 重點\n- 甲/);

  const noNote = text(await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 9 }));
  assert.match(noNote, /AI 整理筆記：尚未整理/);

  const notRecording = text(await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 8 }));
  assert.doesNotMatch(notRecording, /AI 整理筆記/);
});
