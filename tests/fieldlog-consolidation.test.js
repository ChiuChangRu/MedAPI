/**
 * 整併後的 fieldlog Worker 測試。
 *
 * 整併前是 worker-entry → v49 → v46 → v45 → v43 → v40 → v37 → worker.js 一條
 * 八層包裝鏈，每層用 fetch 轉呼叫下一層。這份測試蓋住「原本散在各層的端點，
 * 整併後是不是都還在同一支 worker.js 裡正常運作」，以及新做的分類字典。
 *
 * 另外有一組結構性測試，確保包裝鏈不會被重新引入（那是這次整併要根除的模式）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { CATEGORY_SEED, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

// ---------- 假的 D1 ----------
// 只認這些端點實際會下的語句；認不出來的一律回空集合（而不是靜默假裝成功），
// 這樣端點多下了預期外的 SQL 時測試會壞掉，而不是悄悄通過。

function makeDB() {
  const tables = {
    folders: [], entries: [], attachments: [], categories: [], history: [], relations: [], sources: [],
  };
  const nextId = { folders: 1, entries: 1, attachments: 1, categories: 1, history: 1, relations: 1, sources: 1 };
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

    // ---- categories ----
    if (q === "SELECT id FROM categories WHERE kind = '_seeded' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_seeded");
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id FROM categories WHERE kind = '_sources_seeded' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_sources_seeded");
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q.startsWith("INSERT INTO categories") || q.startsWith("INSERT OR IGNORE INTO categories")) {
      const [kind, level, name, icon, note, fields_json, sort_order, created_at] =
        q.includes("VALUES ('_seeded'")
          ? ["_seeded", 0, "seeded", "", "", "[]", 0, args[0]]
          : q.includes("VALUES ('_sources_seeded'")
            ? ["_sources_seeded", 0, "seeded", "", "", "[]", 0, args[0]]
            : args;
      const clash = tables.categories.some((c) => c.kind === kind && c.level === level && c.name === name);
      if (clash && q.startsWith("INSERT OR IGNORE")) return none;
      const id = insert("categories", { kind, level, name, icon, note, fields_json, sort_order, created_at });
      return { results: [], lastRowId: id, changes: 1 };
    }
    // ---- sources（外部來源種子；同步引擎本身的行為在 fieldlog-sync-sources.test.js）----
    if (q.startsWith("INSERT OR IGNORE INTO sources")) {
      const [key, label, url, items_path, id_field, title_field, folder_parent, folder_type, created_at] = args;
      if (tables.sources.some((s) => s.key === key)) return none;
      const id = insert("sources", { key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled: 1, last_synced_at: "", created_at });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q.startsWith("SELECT * FROM categories WHERE") && q.includes("ORDER BY kind, level, sort_order, id")) {
      let rows = tables.categories.filter((c) => !String(c.kind).startsWith("_"));
      let i = 0;
      if (q.includes("kind = ?")) { const k = args[i++]; rows = rows.filter((c) => c.kind === k); }
      if (q.includes("(level = ? OR level = 0)")) {
        const lv = args[i++];
        rows = rows.filter((c) => c.level === lv || c.level === 0);
      }
      rows = [...rows].sort((a, b) =>
        String(a.kind).localeCompare(String(b.kind)) || a.level - b.level || a.sort_order - b.sort_order || a.id - b.id);
      return { results: rows, changes: 0 };
    }
    if (q === "SELECT id FROM categories WHERE kind = ? AND level = ? AND name = ?") {
      const row = tables.categories.find((c) => c.kind === args[0] && c.level === args[1] && c.name === args[2]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT id FROM categories WHERE kind = ? AND level = ? AND name = ? AND id != ?") {
      const row = tables.categories.find((c) =>
        c.kind === args[0] && c.level === args[1] && c.name === args[2] && c.id !== args[3]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT MAX(sort_order) AS max_order FROM categories WHERE kind = ? AND level = ?") {
      const rows = tables.categories.filter((c) => c.kind === args[0] && c.level === args[1]);
      return { results: [{ max_order: rows.reduce((m, c) => Math.max(m, c.sort_order || 0), 0) }], changes: 0 };
    }
    if (q === "SELECT * FROM categories WHERE id = ? AND kind NOT LIKE '\\_%' ESCAPE '\\'") {
      const row = tables.categories.find((c) => c.id === args[0] && !String(c.kind).startsWith("_"));
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "UPDATE categories SET name = ?, level = ?, icon = ?, note = ?, fields_json = ? WHERE id = ?") {
      const row = tables.categories.find((c) => c.id === args[5]);
      if (row) Object.assign(row, { name: args[0], level: args[1], icon: args[2], note: args[3], fields_json: args[4] });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM categories WHERE id = ?") {
      const before = tables.categories.length;
      tables.categories = tables.categories.filter((c) => c.id !== args[0]);
      return { results: [], changes: before - tables.categories.length };
    }
    if (q === "SELECT name FROM categories WHERE kind = 'device' ORDER BY sort_order, id") {
      const rows = tables.categories.filter((c) => c.kind === "device")
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      return { results: rows.map((c) => ({ name: c.name })), changes: 0 };
    }

    // ---- folders ----
    if (q === "SELECT id, parent_id FROM folders WHERE id = ?") {
      const row = tables.folders.find((f) => f.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)") {
      const id = insert("folders", { name: args[0], type: args[1], parent_id: args[2], created_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id, name FROM folders WHERE id = ?") {
      const row = tables.folders.find((f) => f.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "SELECT COUNT(*) AS count FROM folders WHERE type = ?") {
      return { results: [{ count: tables.folders.filter((f) => f.type === args[0]).length }], changes: 0 };
    }
    if (q === "UPDATE folders SET type = ? WHERE type = ?") {
      const hit = tables.folders.filter((f) => f.type === args[1]);
      hit.forEach((f) => { f.type = args[0]; });
      return { results: [], changes: hit.length };
    }

    // ---- entries ----
    if (q === "SELECT id, folder_id FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q.startsWith("UPDATE entries SET body = CASE WHEN body IS NULL OR body = ''")) {
      const [first, appended, updatedAt, id] = args;
      const row = tables.entries.find((e) => e.id === id);
      if (!row) return none;
      row.body = !row.body ? first : `${row.body}\n${appended}`;
      row.updated_at = updatedAt;
      return { results: [], changes: 1 };
    }
    if (q.startsWith("INSERT INTO entries (folder_id, title, fields_json, body, created_at, updated_at)")) {
      const id = insert("entries", {
        folder_id: args[0], title: args[1], fields_json: "{}", body: "", created_at: args[2], updated_at: args[3],
      });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT body, fields_json FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [{ body: row.body, fields_json: row.fields_json }] : [], changes: 0 };
    }
    if (q === "DELETE FROM entries WHERE id = ?") {
      const before = tables.entries.length;
      tables.entries = tables.entries.filter((e) => e.id !== args[0]);
      return { results: [], changes: before - tables.entries.length };
    }
    if (q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[2]);
      if (row) { row.folder_id = args[0]; row.updated_at = args[1]; }
      return { results: [], changes: row ? 1 : 0 };
    }

    // ---- attachments ----
    if (q === "SELECT id, entry_id, filename, COALESCE(device_category, '') AS device_category FROM attachments WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      return {
        results: row ? [{ id: row.id, entry_id: row.entry_id, filename: row.filename, device_category: row.device_category || "" }] : [],
        changes: 0,
      };
    }
    if (q === "UPDATE attachments SET device_category = ? WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[1]);
      if (row) row.device_category = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE attachments SET device_category = ? WHERE device_category = ?") {
      const hit = tables.attachments.filter((a) => a.device_category === args[1]);
      hit.forEach((a) => { a.device_category = args[0]; });
      return { results: [], changes: hit.length };
    }
    if (q === "SELECT COUNT(*) AS count FROM attachments WHERE device_category = ?") {
      return { results: [{ count: tables.attachments.filter((a) => a.device_category === args[0]).length }], changes: 0 };
    }
    if (q === "SELECT id, entry_id, filename FROM attachments WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q === "UPDATE attachments SET note = ? WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[1]);
      if (row) row.note = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "SELECT * FROM attachments WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      return { results: row ? [row] : [], changes: 0 };
    }
    if (q.startsWith("SELECT a.*, e.folder_id AS source_folder_id")) {
      const att = tables.attachments.find((a) => a.id === args[0]);
      if (!att) return none;
      const entry = tables.entries.find((e) => e.id === att.entry_id);
      return { results: [{ ...att, source_folder_id: entry?.folder_id ?? null, entry_title: entry?.title || "" }], changes: 0 };
    }
    if (q === "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ? AND source_pdf_id IS NULL") {
      const n = tables.attachments.filter((a) => a.entry_id === args[0] && !a.source_pdf_id).length;
      return { results: [{ count: n }], changes: 0 };
    }
    if (q === "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ?") {
      return { results: [{ count: tables.attachments.filter((a) => a.entry_id === args[0]).length }], changes: 0 };
    }
    if (q === "SELECT id, key FROM attachments WHERE source_pdf_id = ?") {
      const rows = tables.attachments.filter((a) => a.source_pdf_id === args[0]);
      return { results: rows.map((a) => ({ id: a.id, key: a.key })), changes: 0 };
    }
    if (q === "UPDATE attachments SET entry_id = ? WHERE id = ? OR source_pdf_id = ?") {
      const hit = tables.attachments.filter((a) => a.id === args[1] || a.source_pdf_id === args[2]);
      hit.forEach((a) => { a.entry_id = args[0]; });
      return { results: [], changes: hit.length };
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
    if (q === "DELETE FROM ai_usage_reservations WHERE attachment_id = ?") return none;

    // ---- history ----
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
      // 真 D1 回傳純資料列（複製品）而不是內部活物件；假 DB 也要複製，
      // 否則呼叫端手上的列會被後續 UPDATE 就地改掉，測到的行為與正式環境不同
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
  resetSchemaCacheForTests(); // ensureSchema 有模組層快取，每個測試都要重新初始化
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

// ---------- 分類字典（這次整併的主要新功能）----------

test("分類種子會在第一次啟動時寫入，包含四層架構與醫材分類", async () => {
  const env = makeEnv();
  const res = await call(env, "/categories");
  assert.equal(res.status, 200);
  const names = res.data.categories.map((c) => c.name);
  assert.ok(names.includes("中央靜脈導管（CVC）"), "第 1 層產品分類要在");
  assert.ok(names.includes("驗證與確效"), "第 2 層文件類型要在");
  assert.ok(names.includes("標準系列／章節"), "第 3 層主題要在");
  assert.ok(names.includes("年份／版本"), "第 4 層要在");
  assert.ok(names.includes("參展"), "原本的活動型分類要保留");
  assert.equal(res.data.max_folder_depth, 4);
  assert.deepEqual(env.DB.unhandled, [], "不該下出預期外的 SQL");
});

test("種子只寫一次——重複初始化不會把使用者刪掉的預設分類倒回來", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  const seededCount = db.tables.categories.length;

  // 使用者刪掉一個預設分類
  const target = db.tables.categories.find((c) => c.name === "參展");
  await call(env, `/categories/${target.id}`, { method: "DELETE" });

  // 模擬 Worker 冷啟動（schemaReady 重置），再打一次
  resetSchemaCacheForTests();
  await call(env, "/categories");
  assert.equal(db.tables.categories.length, seededCount - 1, "刪掉的分類不該被種子倒回來");
  assert.ok(!db.tables.categories.some((c) => c.name === "參展"));
});

test("可以自己新增分類，並指定放在第幾層", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const created = await call(env, "/categories", {
    method: "POST",
    body: JSON.stringify({ kind: "folder_type", level: 1, name: "抗菌導管產品線", icon: "🧬", note: "新產品線" }),
  });
  assert.equal(created.status, 200);
  assert.ok(created.data.id);

  const level1 = await call(env, "/categories?kind=folder_type&level=1");
  const names = level1.data.categories.map((c) => c.name);
  assert.ok(names.includes("抗菌導管產品線"), "第 1 層要看到新分類");
  assert.ok(names.includes("參展"), "level 0 的通用分類在每一層都要出現");

  const level2 = await call(env, "/categories?kind=folder_type&level=2");
  assert.ok(!level2.data.categories.map((c) => c.name).includes("抗菌導管產品線"), "不該跑到第 2 層");
});

test("新增重複名稱的分類會被擋下來", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const res = await call(env, "/categories", {
    method: "POST",
    body: JSON.stringify({ kind: "folder_type", level: 1, name: "中央靜脈導管（CVC）" }),
  });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /已經存在/);
});

test("分類名稱空白會被拒絕", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const res = await call(env, "/categories", {
    method: "POST",
    body: JSON.stringify({ kind: "device", name: "   " }),
  });
  assert.equal(res.status, 400);
});

test("分類改名會同步更新既有資料夾的分類文字", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  db.tables.folders.push({ id: 1, name: "A", type: "引流導管（Pigtail）", parent_id: null });
  db.tables.folders.push({ id: 2, name: "B", type: "引流導管（Pigtail）", parent_id: null });
  db.tables.folders.push({ id: 3, name: "C", type: "高壓注射筒組", parent_id: null });

  const targetId = db.tables.categories.find((c) => c.name === "引流導管（Pigtail）" && c.kind === "folder_type").id;
  const res = await call(env, `/categories/${targetId}`, {
    method: "PUT",
    body: JSON.stringify({ name: "引流導管" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.renamed, 2, "兩個資料夾要一起更新");
  assert.equal(db.tables.folders[0].type, "引流導管");
  assert.equal(db.tables.folders[1].type, "引流導管");
  assert.equal(db.tables.folders[2].type, "高壓注射筒組", "沒用到這個分類的不該被動到");
});

test("刪除分類只拿掉選項，既有資料上的分類文字保留並回報還有幾筆在用", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  db.tables.folders.push({ id: 1, name: "A", type: "其他專案", parent_id: null });

  const target = db.tables.categories.find((c) => c.name === "其他專案");
  const res = await call(env, `/categories/${target.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(res.data.still_used, 1);
  assert.equal(res.data.still_used_label, "個資料夾");
  assert.equal(db.tables.folders[0].type, "其他專案", "資料夾上的分類文字不該被清掉");
  assert.ok(!db.tables.categories.some((c) => c.id === target.id), "選項本身要刪掉");
});

test("刪除不存在的分類回 404", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const res = await call(env, "/categories/99999", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("kind 只接受 folder_type 與 device", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const res = await call(env, "/categories", {
    method: "POST",
    body: JSON.stringify({ kind: "亂填", name: "x" }),
  });
  assert.equal(res.status, 400);
});

// ---------- 醫材分類套用在檔案上（原本在 v46）----------

test("檔案的醫材分類選項來自資料庫，不是寫死的清單", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  db.tables.attachments.push({ id: 5, entry_id: 1, filename: "a.pdf", device_category: "" });

  const res = await call(env, "/attachments/5/category");
  assert.equal(res.status, 200);
  assert.ok(res.data.categories.includes("中央靜脈導管（CVC）"));

  // 使用者新增一個醫材分類 → 檔案的下拉就該多一個選項，不必改程式碼
  await call(env, "/categories", { method: "POST", body: JSON.stringify({ kind: "device", name: "導引導管" }) });
  const after = await call(env, "/attachments/5/category");
  assert.ok(after.data.categories.includes("導引導管"), "新增的分類要立刻可選");
});

test("存檔案分類時會驗證分類存在，打錯字不會產生幽靈分類", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  db.tables.attachments.push({ id: 5, entry_id: 1, filename: "a.pdf", device_category: "" });

  const bad = await call(env, "/attachments/5/category", {
    method: "PUT",
    body: JSON.stringify({ category: "中央靜脈導管CVC" }), // 少了全角括號
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /不在醫材分類清單/);
  assert.equal(db.tables.attachments[0].device_category, "", "驗證失敗不該寫進去");

  const ok = await call(env, "/attachments/5/category", {
    method: "PUT",
    body: JSON.stringify({ category: "中央靜脈導管（CVC）" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(db.tables.attachments[0].device_category, "中央靜脈導管（CVC）");
});

test("醫材分類可以清空（選「未分類」）", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");
  db.tables.attachments.push({ id: 5, entry_id: 1, filename: "a.pdf", device_category: "高壓注射筒組" });
  const res = await call(env, "/attachments/5/category", { method: "PUT", body: JSON.stringify({ category: "" }) });
  assert.equal(res.status, 200);
  assert.equal(db.tables.attachments[0].device_category, "");
});

// ---------- 四層深度限制（原本在 v46）----------

test("資料夾最多四層，第五層會被擋下來", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  await call(env, "/categories");

  let parentId = null;
  for (let level = 1; level <= 4; level++) {
    const res = await call(env, "/folders", {
      method: "POST",
      body: JSON.stringify({ name: `第${level}層`, type: "其他", parent_id: parentId }),
    });
    assert.equal(res.status, 200, `第 ${level} 層應該建得起來`);
    assert.equal(res.data.depth, level);
    parentId = res.data.id;
  }
  const fifth = await call(env, "/folders", {
    method: "POST",
    body: JSON.stringify({ name: "第5層", type: "其他", parent_id: parentId }),
  });
  assert.equal(fifth.status, 400);
  assert.match(fifth.data.error, /最多 4 層/);
});

test("指定不存在的上層資料夾回 404", async () => {
  const env = makeEnv();
  await call(env, "/categories");
  const res = await call(env, "/folders", {
    method: "POST",
    body: JSON.stringify({ name: "x", type: "其他", parent_id: 4242 }),
  });
  assert.equal(res.status, 404);
});

// ---------- 原子「記一句」（原本在 worker-entry）----------

test("記一句用一句 SQL 附加，連續多句不會互相蓋掉", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 7, folder_id: 3, title: "現場", body: "", fields_json: "{}" });

  await call(env, "/entries/7/notes", { method: "POST", body: JSON.stringify({ line: "第一句" }) });
  await call(env, "/entries/7/notes", { method: "POST", body: JSON.stringify({ line: "第二句" }) });
  await call(env, "/entries/7/notes", { method: "POST", body: JSON.stringify({ line: "第三句" }) });

  assert.equal(db.tables.entries[0].body, "第一句\n第二句\n第三句");
  assert.equal(db.tables.history.filter((h) => h.action === "記一句").length, 3, "每一句都要留歷程");
});

test("記一句空白內容會被拒絕", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 7, folder_id: null, body: "", fields_json: "{}" });
  const res = await call(env, "/entries/7/notes", { method: "POST", body: JSON.stringify({ line: "  " }) });
  assert.equal(res.status, 400);
});

test("記一句到不存在的記事回 404", async () => {
  const env = makeEnv();
  const res = await call(env, "/entries/999/notes", { method: "POST", body: JSON.stringify({ line: "x" }) });
  assert.equal(res.status, 404);
});

// ---------- 單一檔案操作（原本在 v49）----------

test("搬移單一檔案：記事只有這一份檔案時整筆跟著搬", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 1, name: "來源", parent_id: null, type: "其他" });
  db.tables.folders.push({ id: 2, name: "目標", parent_id: 1, type: "其他" });
  db.tables.entries.push({ id: 10, folder_id: 1, title: "只有一個檔", body: "", fields_json: "{}" });
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null });

  const res = await call(env, "/attachments/20/move", { method: "POST", body: JSON.stringify({ folder_id: 2 }) });
  assert.equal(res.status, 200);
  assert.equal(res.data.split, false, "不需要拆記事");
  assert.equal(db.tables.entries[0].folder_id, 2);
});

test("搬移單一檔案：記事還有其他檔案時只把這一份拆出去", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 1, name: "來源", parent_id: null, type: "其他" });
  db.tables.folders.push({ id: 2, name: "目標", parent_id: 1, type: "其他" });
  db.tables.entries.push({ id: 10, folder_id: 1, title: "兩個檔", body: "", fields_json: "{}" });
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null });
  db.tables.attachments.push({ id: 21, entry_id: 10, filename: "b.pdf", key: "k2", source_pdf_id: null });

  const res = await call(env, "/attachments/20/move", { method: "POST", body: JSON.stringify({ folder_id: 2 }) });
  assert.equal(res.status, 200);
  assert.equal(res.data.split, true);
  assert.notEqual(res.data.entry_id, 10, "應該建立新記事承接搬走的檔案");
  assert.equal(db.tables.attachments.find((a) => a.id === 20).entry_id, res.data.entry_id);
  assert.equal(db.tables.attachments.find((a) => a.id === 21).entry_id, 10, "另一個檔案要留在原記事");
});

test("深度處理產生的頁面不能單獨搬移", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.folders.push({ id: 2, name: "目標", parent_id: null, type: "其他" });
  db.tables.entries.push({ id: 10, folder_id: 1, body: "", fields_json: "{}" });
  db.tables.attachments.push({ id: 30, entry_id: 10, filename: "p1.png", key: "k", source_pdf_id: 20 });

  const res = await call(env, "/attachments/30/move", { method: "POST", body: JSON.stringify({ folder_id: 2 }) });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /不能單獨移動/);
});

test("搬到不存在的資料夾回 404、沒指定資料夾回 400", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.entries.push({ id: 10, folder_id: 1, body: "", fields_json: "{}" });
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", key: "k", source_pdf_id: null });

  assert.equal((await call(env, "/attachments/20/move", { method: "POST", body: JSON.stringify({ folder_id: 777 }) })).status, 404);
  assert.equal((await call(env, "/attachments/20/move", { method: "POST", body: "{}" })).status, 400);
});

test("刪除單一檔案會連同深度處理頁面一起清掉，並收掉變空的記事", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  const deleted = [];
  env.FILES = { delete: async (key) => { deleted.push(key); } };
  db.tables.entries.push({ id: 10, folder_id: 1, title: "只有檔案", body: "", fields_json: "{}" });
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", key: "main", source_pdf_id: null });
  db.tables.attachments.push({ id: 21, entry_id: 10, filename: "p1.png", key: "page1", source_pdf_id: 20 });

  const res = await call(env, "/attachments/20", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(res.data.pages_removed, 1);
  assert.equal(res.data.entry_removed, true, "沒有其他內容的記事要一起收掉");
  assert.deepEqual(deleted.sort(), ["main", "page1"], "R2 上的檔案與頁面都要刪");
  assert.equal(db.tables.attachments.length, 0);
  assert.equal(db.tables.entries.length, 0);
});

test("記事還有文字內容時，刪掉最後一個檔案不會把記事一起刪掉", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  env.FILES = { delete: async () => {} };
  db.tables.entries.push({ id: 10, folder_id: 1, title: "有速記", body: "現場重點：流量偏低", fields_json: "{}" });
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", key: "main", source_pdf_id: null });

  const res = await call(env, "/attachments/20", { method: "DELETE" });
  assert.equal(res.data.entry_removed, false);
  assert.equal(db.tables.entries.length, 1, "有文字內容的記事要留著");
});

test("檔案的附屬記事可以獨立儲存（跟記事內文分開）", async () => {
  const db = makeDB();
  const env = makeEnv(db);
  db.tables.attachments.push({ id: 20, entry_id: 10, filename: "a.pdf", note: "" });
  const res = await call(env, "/attachments/20/note", {
    method: "PUT",
    body: JSON.stringify({ note: "這份是 2024 改版，第 8 部條文有動" }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.tables.attachments[0].note, "這份是 2024 改版，第 8 部條文有動");
});

// ---------- 標準檔名整理（原本 v37 與 v49 各有一份對照表）----------

test("標準檔名對照表只有一份，批次與單檔用同一份", async () => {
  const [standards, cleanup, attachments] = await Promise.all([
    readFile(new URL("../fieldlog/src/lib/standards.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/src/lib/cleanup.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/src/lib/attachments.js", import.meta.url), "utf8"),
  ]);
  assert.equal((standards.match(/const STANDARD_TITLES/g) || []).length, 1);
  assert.doesNotMatch(cleanup, /STANDARD_TITLES\s*=/, "cleanup 不該自己再開一份對照表");
  assert.doesNotMatch(attachments, /STANDARD_TITLES\s*=/, "attachments 不該自己再開一份對照表");
  // 兩個入口都從 standards.js 取
  assert.match(cleanup, /from "\.\/standards\.js"/);
  assert.match(attachments, /from "\.\/standards\.js"/);
});

test("單檔改名：年份無法確認時不硬猜，回報 incomplete_year", async () => {
  const { normalizeAttachmentName } = await import("../fieldlog/src/lib/attachments.js");
  const db = makeDB();
  db.tables.attachments.push({
    id: 40, entry_id: 1, filename: "ISO_10555-8.pdf", original_filename: "",
    mime: "application/pdf", ocr_text: "",
  });
  const result = await normalizeAttachmentName(db, 40, { logHistory: async () => {} });
  assert.equal(result.incomplete_year, true);
  assert.equal(result.renamed, false);
  assert.equal(db.tables.attachments[0].filename, "ISO_10555-8.pdf", "不確定就不要改");
});

test("單檔改名：有年份時整理成 組織_編號_年份_中文標題", async () => {
  const { normalizeAttachmentName } = await import("../fieldlog/src/lib/attachments.js");
  const db = makeDB();
  db.tables.attachments.push({
    id: 41, entry_id: 1, filename: "10555-8 2024 scan.pdf", original_filename: "",
    mime: "application/pdf", ocr_text: "ISO 10555-8:2024 血管內導管",
  });
  const result = await normalizeAttachmentName(db, 41, { logHistory: async () => {} });
  assert.equal(result.renamed, true);
  assert.match(result.filename, /^ISO_10555-8_2024_/);
  assert.match(result.filename, /體外血液處理用導管/);
});

test("標準預設年份表兩個入口一致（整併前 v37 與 v49 這裡不一樣）", async () => {
  const { parseStandard, standardIdentity } = await import("../fieldlog/src/lib/standards.js");
  for (const number of ["7886-1", "7886-2", "7886-3", "7886-4"]) {
    const att = { filename: `ISO_${number}.pdf`, original_filename: "", ocr_text: "" };
    const single = parseStandard(att);
    const batch = standardIdentity(att);
    assert.ok(single.year, `${number} 單檔路徑要有預設年份`);
    assert.equal(single.year, batch.year, `${number} 兩個路徑的年份要一致`);
  }
});

// ---------- 結構性防護：包裝鏈不能回來 ----------

test("八層包裝鏈的檔案已經全部移除", async () => {
  const gone = [
    "worker-entry.js", "worker-v36.js", "worker-v37.js", "worker-v40.js", "worker-v41.js",
    "worker-v42.js", "worker-v43.js", "worker-v44.js", "worker-v45.js", "worker-v46.js",
    "worker-v47.js", "worker-v48.js", "worker-v49.js",
  ];
  for (const file of gone) {
    await assert.rejects(
      () => readFile(new URL(`../fieldlog/src/${file}`, import.meta.url)),
      `${file} 應該已經刪除`
    );
  }
});

test("wrangler 入口指向整併後的 worker.js", async () => {
  const raw = await readFile(new URL("../fieldlog/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(raw, /"main":\s*"src\/worker\.js"/);
  const runFirst = raw.match(/"run_worker_first":\s*\[([^\]]*)\]/)[1];
  assert.match(runFirst, /\/wiki\/\*/, "wiki 仍要先過 PIN 驗證");
  // / 與 /app.js 仍要先進 Worker——但理由跟整併前不一樣：整併前是為了在執行期
  // 改寫 HTML／注入 JS 字串（那個模式已經根除，見下面兩個測試）；現在是為了
  // 讓 Worker 有機會蓋掉 Cloudflare Assets 預設的快取表頭，見「App 殼檔案強制
  // no-store」那個測試——2026-07-25 曾經因為漏掉這件事，讓部署明明是最新版、
  // 前台卻還在跑舊介面。
  assert.match(runFirst, /"\/app\.js"/, "app.js 要先進 Worker 蓋快取表頭");
  assert.match(runFirst, /"\/index\.html"/, "index.html 要先進 Worker 蓋快取表頭");
});

test("app 殼路徑進 Worker 只為了蓋快取表頭，不做內容改寫（不是整併前那種注入）", async () => {
  const source = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const fn = source.match(/async function noStoreAsset\(request, env\)[\s\S]*?\n}/)[0];
  assert.doesNotMatch(fn, /\.replace\(/, "不該對回應內容做字串替換");
  assert.doesNotMatch(fn, /await response\.text\(\)/, "不該讀出內容來改寫，直接轉發 body 就好");
  assert.match(fn, /response\.body/, "應該直接轉發原始 body");
});

test("worker.js 不再用 fetch 轉呼叫下一層 Worker", async () => {
  const source = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /previousWorker/, "不該再有包裝鏈轉呼叫");
  assert.doesNotMatch(source, /legacyWorker/);
  assert.doesNotMatch(source, /from "\.\/worker-v/, "不該 import 任何 worker-vNN");
});

test("前端不再用執行期字串注入改寫 app.js", async () => {
  const source = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  // 這些是包裝鏈時期的手法：把 JS 字串接在 app.js 後面、對 app.js 原始碼做字串替換
  assert.doesNotMatch(source, /String\.raw`/, "不該再有注入用的 JS 字串區塊");
  assert.doesNotMatch(source, /url\.pathname === "\/app\.js"/, "不該再攔截 app.js 加工");
  assert.doesNotMatch(source, /\.replace\(\s*\/app\\\.js/, "不該再改寫 HTML 裡的 app.js 版本號");
});

test("public/ 底下沒有任何檔案在執行期覆寫 app.js 的頂層函式", async () => {
  // 這是整併要根除的模式，但第一次整併時漏掉了 home.js——它用
  // `loadUsage = loadActiveUsageOnly` 覆寫掉 app.js 的用量面板，並用
  // MutationObserver 持續刪掉 index.html 裡的元素。結果連改了三次 app.js 的
  // 用量面板都完全沒有效果（改到的是死碼），而且沒有任何錯誤訊息，
  // 只能靠使用者一直回報「還是舊介面」才會發現。
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../fieldlog/public/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".js"));

  // app.js 自己宣告的頂層函式清單
  const app = await readFile(new URL("app.js", dir), "utf8");
  const appFunctions = new Set(
    [...app.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  );
  assert.ok(appFunctions.size > 30, "應該抓到 app.js 的頂層函式清單");

  for (const name of files) {
    if (name === "app.js") continue;
    const source = await readFile(new URL(name, dir), "utf8");
    for (const fn of appFunctions) {
      // 抓「賦值給 app.js 的函式名」這種覆寫寫法（前面不是 . 或宣告關鍵字）
      const pattern = new RegExp(`(?<![.\\w$])${fn}\\s*=\\s*(?:async\\s*)?(?:function|\\()`);
      assert.doesNotMatch(
        source, pattern,
        `${name} 覆寫了 app.js 的 ${fn}()——請把行為直接寫進 app.js，不要在執行期蓋掉`
      );
    }
    // 也不該用 window.xxx = 的方式覆寫（home.js 當初就是這樣改 addTimedNote）
    for (const fn of appFunctions) {
      assert.doesNotMatch(
        source, new RegExp(`window\\.${fn}\\s*=`),
        `${name} 透過 window 覆寫了 app.js 的 ${fn}()`
      );
    }
  }
});

test("index.html 輸出的元素不會被 JS 在執行期刪掉（要藏就別輸出）", async () => {
  // home.js 曾經用 MutationObserver 持續移除 .folder-architecture-guide，
  // 而那個元素同時還存在於 index.html 與 style.css——三個地方各說各話。
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../fieldlog/public/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".js") && name !== "app.js");
  for (const name of files) {
    const source = await readFile(new URL(name, dir), "utf8");
    assert.doesNotMatch(
      source, /new MutationObserver\([^)]*\)\.observe\(document\.documentElement/,
      `${name} 用 MutationObserver 監看整份文件——這種全域覆寫很難追，行為請直接寫進 app.js`
    );
  }
});

test("pdf 塗鴉改成掛 window 上的入口，不再覆寫 app.js 的函式", async () => {
  const editor = await readFile(new URL("../fieldlog/public/pdf-editor.js", import.meta.url), "utf8");
  assert.match(editor, /window\.fieldlogOpenPdfEditor = openPdfEditor/);
  assert.doesNotMatch(editor, /attHtml = function/, "不該再覆寫 attHtml");
  assert.doesNotMatch(editor, /bindAttActions = function/, "不該再覆寫 bindAttActions");
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  assert.match(app, /att-pdf-doodle/, "塗鴉入口要由 app.js 自己產生");
});

test("照片一律走站內檢視器，不能用 target=_blank 開原始圖片 URL", async () => {
  // 這個 App 是 PWA（manifest display: standalone）。在 standalone 模式下用
  // target=_blank 開 /api/file/... 會跳到一個沒有任何瀏覽器介面的畫面——
  // 沒有返回、沒有關閉，使用者只能強制關掉 App。所以照片必須走站內檢視器。
  const [app, html, manifest] = await Promise.all([
    readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/manifest.json", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(manifest).display, "standalone", "前提：這是 standalone PWA");

  // 檢視器本體與關閉鈕要存在
  assert.match(html, /id="image-viewer-overlay"/);
  assert.match(html, /id="image-viewer-close"/, "檢視器一定要有關閉鈕");
  assert.match(app, /function closeImageViewer/);
  assert.match(app, /function openImageViewer/);

  // 產生照片連結的三個地方都要帶 data-image-url（＝交給站內檢視器），
  // 而且同一個標籤裡不能同時有 target="_blank"
  const imageLinks = [...app.matchAll(/<a[^>]*data-image-url[^>]*>/g)].map((m) => m[0]);
  assert.ok(imageLinks.length >= 3, `照片連結應該有三處（縮圖／檔案列／閱讀），實得 ${imageLinks.length}`);
  for (const tag of imageLinks) {
    assert.doesNotMatch(tag, /target="_blank"/, `照片連結不該另開分頁：${tag.slice(0, 90)}`);
  }

  // 點擊要被攔下來轉給檢視器
  assert.match(app, /a\[data-image-url\]/, "要有選取照片連結並改寫點擊行為的綁定");
});

test("圖片檢視器疊在其他 modal 上時，關閉不會解除底層的捲動鎖", async () => {
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  // 檔案詳情裡點縮圖 → 檢視器疊在詳情上面。關掉檢視器時如果無條件
  // unlockBodyScroll，底層還開著的詳情就會變成可以捲動、且捲動位置被重設。
  assert.match(app, /IMAGE_VIEWER_LOCKED_SCROLL/, "要記住捲動鎖是不是檢視器自己上的");
  const closeFn = app.match(/function closeImageViewer\(\)[\s\S]*?\n}/)[0];
  assert.match(closeFn, /if \(IMAGE_VIEWER_LOCKED_SCROLL\)/, "只有自己鎖的才解鎖");
});

test("App 殼檔案強制 no-store，不會被瀏覽器／CDN 快取住舊版本", async () => {
  // 2026-07-25 實際發生過：部署到 Cloudflare 確認是最新版（Version History
  // 對得上、100% 流量），前台卻還是舊介面。原因是這幾個檔案原本沒有被
  // wrangler.jsonc 的 run_worker_first 導進 Worker，Cloudflare Assets 直接
  // 回應、Worker 完全不會執行，就沒機會蓋掉 Assets 預設的快取表頭。
  const shellPaths = ["/", "/index.html", "/app.js", "/style.css", "/pdf-editor.js", "/home.css", "/sw.js", "/manifest.json"];

  let requestedPath = null;
  const env = {
    ASSETS: {
      async fetch(req) {
        requestedPath = new URL(req.url).pathname;
        return new Response("ok", { headers: { "cache-control": "public, max-age=31536000, immutable" } });
      },
    },
  };

  for (const path of shellPaths) {
    const res = await fieldlogWorker.fetch(new Request(`https://x${path}`), env);
    assert.equal(requestedPath, path, `${path} 應該真的問過 Assets（代表有進到 Worker，不是被 Assets 直接攔截）`);
    assert.match(res.headers.get("cache-control") || "", /no-store/, `${path} 的回應要蓋成 no-store`);
  }
});

test("wrangler.jsonc 的 run_worker_first 涵蓋 worker.js 裡要求 no-store 的每一個殼路徑", async () => {
  // 兩邊只要有一個漏列，那個路徑就會被 Cloudflare Assets 直接攔截，Worker 完全
  // 不會執行——no-store 的程式碼寫對也沒用，這就是這次真正發生的那個 bug。
  const [wrangler, worker] = await Promise.all([
    readFile(new URL("../fieldlog/wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8"),
  ]);
  const runFirst = new Set(
    [...wrangler.match(/"run_worker_first":\s*\[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  );
  const shellSet = worker.match(/const NO_CACHE_SHELL_PATHS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const shellPaths = [...shellSet.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const path of shellPaths) {
    assert.ok(runFirst.has(path), `${path} 要求 no-store，但 wrangler.jsonc 的 run_worker_first 沒列它——Worker 永遠不會執行到`);
  }
});

test("版本號在四個地方一致：worker.js／app.js／index.html／sw.js", async () => {
  // 這四處只要有一處沒跟上，就會出現「伺服器以為是新版、瀏覽器載到舊版」而且
  // 完全沒有提示的狀況（2026-07-25 為此耗掉很多來回）。全部綁在一起檢查。
  const [worker, app, html, sw] = await Promise.all([
    readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8"),
  ]);
  const uiVersion = worker.match(/const UI_VERSION = "(\d+)"/)[1];
  const appVersion = app.match(/const APP_VERSION = "(\d+)"/)[1];
  assert.equal(appVersion, uiVersion, "app.js 的 APP_VERSION 要等於 worker.js 的 UI_VERSION");

  const htmlVersions = new Set([...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]));
  assert.deepEqual([...htmlVersions], [uiVersion], `index.html 的 ?v= 應該全部是 ${uiVersion}`);

  const swVersions = new Set([...sw.matchAll(/\?v=(\d+)/g)].map((m) => m[1]));
  assert.deepEqual([...swVersions], [uiVersion], `sw.js 的 ?v= 應該全部是 ${uiVersion}`);
  assert.match(sw.match(/const CACHE = "([^"]+)"/)[1], new RegExp(`v${uiVersion}`), "sw.js 的 CACHE 名稱要帶版本號");
});

test("版本對不上時畫面會直接講，並提供一鍵清除快取", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="stale-version-banner"/, "要有顯示舊版警告的容器");
  assert.match(html, /id="app-version"/, "版本號要常駐顯示在畫面上");
  assert.match(app, /function showVersion/);
  assert.match(app, /function forceReloadLatest/);
  // 一鍵清除要真的解除 service worker 並清掉快取，不能只是 location.reload()
  const reload = app.match(/async function forceReloadLatest[\s\S]*?\n}/)[0];
  assert.match(reload, /getRegistrations\(\)/, "要解除已註冊的 service worker");
  assert.match(reload, /registration\.unregister\(\)/);
  assert.match(reload, /caches\.delete/, "要清掉 cache storage");
  // boot() 一定要拿伺服器版本來對版，否則這個機制等於沒接上
  assert.match(app, /showVersion\(cfg\.ui_version\)/, "boot() 要用 /api/config 回的版本對版");
  // 伺服器沒回版本時不可誤報
  const showVersion = app.match(/function showVersion[\s\S]*?\n}/)[0];
  assert.match(showVersion, /!serverVersion/, "伺服器沒給版本時不該誤判成舊版");
});

test("/api/config 會回報伺服器端的前端版本", async () => {
  resetSchemaCacheForTests();
  const env = { FIELD_PIN: "pin", DB: makeDB() };
  const res = await call(env, "/config");
  assert.equal(res.status, 200);
  const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  assert.equal(res.data.ui_version, worker.match(/const UI_VERSION = "(\d+)"/)[1]);
});

test("service worker 預快取的檔名與 index.html 完全一致", async () => {
  // 版本查詢字串對不上時，預快取的是另一個 URL，等於沒快取到：斷網打不開，
  // 而且完全不會有錯誤提示。整併時 index.html 的版本號改了、sw.js 沒跟著改，
  // 就會發生這件事，所以把它變成測試。
  const [html, sw] = await Promise.all([
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8"),
  ]);
  const assetsBlock = sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1];
  const inSw = new Set([...assetsBlock.matchAll(/"([^"]+\?v=[^"]+)"/g)].map((m) => m[1]));
  const inHtml = new Set([...html.matchAll(/(?:src|href)="([^"]+\?v=[^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...inHtml].sort(), [...inSw].sort(), "index.html 與 sw.js 的帶版本資源要一一對應");
});

test("index.html 不再引用已刪除的舊版檔案", async () => {
  const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /pdf-editor-v39|pdf-editor-folder-v40|archive-ui-v41/, "舊版檔案已刪除，不該還被引用");
  assert.match(html, /pdf-editor\.js/, "PDF 塗鴉要直接在 HTML 裡宣告載入（原本由 Worker 動態注入）");
});

test("分類種子的內容與程式碼裡的預設清單一致（避免只改一邊）", () => {
  const folderLevels = new Set(CATEGORY_SEED.filter((c) => c.kind === "folder_type").map((c) => c.level));
  assert.deepEqual([...folderLevels].sort(), [0, 1, 2, 3, 4], "四層加通用層都要有種子");
  assert.ok(CATEGORY_SEED.filter((c) => c.kind === "device").length >= 6, "醫材分類種子要在");
  for (const item of CATEGORY_SEED) {
    assert.ok(item.name, "每個種子分類都要有名稱");
    assert.ok(Array.isArray(item.fields), `${item.name} 的 fields 要是陣列`);
  }
});
