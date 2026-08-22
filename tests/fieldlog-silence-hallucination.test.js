/**
 * 🎙 Whisper 靜音幻覺過濾。
 *
 * 2026-08-16 使用者實測：麥克風喚醒失敗（錄音浮動列同時顯示「麥克風音軌喚醒
 * 逾時」），實際錄到的是靜音，即時逐字稿整段變成
 * "Thank you. Thank you. Thank you…"。Whisper 拿到靜音時不會回空字串，而是
 * 反覆吐出訓練資料裡的常見結尾語。
 *
 * 這種內容照單全收會同時污染三個地方：永久存成逐字稿、被拿去自動命名附件、
 * 還餵進語意搜尋的向量庫，之後搜尋「thank」會撈到一堆沒有內容的錄音。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let looksLikeSilenceHallucination;
test.before(async () => {
  const src = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const phrases = src.match(/const SILENCE_HALLUCINATION_PHRASES = \[[\s\S]*?\];/)?.[0];
  const fn = src.match(/function looksLikeSilenceHallucination\(text\)[\s\S]*?\n\}/)?.[0];
  assert.ok(phrases && fn, "worker.js 要有靜音幻覺判斷");
  looksLikeSilenceHallucination = new Function(`${phrases}\n${fn}\nreturn looksLikeSilenceHallucination;`)();
});

test("截圖那段整串 Thank you 要被判定成靜音幻覺", () => {
  assert.equal(looksLikeSilenceHallucination("Thank you. ".repeat(25).trim()), true);
});

test("單句已知的靜音幻覺句也要抓到", () => {
  for (const s of ["Thank you.", "thank you", "Thank you for watching", "謝謝觀看"]) {
    assert.equal(looksLikeSilenceHallucination(s), true, `「${s}」應判定為靜音幻覺`);
  }
});

test("真實逐字稿不可被誤殺", () => {
  const real = "今天討論封閉式抽痰管的滅菌流程。EO 殘留量必須符合規範。品保那邊回報客訴三件。下週安排試模。請大家準備資料。";
  assert.equal(looksLikeSilenceHallucination(real), false);
});

test("真人重複強調同一句話不算幻覺", () => {
  const real = "這個很重要。這個很重要。真的非常重要，大家一定要記得。滅菌參數不能改。確認後再回報給我。";
  assert.equal(looksLikeSilenceHallucination(real), false);
});

test("真人在結尾道謝不可被當成幻覺整段丟掉", () => {
  assert.equal(looksLikeSilenceHallucination("謝謝大家今天的參與，辛苦了。"), false);
});

test("空字串與空白不算幻覺（本來就沒有內容，走原本的無語音路徑）", () => {
  assert.equal(looksLikeSilenceHallucination(""), false);
  assert.equal(looksLikeSilenceHallucination("   "), false);
});

test("判定成幻覺時不可寫進逐字稿、不可拿去命名、不可餵進向量庫", async () => {
  const src = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const fn = src.match(/async function transcribeAttachment\(env, db, old\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /const hallucinated = looksLikeSilenceHallucination\(raw\)/,
    "轉錄流程要實際呼叫判斷，不能只定義不用");
  assert.match(fn, /const text = hallucinated \? "" : raw/,
    "判定成幻覺要存成空字串——autoRenameAttachment 與 triggerEmbedding 都吃這個變數，"
    + "一次擋掉逐字稿、自動命名、向量庫三個污染點");
  assert.match(fn, /沒有收到聲音/,
    "歷程要講清楚是麥克風沒收到聲音，不要只寫「無語音內容」讓人以為是自己沒講話");
});
