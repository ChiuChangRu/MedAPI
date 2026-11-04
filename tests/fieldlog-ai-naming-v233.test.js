/**
 * v233 AI 命名：讀內容＋來源網址＋資料夾，請 AI 判斷公司／產品／文件類型，
 * 只回建議（不改檔名）；沒擷取過文字的 PDF 先擷取並存起來。node:sqlite＋假 AI 實跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { composeFilename, namingMessages, parseNamingResult } from "../fieldlog/src/lib/ai-naming.js";

test("組檔名：公司_產品_類型，產品已含公司名不重複；判斷不出就不給建議", () => {
  assert.equal(composeFilename({ company: "BD", product: "Mission Core Biopsy Instrument", doc_type: "型錄" }, "27.pdf"), "BD_Mission Core Biopsy Instrument_型錄.pdf");
  assert.equal(composeFilename({ company: "Argon Medical", product: "Argon Medical SuperCore", doc_type: "型錄" }, "a.PDF"), "Argon Medical SuperCore_型錄.pdf");
  assert.equal(composeFilename({ company: "", product: "", doc_type: "其他" }, "x.pdf"), "");
  assert.deepEqual(parseNamingResult('說明 {"company":"Merit / Medical","product":"Temno?","doc_type":"亂寫"}'), { company: "Merit Medical", product: "Temno", doc_type: "其他" });
  assert.equal(parseNamingResult("沒有 JSON"), null);
  assert.match(namingMessages({ filename: "27.pdf", sourceUrl: "https://eu.bd.com/x/27.pdf", folderPath: "專案 / 檢體針", text: "abc" })[1].content, /eu\.bd\.com/);
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

test("建議檔名：先擷取 PDF 文字並存起來、帶來源網址與資料夾給 AI、不改檔名", async (t) => {
  resetSchemaCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = d1();
  const sent = [];
  const env = {
    DB: db, FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok",
    FILES: { async get() { return { arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }; }, async put() {}, async delete() {} },
    AI: {
      async toMarkdown() { return [{ data: "Mission Disposable Core Biopsy Instrument Instructions for Use BD" }]; },
      async run(model, input) { sent.push({ model, input }); return { response: { company: "BD", product: "Mission Disposable Core Biopsy Instrument", doc_type: "使用說明書" } }; },
    },
  };
  const call = async (path, method = "GET", body) => {
    const res = await fieldlogWorker.fetch(new Request(`https://fieldlog.example.dev/api${path}`, { method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, body: await res.json() };
  };
  const folder = await call("/folders", "POST", { name: "比對品", category: "project" });
  db.sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, created_at, updated_at) VALUES (1, ?, '27', ?, '2026-11-04 00:00:00Z', '2026-11-04 00:00:00Z')")
    .run(folder.body.id, JSON.stringify({ source_url: "https://eu.bd.com/emea-peripheral-interventions/lib/asset/27.pdf" }));
  db.sqlite.prepare("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, created_at) VALUES (5, 1, 'file', '27.pdf', '1/27.pdf', 4, 'application/pdf', '2026-11-04 00:00:00Z')").run();
  const r = await call("/attachments/5/suggest-name", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.filename, "BD_Mission Disposable Core Biopsy Instrument_使用說明書.pdf");
  const llm = sent.find((c) => c.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(llm.input.messages[1].content, /eu\.bd\.com/);
  assert.match(llm.input.messages[1].content, /比對品/);
  assert.match(llm.input.messages[1].content, /Mission Disposable/);
  const row = db.sqlite.prepare("SELECT filename, ocr_text FROM attachments WHERE id = 5").get();
  assert.equal(row.filename, "27.pdf", "只給建議，不改檔名");
  assert.match(row.ocr_text, /Mission Disposable/, "擷取的文字存起來");
});

test("選取列有 AI 命名按鈕", async () => {
  const [html, sel] = await Promise.all([
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/file-selection.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="file-selection-ai-name"/);
  assert.match(sel, /openAiNaming\(selectedFileItems\(\)\)/);
});
