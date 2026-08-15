/**
 * 附件搬移必須拒絕把附件（進而整筆記事）搬進已進垃圾桶的資料夾。
 *
 * bug：moveAttachment() 查詢目的資料夾時原本沒有排除 deleted_at 已設定的
 * 資料夾（fieldlog/src/lib/attachments.js:14）。還停留在舊畫面狀態的分頁／
 * 裝置可以把附件搬進一個剛被使用者丟進垃圾桶的資料夾——記事的 folder_id
 * 指過去了，但記事自己的 deleted_at 從頭到尾不會被設定，變成正常清單看
 * 不到、垃圾桶也撈不到、60 天排程更清不到的孤兒資料。
 *
 * 這裡直接呼叫 moveAttachment()（不經過 worker.js 的 HTTP 層／
 * activeAttachment() 前置檢查），用一個只認 moveAttachment 實際會下的
 * SQL 的最小假 D1——不碰 fieldlog-consolidation.test.js 那份還在等垃圾桶
 * 重構全面更新的舊 mock，範圍只鎖在這次修的 bug 本身。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { moveAttachment } from "../fieldlog/src/lib/attachments.js";

function makeDB({ folders = [], entries = [], attachments = [] }) {
  const tables = {
    folders: folders.map((f) => ({ ...f })),
    entries: entries.map((e) => ({ ...e })),
    attachments: attachments.map((a) => ({ ...a })),
  };
  let nextEntryId = 1000;

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q === "SELECT id, name FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''") {
      const row = tables.folders.find((f) => f.id === args[0] && !(f.deleted_at || ""));
      return { results: row ? [row] : [] };
    }
    if (q.startsWith("SELECT a.*, e.folder_id AS source_folder_id, e.title AS entry_title")) {
      const a = tables.attachments.find((x) => x.id === args[0]);
      if (!a) return { results: [] };
      const e = tables.entries.find((x) => x.id === a.entry_id);
      return { results: [{ ...a, source_folder_id: e ? e.folder_id : null, entry_title: e ? e.title : "" }] };
    }
    if (q === "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ? AND source_pdf_id IS NULL") {
      const n = tables.attachments.filter((a) => a.entry_id === args[0] && !a.source_pdf_id).length;
      return { results: [{ count: n }] };
    }
    if (q === "UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?") {
      const e = tables.entries.find((x) => x.id === args[2]);
      if (e) { e.folder_id = args[0]; e.updated_at = args[1]; }
      return { results: [], changes: e ? 1 : 0 };
    }
    if (q.startsWith("INSERT INTO entries (folder_id, title, fields_json, body, created_at, updated_at)")) {
      const id = nextEntryId++;
      tables.entries.push({ id, folder_id: args[0], title: args[1], fields_json: "{}", body: "", created_at: args[2], updated_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "UPDATE attachments SET entry_id = ? WHERE id = ? OR source_pdf_id = ?") {
      const hit = tables.attachments.filter((a) => a.id === args[1] || a.source_pdf_id === args[1]);
      hit.forEach((a) => { a.entry_id = args[0]; });
      return { results: [], changes: hit.length };
    }
    if (q === "DELETE FROM entries WHERE id = ?") {
      const before = tables.entries.length;
      tables.entries = tables.entries.filter((e) => e.id !== args[0]);
      return { results: [], changes: before - tables.entries.length };
    }
    throw new Error(`測試沒預期到 moveAttachment 會下這句 SQL：${q}`);
  }

  return {
    tables,
    prepare(sql) {
      const make = (args) => ({
        async first() { return exec(sql, args).results[0] || null; },
        async all() { return { results: exec(sql, args).results }; },
        async run() {
          const r = exec(sql, args);
          return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? r.results.length } };
        },
      });
      return { bind: (...args) => make(args) };
    },
  };
}

const noopLogHistory = async () => {};
const fixedNow = () => "2026-08-15T00:00:00.000Z";

test("正常（未刪除）資料夾仍可搬入——修這個 bug 不能連帶擋掉正常搬移", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "來源" },
      { id: 2, name: "目標" },
    ],
    entries: [{ id: 10, folder_id: 1, title: "只有一個檔" }],
    attachments: [{ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null }],
  });

  const result = await moveAttachment(db, 20, 2, { logHistory: noopLogHistory, timestamp: fixedNow });
  assert.equal(result.ok, true);
  assert.equal(result.moved, true);
  assert.equal(db.tables.entries.find((e) => e.id === 10).folder_id, 2);
});

test("已進垃圾桶的資料夾不可搬入——回 404 找不到目標資料夾", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "來源" },
      { id: 2, name: "已刪除的目標", deleted_at: "2026-08-15T00:00:00.000Z" },
    ],
    entries: [{ id: 10, folder_id: 1, title: "只有一個檔" }],
    attachments: [{ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null }],
  });

  const result = await moveAttachment(db, 20, 2, { logHistory: noopLogHistory, timestamp: fixedNow });
  assert.equal(result.error, "找不到目標資料夾");
  assert.equal(result.status, 404);
});

test("拒絕後原附件、原記事及 folder_id 都維持不變（單一附件整筆搬移路徑）", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "來源" },
      { id: 2, name: "已刪除的目標", deleted_at: "2026-08-15T00:00:00.000Z" },
    ],
    entries: [{ id: 10, folder_id: 1, title: "只有一個檔", updated_at: "原始時間" }],
    attachments: [{ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null }],
  });

  await moveAttachment(db, 20, 2, { logHistory: noopLogHistory, timestamp: fixedNow });

  const entry = db.tables.entries.find((e) => e.id === 10);
  assert.equal(entry.folder_id, 1, "記事不該被搬進已刪除的資料夾");
  assert.equal(entry.updated_at, "原始時間", "沒有實際搬移，updated_at 不該被動到");
  assert.equal(db.tables.attachments.find((a) => a.id === 20).entry_id, 10, "附件仍留在原記事底下");
  assert.equal(db.tables.entries.length, 1, "不該多長出任何記事");
});

test("多附件拆分路徑：目的資料夾已刪除時，不拆出新記事、不產生孤兒附件", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "來源" },
      { id: 2, name: "已刪除的目標", deleted_at: "2026-08-15T00:00:00.000Z" },
    ],
    entries: [{ id: 10, folder_id: 1, title: "兩個檔" }],
    attachments: [
      { id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null },
      { id: 21, entry_id: 10, filename: "b.pdf", key: "k2", source_pdf_id: null },
    ],
  });

  const result = await moveAttachment(db, 20, 2, { logHistory: noopLogHistory, timestamp: fixedNow });
  assert.equal(result.status, 404, "在建立新記事之前就要先擋下來");
  assert.equal(db.tables.entries.length, 1, "不該建立承接檔案的新記事（那會是孤兒——所在資料夾已刪除，本身 deleted_at 卻是空的）");
  assert.equal(db.tables.attachments.find((a) => a.id === 20).entry_id, 10, "附件 20 仍留在原記事");
  assert.equal(db.tables.attachments.find((a) => a.id === 21).entry_id, 10, "附件 21 仍留在原記事");
});

test("目的資料夾根本不存在（非刪除，單純沒這個 id）——維持既有 404 行為不受影響", async () => {
  const db = makeDB({
    folders: [{ id: 1, name: "來源" }],
    entries: [{ id: 10, folder_id: 1, title: "只有一個檔" }],
    attachments: [{ id: 20, entry_id: 10, filename: "a.pdf", key: "k1", source_pdf_id: null }],
  });

  const result = await moveAttachment(db, 20, 999, { logHistory: noopLogHistory, timestamp: fixedNow });
  assert.equal(result.error, "找不到目標資料夾");
  assert.equal(result.status, 404);
});
