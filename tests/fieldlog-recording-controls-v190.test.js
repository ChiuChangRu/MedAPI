import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("錄音浮窗可以縮小，但縮小後仍保留停止按鈕", () => {
  assert.match(html, /id="audio-minimize-btn"/);
  assert.match(app, /function toggleAudioPanelMinimized\(\)/);
  assert.match(css, /\.audio-badge\.is-minimized/);
  assert.match(css, /\.audio-badge\.is-minimized #audio-stop-btn/);
  assert.doesNotMatch(css, /\.audio-badge\.is-minimized #audio-stop-btn[^}]*display:\s*none/);
});

test("錄音中可以改檔名；手動停止先暫停，再詢問檔名，空白可略過", () => {
  assert.match(html, /id="audio-rename-btn"[^>]*>✏️ 改檔名/);
  assert.match(app, /async function renameActiveAudio/);
  assert.match(app, /entered === null \|\| !entered\.trim\(\)/);
  const stop = app.match(/async function requestAudioStop\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(stop, /recorder\.pause\(\)/);
  assert.ok(stop.indexOf("recorder.pause()") < stop.indexOf("renameActiveAudio("));
  assert.match(stop, /renameActiveAudio\("錄音已暫停/);
  assert.match(app, /\$\("audio-stop-btn"\)\.onclick = requestAudioStop/);
});

test("閱讀模式仍把錄音狀態顯示在最上層", () => {
  assert.match(css, /body\.reader-fullscreen \.audio-badge \{ z-index: 120; \}/);
  assert.match(css, /body\.reader-fullscreen \.folder-preview[\s\S]*?z-index: 110/);
});
