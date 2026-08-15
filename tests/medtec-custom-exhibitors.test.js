/**
 * cloudflare/src/worker.js：自訂廠商（官方展商目錄以外，團隊自己追蹤的）。
 *
 * 2026-08-10 長儒的情境：昌毅指定的 5 家 CDMO 候選裡，有 3 家根本沒參展
 * Medtec，不在官方展商目錄裡，但還是想指派、寫紀錄、進 PDF 報告追蹤。
 * 官方展商目錄要重新爬官網才能更新，不可能為了追蹤幾家沒參展的公司就
 * 一直要求重新匯入整份名冊——所以另外開一張 custom_exhibitors 表，讓
 * 團隊直接在 App 裡新增，id 前綴跟官方的 ex-XXXX 分開，其餘欄位跟
 * exhibitors.json 同形狀，指派/筆記/PDF 報告全部沿用既有邏輯。
 *
 * 這裡鎖住兩件事：
 * 1. 基本 CRUD（新增驗證、軟刪除、列表排除已刪除）
 * 2. 加進來之後，既有的 /report／/export.csv 兩支端點都要正確併入自訂
 *    廠商的名稱——這兩支原本都是「只從靜態 exhibitors.json 建 exMap」，
 *    加了 custom_exhibitors 表之後如果忘記兩邊都改，自訂廠商在個人報告
 *    裡會被 .filter((x) => x.ex) 悄悄濾掉、在 CSV 匯出裡會變成「廠商」
 *    欄空白的一列——都不會報錯，只會讓人以為資料不見了或壞掉。
 */

import assert from "node:assert/strict";
import test from "node:test";

import medtecWorker from "../cloudflare/src/worker.js";

const TEAM_PIN = "pin1234";
const STATIC_EXHIBITORS = [
  { id: "ex-0001", name_zh: "官方展商甲", name_en: "Official A", booth_no: "N1-A01", country: "中國", category: "cat-05", tags: [], description: "", products: [], website: "" },
];

function makeDB() {
  const tables = { members: [], exhibitor_state: [], notes: [], history: [], attachments: [], line_recipients: [], custom_exhibitors: [] };
  let nextHistoryId = 1;

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (/^CREATE (TABLE|INDEX)/i.test(q)) return none;
    if (/^ALTER TABLE/i.test(q)) return none;

    if (q === "SELECT * FROM custom_exhibitors WHERE deleted = 0 ORDER BY id") {
      return { results: tables.custom_exhibitors.filter((r) => !r.deleted).map((r) => ({ ...r })), changes: 0 };
    }
    if (q === "SELECT * FROM custom_exhibitors WHERE deleted = 0") {
      return { results: tables.custom_exhibitors.filter((r) => !r.deleted).map((r) => ({ ...r })), changes: 0 };
    }
    if (q.startsWith("INSERT INTO custom_exhibitors")) {
      const [id, name_zh, name_en, booth_no, country, category, description, website, added_by, created_at] = args;
      tables.custom_exhibitors.push({ id, name_zh, name_en, booth_no, country, category, description, website, added_by, created_at, deleted: 0 });
      return { results: [], changes: 1 };
    }
    if (q === "SELECT * FROM custom_exhibitors WHERE id = ? AND deleted = 0") {
      const row = tables.custom_exhibitors.find((r) => r.id === args[0] && !r.deleted);
      return { results: row ? [{ ...row }] : [], changes: 0 };
    }
    if (q === "UPDATE custom_exhibitors SET deleted = 1 WHERE id = ?") {
      const row = tables.custom_exhibitors.find((r) => r.id === args[0]);
      if (row) row.deleted = 1;
      return { results: [], changes: row ? 1 : 0 };
    }

    if (q === "SELECT * FROM exhibitor_state") return { results: tables.exhibitor_state.map((r) => ({ ...r })), changes: 0 };
    if (q === "SELECT * FROM notes WHERE deleted = 0 AND author = ? ORDER BY id") {
      return { results: tables.notes.filter((n) => !n.deleted && n.author === args[0]), changes: 0 };
    }
    if (q === "SELECT * FROM notes WHERE deleted = 0 ORDER BY exhibitor_id, id") {
      return { results: tables.notes.filter((n) => !n.deleted), changes: 0 };
    }
    if (q === "SELECT * FROM attachments WHERE author = ? ORDER BY id") {
      return { results: tables.attachments.filter((a) => a.author === args[0]), changes: 0 };
    }
    if (q.startsWith("INSERT INTO history")) {
      tables.history.push({ id: nextHistoryId++, exhibitor_id: args[0], author: args[1], action: args[2], detail: args[3], created_at: args[4] });
      return { results: [], changes: 1 };
    }
    if (q.startsWith("INSERT INTO exhibitor_state")) {
      const [exhibitor_id, updated_by, updated_at] = args;
      if (!tables.exhibitor_state.some((s) => s.exhibitor_id === exhibitor_id)) {
        tables.exhibitor_state.push({ exhibitor_id, status: "未排定", assignee: "", dept_tags: "[]", collected: "[]", goal_tags: "[]", quals: "[]", post_class: "", pocket: 0, visit_record: "{}", updated_by, updated_at });
      }
      return { results: [], changes: 1 };
    }
    if (q.startsWith("UPDATE exhibitor_state SET")) {
      const exhibitorId = args[args.length - 1];
      const row = tables.exhibitor_state.find((s) => s.exhibitor_id === exhibitorId);
      const setClause = q.match(/SET (.+) WHERE/)[1];
      const fields = setClause.split(",").map((s) => s.trim().split(" = ")[0]);
      fields.forEach((f, i) => { row[f] = args[i]; });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "SELECT COUNT(*) AS note_count FROM notes WHERE deleted = 0 GROUP BY exhibitor_id" || q.includes("exhibitor_id, COUNT(*) AS note_count")) {
      return { results: [], changes: 0 };
    }
    return none;
  }

  const db = {
    tables,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { const r = exec(sql, args); return { meta: { changes: r.changes } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db, { exhibitors = STATIC_EXHIBITORS } = {}) {
  return {
    TEAM_PIN,
    DB: db,
    ASSETS: {
      async fetch() {
        return { async json() { return { exhibitors, categories: [] }; } };
      },
    },
  };
}

function call(env, path, { method = "GET", body } = {}) {
  const req = new Request(`https://x/api${path}`, {
    method,
    headers: { "x-team-pin": TEAM_PIN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ctx = { waitUntil: () => {} };
  return medtecWorker.fetch(req, env, ctx).then(async (res) => ({ status: res.status, data: await res.json() }));
}

test("新增自訂廠商：中文英文都沒填要擋下來", async () => {
  const env = makeEnv(makeDB());
  const res = await call(env, "/custom-exhibitors", { method: "POST", body: { booth_no: "N1-B01" } });
  assert.equal(res.status, 400);
});

test("新增自訂廠商成功：id 用 custom- 前綴，跟官方 ex-XXXX 分開避免撞號", async () => {
  const env = makeEnv(makeDB());
  const res = await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "測試CDMO", author: "昌毅" } });
  assert.equal(res.status, 200);
  assert.match(res.data.id, /^custom-/);
  assert.equal(res.data.name_zh, "測試CDMO");
  assert.equal(res.data.custom, true, "要標記 custom:true，前端才知道要顯示自訂徽章");
});

test("列表只回傳未刪除的自訂廠商", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "A公司" } })).data;
  await call(env, `/custom-exhibitors/${created.id}?author=昌毅`, { method: "DELETE" });
  await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "B公司" } });

  const list = (await call(env, "/custom-exhibitors")).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].name_zh, "B公司");
});

test("刪除是軟刪除：資料庫裡的紀錄還在，只是不會出現在列表", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "要刪的" } })).data;
  const res = await call(env, `/custom-exhibitors/${created.id}?author=昌毅`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const row = env.DB.tables.custom_exhibitors.find((r) => r.id === created.id);
  assert.equal(row.deleted, 1, "軟刪除，底下如果已經有指派/紀錄不會變成孤兒");
});

test("刪除不存在的自訂廠商回 404", async () => {
  const env = makeEnv(makeDB());
  const res = await call(env, "/custom-exhibitors/custom-not-exist", { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("個人報告（/report）要併入自訂廠商——被指派的自訂廠商不該被悄悄濾掉", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "TT Medical" } })).data;
  await call(env, `/state/${created.id}`, { method: "PUT", body: { assignee: "昌毅", author: "昌毅" } });

  const req = new Request(`https://x/api/report?author=昌毅&pin=${TEAM_PIN}`);
  const res = await medtecWorker.fetch(req, env, { waitUntil: () => {} });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /TT Medical/, "指派給昌毅的自訂廠商要出現在他的個人報告裡，不能因為不在靜態 exhibitors.json 裡就被濾掉");
});

test("CSV 匯出（/export.csv）的自訂廠商要顯示正確公司名，不是空白", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/custom-exhibitors", { method: "POST", body: { name_zh: "天津匯田" } })).data;
  await call(env, `/state/${created.id}`, { method: "PUT", body: { status: "已排定", author: "昌毅" } });

  const req = new Request(`https://x/api/export.csv?pin=${TEAM_PIN}`, { headers: { "x-team-pin": TEAM_PIN } });
  const res = await medtecWorker.fetch(req, env, { waitUntil: () => {} });
  const csv = await res.text();
  assert.match(csv, /天津匯田/, "自訂廠商在 CSV 裡不該變成廠商欄空白的一列");
});
