/**
 * v253 錄完／上傳完自動命名＋歸類：POST /api/entries/:id/auto-organize。
 * node:sqlite 當 D1、假 AI 依模型回指定內容。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const NAMING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MOVE_MODEL = "@cf/google/gemma-4-26b-a4b-it";

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

function fakeAi({ subject = "廠商拜訪訪談", move = null } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model === NAMING_MODEL) return { response: JSON.stringify({ name: subject }) };
      if (model === MOVE_MODEL) return { response: JSON.stringify(move) };
      return { response: "{}" };
    },
  };
}

async function call(env, path, host = "mywiki.example.dev") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  try {
    const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: "{}",
    }), { FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok", ...env });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = originalFetch; }
}

async function seed(db) {
  await ensureSchema(db, "2026-11-16 00:00:00Z");
  const q = (sql, ...a) => db.sqlite.prepare(sql).run(...a);
  const t = "2026-11-16 02:00:00Z";
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (1, '檢體針', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '廠商拜訪', '其他專案', 'project', 1, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (6, '⏳ 待分類', '其他', 'misc', NULL, 'staging', ?)", t);
  // 10：首頁錄的音（待分類、預設標題、逐字稿已完成）
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (10, 6, '錄音 11/16 10:30', '{}', '', 'html', ?)", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, transcript, transcribed_at, created_at) VALUES (20, 10, 'audio', '錄音-段1.webm', 'k1', 100, 'audio/webm', '今天拜訪廠商，討論檢體針的規格', '2026-11-16 03:00:00Z', '2026-11-16 02:30:00Z')");
  // 11：音檔還在轉錄
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (11, 6, '錄音 11/16 11:00', '{}', '', 'html', ?)", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, transcript, transcribed_at, created_at) VALUES (21, 11, 'audio', '錄音-段1.webm', 'k2', 100, 'audio/webm', '', '', '2026-11-16 03:30:00Z')");
  // 12：在資料夾內錄的（位置是使用者選的）
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 2, '錄音 11/16 12:00', '{}', '', 'html', ?)", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, transcript, transcribed_at, created_at) VALUES (22, 12, 'audio', '錄音-段1.webm', 'k3', 100, 'audio/webm', '會議紀錄', '2026-11-16 04:00:00Z', '2026-11-16 03:40:00Z')");
  // 13：使用者自己取的標題
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (13, 6, '我自己取的標題', '{}', '', 'html', ?)", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, transcript, transcribed_at, created_at) VALUES (23, 13, 'audio', '錄音-段1.webm', 'k4', 100, 'audio/webm', '內容', '2026-11-16 04:00:00Z', '2026-11-16 03:40:00Z')");
  // 14：週報
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (14, 6, '週報', '{\"_kind\":\"weekly_report\"}', '', 'html', ?)", t);
}

test("錄音：附件改成「日期_主題」、預設標題換成主題、待分類的搬到 AI 選的資料夾並可復原", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({ subject: "廠商拜訪訪談", move: { folder_id: 2, new_folder: null, reason: "內容是廠商拜訪" } });
  const r = await call({ DB: db, AI: ai }, "/entries/10/auto-organize");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, "廠商拜訪訪談");
  assert.equal(r.body.title_changed, true);
  assert.equal(r.body.renamed[0].to, "20261116_廠商拜訪訪談.webm");
  assert.equal(r.body.moved.folder_id, 2);
  assert.equal(r.body.moved.path, "檢體針 ／ 廠商拜訪");
  const entry = db.sqlite.prepare("SELECT * FROM entries WHERE id = 10").get();
  assert.equal(entry.folder_id, 2);
  assert.equal(entry.title, "廠商拜訪訪談");
  assert.match(entry.fields_json, /_auto_organized_at/);
  const att = db.sqlite.prepare("SELECT filename, original_filename FROM attachments WHERE id = 20").get();
  assert.equal(att.filename, "20261116_廠商拜訪訪談.webm");
  assert.equal(att.original_filename, "錄音-段1.webm", "原檔名保留");
  const s = db.sqlite.prepare("SELECT * FROM filing_suggestions WHERE entry_id = 10").get();
  assert.equal(s.status, "auto_applied", "走既有的 auto_applied，列表上的復原鈕才能搬回待分類");
  assert.equal(Number(s.previous_folder_id), 6);
  // 第二次呼叫不重做
  const again = await call({ DB: db, AI: ai }, "/entries/10/auto-organize");
  assert.equal(again.body.skipped, "這筆已經自動整理過");
});

test("AI 沒有明確答案時：用向量找最接近的資料夾（使用者選擇「一律搬到最接近的」）", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({ move: { folder_id: null, new_folder: { name: "新資料夾", parent_id: 1 }, reason: "沒有合適的" } });
  const VECTOR = {
    async query() { return { matches: [{ score: 0.8, metadata: { entryId: 99 } }] }; },
  };
  // 向量比對到的記事 99 放在資料夾 2
  db.sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (99, 2, '舊拜訪', '{}', '', 'html', '2026-11-01 00:00:00Z')").run();
  const aiWithEmbed = {
    calls: ai.calls,
    async run(model, input) {
      if (model === "@cf/baai/bge-m3") return { data: [[0.1, 0.2, 0.3]] };
      return ai.run(model, input);
    },
  };
  const r = await call({ DB: db, AI: aiWithEmbed, VECTOR_INDEX: VECTOR }, "/entries/10/auto-organize");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moved?.folder_id, 2, JSON.stringify(r.body));
  const s = db.sqlite.prepare("SELECT confidence, reason FROM filing_suggestions WHERE entry_id = 10").get();
  assert.ok(Number(s.confidence) < 0.5, "低信心也要記錄，方便使用者判斷要不要復原");
  assert.match(s.reason, /最接近/);
});

test("沒有任何相近資料夾時留在待分類，不亂搬", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const r = await call({ DB: db, AI: fakeAi({ move: null }) }, "/entries/10/auto-organize");
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, null);
  assert.equal(db.sqlite.prepare("SELECT folder_id FROM entries WHERE id = 10").get().folder_id, 6);
  assert.equal(r.body.title, "廠商拜訪訪談", "改名不受影響");
});

test("逐字稿還沒好：回 pending，不標記完成、不改任何東西", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({});
  const r = await call({ DB: db, AI: ai }, "/entries/11/auto-organize");
  assert.equal(r.body.pending, true);
  assert.equal(ai.calls.length, 0, "沒有逐字稿就不呼叫 AI");
  const entry = db.sqlite.prepare("SELECT title, fields_json FROM entries WHERE id = 11").get();
  assert.equal(entry.title, "錄音 11/16 11:00");
  assert.doesNotMatch(entry.fields_json, /_auto_organized_at/);
});

test("使用者自己放的位置不動：資料夾內錄的只改名；自己取的標題不改；週報不處理", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({ subject: "會議重點", move: { folder_id: 1, reason: "x" } });
  const inFolder = await call({ DB: db, AI: ai }, "/entries/12/auto-organize");
  assert.equal(inFolder.body.moved, null);
  assert.equal(db.sqlite.prepare("SELECT folder_id FROM entries WHERE id = 12").get().folder_id, 2);
  assert.equal(inFolder.body.title, "會議重點");

  const custom = await call({ DB: db, AI: ai }, "/entries/13/auto-organize");
  assert.equal(db.sqlite.prepare("SELECT title FROM entries WHERE id = 13").get().title, "我自己取的標題");
  assert.equal(custom.body.title_changed, undefined);

  const weekly = await call({ DB: db, AI: ai }, "/entries/14/auto-organize");
  assert.match(weekly.body.skipped, /週報/);
});

test("AI（MCP）不能觸發；沒有 AI 綁定回 501", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const mcp = await call({ DB: db, AI: fakeAi({}) }, "/entries/10/auto-organize", "fieldlog.internal");
  assert.equal(mcp.status, 403);
  const none = await call({ DB: db }, "/entries/10/auto-organize");
  assert.equal(none.status, 501);
});

test("前端：錄音結束與上傳完成都會觸發，結果放進最近開啟；版本號四處一致", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /async function autoOrganizeCaptured\(entryIds, \{ transcribe = false \} = \{\}\)/);
  assert.match(app, /if \(uploadedSegments\) autoOrganizeCaptured\(\[entryId\], \{ transcribe: true \}\)/, "錄音結束");
  assert.match(app, /autoOrganizeCaptured\(organizeIds\)/, "上傳完成");
  assert.match(app, /organizeIds\.push\(entryId\)/);
  assert.match(app, /rememberRecentFolder\(item\.folder_id\);\s*rememberRecentEntry\(\{ id: item\.id, title: item\.title, folder_id: item\.folder_id \}\)/, "目的資料夾要進最近開啟");
  assert.match(app, /if \(!result\.pending\) break;/, "逐字稿未好就稍後再問");
  const worker = await read("../fieldlog/src/worker.js");
  const sw = await read("../fieldlog/public/sw.js");
  const html = await read("../fieldlog/public/index.html");
  // 版本號之後還會再升，這裡只檢查四處一致
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 253);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
  assert.match(html, new RegExp(`app\\.js\\?v=${version}`));
});
