/**
 * v231 連結放資料夾＋常用打星號：連結是一筆記事（fields_json.link_url），
 * 首頁「常用網頁」只列打星號的；舊的 widgets.links 一次搬進待分類並打星號。
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

test("連結：搬移舊清單、加到資料夾、打星號、常用清單與資料夾列表", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const env = { DB: db, FIELD_PIN: "1234" };
  const call = async (path, method = "GET", body) => {
    const res = await fieldlogWorker.fetch(new Request(`https://fieldlog.example.dev/api${path}`, { method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, body: await res.json() };
  };
  await call("/widgets/links", "PUT", { links: [{ name: "Leapspace", url: "https://www.sciencedirect.com/leapspace" }] });
  const first = await call("/links/starred");
  assert.deepEqual(first.body.links.map((l) => l.title), ["Leapspace"], "舊的常用網頁搬成打星號的連結");
  assert.equal((await call("/links/starred")).body.links.length, 1, "只搬一次");

  const folder = await call("/folders", "POST", { name: "ISO", category: "qa_reg" });
  assert.equal((await call("/links", "POST", { url: "javascript:alert(1)", folder_id: folder.body.id })).status, 400);
  const iso = await call("/links", "POST", { url: "https://www.iso.org/", note: "查版次", folder_id: folder.body.id });
  assert.equal(iso.body.title, "iso.org", "沒給名稱就用網站名稱");
  assert.equal(iso.body.starred, false);
  const list = await call(`/entries?folder_id=${folder.body.id}&include=attachments`);
  assert.equal(list.body[0].link_url, "https://www.iso.org/");
  const body = db.sqlite.prepare("SELECT body FROM entries WHERE id = ?").get(iso.body.id).body;
  assert.match(body, /查版次/);
  assert.match(body, /https:\/\/www\.iso\.org\//, "網址寫進內文，搜尋找得到");

  await call(`/links/${iso.body.id}/star`, "PUT", { starred: true });
  const starred = (await call("/links/starred")).body.links;
  assert.deepEqual(starred.map((l) => l.title), ["Leapspace", "iso.org"], "依加星號的先後排序");
  assert.equal(starred[1].folder_name, "ISO");
  await call(`/links/${iso.body.id}/star`, "PUT", { starred: false });
  assert.equal((await call("/links/starred")).body.links.length, 1);
});

test("前端：側欄常用連結已移除；網址對話框有加入連結模式；資料夾連結列有星號", async () => {
  const [html, app] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js")]);
  assert.doesNotMatch(html, /id="desktop-links"/);
  assert.doesNotMatch(app, /renderSidebarLinks/);
  assert.match(html, /name="url-import-mode" value="link"/);
  assert.match(app, /api\("\/links", \{/);
  assert.match(app, /data-star="\$\{e\.id\}"/);
  assert.match(app, /api\("\/links\/starred"\)/);
});
