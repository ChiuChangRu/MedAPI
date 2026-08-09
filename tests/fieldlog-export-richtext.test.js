/**
 * GET /export/folder/:id — 匯出資料夾原始資料給 AI 彙整。
 *
 * entries.body_format = 'html' 的記事（富文字編輯框產生）要在匯出時剝成純
 * 文字，AI 只需要文字內容，不該收到一堆標籤。純文字記事（'text'，含所有
 * 既有資料）維持原樣輸出，完全不受影響。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB() {
  const tables = { folders: [], entries: [], attachments: [] };

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };
    if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q) || /^DROP INDEX/i.test(q)) return none;
    if (q === "SELECT * FROM folders WHERE id = ?") {
      const row = tables.folders.find((f) => f.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q === "SELECT * FROM entries WHERE folder_id = ? ORDER BY id") {
      return { results: tables.entries.filter((e) => e.folder_id === args[0]) };
    }
    if (q === "SELECT * FROM attachments WHERE entry_id = ? ORDER BY id") {
      return { results: tables.attachments.filter((a) => a.entry_id === args[0]) };
    }
    return none;
  }

  const db = {
    tables,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { return { meta: {} }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db) {
  resetSchemaCacheForTests();
  return { FIELD_PIN: "pin", DB: db };
}

async function exportFolder(env, id) {
  const req = new Request(`https://x/api/export/folder/${id}`, { headers: { "x-pin": "pin" } });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, text: await res.text() };
}

test("匯出資料夾：body_format='text' 的記事原樣輸出（既有行為不變）", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 1, name: "測試資料夾", type: "其他" });
  db.tables.entries.push({ id: 1, folder_id: 1, title: "純文字記事", body: "第一行\n第二行", fields_json: "{}", created_at: "x" });

  const { status, text } = await exportFolder(env, 1);
  assert.equal(status, 200);
  assert.match(text, /第一行\n第二行/);
});

test("匯出資料夾：body_format='html' 的記事要剝成純文字，不能帶標籤", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 1, name: "測試資料夾", type: "其他" });
  db.tables.entries.push({
    id: 1, folder_id: 1, title: "富文字記事", fields_json: "{}", created_at: "x",
    body_format: "html",
    body: '<p>第一段</p><p>第二段</p><img src="/api/file/x" alt="收據.jpg">',
  });

  const { status, text } = await exportFolder(env, 1);
  assert.equal(status, 200);
  assert.match(text, /第一段/);
  assert.match(text, /第二段/);
  assert.match(text, /\[圖片：收據\.jpg\]/);
  assert.doesNotMatch(text, /<p>|<img/, "匯出給 AI 的內容不該帶 HTML 標籤");
});
