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

test("背景錄音提示誠實區分 Android 與 iPhone 限制", () => {
  assert.match(app, /背景錄音嘗試中；Android 較可能持續，iPhone 可能暫停/);
  assert.match(app, /AUDIO\.recorder\?\.state === "recording"/);
  assert.match(app, /AUDIO\.recorder\.requestData\(\)/);
  assert.match(app, /resumeAudioOnForeground/);
});
