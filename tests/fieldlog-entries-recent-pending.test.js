/**
 * GET /entries/recent —— 首頁「📥 待處理」清單。
 *
 * 2026-08-07 曾經做成「不分資料夾、列最後動過的 25 筆」（收件匣改叫「最近
 * 作業」），想解決「收件匣空了整個面板就消失」的問題。但代價很快就冒出來：
 * 使用者剛手動搬移／編輯過某筆已經歸檔好的記事，它就會佔著清單最上面的
 * 位置，把真正還沒處理的擠掉——套用「0 天不等待、全部立即歸檔」之後，
 * 暫存區明明已經清空，畫面卻還是一堆舊記事在最上面，看起來像設定沒生效
 * （2026-08-09 實際回報，附截圖）。
 *
 * 改回「只列還沒真正歸檔的」：收件匣（folder_id 空）、暫存區
 * （role='staging'）、AI 剛自動歸類但使用者還沒確認過的（auto_filed_at 有值
 * 且不是 'failed'——那組保留是為了不讓 🤖 標記／confirm-filing 那套審查
 * 機制變成沒有任何入口，只能靠使用者剛好逛進那個資料夾才會發現）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";

function makeFieldlogDB({ folders = [], entries = [] } = {}) {
  const state = { folders: [...folders], entries: [...entries] };

  function exec(sql, args) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql) || /^ALTER TABLE/i.test(sql) || /^DROP/i.test(sql)) {
      return { results: [] };
    }
    if (sql.includes("SELECT id FROM categories WHERE kind = '_seeded'")) return { results: [{ id: 1 }] };
    if (sql.includes("SELECT id FROM categories WHERE kind = '_sources_seeded'")) return { results: [{ id: 1 }] };

    if (sql.includes("FROM entries e LEFT JOIN folders f ON f.id = e.folder_id") && sql.includes("WHERE e.folder_id IS NULL")) {
      const byId = new Map(state.folders.map((f) => [f.id, f]));
      const rows = state.entries
        .filter((e) => {
          const folder = e.folder_id ? byId.get(e.folder_id) : null;
          const staging = folder?.role === "staging";
          const pendingAiReview = (e.auto_filed_at || "") !== "" && e.auto_filed_at !== "failed";
          return e.folder_id === null || e.folder_id === undefined || staging || pendingAiReview;
        })
        .map((e) => {
          const folder = e.folder_id ? byId.get(e.folder_id) : null;
          return {
            id: e.id, folder_id: e.folder_id ?? null, title: e.title,
            created_at: e.created_at, updated_at: e.updated_at || "",
            auto_filed_at: e.auto_filed_at || "", auto_filed_reason: e.auto_filed_reason || "",
            folder_name: folder?.name || null, folder_type: folder?.type || null, folder_role: folder?.role || "",
            att_count: 0,
          };
        })
        .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)) || b.id - a.id);
      return { results: rows };
    }

    return { results: [] };
  }

  return {
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { const r = exec(sql, args); return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? 0 } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
}

async function call(env, path) {
  const req = new Request(`https://x/api${path}`, { headers: { "x-pin": "pin" } });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("已經歸檔到真正資料夾、且不是 AI 待確認的記事，不出現在待處理清單裡", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB({
    folders: [{ id: 1, name: "CVC", type: "產品", role: "" }],
    entries: [
      { id: 101, folder_id: 1, title: "手動歸檔好的舊記事", created_at: "2026-07-30 00:00:00Z", updated_at: "2026-08-07 13:46:00Z" },
    ],
  }) };
  const res = await call(env, "/entries/recent?limit=25");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, [], "已經歸檔完、剛被手動動過的舊記事不該再佔著待處理清單的位置");
});

test("收件匣（folder_id 空）與暫存區的記事都出現在待處理清單裡", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB({
    folders: [
      { id: 1, name: "CVC", type: "產品", role: "" },
      { id: 9, name: "⏳ 暫存區（待歸類）", type: "其他", role: "staging" },
    ],
    entries: [
      { id: 101, folder_id: null, title: "收件匣草稿", created_at: "2026-08-07 10:00:00Z" },
      { id: 102, folder_id: 9, title: "暫存區裡的東西", created_at: "2026-08-06 10:00:00Z" },
      { id: 103, folder_id: 1, title: "已經歸檔好的", created_at: "2026-08-07 12:00:00Z" },
    ],
  }) };
  const res = await call(env, "/entries/recent?limit=25");
  const ids = res.data.map((e) => e.id).sort();
  assert.deepEqual(ids, [101, 102], "只有收件匣跟暫存區的兩筆該出現，已歸檔的那筆不該出現");
});

test("AI 剛自動歸類、使用者還沒確認的記事，即使已經有真正的資料夾也要留在待處理清單裡", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB({
    folders: [{ id: 1, name: "CVC", type: "產品", role: "" }],
    entries: [
      { id: 101, folder_id: 1, title: "AI 剛歸類，還沒確認", created_at: "2026-08-01 00:00:00Z", auto_filed_at: "2026-08-09 02:00:00Z", auto_filed_reason: "講的是導管標準" },
    ],
  }) };
  const res = await call(env, "/entries/recent?limit=25");
  assert.equal(res.data.length, 1, "🤖 標記／confirm-filing 那套審查機制不能因為改了範圍就完全沒有入口");
  assert.equal(res.data[0].auto_filed_at, "2026-08-09 02:00:00Z");
});

test("AI 判斷不出來（auto_filed_at='failed'）的記事也在待處理清單裡（它其實還留在暫存區，靠 role 那條規則涵蓋）", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB({
    folders: [{ id: 9, name: "⏳ 暫存區（待歸類）", type: "其他", role: "staging" }],
    entries: [
      { id: 101, folder_id: 9, title: "AI 判斷不出來", created_at: "2026-08-01 00:00:00Z", auto_filed_at: "failed", auto_filed_reason: "內容太少" },
    ],
  }) };
  const res = await call(env, "/entries/recent?limit=25");
  assert.equal(res.data.length, 1);
});

test("使用者確認過分類（auto_filed_at 被清空）之後，已歸檔的記事就正常退出待處理清單", async () => {
  const env = { FIELD_PIN: "pin", DB: makeFieldlogDB({
    folders: [{ id: 1, name: "CVC", type: "產品", role: "" }],
    entries: [
      { id: 101, folder_id: 1, title: "已確認過的 AI 分類", created_at: "2026-08-01 00:00:00Z", auto_filed_at: "", auto_filed_reason: "" },
    ],
  }) };
  const res = await call(env, "/entries/recent?limit=25");
  assert.deepEqual(res.data, []);
});
