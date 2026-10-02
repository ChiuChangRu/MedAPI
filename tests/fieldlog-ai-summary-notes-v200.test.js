import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("AI 整理筆記與原始逐字稿分表保存", async () => {
  const schema = await read("../fieldlog/src/lib/schema.js");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS entry_ai_notes/);
  assert.match(schema, /ai_summary\.cutoff/);
});

test("Claude 佇列只掃 cutoff 後建立的錄音，未完成轉錄先等待", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /e\.created_at >= \?/);
  assert.match(worker, /waiting_transcription/);
  assert.match(worker, /path === "\/ai-summary\/jobs"/);
  assert.match(worker, /逐字稿尚未完成或版本已改變/);
});

test("AI Agent 不可直接覆蓋人工修改稿", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /existing\?\.manually_edited/);
  assert.match(worker, /人工修改過的整理筆記不可由 Agent 覆蓋/);
});

test("錄音右欄最上方可貼上或上傳 Markdown", async () => {
  const app = await read("../fieldlog/public/app.js");
  const inspector = await read("../fieldlog/public/inspector.js");
  assert.match(app, /AI 整理筆記（Markdown）/);
  assert.match(app, /accept="\.md,text\/markdown,text\/plain"/);
  assert.match(app, /aiNoteEditorHtml\(entry\.ai_note, "preview-entry"\)/);
  assert.match(inspector, /aiNotePreviewHtml\(entry\.ai_note\)/);
});

// 2026-10-02：記事編輯視窗（openEntry 的置中 modal）移除「✨ AI 整理筆記
// （Markdown）」區塊的前端入口，但完整轉錄與關聯要維持原狀，且不能動到
// ai_note 的資料庫欄位／既有資料（只隱藏 UI，不是刪功能）。
test("記事編輯視窗（openEntry）不再顯示 AI 整理筆記區塊，但完整轉錄與關聯維持原狀", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /const SHOW_ENTRY_MODAL_AI_NOTE = false;/,
    "用常數關閉而不是刪掉程式碼，才能一行改回來，不用重寫");
  const openEntry = app.match(/async function openEntry\(id\)[\s\S]*?\n}\n/)[0];
  assert.match(openEntry, /entryAudio\.length && SHOW_ENTRY_MODAL_AI_NOTE \? aiNoteEditorHtml\(e\.ai_note, "e"\) : ""/,
    "渲染要掛在常數上，常數關閉時這個 modal 完全不產生 AI 整理筆記的 HTML");
  assert.match(openEntry, /if \(entryAudio\.length && SHOW_ENTRY_MODAL_AI_NOTE\) bindAiNoteFileInput\("e"\);/,
    "輸入框已經不在畫面上，不該還去綁一個不存在的 .md 上傳欄位");
  // 保留：完整轉錄與關聯兩個區塊的既有行為完全不受影響
  assert.match(openEntry, /📝 完整轉錄/);
  assert.match(openEntry, /id="e-open-transcript"/);
  assert.match(openEntry, /<h3 class="section-title">關聯 <button class="btn small" id="e-add-relation"/);
  assert.match(openEntry, /id="e-relations"/);
});

test("記事編輯視窗存檔時不會把隱藏起來的 AI 整理筆記存成空字串，蓋掉既有資料", async () => {
  const app = await read("../fieldlog/public/app.js");
  const openEntry = app.match(/async function openEntry\(id\)[\s\S]*?\n}\n/)[0];
  const saveHandler = openEntry.match(/\$\("e-save"\)\.onclick = async \(\) => \{[\s\S]*?\n  \};/)[0];
  assert.match(saveHandler,
    /const aiMarkdown = entryAudio\.length && SHOW_ENTRY_MODAL_AI_NOTE \? String\(\$\("e-ai-note"\)\?\.value \|\| ""\) : initialAiNoteMarkdown;/,
    "常數關閉時要直接沿用讀出來的 initialAiNoteMarkdown，而不是去讀一個不存在的輸入框拿到空字串");
  assert.match(saveHandler, /if \(entryAudio\.length && SHOW_ENTRY_MODAL_AI_NOTE && aiMarkdown !== initialAiNoteMarkdown\) \{/,
    "常數關閉時這個條件恆假，PUT /entries/:id/ai-note 不會被呼叫，既有 ai_note 資料原封不動");
});

test("桌機右欄編輯器（renderEntryEditor）沒有被要求改動，AI 整理筆記維持原樣", async () => {
  const app = await read("../fieldlog/public/app.js");
  const renderEntryEditor = app.match(/async function renderEntryEditor\(entryId\)[\s\S]*?\n}\n/)[0];
  assert.match(renderEntryEditor, /\$\{recordingAudio\.length \? aiNoteEditorHtml\(entry\.ai_note, "preview-entry"\) : ""\}/,
    "這支是 renderEntryEditor 的呼叫點，不該被 openEntry 的開關連帶影響");
});
