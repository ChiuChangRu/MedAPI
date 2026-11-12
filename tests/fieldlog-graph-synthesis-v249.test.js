/**
 * v249 關聯圖 AI 綜整：圖上多筆資料一起交給 AI 做橫向整理；先估算用量，看過結果才存。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  estimateUsage, excerptForSynthesis, fitDocuments, markdownToHtml, normalizeCitations, synthesisMessages,
} from "../fieldlog/src/lib/synthesis.js";

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

async function seed(db) {
  await ensureSchema(db, "2026-11-12 00:00:00Z");
  const q = (sql, ...a) => db.sqlite.prepare(sql).run(...a);
  const t = "2026-11-12 01:00:00Z";
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (1, '專利分析', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (1, 1, 'US10463350B2 活檢裝置', '{}', '<p>專利摘要</p>', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (2, 1, 'CN107666864B 活检装置', '{}', '<p>中國專利</p>', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (3, 1, '已刪除', '{}', '', 'html', ?)", t);
  q("UPDATE entries SET deleted_at = ? WHERE id = 3", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, ocr_text, created_at) VALUES (10, 1, 'file', 'US10463350.pdf', 'k', 1, 'application/pdf', ?, ?)", "Background ".repeat(2000) + "What is claimed is: 1. A biopsy device comprising a needle", t);
}

function fakeAi(reply, calls = []) {
  return { calls, async run(model, input) { calls.push({ model, input }); return { response: reply }; } };
}

async function call(env, path, body, host = "mywiki.example.dev") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  try {
    const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify(body),
    }), { FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_USAGE_API_TOKEN: "t", ...env });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = originalFetch; }
}

test("excerptForSynthesis：長文件優先保留請求項；短文件原樣", () => {
  const long = "背景".repeat(5000) + "\n權利要求書\n1. 一種活檢裝置" + "細節".repeat(5000);
  const r = excerptForSynthesis(long, 2000);
  assert.equal(r.claims, true);
  assert.match(r.text, /權利要求書\n1\. 一種活檢裝置/);
  assert.ok(r.text.length <= 2020);
  assert.deepEqual(excerptForSynthesis("短文", 2000), { text: "短文", truncated: false, claims: false });
  const plain = excerptForSynthesis("內文提到請求項第1項".repeat(300), 500);
  assert.equal(plain.claims, false);
  assert.equal(plain.text.length, 500, "內文順口提到「請求項」不算段落標題");
  assert.equal(excerptForSynthesis("前言".repeat(3000) + "\n請求項\n1. 一種" + "x".repeat(3000), 1000).claims, true, "行首的「請求項」標題算");
});

test("normalizeCitations：不在資料中的編號改成 [#?]；markdownToHtml 會跳脫 HTML", () => {
  const n = normalizeCitations("重點 [#1][#2]，另見 [#99]", [1, 2]);
  assert.equal(n.markdown, "重點 [#1][#2]，另見 [#?]");
  assert.deepEqual(n.cited, [1, 2]);
  assert.equal(n.invalid, 1);
  const html = markdownToHtml("## 標題\n- **粗體** [#1]\n- <script>alert(1)</script>\n\n1. 第一\n段落", { citeLinks: true });
  assert.match(html, /<h3>標題<\/h3>/);
  assert.match(html, /<li><strong>粗體<\/strong> <span class="graph-cite" data-cite="1"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<ol><li>第一<\/li><\/ol><p>段落<\/p>/);
});

test("synthesisMessages：有問題時先回答問題；每筆標 [#編號]；要求引用與不得編造", () => {
  const m = synthesisMessages({ docs: [{ id: 1, title: "A", text: "x" }, { id: 2, title: "B", text: "y" }], centerId: 1, question: "比較差異" });
  assert.match(m[0].content, /## 回答：比較差異/);
  assert.match(m[0].content, /只根據提供的資料/);
  assert.match(m[0].content, /\[#編號\]/);
  assert.match(m[1].content, /=== \[#1\]（中心） A/);
  assert.match(m[1].content, /=== \[#2\] B/);
  const fitted = fitDocuments([{ id: 1, text: "字".repeat(100000) }, { id: 2, text: "短" }], { total: 10000, perDoc: 6000 });
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.docs[0].text.length <= 5000);
  assert.ok(estimateUsage(40000).neurons > 0);
});

test("/graph/synthesize：estimate_only 不呼叫 AI；實跑回傳 HTML 與引用；已刪除與重複的編號被略過", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi("## 一句話總結\n兩份專利都是活檢裝置 [#1][#2]，另有 [#3]");
  const est = await call({ DB: db, AI: ai }, "/graph/synthesize", { center: 1, ids: [2, 3, 2], estimate_only: true });
  assert.equal(est.status, 200, JSON.stringify(est.body));
  assert.equal(ai.calls.length, 0, "估算不呼叫 AI");
  assert.deepEqual(est.body.docs.map((d) => d.id), [1, 2]);
  assert.ok(est.body.estimate.neurons > 0);
  const run = await call({ DB: db, AI: ai }, "/graph/synthesize", { center: 1, ids: [2, 3], question: "比較" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, "@cf/google/gemma-4-26b-a4b-it");
  assert.match(ai.calls[0].input.messages[0].content, /## 回答：比較/);
  assert.match(ai.calls[0].input.messages[1].content, /What is claimed is/, "專利附件讀到請求項");
  assert.equal(run.body.invalid_citations, 1, "[#3] 已刪除，不算有效引用");
  assert.match(run.body.html, /data-cite="1"/);
  assert.match(run.body.markdown, /\[#\?\]/);
});

test("/graph/synthesize：少於兩筆不能綜整；AI（MCP 主機）不能用", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  assert.equal((await call({ DB: db, AI: fakeAi("x") }, "/graph/synthesize", { center: 1, ids: [3] })).status, 400);
  assert.equal((await call({ DB: db, AI: fakeAi("x") }, "/graph/synthesize", { center: 1, ids: [2] }, "fieldlog.internal")).status, 403);
  assert.equal((await call({ DB: db, AI: fakeAi("x") }, "/graph/synthesize/save", { center: 1, ids: [2], markdown: "x" }, "fieldlog.internal")).status, 403);
});

test("/graph/synthesize/save：存成【AI彙整】記事，放在中心的資料夾，並與每筆來源建立關聯", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const r = await call({ DB: db }, "/graph/synthesize/save", { center: 1, ids: [1, 2, 3], question: "比較兩份專利", markdown: "## 一句話總結\n都是活檢裝置 [#1][#2]" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const entry = db.sqlite.prepare("SELECT * FROM entries WHERE id = ?").get(r.body.id);
  assert.equal(entry.title, "【AI彙整】關聯綜整：比較兩份專利");
  assert.equal(entry.folder_id, 1);
  assert.match(entry.body, /<h3>一句話總結<\/h3>/);
  assert.match(entry.body, /引用前請回原文確認/);
  const fields = JSON.parse(entry.fields_json);
  assert.equal(fields._kind, "graph_synthesis");
  assert.deepEqual(fields.source_ids, [1, 2], "已刪除的 3 不算來源");
  const rels = db.sqlite.prepare("SELECT to_entry_id, relation_type FROM relations WHERE from_entry_id = ? ORDER BY to_entry_id").all(r.body.id);
  assert.deepEqual(rels.map((x) => [x.to_entry_id, x.relation_type]), [[1, "AI彙整來源"], [2, "AI彙整來源"]]);
});

test("前端：關聯圖有問題欄與 AI 綜整按鈕；先估算再確認；可存、可複製、引用可點", async () => {
  const [html, view] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/graph-view.js")]);
  assert.match(html, /id="graph-question"/);
  assert.match(html, /id="graph-synth"/);
  assert.match(view, /estimate_only: true/);
  assert.match(view, /confirm\(msg\)/);
  assert.match(view, /\/graph\/synthesize\/save/);
  assert.match(view, /\.graph-cite/);
  assert.match(view, /slice\(0, 20\)/);
});
