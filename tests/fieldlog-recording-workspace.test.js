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

test("錄音編輯與管理固定在桌機右欄，逐字稿可修改及重新擷取，且不拆資料包", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function openRecordingEditor\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(editor, /folder-preview-body/);
  assert.match(editor, /recording-preview-editor/);
  assert.match(editor, /folder-preview-title/);
  assert.doesNotMatch(editor, /entry-modal/);
  assert.doesNotMatch(editor, /entry-overlay.*classList\.add\("open"\)/s);
  assert.match(editor, /recording-edit-title/);
  assert.match(editor, /recording-edit-note/);
  assert.match(editor, /recording-transcript-input/);
  assert.match(editor, /recording-edit-transcribe/);
  assert.match(editor, /attachments\/\$\{audio\[index\]\.id\}\/transcribe/);
  assert.match(editor, /recording-edit-move/);
  assert.match(editor, /recording-edit-delete/);
  assert.match(editor, /recording-editor-downloads/);
  assert.match(editor, /body_format: "text"/);
  assert.match(editor, /JSON\.stringify\(\{ transcript:/);
  assert.doesNotMatch(editor, /fields:/, "錄音專用編輯不可再送展場模板欄位");
});

test("一般檔案也在右欄編輯名稱、Note、分類與索引文字", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function showFileEditor\(entryId, attachmentId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(editor, /folder-preview-body/);
  assert.match(editor, /file-preview-editor/);
  assert.match(editor, /preview-file-name/);
  assert.match(editor, /preview-file-note/);
  assert.match(editor, /preview-file-category/);
  assert.match(editor, /preview-file-index/);
  assert.match(editor, /preview-file-ocr/);
  assert.match(editor, /attachments\/\$\{attachmentId\}\/ocr/);
  assert.match(editor, /preview-file-deep/);
  assert.match(editor, /deepProcessPdf\(entryId, attachment/);
  assert.match(editor, /preview-file-copy/);
  assert.match(editor, /preview-file-move/);
  assert.match(editor, /preview-file-share/);
  assert.match(editor, /preview-file-delete/);
  assert.match(editor, /folder-preview-manage"\)\.disabled = true/);
  assert.doesNotMatch(editor, /openFileDetail\(entryId, attachmentId\)[\s\S]*開啟檔案管理失敗/,
    "桌機右欄編輯中不可再開舊檔案資料框");
  assert.match(editor, /attachments\/\$\{attachmentId\}\/note/);
  assert.match(editor, /attachments\/\$\{attachmentId\}\/category/);
});

test("純記事與一般資料包也使用右欄預覽／編輯", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /async function showEntryEditor\(entryId\)/);
  assert.match(app, /entry-preview-editor/);
  assert.match(app, /entry-side-attachments/);
  const rows = app.match(/function bindEntryRows\(wrap\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(rows, /showEntryPreview\(entryId\)/);
  const packages = app.match(/function bindRecordGroupCards\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(packages, /showEntryPreview\(entryId\)/);
});

test("Excel 與 CSV 以右欄表格顯示，常用格式有明確降級說明", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  assert.match(app, /function renderDelimitedTable/);
  assert.match(app, /renderDelimitedTable\(extracted, \{ spreadsheet: true \}\)/);
  assert.match(app, /\/attachments\/\$\{attachmentId\}\/ocr/);
  assert.match(app, /舊版 Office 格式無法可靠預覽/);
  assert.match(app, /OpenDocument／RTF/);
  assert.match(css, /\.spreadsheet-scroll table/);
  assert.match(css, /\.preview-editor/);
});

test("桌機錄音 ⋯ 進右欄，手機相容介面仍提供完整操作", async () => {
  const app = await read("../fieldlog/public/app.js");
  const cards = app.match(/function bindRecordGroupCards\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(cards, /openRecordingEditor\(entryId\)/);
  assert.match(cards, /openRecordingActions\(entryId\)/);
  const actions = app.match(/async function openRecordingActions\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  for (const label of ["重新轉錄", "下載錄音", "重新命名", "移動", "刪除"]) {
    assert.match(actions, new RegExp(label));
  }
  assert.match(actions, /openMoveEntryDialog\(entryId/,
    "移動必須移動 entry，讓音訊、逐字稿與照片一起走，不可只搬單一 attachment");
  assert.match(actions, /api\(`\/entries\/\$\{entryId\}`,[\s\S]*method: "DELETE"/,
    "刪除必須刪整個錄音資料包並進垃圾桶");
});

test("桌機檔案列 ⋯ 與右欄 ⋯ 都不再打開舊展場檔案框", async () => {
  const app = await read("../fieldlog/public/app.js");
  const rows = app.match(/function bindFileRows\(\)[\s\S]*?\n}\n/)?.[0] || "";
  const preview = app.match(/async function showFilePreview\([\s\S]*?\n}\n/)?.[0] || "";
  assert.match(rows, /showFileEditor\(entryId, attachmentId\)/);
  assert.match(rows, /openFileDetail\(entryId, attachmentId\)/,
    "手機仍可使用相容介面");
  assert.match(preview, /folder-preview-manage/);
  assert.match(preview, /showFileEditor\(entryId, attachmentId\)/);
  assert.doesNotMatch(preview, /openFileDetail/);
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
