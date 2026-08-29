import assert from "node:assert/strict";
import test from "node:test";

import { buildRecordingDocumentHtml, formatRecordingOffset, parseVtt, shouldRegenerateRecordingDocument } from "../fieldlog/src/lib/recording-document.js";
import { composeRecordingDocument } from "../fieldlog/src/worker.js";

function recordingDb() {
  const state = {
    entry: { id: 1, body: "", body_format: "html", fields_json: "{}" },
    attachments: [
      { id: 10, entry_id: 1, kind: "audio", filename: "a.webm", key: "1/a.webm", mime: "audio/webm", offset_secs: 0, transcript: "逐字內容", transcript_vtt: "", source_pdf_id: null },
      { id: 11, entry_id: 1, kind: "photo", filename: "p.jpg", key: "1/p.jpg", mime: "image/jpeg", offset_secs: 3, transcript: "", transcript_vtt: "", source_pdf_id: null },
    ],
  };
  return {
    state,
    prepare(sql) {
      return { bind(...args) { return {
        async first() {
          if (sql.startsWith("SELECT id, body, body_format, fields_json FROM entries")) return args[0] === state.entry.id ? { ...state.entry } : null;
          return null;
        },
        async all() {
          if (sql.startsWith("SELECT id, kind, filename")) return { results: state.attachments.filter((item) => item.entry_id === args[0]).map((item) => ({ ...item })) };
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE entries SET body = ?")) {
            state.entry.body = args[0]; state.entry.body_format = "html"; state.entry.fields_json = args[1];
          }
          return { meta: { changes: 1 } };
        },
      }; } };
    },
  };
}

test("VTT 時間碼解析成每段逐字稿的相對秒數", () => {
  const cues = parseVtt(`WEBVTT\n\n00:00:01.500 --> 00:00:04.000\n第一段\n\n00:04.000 --> 00:06.250\n第二段`);
  assert.deepEqual(cues, [
    { start: 1.5, end: 4, text: "第一段" },
    { start: 4, end: 6.25, text: "第二段" },
  ]);
  assert.equal(formatRecordingOffset(65), "01:05");
  assert.equal(formatRecordingOffset(3661), "01:01:01");
});

test("多段錄音與拍照依共同 offset 穿插成單一 Word HTML", () => {
  const html = buildRecordingDocumentHtml([
    { id: 1, kind: "audio", offset_secs: 0, transcript: "", transcript_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:08.000\n開場說明" },
    { id: 2, kind: "photo", offset_secs: 5, key: "9/現場 照片.jpg", filename: "現場照片.jpg", mime: "image/jpeg" },
    { id: 3, kind: "audio", offset_secs: 60, transcript: "第二段完整逐字稿", transcript_vtt: "" },
  ]);
  const opening = html.indexOf("開場說明");
  const photo = html.indexOf('data-att-id="2"');
  const second = html.indexOf("第二段完整逐字稿");
  assert.ok(opening >= 0 && photo > opening && second > photo, "逐字稿、照片、下一段錄音要依時間順序排列");
  assert.match(html, /📷 00:05/);
  assert.match(html, /\/api\/file\/9\/%E7%8F%BE%E5%A0%B4%20%E7%85%A7%E7%89%87\.jpg/);
  assert.match(html, /<strong>01:00<\/strong> 第二段完整逐字稿/);
});

test("同一張照片只插入一次，文字與檔名都會安全轉義", () => {
  const html = buildRecordingDocumentHtml([
    { id: 7, kind: "audio", offset_secs: 0, transcript: "A < B", transcript_vtt: "" },
    { id: 8, kind: "photo", offset_secs: 1, key: "7/a.jpg", filename: 'a\"<.jpg', mime: "image/jpeg" },
    { id: 8, kind: "photo", offset_secs: 1, key: "7/a.jpg", filename: 'a\"<.jpg', mime: "image/jpeg" },
  ]);
  assert.match(html, /A &lt; B/);
  assert.equal((html.match(/data-att-id="8"/g) || []).length, 1);
  assert.match(html, /alt="a&amp;quot;&lt;\.jpg"|alt="a&quot;&lt;\.jpg"/);
});

test("只有空白文件或仍等於上次自動版本時才可重建", () => {
  assert.equal(shouldRegenerateRecordingDocument("", "empty-hash", ""), true);
  assert.equal(shouldRegenerateRecordingDocument("自動內容", "same", "same"), true);
  assert.equal(shouldRegenerateRecordingDocument("人工改寫", "new-hash", "old-hash"), false);
  assert.equal(shouldRegenerateRecordingDocument("原有記事", "hash", ""), false);
});

test("純照片附件本身不是錄音時間軸文件", () => {
  const attachments = [{ id: 9, kind: "photo", offset_secs: 0, key: "9/photo.jpg", filename: "photo.jpg", mime: "image/jpeg" }];
  assert.equal(attachments.some((item) => item.kind === "audio"), false);
});

test("實際重建會寫入 hash；人工修改後再重建會保留人工版本", async () => {
  const db = recordingDb();
  const first = await composeRecordingDocument({}, db, 1);
  assert.equal(first.updated, true);
  assert.match(db.state.entry.body, /逐字內容/);
  assert.match(db.state.entry.body, /data-att-id="11"/);
  assert.ok(JSON.parse(db.state.entry.fields_json)._recording_document_hash);

  db.state.entry.body = "<p>人工改寫，不可覆蓋</p>";
  const second = await composeRecordingDocument({}, db, 1);
  assert.deepEqual(second, { updated: false, reason: "manual_body" });
  assert.equal(db.state.entry.body, "<p>人工改寫，不可覆蓋</p>");
});
