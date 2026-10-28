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

test("MCP 有 suggest_folder 工具，說明 AI 不能直接建立", async () => {
  const mcp = await read("../mcp/src/worker.js");
  assert.match(mcp, /name: "suggest_folder"/);
  assert.match(mcp, /fieldlog\.internal\/api\/folder-suggestions/);
  assert.match(mcp, /AI 不能直接建立資料夾：需要新資料夾時用 suggest_folder/);
  assert.doesNotMatch(mcp, /fieldlog\.internal\/api\/folders"\)[\s\S]{0,200}method: "POST"/, "MCP 不直接 POST /folders");
});
