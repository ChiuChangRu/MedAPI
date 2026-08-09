import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker from "../mcp/src/worker.js";

// medapi-mcp 對「記事的實際內容」與「關聯／同義詞」預設唯讀：
// create_fieldlog_entry／create_fieldlog_attachment／create_relation／add_synonym
// 四支工具能寫入，而且只能 INSERT（新增），不能 UPDATE／DELETE——這份測試守的
// 就是這件事：mcp/src/worker.js 裡不會出現操作 entries 內容／attachments／
// relations／synonyms 的 SQL UPDATE 或 DELETE 語句。
//
// 2026-08-08 分類重整新增了 update_folder／move_folder／move_entry／
// delete_folder 四支資料夾整理工具，範圍限定在資料夾結構與記事的歸檔位置，
// 這四支「沒有」自己的 SQL UPDATE／DELETE 字串——全部是 fetch(..., {method:
// "PUT"/"DELETE"}) 透過 FIELDLOG Service Binding 打 fieldlog 自己既有、
// 已經測試過的 /api/folders、/api/entries 端點，真正的 UPDATE／DELETE SQL
// 執行在 fieldlog/src/worker.js 那邊，不在這支檔案裡，所以下面這條正規表達式
// 守衛依然成立且依然有意義：medapi-mcp 自己的程式碼裡沒有寫任何一行會
// 修改／刪除既有資料的 SQL。

test("原始碼裡沒有任何 SQL UPDATE 或 DELETE 語句（寫入只能是 INSERT，或代理呼叫 fieldlog 既有端點）", async () => {
  const src = await readFile(new URL("../mcp/src/worker.js", import.meta.url), "utf8");
  assert.equal(/\bUPDATE\s+\w/i.test(src), false, "不應該出現 SQL UPDATE 語句");
  assert.equal(/\bDELETE\s+FROM\b/i.test(src), false, "不應該出現 SQL DELETE FROM 語句");
  // entries+history、relations+history、synonyms 出廠 seed、add_synonym 各 1 處
  assert.equal((src.match(/INSERT INTO/g) || []).length, 6, "應該剛好 6 處 INSERT INTO（entries+history、relations+history、synonyms seed、add_synonym）");
});

// 一顆會記狀態的假 D1，只實作這兩支工具真的會用到的查詢／寫入
function makeWritableFieldlogDB() {
  const folders = [{ id: 1, name: "ISO 資料庫", type: "標準", parent_id: null }];
  const entries = [
    { id: 42, folder_id: null, title: "既有記事 A", body: "", fields_json: "{}" },
    { id: 43, folder_id: null, title: "既有記事 B", body: "", fields_json: "{}" },
  ];
  const relations = [];
  const history = [];
  let nextEntryId = 100;
  let nextRelId = 1;

  function exec(sql, args) {
    if (sql.includes("SELECT id, name, type FROM folders WHERE id")) {
      const f = folders.find((row) => row.id === args[0]);
      return { results: f ? [f] : [] };
    }
    if (sql.includes("INSERT INTO entries")) {
      const [folderId, title, fieldsJson, body] = args;
      const row = { id: nextEntryId++, folder_id: folderId, title, fields_json: fieldsJson, body };
      entries.push(row);
      return { results: [], lastRowId: row.id };
    }
    if (sql.includes("SELECT id, title FROM entries WHERE id")) {
      const e = entries.find((row) => row.id === args[0]);
      return { results: e ? [{ id: e.id, title: e.title }] : [] };
    }
    if (sql.includes("INSERT INTO relations")) {
      const [fromId, toId, relationType, note] = args;
      const row = { id: nextRelId++, from_entry_id: fromId, to_entry_id: toId, relation_type: relationType, note };
      relations.push(row);
      return { results: [], lastRowId: row.id };
    }
    if (sql.includes("INSERT INTO history")) {
      history.push(args);
      return { results: [], lastRowId: history.length };
    }
    return { results: [] };
  }

  return {
    folders, entries, relations, history,
    prepare(sql) {
      return {
        bind(...args) {
          // 真正的 D1 對「? 佔位符數量 ≠ bind() 參數數量」會直接報錯（Wrong number of
          // parameter bindings）。之前的 mock 沒做這個檢查，讓漏寫一個參數的 bug
          // 在測試裡悄悄過關，實際上到正式環境才炸——這裡補上，跟真正的 D1 行為一致。
          const placeholders = (sql.match(/\?/g) || []).length;
          if (placeholders !== args.length) {
            throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query.`);
          }
          return {
            async all() { return { results: exec(sql, args).results }; },
            async first() { return exec(sql, args).results[0] || null; },
            async run() { const r = exec(sql, args); return { meta: { last_row_id: r.lastRowId } }; },
          };
        },
      };
    },
  };
}

async function callTool(env, name, args) {
  const req = new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, env);
  return (await res.json()).result;
}

test("create_fieldlog_entry：缺 title 報錯，不寫入任何東西", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const result = await callTool(env, "create_fieldlog_entry", { body: "沒有標題" });
  assert.equal(result.isError, true);
  assert.equal(db.entries.length, 2, "失敗時不該多出任何一列");
});

test("create_fieldlog_entry：不填 folder_id 進收件匣，成功寫入", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const result = await callTool(env, "create_fieldlog_entry", { title: "臨時記一筆", body: "討論到的重點" });
  assert.match(result.content[0].text, /收件匣/);
  const created = db.entries.find((e) => e.title === "臨時記一筆");
  assert.ok(created, "應該真的寫進資料庫");
  assert.equal(created.body, "討論到的重點");
});

test("create_fieldlog_entry：指到不存在的資料夾要報錯，不會硬寫", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const result = await callTool(env, "create_fieldlog_entry", { title: "指到不存在的資料夾", folder_id: 999 });
  assert.equal(result.isError, true);
  assert.equal(db.entries.some((e) => e.title === "指到不存在的資料夾"), false);
});

test("create_fieldlog_entry：給正確 folder_id 會直接歸檔，自訂欄位存進 fields_json，並寫 history 標註來源", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const result = await callTool(env, "create_fieldlog_entry", {
    title: "ISO 7886-2 標準歸檔", folder_id: 1, fields: { 標準編號: "ISO 7886-2" },
  });
  assert.match(result.content[0].text, /ISO 資料庫/);
  const row = db.entries.find((e) => e.title === "ISO 7886-2 標準歸檔");
  assert.equal(JSON.parse(row.fields_json).標準編號, "ISO 7886-2");
  assert.ok(db.history.some((h) => String(h[3]).includes("MCP")), "history 要能看出這是透過 MCP 新增的");
});

test("create_relation：起點/終點/自我關聯/查無記事都要擋下，不寫入任何關聯", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const missing = await callTool(env, "create_relation", { from_entry_id: 42, relation_type: "測試對象" });
  assert.equal(missing.isError, true);
  const self = await callTool(env, "create_relation", { from_entry_id: 42, to_entry_id: 42, relation_type: "測試對象" });
  assert.equal(self.isError, true);
  const noSuchEntry = await callTool(env, "create_relation", { from_entry_id: 42, to_entry_id: 9999, relation_type: "測試對象" });
  assert.equal(noSuchEntry.isError, true);
  assert.equal(db.relations.length, 0, "上面三次都該失敗，不該留下任何關聯");
});

test("create_relation：成功建立雙向可查的關聯，且完全沒動到既有記事內容", async () => {
  const db = makeWritableFieldlogDB();
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: db };
  const result = await callTool(env, "create_relation", {
    from_entry_id: 42, to_entry_id: 43, relation_type: "測試對象", note: "備註文字",
  });
  assert.match(result.content[0].text, /既有記事 A/);
  assert.match(result.content[0].text, /既有記事 B/);
  assert.match(result.content[0].text, /測試對象/);
  assert.ok(db.relations.some((r) => r.from_entry_id === 42 && r.to_entry_id === 43 && r.note === "備註文字"));
  assert.ok(db.history.some((h) => h[2] === "新增關聯" && String(h[3]).includes("MCP")));
  // 只增不改：兩筆既有記事的標題全程不變
  assert.equal(db.entries.find((e) => e.id === 42).title, "既有記事 A");
  assert.equal(db.entries.find((e) => e.id === 43).title, "既有記事 B");
});
