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
  assert.match(app, /aiNoteEditorHtml\(entry\.ai_note, "preview-entry", \{ collapsible: !recordingAudio\.length \}\)/);
  assert.match(inspector, /aiNotePreviewHtml\(entry\.ai_note\)/);
});
