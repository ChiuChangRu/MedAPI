/**
 * applyFolderReorg20260808：2026-08-08「MyWiki 隨身記系統改造規格」§B 對照表
 * 的一次性資料夾分類重整。只做兩類安全動作：
 *   1. 改名＋設定 category（純文字／metadata）
 *   2. §B4 明確列出、id 對 id 的資料搬移／刪除
 * 不做規格裡用「｜」暗示、需要知道現在實際 parent_id／深度才能安全判斷
 * 的樹狀搬移，這裡也順便驗證「沒做」這件事（沒有動到 parent_id，除了
 * §B4 明確要求的兩處防禦性上移）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyFolderReorg20260808 } from "../fieldlog/src/lib/schema.js";

function makeDB({ folders = [], entries = [] } = {}) {
  const tables = {
    folders: folders.map((f) => ({ ...f })),
    entries: entries.map((e) => ({ ...e })),
    categories: [],
  };

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q === "SELECT id FROM categories WHERE kind = '_folder_reorg_2026_08_08' LIMIT 1") {
      const row = tables.categories.find((c) => c.kind === "_folder_reorg_2026_08_08");
      return row ? [row] : [];
    }
    if (q.startsWith("INSERT INTO categories")) {
      tables.categories.push({ kind: "_folder_reorg_2026_08_08" });
      return [];
    }
    if (q === "UPDATE folders SET name = ?, category = ? WHERE id = ?") {
      const [name, category, id] = args;
      const f = tables.folders.find((row) => row.id === id);
      if (f) { f.name = name; f.category = category; }
      return [];
    }
    if (q === "UPDATE folders SET category = ? WHERE id = ?") {
      const [category, id] = args;
      const f = tables.folders.find((row) => row.id === id);
      if (f) f.category = category;
      return [];
    }
    if (q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?") {
      const [folderId, updatedAt, fromFolderId] = args;
      tables.entries.filter((e) => e.folder_id === fromFolderId).forEach((e) => { e.folder_id = folderId; e.updated_at = updatedAt; });
      return [];
    }
    if (q === "UPDATE entries SET folder_id = NULL, updated_at = ? WHERE folder_id = ?") {
      const [updatedAt, fromFolderId] = args;
      tables.entries.filter((e) => e.folder_id === fromFolderId).forEach((e) => { e.folder_id = null; e.updated_at = updatedAt; });
      return [];
    }
    if (q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?") {
      const [folderId, updatedAt, id] = args;
      const e = tables.entries.find((row) => row.id === id);
      if (e) { e.folder_id = folderId; e.updated_at = updatedAt; }
      return [];
    }
    if (q === "UPDATE folders SET parent_id = ? WHERE parent_id = ?") {
      const [parentId, fromParentId] = args;
      tables.folders.filter((f) => f.parent_id === fromParentId).forEach((f) => { f.parent_id = parentId; });
      return [];
    }
    if (q === "UPDATE folders SET parent_id = NULL WHERE parent_id = ?") {
      const [fromParentId] = args;
      tables.folders.filter((f) => f.parent_id === fromParentId).forEach((f) => { f.parent_id = null; });
      return [];
    }
    if (q === "DELETE FROM folders WHERE id = ?") {
      tables.folders = tables.folders.filter((f) => f.id !== args[0]);
      return [];
    }
    throw new Error(`測試沒預期到的 SQL：${q}`);
  }

  return {
    tables,
    prepare(sql) {
      return {
        bind: (...args) => ({
          run: async () => ({ meta: { changes: exec(sql, args).length } }),
          first: async () => exec(sql, args)[0] || null,
        }),
        first: async () => exec(sql, [])[0] || null,
      };
    },
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
  };
}

function baselineFolders() {
  // 只列這份測試會檢查的幾筆，其餘規格提到的 id 用同樣的方式類推，不用全列
  return [
    { id: 19, name: "其他專案｜檢體針", type: "其他專案", category: null, parent_id: null },
    { id: 23, name: "廠商｜北回化學", type: "廠商", category: null, parent_id: 22 },
    { id: 15, name: "文獻庫｜專利與文獻", type: "文獻庫", category: null, parent_id: null },
    { id: 9, name: "其他｜高壓注射筒", type: "其他", category: null, parent_id: null },
    { id: 39, name: "其他｜⏳ 暫存區（待歸類）", type: "其他", category: null, parent_id: null, role: "staging" },
    { id: 13, name: "其他專案｜教育訓練", type: "其他專案", category: null, parent_id: null },
    { id: 11, name: "其他專案｜課程", type: "其他專案", category: null, parent_id: null },
    { id: 26, name: "其他｜月報與周報", type: "其他", category: null, parent_id: null },
    { id: 42, name: "其他｜週報月報KPI", type: "其他", category: null, parent_id: null },
    { id: 36, name: "引流導管（Pigtail）｜親水塗層", type: "其他", category: null, parent_id: null },
    { id: 35, name: "上課｜FMEA", type: "上課", category: null, parent_id: null },
    // 沒被規格提到的資料夾，用來驗證「沒被動到」
    { id: 999, name: "跟這次重整無關的資料夾", type: "其他", category: null, parent_id: null },
  ];
}

function baselineEntries() {
  return [
    { id: 201, folder_id: 11, title: "課程筆記 A" },
    { id: 202, folder_id: 11, title: "課程筆記 B" },
    { id: 203, folder_id: 11, title: "課程筆記 C" },
    { id: 262, folder_id: 36, title: "FMEA 課程筆記（誤歸檔）" },
    { id: 300, folder_id: 999, title: "跟這次重整無關的記事" },
  ];
}

test("改名＋設定 category：一般案例（19 檢體針）", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 19);
  assert.equal(f.name, "專案｜檢體針");
  assert.equal(f.category, "project");
});

test("只設定 category、不改名：23（技術性廠商，保留名稱）", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 23);
  assert.equal(f.name, "廠商｜北回化學", "名稱不該被改動");
  assert.equal(f.category, "project");
  assert.equal(f.parent_id, 22, "parent_id 不該被動到——規格沒有明確要求搬這個");
});

test("只設定 category：15（文獻庫，命名已清楚不用改名）", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 15);
  assert.equal(f.name, "文獻庫｜專利與文獻");
  assert.equal(f.category, "literature");
});

test("9：不確定歸屬先進暫存區（misc），且不做任何 parent_id 搬移", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 9);
  assert.equal(f.name, "暫存區｜高壓注射筒（待確認）");
  assert.equal(f.category, "misc");
  assert.equal(f.parent_id, null, "刻意不做樹狀搬移，只設定顏色分類");
});

test("39：暫存區根資料夾改名＋misc，role='staging' 不受影響", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 39);
  assert.equal(f.name, "暫存區（待歸類）");
  assert.equal(f.category, "misc");
  assert.equal(f.role, "staging", "既有的自動歸類 staging 標記不該被這次重整動到");
});

test("§B4：11 的 3 筆記事併入 13，11 自己被刪除", async () => {
  const db = makeDB({ folders: baselineFolders(), entries: baselineEntries() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  assert.equal(db.tables.folders.some((f) => f.id === 11), false, "11 應該被刪除");
  const moved = db.tables.entries.filter((e) => [201, 202, 203].includes(e.id));
  assert.equal(moved.length, 3);
  for (const e of moved) assert.equal(e.folder_id, 13, `entry ${e.id} 應該搬到 13`);
  const target = db.tables.folders.find((f) => f.id === 13);
  assert.equal(target.name, "教育訓練（根）");
  assert.equal(target.category, "training");
});

test("§B4：26（跟 42 重複）直接刪除，42 保留不受影響", async () => {
  const db = makeDB({ folders: baselineFolders() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  assert.equal(db.tables.folders.some((f) => f.id === 26), false, "26 應該被刪除");
  const kept = db.tables.folders.find((f) => f.id === 42);
  assert.equal(kept.name, "行政｜週報月報KPI");
  assert.equal(kept.category, "admin");
});

test("§B4：entry 262 從 36（親水塗層）搬到 35（FMEA），不動其他欄位", async () => {
  const db = makeDB({ folders: baselineFolders(), entries: baselineEntries() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const e = db.tables.entries.find((row) => row.id === 262);
  assert.equal(e.folder_id, 35);
  assert.equal(e.title, "FMEA 課程筆記（誤歸檔）", "標題不該被動到，只改歸檔位置");
});

test("沒被規格提到的資料夾／記事完全不受影響", async () => {
  const db = makeDB({ folders: baselineFolders(), entries: baselineEntries() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  const f = db.tables.folders.find((row) => row.id === 999);
  assert.equal(f.name, "跟這次重整無關的資料夾");
  assert.equal(f.category, null);
  const e = db.tables.entries.find((row) => row.id === 300);
  assert.equal(e.folder_id, 999);
});

test("只套用一次：第二次呼叫完全不動任何東西（標記機制生效）", async () => {
  const db = makeDB({ folders: baselineFolders(), entries: baselineEntries() });
  await applyFolderReorg20260808(db, "2026-08-08T02:00:00Z");
  // 套用後手動把 19 的名稱／分類改掉，模擬使用者事後自己調整
  const f19 = db.tables.folders.find((row) => row.id === 19);
  f19.name = "使用者自己改過的名字";
  f19.category = "admin";
  await applyFolderReorg20260808(db, "2026-08-09T02:00:00Z");
  assert.equal(f19.name, "使用者自己改過的名字", "已經套用過一次之後，不該再把使用者的調整蓋回去");
  assert.equal(f19.category, "admin");
});
