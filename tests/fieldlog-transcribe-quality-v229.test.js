/**
 * v229 錄音轉文字品質：Whisper 指定中文、專業詞彙提示、去靜音、不沿用前句；結果簡轉繁
 * （只換字形，不換詞彙；保留「台」）。詞彙可在首頁自訂。用 node:sqlite＋假 AI 實跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { buildInitialPrompt, cleanGlossary, DEFAULT_GLOSSARY, looksLikePromptEcho, toTraditional } from "../fieldlog/src/lib/transcribe.js";

test("簡轉繁只換字形：專業詞不被換成台灣慣用詞，「台」保留", () => {
  assert.equal(toTraditional("灭菌缺效报告，连接管，软件，打印，台湾"), "滅菌缺效報告，連接管，軟件，打印，台灣");
  assert.equal(toTraditional("已是繁體：逆止閥、加速老化"), "已是繁體：逆止閥、加速老化");
});

test("提示詞：繁體情境＋詞彙，不超過 200 字；提示回吐判為幻覺", () => {
  const prompt = buildInitialPrompt(DEFAULT_GLOSSARY);
  assert.ok(prompt.length <= 200);
  assert.match(prompt, /逆止閥、滅菌確效/);
  const long = buildInitialPrompt(Array.from({ length: 80 }, (_, i) => `很長的專業詞彙${i}`));
  assert.ok(long.length <= 200, "詞太多時截斷");
  assert.equal(looksLikePromptEcho(prompt), true);
  assert.equal(looksLikePromptEcho("今天討論逆止閥規格"), false);
  assert.deepEqual(cleanGlossary("逆止閥\n 逆止閥 ,DEHP、"), ["逆止閥", "DEHP"]);
});

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

test("轉錄送出正確參數、存成繁體；自訂詞彙會進提示", async (t) => {
  resetSchemaCacheForTests();
  // 讓 enforceAiSoftBudget 過關（同 fieldlog-auto-transcribe.test.js 的做法）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = d1();
  const calls = [];
  const env = {
    DB: db, FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok",
    FILES: { async get() { return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }, async put() {}, async delete() {} },
    AI: { async run(model, input) { calls.push({ model, input }); return { text: "灭菌袋的规格书已经更新", vtt: "WEBVTT\n\n00:00.000 --> 00:02.000\n规格书" }; } },
  };
  const call = async (path, method = "GET", body) => {
    const res = await fieldlogWorker.fetch(new Request(`https://fieldlog.example.dev/api${path}`, { method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call("/transcribe/glossary")).body.custom, false, "未自訂時用預設詞彙");
  const saved = await call("/transcribe/glossary", "PUT", { terms: ["A9150", "逆止閥", "A9150"] });
  assert.deepEqual(saved.body.terms, ["A9150", "逆止閥"]);
  db.sqlite.prepare("INSERT INTO entries (id, title, created_at, updated_at) VALUES (1, '錄音', '2026-11-03 00:00:00Z', '2026-11-03 00:00:00Z')").run();
  db.sqlite.prepare("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, created_at) VALUES (7, 1, 'audio', '錄音-段1.webm', '1/a.webm', 3, 'audio/webm', '2026-11-03 00:00:00Z')").run();
  const r = await call("/attachments/7/transcribe", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const whisper = calls.find((c) => c.model === "@cf/openai/whisper-large-v3-turbo");
  assert.equal(whisper.input.language, "zh");
  assert.equal(whisper.input.vad_filter, true);
  assert.equal(whisper.input.condition_on_previous_text, false);
  assert.match(whisper.input.initial_prompt, /A9150、逆止閥/);
  const row = db.sqlite.prepare("SELECT transcript, transcript_vtt FROM attachments WHERE id = 7").get();
  assert.equal(row.transcript, "滅菌袋的規格書已經更新");
  assert.match(row.transcript_vtt, /規格書/);
});

test("首頁有詞彙編輯區", async () => {
  const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="transcribe-glossary"/);
});
