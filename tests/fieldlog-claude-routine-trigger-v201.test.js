/**
 * v201：錄音轉錄完成 → 觸發 claude.ai Routine 整理逐字稿（取代每天固定時間跑的 Agent），
 * 自動沒觸發到時記事上有「✨ Claude 整理」可以自己按。
 *
 * 用 node:sqlite 當 D1，實際跑 schema 與 SQL，只把 /fire 的 HTTP 呼叫換掉。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker, { fireDueAiSummaries } from "../fieldlog/src/worker.js";
import { fireClaudeRoutine } from "../fieldlog/src/lib/claude-routine.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    sqlite,
    prepare: (sql) => stmt(sql),
    async batch(list) { return Promise.all(list.map((s) => s.run())); },
  };
}

const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19) + "Z";
const MIN = 60000;

async function setup() {
  resetSchemaCacheForTests();
  const db = d1();
  await ensureSchema(db, ts(60 * MIN));
  return db;
}

function addEntry(db, { id, createdAgo = 30 * MIN, audio = [] }) {
  db.sqlite.prepare("INSERT INTO entries (id, title, created_at) VALUES (?, ?, ?)").run(id, `錄音 ${id}`, ts(createdAgo));
  for (const [i, a] of audio.entries()) {
    db.sqlite.prepare(
      "INSERT INTO attachments (entry_id, kind, filename, key, transcript, transcribed_at, offset_secs, created_at) VALUES (?, 'audio', ?, ?, ?, ?, ?, ?)"
    ).run(id, `seg${i}.webm`, `k${id}-${i}`, a.transcript ?? "", a.transcribed_at ?? ts(a.createdAgo ?? 20 * MIN), i * 60, ts(a.createdAgo ?? 20 * MIN));
  }
}

function fakeFire(calls, { status = 200 } = {}) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "bad token" } }), { status });
    return new Response(JSON.stringify({ claude_code_session_id: "session_1", claude_code_session_url: "https://claude.ai/code/session_1" }));
  };
}

const ENV = (db) => ({ DB: db, CLAUDE_ROUTINE_FIRE_URL: "https://api.anthropic.com/v1/claude_code/routines/trig_x/fire", CLAUDE_ROUTINE_TOKEN: "tok" });

test("/fire 呼叫帶 bearer token 與 beta header，text 只放記事識別資訊", async () => {
  const calls = [];
  const r = await fireClaudeRoutine(ENV(null), "{\"entry_id\":1}", fakeFire(calls));
  assert.equal(r.sessionUrl, "https://claude.ai/code/session_1");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.match(calls[0].init.headers["anthropic-beta"], /^experimental-cc-routine-/);
  assert.deepEqual(calls[0].body, { text: "{\"entry_id\":1}" });
});

test("session 網址不是 https 時不收（避免變成 javascript: 連結）", async () => {
  const r = await fireClaudeRoutine(ENV(null), "x", async () => new Response(JSON.stringify({ claude_code_session_url: "javascript:alert(1)" })));
  assert.equal(r.sessionUrl, "");
});

test("自動觸發：只挑轉錄完成、安靜 10 分鐘、cutoff 之後、還沒觸發過的錄音，每筆只觸發一次", async (t) => {
  const db = await setup();
  addEntry(db, { id: 1, audio: [{ transcript: "第一段" }, { transcript: "第二段" }] });           // ✅
  addEntry(db, { id: 2, audio: [{ transcript: "還在錄", createdAgo: 2 * MIN }] });                // 剛上傳，還沒安靜
  addEntry(db, { id: 3, audio: [{ transcript: "a" }, { transcript: "", transcribed_at: "" }] });  // 還有一段沒轉
  addEntry(db, { id: 4, createdAgo: 120 * MIN, audio: [{ transcript: "舊錄音" }] });              // cutoff 之前
  addEntry(db, { id: 5, audio: [{ transcript: "" }] });                                           // 全是靜音
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFire(calls);
  t.after(() => { globalThis.fetch = original; });

  const first = await fireDueAiSummaries(ENV(db));
  assert.equal(first.fired, 1);
  assert.equal(JSON.parse(calls[0].body.text).entry_id, 1);
  assert.equal(JSON.parse(calls[0].body.text).trigger, "auto");

  const second = await fireDueAiSummaries(ENV(db));
  assert.equal(second.fired, 0, "同一筆不會被自動重複觸發");
  const row = db.sqlite.prepare("SELECT status, session_url FROM ai_summary_fires WHERE entry_id = 1").get();
  assert.equal(row.status, "fired");
  assert.equal(row.session_url, "https://claude.ai/code/session_1");
});

test("沒設定 Secret 時自動觸發安靜跳過、不打任何外部請求", async () => {
  const db = await setup();
  addEntry(db, { id: 1, audio: [{ transcript: "內容" }] });
  const r = await fireDueAiSummaries({ DB: db });
  assert.equal(r.skipped, "not_configured");
});

test("token 錯誤（401）記成失敗、這輪停下，最多自動重試 3 次", async (t) => {
  const db = await setup();
  addEntry(db, { id: 1, audio: [{ transcript: "一" }] });
  addEntry(db, { id: 2, audio: [{ transcript: "二" }] });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFire(calls, { status: 401 });
  t.after(() => { globalThis.fetch = original; });
  const r = await fireDueAiSummaries(ENV(db));
  assert.equal(r.fired, 0);
  assert.equal(calls.length, 1, "401 之後不再嘗試下一筆");
  await fireDueAiSummaries(ENV(db));
  await fireDueAiSummaries(ENV(db));
  await fireDueAiSummaries(ENV(db));
  const attempts = db.sqlite.prepare("SELECT attempts FROM ai_summary_fires WHERE entry_id = 1").get().attempts;
  assert.equal(attempts, 3);
});

async function callApi(env, path, method = "POST") {
  const res = await fieldlogWorker.fetch(new Request(`https://x.test/api${path}`, { method, headers: { "x-pin": "1234" } }), { ...env, FIELD_PIN: "1234" });
  return { status: res.status, body: await res.json() };
}

test("手動按鈕：舊錄音也能觸發；兩分鐘內重按會被擋；未設定 Secret 回 501", async (t) => {
  const db = await setup();
  addEntry(db, { id: 9, createdAgo: 500 * MIN, audio: [{ transcript: "上線前的舊錄音" }] });
  addEntry(db, { id: 10, audio: [] });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFire(calls);
  t.after(() => { globalThis.fetch = original; });

  assert.equal((await callApi({ DB: db }, "/entries/9/claude-summary")).status, 501);
  const ok = await callApi(ENV(db), "/entries/9/claude-summary");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session_url, "https://claude.ai/code/session_1");
  assert.equal(JSON.parse(calls[0].body.text).trigger, "manual");
  assert.equal((await callApi(ENV(db), "/entries/9/claude-summary")).status, 429);
  assert.equal((await callApi(ENV(db), "/entries/10/claude-summary")).status, 400, "沒有逐字稿不觸發");

  const entry = await callApi(ENV(db), "/entries/9", "GET");
  assert.equal(entry.body.ai_fire.status, "fired");
  assert.equal(entry.body.ai_fire.trigger, "manual");
});

test("每 10 分鐘的排程與前台按鈕都已接上", async () => {
  const wrangler = await read("../fieldlog/wrangler.jsonc");
  const app = await read("../fieldlog/public/app.js");
  assert.match(wrangler, /"\*\/10 \* \* \* \*"/);
  assert.match(app, /id="e-claude-summary"/);
  assert.match(app, /\/claude-summary`/);
});
