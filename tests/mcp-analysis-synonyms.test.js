/**
 * MCP 端的深度解析呈現＋同義詞入庫測試。
 *
 * 兩個核心不變量：
 * 1. AI 產出必須標示——analysis_json 的內容在搜尋與讀取時都要明講是 AI 解析，
 *    否則下次對話會把 AI 推論當成現場證據引用（最危險的失效模式）。
 * 2. 同義詞表在 D1、add_synonym 只能 INSERT——查不到的當下在對話裡補一組，
 *    立刻生效，而且永遠改不掉、刪不掉既有對照。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, { resetSynonymCacheForTests } from "../mcp/src/worker.js";

// ---------- 假 DB_FIELDLOG ----------

// missingColumns：模擬「fieldlog 還沒跑 migration，資料庫比程式碼舊」。
// 這些欄位在 PRAGMA 裡查不到，SELECT 到它們也會照真實 D1 的行為丟 no such column。
function makeDB({ entries = [], attachments = [], synonyms = null, sources = [], syncLog = [], missingColumns = [] } = {}) {
  const state = { entries, attachments, synonyms, sources, syncLog, synonymInserts: [] };
  const ENTRY_COLUMNS = ["id", "folder_id", "title", "body", "body_format", "fields_json", "created_at", "analysis_json"];
  const ATT_COLUMNS = ["id", "entry_id", "kind", "filename", "transcript", "ocr_text", "offset_secs", "analysis_json"];
  function exec(sql, args = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    const pragma = q.match(/^PRAGMA table_info\((\w+)\)$/);
    if (pragma) {
      const all = pragma[1] === "entries" ? ENTRY_COLUMNS : pragma[1] === "attachments" ? ATT_COLUMNS : [];
      return { results: all.filter((c) => !missingColumns.includes(c)).map((name) => ({ name })) };
    }
    // 真實 D1 的行為：SELECT 到不存在的欄位就整句失敗
    for (const col of missingColumns) {
      if (new RegExp(`\\b[ea]\\.${col}\\b`).test(q)) {
        throw new Error(`D1_ERROR: no such column: e.${col} at offset 43: SQLITE_ERROR`);
      }
    }
    if (q.startsWith("SELECT canonical, aliases_json, codes_json FROM synonyms")) {
      if (state.synonyms === null) throw new Error("no such table: synonyms");
      return { results: state.synonyms };
    }
    if (q.startsWith("CREATE TABLE IF NOT EXISTS synonyms")) {
      if (state.synonyms === null) state.synonyms = [];
      return { results: [] };
    }
    if (q.startsWith("INSERT INTO synonyms")) {
      state.synonymInserts.push(args);
      state.synonyms.push({ canonical: args[0], aliases_json: args[1], codes_json: args[2] });
      return { results: [] };
    }
    // 不比對完整欄位清單：選用欄位（body_format／analysis_json）會依資料庫實際
    // 有什麼而增減，寫死清單的話反而驗不出「資料庫少欄位」這個真實情境
    if (q.startsWith("SELECT e.id, e.folder_id, e.title, e.body,")) {
      return { results: state.entries };
    }
    if (q.startsWith("SELECT a.id AS att_id,")) {
      return { results: state.attachments };
    }
    if (q === "SELECT * FROM entries WHERE id = ?") {
      const row = state.entries.find((e) => e.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q === "SELECT * FROM attachments WHERE entry_id = ? ORDER BY id") {
      return { results: state.attachments.filter((a) => a.entry_id === args[0]) };
    }
    if (q === "SELECT * FROM attachments WHERE id = ?") {
      const row = state.attachments.find((a) => a.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q === "SELECT id, title FROM entries WHERE id = ?") {
      const row = state.entries.find((e) => e.id === args[0]);
      return { results: row ? [{ id: row.id, title: row.title }] : [] };
    }
    if (q.startsWith("SELECT key, label, url, enabled, last_synced_at FROM sources")) {
      if (!state.sources.length && !state.syncLog.length) throw new Error("no such table: sources");
      return { results: state.sources };
    }
    if (q.startsWith("SELECT * FROM sync_log")) {
      return { results: state.syncLog };
    }
    return { results: [] };
  }
  const makeStmt = (sql, args) => ({
    async all() { return { results: exec(sql, args).results }; },
    async first() { return exec(sql, args).results[0] || null; },
    async run() { exec(sql, args); return { meta: {} }; },
  });
  return { state, prepare(sql) { return { bind: (...args) => makeStmt(sql, args), ...makeStmt(sql, []) }; } };
}

async function callTool(env, name, args) {
  const req = new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin", ...env });
  return (await res.json()).result;
}

function entryRow(overrides = {}) {
  return {
    id: 1, folder_id: 2, title: "同步進來的文獻", body: "一般內文", fields_json: "{}",
    created_at: "2026-07-26", folder_name: "親水塗層文獻", folder_type: "文獻庫",
    analysis_json: "", analysis_at: "", analysis_model: "", analysis_profile: "",
    ...overrides,
  };
}

test("search_fieldlog 掃得到 analysis_json，且標示命中在 AI 解析段", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    entries: [entryRow({
      analysis_json: JSON.stringify({ patentResults: { full: { examples: ["PTGL1000 4.25 wt%"] } } }),
      analysis_model: "litdb-原生",
    })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "PTGL1000" });
  const text = result.content[0].text;
  assert.match(text, /\[entry 1\]/, "要命中");
  assert.match(text, /命中在 AI 解析段/, "命中只出現在解析段時要標示，不能讓人以為是現場紀錄");
});

test("get_fieldlog_entry：AI 解析段獨立呈現且明講是 AI 產出；內部欄位與同步標記不顯示", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    entries: [entryRow({
      fields_json: JSON.stringify({ "作者": "王小明", _sid: "coating:P01", _content_hash: "abc" }),
      body: "<!-- sync:start 以下為來源自動同步區，同步時會整段改寫 -->\n- purpose：測試\n<!-- sync:end 在這行之後加的註記不會被同步動到 -->",
      analysis_json: JSON.stringify({ patentResults: { full: { red_flags: "FTO 風險低" } } }),
      analysis_model: "litdb-原生", analysis_at: "2026-07-26 02:00:00Z",
    })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 1 });
  const text = result.content[0].text;
  assert.match(text, /AI 深度解析/);
  assert.match(text, /litdb-原生/);
  assert.match(text, /AI 產出的整理／推論，不是現場原始紀錄/);
  assert.match(text, /red_flags：FTO 風險低/);
  assert.match(text, /作者.*王小明/);
  assert.doesNotMatch(text, /_sid|_content_hash/, "內部欄位是雜訊");
  assert.doesNotMatch(text, /<!-- sync:/, "同步標記只給引擎認位置，不該顯示");
});

test("get_fieldlog_entry：body_format='html' 的記事要剝成純文字顯示，不能帶標籤", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    entries: [entryRow({
      body_format: "html",
      body: '<p>第一段</p><p>第二段<br>換行</p><img src="/api/file/x" alt="收據.jpg">',
    })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 1 });
  const text = result.content[0].text;
  assert.match(text, /第一段/);
  assert.match(text, /第二段\n換行/);
  assert.match(text, /\[圖片：收據\.jpg\]/);
  assert.doesNotMatch(text, /<p>|<img|<br>/, "html 格式的記事顯示時不該留下標籤");
});

test("search_fieldlog：body_format='html' 的記事一樣搜得到，命中片段是剝過標籤的純文字", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    entries: [entryRow({
      title: "富文字記事",
      body_format: "html",
      body: "<p>提到 PTGL1000 這個代號</p>",
    })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "PTGL1000" });
  const text = result.content[0].text;
  assert.match(text, /\[entry 1\]/, "html 格式的內文也要能被搜到");
  assert.doesNotMatch(text, /<p>/, "命中片段不該帶 HTML 標籤");
});

// ---------- 資料庫比程式碼舊時仍要能查（2026-08-01 實際事故的迴歸測試）----------
//
// 當天 search_fieldlog 100% 失敗，回 no such column: e.body_format。原本就有
// 「欄位不存在時退回舊欄位集」的機制，但它只切換 analysis_json，而 body_format
// 兩個版本的 SQL 都帶著——於是兩次都失敗、錯誤照樣往外拋。
// 現在改成查 PRAGMA 決定要 SELECT 哪些欄位，下面幾項就是不讓它退化回去。

test("entries 少了 body_format（fieldlog 還沒跑 migration）時，搜尋照常運作", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    missingColumns: ["body_format"],
    entries: [entryRow({ title: "UV膠測試", body: "北回 41431 太稀" })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "UV膠" });
  assert.notEqual(result.isError, true, `不該報錯，實得：${result.content[0].text}`);
  assert.match(result.content[0].text, /\[entry 1\]/, "少一個選用欄位不該讓整支查詢掛掉");
});

test("entries 少了 analysis_json 時，搜尋照常運作", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    missingColumns: ["analysis_json"],
    entries: [entryRow({ title: "UV膠測試", body: "北回 41431" })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "UV膠" });
  assert.notEqual(result.isError, true, `不該報錯，實得：${result.content[0].text}`);
  assert.match(result.content[0].text, /\[entry 1\]/);
});

test("兩個選用欄位同時都缺（最舊的資料庫）也要能查", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    missingColumns: ["body_format", "analysis_json"],
    entries: [entryRow({ title: "UV膠測試", body: "北回 41431" })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "UV膠" });
  assert.notEqual(result.isError, true, `不該報錯，實得：${result.content[0].text}`);
  assert.match(result.content[0].text, /\[entry 1\]/);
});

test("get_fieldlog_entry：來源已移除的孤兒記事要有警示", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    entries: [entryRow({ fields_json: JSON.stringify({ _orphaned: true, _sid: "coating:GONE" }) })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "get_fieldlog_entry", { id: 1 });
  assert.match(result.content[0].text, /來源資料已從外部知識庫移除/);
});

test("get_fieldlog_attachment：AI 解析段跟逐字稿一起分頁，並標示 AI 產出", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    attachments: [{
      id: 9, entry_id: 1, kind: "file", filename: "報告.pdf", created_at: "2026-07-26",
      transcript: "", ocr_text: "本文內容",
      analysis_json: JSON.stringify({ 決議: "改用配方B" }), analysis_model: "claude", analysis_at: "2026-07-26",
      offset_secs: null,
    }],
    entries: [entryRow({ id: 1 })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "get_fieldlog_attachment", { id: 9 });
  const text = result.content[0].text;
  assert.match(text, /本文內容/);
  assert.match(text, /AI 深度解析/);
  assert.match(text, /決議：改用配方B/);
  assert.match(text, /不是現場原始紀錄/);
});

test("add_synonym：只 INSERT、立刻生效（下一次查詢就用得到新對照）", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    synonyms: [], // 表已存在但是空的 → 用出廠預設值之外也能加新組
    entries: [entryRow({ title: "抗結痂披膜試作紀錄", body: "第三次試作" })],
  });
  const env = { DB_FIELDLOG: db };
  const added = await callTool(env, "add_synonym", { canonical: "抗結痂披膜", aliases: ["BaClear"] });
  assert.match(added.content[0].text, /已新增同義詞組/);
  assert.equal(db.state.synonymInserts.length, 1, "只該有一筆 INSERT");

  // 快取已失效 → 下一次 tools/call 重新載入 D1 的表 → 「BaClear」查得到「抗結痂披膜」
  const result = await callTool(env, "search_fieldlog", { query: "BaClear" });
  assert.match(result.content[0].text, /抗結痂披膜試作紀錄/, "新同義詞要立刻生效");
});

test("add_synonym：沒給任何 alias/code 報錯，不寫入", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({ synonyms: [] });
  const result = await callTool({ DB_FIELDLOG: db }, "add_synonym", { canonical: "某某", aliases: [] });
  assert.equal(result.isError, true);
  assert.equal(db.state.synonymInserts.length, 0);
});

test("synonyms 表讀不到時退回出廠預設值，搜尋照常運作（HD管 → 體外血液處理用導管）", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    synonyms: null, // 表不存在；CREATE 之後 seed 會寫進去
    entries: [entryRow({ title: "體外血液處理用導管規格", body: "" })],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "HD管" });
  assert.match(result.content[0].text, /體外血液處理用導管規格/, "出廠同義詞要能用");
  assert.ok(db.state.synonymInserts.length >= 16, "第一次會把出廠預設值 seed 進表");
});

test("查無結果的提示改叫使用者用 add_synonym，不再叫人改原始碼", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({ synonyms: [], entries: [] });
  const result = await callTool({ DB_FIELDLOG: db }, "search_fieldlog", { query: "不存在的內部代號XYZ" });
  const text = result.content[0].text;
  assert.match(text, /add_synonym/);
  assert.doesNotMatch(text, /mcp\/src\/synonyms\.json/, "不該再叫使用者去改原始碼");
});

test("sync_status：列出來源最後同步時間與最近的同步紀錄", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({
    synonyms: [],
    sources: [{ key: "coating", label: "親水塗層文獻", url: "https://x", enabled: 1, last_synced_at: "2026-07-27 02:00:00Z" }],
    syncLog: [{ id: 1, source_key: "coating", finished_at: "2026-07-27 02:00:05Z", inserted: 2, updated: 1, skipped: 99, orphaned: 0, errors: "" }],
  });
  const result = await callTool({ DB_FIELDLOG: db }, "sync_status", {});
  const text = result.content[0].text;
  assert.match(text, /coating（親水塗層文獻）/);
  assert.match(text, /2026-07-27 02:00:00Z/);
  assert.match(text, /新增 2、更新 1、跳過 99/);
});

test("sync_status：表還沒建立時誠實說明，不是報錯", async () => {
  resetSynonymCacheForTests();
  const db = makeDB({ synonyms: [] });
  const result = await callTool({ DB_FIELDLOG: db }, "sync_status", {});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /還沒有任何同步紀錄/);
});

// ---------- 結構性防護 ----------

test("工具數與文件記載一致（改了工具就要同步改文件，不能只改一邊）", async () => {
  const [src, connectGpt, readme] = await Promise.all([
    readFile(new URL("../mcp/src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../mcp/CONNECT-GPT.md", import.meta.url), "utf8"),
    readFile(new URL("../mcp/README.md", import.meta.url), "utf8"),
  ]);
  const count = (src.match(/^\s{4}name: "/gm) || []).length;
  assert.equal(count, 21, "工具數變了要一起更新兩份文件");
  assert.match(connectGpt, new RegExp(`可用工具（${count} 個）`));
  assert.match(connectGpt, new RegExp(`抓到下面這 ${count} 個工具`));
  // README 講的是「其餘幾個唯讀」＝總數扣掉三支可寫入的
  assert.match(readme, new RegExp(`其餘 ${count - 3} 個工具`));
});

test("同義詞表已經不是編譯進程式碼的靜態常數（要能在對話裡長大）", async () => {
  const searchSrc = await readFile(new URL("../mcp/src/search.js", import.meta.url), "utf8");
  assert.match(searchSrc, /export function setSynonymGroups/, "要能被 D1 版本換掉");
  assert.doesNotMatch(searchSrc, /^const GROUPS = /m, "GROUPS 不能是不可替換的常數");
});
