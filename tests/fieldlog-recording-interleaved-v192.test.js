import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const inspector = readFileSync(new URL("../fieldlog/public/inspector.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("錄音預覽依語音檔案、該段轉錄的順序交錯顯示", () => {
  assert.match(inspector, /class="recording-interleaved-segment"/);
  assert.match(inspector, /<strong>語音檔案 \$\{index \+ 1\}<\/strong>/);
  assert.match(inspector, /<strong>轉錄 \$\{index \+ 1\}<\/strong>/);
  assert.match(inspector, /String\(a\.transcript \|\| ""\)\.trim\(\)/);
  assert.match(inspector, /sort\(\(a, b\) => Number\(a\.offset_secs/);
});

test("錄音預覽本身是單欄容器，人工速記只接在全部段落之後", () => {
  assert.match(css, /\.inspector-recording-preview \{ width: 100%; min-width: 0;/);
  assert.match(css, /\.recording-interleaved-preview \{ display: grid; gap: \d+px; \}/);
  assert.match(inspector, /!recordingFields\._recording_document_hash/);
  assert.match(inspector, /querySelector\("\.inspector-recording-preview"\)\.appendChild\(frame\)/);
});

test("右欄明列已轉錄與未轉錄段數，並說明隔日自動接續及防重", () => {
  assert.match(inspector, /已轉錄 \$\{recordingProgress\.completedCount\} 段/);
  assert.match(inspector, /未轉錄 \$\{recordingProgress\.remainingCount\} 段/);
  assert.match(inspector, /隔日台灣時間 08:15 起自動接續/);
  assert.match(inspector, /已完成段落不會重複轉錄/);
  assert.match(css, /\.recording-progress-summary/);
});
