import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");

function audioRecorderBody() {
  const match = app.match(/function startAudioSegRecorder\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "找不到 startAudioSegRecorder");
  return match[0];
}

test("Chrome 錄音優先使用可串接的 WebM Opus，MP4 只作退路", () => {
  const body = audioRecorderBody();
  const list = body.match(/const mimeType = \[(.*?)\]/s)?.[1] || "";
  assert.ok(list.indexOf('"audio/webm;codecs=opus"') >= 0);
  assert.ok(list.indexOf('"audio/mp4"') > list.indexOf('"audio/webm;codecs=opus"'));
});

test("MP4 不使用五秒 timeslice，避免播放器只顯示第一個 fragment", () => {
  const body = audioRecorderBody();
  assert.match(body, /\^audio\\\/mp4/);
  assert.match(body, /recorder\.start\(\);/);
  assert.match(body, /else recorder\.start\(AUDIO_DATA_SLICE_MS\);/);
});
