/**
 * 自動歸類的判斷規則（fieldlog/src/lib/autofile.js 的 hints／corrections）。
 *
 * 設計重點：規則會自己長，但一定要人核准才會生效——系統只負責偵測「這個
 * 資料夾最近被手動修正了好幾次」這個訊號並跳出候選，關鍵字永遠是使用者
 * 自己填的，不是 AI 用猜的。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOFILE_HINT_MIN_OCCURRENCES,
  addHint,
  approveHint,
  deleteHint,
  getActiveHints,
  getPendingHints,
  matchHints,
  recordAutoFileCorrection,
  reviewAutoFileCorrections,
} from "../fieldlog/src/lib/autofile.js";

function makeDB() {
  const tables = { autofile_hints: [], autofile_corrections: [] };
  const nextId = { autofile_hints: 1, autofile_corrections: 1 };

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (q === "INSERT INTO autofile_hints (folder_id, keyword, status, note, created_at) VALUES (?, ?, ?, ?, ?)") {
      const id = nextId.autofile_hints++;
      tables.autofile_hints.push({ id, folder_id: args[0], keyword: args[1], status: args[2], note: args[3], created_at: args[4] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'active' ORDER BY id") {
      return { results: tables.autofile_hints.filter((h) => h.status === "active") };
    }
    if (q === "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'suggested' ORDER BY id") {
      return { results: tables.autofile_hints.filter((h) => h.status === "suggested") };
    }
    if (q === "UPDATE autofile_hints SET keyword = ?, status = 'active' WHERE id = ? AND status = 'suggested'") {
      const row = tables.autofile_hints.find((h) => h.id === args[1] && h.status === "suggested");
      if (row) { row.keyword = args[0]; row.status = "active"; }
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM autofile_hints WHERE id = ?") {
      const before = tables.autofile_hints.length;
      tables.autofile_hints = tables.autofile_hints.filter((h) => h.id !== args[0]);
      return { results: [], changes: before - tables.autofile_hints.length };
    }
    if (q === "SELECT DISTINCT folder_id FROM autofile_hints WHERE status IN ('active', 'suggested') AND (keyword = '' OR keyword IS NULL)") {
      const ids = [...new Set(tables.autofile_hints.filter((h) => !h.keyword).map((h) => h.folder_id))];
      return { results: ids.map((folder_id) => ({ folder_id })) };
    }
    if (q === "INSERT INTO autofile_corrections (entry_id, from_folder_id, to_folder_id, keyword_guess, created_at) VALUES (?, ?, ?, ?, ?)") {
      const id = nextId.autofile_corrections++;
      tables.autofile_corrections.push({
        id, entry_id: args[0], from_folder_id: args[1], to_folder_id: args[2], keyword_guess: args[3],
        created_at: args[4], reviewed_at: "",
      });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id FROM autofile_corrections WHERE COALESCE(reviewed_at, '') = ''") {
      return { results: tables.autofile_corrections.filter((c) => !c.reviewed_at) };
    }
    if (q === "SELECT to_folder_id, keyword_guess FROM autofile_corrections") {
      return { results: tables.autofile_corrections };
    }
    if (q === "UPDATE autofile_corrections SET reviewed_at = ? WHERE id = ?") {
      const row = tables.autofile_corrections.find((c) => c.id === args[1]);
      if (row) row.reviewed_at = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }

    throw new Error(`unhandled SQL in fake DB: ${q}`);
  }

  return {
    tables,
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() {
          const r = exec(sql, args);
          return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? r.results.length } };
        },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
}

test("matchHints: 唯一命中一個資料夾才當高信心結果", () => {
  const hints = [
    { folder_id: 1, keyword: "UV膠" },
    { folder_id: 2, keyword: "報價" },
  ];
  const allowed = new Set([1, 2]);
  assert.deepEqual(matchHints(hints, "這批 UV膠 的黏著測試", allowed), { folderId: 1, keyword: "UV膠" });
  assert.equal(matchHints(hints, "跟這兩個關鍵字完全無關的內容", allowed), null);
});

test("matchHints: 大小寫不敏感，且同時命中不同資料夾時退回 null（規則打架不能悄悄選一個）", () => {
  const hints = [{ folder_id: 1, keyword: "TDS" }, { folder_id: 2, keyword: "tds" }];
  assert.equal(matchHints(hints, "廠商附的 TDS 文件", new Set([1, 2])), null);
});

test("matchHints: 規則指到的資料夾已經不在允許清單（例如被刪了）就跳過", () => {
  const hints = [{ folder_id: 99, keyword: "UV膠" }];
  assert.equal(matchHints(hints, "UV膠測試", new Set([1, 2])), null);
});

test("addHint: active 規則沒填關鍵字要被拒絕，suggested 可以先不填", async () => {
  const db = makeDB();
  assert.equal(await addHint(db, { folderId: 1, keyword: "", status: "active" }, "t"), null);
  const id = await addHint(db, { folderId: 1, keyword: "", status: "suggested", note: "候選" }, "t");
  assert.ok(id);
  assert.equal((await getPendingHints(db))[0].note, "候選");
});

test("approveHint: 採用候選規則要帶關鍵字，之後 getActiveHints 找得到；沒填關鍵字不給過", async () => {
  const db = makeDB();
  const id = await addHint(db, { folderId: 5, keyword: "", status: "suggested" }, "t");
  assert.equal(await approveHint(db, id, ""), false, "沒填關鍵字不能採用");
  assert.equal(await approveHint(db, id, "親水塗層"), true);
  const active = await getActiveHints(db);
  assert.equal(active.length, 1);
  assert.equal(active[0].keyword, "親水塗層");
  assert.equal((await getPendingHints(db)).length, 0, "採用後就不再是候選");
});

test("deleteHint: 候選或已生效的規則都能直接刪掉", async () => {
  const db = makeDB();
  const id = await addHint(db, { folderId: 1, keyword: "報價", status: "active" }, "t");
  assert.equal(await deleteHint(db, id), true);
  assert.equal((await getActiveHints(db)).length, 0);
  assert.equal(await deleteHint(db, 99999), false, "刪不存在的規則要回報失敗，不是靜默成功");
});

test("reviewAutoFileCorrections: 同一個資料夾累積到門檻次數才建議候選規則，只有一次不會吵使用者", async () => {
  const db = makeDB();
  assert.equal(AUTOFILE_HINT_MIN_OCCURRENCES, 2, "門檻目前是 2 次，這個測試跟著這個假設走");
  await recordAutoFileCorrection(db, { entryId: 1, fromFolderId: 9, toFolderId: 20, entryTitle: "UV膠測試A", timestamp: "t1" });
  let result = await reviewAutoFileCorrections(db, { timestamp: () => "t2" });
  assert.equal(result.reviewed, 1);
  assert.equal(result.suggested, 0, "只發生一次不該建議");
  assert.equal((await getPendingHints(db)).length, 0);

  await recordAutoFileCorrection(db, { entryId: 2, fromFolderId: 9, toFolderId: 20, entryTitle: "UV膠測試B", timestamp: "t3" });
  result = await reviewAutoFileCorrections(db, { timestamp: () => "t4" });
  assert.equal(result.suggested, 1, "累積到第二次要建議一條候選規則");
  const pending = await getPendingHints(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].folder_id, 20);
  assert.equal(pending[0].keyword, "", "候選規則的關鍵字先留空，等使用者自己填");
  assert.match(pending[0].note, /UV膠測試A/);
  assert.match(pending[0].note, /UV膠測試B/);
});

test("reviewAutoFileCorrections: 已經有候選規則在等的資料夾，不會重複再建議一條", async () => {
  const db = makeDB();
  for (let i = 0; i < 3; i++) {
    await recordAutoFileCorrection(db, { entryId: i, fromFolderId: 9, toFolderId: 20, entryTitle: `案例${i}`, timestamp: "t" });
  }
  const first = await reviewAutoFileCorrections(db, { timestamp: () => "t1" });
  assert.equal(first.suggested, 1);

  await recordAutoFileCorrection(db, { entryId: 99, fromFolderId: 9, toFolderId: 20, entryTitle: "又一筆", timestamp: "t2" });
  const second = await reviewAutoFileCorrections(db, { timestamp: () => "t3" });
  assert.equal(second.suggested, 0, "folder 20 已經有候選規則在等使用者決定，不用再建議一次");
  assert.equal((await getPendingHints(db)).length, 1);
});

test("reviewAutoFileCorrections: 每一筆修正都會標記已處理，不會被下一次排程重複彙整", async () => {
  const db = makeDB();
  await recordAutoFileCorrection(db, { entryId: 1, fromFolderId: 9, toFolderId: 20, entryTitle: "A", timestamp: "t" });
  await reviewAutoFileCorrections(db, { timestamp: () => "t1" });
  assert.equal(db.tables.autofile_corrections[0].reviewed_at, "t1");
  const second = await reviewAutoFileCorrections(db, { timestamp: () => "t2" });
  assert.equal(second.reviewed, 0, "已經處理過的不該再被算一次");
});
