/**
 * v201：每一筆記事都有「✨ AI 整理筆記」。
 *
 * - 錄音記事：維持 v200 行為，一律展開。
 * - 非錄音記事：沒內容時收合（只剩一行標題），有內容時展開——主要由 MCP
 *   update_ai_note 寫入，寫完打開記事若是收合的，使用者會以為沒寫進去。
 * - 後端：Agent 寫入的逐字稿版本檢查只套用在錄音記事。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function extractFns(src, names) {
  return names.map((n) => {
    const m = src.match(new RegExp(`function ${n}\\([^)]*\\)[\\s\\S]*?\\n\\}\\n`))?.[0];
    assert.ok(m, `找不到函式 ${n}`);
    return m;
  }).join("\n");
}

async function aiNoteRenderers() {
  const app = await read("../fieldlog/public/app.js");
  const src = extractFns(app, ["aiNoteStatusLabel", "aiNoteEditorHtml", "aiNotePreviewHtml"]);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Function("esc", "localDateTime", "window", `${src}\nreturn { aiNoteEditorHtml, aiNotePreviewHtml };`)(
    esc, (s) => s, { fieldlogRichEditor: null },
  );
}

const NOTE = { markdown: "## 重點\n- 甲", status: "completed", source: "mcp_api", updated_at: "2026-09-23 01:00:00Z" };

test("錄音記事的編輯區塊維持 v200 的展開式 <section>，不可收合", async () => {
  const { aiNoteEditorHtml } = await aiNoteRenderers();
  const html = aiNoteEditorHtml(null, "e");
  assert.match(html, /^<section class="ai-summary-note" data-ai-note-editor>/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /id="e-ai-note"/);
  assert.match(html, /id="e-ai-note-file"/);
});

test("非錄音記事：沒有內容時收合，有內容時展開；兩種情況 textarea 都在（存檔才讀得到）", async () => {
  const { aiNoteEditorHtml } = await aiNoteRenderers();
  const empty = aiNoteEditorHtml(null, "e", { collapsible: true });
  assert.match(empty, /^<details class="ai-summary-note ai-summary-note-collapsible" data-ai-note-editor>/);
  assert.match(empty, /尚未整理/);
  assert.match(empty, /id="e-ai-note"/);

  const withNote = aiNoteEditorHtml(NOTE, "e", { collapsible: true });
  assert.match(withNote, /^<details class="ai-summary-note ai-summary-note-collapsible" data-ai-note-editor open>/);
  assert.match(withNote, /來源：mcp_api/);
  assert.match(withNote, /## 重點\n- 甲<\/textarea>/);

  const blank = aiNoteEditorHtml({ markdown: "  \n " }, "e", { collapsible: true });
  assert.doesNotMatch(blank.split("\n")[0], / open>/, "只有空白字元不算有內容");
});

test("右欄預覽：非錄音記事同樣沒內容收合、有內容展開；錄音記事維持 <section>", async () => {
  const { aiNotePreviewHtml } = await aiNoteRenderers();
  assert.match(aiNotePreviewHtml(null, { collapsible: true }), /^<details class="ai-summary-note ai-summary-note-preview ai-summary-note-collapsible">/);
  assert.match(aiNotePreviewHtml(NOTE, { collapsible: true }), /^<details class="[^"]*ai-summary-note-collapsible" open>/);
  assert.match(aiNotePreviewHtml(NOTE), /^<section class="ai-summary-note ai-summary-note-preview">/);
});

test("兩個編輯畫面：每筆記事都渲染、綁定 .md 上傳、存檔，不再限定有錄音", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /aiNoteEditorHtml\(entry\.ai_note, "preview-entry", \{ collapsible: !recordingAudio\.length \}\)/);
  assert.match(app, /aiNoteEditorHtml\(e\.ai_note, "e", \{ collapsible: !entryAudio\.length \}\)/);
  assert.match(app, /\n  bindAiNoteFileInput\("preview-entry"\);/);
  assert.match(app, /\n  bindAiNoteFileInput\("e"\);/);
  assert.doesNotMatch(app, /(recordingAudio|entryAudio)\.length && aiMarkdown !== initialAiNoteMarkdown/);
  assert.doesNotMatch(app, /(recordingAudio|entryAudio)\.length \? aiNoteEditorHtml/);
});

test("右欄預覽的非錄音分支也顯示 AI 整理筆記，且「尚無內容」不會蓋掉已寫入的筆記", async () => {
  const inspector = await read("../fieldlog/public/inspector.js");
  assert.match(inspector, /inspector-document-preview">\$\{aiNotePreviewHtml\(entry\.ai_note, \{ collapsible: true \}\)\}/);
  assert.match(inspector, /!visibleEntryFields\(entry\)\.length && !String\(entry\.ai_note\?\.markdown \|\| ""\)\.trim\(\)\) body\.innerHTML = '<p class="folder-preview-empty">/);
});

test("後端：Agent 寫入的逐字稿版本檢查只套用在錄音記事", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /if \(isAgent && context\.audio\.length && \(!context\.complete \|\| !requestedRevision \|\| requestedRevision !== context\.revision\)\)/);
  assert.match(worker, /"AI 寫入整理筆記"/);
});
