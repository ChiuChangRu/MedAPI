/**
 * v222 AI 建議新增資料夾：AI（經 MyWiki MCP，主機 fieldlog.internal）不能直接建立資料夾、
 * 不能自行同意建議；只有使用者本人在網頁同意後才建立。用 node:sqlite 當 D1 實跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { sqlite, prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
}

async function call(env, host, path, method = "GET", body) {
  const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
    method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }), { ...env, FIELD_PIN: "1234" });
  return { status: res.status, body: await res.json() };
}
const AI = "fieldlog.internal";
const WEB = "fieldlog.example.dev";

test("AI 只能建議；本人同意後才建立，紀錄標明 AI 建議", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const env = { DB: db };

  const direct = await call(env, AI, "/folders", "POST", { name: "AI 直接建", category: "misc" });
  assert.equal(direct.status, 403, "AI 不能直接建立資料夾");

  const parent = await call(env, WEB, "/folders", "POST", { name: "專案甲", category: "project" });
  assert.equal(parent.status, 200, "本人在網頁仍可直接建立");

  const s1 = await call(env, AI, "/folder-suggestions", "POST", { name: "會議紀錄", parent_id: parent.body.id, reason: "放每週會議", requested_by: "Claude" });
  assert.equal(s1.body.status, "pending");
  const again = await call(env, AI, "/folder-suggestions", "POST", { name: "會議紀錄", parent_id: parent.body.id, reason: "重送" });
  assert.equal(again.body.duplicate, true, "相同建議不重複新增");

  const conflict = await call(env, AI, "/folder-suggestions", "POST", { name: "專案甲", category: "project", reason: "x" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.existing_folder_id, parent.body.id, "已有同名資料夾時回傳既有 id");

  const selfApprove = await call(env, AI, `/folder-suggestions/${s1.body.id}/approve`, "POST", {});
  assert.equal(selfApprove.status, 403, "AI 不能自行同意");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM folders WHERE name = '會議紀錄'").get().n, 0);

  const list = await call(env, WEB, "/folder-suggestions");
  assert.equal(list.body.suggestions.length, 1);
  assert.equal(list.body.suggestions[0].parent_name, "專案甲");

  const ok = await call(env, WEB, `/folder-suggestions/${s1.body.id}/approve`, "POST", { name: "週會紀錄" });
  assert.equal(ok.body.status, "approved");
  const folder = db.sqlite.prepare("SELECT * FROM folders WHERE id = ?").get(ok.body.folder_id);
  assert.equal(folder.name, "週會紀錄", "同意前可改名");
  assert.equal(folder.parent_id, parent.body.id);
  const hist = db.sqlite.prepare("SELECT detail FROM history WHERE folder_id = ? AND action = '建立資料夾'").get(ok.body.folder_id);
  assert.match(hist.detail, /AI 建議（Claude），使用者已確認/);
  assert.equal((await call(env, WEB, "/folder-suggestions")).body.suggestions.length, 0);

  const s2 = await call(env, AI, "/folder-suggestions", "POST", { name: "雜項", category: "misc", reason: "y" });
  const rej = await call(env, WEB, `/folder-suggestions/${s2.body.id}/reject`, "POST", {});
  assert.equal(rej.body.status, "rejected");
});

test("關閉後 AI 不能建議；只有本人能改設定", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  assert.equal((await call(env, AI, "/folder-suggestions/mode", "PUT", { mode: "off" })).status, 403);
  assert.equal((await call(env, WEB, "/folder-suggestions/mode", "PUT", { mode: "off" })).body.mode, "off");
  const blocked = await call(env, AI, "/folder-suggestions", "POST", { name: "新資料夾", category: "misc", reason: "z" });
  assert.equal(blocked.status, 403);
  assert.equal((await call(env, WEB, "/folder-suggestions")).body.mode, "off");
});

test("MCP 有 suggest_folder 工具，說明三種模式（直接建立／先建議／禁止）", async () => {
  const mcp = await read("../mcp/src/worker.js");
  assert.match(mcp, /name: "suggest_folder"/);
  assert.match(mcp, /fieldlog\.internal\/api\/folder-suggestions/);
  assert.match(mcp, /新增資料夾用 suggest_folder：使用者在隨身記首頁選「AI 可直接建立」/);
  assert.doesNotMatch(mcp, /fieldlog\.internal\/api\/folders"\)[\s\S]{0,200}method: "POST"/, "MCP 不直接 POST /folders");
});

test("v238 auto 模式：AI 經 suggest_folder 直接建立，本人送的仍走確認；有層數／同名／每日上限保護", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const env = { DB: db };
  // AI 不能自己切到 auto
  assert.equal((await call(env, AI, "/folder-suggestions/mode", "PUT", { mode: "auto" })).status, 403);
  assert.equal((await call(env, WEB, "/folder-suggestions/mode", "PUT", { mode: "auto" })).body.mode, "auto");
  assert.equal((await call(env, WEB, "/folder-suggestions")).body.mode, "auto");
  // 預設與無效值仍是 suggest
  assert.equal((await call(env, WEB, "/folder-suggestions/mode", "PUT", { mode: "bogus" })).body.mode, "suggest");
  await call(env, WEB, "/folder-suggestions/mode", "PUT", { mode: "auto" });

  const parent = await call(env, WEB, "/folders", "POST", { name: "專案乙", category: "project" });
  const made = await call(env, AI, "/folder-suggestions", "POST", { name: "試驗報告", parent_id: parent.body.id, reason: "放試驗報告", requested_by: "Claude" });
  assert.equal(made.status, 200);
  assert.equal(made.body.status, "created");
  const folder = db.sqlite.prepare("SELECT * FROM folders WHERE id = ?").get(made.body.folder_id);
  assert.equal(folder.name, "試驗報告");
  assert.equal(folder.parent_id, parent.body.id);
  const hist = db.sqlite.prepare("SELECT detail FROM history WHERE folder_id = ? AND action = '建立資料夾'").get(made.body.folder_id);
  assert.match(hist.detail, /AI 自動建立（Claude），理由：放試驗報告/);

  // 首頁可看到自動建立的紀錄，不會出現在待確認
  const list = (await call(env, WEB, "/folder-suggestions")).body;
  assert.equal(list.suggestions.length, 0);
  assert.equal(list.auto_created.length, 1);
  assert.equal(list.auto_created[0].folder_id, made.body.folder_id);

  // 同名仍擋下並回既有 id
  const dup = await call(env, AI, "/folder-suggestions", "POST", { name: "試驗報告", parent_id: parent.body.id, reason: "重複" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.existing_folder_id, made.body.folder_id);

  // 本人在網頁送的建議仍是待確認（不因 auto 而直接建）
  const web = await call(env, WEB, "/folder-suggestions", "POST", { name: "本人建議", category: "misc", reason: "x" });
  assert.equal(web.body.status, "pending");

  // 復原＝移到垃圾桶後不再列在 auto_created
  assert.equal((await call(env, WEB, `/folders/${made.body.folder_id}`, "DELETE")).body.trashed, true);
  assert.equal((await call(env, WEB, "/folder-suggestions")).body.auto_created.length, 0);

  // 每日上限：用滿後退回「先建議」
  for (let i = 0; i < 9; i++) {
    const r = await call(env, AI, "/folder-suggestions", "POST", { name: `自動${i}`, category: "misc", reason: "批次" });
    assert.equal(r.body.status, "created", `第 ${i + 2} 個仍可自動建立`);
  }
  const over = await call(env, AI, "/folder-suggestions", "POST", { name: "超額", category: "misc", reason: "批次" });
  assert.equal(over.body.status, "pending", "超過每日上限改為等待確認");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM folders WHERE name = '超額'").get().n, 0);
});

test("v238 auto 模式仍擋四層深度；AI 直接 POST /folders 仍被擋", async () => {
  resetSchemaCacheForTests();
  const env = { DB: d1() };
  await call(env, WEB, "/folder-suggestions/mode", "PUT", { mode: "auto" });
  assert.equal((await call(env, AI, "/folders", "POST", { name: "直接建", category: "misc" })).status, 403);
  let parentId = (await call(env, WEB, "/folders", "POST", { name: "L1", category: "project" })).body.id;
  for (const name of ["L2", "L3", "L4"]) {
    const r = await call(env, AI, "/folder-suggestions", "POST", { name, parent_id: parentId, reason: "層級" });
    assert.equal(r.body.status, "created");
    parentId = r.body.folder_id;
  }
  const tooDeep = await call(env, AI, "/folder-suggestions", "POST", { name: "L5", parent_id: parentId, reason: "太深" });
  assert.equal(tooDeep.status >= 400, true, "第五層被擋下");
});
