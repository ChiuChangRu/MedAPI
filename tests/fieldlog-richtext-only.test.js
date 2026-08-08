/**
 * 記事內文只有一種格式：富文字。
 *
 * 原本是雙軌——新記事建成 body_format='text'，使用者要自己按「⤴ 升級為富文字」
 * 才會換成 html。兩種格式並存代表每個消費端（搜尋、匯出、合併、MyWiki）都要
 * 記得分兩條路處理，也代表使用者得先知道有這顆按鈕才用得到富文字。
 * 現在新記事直接是 html，舊記事打開就以富文字編輯、存檔時一併定案。
 *
 * 唯一保留純文字的是來源同步管理的記事（fields_json._sid／litdb_id）：它的 body
 * 夾著 <!-- sync:start/end --> 標記，而 sanitizeEntryHtml 會把 HTML 註解清掉，
 * 標記一消失，下次同步的 mergeSyncedBody 就會把整個 body 當同步區整段覆寫，
 * 使用者手寫在 SYNC_END 之後的備註會直接不見。這幾項就是防止那件事再被打開。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB() {
  const tables = { entries: [], history: [] };
  let nextId = 1;
  const inserts = [];

  function exec(sql, args = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0, meta: {} };
    if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(q) || /^ALTER TABLE/i.test(q) || /^DROP INDEX/i.test(q)) return none;
    if (q.startsWith("INSERT INTO entries (folder_id, title, fields_json, body, body_format, created_at)")) {
      const row = { id: nextId++, folder_id: args[0], title: args[1], fields_json: args[2], body: args[3], body_format: args[4] };
      tables.entries.push(row);
      inserts.push(row);
      return { results: [], meta: { last_row_id: row.id } };
    }
    if (q.startsWith("INSERT INTO history")) return none;
    if (q === "SELECT * FROM entries WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q.startsWith("UPDATE entries SET")) {
      const row = tables.entries.find((e) => e.id === args[args.length - 1]);
      if (row) { row.body = args[1]; row.body_format = args[4]; }
      return { ...none, meta: { changes: row ? 1 : 0 } };
    }
    return none;
  }

  return {
    tables,
    inserts,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { return exec(sql, args); },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
}

function makeEnv(db) {
  resetSchemaCacheForTests();
  return { FIELD_PIN: "pin", DB: db };
}

async function post(env, path, payload) {
  const req = new Request(`https://x/api${path}`, {
    method: "POST",
    headers: { "x-pin": "pin", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function put(env, path, payload) {
  const req = new Request(`https://x/api${path}`, {
    method: "PUT",
    headers: { "x-pin": "pin", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("新記事預設就是富文字，純文字內容會轉成 HTML 段落", async () => {
  const db = makeDB();
  const res = await post(makeEnv(db), "/entries", { title: "現場速記", body: "第一段\n第二行\n\n第三段" });
  assert.equal(res.status, 200);
  const row = db.inserts[0];
  assert.equal(row.body_format, "html", "不該再建成 text 讓使用者自己去升級");
  assert.match(row.body, /<p>第一段<br>第二行<\/p>/, "單一換行要變 <br>");
  assert.match(row.body, /<p>第三段<\/p>/, "空行要分段");
});

test("新記事的純文字內容會被轉義，不會被當成 HTML 吃掉", async () => {
  const db = makeDB();
  await post(makeEnv(db), "/entries", { title: "t", body: "濃度 < 5% & 溫度 > 30" });
  const row = db.inserts[0];
  assert.match(row.body, /&lt; 5% &amp; 溫度 &gt;/, "使用者打的角括號是文字，不是標籤");
  assert.doesNotMatch(row.body, /<script/i);
});

test("沒有內文的新記事（錄音／拍照建立的）不會壞掉", async () => {
  const db = makeDB();
  const res = await post(makeEnv(db), "/entries", { title: "錄音 12:34" });
  assert.equal(res.status, 200);
  assert.equal(db.inserts[0].body_format, "html");
  assert.equal(db.inserts[0].body, "");
});

test("明確指定 body_format='text' 時仍存成純文字（同步引擎等呼叫端用）", async () => {
  const db = makeDB();
  await post(makeEnv(db), "/entries", { title: "t", body: "純文字內容", body_format: "text" });
  const row = db.inserts[0];
  assert.equal(row.body_format, "text");
  assert.equal(row.body, "純文字內容", "指定 text 就不該被轉成 HTML");
});

test("同步管理的記事不能被升級成富文字（後端第二道防線還在）", async () => {
  const db = makeDB();
  db.tables.entries.push({
    id: 1, folder_id: null, title: "litdb 文獻", body: "<!-- sync:start -->來源內容<!-- sync:end -->\n我的備註",
    body_format: "text", fields_json: JSON.stringify({ _sid: "coating:X1" }),
  });
  const res = await put(makeEnv(db), "/entries/1", { body_format: "html", body: "<p>來源內容</p>" });
  assert.equal(res.status, 400, "要擋下來，否則同步標記會被清掉、下次同步覆蓋掉使用者備註");
  assert.match(res.body.error, /同步管理/);
  assert.equal(db.tables.entries[0].body_format, "text", "格式不能被改動");
});

test("前端已經沒有手動升級入口（比對按鈕本身，不是註解裡的字）", async () => {
  const appJs = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  // 只禁按鈕與它的 handler；註解裡為了說明「為什麼拿掉」而提到這個詞是合理的
  assert.doesNotMatch(appJs, /e-body-upgrade/, "按鈕與 handler 都要移除，不要留死碼");
  assert.doesNotMatch(appJs, /<button[^>]*>[^<]*升級為富文字/, "不該再有手動升級的按鈕");
});

test("同步管理的記事仍然走純文字編輯框（前端第一道防線）", async () => {
  const appJs = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  assert.match(appJs, /const bodyFormat = isSynced \? "text" : "html"/,
    "同步記事必須維持 text，否則富文字存檔會清掉 <!-- sync:start/end --> 標記");
});
