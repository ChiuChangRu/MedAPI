import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";

// POST /attachments/:id/rotate：純顯示層旋轉，只改 attachments.rotation 這個
// 中繼資料欄位，跟 R2 裡的原始檔案完全無關（raw data 只增不刪）。每次呼叫
// +90° mod 360，角度算在伺服器端（不是前端算好絕對值回傳），避免兩個分頁
// 同時點時互相蓋掉對方剛按的那一下。

function makeFieldlogDB() {
  const attachments = [
    { id: 30, entry_id: 5, filename: "現場照.jpg", rotation: 0 },
  ];

  function exec(sql, args) {
    if (/^CREATE (TABLE|INDEX)/i.test(sql) || /^ALTER TABLE/i.test(sql)) return { results: [] };
    if (sql.includes("SELECT id, entry_id, filename, COALESCE(rotation, 0) AS rotation FROM attachments WHERE id = ?")) {
      const a = attachments.find((row) => row.id === args[0]);
      return { results: a ? [{ id: a.id, entry_id: a.entry_id, filename: a.filename, rotation: a.rotation }] : [] };
    }
    if (sql.includes("UPDATE attachments SET rotation = ? WHERE id = ?")) {
      const [rotation, id] = args;
      const a = attachments.find((row) => row.id === id);
      if (a) a.rotation = rotation;
      return { results: [] };
    }
    return { results: [] };
  }

  return {
    attachments,
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: exec(sql, args).results }; },
            async first() { return exec(sql, args).results[0] || null; },
            async run() { const r = exec(sql, args); return { meta: { last_row_id: r.lastRowId } }; },
          };
        },
        async all() { return { results: exec(sql, []).results }; },
        async first() { return exec(sql, []).results[0] || null; },
        async run() { const r = exec(sql, []); return { meta: { last_row_id: r.lastRowId } }; },
      };
    },
  };
}

async function postRotate(env, id) {
  const req = new Request(`https://x/api/attachments/${id}/rotate?pin=pin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pin": "pin" },
    body: "{}",
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("每點一次 +90 度", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const r1 = await postRotate(env, 30);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.rotation, 90);
  assert.equal(DB.attachments[0].rotation, 90, "要真的寫回資料庫，不是只回傳算好的值");

  const r2 = await postRotate(env, 30);
  assert.equal(r2.data.rotation, 180);
  const r3 = await postRotate(env, 30);
  assert.equal(r3.data.rotation, 270);
});

test("轉滿一圈回到 0（mod 360，不會一直往上累加）", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  await postRotate(env, 30);
  await postRotate(env, 30);
  await postRotate(env, 30);
  const r4 = await postRotate(env, 30);
  assert.equal(r4.data.rotation, 0);
});

test("角度算在伺服器端，不是前端傳絕對值——請求 body 沒帶任何角度也一樣能轉", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const req = new Request("https://x/api/attachments/30/rotate?pin=pin", { method: "POST" }); // 完全不帶 body
  const res = await fieldlogWorker.fetch(req, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rotation, 90);
});

test("查無此附件回 404，不會憑空生一筆 rotation", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  const res = await postRotate(env, 999);
  assert.equal(res.status, 404);
});

test("旋轉不會動到原始檔案相關欄位（raw data 只增不刪）", async () => {
  const DB = makeFieldlogDB();
  const env = { FIELD_PIN: "pin", DB };
  await postRotate(env, 30);
  assert.equal(DB.attachments[0].filename, "現場照.jpg", "旋轉只改 rotation，檔名等其他欄位不該被動到");
});
