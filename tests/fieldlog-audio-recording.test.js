/**
 * 🎙 錄音：分段長度、換段時的接續方式、背景中斷要留下永久記錄。
 *
 * 這裡沒有瀏覽器/DOM/MediaRecorder 可以真的錄音測試，跟這個專案其他前端測試
 * 一致的做法：直接檢查原始碼裡的關鍵邏輯有沒有接上。
 *
 * 背景（2026-08-XX 使用者回報）：
 * 1. 上課用電腦錄音，Chrome 切分頁／開 Outlook 會被系統中斷，浮動列的中斷
 *    提示是一閃而過的，事後回顧記事完全看不出來哪裡斷過。
 * 2. 分段長度改成跟錄影一樣的 10 分鐘為單位；換段的瞬間原本是「先停舊的
 *    recorder、onstop 觸發後才開新的」，中間有一個技術性的小空隙。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let app;
test.before(async () => {
  app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
});

test("錄音分段長度改成跟錄影一樣 10 分鐘為單位，不是各自寫死的數字", () => {
  assert.match(app, /const AUDIO_LIVE_SEG_SECONDS = SEG_MINUTES \* 60;/,
    "音檔分段長度要跟錄影共用 SEG_MINUTES，不要各自硬寫一個數字之後兜不起來");
});

test("換段用「新的先開始收音、重疊一小段才收尾舊的」，不是「先停舊的才開新的」", () => {
  assert.match(app, /function rotateAudioSegment\(\)/, "要有專門的換段函式");
  const fn = app.match(/function rotateAudioSegment\(\)[\s\S]*?\n\}/)?.[0] || "";
  // 新 recorder 要在 setTimeout（收尾舊的）之前就呼叫 startAudioSegRecorder()，
  // 這樣兩段音檔在時間軸上會重疊，而不是中間有一段沒有任何 recorder 在收音
  const startIdx = fn.indexOf("startAudioSegRecorder()");
  const stopIdx = fn.indexOf("oldRecorder.stop()");
  assert.ok(startIdx > -1 && stopIdx > -1 && startIdx < stopIdx,
    "新的一段要先開始收音，才去停舊的那個 recorder，避免中間出現收不到音的空隙");
  assert.match(fn, /setTimeout\([\s\S]*AUDIO_SEG_OVERLAP_MS\)/, "收尾舊 recorder 要延遲一小段重疊時間，不是立刻停");
});

test("錄音狀態列的定時器改呼叫 rotateAudioSegment，不是直接 recorder.stop()", () => {
  assert.match(app, />= AUDIO_LIVE_SEG_SECONDS \* 1000\) \{\s*\n\s*rotateAudioSegment\(\);/,
    "分段時間到了要走有重疊保護的換段函式，不能繞過去直接 stop()");
});

test("背景中斷時要把警示寫進記事永久保存，不是只有浮動列上一閃而過的提示", () => {
  assert.match(app, /async function noteAudioInterruption\(entryId, line\)/, "要有專門把中斷寫進記事的函式");
  const fn = app.match(/async function noteAudioInterruption[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /api\(`\/entries\/\$\{entryId\}\/notes`,\s*\{\s*method:\s*"POST"/,
    "要透過既有的「記一句」端點附加，不是自己另外發明一套寫法");
});

test("resumeAudioOnForeground：成功接續與無法接續兩種結果都要呼叫 noteAudioInterruption", () => {
  const fn = app.match(/async function resumeAudioOnForeground[\s\S]*?\n\}\n/)?.[0] || "";
  const calls = fn.match(/noteAudioInterruption\(/g) || [];
  assert.equal(calls.length, 3, "成功接續、舊音軌恢復、完全接不上三條路徑都要留永久記錄，不能只顧一邊");
});

test("MediaRecorder 要定期交出資料，並監聽 recorder error", () => {
  assert.match(app, /const AUDIO_DATA_SLICE_MS = 5000;/, "背景凍結前要縮短尚未交給 JS 的錄音資料量");
  const fn = app.match(/function startAudioSegRecorder\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /recorder\.start\(AUDIO_DATA_SLICE_MS\)/, "MediaRecorder.start 要帶 timeslice");
  assert.match(fn, /recorder\.onerror\s*=.*recorderFailed/s, "MediaRecorder 自己報錯也要觸發接續判斷");
});

test("音軌 muted 或 ended 也算中斷，不能只檢查 MediaRecorder.state", () => {
  const watch = app.match(/function watchAudioStream\(stream\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(watch, /addEventListener\("mute", markInterrupted\)/, "iOS 常只把 track muted，必須監聽");
  assert.match(watch, /addEventListener\("ended", markInterrupted\)/, "麥克風 track 結束必須監聽");
  const resume = app.match(/async function resumeAudioOnForeground[\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(resume, /track\.muted/, "回前台要檢查仍處於 muted 的 track");
  assert.match(resume, /AUDIO\.trackInterrupted/, "mute 後已自行 unmute 也要留下中斷邊界");
  assert.match(resume, /AUDIO\.recorderFailed/, "recorder error 也要重建錄音器");
});

test("回前台重建時先開始新 recorder，再延遲停止舊 recorder", () => {
  const resume = app.match(/async function resumeAudioOnForeground[\s\S]*?\n\}\n/)?.[0] || "";
  const startIdx = resume.indexOf("startAudioSegRecorder()");
  const stopIdx = resume.indexOf("oldRecorder.stop()");
  assert.ok(startIdx > -1 && stopIdx > -1 && startIdx < stopIdx,
    "恢復前景時要先接上新的 recorder，不能再製造可避免的空隙");
  assert.match(resume, /setTimeout\([\s\S]*AUDIO_SEG_OVERLAP_MS\)/,
    "舊 recorder 要延遲到重疊時間後才停止");
});

test("pagehide 進入 bfcache 時不能停止錄音，真正離頁則先由 beforeunload 警告", () => {
  const hide = app.match(/function onPageHide\(event\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(hide, /if \(event\.persisted\)[\s\S]*onPageHidden\(\);[\s\S]*return;/,
    "bfcache 只是凍結，不能當成真正關頁");
  assert.match(hide, /stopAnyActiveCapture\(\)/, "真正卸載仍要嘗試收尾");
  assert.doesNotMatch(app, /addEventListener\("pagehide", stopAnyActiveCapture\)/,
    "pagehide 不可再無條件停止所有採集");
  assert.match(app, /addEventListener\("beforeunload", guardRecordingNavigation\)/,
    "錄音中用同一頁籤離開要先顯示原生確認");
});

test("frozen 或 bfcache 回復也會檢查並接續錄音", () => {
  assert.match(app, /addEventListener\("pageshow", resumeAudioOnForeground\)/,
    "bfcache 回來不一定有 visibilitychange，要監聽 pageshow");
  assert.match(app, /addEventListener\("resume", resumeAudioOnForeground\)/,
    "Chrome frozen page 回復要監聽 resume");
  assert.match(app, /addEventListener\("freeze", onPageHidden\)/,
    "頁面凍結前要要求 recorder 交出資料");
});
