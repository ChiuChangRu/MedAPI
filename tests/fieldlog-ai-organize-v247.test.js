/**
 * v247 AI 整理：任何檔案／記事／資料夾 → 建議名稱（固定命名法則）＋建議搬動位置。
 * node:sqlite 當 D1、假的 env.AI 依 prompt 回 JSON，實跑 /api/ai-organize。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { ensureSchema, resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import {
  attachmentRuleKey, cleanName, composeOrganizedName, dateLabel, folderSubtree, withPaths,
} from "../fieldlog/src/lib/ai-organize.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

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

/** 假 AI：命名模型回 name／文件三欄；搬動模型回事先指定的 JSON。 */
function fakeAi({ name = "", doc = null, move = null, calls = [] } = {}) {
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") {
        const wantsDoc = input.response_format?.json_schema?.properties?.company;
        return { response: JSON.stringify(wantsDoc ? doc : { name }) };
      }
      return { response: JSON.stringify(typeof move === "function" ? move(input) : move) };
    },
  };
}

async function call(env, path, body, host = "mywiki.example.dev") {
  // 軟預算檢查會查 Cloudflare 用量：回報零用量，等於沒超過上限
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
  try {
    const res = await fieldlogWorker.fetch(new Request(`https://${host}/api${path}`, {
      method: "POST", headers: { "x-pin": "1234", "content-type": "application/json" }, body: JSON.stringify(body),
    }), { FIELD_PIN: "1234", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok", ...env });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = originalFetch; }
}

async function seed(db) {
  await ensureSchema(db, "2026-11-07 00:00:00Z");
  const q = (sql, ...a) => db.sqlite.prepare(sql).run(...a);
  const t = "2026-11-07 01:00:00Z";
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (1, '專利分析', '其他專案', 'project', NULL, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (2, '專利', '其他專案', 'project', 1, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (3, '活檢針', '其他專案', 'project', 2, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (4, '2026', '其他專案', 'project', 3, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (7, '導管', '其他專案', 'project', 2, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (5, '教育訓練', '上課', 'training', NULL, '', ?)", t);
  q("INSERT INTO folders (id, name, type, category, parent_id, role, created_at) VALUES (6, '⏳ 待分類', '其他', 'misc', NULL, 'staging', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (10, 6, '未命名紀錄', '{}', '<p>活檢針專利 US10463350 的說明</p>', 'html', ?)", t);
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, ocr_text, created_at) VALUES (20, 10, 'file', 'US10463350.pdf', 'k1', 100, 'application/pdf', 'Biopsy device patent by Becton Dickinson', '2026-11-07 02:00:00Z')", );
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, ocr_text, created_at) VALUES (21, 10, 'photo', 'IMG_0042.jpg', 'k2', 100, 'image/jpeg', '', '2026-11-05 03:00:00Z')");
  q("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, transcript, created_at) VALUES (22, 10, 'audio', 'rec_1.webm', 'k3', 100, 'audio/webm', '今天和廠商討論活檢針的規格', '2026-11-06 03:00:00Z')");
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (11, 6, '【AI彙整】某次講座', '{}', '', 'html', ?)", t);
  q("INSERT INTO entries (id, folder_id, title, fields_json, body, body_format, created_at) VALUES (12, 1, '週報', '{\"_kind\":\"weekly_report\"}', '', 'html', ?)", t);
}

const MOVE_MODEL = "@cf/google/gemma-4-26b-a4b-it";

test("純函式：命名法則歸類、日期、清理、子樹高度", () => {
  assert.equal(attachmentRuleKey({ kind: "file", filename: "a.pdf", mime: "application/pdf" }), "doc");
  assert.equal(attachmentRuleKey({ kind: "photo", filename: "a.jpg" }), "media");
  assert.equal(attachmentRuleKey({ kind: "file", filename: "clip.mp4", mime: "video/mp4" }), "media");
  assert.equal(attachmentRuleKey({ kind: "audio", filename: "a.webm" }), "audio");
  assert.equal(dateLabel("2026-11-07 01:00:00Z"), "20261107");
  assert.equal(cleanName('  活檢/針:斷面?*  '), "活檢 針 斷面");
  assert.equal(composeOrganizedName("media", "活檢針斷面", { filename: "IMG_1.JPG", createdAt: "2026-11-05T03:00:00Z" }), "20261105_活檢針斷面.jpg");
  assert.equal(composeOrganizedName("media", "20261105_活檢針斷面", { filename: "a.jpg", createdAt: "2026-11-05" }), "20261105_活檢針斷面.jpg", "AI 自己加了日期也不會重複");
  assert.equal(composeOrganizedName("entry", "天虹參訪重點"), "天虹參訪重點");
  assert.equal(composeOrganizedName("audio", "", { filename: "a.m4a" }), "");
  const folders = withPaths([{ id: 1, name: "A", parent_id: null }, { id: 2, name: "B", parent_id: 1 }, { id: 3, name: "C", parent_id: 2 }, { id: 4, name: "D", parent_id: null }]);
  assert.equal(folders[2].depth, 3);
  assert.equal(folders[2].path, "A ／ B ／ C");
  const sub = folderSubtree(folders, 1);
  assert.deepEqual([...sub.ids].sort(), [1, 2, 3]);
  assert.equal(sub.height, 3);
});

test("文件：沿用「公司_產品_文件類型」，並建議搬到既有資料夾（向量／AI 判斷，含理由與目前位置）", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({
    doc: { company: "BD", product: "Mission Core Biopsy Instrument", doc_type: "專利" },
    move: { folder_id: 3, new_folder: null, reason: "內容是活檢針專利" },
  });
  const r = await call({ DB: db, AI: ai }, "/ai-organize", { type: "attachment", id: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, "BD_Mission Core Biopsy Instrument_專利.pdf");
  assert.equal(r.body.rule, "公司_產品_文件類型");
  assert.equal(r.body.move.folder_id, 3);
  assert.equal(r.body.move.path, "專利分析 ／ 專利 ／ 活檢針");
  assert.equal(r.body.move.current_path, "⏳ 待分類");
  assert.equal(r.body.move.reason, "內容是活檢針專利");
  // 候選清單不含待分類容器，且標出目前位置之外的所有資料夾
  const moveCall = ai.calls.find((c) => c.model === MOVE_MODEL);
  assert.doesNotMatch(moveCall.input.messages[1].content, /待分類/);
  assert.match(moveCall.input.messages[1].content, /3\t專利分析 ／ 專利 ／ 活檢針\t第3層/);
});

test("照片、錄音：日期_主題（日期取檔案建立日，副檔名保留）", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const photo = await call({ DB: db, AI: fakeAi({ name: "活檢針斷面觀察", move: { folder_id: null, reason: "x" } }) }, "/ai-organize", { type: "attachment", id: 21, want_move: false });
  assert.equal(photo.body.name, "20261105_活檢針斷面觀察.jpg");
  assert.equal(photo.body.rule, "日期_主題");
  const audio = await call({ DB: db, AI: fakeAi({ name: "廠商規格討論" }) }, "/ai-organize", { type: "attachment", id: 22, want_move: false });
  assert.equal(audio.body.name, "20261106_廠商規格討論.webm");
  const none = await call({ DB: db, AI: fakeAi({ name: "" }) }, "/ai-organize", { type: "attachment", id: 21, want_move: false });
  assert.equal(none.body.name, "");
  assert.match(none.body.name_note, /資料不足/);
});

test("記事：簡短主題；【AI彙整】與週報不改名；目前位置已合適時不建議搬動", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ok = await call({ DB: db, AI: fakeAi({ name: "活檢針專利筆記", move: { folder_id: 3, reason: "專利" } }) }, "/ai-organize", { type: "entry", id: 10 });
  assert.equal(ok.body.name, "活檢針專利筆記");
  assert.equal(ok.body.move.folder_id, 3);
  const sys = await call({ DB: db, AI: fakeAi({ name: "不該用" , move: { folder_id: 6, reason: "x" } }) }, "/ai-organize", { type: "entry", id: 11 });
  assert.equal(sys.body.name, "");
  assert.match(sys.body.name_note, /系統慣例/);
  const weekly = await call({ DB: db, AI: fakeAi({ name: "不該用" }) }, "/ai-organize", { type: "entry", id: 12, want_move: false });
  assert.match(weekly.body.name_note, /週報/);
  const stay = await call({ DB: db, AI: fakeAi({ name: "週報", move: { folder_id: 1, reason: "已在專案裡" } }) }, "/ai-organize", { type: "entry", id: 12, want_name: false });
  assert.equal(stay.body.move, null);
  assert.match(stay.body.move_note, /已在專案裡/);
});

test("資料夾：依層級法則建議名稱；搬動不會選到自己的子樹或超過四層", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const ai = fakeAi({ name: "活檢針專利", move: { folder_id: 5, reason: "教育訓練底下" } });
  const r = await call({ DB: db, AI: ai }, "/ai-organize", { type: "folder", id: 3 });
  assert.equal(r.body.name, "活檢針專利");
  assert.equal(r.body.rule, "第 3 層");
  const nameCall = ai.calls.find((c) => c.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(nameCall.input.messages[0].content, /第 3 層＝主題、試驗或標準系列/);
  assert.match(nameCall.input.messages[1].content, /同層其他資料夾：/);
  const moveCall = ai.calls.find((c) => c.model === MOVE_MODEL);
  const listed = moveCall.input.messages[1].content;
  for (const forbidden of ["\n3\t", "\n4\t"]) assert.ok(!listed.includes(forbidden), "不能搬到自己或自己的子資料夾");
  // 資料夾 3（含子層，高度 2）：搬到第 3 層（深度 3）底下會變成第 5 層，不在候選裡；第 2 層可以
  assert.ok(!/\n7\t/.test(`\n${listed}`), "第 3 層的資料夾底下放不下高度 2 的子樹");
  assert.match(listed, /(^|\n)2\t專利分析 ／ 專利\t第2層/);
  assert.equal(r.body.move.folder_id, 5);
  // 若 AI 硬選自己的子資料夾 → 不接受
  const bad = await call({ DB: db, AI: fakeAi({ name: "x", move: { folder_id: 4, reason: "亂選" } }) }, "/ai-organize", { type: "folder", id: 3 });
  assert.equal(bad.body.move, null);
});

test("找不到合適資料夾時可提議新資料夾（需使用者確認才建立）；層級超過四層會被擋", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  const proposal = await call({ DB: db, AI: fakeAi({ name: "x", move: { folder_id: null, new_folder: { name: "BD", parent_id: 1 }, reason: "新廠商" } }) }, "/ai-organize", { type: "entry", id: 10, want_name: false });
  assert.deepEqual(proposal.body.move.new_folder, { name: "BD", parent_id: 1, parent_path: "專利分析", type: "其他專案" });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM folders WHERE name = 'BD'").get().n, 0, "只是建議，沒有建立");
  // 在第 4 層底下再建 → 第 5 層，不允許
  const deep = await call({ DB: db, AI: fakeAi({ name: "x", move: { folder_id: null, new_folder: { name: "太深", parent_id: 4 }, reason: "x" } }) }, "/ai-organize", { type: "entry", id: 10, want_name: false });
  assert.equal(deep.body.move, null);
  assert.match(deep.body.move_note, /層級超過上限|無法建立/);
  // 同層已有同名資料夾 → 改成建議搬進既有的
  const dup = await call({ DB: db, AI: fakeAi({ name: "x", move: { folder_id: null, new_folder: { name: "專利", parent_id: 1 }, reason: "x" } }) }, "/ai-organize", { type: "entry", id: 10, want_name: false });
  assert.equal(dup.body.move.folder_id, 2);
});

test("AI（MCP 主機）不能用；參數錯誤與找不到對象有清楚的錯誤；沒有 AI 綁定回 501", async () => {
  resetSchemaCacheForTests();
  const db = d1(); await seed(db);
  assert.equal((await call({ DB: db, AI: fakeAi() }, "/ai-organize", { type: "entry", id: 10 }, "fieldlog.internal")).status, 403);
  assert.equal((await call({ DB: db, AI: fakeAi() }, "/ai-organize", { type: "bogus", id: 1 })).status, 400);
  assert.equal((await call({ DB: db, AI: fakeAi() }, "/ai-organize", { type: "attachment", id: 9999 })).status, 404);
  assert.equal((await call({ DB: db, AI: fakeAi() }, "/ai-organize", { type: "folder", id: 9999 })).status, 404);
  assert.equal((await call({ DB: db }, "/ai-organize", { type: "entry", id: 10 })).status, 501);
});

test("前端：選取任何項目都能 AI 整理；套用才改名／搬動，新資料夾要勾選同意", async () => {
  const [app, html] = await Promise.all([read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html")]);
  assert.match(html, />AI 整理<\/button>/);
  assert.match(html, /id="ai-want-move"/);
  assert.match(html, /命名法則/);
  assert.match(app, /\["attachment", "entry", "folder"\]\.includes\(item\.type\)/);
  assert.match(app, /api\("\/ai-organize"/);
  const apply = app.match(/async function applyAiNaming[\s\S]*?\n\}\n/)[0];
  assert.match(apply, /\.ai-move-check"\)\.checked/);
  assert.match(apply, /api\("\/folders", \{ method: "POST"/);
  assert.match(apply, /\/attachments\/\$\{id\}\/move/);
});
