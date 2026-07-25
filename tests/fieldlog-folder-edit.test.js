import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";

// PUT /folders/:id 原本只能改 name／status，type 建立後沒地方修正——
// 分類選錯（或匯入資料類型跟預期不同）只能刪掉重建。這份測試涵蓋新開放的 type 欄位。

function makeFieldlogDB() {
  const folders = [
    { id: 11, name: "課程", type: "中央靜脈導管（CVC）", status: "進行中", parent_id: null, created_at: "2026-07-24" },
  ];
  const history = [];

  function exec(sql, args) {
    if (/^CREATE (TABLE|INDEX)/i.test(sql) || /^ALTER TABLE/i.test(sql)) return { results: [] };
    if (sql.includes("SELECT * FROM folders WHERE id = ?")) {
      const f = folders.find((row) => row.id === args[0]);
      return { results: f ? [f] : [] };
    }
    if (sql.includes("UPDATE folders SET name = ?, status = ?, type = ? WHERE id = ?")) {
      const [name, status, type, id] = args;
      const f = folders.find((row) => row.id === id);
      if (f) { f.name = name; f.status = status; f.type = type; }
      return { results: [] };
    }
    if (sql.includes("INSERT INTO history")) { history.push(args); return { results: [] }; }
    return { results: [] };
  }

  return {
    folders, history,
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: exec(sql, args).results }; },
            async first() { return exec(sql, args).results[0] || null; },
            async run() { const r = exec(sql, args); return { meta: { last_row_id: r.lastRowId, changes: r.results.length } }; },
          };
        },
        // ensureSchema()／MIGRATIONS 是直接 .prepare(sql).run()，不經過 .bind()
        async all() { return { results: exec(sql, []).results }; },
        async first() { return exec(sql, []).results[0] || null; },
        async run() { const r = exec(sql, []); return { meta: { last_row_id: r.lastRowId } }; },
      };
    },
  };
}

async function putFolder(env, id, body) {
  const req = new Request(`https://x/api/folders/${id}?pin=pin`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-pin": "pin" },
    body: JSON.stringify(body),
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("PUT /folders/:id 可以修正建立時選錯的 type", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const res = await putFolder(env, 11, { name: "課程", type: "上課" });
  assert.equal(res.status, 200);
  assert.equal(DB.folders[0].type, "上課");
  assert.equal(DB.folders[0].name, "課程", "沒特別要求改名字時名字不變");
});

test("PUT /folders/:id 不給 type 時沿用原本的值（向下相容舊呼叫）", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const res = await putFolder(env, 11, { name: "課程改名" });
  assert.equal(res.status, 200);
  assert.equal(DB.folders[0].type, "中央靜脈導管（CVC）", "沒傳 type 就不該被清空或改動");
  assert.equal(DB.folders[0].name, "課程改名");
});

test("PUT /folders/:id 型別給空字串要拒絕，不會把資料夾改成沒有分類", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const res = await putFolder(env, 11, { name: "課程", type: "" });
  assert.equal(res.status, 400);
  assert.equal(DB.folders[0].type, "中央靜脈導管（CVC）", "失敗時不該改到任何東西");
});

test("PUT /folders/:id 查無此資料夾回 404", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const res = await putFolder(env, 999, { name: "x", type: "上課" });
  assert.equal(res.status, 404);
});
