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
  const preview = app.match(/async function renderRecordingPreview\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(preview, /<audio controls preload="metadata"/);
  assert.match(preview, /錄音時間/);
  assert.match(preview, /檔案大小/);
  assert.match(preview, /錄音段數/);
  assert.match(preview, /recordingStatus\(audio\)/);
  assert.match(preview, /<h3>逐字稿<\/h3>/);
});

test("錄音編輯與管理固定在桌機右欄，逐字稿可修改及重新擷取，且不拆資料包", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function renderRecordingEditor\(entryId, entry, audio\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(editor, /folder-preview-body/);
  assert.match(editor, /recording-preview-editor/);
  assert.match(editor, /setFolderPreviewTitle/);
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

test("錄音實際進入的 Word 畫面固定顯示擷取文字，避免統一編輯器再次移除入口", async () => {
  const [app, index] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
  ]);
  const editor = app.match(/async function renderEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function showRecordingPreview/)?.[0] || "";
  const action = app.match(/function showRecordingTranscribeButton\(entryId, audio\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(index, /id="folder-preview-transcribe"[^>]*hidden/);
  assert.match(editor, /showRecordingTranscribeButton\(entryId, recordingAudio\)/,
    "共用 Word 編輯器載入錄音附件後，必須直接掛上擷取文字按鈕");
  assert.match(action, /📝 擷取文字/);
  assert.match(action, /📝 重新擷取文字/);
  assert.match(action, /attachments\/\$\{audio\[index\]\.id\}\/transcribe/);
  assert.match(action, /await showEntryEditor\(entryId\)/,
    "擷取完成後要回到使用者目前的 Word 畫面");
  assert.match(app, /function clearFolderPreviewEditorToolbar\([\s\S]*?folder-preview-transcribe[\s\S]*?transcribe\.hidden = true/,
    "切換到非錄音項目時必須清掉按鈕，避免殘留到一般文件");
});

test("一般檔案也在右欄編輯名稱、Note、分類與索引文字", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function renderFileEditor\(entryId, attachmentId\)[\s\S]*?\n}\n/)?.[0] || "";
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

test("純記事與一般資料包直接使用同一個右欄 Word 畫面", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /async function showEntryEditor\(entryId\)/);
  assert.match(app, /entry-preview-editor/);
  const preview = app.match(/async function showEntryPreview\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(preview, /return showEntryEditor\(entryId\)/);
  assert.doesNotMatch(app, /entry-side-attachments/);
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

test("錄音 ⋯ 只疊加操作選單，不可再把右欄換成第二套編輯介面", async () => {
  const app = await read("../fieldlog/public/app.js");
  const cards = app.match(/function bindRecordGroupCards\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(cards, /openRecordingActions\(entryId\)/);
  assert.doesNotMatch(cards, /openRecordingManager\(entryId\)/,
    "錄音卡 ⋯ 不可依桌機尺寸切到第二套右欄管理畫面");
  const actions = app.match(/async function openRecordingActions\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.doesNotMatch(actions, /usesDesktopRightPane\(\).*openRecordingManager/,
    "桌機與手機都應使用同一個非編輯型操作選單");
  assert.doesNotMatch(actions, /folder-preview-body|renderRecordingManager/,
    "操作選單不可替換右欄文件內容");
  for (const label of ["返回文件編輯", "依時間軸整理圖文", "原始錄音", "移動", "刪除"]) {
    assert.match(actions, new RegExp(label));
  }
  assert.match(actions, /closeEntry\(\);\s*openRecordingEditor\(entryId\)/,
    "從選單返回編輯時必須回到既有統一編輯器");
  assert.match(actions, /recording-action-audio-delete/,
    "移除第二套管理畫面後，刪除單一錄音段的功能仍要留在操作選單");
  assert.match(actions, /openMoveEntryDialog\(entryId/,
    "移動必須移動 entry，讓音訊、逐字稿與照片一起走，不可只搬單一 attachment");
  assert.match(actions, /api\(`\/entries\/\$\{entryId\}`,[\s\S]*method: "DELETE"/,
    "刪除必須刪整個錄音資料包並進垃圾桶");
});

test("錄音狀態與轉錄按鈕一致，資料夾卡片可直接看出是否已轉錄", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  const status = app.match(/function recordingStatus\(audioAttachments\)[\s\S]*?\n}\n/)?.[0] || "";
  const action = app.match(/function recordingTranscribeAction\(status, audioAttachments\)[\s\S]*?\n}\n/)?.[0] || "";
  const cards = app.match(/function recordGroupCardHtml\(e, atts\)[\s\S]*?\n}\n/)?.[0] || "";
  const actions = app.match(/async function openRecordingActions\(entryId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(status, /label: "尚未轉錄"/);
  assert.match(status, /label: "已轉錄"/);
  assert.match(status, /transcriptChars/);
  for (const label of ["開始轉錄", "繼續轉錄", "重試轉錄", "重新轉錄", "轉錄中…"]) {
    assert.match(action, new RegExp(label));
  }
  assert.match(cards, /recording-card-status/);
  assert.match(actions, /recording-status-summary/);
  assert.match(actions, /transcribeAction\.label/);
  assert.match(actions, /transcribeAction\.targets/);
  assert.match(css, /\.recording-card-status/);
});

test("桌機點檔案名稱與點 ⋯ 都進同一個檔案編輯器，儲存後也不退回唯讀預覽", async () => {
  const app = await read("../fieldlog/public/app.js");
  const rows = app.match(/function bindFileRows\(\)[\s\S]*?\n}\n/)?.[0] || "";
  const editor = app.match(/async function renderFileEditor\(entryId, attachmentId\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(rows, /showFileEditor\(entryId, attachmentId\)/);
  assert.match(rows, /openFileDetail\(entryId, attachmentId\)/,
    "手機仍可使用相容介面");
  assert.ok((rows.match(/showFileEditor\(/g) || []).length >= 2,
    "桌機點整列與點 ⋯ 都必須呼叫同一個 showFileEditor");
  assert.doesNotMatch(rows, /showFilePreview\(/,
    "點檔案名稱不可再先進另一套唯讀預覽");
  assert.match(editor, /const restoreSavedFile = \(\) => showFileEditor\(entryId, attachmentId\)/);
  assert.match(editor, /folder-preview-edit"\)\.textContent = "還原"/);
  assert.doesNotMatch(editor, /showFilePreview\(/,
    "還原或儲存後都不可切回第二套檔案預覽介面");
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
  assert.match(worker, /pdf: "application\/pdf"/);
});
