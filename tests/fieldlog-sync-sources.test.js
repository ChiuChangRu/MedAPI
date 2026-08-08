/**
 * 外部來源同步引擎測試（規格書 I 項目 1–5 ＋ 規格書 II 項目 8/12 的落地驗收）。
 *
 * 取代原本的 fieldlog-import-litdb 測試——那支端點是一次性匯入（來源寫死、
 * 欄位白名單、只 INSERT），現在是 sources 表驅動的可重複同步。核心驗收：
 *   - 通用渲染：任何欄位（含沒列舉過的新欄位）自動進 body 可搜尋
 *   - patentResults 進 analysis_json（AI 產出與人工內容分離），配方／FTO 查得到
 *   - content-hash upsert：沒變不動、變了只改同步區、人工註記保留
 *   - 來源消失標 _orphaned 不刪除
 *   - 新增一個全新格式的來源＝往 sources 表加一列，全程不改程式碼
 *   - cron scheduled handler 與手動端點走同一套引擎
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { renderTree } from "../fieldlog/src/lib/render.js";
import { SYNC_START, SYNC_END } from "../fieldlog/src/lib/sync.js";

function fakePaper(overrides = {}) {
  return {
    id: "P01", title: "示範論文", authors: "作者", year: "2024", venue: "期刊",
    doc_type: "期刊論文", tags: ["TPU", "親水塗層"], purpose: "測試用",
    abstract_note: "這是摘要全文", value_to_project: "對專案的價值",
    links: { doi: "https://doi.org/x" },
    patentResults: {
      full: {
        summary: "專利分析摘要",
        examples: ["PTGL1000 4.25 wt%、PVP K-90 5.00 wt%、UV 0.9 J/cm²"],
        red_flags: "核心專利 2027 到期，FTO 風險低",
        next_actions: ["驗證固化條件"],
      },
    },
    ...overrides,
  };
}

function stubFetch(byUrl) {
  globalThis.fetch = async (url) => {
    const match = Object.entries(byUrl).find(([key]) => String(url).includes(key));
    if (!match) return { ok: false, status: 404 };
    const [, respond] = match;
    if (respond.status && respond.status !== 200) return { ok: false, status: respond.status };
    return { ok: true, json: async () => respond };
  };
}

function makeDB() {
  const tables = { folders: [], entries: [], categories: [], history: [], sources: [], sync_log: [] };
  const nextId = { folders: 1, entries: 1, categories: 1, history: 1, sources: 1, sync_log: 1 };
  const unhandled = [];

  function insert(table, row) {
    const id = nextId[table]++;
    tables[table].push({ id, ...row });
    return id;
  }

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q) || /^DROP INDEX/i.test(q)) return none;

    // ---- schema 種子 ----
    if (q === "SELECT id FROM categories WHERE kind = '_seeded' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_seeded");
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id FROM categories WHERE kind = '_sources_seeded' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_sources_seeded");
      return { results: row ? [row] : [], changes: 0 };
    }
    // 一次性的資料夾分類重整（2026-08-08，見 lib/schema.js 的
    // applyFolderReorg20260808）掛在 scheduled() 裡，這個測試檔會直接呼叫
    // worker 的 scheduled handler，所以也會跑到它——這裡的假 folders／entries
    // 表本來就是空的，讓它安靜套用（或安靜判定已套用過）即可，不是這個
    // 測試檔要驗的東西。
    if (q === "SELECT id FROM categories WHERE kind = '_folder_reorg_2026_08_08' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_folder_reorg_2026_08_08");
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q.startsWith("INSERT INTO categories") || q.startsWith("INSERT OR IGNORE INTO categories")) {
      const kind = q.includes("VALUES ('_seeded'") ? "_seeded"
        : q.includes("VALUES ('_sources_seeded'") ? "_sources_seeded"
        : q.includes("VALUES ('_folder_reorg_2026_08_08'") ? "_folder_reorg_2026_08_08" : args[0];
      insert("categories", { kind });
      return { results: [], changes: 1 };
    }
    if (
      q === "UPDATE folders SET name = ?, category = ? WHERE id = ?"
      || q === "UPDATE folders SET category = ? WHERE id = ?"
      || q === "UPDATE folders SET parent_id = ? WHERE parent_id = ?"
      || q === "UPDATE folders SET parent_id = NULL WHERE parent_id = ?"
      || q === "DELETE FROM folders WHERE id = ?"
      || q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?"
      || q === "UPDATE entries SET folder_id = NULL, updated_at = ? WHERE folder_id = ?"
      || q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?"
    ) {
      return none;
    }
    if (q.startsWith("INSERT OR IGNORE INTO sources")) {
      const [key, label, url, items_path, id_field, title_field, folder_parent, folder_type, created_at] = args;
      if (tables.sources.some((s) => s.key === key)) return none;
      const id = insert("sources", { key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled: 1, last_synced_at: "", created_at });
      return { results: [], lastRowId: id, changes: 1 };
    }

    // ---- sources（同步引擎＋CRUD）----
    if (q === "SELECT * FROM sources WHERE enabled = 1 AND key = ?") {
      return { results: tables.sources.filter((s) => s.enabled === 1 && s.key === args[0]), changes: 0 };
    }
    if (q === "SELECT * FROM sources WHERE enabled = 1 ORDER BY id") {
      return { results: tables.sources.filter((s) => s.enabled === 1), changes: 0 };
    }
    if (q === "SELECT * FROM sources ORDER BY id") {
      return { results: tables.sources, changes: 0 };
    }
    if (q === "SELECT id FROM sources WHERE key = ?") {
      const row = tables.sources.find((s) => s.key === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT * FROM sources WHERE id = ?") {
      const row = tables.sources.find((s) => s.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id, key FROM sources WHERE id = ?") {
      const row = tables.sources.find((s) => s.id === args[0]);
      return { results: row ? [{ id: row.id, key: row.key }] : [], changes: 0 };
    }
    if (q.startsWith("INSERT INTO sources (key, label, url")) {
      const [key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled, created_at] = args;
      const id = insert("sources", { key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled, last_synced_at: "", created_at });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q.startsWith("UPDATE sources SET label = ?")) {
      const row = tables.sources.find((s) => s.id === args[8]);
      if (row) Object.assign(row, {
        label: args[0], url: args[1], items_path: args[2], id_field: args[3],
        title_field: args[4], folder_parent: args[5], folder_type: args[6], enabled: args[7],
      });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE sources SET last_synced_at = ? WHERE id = ?") {
      const row = tables.sources.find((s) => s.id === args[1]);
      if (row) row.last_synced_at = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM sources WHERE id = ?") {
      const before = tables.sources.length;
      tables.sources = tables.sources.filter((s) => s.id !== args[0]);
      return { results: [], changes: before - tables.sources.length };
    }

    // ---- 同步引擎：entries 預載／upsert／孤兒標記 ----
    if (q.startsWith("SELECT id, fields_json, body FROM entries WHERE json_extract")) {
      const rows = tables.entries.filter((e) => {
        try {
          const f = JSON.parse(e.fields_json || "{}");
          return f._sid || f.litdb_id;
        } catch { return false; }
      });
      return { results: rows.map((e) => ({ id: e.id, fields_json: e.fields_json, body: e.body })), changes: 0 };
    }
    if (q === "SELECT id FROM folders WHERE parent_id IS NULL AND name = ?") {
      const row = tables.folders.find((f) => f.parent_id === null && f.name === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id FROM folders WHERE parent_id = ? AND name = ?") {
      const row = tables.folders.find((f) => f.parent_id === args[0] && f.name === args[1]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)") {
      const id = insert("folders", { name: args[0], type: args[1], parent_id: args[2], created_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    // 暫存區資料夾（自動歸類用）：cron 除了同步之外也會跑一次自動歸類，
    // 第一件事就是確保暫存區存在
    if (q === "SELECT * FROM folders WHERE role = ? LIMIT 1") {
      const row = tables.folders.find((f) => f.role === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "INSERT INTO folders (name, type, parent_id, role, created_at) VALUES (?, ?, NULL, ?, ?)") {
      const id = insert("folders", { name: args[0], type: args[1], parent_id: null, role: args[2], created_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    // 天數設定（resolveAutoFileDays）：cron 沒人設定過，退回環境變數／預設值
    if (q === "SELECT value FROM settings WHERE key = ?") {
      return { results: [], changes: 0 };
    }
    if (q.startsWith("INSERT INTO entries (folder_id, title, fields_json, body, analysis_json")) {
      const id = insert("entries", {
        folder_id: args[0], title: args[1], fields_json: args[2], body: args[3],
        analysis_json: args[4], analysis_at: args[5], analysis_model: args[6], created_at: args[7],
      });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "UPDATE entries SET title = ?, fields_json = ?, body = ?, analysis_json = ?, analysis_at = ?, analysis_model = ?, updated_at = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[7]);
      if (row) Object.assign(row, {
        title: args[0], fields_json: args[1], body: args[2],
        analysis_json: args[3], analysis_at: args[4], analysis_model: args[5], updated_at: args[6],
      });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE entries SET fields_json = ?, updated_at = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[2]);
      if (row) { row.fields_json = args[0]; row.updated_at = args[1]; }
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q.startsWith("INSERT INTO sync_log")) {
      insert("sync_log", {
        source_key: args[0], started_at: args[1], finished_at: args[2],
        inserted: args[3], updated: args[4], skipped: args[5], orphaned: args[6], errors: args[7], created_at: args[8],
      });
      return { results: [], changes: 1 };
    }
    if (q.startsWith("INSERT INTO history")) {
      insert("history", { entry_id: args[0], folder_id: args[1], action: args[2], detail: args[3], created_at: args[4] });
      return { results: [], changes: 1 };
    }

    // ---- 來歷面板：履歷讀取 ----
    if (q === "SELECT id FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [{ id: row.id }] : [], changes: 0 };
    }
    if (q === "SELECT id, action, detail, folder_id, created_at FROM history WHERE entry_id = ? ORDER BY id DESC LIMIT ?") {
      const rows = tables.history
        .filter((h) => h.entry_id === args[0])
        .sort((a, b) => b.id - a.id)
        .slice(0, args[1]);
      return { results: rows, changes: 0 };
    }

    // ---- PUT /entries/:id 的欄位合併測試用 ----
    if (q === "SELECT * FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "UPDATE entries SET title = ?, body = ?, fields_json = ?, folder_id = ?, body_format = ?, auto_filed_at = ?, auto_filed_reason = ?, updated_at = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[8]);
      if (row) {
        Object.assign(row, {
          title: args[0], body: args[1], fields_json: args[2], folder_id: args[3], body_format: args[4],
          auto_filed_at: args[5], auto_filed_reason: args[6], updated_at: args[7],
        });
      }
      return { results: [], changes: row ? 1 : 0 };
    }
    // 排程順手跑「彙整分類規則建議」（見 reviewAutoFileCorrections）；這個測試
    // 檔沒有相關資料，回空結果讓它安靜跳過就好，不是這裡要測的東西
    if (q === "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'active' ORDER BY id") {
      return { results: [] };
    }
    if (q === "SELECT id FROM autofile_corrections WHERE COALESCE(reviewed_at, '') = ''") {
      return { results: [] };
    }

    unhandled.push(q);
    return none;
  }

  const db = {
    tables, unhandled,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const copy = (row) => (row && typeof row === "object" ? { ...row } : row);
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results.map(copy) }; },
        async first() { return copy(exec(sql, args).results[0]) || null; },
        async run() {
          const r = exec(sql, args);
          return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? r.results.length } };
        },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db = makeDB()) {
  resetSchemaCacheForTests();
  return { FIELD_PIN: "pin", DB: db };
}

async function call(env, path, options = {}) {
  const req = new Request(`https://x/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-pin": "pin", ...(options.headers || {}) },
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

const LITDB_URLS = {
  coating: "coating/papers.json",
  biopsy: "biopsy_patents.json",
  packaging: "packaging/papers.json",
};

test("首次同步：sources 種子驅動、建資料夾、通用渲染進 body、patentResults 進 analysis_json", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01", title: "親水塗層配方" })] },
    [LITDB_URLS.biopsy]: { papers: [fakePaper({ id: "B01", title: "活檢針擊發機構", patentResults: undefined })] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(res.status, 200);
  const coating = res.data.results.find((r) => r.source === "coating");
  assert.equal(coating.inserted, 1);

  const root = env.DB.tables.folders.find((f) => f.name === "LitDB 文獻庫" && f.parent_id === null);
  assert.ok(root, "母資料夾要建起來");
  assert.ok(env.DB.tables.folders.some((f) => f.parent_id === root.id && f.name === "親水塗層文獻"));

  const entry = env.DB.tables.entries.find((e) => e.title === "親水塗層配方");
  // 通用渲染：鍵名與值都進 body（黑名單制，沒列舉過的欄位也自動進來）
  assert.match(entry.body, /purpose/);
  assert.match(entry.body, /這是摘要全文/);
  assert.match(entry.body, /tags：TPU、親水塗層/, "tags 要進 body（fields 之外也要能搜到）");
  assert.match(entry.body, /https:\/\/doi\.org\/x/);
  assert.ok(entry.body.includes(SYNC_START) && entry.body.includes(SYNC_END), "body 要帶同步區標記");
  // AI 深度分析產物與 body 分離
  assert.doesNotMatch(entry.body, /PTGL1000/, "patentResults 不進 body");
  assert.match(entry.analysis_json, /PTGL1000 4\.25 wt%/, "配方要在 analysis_json（規格書驗收：搜 PTGL1000 找得到）");
  assert.match(entry.analysis_json, /FTO/);
  assert.equal(entry.analysis_model, "litdb-原生");

  const fields = JSON.parse(entry.fields_json);
  assert.equal(fields._sid, "coating:P01");
  assert.equal(fields._source_key, "coating");
  assert.ok(fields._content_hash, "要存內容 hash");
  assert.equal(fields["標籤"], "TPU、親水塗層");

  // 沒有 patentResults 的來源不硬塞 analysis
  const biopsyEntry = env.DB.tables.entries.find((e) => e.title === "活檢針擊發機構");
  assert.equal(biopsyEntry.analysis_json, "");

  assert.equal(env.DB.tables.sync_log.length, 3, "每個來源一列 sync_log");
  assert.ok(env.DB.tables.sources.every((s) => s.last_synced_at), "last_synced_at 要更新");
  assert.deepEqual(env.DB.unhandled, [], "不該下出預期外的 SQL");
});

test("hash 沒變的資料重跑是 skipped，不會重複建立也不會改寫", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const env = makeEnv();
  await call(env, "/admin/sync-sources", { method: "POST" });
  const bodyAfterFirst = env.DB.tables.entries[0].body;
  const second = await call(env, "/admin/sync-sources", { method: "POST" });
  const coating = second.data.results.find((r) => r.source === "coating");
  assert.equal(coating.skipped, 1);
  assert.equal(coating.inserted, 0);
  assert.equal(env.DB.tables.entries.length, 1);
  assert.equal(env.DB.tables.entries[0].body, bodyAfterFirst, "沒變就一個字都不該動");
});

test("內容變更只改寫同步區，使用者在標記外加的人工註記保留", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01", abstract_note: "第一版摘要" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const env = makeEnv();
  await call(env, "/admin/sync-sources", { method: "POST" });

  // 使用者在同步區之後加了自己的註記
  const entry = env.DB.tables.entries[0];
  entry.body = `${entry.body}\n\n我的人工註記：這篇要拿去對照百賽飛的型錄`;

  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01", abstract_note: "第二版摘要（重新分析過）" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const res = await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(res.data.results.find((r) => r.source === "coating").updated, 1);

  const updated = env.DB.tables.entries[0];
  assert.match(updated.body, /第二版摘要/);
  assert.doesNotMatch(updated.body, /第一版摘要/, "同步區要整段換新");
  assert.match(updated.body, /我的人工註記/, "標記外的人工內容不能被同步蓋掉");
});

test("第一版匯入器寫的舊資料（只有 litdb_id、沒有標記）升級後不重複、litdb_id 保留", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({
    id: 1, folder_id: 9, title: "舊版匯入的紀錄",
    fields_json: JSON.stringify({ "作者": "舊作者", litdb_id: "coating:P01" }),
    body: "**用途**：舊版白名單渲染的內容",
  });
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01", title: "親水塗層配方" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const res = await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(res.data.results.find((r) => r.source === "coating").updated, 1, "應該是更新既有列，不是新插一列");
  assert.equal(db.tables.entries.length, 1, "不能因為換了識別欄位而重複匯入");
  const fields = JSON.parse(db.tables.entries[0].fields_json);
  assert.equal(fields.litdb_id, "coating:P01", "舊識別欄位保留");
  assert.equal(fields._sid, "coating:P01", "新識別欄位補上");
  assert.ok(db.tables.entries[0].body.includes(SYNC_START), "升級後帶同步區標記");
});

test("來源端消失的資料標 _orphaned 保留，不自動刪除", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01" }), fakePaper({ id: "P02", title: "會消失的" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const env = makeEnv();
  await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(env.DB.tables.entries.length, 2);

  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01" })] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const res = await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(res.data.results.find((r) => r.source === "coating").orphaned, 1);
  assert.equal(env.DB.tables.entries.length, 2, "記事不能被刪");
  const gone = env.DB.tables.entries.find((e) => e.title === "會消失的");
  assert.equal(JSON.parse(gone.fields_json)._orphaned, true);
});

test("單一來源讀取失敗不中斷其他來源，錯誤記進 sync_log 並在回應標示", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01" })] },
    [LITDB_URLS.biopsy]: { status: 500 },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const env = makeEnv();
  const res = await call(env, "/admin/sync-sources", { method: "POST" });
  assert.equal(res.status, 502, "有來源失敗要用狀態碼講，不能靜默");
  assert.equal(res.data.results.find((r) => r.source === "coating").inserted, 1, "沒失敗的來源照常匯入");
  assert.match(res.data.results.find((r) => r.source === "biopsy").error, /HTTP 500/);
  const failLog = env.DB.tables.sync_log.find((l) => l.source_key === "biopsy");
  assert.match(failLog.errors, /HTTP 500/);
});

test("新增一個全新格式的來源（不同陣列鍵名／id 欄位）＝加一列 sources，不改程式碼", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [] },
    [LITDB_URLS.biopsy]: { papers: [] },
    [LITDB_URLS.packaging]: { papers: [] },
    "market/reports.json": { reports: [{ code: "M01", title: "活檢針市場報告", summary: "2035 年市場規模預測", region: "亞太" }] },
  });
  const env = makeEnv();
  const created = await call(env, "/sources", {
    method: "POST",
    body: JSON.stringify({
      key: "market", label: "市場分析", url: "https://example.com/market/reports.json",
      items_path: "reports", id_field: "code",
    }),
  });
  assert.equal(created.status, 200);

  const res = await call(env, "/admin/sync-sources?source=market", { method: "POST" });
  assert.equal(res.data.results.length, 1);
  assert.equal(res.data.results[0].inserted, 1);
  const entry = env.DB.tables.entries.find((e) => e.title === "活檢針市場報告");
  assert.ok(entry, "新格式的資料要能進來");
  assert.match(entry.body, /2035 年市場規模預測/);
  assert.match(entry.body, /region/, "沒列舉過的新欄位也要自動可搜尋");
  assert.equal(JSON.parse(entry.fields_json)._sid, "market:M01");
});

test("sources CRUD：重複 key 擋下、可停用、刪除不動既有記事", async () => {
  stubFetch({ [LITDB_URLS.coating]: { papers: [] }, [LITDB_URLS.biopsy]: { papers: [] }, [LITDB_URLS.packaging]: { papers: [] } });
  const env = makeEnv();
  await call(env, "/sources"); // 觸發 schema/種子
  const dup = await call(env, "/sources", {
    method: "POST",
    body: JSON.stringify({ key: "coating", label: "重複", url: "https://x/y.json" }),
  });
  assert.equal(dup.status, 409);

  const list = await call(env, "/sources");
  const coating = list.data.sources.find((s) => s.key === "coating");
  const off = await call(env, `/sources/${coating.id}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(env.DB.tables.sources.find((s) => s.key === "coating").enabled, 0);

  env.DB.tables.entries.push({ id: 50, folder_id: 1, title: "既有記事", fields_json: JSON.stringify({ _sid: "coating:P01" }), body: "x" });
  const del = await call(env, `/sources/${coating.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.ok(!env.DB.tables.sources.some((s) => s.key === "coating"));
  assert.equal(env.DB.tables.entries.length, 1, "刪來源不刪記事");
});

test("cron scheduled handler 跑同一套引擎：自動同步全部來源並寫 sync_log", async () => {
  stubFetch({
    [LITDB_URLS.coating]: { papers: [fakePaper({ id: "P01" })] },
    [LITDB_URLS.biopsy]: { papers: [fakePaper({ id: "B01" })] },
    [LITDB_URLS.packaging]: { papers: [] },
  });
  const db = makeDB();
  resetSchemaCacheForTests();
  await fieldlogWorker.scheduled({}, { DB: db });
  assert.equal(db.tables.entries.length, 2, "排程要自動匯入");
  assert.equal(db.tables.sync_log.length, 3);
  assert.deepEqual(db.unhandled, [], "不該下出預期外的 SQL");
});

test("PUT /entries/:id 的 fields 是合併不是取代——內部識別欄位不會被前端編輯抹掉", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({
    id: 7, folder_id: 1, title: "同步進來的記事", body: "內容",
    fields_json: JSON.stringify({ "作者": "舊作者", _sid: "coating:P01", _content_hash: "abc", litdb_id: "coating:P01" }),
  });
  const res = await call(env, "/entries/7", {
    method: "PUT",
    body: JSON.stringify({ title: "改過標題", body: "內容", fields: { "作者": "新作者" } }),
  });
  assert.equal(res.status, 200);
  const fields = JSON.parse(db.tables.entries.find((e) => e.id === 7).fields_json);
  assert.equal(fields["作者"], "新作者", "有送的欄位要更新");
  assert.equal(fields._sid, "coating:P01", "沒送的內部欄位要保留——被抹掉的話隔天 cron 會整批重複匯入");
  assert.equal(fields._content_hash, "abc");
  assert.equal(fields.litdb_id, "coating:P01");
});

test("PUT /entries/:id：來源同步管理的記事不能升級為富文字（body_format='html' 要被擋）", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({
    id: 8, folder_id: 1, title: "同步進來的記事", body: "內容", body_format: "text",
    fields_json: JSON.stringify({ _sid: "coating:P01", litdb_id: "coating:P01" }),
  });
  const res = await call(env, "/entries/8", {
    method: "PUT",
    body: JSON.stringify({ body_format: "html", body: "<p>內容</p>" }),
  });
  assert.equal(res.status, 400, "同步管理的記事不能切成富文字");
  assert.equal(db.tables.entries.find((e) => e.id === 8).body_format, "text", "拒絕後格式不能被改掉");
});

test("PUT /entries/:id：一般記事可以升級為富文字，內容會被清理過再存", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 9, folder_id: 1, title: "一般記事", body: "內容", body_format: "text", fields_json: "{}" });
  const res = await call(env, "/entries/9", {
    method: "PUT",
    body: JSON.stringify({ body_format: "html", body: '<p onclick="evil()">內容</p><script>alert(1)</script>' }),
  });
  assert.equal(res.status, 200);
  const row = db.tables.entries.find((e) => e.id === 9);
  assert.equal(row.body_format, "html");
  assert.equal(row.body, "<p>內容</p>", "存進資料庫前要清掉不在白名單的屬性與標籤");
});

test("沒帶 PIN 一律擋下（同步端點與 sources 管理都在 PIN 之內）", async () => {
  resetSchemaCacheForTests();
  const env = { FIELD_PIN: "pin", DB: makeDB() };
  for (const [path, method] of [["/admin/sync-sources", "POST"], ["/sources", "GET"], ["/sources", "POST"]]) {
    const res = await fieldlogWorker.fetch(new Request(`https://x/api${path}`, { method }), env);
    assert.equal(res.status, 401, `${method} ${path} 沒 PIN 要 401`);
  }
});

// ---------- 通用渲染器本身 ----------

test("renderTree：巢狀物件／陣列展開、鍵名可搜、黑名單鍵排除、超長截斷", () => {
  const text = renderTree({
    id: "P01", // 黑名單
    purpose: "測試",
    patent: { red_flags: "FTO 風險低", examples: ["配方A", "配方B"] },
    steps: [{ name: "清洗", temp: "60C" }],
  });
  assert.doesNotMatch(text, /P01/, "id 在黑名單");
  assert.match(text, /purpose：測試/);
  assert.match(text, /red_flags：FTO 風險低/, "鍵名要進輸出，能直接當關鍵字搜");
  assert.match(text, /配方A、配方B/);
  assert.match(text, /name：清洗/);

  const long = renderTree({ a: "x".repeat(70000) });
  assert.ok(long.length < 61000);
  assert.match(long, /已截斷/);
});

// ---------- 「這筆資料的來歷」面板 ----------

test("GET /entries/:id/history 讀得到操作履歷（history 表原本只寫不讀）", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 5, folder_id: 1, title: "有履歷的記事", fields_json: "{}", body: "" });
  db.tables.history.push({ id: 1, entry_id: 5, folder_id: 1, action: "新增紀錄", detail: "現場採集", created_at: "2026-07-20 10:00:00Z" });
  db.tables.history.push({ id: 2, entry_id: 5, folder_id: 1, action: "來源同步更新", detail: "coating：親水塗層配方", created_at: "2026-07-26 02:00:00Z" });
  db.tables.history.push({ id: 3, entry_id: 99, folder_id: 1, action: "別人的履歷", detail: "", created_at: "2026-07-26 03:00:00Z" });

  const res = await call(env, "/entries/5/history");
  assert.equal(res.status, 200);
  assert.equal(res.data.history.length, 2, "只回這筆的履歷");
  assert.equal(res.data.history[0].action, "來源同步更新", "新到舊排序");
  assert.deepEqual(db.unhandled, [], "不該下出預期外的 SQL");
});

test("GET /entries/:id/history 查無此記事回 404，不是回空陣列", async () => {
  const env = makeEnv();
  const res = await call(env, "/entries/9999/history");
  assert.equal(res.status, 404);
});

test("來歷面板：raw 檢視會截斷超長欄位並標示總長度，不靜默砍掉", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const fn = app.match(/function clipForRaw\(row\)[\s\S]*?\n}/)[0];
  assert.match(fn, /共 \$\{v\.length\} 字/, "截斷要講總長度");
  for (const key of ["body", "transcript", "ocr_text", "analysis_json"]) {
    assert.match(fn, new RegExp(`"${key}"`), `${key} 是可能超長的欄位，要納入截斷`);
  }
});

test("來歷面板：同步來的資料要標示來源，孤兒要警示，AI 產出與人工內容分得清楚", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const origin = app.match(/function provenanceOrigin\(fields, history\)[\s\S]*?\n}/)[0];
  assert.match(origin, /_sid \|\| fields\.litdb_id/, "新舊兩種同步識別碼都要認");
  assert.match(origin, /_orphaned/, "來源已移除要警示");
  assert.match(origin, /透過 MCP/, "要分得出是對話裡建立的");
  // 三態時間戳一定要翻成人看得懂的話，不能直接把 'skipped' 丟到畫面上
  const state = app.match(/function stateLabel\(value\)[\s\S]*?\n}/)[0];
  for (const s of ["skipped", "processing", "failed"]) {
    assert.match(state, new RegExp(`"${s}"`), `${s} 狀態要有對應說明`);
  }
  assert.match(app, /AI 對這筆做過什麼/, "AI 動過哪裡要獨立一段");
});
