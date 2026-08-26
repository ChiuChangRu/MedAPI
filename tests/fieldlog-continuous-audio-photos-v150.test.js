import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");

test("錄音中拍照維持取景器，直到使用者按完成", () => {
  const start = app.indexOf("async function audioPhotoSnap()");
  const end = app.indexOf("function onPageHidden()", start);
  const snap = app.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(snap, /closeAudioPhotoPopup\(\)/);
  assert.match(snap, /audio-photo-count/);
  assert.match(snap, /putFile\(entryId, blob, filename, offset\)[\s\S]*\.catch/);
  assert.match(html, /id="audio-photo-cancel"[^>]*>✓<span>完成<\/span>/);
  assert.match(html, /id="audio-photo-count"/);
});

test("iOS 切到背景立即保存，其他平台才嘗試背景續錄", () => {
  assert.match(app, /if \(isIOSMobile\(\)\)[\s\S]*AUDIO\.autoStopped = true;[\s\S]*stopAudio\(\)/);
  assert.match(app, /iPhone 不支援可靠背景錄音，已結束並保存/);
  assert.match(app, /背景錄音嘗試中；請勿鎖屏或關閉 MyWiki/);
  assert.match(app, /AUDIO\.recorder\?\.state === "recording"/);
  assert.match(app, /AUDIO\.recorder\.requestData\(\)/);
  assert.match(app, /resumeAudioOnForeground/);
});

test("iOS 拍照造成短暫 hidden 不會立刻關掉連拍取景器", () => {
  assert.match(app, /AUDIO_PHOTO_HIDE_TIMER = setTimeout\([\s\S]*document\.hidden[\s\S]*1500/);
  assert.match(app, /clearTimeout\(AUDIO_PHOTO_HIDE_TIMER\)/);
});
