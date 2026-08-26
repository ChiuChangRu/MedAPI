/**
 * POST /entries/:sourceId/merge — 手動合併兩筆記事。
 *
 * 背景：錄音中若改按主畫面獨立的「📷 拍照」（而不是浮動列裡的相機鈕），會
 * 拆成兩筆記事（見 ensureEntryForCapture 的修正）。這支端點是拆開後的手動
 * 補救：把來源記事的附件搬進目標記事、內文接起來，來源記事之後刪除。也是
 * 一般情況下想合併任兩筆記事的入口——這個 App 主要在手機上用，原生 HTML5
 * 拖曳在觸控螢幕上用不了，合併沒有對應的拖曳操作可以取代。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB() {
  const tables = { entries: [], attachments: [], relations: [], history: [] };
  const nextId = { entries: 1, attachments: 1, relations: 1, history: 1 };
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

    if (q === "SELECT * FROM entries WHERE id = ?" ||
        q === "SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''") {
      const row = tables.entries.find((e) => e.id === args[0]);
      const active = row && (!q.includes("deleted_at") || !row.deleted_at);
      return { results: active ? [row] : [], changes: 0 };
    }
    if (q === "SELECT COUNT(*) AS count FROM entries WHERE parent_entry_id = ? AND COALESCE(deleted_at, '') = ''") {
      const count = tables.entries.filter((e) => e.parent_entry_id === args[0] && !e.deleted_at).length;
      return { results: [{ count }], changes: 0 };
    }
    if (q === "UPDATE entries SET body = ?, fields_json = ?, updated_at = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[3]);
      if (row) { row.body = args[0]; row.fields_json = args[1]; row.updated_at = args[2]; }
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM entries WHERE id = ?") {
      const before = tables.entries.length;
      tables.entries = tables.entries.filter((e) => e.id !== args[0]);
      return { results: [], changes: before - tables.entries.length };
    }

    if (q === "SELECT * FROM attachments WHERE entry_id = ?") {
      const rows = tables.attachments.filter((a) => a.entry_id === args[0]);
      return { results: rows, changes: 0 };
    }
    if (q === "UPDATE attachments SET entry_id = ? WHERE id = ?") {
      const [targetId, id] = args;
      const row = tables.attachments.find((a) => a.id === id);
      if (!row) return none;
      // 模擬 attachments(entry_id, content_hash) 的唯一索引：目標記事底下
      // 已經有一份同 hash 的檔案時，這個 UPDATE 在真的 D1 上會直接拋錯
      if (row.content_hash) {
        const clash = tables.attachments.some((a) =>
          a.id !== id && a.entry_id === targetId && a.content_hash === row.content_hash);
        if (clash) throw new Error("UNIQUE constraint failed: attachments.entry_id, attachments.content_hash");
      }
      row.entry_id = targetId;
      return { results: [], changes: 1 };
    }
    if (q === "SELECT id, key FROM attachments WHERE source_pdf_id = ?") {
      const rows = tables.attachments.filter((a) => a.source_pdf_id === args[0]);
      return { results: rows.map((a) => ({ id: a.id, key: a.key })), changes: 0 };
    }
    if (q === "DELETE FROM attachments WHERE source_pdf_id = ?") {
      const before = tables.attachments.length;
      tables.attachments = tables.attachments.filter((a) => a.source_pdf_id !== args[0]);
      return { results: [], changes: before - tables.attachments.length };
    }
    if (q === "DELETE FROM attachments WHERE id = ?") {
      const before = tables.attachments.length;
      tables.attachments = tables.attachments.filter((a) => a.id !== args[0]);
      return { results: [], changes: before - tables.attachments.length };
    }

    if (q === "UPDATE relations SET from_entry_id = ? WHERE from_entry_id = ?") {
      const hit = tables.relations.filter((r) => r.from_entry_id === args[1]);
      hit.forEach((r) => { r.from_entry_id = args[0]; });
      return { results: [], changes: hit.length };
    }
    if (q === "UPDATE relations SET to_entry_id = ? WHERE to_entry_id = ?") {
      const hit = tables.relations.filter((r) => r.to_entry_id === args[1]);
      hit.forEach((r) => { r.to_entry_id = args[0]; });
      return { results: [], changes: hit.length };
    }
    if (q === "DELETE FROM relations WHERE from_entry_id = to_entry_id") {
      const before = tables.relations.length;
      tables.relations = tables.relations.filter((r) => r.from_entry_id !== r.to_entry_id);
      return { results: [], changes: before - tables.relations.length };
    }

    if (q.startsWith("INSERT INTO history")) {
      insert("history", { entry_id: args[0], folder_id: args[1], action: args[2], detail: args[3], created_at: args[4] });
      return { results: [], changes: 1 };
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

test("合併成功：附件搬到目標、內文接起來、來源記事刪除", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "拍照 07/28 08:48", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "錄音 07/28 08:48", body: "現場重點", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.attachments.push({ id: 10, entry_id: 1, kind: "photo", filename: "a.jpg", key: "k1", content_hash: "" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  assert.equal(res.data.moved, 1);
  assert.equal(res.data.duplicates_removed, 0);
  assert.equal(res.data.target_id, 2);

  assert.equal(db.tables.entries.length, 1, "來源記事要被刪除");
  assert.equal(db.tables.entries[0].id, 2);
  assert.equal(db.tables.attachments[0].entry_id, 2, "附件要搬到目標記事");
  assert.match(db.tables.entries[0].body, /現場重點/);
  assert.match(db.tables.entries[0].body, /【併入：拍照 07\/28 08:48】/);
  assert.equal(db.tables.history.some((h) => h.action === "合併紀錄"), true);
  // ensureSchema() 首次啟動會種類別字典／同步來源（categories／sources），
  // 這支端點用不到、這裡的假 DB 也沒實作那兩組表，不列入「預期外 SQL」的判斷範圍
  const unexpected = db.unhandled.filter((q) => !/\b(categories|sources)\b/i.test(q));
  assert.deepEqual(unexpected, [], "不該下出預期外的 SQL（schema 種子除外）");
});

test("fields_json 合併不取代，鍵衝突時目標優先", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "來源", body: "", fields_json: JSON.stringify({ 廠商: "A公司", 備註: "來源專屬" }), created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "目標", body: "", fields_json: JSON.stringify({ 廠商: "B公司" }), created_at: "x", updated_at: "x" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  const fields = JSON.parse(db.tables.entries[0].fields_json);
  assert.equal(fields.廠商, "B公司", "撞鍵時目標優先");
  assert.equal(fields.備註, "來源專屬", "目標沒有的鍵，來源的要保留");
});

test("附件 content_hash 撞到目標記事既有檔案時當重複檔處理，不中斷合併", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  const deleted = [];
  env.FILES = { delete: async (key) => { deleted.push(key); } };
  db.tables.entries.push({ id: 1, folder_id: null, title: "來源", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "目標", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.attachments.push({ id: 10, entry_id: 1, kind: "photo", filename: "dup.jpg", key: "k-dup-src", content_hash: "abc" });
  db.tables.attachments.push({ id: 11, entry_id: 1, kind: "photo", filename: "uniq.jpg", key: "k-uniq", content_hash: "def" });
  db.tables.attachments.push({ id: 20, entry_id: 2, kind: "photo", filename: "dup.jpg", key: "k-dup-tgt", content_hash: "abc" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  assert.equal(res.data.moved, 1, "只有不重複的那份真的搬過去");
  assert.equal(res.data.duplicates_removed, 1);
  assert.ok(deleted.includes("k-dup-src"), "重複的來源檔案要從 R2 刪掉");
  assert.equal(db.tables.attachments.find((a) => a.id === 10), undefined, "重複的來源附件列要刪掉");
  assert.equal(db.tables.attachments.find((a) => a.id === 11).entry_id, 2);
  assert.equal(db.tables.attachments.find((a) => a.id === 20).entry_id, 2, "目標原本那份不受影響");
});

test("目標是富文字（body_format='html'）、來源是純文字時，合併要把來源內容轉成 HTML 再接", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "純文字來源", body: "來源內容", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "富文字目標", body: "<p>目標內容</p>", body_format: "html", fields_json: "{}", created_at: "x", updated_at: "x" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  const merged = db.tables.entries[0].body;
  assert.match(merged, /<p>目標內容<\/p>/, "目標原本的 HTML 內容要保留");
  assert.match(merged, /<p>來源內容<\/p>/, "來源的純文字要轉成 HTML 段落，不能原樣塞進去");
  assert.match(merged, /純文字來源/, "併入標記要留著");
  assert.doesNotMatch(merged, /\n\n來源內容/, "純文字換行分段不該直接混進 HTML 字串");
});

test("目標是純文字、來源是富文字時，合併要把來源內容剝成純文字再接", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "富文字來源", body: "<p>來源內容</p><img src=\"/api/file/x\" alt=\"圖.jpg\">", body_format: "html", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "純文字目標", body: "目標內容", fields_json: "{}", created_at: "x", updated_at: "x" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  const merged = db.tables.entries[0].body;
  assert.match(merged, /目標內容/);
  assert.match(merged, /來源內容/);
  assert.match(merged, /\[圖片：圖\.jpg\]/, "來源的圖片要轉成純文字標註");
  assert.doesNotMatch(merged, /<p>|<img/, "目標是純文字，合併結果不該留下 HTML 標籤");
});

test("relations 雙向重新指向目標，合併後產生的自我關聯要清掉", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "來源", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "目標", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 3, folder_id: null, title: "第三筆", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });
  db.tables.relations.push({ id: 1, from_entry_id: 1, to_entry_id: 3, relation_type: "引用", note: "", created_at: "x" });
  db.tables.relations.push({ id: 2, from_entry_id: 1, to_entry_id: 2, relation_type: "引用", note: "", created_at: "x" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 200);
  assert.equal(db.tables.relations.length, 1, "來源↔目標那筆重新指向後變自我關聯，要被清掉");
  assert.equal(db.tables.relations[0].from_entry_id, 2);
  assert.equal(db.tables.relations[0].to_entry_id, 3, "來源→第三筆的關聯要保留，改指向目標");
});

test("兩邊都是外部同步管理的記事時拒絕合併，不能弄亂同步追蹤", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "同步A", body: "", fields_json: JSON.stringify({ _sid: "src:1" }), created_at: "x", updated_at: "x" });
  db.tables.entries.push({ id: 2, folder_id: null, title: "同步B", body: "", fields_json: JSON.stringify({ litdb_id: "lit:2" }), created_at: "x", updated_at: "x" });

  const res = await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 2 }) });
  assert.equal(res.status, 400);
  assert.equal(db.tables.entries.length, 2, "拒絕時不該動到任何資料");
});

test("target_id 缺漏、等於來源、或指向不存在的記事都要擋下來", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 1, folder_id: null, title: "來源", body: "", fields_json: "{}", created_at: "x", updated_at: "x" });

  assert.equal((await call(env, "/entries/1/merge", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 1 }) })).status, 400);
  assert.equal((await call(env, "/entries/1/merge", { method: "POST", body: JSON.stringify({ target_id: 999 }) })).status, 404);
  assert.equal((await call(env, "/entries/999/merge", { method: "POST", body: JSON.stringify({ target_id: 1 }) })).status, 404);
});
