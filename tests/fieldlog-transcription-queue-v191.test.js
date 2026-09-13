import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetryableTranscriptionError } from "../fieldlog/src/worker.js";

const worker = readFileSync(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../fieldlog/wrangler.jsonc", import.meta.url), "utf8");

test("額度重置後在台灣 08:15 至 09:45 自動補轉錄", () => {
  assert.match(wrangler, /"15,45 0-1 \* \* \*"/);
  assert.match(worker, /event\?\.cron === TRANSCRIPTION_RETRY_CRON/);
  assert.match(worker, /runPendingAudioTranscriptions\(env\)/);
  assert.match(worker, /ORDER BY first_audio_at, a\.entry_id/);
});

test("額度與頻率限制會排到隔日，其他錯誤仍標示失敗", () => {
  assert.equal(isRetryableTranscriptionError(new Error("429 quota exceeded")), true);
  assert.equal(isRetryableTranscriptionError(new Error("rate limit")), true);
  assert.equal(isRetryableTranscriptionError(new Error("unsupported audio format")), false);
  assert.match(worker, /UPDATE attachments SET transcribed_at = ''/);
  assert.match(worker, /UPDATE ai_usage_reservations SET status = 'queued'/);
  assert.match(worker, /等待隔日自動轉錄/);
  assert.match(worker, /SELECT usage_date, status FROM ai_usage_reservations WHERE attachment_id = \?/);
  assert.match(worker, /previous\.usage_date !== today/);
});

test("所有錄音入口共用完整轉錄對話框與一鍵複製", () => {
  assert.match(app, /function openRecordingTranscriptDialog\(title, audioAttachments\)/);
  assert.match(app, /className = "recording-transcript-dialog"/);
  assert.match(app, /一鍵複製全部文字/);
  assert.match(app, /navigator\.clipboard\.writeText\(transcript\)/);
  assert.match(app, /id="recording-preview-transcript-dialog"/);
  assert.match(app, /id="recording-edit-full-transcript"/);
  assert.match(app, /id="e-open-transcript"/);
  assert.match(css, /\.recording-transcript-dialog::backdrop/);
});
