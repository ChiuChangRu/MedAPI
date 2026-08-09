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
  assert.equal(calls.length, 2, "成功自動接續、跟完全接不上這兩條路徑都要留永久記錄，不能只顧一邊");
});
