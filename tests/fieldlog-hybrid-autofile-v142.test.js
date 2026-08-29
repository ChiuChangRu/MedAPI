import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  AUTOFILING_DECISION_MODEL,
  AUTOFILING_EMBED_MODEL,
  decideHybridFiling,
  runBaselineFilingReview,
  runHybridAutofile,
} from "../fieldlog/src/lib/autofile.js";
import { MIGRATIONS, SCHEMA } from "../fieldlog/src/lib/schema.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid || 0) } };
        },
      };
    },
  };
}

function makeRealSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) sqlite.exec(sql);
  for (const sql of MIGRATIONS) {
    try { sqlite.exec(sql); } catch { /* 已存在或舊版遷移不適用時等同 D1 ensureSchema */ }
  }
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

test("B 模式：明確規則可以自動分類", () => {
  assert.deepEqual(
    decideHybridFiling({ rule: { folderId: 12, reason: "固定規則" }, vector: null, aiFolderId: null }),
    { action: "auto", folderId: 12, confidence: 0.99, basis: "rule", reason: "固定規則" },
  );
});

test("B 模式：向量與 AI 高信心一致才自動分類", () => {
  const result = decideHybridFiling({
    rule: null,
    vector: { folderId: 7, score: 0.81, margin: 0.09 },
    aiFolderId: 7,
  });
  assert.equal(result.action, "auto");
  assert.equal(result.folderId, 7);
  assert.equal(result.basis, "vector+ai");
});

test("B 模式：一致但相似度或差距不足只能顯示建議", () => {
  assert.equal(decideHybridFiling({
    rule: null,
    vector: { folderId: 7, score: 0.7, margin: 0.09 },
    aiFolderId: 7,
  }).action, "suggest");
  assert.equal(decideHybridFiling({
    rule: null,
    vector: { folderId: 7, score: 0.81, margin: 0.03 },
    aiFolderId: 7,
  }).action, "suggest");
});

test("B 模式：AI 單獨建議或與向量不同意，絕不自動搬", () => {
  const aiOnly = decideHybridFiling({ rule: null, vector: null, aiFolderId: 8 });
  assert.equal(aiOnly.action, "suggest");
  assert.equal(aiOnly.folderId, 8);
  const disagreement = decideHybridFiling({
    rule: null,
    vector: { folderId: 7, score: 0.9, margin: 0.2 },
    aiFolderId: 8,
  });
  assert.equal(disagreement.action, "suggest");
  assert.equal(disagreement.folderId, 8);
});

test("B 模式：沒有可靠結果就留在待分類", () => {
  assert.equal(decideHybridFiling({ rule: null, vector: null, aiFolderId: null }).action, "unresolved");
});

test("真實 SQLite：人工規則自動搬動，AI 單獨判斷只產生待確認建議", async (t) => {
  const { sqlite, DB } = makeRealSqliteD1();
  t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO folders (id, name, type, parent_id, role, created_at) VALUES (1, '⏳ 待分類', '其他', NULL, 'staging', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '檢體針專案', '專案', 'project', NULL, '', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (3, '法規文件', '法規', 'qa_reg', NULL, '', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO autofile_hints (folder_id, keyword, status, created_at) VALUES (2, '檢體針', 'active', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (10, 1, '檢體針測試紀錄', '{}', '', 'text', '2026-08-24 01:00:00Z')").run();
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (11, 1, 'Sampling procedures', '{}', 'ISO 文件內容', 'text', '2026-08-24 01:01:00Z')").run();
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 3, '檢體針既有歸檔', '{}', '', 'text', '2026-08-24 01:02:00Z')").run();
  let aiCalls = 0;
  const outcome = await runHybridAutofile({ DB }, {
    timestamp: () => "2026-08-24 02:00:00Z",
    runAi: async (model) => {
      aiCalls++;
      assert.equal(model, AUTOFILING_DECISION_MODEL);
      return { response: '{"folder_id":3,"reason":"內容屬於法規文件"}' };
    },
  });
  assert.deepEqual(outcome, { checked: 2, auto_moved: 1, suggested: 1, unresolved: 0, errors: 0 });
  assert.equal(aiCalls, 1, "命中人工規則的記事不應再呼叫 AI");
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 10").get().folder_id, 2);
  assert.equal(sqlite.prepare("SELECT status FROM filing_suggestions WHERE entry_id = 10").get().status, "auto_applied");
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 11").get().folder_id, 1, "AI 單獨建議不能搬動記事");
  assert.equal(sqlite.prepare("SELECT status FROM filing_suggestions WHERE entry_id = 11").get().status, "pending");
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 12").get().folder_id, 3, "每日 B 模式不能碰已分類記事");

  const unchanged = await runHybridAutofile({ DB }, {
    timestamp: () => "2026-08-25 02:00:00Z",
    runAi: async () => { throw new Error("內容沒更新，不應再次呼叫 AI"); },
  });
  assert.equal(unchanged.checked, 0, "同一內容隔天不能重複扣 AI 額度");

  const baseline = await runBaselineFilingReview({ DB }, {
    timestamp: () => "2026-08-25 03:00:00Z",
    runAi: async () => { throw new Error("命中人工規則時不應呼叫 AI"); },
  });
  assert.deepEqual(baseline, { checked: 1, moved: 1, kept: 0, suggested: 0, unresolved: 0, errors: 0, remaining: 0 });
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 12").get().folder_id, 2, "明確下令的母體整理才可搬既有正式資料");
  assert.equal(sqlite.prepare("SELECT status FROM filing_suggestions WHERE entry_id = 12").get().status, "baseline_auto_applied");
  const baselineAgain = await runBaselineFilingReview({ DB }, {
    timestamp: () => "2026-08-26 03:00:00Z",
    runAi: async () => { throw new Error("母體記事只能評估一次"); },
  });
  assert.equal(baselineAgain.checked, 0);
});

test("分類模型只使用 Cloudflare Workers AI 的 BGE-M3 與 Llama", () => {
  assert.equal(AUTOFILING_EMBED_MODEL, "@cf/baai/bge-m3");
  assert.equal(AUTOFILING_DECISION_MODEL, "@cf/meta/llama-3.2-3b-instruct");
  assert.doesNotMatch(`${AUTOFILING_EMBED_MODEL} ${AUTOFILING_DECISION_MODEL}`, /gpt|claude|anthropic|openai/i);
});

test("母體整理會凍結最大記事 ID，部署後新增的已分類資料不納入", async (t) => {
  const { sqlite, DB } = makeRealSqliteD1();
  t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '檢體針專案', '專案', 'project', NULL, '', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (3, '法規文件', '法規', 'qa_reg', NULL, '', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO autofile_hints (folder_id, keyword, status, created_at) VALUES (2, '檢體針', 'active', '2026-08-24 00:00:00Z')").run();
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 3, '檢體針既有母體', '{}', '', 'text', '2026-08-24 01:00:00Z')").run();
  sqlite.prepare("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (13, 3, '檢體針部署後新增', '{}', '', 'text', '2026-08-24 02:00:00Z')").run();

  const result = await runBaselineFilingReview({ DB }, {
    timestamp: () => "2026-08-24 03:00:00Z",
    maxEntryId: 12,
    runAi: async () => { throw new Error("人工規則命中不應呼叫 AI"); },
  });
  assert.deepEqual(result, { checked: 1, moved: 1, kept: 0, suggested: 0, unresolved: 0, errors: 0, remaining: 0 });
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 12").get().folder_id, 2);
  assert.equal(sqlite.prepare("SELECT folder_id FROM entries WHERE id = 13").get().folder_id, 3,
    "凍結母體後新增的正式記事不可被這次整理搬動");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM filing_suggestions WHERE entry_id = 13").get().count, 0);
});

test("母體整理由 Cloudflare Workflow 後台觸發，不依賴 Cloud Browser", async () => {
  const [worker, workflow] = await Promise.all([
    read("../fieldlog/src/worker.js"),
    read("../.github/workflows/deploy-fieldlog.yml"),
  ]);
  assert.match(worker, /kind === "baseline_filing_v142"/);
  assert.match(worker, /freeze-existing-filing-corpus/);
  assert.match(worker, /maintenance\.baseline_filing/);
  assert.match(workflow, /workflows trigger fieldlog-embedding-workflow/);
  assert.match(workflow, /"kind":"baseline_filing_v142"/);
});

test("每日排程、狀態表與人工套用／忽略／復原路由完整存在", async () => {
  const [worker, schema, app] = await Promise.all([
    read("../fieldlog/src/worker.js"),
    read("../fieldlog/src/lib/schema.js"),
    read("../fieldlog/public/app.js"),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS filing_suggestions/);
  assert.match(worker, /async scheduled\(_event, env\)[\s\S]*runHybridAutofile\(env/);
  assert.doesNotMatch(worker.match(/async scheduled\(_event, env\)[\s\S]*?\n  },\n};/)?.[0] || "", /runBaselineFilingReview/,
    "母體整理不能掛進每日排程");
  assert.match(worker, /\/admin\/review-existing-filing/);
  assert.match(worker, /\/filing-suggestions\\\/\(\\d\+\)\\\/\(accept\|reject\|undo\)/);
  assert.match(worker, /status = 'overridden'/);
  assert.match(app, /entry-filing-accept/);
  assert.match(app, /entry-filing-reject/);
  assert.match(app, /entry-filing-undo/);
});

test("分類引擎只掃待分類、內容未更新不重跑、且不操作資料夾結構", async () => {
  const source = await read("../fieldlog/src/lib/autofile.js");
  const runner = source.slice(source.indexOf("export async function runHybridAutofile"));
  assert.match(runner, /WHERE e\.folder_id = \?/);
  assert.match(runner, /previous_source_stamp <> source_stamp/);
  assert.match(runner, /UPDATE entries SET folder_id = \?/);
  assert.doesNotMatch(runner, /DELETE FROM folders/);
  assert.doesNotMatch(runner, /UPDATE folders SET (?:name|parent_id)/);
});
