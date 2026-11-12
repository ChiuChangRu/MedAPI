/**
 * v248 關聯圖：GET /api/graph 以一筆記事為中心，合併正式關聯、語意相似、共同編號。
 * node:sqlite 當 D1、假的 Vectorize（getByIds／query）實跑 Worker。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { extractIdentifiers, identifierLikeForms, mergeEdges } from "../fieldlog/src/lib/graph.js";

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
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '專利', '其他專案', 'project', 1, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (3, '法規', '法規', 'qa_reg', NULL, '', ?)", t);
  const e = (id, folder, title, body, status = "done") => q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at, embedding_status) VALUES (?, ?, ?, '{}', ?, 'html', ?, ?)", id, folder, title, body, t, status);
  e(1, 2, "US10463350B2 活檢裝置", "<p>參考 ISO 10993-5 生物相容性</p>");
  e(2, 2, "BD 活檢針型錄", "<p>Mission Core</p>");
  e(3, 3, "ISO 10993-5 細胞毒性", "<p>標準摘要</p>");
  e(4, 2, "競品比較會議", "<p>討論 US10463350 的請求項</p>", "pending");
  e(5, 1, "不相干的記事", "<p>午餐</p>");
  e(6, 2, "已刪除", "<p>US10463350</p>");
  q("UPDATE entries SET deleted_at = ? WHERE id = 6", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, ocr_text, created_at) VALUES (10, 2, 'file', 'BD_catalog.pdf', 'k', 1, 'application/pdf', 'biopsy needle', ?)", t);
  q("INSERT INTO relations (from_entry_id, to_entry_id, relation_type, note, created_at) VALUES (1, 2, '對照廠商產品', '', ?)", t);
  q("INSERT INTO relations (from_entry_id, to_entry_id, relation_type, note, created_at) VALUES (2, 3, '引用標準', '', ?)", t);
}

function fakeVectors(scores) {
  const calls = { getByIds: [], query: 0 };
  return {
    calls,
    async getByIds(ids) { calls.getByIds.push(ids); return ids.includes("entry-1") ? [{ id: "entry-1", values: [0.1, 0.2] }] : []; },
    async query() { calls.query++; return { matches: Object.entries(scores).map(([entryId, score]) => ({ score, metadata: { entryId: String(entryId) } })) }; },
  };
}

async function graph(env, qs) {
  const res = await fieldlogWorker.fetch(new Request(`https://mywiki.example.dev/api/graph?${qs}`, { headers: { "x-pin": "1234" } }), { FIELD_PIN: "1234", ...env });
  return { status: res.status, body: await res.json() };
}

test("extractIdentifiers：專利號（去掉版本碼）、標準號（保留子編號），排除年份", () => {
  assert.deepEqual(
    extractIdentifiers("US10463350B2、US 10463350 B1、CN107666864B、ISO 10993-5、ISO11135、GB/T 16886.1、ASTM F1980、EN 2026 年版、EN 556-1"),
    ["US10463350", "CN107666864", "ISO 10993-5", "ISO 11135", "GB/T 16886.1", "ASTM F1980", "EN 556-1"],
  );
  assert.deepEqual(identifierLikeForms("ISO 11135"), ["ISO 11135", "ISO11135"]);
  assert.deepEqual(extractIdentifiers("沒有編號的文字"), []);
});

test("mergeEdges：同一對節點的多種原因合併成一條，保留每種原因的標籤", () => {
  const merged = mergeEdges([
    { source: 1, target: 2, kind: "relation", label: "對照", relation_id: 7 },
    { source: 2, target: 1, kind: "similar", label: "相似 81%", score: 0.81 },
    { source: 1, target: 3, kind: "identifier", label: "ISO 10993-5" },
  ]);
  assert.equal(merged.length, 2);
  const a = merged.find((e) => e.target === 2 || e.source === 2);
  assert.deepEqual(a.kinds, ["relation", "similar"]);
  assert.equal(a.score, 0.81);
  assert.deepEqual(a.relation_ids, [7]);
  assert.deepEqual(a.reasons, [{ kind: "relation", label: "對照" }, { kind: "similar", label: "相似 81%" }]);
});

test("/graph：正式關聯＋內容相似（過門檻）＋共同編號，排除已刪除；周邊彼此的關聯也畫出來", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const vectors = fakeVectors({ 2: 0.82, 4: 0.71, 5: 0.41, 6: 0.9, 1: 1 });
  const r = await graph({ DB: db, VECTOR_INDEX: vectors }, "type=entry&id=1");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [1, 2, 3, 4], "5 低於門檻、6 已刪除，都不出現");
  const edge = (a, b) => r.body.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  assert.deepEqual(edge(1, 2).kinds.sort(), ["relation", "similar"]);
  assert.ok(edge(1, 4).kinds.includes("similar"));
  assert.ok(edge(1, 4).kinds.includes("identifier"), "競品會議提到同一個專利號");
  assert.ok(edge(1, 3).kinds.includes("identifier"), "共同標準號 ISO 10993-5");
  assert.deepEqual(edge(2, 3).kinds, ["relation"], "周邊節點彼此的正式關聯");
  assert.deepEqual(r.body.identifiers, ["US10463350", "ISO 10993-5"]);
  const center = r.body.nodes.find((n) => n.center);
  assert.equal(center.id, 1);
  assert.equal(center.path, "專利分析 ／ 專利");
  assert.equal(center.category, "project");
  assert.equal(r.body.nodes.find((n) => n.id === 3).category, "qa_reg");
  assert.equal(r.body.nodes.find((n) => n.id === 4).embedded, false);
  assert.equal(r.body.stats.similar, 2);
  assert.equal(r.body.stats.pending_embeddings, 1);
  assert.deepEqual(vectors.calls.getByIds[0], ["entry-1"]);
});

test("/graph：門檻可調；附件以所屬記事為中心；沒有向量索引時仍有關聯與編號", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const strict = await graph({ DB: db, VECTOR_INDEX: fakeVectors({ 2: 0.82, 4: 0.71 }) }, "type=entry&id=1&min=0.8");
  assert.equal(strict.body.stats.similar, 1);
  const viaAttachment = await graph({ DB: db, VECTOR_INDEX: fakeVectors({}) }, "type=attachment&id=10");
  assert.equal(viaAttachment.body.center, 2);
  const noVector = await graph({ DB: db }, "type=entry&id=1");
  assert.equal(noVector.status, 200);
  assert.match(noVector.body.notes.join(""), /尚未設定語意向量索引/);
  assert.ok(noVector.body.nodes.length >= 3);
  assert.equal((await graph({ DB: db }, "type=entry&id=999")).status, 404);
});

test("/graph：中心沒有向量時現場用 bge-m3 算一次", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  let embedCalls = 0;
  const ai = { async run(model) { embedCalls++; assert.equal(model, "@cf/baai/bge-m3"); return { data: [[0.3, 0.4]] }; } };
  const r = await graph({ DB: db, AI: ai, VECTOR_INDEX: fakeVectors({ 1: 0.75 }) }, "type=entry&id=4");
  assert.equal(embedCalls, 1);
  assert.match(r.body.notes.join(""), /現場計算/);
  assert.ok(r.body.nodes.some((n) => n.id === 1));
});

test("前端：右欄與記事頁都有關聯圖入口；圖支援篩選、換中心、存成正式關聯、補齊向量", async () => {
  const [html, view, inspector, app, sw] = await Promise.all([
    read("../fieldlog/public/index.html"), read("../fieldlog/public/graph-view.js"), read("../fieldlog/public/inspector.js"),
    read("../fieldlog/public/app.js"), read("../fieldlog/public/sw.js"),
  ]);
  assert.match(html, /id="folder-preview-graph"/);
  assert.match(html, /id="graph-overlay"/);
  assert.match(html, /data-graph-kind="similar"/);
  assert.match(inspector, /openRelationGraph\?\.\(\{ type: item\.type, id: item\.id \}\)/);
  assert.match(app, /id="e-open-graph"/);
  assert.match(view, /api\("\/relations", \{ method: "POST"/);
  assert.match(view, /\/admin\/backfill-embeddings\?limit=100/);
  assert.match(sw, /graph-view\.js\?v=/);
});
