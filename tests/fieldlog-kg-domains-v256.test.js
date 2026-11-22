/**
 * v256 三大類：專案開發（行政）／技術／法規。每個關鍵字只有一個主要大類，跨大類照樣連線；
 * 星狀圖依大類上色、分群、篩選；樹狀圖＝大類 → 類型 → 關鍵字，可改類型的大類。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { buildEntityGraph, buildKgTree, guessDomain, parseTypeDomains } from "../fieldlog/src/lib/kg.js";

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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  try {
    const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
      method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    }), { FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok", ...env });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = originalFetch; }
}

async function seed(db) {
  await ensureSchema(db, "2026-11-22 00:00:00Z");
  const q = (sql, ...a) => db.sqlite.prepare(sql).run(...a);
  const t = "2026-11-22 01:00:00Z";
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (1, '檢體針', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (10, 1, '滅菌會議', '{}', '', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (11, 1, '稽核待辦', '{}', '', 'html', ?)", t);
  const ents = [[1, "Stella", "人員"], [2, "加速老化", "驗證項目"], [3, "ISO 11135", "標準"], [4, "QMS 稽核", "法規"], [5, "恆溫恆濕機", "設備"], [6, "乾冰", "材料"]];
  for (const [id, name, type] of ents) q("INSERT INTO kg_entities (id, name, norm_key, type_label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, name, name.toLowerCase(), type, id === 6 ? "candidate" : "active", t);
  for (const [e, d] of [[1, 10], [2, 10], [3, 10], [5, 10], [1, 11], [4, 11], [3, 11]]) q("INSERT INTO kg_mentions (entity_id, entry_id, salience, evidence, created_at) VALUES (?, ?, 2, '', ?)", e, d, t);
  q("INSERT INTO kg_relations (subject_id, object_id, relation, entry_id, evidence, created_at) VALUES (2, 3, '依據', 10, '', ?)", t);
}

test("備用歸類：法規、標準→法規；驗證、設備、材料、規格、零件、製程、競品、臨床→技術；其餘→專案開發（行政）", () => {
  const expect = {
    標準: "reg", 法規: "reg", 驗證項目: "tech", 設備: "tech", 材料: "tech", 規格: "tech", 零件: "tech", 製程技術: "tech", 競品: "tech", 臨床部位: "tech",
    人員: "project", 產品: "project", 廠商: "project", 文件: "project", 主題: "project", 地區: "project", 業務: "project",
  };
  for (const [type, domain] of Object.entries(expect)) assert.equal(guessDomain(type), domain, type);
  assert.deepEqual(parseTypeDomains('{"domains":{"供應商":"tech","奇怪":"xyz"}}', ["供應商", "奇怪", "標準"]), { 供應商: "tech", 奇怪: "project", 標準: "reg" }, "AI 給錯值或漏給就用備用規則");
});

test("樹狀資料：大類 → 類型 → 關鍵字，依出現份數排序；候選也列出", () => {
  const tree = buildKgTree([
    { id: 1, name: "Stella", type_group: "人員", domain: "project", docs: 4 },
    { id: 2, name: "加速老化", type_group: "驗證項目", domain: "tech", docs: 4 },
    { id: 7, name: "EO殘留", type_group: "驗證項目", domain: "tech", docs: 3 },
    { id: 6, name: "乾冰", type_group: "材料", domain: "tech", docs: 1, status: "candidate" },
    { id: 3, name: "ISO 11135", type_group: "標準", domain: "reg", docs: 2 },
  ]);
  assert.deepEqual(tree.map((d) => [d.key, d.count]), [["project", 1], ["tech", 3], ["reg", 1]]);
  const tech = tree.find((d) => d.key === "tech");
  assert.equal(tech.types[0].type, "驗證項目");
  assert.deepEqual(tech.types[0].entities.map((e) => e.name), ["加速老化", "EO殘留"]);
  assert.equal(tech.types[1].entities[0].status, "candidate");
});

test("建圖：每個實體帶主要大類；跨大類的明寫關係照樣畫並計數", () => {
  const entities = new Map([[2, { id: 2, name: "加速老化", type_group: "驗證項目", domain: "tech", aliases: [] }], [3, { id: 3, name: "ISO 11135", type_group: "標準", domain: "reg", aliases: [] }]]);
  const entries = new Map([[10, { id: 10, title: "滅菌會議" }]]);
  const g = buildEntityGraph({ center: { type: "entity", id: 2 }, mentions: [{ entity_id: 2, entry_id: 10, salience: 2 }, { entity_id: 3, entry_id: 10, salience: 2 }], entities, entries, relations: [{ subject_id: 2, object_id: 3, relation: "依據", entry_id: 10 }] });
  assert.equal(g.nodes.find((n) => n.id === "e:3").domain, "reg");
  assert.deepEqual(g.domain_counts, { project: 0, tech: 1, reg: 1 });
  assert.equal(g.cross_relations, 1, "技術與法規之間的明寫關係");
});

test("API：第一次讀圖或樹自動補大類；使用者可改類型的大類，之後 AI 不覆蓋；MCP 不能改", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const tree = await call({ DB: db }, "GET", "/kg/tree");
  assert.equal(tree.status, 200, JSON.stringify(tree.body));
  const byKey = Object.fromEntries(tree.body.tree.map((d) => [d.key, d]));
  assert.deepEqual(byKey.project.types.map((t) => t.type), ["人員"]);
  assert.deepEqual(byKey.tech.types.map((t) => t.type).sort(), ["材料", "設備", "驗證項目"]);
  assert.deepEqual(byKey.reg.types.map((t) => t.type).sort(), ["標準", "法規"]);
  assert.equal(db.sqlite.prepare("SELECT source FROM kg_type_domains WHERE type_group = '設備'").get().source, "rule");

  const graph = await call({ DB: db }, "GET", "/kg/graph?entity=1");
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.equal(graph.body.nodes.find((n) => n.title === "Stella").domain, "project");
  assert.ok(graph.body.nodes.some((n) => n.title === "QMS 稽核" && n.domain === "reg"), "人員（行政）連到法規類的關鍵字");

  const mcp = await call({ DB: db }, "POST", `/kg/types/${encodeURIComponent("設備")}`, { domain: "project" }, "fieldlog.internal");
  assert.equal(mcp.status, 403);
  const badDomain = await call({ DB: db }, "POST", `/kg/types/${encodeURIComponent("設備")}`, { domain: "xx" });
  assert.equal(badDomain.status, 400);
  const moved = await call({ DB: db }, "POST", `/kg/types/${encodeURIComponent("設備")}`, { domain: "project" });
  assert.equal(moved.status, 200);
  const row = db.sqlite.prepare("SELECT domain, source FROM kg_type_domains WHERE type_group = '設備'").get();
  assert.deepEqual({ ...row }, { domain: "project", source: "user" });
  const tree2 = await call({ DB: db }, "GET", "/kg/tree");
  const t2 = tree2.body.tree.find((d) => d.key === "project").types.find((t) => t.type === "設備");
  assert.equal(t2.source, "user");
});

test("AI 整理類型時一併判斷大類；使用者指定過的不被覆蓋", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  db.sqlite.prepare("INSERT INTO kg_type_domains (type_group, domain, source, updated_at) VALUES ('人員', 'reg', 'user', '')").run();
  const ai = {
    async run(model, input) {
      const sys = input.messages?.[0]?.content || "";
      if (/實體類型名稱/.test(sys)) return { response: JSON.stringify({ mapping: { 供應商: "廠商" }, domains: { 廠商: "tech", 人員: "project" } }) };
      return { response: JSON.stringify({ entities: [{ name: "NOF", type: "供應商", salience: 3, evidence: "" }], relations: [] }) };
    },
  };
  db.sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 1, '採購', '{}', '<p>NOF 供貨</p>', 'html', '2026-11-22 02:00:00Z')").run();
  const r = await call({ DB: db, AI: ai }, "POST", "/kg/extract", { folder_id: 1, limit: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.sqlite.prepare("SELECT domain FROM kg_type_domains WHERE type_group = '廠商'").get().domain, "tech", "AI 的判斷");
  assert.equal(db.sqlite.prepare("SELECT domain FROM kg_type_domains WHERE type_group = '人員'").get().domain, "reg", "使用者指定的不被 AI 改掉");
});

test("前端：星狀圖依大類分群與篩選、樹狀圖可改大類；版本一致", async () => {
  const html = await read("../fieldlog/public/index.html");
  const kg = await read("../fieldlog/public/entity-graph.js");
  const engine = await read("../fieldlog/public/graph3d.js");
  const worker = await read("../fieldlog/src/worker.js");
  const app = await read("../fieldlog/public/app.js");
  const sw = await read("../fieldlog/public/sw.js");
  for (const id of ["kg-view-star", "kg-view-tree", "kg-domains", "kg-tree"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(kg, /groups: DOMAINS\.map\(/, "把三大類交給 3D 引擎分群");
  assert.match(kg, /group: n\.id === center \? undefined : n\.domain/);
  assert.match(kg, /state\.domainFilter === "all" \|\| n\.domain === state\.domainFilter/);
  assert.match(kg, /\/kg\/types\/\$\{encodeURIComponent\(sel\.dataset\.type\)\}/);
  assert.match(engine, /anchors\.get\(groupOf\.get\(id\)\)/, "引擎把同群節點拉往同一區");
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 256);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
  assert.match(html, new RegExp(`entity-graph\\.js\\?v=${version}`));
});
