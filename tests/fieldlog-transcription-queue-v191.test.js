import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetryableTranscriptionError, recoverPreviousDayTranscriptionClaims } from "../fieldlog/src/worker.js";

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

test("上一日意外卡在 processing 的段落會跨日解鎖，同一天不會重送", () => {
  assert.match(worker, /function recoverPreviousDayTranscriptionClaims/);
  assert.match(worker, /transcribed_at = 'processing'/);
  assert.match(worker, /r\.usage_date < \?/);
  assert.match(worker, /r\.status = 'reserved'/);
  assert.match(worker, /SET status = 'queued'/);
  assert.match(worker, /const recovered = await recoverPreviousDayTranscriptionClaims\(env\.DB\)/);
});

test("跨日解鎖實際只重排前一日 processing，當日 claim 保持鎖定", async () => {
  const makeDb = (usageDate) => {
    const state = { transcript: "", transcribed_at: "processing", usage_date: usageDate, status: "reserved" };
    return {
      state,
      prepare(sql) {
        return { bind(today) { return { async run() {
          if (sql.includes("UPDATE attachments")) {
            const eligible = !state.transcript && state.transcribed_at === "processing" && state.usage_date < today && state.status === "reserved";
            if (eligible) state.transcribed_at = "";
            return { meta: { changes: eligible ? 1 : 0 } };
          }
          const eligible = state.usage_date < today && state.status === "reserved" && !state.transcript && !state.transcribed_at;
          if (eligible) state.status = "queued";
          return { meta: { changes: eligible ? 1 : 0 } };
        } }; } };
      },
    };
  };
  const previous = makeDb("2026-09-13");
  assert.equal(await recoverPreviousDayTranscriptionClaims(previous, new Date("2026-09-14T00:15:00Z")), 1);
  assert.equal(previous.state.transcribed_at, "");
  assert.equal(previous.state.status, "queued");

  const sameDay = makeDb("2026-09-14");
  assert.equal(await recoverPreviousDayTranscriptionClaims(sameDay, new Date("2026-09-14T00:15:00Z")), 0);
  assert.equal(sameDay.state.transcribed_at, "processing");
  assert.equal(sameDay.state.status, "reserved");
});

test("自動候選只包含逐字稿與狀態都空白的段落，已完成內容不會重複送件", () => {
  assert.match(worker, /kind = 'audio' AND COALESCE\(transcript, ''\) = '' AND COALESCE\(transcribed_at, ''\) = ''/);
  assert.match(worker, /INSERT OR IGNORE INTO ai_usage_reservations/);
  assert.match(worker, /WHERE id = \? AND COALESCE\(transcribed_at, ''\) = ''/);
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
