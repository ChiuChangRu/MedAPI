/**
 * fieldlog/src/lib/settings.js — 使用者自己在前台能調整的 key-value 設定。
 *
 * 用最小的假 DB 驗證「有就更新、沒有就新增」的邏輯，不用整套 worker.js 的
 * mock（那份是給整合測試用的）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getSetting, setSetting } from "../fieldlog/src/lib/settings.js";

function makeSettingsDB() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    prepare(sql) {
      const make = (args) => ({
        async first() {
          calls.push({ sql, args });
          if (sql === "SELECT value FROM settings WHERE key = ?") {
            return rows.has(args[0]) ? { value: rows.get(args[0]).value } : null;
          }
          if (sql === "SELECT key FROM settings WHERE key = ?") {
            return rows.has(args[0]) ? { key: args[0] } : null;
          }
          throw new Error(`未預期的 SQL：${sql}`);
        },
        async run() {
          calls.push({ sql, args });
          if (sql === "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)") {
            rows.set(args[0], { value: args[1], updated_at: args[2] });
            return { meta: { changes: 1 } };
          }
          if (sql === "UPDATE settings SET value = ?, updated_at = ? WHERE key = ?") {
            const row = rows.get(args[2]);
            if (row) Object.assign(row, { value: args[0], updated_at: args[1] });
            return { meta: { changes: row ? 1 : 0 } };
          }
          throw new Error(`未預期的 SQL：${sql}`);
        },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
}

test("getSetting：沒有這個 key 回 null，不是拋錯", async () => {
  const db = makeSettingsDB();
  assert.equal(await getSetting(db, "auto_file_days"), null);
});

test("setSetting 第一次寫入是 INSERT，第二次改同一個 key 是 UPDATE", async () => {
  const db = makeSettingsDB();
  await setSetting(db, "auto_file_days", 2, "2026-08-09 00:00:00Z");
  assert.equal(await getSetting(db, "auto_file_days"), "2");
  const inserts = db.calls.filter((c) => c.sql.startsWith("INSERT"));
  assert.equal(inserts.length, 1);

  await setSetting(db, "auto_file_days", 5, "2026-08-10 00:00:00Z");
  assert.equal(await getSetting(db, "auto_file_days"), "5");
  const updates = db.calls.filter((c) => c.sql.startsWith("UPDATE"));
  assert.equal(updates.length, 1, "改既有 key 要走 UPDATE，不能又 INSERT 一次造成重複列");
});

test("setSetting 一律存字串，數字與字串輸入結果一致", async () => {
  const db = makeSettingsDB();
  await setSetting(db, "k", 7, "t");
  assert.equal(db.rows.get("k").value, "7");
  assert.equal(typeof db.rows.get("k").value, "string");
});
