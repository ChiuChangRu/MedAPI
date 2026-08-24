import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("錄音卡片以右側專用預覽為主，舊展場資料框只在舊資料時後備", async () => {
  const app = await read("../fieldlog/public/app.js");
  const bind = app.match(/function bindRecordGroupCards[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(bind, /card\.dataset\.recording === "1"/);
  assert.match(bind, /showRecordingPreview\(entryId\)/);
  assert.match(app, /async function showRecordingPreview\(entryId\)/);
  assert.match(app, /function hasLegacyRecordingFields\(entry\)/);
  assert.match(app, /舊資料相容工具/);
  assert.match(app, /if \(legacy\).*openEntry\(entryId\)/s);
});

test("錄音預覽包含播放器、大小、錄音時間、長度、轉錄狀態與逐字稿", async () => {
  const app = await read("../fieldlog/public/app.js");
  const preview = app.match(/async function showRecordingPreview\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(preview, /<audio controls preload="metadata"/);
  assert.match(preview, /錄音時間/);
  assert.match(preview, /檔案大小/);
  assert.match(preview, /錄音段數/);
  assert.match(preview, /recordingStatus\(audio\)/);
  assert.match(preview, /<h3>逐字稿<\/h3>/);
});

test("錄音編輯只送名稱、速記與逐字稿，不拆資料包", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function openRecordingEditor\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(editor, /recording-edit-title/);
  assert.match(editor, /recording-edit-note/);
  assert.match(editor, /recording-transcript-input/);
  assert.match(editor, /body_format: "text"/);
  assert.match(editor, /JSON\.stringify\(\{ transcript:/);
  assert.doesNotMatch(editor, /fields:/, "錄音專用編輯不可再送展場模板欄位");
});

test("錄音 ⋯ 提供重新轉錄、下載、重新命名、整包移動與整包刪除", async () => {
  const app = await read("../fieldlog/public/app.js");
  const actions = app.match(/async function openRecordingActions\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  for (const label of ["重新轉錄", "下載錄音", "重新命名", "移動", "刪除"]) {
    assert.match(actions, new RegExp(label));
  }
  assert.match(actions, /openMoveEntryDialog\(entryId/,
    "移動必須移動 entry，讓音訊、逐字稿與照片一起走，不可只搬單一 attachment");
  assert.match(actions, /api\(`\/entries\/\$\{entryId\}`,[\s\S]*method: "DELETE"/,
    "刪除必須刪整個錄音資料包並進垃圾桶");
});

test("人工逐字稿可保存並標記 manual_edit，明確重新轉錄仍可覆寫", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const update = worker.match(/const attMatch = path\.match[\s\S]*?if \(attMatch && method === "DELETE"\)/)?.[0] || "";
  assert.match(update, /if \(body\.transcript !== undefined\)/);
  assert.match(update, /UPDATE attachments SET transcript = \?, transcribed_at = 'manual_edit'/);
  assert.match(update, /triggerEmbedding\(env, \{ kind: "attachment"/);
  assert.ok(worker.includes('path.match(/^\\/attachments\\/(\\d+)\\/transcribe$/)'),
    "⋯ 的重新轉錄仍要保留既有人工重跑端點");
});

test("PDF 預覽使用 PDF.js，舊檔 MIME 會由資料庫與副檔名修正", async () => {
  const [app, worker] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/src/worker.js"),
  ]);
  assert.match(app, /async function renderPdfPreview/);
  assert.match(app, /pdfjsLib\.getDocument/);
  assert.match(app, /else if \(pdf\) await renderPdfPreview/);
  assert.match(worker, /SELECT a\.id, a\.mime, a\.filename FROM attachments/);
  assert.match(worker, /contentType = "application\/pdf"/);
});
