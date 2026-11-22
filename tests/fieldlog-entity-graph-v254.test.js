/**
 * v254 實體關聯圖（知識圖譜試做）：AI 自行判斷實體與類型、統計判斷關聯強弱、合併前給使用者確認、可輸入關鍵字當中心。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  buildEntityGraph, isUsefulEntityName, mergeCandidates, normalizeEntityKey, parseKgResult, parseTypeGroups, specificity,
} from "../fieldlog/src/lib/kg.js";

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

/** 假 AI：依記事標題回不同的實體；類型歸群把「供應商」併進「廠商」 */
function fakeAi(byTitle) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const user = input.messages?.[1]?.content || "";
      if (/實體類型名稱/.test(input.messages?.[0]?.content || "")) return { response: JSON.stringify({ mapping: { 供應商: "廠商", 廠商: "廠商", 材料: "材料", 設備: "設備" } }) };
      const title = (user.match(/^標題：(.*)$/m) || [])[1] || "";
      return { response: JSON.stringify(byTitle[title] || { entities: [], relations: [] }) };
    },
  };
}

async function seed(db) {
  await ensureSchema(db, "2026-11-22 00:00:00Z");
  const q = (sql, ...a) => db.sqlite.prepare(sql).run(...a);
  const t = "2026-11-22 01:00:00Z";
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (1, '檢體針', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '廠商', '其他專案', 'project', 1, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (3, '別的專案', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (10, 1, '外針採購', '{}', '<p>NOF Corporation 供應 Lipidure-CM5206 給外針披膜使用。</p>', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (11, 2, '披膜試驗', '{}', '<p>Lipidure-CM5206 在超音波噴塗機上試驗，NOF 提供樣品。</p>', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 1, '2026-W47 工作週報', '{\"_kind\":\"weekly_report\"}', '', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (13, 1, '【AI彙整】某次會議', '{}', '', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (14, 3, '別的專案記事', '{}', '<p>無關</p>', 'html', ?)", t);
}

const BY_TITLE = {
  外針採購: {
    entities: [
      { name: "NOF Corporation", type: "供應商", salience: 3, evidence: "NOF Corporation 供應 Lipidure-CM5206" },
      { name: "Lipidure-CM5206", type: "材料", salience: 3, evidence: "Lipidure-CM5206 給外針披膜使用" },
      { name: "測試", type: "其他", salience: 1, evidence: "" },
      { name: "2026/11/22", type: "日期", salience: 1, evidence: "" },
    ],
    relations: [{ subject: "NOF Corporation", relation: "供應", object: "Lipidure-CM5206", evidence: "NOF Corporation 供應 Lipidure-CM5206" }],
  },
  披膜試驗: {
    entities: [
      { name: "Lipidure-CM5206", type: "材料", salience: 3, evidence: "Lipidure-CM5206 在超音波噴塗機上試驗" },
      { name: "超音波噴塗機", type: "設備", salience: 2, evidence: "超音波噴塗機上試驗" },
      { name: "NOF", type: "廠商", salience: 1, evidence: "AI 自己改寫的句子，原文沒有" },
    ],
    relations: [],
  },
};

test("純函式：名稱正規化、一般詞過濾、原文依據查核、合併候選、代表性", () => {
  assert.equal(normalizeEntityKey("NOF Corporation"), "nof");
  assert.equal(normalizeEntityKey("ＮＯＦ"), "nof", "全形半形統一");
  assert.equal(normalizeEntityKey("邦特生物科技股份有限公司"), "邦特生物科技");
  assert.equal(isUsefulEntityName("測試"), false);
  assert.equal(isUsefulEntityName("2026/11/22"), false);
  assert.equal(isUsefulEntityName("ISO 11135"), true);
  const parsed = parseKgResult(BY_TITLE.披膜試驗, "Lipidure-CM5206 在超音波噴塗機上試驗，NOF 提供樣品。");
  assert.equal(parsed.entities.find((e) => e.name === "NOF").evidence, "", "原文找不到的依據要清空，不留 AI 改寫");
  assert.ok(parsed.entities.find((e) => e.name === "超音波噴塗機").evidence);
  const p2 = parseKgResult(BY_TITLE.外針採購, "NOF Corporation 供應 Lipidure-CM5206 給外針披膜使用。");
  assert.deepEqual(p2.entities.map((e) => e.name), ["NOF Corporation", "Lipidure-CM5206"], "一般詞與日期被擋");
  assert.equal(p2.relations[0].relation, "供應");
  assert.deepEqual(mergeCandidates({ id: 1, name: "BD" }, [{ id: 2, name: "Becton Dickinson" }]).map((c) => c.reason), ["縮寫對得上"]);
  assert.deepEqual(mergeCandidates({ id: 1, name: "Lipidure CM5206" }, [{ id: 2, name: "Lipidure-CM5206 polymer" }]).map((c) => c.reason), ["名稱互相包含"]);
  assert.equal(mergeCandidates({ id: 1, name: "鈦合金" }, [{ id: 2, name: "不鏽鋼" }]).length, 0);
  assert.ok(specificity(1, 100) > specificity(60, 100), "越多份資料都出現的實體越不具代表性");
  assert.deepEqual(parseTypeGroups('{"mapping":{"供應商":"廠商"}}', ["供應商", "材料"]), { 供應商: "廠商", 材料: "材料" });
});

test("建圖：以實體為中心，列出提到它的資料與常一起出現的實體，原文明寫的關係畫成標字的線", () => {
  const entities = new Map([
    [1, { id: 1, name: "NOF", type_group: "廠商", aliases: [] }],
    [2, { id: 2, name: "Lipidure-CM5206", type_group: "材料", aliases: [] }],
    [3, { id: 3, name: "超音波噴塗機", type_group: "設備", aliases: [] }],
  ]);
  const entries = new Map([[10, { id: 10, title: "外針採購" }], [11, { id: 11, title: "披膜試驗" }]]);
  const mentions = [
    { entity_id: 1, entry_id: 10, salience: 3, evidence: "a" }, { entity_id: 2, entry_id: 10, salience: 3, evidence: "b" },
    { entity_id: 2, entry_id: 11, salience: 3, evidence: "c" }, { entity_id: 3, entry_id: 11, salience: 2, evidence: "d" },
  ];
  const relations = [{ subject_id: 1, object_id: 2, relation: "供應", entry_id: 10, evidence: "a" }];
  const g = buildEntityGraph({ center: { type: "entity", id: 2 }, mentions, entities, entries, relations });
  assert.equal(g.center, "e:2");
  assert.ok(g.nodes.some((n) => n.id === "d:10") && g.nodes.some((n) => n.id === "d:11"));
  assert.ok(g.nodes.some((n) => n.id === "e:1") && g.nodes.some((n) => n.id === "e:3"));
  const rel = g.edges.find((e) => e.kind === "relation");
  assert.equal(rel.label, "供應");
  assert.deepEqual(new Set(g.types), new Set(["材料", "廠商", "設備"]));
  const byDoc = buildEntityGraph({ center: { type: "entry", id: 10 }, mentions, entities, entries, relations });
  assert.ok(byDoc.nodes.some((n) => n.id === "d:11"), "透過共同實體找到另一份資料");
});

test("擷取：只擷取資料夾子樹、跳過週報與 AI 彙整；類型自動歸群；名稱相近只產生合併建議", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi(BY_TITLE);
  const status0 = await call({ DB: db, AI: ai }, "GET", "/kg/status?folder_id=1");
  assert.equal(status0.body.total, 2, "週報、【AI彙整】不算；別的專案不在範圍");
  assert.equal(status0.body.skipped, 2);
  const r = await call({ DB: db, AI: ai }, "POST", "/kg/extract", { folder_id: 1, limit: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.processed, 2);
  assert.equal(r.body.remaining, 0);
  const names = db.sqlite.prepare("SELECT name FROM kg_entities ORDER BY id").all().map((x) => x.name);
  assert.deepEqual(names, ["NOF Corporation", "Lipidure-CM5206", "超音波噴塗機"], "NOF 與 NOF Corporation 正規化後同鍵，不重複建立");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM kg_relations").get().n, 1);
  assert.equal(db.sqlite.prepare("SELECT type_group FROM kg_type_groups WHERE type_label = '供應商'").get().type_group, "廠商");
  const again = await call({ DB: db, AI: ai }, "POST", "/kg/extract", { folder_id: 1 });
  assert.equal(again.body.processed, 0, "內容沒變就不重複擷取");
  const status1 = await call({ DB: db, AI: ai }, "GET", "/kg/status?folder_id=1");
  assert.equal(status1.body.done, 2);
});

test("關鍵字當中心、合併要使用者確認、標為雜訊會隱藏並回饋給下次擷取", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  // 先放一個名稱相近的既有實體，讓擷取時產生合併建議
  db.sqlite.prepare("INSERT INTO kg_entities (name, norm_key, type_label, created_at) VALUES ('Lipidure CM5206 polymer', 'lipidurecm5206polymer', '材料', '2026-11-01')").run();
  const ai = fakeAi(BY_TITLE);
  await call({ DB: db, AI: ai }, "POST", "/kg/extract", { folder_id: 1, limit: 3 });

  const search = await call({ DB: db, AI: ai }, "GET", "/kg/search?q=lipidure");
  assert.equal(search.body.results[0].name, "Lipidure-CM5206");
  const top = await call({ DB: db, AI: ai }, "GET", "/kg/search?q=");
  assert.equal(top.body.top, true);

  const graph = await call({ DB: db, AI: ai }, "GET", "/kg/graph?q=Lipidure-CM5206");
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.ok(graph.body.nodes.some((n) => n.title === "外針採購"));
  assert.ok(graph.body.nodes.some((n) => n.title === "超音波噴塗機"));
  assert.equal(graph.body.pending_merges, 1);
  const missing = await call({ DB: db, AI: ai }, "GET", "/kg/graph?q=不存在的東西");
  assert.equal(missing.status, 404);

  const merges = await call({ DB: db, AI: ai }, "GET", "/kg/merges");
  assert.equal(merges.body.results.length, 1);
  const m = merges.body.results[0];
  const keepId = [m.a_id, m.b_id].find((id) => id !== 1);
  const lipidureId = db.sqlite.prepare("SELECT id FROM kg_entities WHERE name = 'Lipidure-CM5206'").get().id;
  const ok = await call({ DB: db, AI: ai }, "POST", `/kg/merges/${m.id}`, { action: "accept", keep_id: lipidureId });
  assert.equal(ok.body.keep_name, "Lipidure-CM5206");
  const kept = db.sqlite.prepare("SELECT aliases_json FROM kg_entities WHERE id = ?").get(lipidureId);
  assert.match(kept.aliases_json, /Lipidure CM5206 polymer/, "另一個名稱變成別名");
  assert.ok(keepId);
  const dup = await call({ DB: db, AI: ai }, "POST", `/kg/merges/${m.id}`, { action: "accept" });
  assert.equal(dup.status, 409);

  const machineId = db.sqlite.prepare("SELECT id FROM kg_entities WHERE name = '超音波噴塗機'").get().id;
  const hide = await call({ DB: db, AI: ai }, "POST", `/kg/entities/${machineId}`, { action: "hide" });
  assert.equal(hide.status, 200);
  const g2 = await call({ DB: db, AI: ai }, "GET", `/kg/graph?entity=${lipidureId}`);
  assert.ok(!g2.body.nodes.some((n) => n.title === "超音波噴塗機"), "雜訊不再顯示");
  // 內容改了重新擷取時，提示裡會帶上使用者標為雜訊的名稱
  db.sqlite.prepare("UPDATE entries SET updated_at = '2026-11-23 00:00:00Z' WHERE id = 11").run();
  ai.calls.length = 0;
  await call({ DB: db, AI: ai }, "POST", "/kg/extract", { folder_id: 1 });
  const prompt = ai.calls.find((c) => /標題：披膜試驗/.test(c.input.messages?.[1]?.content || ""));
  assert.match(prompt.input.messages[0].content, /不要再抽的名稱：超音波噴塗機/);
  assert.ok(!db.sqlite.prepare("SELECT 1 FROM kg_mentions m JOIN kg_entities k ON k.id = m.entity_id WHERE k.name = '超音波噴塗機' AND k.status = 'active'").get());
});

test("AI（MCP）只能讀不能擷取或合併；沒有 AI 綁定回 501", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  assert.equal((await call({ DB: db, AI: fakeAi({}) }, "POST", "/kg/extract", { folder_id: 1 }, "fieldlog.internal")).status, 403);
  assert.equal((await call({ DB: db, AI: fakeAi({}) }, "POST", "/kg/merges/1", { action: "accept" }, "fieldlog.internal")).status, 403);
  assert.equal((await call({ DB: db, AI: fakeAi({}) }, "POST", "/kg/entities/1", { action: "hide" }, "fieldlog.internal")).status, 403);
  assert.equal((await call({ DB: db }, "POST", "/kg/extract", { folder_id: 1 })).status, 501);
  assert.equal((await call({ DB: db, AI: fakeAi({}) }, "GET", "/kg/status?folder_id=1", null, "fieldlog.internal")).status, 200);
});

test("前端：資料夾工具列與文件關聯圖都能打開實體關聯圖；版本 254 四處一致", async () => {
  const html = await read("../fieldlog/public/index.html");
  const app = await read("../fieldlog/public/app.js");
  const gv = await read("../fieldlog/public/graph-view.js");
  const kg = await read("../fieldlog/public/entity-graph.js");
  const sw = await read("../fieldlog/public/sw.js");
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(html, /id="btn-folder-kg"/);
  assert.match(html, /id="kg-overlay"/);
  assert.match(html, /id="kg-search" type="search"/);
  assert.match(html, /<script src="entity-graph\.js\?v=\d+"><\/script>/);
  assert.match(app, /\$\("btn-folder-kg"\)\.onclick = \(\) => \{ if \(CURRENT_FOLDER\) window\.openEntityGraph/);
  assert.match(gv, /\$\("graph-kg"\)\.onclick/);
  assert.match(kg, /window\.openEntityGraph = openEntityGraph/);
  assert.match(kg, /待確認合併/);
  assert.match(sw, /"entity-graph\.js\?v=\d+"/);
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 254);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
});
