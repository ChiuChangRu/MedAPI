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

test("MCP 可只寫 AI 整理筆記，並提供樂觀鎖與稽核版本", async () => {
  const mcp = await read("../mcp/src/worker.js");
  const fieldlog = await read("../fieldlog/src/worker.js");
  const schema = await read("../fieldlog/src/lib/schema.js");
  assert.match(mcp, /name: "update_ai_notes"/);
  assert.match(mcp, /expected_updated_at/);
  assert.match(mcp, /AI 整理筆記寫入失敗/);
  assert.match(fieldlog, /AI 整理筆記已在讀取後被修改，拒絕覆蓋/);
  assert.match(fieldlog, /entry_ai_note_revisions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS entry_ai_note_revisions/);
});

test("MCP 讀取與清單提供 AI 筆記、轉錄狀態與建立時間篩選", async () => {
  const mcp = await read("../mcp/src/worker.js");
  assert.match(mcp, /ai_notes_updated_at/);
  assert.match(mcp, /transcription_status/);
  assert.match(mcp, /audio_segments_transcribed/);
  assert.match(mcp, /created_after/);
  assert.match(mcp, /include_subfolders/);
  assert.match(mcp, /transcript_view/);
});

test("錄音右欄最上方可貼上或上傳 Markdown", async () => {
  const app = await read("../fieldlog/public/app.js");
  const inspector = await read("../fieldlog/public/inspector.js");
  assert.match(app, /AI 整理筆記（Markdown）/);
  assert.match(app, /accept="\.md,text\/markdown,text\/plain"/);
  assert.match(app, /aiNoteEditorHtml\(entry\.ai_note, "preview-entry"\)/);
  assert.match(inspector, /aiNotePreviewHtml\(entry\.ai_note\)/);
});
