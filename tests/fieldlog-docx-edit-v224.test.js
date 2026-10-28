/**
 * v224 Word 簡易文字編輯：只替換改過的段落，其他段落 XML 原封不動；
 * 含超連結／圖片的段落不可編輯；存檔保留舊版、可還原。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const JSZip = require("jszip");
const { window } = new JSDOM("");
globalThis.window ??= window;
const { analyzeDocumentXml, applyParagraphEdits, serializeDocumentXml, W_NS } = await import("../fieldlog/public/docx-edit.js");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const sample = async () => Buffer.from(await read("./fixtures/docx-edit-sample.docx.b64"), "base64");

async function openDoc() {
  const zip = await JSZip.loadAsync(await sample());
  const xml = await zip.file("word/document.xml").async("string");
  return { zip, xml, doc: new window.DOMParser().parseFromString(xml, "application/xml"), ser: new window.XMLSerializer() };
}

test("段落分析：一般文字可編輯、超連結與圖片鎖住、混合格式與表格有標示", async () => {
  const { doc, ser } = await openDoc();
  const { tracked, items } = analyzeDocumentXml(doc, ser);
  assert.equal(tracked, false);
  const find = (t) => items.find((i) => i.text.startsWith(t));
  assert.equal(find("注射筒容量").mixed, true);
  assert.equal(find("1.2 mm").inTable, true);
  assert.equal(find("第一行").text, "第一行\n第二行\t含Tab", "段內換行與 Tab 轉成 \\n、\\t");
  assert.equal(find("參考").editable, false);
  assert.equal(find("參考").text, "參考：ISO 網站", "鎖住的段落也顯示超連結文字");
  assert.equal(find("圖片前文字").editable, false);
});

test("寫回：只動改過的段落，格式沿用、換行與 Tab 正確，其他段落 XML 不變", async () => {
  const { zip, xml, doc, ser } = await openDoc();
  const before = Array.from(doc.getElementsByTagNameNS(W_NS, "p")).map((p) => ser.serializeToString(p));
  const { items } = analyzeDocumentXml(doc, ser);
  const idx = (t) => items.find((i) => i.text.startsWith(t)).index;
  const changed = applyParagraphEdits(doc, new Map([[idx("第一行"), "改一\n改二\t尾"], [idx("1.2 mm"), "1.3 mm"], [idx("參考"), "不應被改"]]));
  assert.equal(changed, 2, "鎖住的段落不會被寫入");
  const after = Array.from(doc.getElementsByTagNameNS(W_NS, "p")).map((p) => ser.serializeToString(p));
  const diff = after.map((x, i) => (x === before[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(diff, [idx("第一行"), idx("1.2 mm")]);
  const edited = doc.getElementsByTagNameNS(W_NS, "p")[idx("第一行")];
  const runs = edited.getElementsByTagNameNS(W_NS, "r");
  assert.equal(runs.length, 1);
  assert.ok(runs[0].getElementsByTagNameNS(W_NS, "sz").length, "沿用原本的字級設定");
  assert.equal(runs[0].getElementsByTagNameNS(W_NS, "br").length, 1);
  assert.equal(runs[0].getElementsByTagNameNS(W_NS, "tab").length, 1);
  const out = serializeDocumentXml(doc, ser, xml);
  assert.match(out, /^<\?xml[^>]*\?>\r\n<w:document/, "保留 XML 宣告");
  zip.file("word/document.xml", out, { createFolders: false });
  const roundtrip = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
  const original = await JSZip.loadAsync(await sample());
  assert.deepEqual(Object.keys(roundtrip.files), Object.keys(original.files), "壓縮檔內容清單與原檔一致");
});

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

test("Word 存檔保留舊版（30 分鐘內合併）並可還原", async () => {
  resetSchemaCacheForTests();
  const db = d1();
  const store = new Map([["1/orig.docx", "v0"]]);
  const FILES = { async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, async get(k) { return store.has(k) ? { arrayBuffer: async () => new TextEncoder().encode(String(store.get(k))).buffer } : null; } };
  const env = { DB: db, FILES, FIELD_PIN: "1234" };
  const call = async (path, method = "GET", body, type = "application/json") => {
    const res = await fieldlogWorker.fetch(new Request(`https://fieldlog.example.dev/api${path}`, { method, headers: { "x-pin": "1234", "content-type": type }, body }), env);
    return { status: res.status, body: await res.json() };
  };
  await call("/entries", "GET");
  db.sqlite.prepare("INSERT INTO entries (id, title, created_at, updated_at) VALUES (1, 'w', '2026-10-28 00:00:00Z', '2026-10-28 00:00:00Z')").run();
  db.sqlite.prepare("INSERT INTO attachments (id, entry_id, kind, filename, key, size, mime, content_hash, created_at) VALUES (5, 1, 'file', 'a.docx', '1/orig.docx', 2, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'h0', '2026-10-28 00:00:00Z')").run();
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const r1 = await call("/attachments/5/content", "PUT", "v1", docx);
  assert.equal(r1.status, 200);
  assert.equal((await call("/attachments/5/versions")).body.versions.length, 1, "第一次存檔留下原檔");
  assert.ok(store.has("1/orig.docx"), "原檔沒有被刪");
  await call("/attachments/5/content", "PUT", "v2", docx);
  assert.equal((await call("/attachments/5/versions")).body.versions.length, 1, "30 分鐘內連續存檔不多留版本");
  assert.ok(!store.has(r1.body.key), "中間稿被清掉");
  const vid = (await call("/attachments/5/versions")).body.versions[0].id;
  const restored = await call(`/attachments/5/versions/${vid}/restore`, "POST", "{}");
  assert.equal(restored.body.key, "1/orig.docx");
  assert.equal(db.sqlite.prepare("SELECT key FROM attachments WHERE id = 5").get().key, "1/orig.docx");
  assert.equal((await call("/attachments/5/versions")).body.versions.length, 1, "還原後原本的目前版本變成舊版");
});
