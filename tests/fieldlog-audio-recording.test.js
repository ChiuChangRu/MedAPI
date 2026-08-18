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

test("MediaRecorder 要定期交出資料，並監聽 recorder error", () => {
  assert.match(app, /const AUDIO_DATA_SLICE_MS = 5000;/, "背景凍結前要縮短尚未交給 JS 的錄音資料量");
  const fn = app.match(/function startAudioSegRecorder\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /recorder\.start\(AUDIO_DATA_SLICE_MS\)/, "MediaRecorder.start 要帶 timeslice");
  assert.match(fn, /recorder\.onerror\s*=.*recorderFailed/s, "MediaRecorder 自己報錯也要觸發接續判斷");
});

test("pagehide 不得停止背景錄音；真正離頁由 beforeunload 先警告", () => {
  const hide = app.match(/function onPageHide\(event\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(hide, /onPageHidden\(\)/, "pagehide 應先要求錄音資料切片保存");
  assert.doesNotMatch(hide, /stopAnyActiveCapture\(\)/,
    "手機切換 App 或瀏覽器凍結也可能送出 pagehide，不可因此結束錄音");
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

// 2026-08-16 使用者實測回報：錄音約 10 分鐘後跳「⛔ 錄音無法自動接續
// （Error：頁面尚未回到前景），請結束後重新錄音」。原因不是麥克風真的壞掉，
// 而是恢復流程最長會跑十幾秒（AUDIO_RECOVERY_ATTEMPTS 次 × 每次最多等音軌
// 喚醒 ＋ 逐次拉長的退避），迴圈每一輪開頭都檢查 document.hidden；使用者在
// 這段期間只要再切走一次分頁就會被丟出這個錯，而它當時被當成永久失敗處理。
test("版本號四處同步（app.js／worker.js／sw.js 快取名）", async () => {
  const appVer = app.match(/const APP_VERSION = "(\d+)"/)?.[1];
  const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  const sw = await readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8");
  const index = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
  assert.ok(appVer, "app.js 要有 APP_VERSION");
  assert.equal(worker.match(/const UI_VERSION = "(\d+)"/)?.[1], appVer,
    "worker.js 的 UI_VERSION 要跟 app.js 一致，否則畫面會一直提示版本不符");
  assert.match(sw.match(/const CACHE = "(.*?)"/)?.[1] || "", new RegExp(`-v${appVer}-`),
    "sw.js 的快取名要帶上同一版號，否則瀏覽器會續用舊的 app.js");
  assert.ok(!index.includes(`?v=${Number(appVer) - 1}`),
    "index.html 的資源版號不可殘留上一版");
});



/**
 * 🎙 2026-08-18 迴歸測試：換段太頻繁，把錄音剁碎並且每次換段都掉音訊
 *
 * 使用者實測（桌機 Chrome 切分頁／切別的 App）：一段 3 分 34 秒（214 秒）的
 * 錄音被剁成 6 段，實際只錄到 107 秒——整整一半掉在換段的空隙裡，而且每一段
 * 都是「無語音內容」。
 *
 * 根因不是「接不上」，而是「接得太頻繁」：桌機 Chrome 切分頁時錄音其實照常
 * 進行，但程式每次回前景都判定中斷、把 stream 拆掉重建，重建的空窗就是掉掉
 * 的音訊。track.muted 常常只是一瞬間（系統提示音、裝置切換），被當成報廢。
 *
 * 因此原則反過來：預設什麼都不做。只有「音軌全部 ended」或「recorder 不在
 * recording」才算真的死了；muted 先給緩衝等它自行恢復；真的要換段時還有節流，
 * 不能連續剁。
 *
 * 這幾個測試直接跑 resumeAudioOnForeground 的行為，不比對原始碼字串。
 */
function makeAudioHarness(app, { AUDIO, getUserMedia, hidden = false }) {
  const src = app.match(/async function resumeAudioOnForeground\(\)[\s\S]*?\n\}\n\n/)?.[0];
  const rebuild = app.match(/async function rebuildAudioAfterInterruption\([\s\S]*?\n\}\n/)?.[0];
  const alive = app.match(/async function audioStillAlive\(\)[\s\S]*?\n\}\n/)?.[0];
  const waitFn = app.match(/function waitForTrackUsable\(stream, timeoutMs\)[\s\S]*?\n\}\n/)?.[0];
  assert.ok(src && rebuild && alive && waitFn, "找不到錄音接續相關函式");

  const calls = { getUserMedia: 0, startSeg: 0, status: [], notes: [] };
  const body = `
    ${waitFn}
    ${alive}
    ${rebuild}
    ${src}
    return resumeAudioOnForeground;`;
  const fn = new Function(
    "AUDIO", "navigator", "document", "fmtSecs", "setAudioStatus", "showToast",
    "noteAudioInterruption", "watchAudioStream", "startAudioSegRecorder",
    "AUDIO_SEG_OVERLAP_MS", "AUDIO_RECOVERY_ATTEMPTS", "AUDIO_RECOVERY_RETRY_MS",
    "AUDIO_MUTE_GRACE_MS", "AUDIO_MIN_ROTATE_INTERVAL_MS", "setTimeout", "clearTimeout",
    body
  )(
    AUDIO,
    { mediaDevices: { async getUserMedia() { calls.getUserMedia++; return getUserMedia(); } } },
    { hidden },
    (n) => String(n),
    (msg) => calls.status.push(String(msg)),
    () => {},
    async (id, line) => { calls.notes.push(line); },
    () => {},
    () => { calls.startSeg++; },
    0, 3, 0, 20, 20000,
    (cb, ms) => globalThis.setTimeout(cb, Math.min(ms || 0, 5)),
    (id) => globalThis.clearTimeout(id),
  );
  return { run: fn, calls };
}

const liveTrack = () => ({ readyState: "live", muted: false, stop() { this.readyState = "ended"; }, addEventListener() {}, removeEventListener() {} });
const newStreamOf = () => { const t = liveTrack(); return { getAudioTracks: () => [t], getTracks: () => [t] }; };

test("桌機切分頁回來、錄音其實還活著時：完全不換段、不重取麥克風", async () => {
  const track = liveTrack();
  const AUDIO = {
    ending: false, resuming: false, backgroundAt: Date.now() - 120_000, backgroundSecs: 0,
    startedAt: Date.now() - 200_000, segIndex: 1, entryId: 7,
    trackInterrupted: false, trackInterruptedAt: 0, recorderFailed: false,
    lastRotateAt: 0, recheckTimer: 0,
    recorder: { state: "recording", stop() {} },
    stream: { getAudioTracks: () => [track] },
  };
  const { run, calls } = makeAudioHarness(app, { AUDIO, getUserMedia: newStreamOf });
  await run();

  assert.equal(calls.getUserMedia, 0, "錄音還活著就不該重取麥克風——重取的空窗正是音訊掉掉的地方");
  assert.equal(calls.startSeg, 0, "錄音還活著就不該開新的一段");
  assert.equal(AUDIO.segIndex, 1, "段號不可以前進，否則一次錄音會被切分頁次數剁碎");
  assert.equal(calls.notes.length, 0, "沒有真的中斷就不該往記事寫中斷警告");
});

test("音軌只是短暫 muted、隨後自行 unmute：一樣不換段", async () => {
  const track = { readyState: "live", muted: true, stop() {}, _h: [],
    addEventListener(ev, cb) { this._h.push([ev, cb]); },
    removeEventListener() {} };
  // 緩衝期間自行 unmute
  globalThis.setTimeout(() => {
    track.muted = false;
    track._h.filter(([e]) => e === "unmute").forEach(([, cb]) => cb());
  }, 1);
  const AUDIO = {
    ending: false, resuming: false, backgroundAt: Date.now() - 5_000, backgroundSecs: 0,
    startedAt: Date.now() - 60_000, segIndex: 1, entryId: 7,
    trackInterrupted: true, trackInterruptedAt: Date.now() - 5_000, recorderFailed: false,
    lastRotateAt: 0, recheckTimer: 0,
    recorder: { state: "recording", stop() {} },
    stream: { getAudioTracks: () => [track] },
  };
  const { run, calls } = makeAudioHarness(app, { AUDIO, getUserMedia: newStreamOf });
  await run();

  assert.equal(calls.getUserMedia, 0, "瞬間 muted 自行恢復後不該重取麥克風");
  assert.equal(AUDIO.segIndex, 1, "瞬間 muted 不該讓錄音被切成兩段");
  assert.equal(AUDIO.trackInterrupted, false, "自行恢復後要清掉中斷標記，否則下次回前景又會重跑一次");
});

test("音軌真的 ended：才重取麥克風並開新的一段", async () => {
  const dead = { readyState: "ended", muted: false, stop() {}, addEventListener() {}, removeEventListener() {} };
  const AUDIO = {
    ending: false, resuming: false, backgroundAt: Date.now() - 30_000, backgroundSecs: 0,
    startedAt: Date.now() - 60_000, segIndex: 1, entryId: 7,
    trackInterrupted: true, trackInterruptedAt: Date.now() - 30_000, recorderFailed: false,
    lastRotateAt: 0, recheckTimer: 0,
    recorder: { state: "recording", stop() {} },
    stream: { getAudioTracks: () => [dead] },
  };
  const { run, calls } = makeAudioHarness(app, { AUDIO, getUserMedia: newStreamOf });
  await run();

  assert.equal(calls.getUserMedia, 1, "音軌確定死掉就必須重取麥克風");
  assert.equal(calls.startSeg, 1, "重取後要開新的一段接續");
  assert.equal(AUDIO.segIndex, 2, "段號要前進");
  assert.ok(calls.notes.some((n) => n.includes("接續")), "真的中斷要留下永久記錄");
});

test("換段有節流：短時間內反覆中斷不可把錄音剁成很多段", async () => {
  const dead = { readyState: "ended", muted: false, stop() {}, addEventListener() {}, removeEventListener() {} };
  const AUDIO = {
    ending: false, resuming: false, backgroundAt: Date.now() - 5_000, backgroundSecs: 0,
    startedAt: Date.now() - 60_000, segIndex: 3, entryId: 7,
    trackInterrupted: true, trackInterruptedAt: Date.now() - 5_000, recorderFailed: false,
    // 剛剛才換過段
    lastRotateAt: Date.now() - 1_000, recheckTimer: 0,
    recorder: { state: "recording", stop() {} },
    stream: { getAudioTracks: () => [dead] },
  };
  const { run, calls } = makeAudioHarness(app, { AUDIO, getUserMedia: newStreamOf });
  await run();

  assert.equal(calls.getUserMedia, 0, "距離上次換段還太近，不可立刻又換一段");
  assert.equal(AUDIO.segIndex, 3, "段號不可以前進——使用者實測 214 秒被剁成 6 段就是缺這道閘");
});
