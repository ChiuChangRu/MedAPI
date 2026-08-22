/**
 * 語意搜尋（Vectorize）重新上線的回歸測試。
 *
 * 背景：之前做過一版語意搜尋，命中率太差沒上線——根因是完全沒把記事本文
 * （entries.body）向量化（只有附件轉錄/OCR 內容會排入），加上長文件整篇只取
 * 前 2000 字元就丟去 embedding。這次重做補齊兩個缺口：記事一律整篇 embed，
 * 附件內容太長時分段各自 embed。這裡鎖住：
 *   1. chunkText() 分段邏輯本身的數學正確
 *   2. 寫入點（記事新增/更新、6 個附件 OCR/轉錄端點）都有接上 triggerEmbedding
 *   3. GET /api/search/semantic：entry/attachment 分流、同附件多段命中去重、
 *      低分過濾、deleted_at 過濾
 *   4. 60 天垃圾桶永久刪除／單一附件硬刪都會清掉對應向量，不留幽靈結果
 *   5. MCP 新工具 search_fieldlog_semantic 有正確呼叫到 fieldlog 的
 *      Service Binding
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fieldlogWorker, { chunkText } from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

// ---------- chunkText() 單元測試 ----------

test("chunkText：短文字（不超過 chunkSize）不分段，整段回傳", () => {
  const chunks = chunkText("這是一段不長的速記內容。", { chunkSize: 1200 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "這是一段不長的速記內容。");
});

test("chunkText：空字串／null 回傳空陣列", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
});

test("chunkText：長文字依 chunkSize/overlap 正確分段", () => {
  const text = "a".repeat(3000);
  const chunks = chunkText(text, { chunkSize: 1000, overlap: 100, maxChunks: 20 });
  // 每段跨距 900（1000-100），涵蓋到 3000 字大約需要 4 段：0-1000,900-1900,1800-2800,2700-3000
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].length, 1000);
  // 相鄰段落確實重疊 100 字
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100));
});

test("chunkText：極端長文件段數卡在 maxChunks 上限，不會無限分下去", () => {
  const text = "b".repeat(100000);
  const chunks = chunkText(text, { chunkSize: 1200, overlap: 100, maxChunks: 20 });
  assert.equal(chunks.length, 20);
});

test("chunkText：每段都不超過 cap（留在 embedding 模型 token 上限內）", () => {
  const text = "c".repeat(10000);
  const chunks = chunkText(text, { chunkSize: 1200, overlap: 100, cap: 800 });
  for (const c of chunks) assert.ok(c.length <= 800);
});

// ---------- 寫入點靜態分析：確認 8 個地方都接上 triggerEmbedding ----------

test("worker.js：記事新增/更新與 6 個附件 OCR/轉錄寫入點都呼叫了 triggerEmbedding", async () => {
  const src = await read("../fieldlog/src/worker.js");
  // 8 個即時寫入點（2 記事 + 6 附件）＋ 2 個在 /admin/backfill-embeddings 迴圈裡
  // （掃 entries／attachments 各一次呼叫點，不是同一批「即時寫入」）＝ 10
  const count = (src.match(/await triggerEmbedding\(env,/g) || []).length;
  assert.equal(count, 10, "寫入點數量變了要確認是不是漏掛或多掛");
  assert.match(src, /kind: "entry", id: r\.meta\.last_row_id/); // POST /entries
  assert.match(src, /kind: "entry", id, entryId: id,/); // PUT /entries/:id
});

test("worker.js：EmbeddingWorkflow 記事整篇 embed、附件超長才分段，重新分段前會先清舊向量", async () => {
  const src = await read("../fieldlog/src/worker.js");
  assert.match(src, /class EmbeddingWorkflow extends WorkflowEntrypoint/);
  assert.match(src, /const chunks = kind === "entry" \? \[combined\.slice\(0, EMBED_TEXT_CAP\)\] : chunkText\(combined\);/);
  assert.match(src, /await this\.env\.VECTOR_INDEX\.deleteByIds\(vectorIdsForAttachment\(id\)\)/);
});

test("worker.js：/admin/backfill-embeddings 同時掃 entries 與 attachments（先前的缺口）", async () => {
  const src = await read("../fieldlog/src/worker.js");
  const block = src.slice(src.indexOf('"/admin/backfill-embeddings"'), src.indexOf('"/admin/backfill-embeddings"') + 1500);
  assert.match(block, /FROM entries/);
  assert.match(block, /FROM attachments a/);
});

test("fieldlog/wrangler.jsonc：vectorize 與 workflows binding 都有", async () => {
  const cfg = await read("../fieldlog/wrangler.jsonc");
  assert.match(cfg, /"binding":\s*"VECTOR_INDEX"/);
  assert.match(cfg, /"index_name":\s*"fieldlog-embeddings"/);
  assert.match(cfg, /"binding":\s*"EMBEDDING_WORKFLOW"/);
});

test("fieldlog/src/lib/schema.js：attachments 與 entries 都補了向量化狀態欄位", async () => {
  const src = await read("../fieldlog/src/lib/schema.js");
  assert.match(src, /ALTER TABLE attachments ADD COLUMN vector_id/);
  assert.match(src, /ALTER TABLE attachments ADD COLUMN embedding_status/);
  assert.match(src, /ALTER TABLE entries ADD COLUMN vector_id/);
  assert.match(src, /ALTER TABLE entries ADD COLUMN embedding_status/);
});

// ---------- 垃圾桶清理：永久刪除／單一附件硬刪都要清掉對應向量 ----------

test("trash.js：permanentlyDeleteTrashItem 收到 vectorIndex 時會呼叫 deleteByIds 清掉 entry-*／att-*-N", async () => {
  const { permanentlyDeleteTrashItem } = await import("../fieldlog/src/lib/trash.js");
  const deleted = [];
  const vectorIndex = { async deleteByIds(ids) { deleted.push(...ids); } };
  const tables = {
    trash_items: [{ id: 1, item_type: "entry", item_id: 42, title: "t", state: "trashed", purge_after: "2026-01-01" }],
    entries: [{ id: 42, parent_entry_id: null, deleted_at: "x" }],
    attachments: [{ id: 7, entry_id: 42, key: "k7" }],
  };
  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("UPDATE trash_items SET state = 'purging'")) return { results: [], changes: 1 };
    if (q === "SELECT * FROM trash_items WHERE id = ? AND state = 'purging'") return { results: [tables.trash_items[0]] };
    if (q.startsWith("SELECT id FROM entries WHERE id IN")) return { results: tables.entries.filter((e) => args.includes(e.id)) };
    if (q.startsWith("SELECT id FROM entries WHERE parent_entry_id")) return { results: [] };
    if (q.startsWith("SELECT id, key FROM attachments WHERE entry_id IN")) return { results: tables.attachments.filter((a) => args.includes(a.entry_id)) };
    return { results: [], changes: 0 };
  }
  const db = {
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { return { meta: { changes: exec(sql, args).changes || 0 } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  const files = { async delete() {} };
  const result = await permanentlyDeleteTrashItem(db, files, 1, vectorIndex);
  assert.ok(result);
  assert.ok(deleted.includes("entry-42"));
  assert.ok(deleted.includes("att-7-0"));
  assert.ok(deleted.includes("att-7-19"));
});

test("attachments.js：deleteAttachmentDeep 接受 vectorIndex 並清掉對應向量", async () => {
  const src = await read("../fieldlog/src/lib/attachments.js");
  assert.match(src, /export async function deleteAttachmentDeep\(db, files, attachmentId, \{ logHistory, vectorIndex \}\)/);
  assert.match(src, /vectorIndex\.deleteByIds\(ids\)/);
});

test("worker.js：三個呼叫點都把 env.VECTOR_INDEX 傳進垃圾桶清理／單一附件刪除", async () => {
  const src = await read("../fieldlog/src/worker.js");
  assert.match(src, /permanentlyDeleteTrashItem\(db, env\.FILES, Number\(trashItemMatch\[1\]\), env\.VECTOR_INDEX\)/);
  assert.match(src, /permanentlyDeleteTrashItem\(db, env\.FILES, Number\(item\.id\), env\.VECTOR_INDEX\)/);
  assert.match(src, /purgeExpiredTrash\(env\.DB, env\.FILES, now\(\), env\.VECTOR_INDEX\)/);
  assert.match(src, /deleteAttachmentDeep\(db, env\.FILES, id, \{ logHistory, vectorIndex: env\.VECTOR_INDEX \}\)/);
});

// ---------- GET /api/search/semantic：entry/attachment 分流、去重、過濾 ----------

function makeSearchEnv({ matches }) {
  resetSchemaCacheForTests();
  const entries = {
    10: { id: 10, title: "滅菌相關的品質偏差", body: "內容", body_format: "text", folder_id: 1, deleted_at: "" },
    11: { id: 11, title: "已刪除的記事", body: "x", body_format: "text", folder_id: 1, deleted_at: "2026-01-01" },
  };
  const attachments = {
    20: { id: 20, entry_id: 10, filename: "report.pdf", kind: "file", transcript: "", ocr_text: "abc", deleted_at: "" },
  };
  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT e.*, f.name AS folder_name, f.type AS folder_type FROM entries e")) {
      const e = entries[args[0]];
      if (!e || e.deleted_at) return { results: [] };
      return { results: [{ ...e }] };
    }
    if (q.startsWith("SELECT a.*, e.title AS entry_title")) {
      const a = attachments[args[0]];
      if (!a) return { results: [] };
      const e = entries[a.entry_id];
      if (!e || e.deleted_at) return { results: [] };
      return { results: [{ ...a, entry_title: e.title, folder_id: e.folder_id }] };
    }
    return { results: [], changes: 0 };
  }
  const db = {
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { return { meta: { changes: 0 } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return {
    FIELD_PIN: "pin", DB: db,
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    VECTOR_INDEX: { async query() { return { matches }; } },
  };
}

test("GET /api/search/semantic：entry 與 attachment 分流回傳，各自帶分數", async () => {
  const env = makeSearchEnv({
    matches: [
      { score: 0.9, metadata: { kind: "entry", entryId: "10" } },
      { score: 0.8, metadata: { kind: "attachment", attachmentId: "20", entryId: "10" } },
    ],
  });
  const res = await fieldlogWorker.fetch(new Request("https://x/api/search/semantic?q=滅菌&pin=pin"), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].entry.id, 10);
  assert.equal(data.entries[0].score, 0.9);
  assert.equal(data.attachments.length, 1);
  assert.equal(data.attachments[0].attachment.id, 20);
});

test("GET /api/search/semantic：低於 VECTOR_MIN_SCORE 的結果被濾掉", async () => {
  const env = makeSearchEnv({ matches: [{ score: 0.2, metadata: { kind: "entry", entryId: "10" } }] });
  const res = await fieldlogWorker.fetch(new Request("https://x/api/search/semantic?q=x&pin=pin"), env);
  const data = await res.json();
  assert.equal(data.entries.length, 0);
});

test("GET /api/search/semantic：同一份附件的多段命中只留分數最高的一筆", async () => {
  const env = makeSearchEnv({
    matches: [
      { score: 0.7, metadata: { kind: "attachment", attachmentId: "20", entryId: "10" } },
      { score: 0.95, metadata: { kind: "attachment", attachmentId: "20", entryId: "10" } },
      { score: 0.6, metadata: { kind: "attachment", attachmentId: "20", entryId: "10" } },
    ],
  });
  const res = await fieldlogWorker.fetch(new Request("https://x/api/search/semantic?q=x&pin=pin"), env);
  const data = await res.json();
  assert.equal(data.attachments.length, 1);
  assert.equal(data.attachments[0].score, 0.95);
});

test("GET /api/search/semantic：已刪除的記事不會出現在結果裡（垃圾桶清理有延遲的雙層防護）", async () => {
  const env = makeSearchEnv({ matches: [{ score: 0.9, metadata: { kind: "entry", entryId: "11" } }] });
  const res = await fieldlogWorker.fetch(new Request("https://x/api/search/semantic?q=x&pin=pin"), env);
  const data = await res.json();
  assert.equal(data.entries.length, 0);
});

test("GET /api/search/semantic：查詢詞為空回 400", async () => {
  const env = makeSearchEnv({ matches: [] });
  const res = await fieldlogWorker.fetch(new Request("https://x/api/search/semantic?q=&pin=pin"), env);
  assert.equal(res.status, 400);
});

// ---------- MCP 工具：search_fieldlog_semantic ----------

test("mcp/src/worker.js：search_fieldlog_semantic 呼叫 FIELDLOG service binding 的 /api/search/semantic", async () => {
  const src = await read("../mcp/src/worker.js");
  assert.match(src, /name: "search_fieldlog_semantic"/);
  assert.match(src, /new URL\("https:\/\/fieldlog\.internal\/api\/search\/semantic"\)/);
  assert.match(src, /search_fieldlog_semantic: "語意搜尋隨身記"/);
});

test("mcp/src/worker.js：search_fieldlog_semantic 真的呼叫 env.FIELDLOG.fetch 並格式化結果", async () => {
  const worker = (await import("../mcp/src/worker.js")).default;
  const fetchCalls = [];
  const env = {
    MCP_PIN: "mcp-pin",
    FIELD_PIN: "field-pin",
    FIELDLOG: {
      async fetch(url) {
        fetchCalls.push(url);
        return new Response(JSON.stringify({
          entries: [{ score: 0.88, entry: { id: 5, title: "滅菌偏差", body: "內容", body_format: "text", created_at: "2026-08-01", folder_name: "品質", folder_type: "查廠" } }],
          attachments: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  };
  const req = new Request("https://x/mcp?pin=mcp-pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_fieldlog_semantic", arguments: { query: "滅菌相關的品質問題" } },
    }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.isError, undefined);
  assert.match(fetchCalls[0], /\/api\/search\/semantic\?q=/);
  assert.match(fetchCalls[0], /pin=field-pin/);
  assert.match(result.content[0].text, /滅菌偏差/);
});

// 2026-08-16：第一次補跑一口氣排了 298 筆（附件每份最多再切 20 段），把當天的
// 免費 Neurons 額度吃掉，害正在進行的錄音即時轉錄被安全門檻擋下來停掉。向量化
// 是背景的加值功能，不該跟現場錄音搶額度。
test("補跑端點要分批，不可一次把待處理的資料全部排進去", async () => {
  const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const start = worker.indexOf('path === "/admin/backfill-embeddings"');
  assert.ok(start > -1, "要有補跑端點");
  const block = worker.slice(start, start + 2600);
  assert.match(block, /searchParams\.get\("limit"\)/, "要能用 limit 參數控制單次批量");
  assert.match(block, /FROM entries[\s\S]*?LIMIT \?/, "記事查詢要帶 LIMIT，不能整批撈");
  assert.match(block, /FROM attachments[\s\S]*?LIMIT \?/, "附件查詢要帶 LIMIT，不能整批撈");
  assert.match(block, /remaining/, "要回報還剩幾筆，呼叫端才知道要不要再打一次");
});

test("轉錄安全門檻要讀常數，不可寫死數字讓訊息與實際值對不上", async () => {
  const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const guard = worker.match(/if \(cloudUsed \+ reserved \+ estimate > .*?\) \{/)?.[0] || "";
  assert.ok(guard, "要有安全門檻判斷");
  assert.match(guard, /AI_AUTO_SAFE_NEURONS/,
    "門檻必須讀 AI_AUTO_SAFE_NEURONS：寫死數字會變成畫面說一個值、實際卡在另一個值");
  assert.doesNotMatch(guard, /\d{4}/, "比較值不可出現寫死的數字");
});
