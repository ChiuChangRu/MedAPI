/**
 * v227 錄音中拍照：錄音面板（z-index 95）原本蓋住相機快門（相機 z-index 80）。
 * 相機開著時 body 加 audio-camera-open，面板縮成上方一條、不可點；關相機時移除。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("開關相機時切換 audio-camera-open，面板縮到上方且不擋快門", async () => {
  const [app, css] = await Promise.all([read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css")]);
  const open = app.match(/async function openAudioPhotoPopup\(\)[\s\S]*?\n}/)[0];
  const close = app.match(/function closeAudioPhotoPopup\(\)[\s\S]*?\n}/)[0];
  assert.match(open, /classList\.add\("audio-camera-open"\)/);
  assert.match(close, /classList\.remove\("audio-camera-open"\)/);
  const block = css.slice(css.indexOf("/* v227 錄音中拍照"));
  assert.match(block, /body\.audio-camera-open \.audio-badge \{[\s\S]*?bottom: auto;[\s\S]*?pointer-events: none;/);
  assert.match(block, /> :not\(\.audio-panel-heading\)[\s\S]*?display: none !important;/, "停止錄音等按鈕在相機開著時隱藏");
});
