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
 * 🎙 2026-08-18（二）架構重寫後的行為測試：Web Audio 中繼收音
 *
 * 教訓總結（v118–v121 四次失敗）：
 * - 殭屍音軌：readyState=live、muted=false、recorder 照樣吐資料，但樣本全零。
 *   任何靠狀態旗標的偵測都會被騙過。唯一可靠判準＝量測實際訊號。
 * - 重建 MediaRecorder 必掉音訊：實測 214 秒被剁成 6 段、只錄到 107 秒。
 *   唯一不掉音訊的恢復＝recorder 錄固定的 destination stream、只換訊號源。
 *
 * 以下測試直接執行抽出的函式驗證行為，不比對原始碼字串。
 */

const liveTrack = () => ({ readyState: "live", muted: false, stop() { this.readyState = "ended"; }, addEventListener() {}, removeEventListener() {} });

function extractFns(app, names) {
  return names.map((n) => {
    const re = new RegExp(`(?:async )?function ${n}\\([^)]*\\)[\\s\\S]*?\\n\\}\\n`);
    const m = app.match(re)?.[0];
    assert.ok(m, `找不到函式 ${n}`);
    return m;
  }).join("\n");
}

// 把 attemptMicSwap 抽出來、注入替身依賴後直接執行，驗行為而不是比對字串。
function swapRunner(src, AUDIO, overrides = {}) {
  const deps = {
    document: { hidden: false },
    AUDIO_RECOVERY_ATTEMPTS: 3,
    AUDIO_RECOVERY_RETRY_MS: 0,
    AUDIO_MIN_SWAP_INTERVAL_MS: 15000,
    stopStream: (s) => { try { s?.getTracks().forEach((t) => t.stop()); } catch {} },
    acquireLiveMic: async () => { throw new Error("測試未提供 acquireLiveMic"); },
    watchAudioStream: () => {},
    setAudioStatus: () => {},
    noteAudioInterruption: async () => {},
    fmtSecs: (n) => String(n),
    ...overrides,
  };
  const names = Object.keys(deps);
  return new Function("AUDIO", ...names, `${src}; return attemptMicSwap;`)(
    AUDIO, ...names.map((n) => deps[n]));
}

test("錄音器錄的是 Web Audio destination stream，不是麥克風 stream", () => {
  const seg = app.match(/function startAudioSegRecorder\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(seg, /audioRecordStream\(\)/,
    "recorder 必須錄 audioRecordStream()——錄麥克風 stream 的話，換麥克風就得換段，音訊就會掉");
  assert.doesNotMatch(seg, /MediaRecorder\(AUDIO\.stream/,
    "不可以直接把 AUDIO.stream 餵給 MediaRecorder");
  const graph = app.match(/function initAudioGraph\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(graph, /createMediaStreamDestination\(\)/, "要有 destination 中繼");
  assert.match(graph, /createAnalyser\(\)/, "要有 analyser 量測實際訊號");
});

test("訊號監測：有訊號→不動作；持續全零→觸發換源；換源有節流", async () => {
  const src = extractFns(app, ["noteMicPeak", "checkMicSignal"]);
  const calls = { swap: 0 };
  const make = (peak, AUDIO) => new Function(
    "AUDIO", "AUDIO_SIGNAL_FLOOR", "AUDIO_DEAD_SIGNAL_MS", "readMicPeak", "attemptMicSwap",
    `${src}; return checkMicSignal;`
  )(AUDIO, 1e-4, 5000, () => peak, () => { calls.swap++; });

  // 有訊號：清掉死亡計時、不換源
  const healthy = { ending: false, deadSince: Date.now() - 9999, lastSignalAt: 0 };
  make(0.02, healthy)();
  assert.equal(healthy.deadSince, 0, "量到訊號要清掉死亡計時");
  assert.equal(calls.swap, 0, "有訊號不可換源");

  // 全零但未超時：只起跑計時
  const quiet = { ending: false, deadSince: 0, lastSignalAt: Date.now() };
  make(0, quiet)();
  assert.ok(quiet.deadSince > 0, "全零要開始計死亡時間");
  assert.equal(calls.swap, 0, "還沒超時不可換源");

  // 全零且超時：換源
  const dead = { ending: false, deadSince: Date.now() - 6000, lastSignalAt: 0 };
  make(0, dead)();
  assert.equal(calls.swap, 1, "持續全零超過門檻必須換訊號源——這正是殭屍音軌唯一會露餡的地方");
});

test("換源是無縫的：先接新源再拔舊源，recorder 與段號完全不動", async () => {
  const src = extractFns(app, ["attemptMicSwap"]);
  const order = [];
  const oldTrack = { readyState: "live", muted: false, stop() { order.push("old-stop"); } };
  const newTrack = liveTrack();
  const AUDIO = {
    ending: false, swapping: false, lastSwapAt: 0, deadSince: Date.now() - 6000,
    startedAt: Date.now() - 60000, segIndex: 1, entryId: 7,
    stream: { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] },
    micSource: { disconnect() { order.push("old-disconnect"); } },
    audioCtx: { createMediaStreamSource() { return { connect(t) { order.push("new-connect"); } }; } },
    analyser: {}, dest: {}, recorder: { state: "recording" }, lastSignalAt: 0,
  };
  AUDIO.micDeviceId = "dead-mic";
  const notes = [];
  const avoided = [];
  const run = swapRunner(src, AUDIO, {
    acquireLiveMic: async (avoid) => {
      avoided.push(avoid);
      return { stream: { getTracks: () => [newTrack], getAudioTracks: () => [newTrack] }, deviceId: "other-mic", peak: 0.05, silent: false };
    },
    noteAudioInterruption: async (id, line) => { notes.push(line); },
  });
  await run();

  assert.deepEqual(avoided, ["dead-mic"],
    "換源必須把剛死掉的裝置當作要避開的對象——換回同一條殭屍是 v118–v123 一路失敗的主因");
  assert.deepEqual(order.slice(0, 2), ["new-connect", "new-connect"],
    "新源要先接上（analyser＋dest 各一次），才能拔舊的——順序反了就有空隙");
  assert.ok(order.indexOf("old-disconnect") > order.lastIndexOf("new-connect"),
    "拔舊源必須在新源接上之後");
  assert.ok(order.includes("old-stop"), "舊 stream 的音軌要 stop() 釋放裝置");
  assert.equal(AUDIO.segIndex, 1, "換源不可換段——重建 recorder 正是之前掉音訊的元凶");
  assert.equal(AUDIO.deadSince, 0, "換完要清掉死亡計時");
  assert.equal(AUDIO.micDeviceId, "other-mic", "換完要記住新裝置，下次才知道該避開誰");
  assert.ok(notes.some((n) => n.includes("無訊號")), "換源要留下永久記錄");
});

/**
 * 🔬 2026-08-18（三）診斷埋點：換源「成功」不等於「換到的音軌真的有聲音」
 *
 * 查歷史錄音發現：8/14 版（已知良好基準）同一場錄音裡，一次背景中斷「已自動
 * 開新的一段接續」之後，後面 70 分鐘全部是 Whisper 對靜音的幻覺輸出。代表
 * 換源這個動作本身「成功」了（拿到新的 track 物件），但新音軌實際上一樣收不
 * 到聲音——這比較像作業系統層級把瀏覽器的錄音整個靜音掉，不是任何換源策略
 * 能在網頁端繞過的。
 *
 * 在真正修好這個之前，程式至少要老實記下「換源後量到的是不是仍然零」，
 * 不能讓「已自動更換收音來源」這句話看起來像問題解決了。
 */
test("換源後要老實回報新音軌是否真的收到訊號，不能讓「已更換」聽起來像已解決", async () => {
  const src = extractFns(app, ["attemptMicSwap"]);
  const oldTrack = { readyState: "live", muted: false, stop() {} };
  const newTrack = liveTrack();
  const notes = [];
  const status = [];
  const AUDIO = {
    ending: false, swapping: false, lastSwapAt: 0, deadSince: Date.now() - 6000,
    startedAt: Date.now() - 60000, segIndex: 1, entryId: 7, micDeviceId: "dead-mic",
    stream: { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] },
    micSource: { disconnect() {} },
    audioCtx: { createMediaStreamSource() { return { connect() {} }; } },
    analyser: {}, dest: {}, recorder: { state: "recording" }, lastSignalAt: 0,
  };
  const run = swapRunner(src, AUDIO, {
    // 每個裝置都試過了，全部量到零——8/14 版實測到的情境
    acquireLiveMic: async () => ({
      stream: { getTracks: () => [newTrack], getAudioTracks: () => [newTrack] },
      deviceId: "other-mic", peak: 0, silent: true,
    }),
    noteAudioInterruption: async (id, line) => { notes.push(line); },
    setAudioStatus: (line) => { status.push(line); },
  });
  await run();

  assert.ok(notes.some((n) => n.includes("每個收音裝置都試過") && n.includes("peak=0")),
    `所有裝置都是靜音時，記事必須明講，不能只說「已自動更換收音來源」讓人以為解決了。實際：${JSON.stringify(notes)}`);
  assert.ok(status.some((s) => s.includes("都是靜音")),
    `浮動列也要老實說現在收不到聲音。實際：${JSON.stringify(status)}`);
});

/**
 * 🎯 2026-08-19：v122／v123 換源做到無縫了、實測卻仍整段靜音，診斷埋點顯示
 * 「換源後立即量測 peak 依然是 0」。原因是舊的換源沒有指定 deviceId，拿回來的
 * 永遠是同一個系統預設裝置——Windows 的預設／communications 裝置被別的程式
 * 佔用或驅動卡住之後就固定吐數位零，再要一百次也還是那條殭屍。
 */
test("取麥克風要逐一驗收實體裝置，避開殭屍裝置且只採用真的量得到訊號的那條", async () => {
  const src = extractFns(app, ["micDeviceIdOf", "acquireLiveMic"]);
  const opened = [];
  const stopped = [];
  const mkStream = (id) => ({ id, getTracks: () => [{ stop() { stopped.push(id); } }], getAudioTracks: () => [{ getSettings: () => ({ deviceId: id }) }] });
  const run = new Function(
    "listMicDeviceIds", "openMicStream", "waitForTrackUsable", "probeStreamPeak",
    "stopStream", "AUDIO_MUTE_GRACE_MS", "AUDIO_SIGNAL_FLOOR",
    `${src}; return acquireLiveMic;`
  )(
    async () => ["default", "communications", "dead-mic", "good-mic"],
    async (deviceId) => { opened.push(deviceId); return mkStream(deviceId); },
    async () => true,
    // 只有 good-mic 收得到聲音，其餘都是殭屍
    async (stream) => (stream.id === "good-mic" ? 0.07 : 0),
    (s) => { try { s?.getTracks().forEach((t) => t.stop()); } catch {} },
    3000, 1e-4,
  );
  const picked = await run("dead-mic");

  assert.equal(picked.deviceId, "good-mic", "要採用真的量得到訊號的那個裝置");
  assert.equal(picked.silent, false);
  assert.deepEqual(opened, ["good-mic"],
    `實體裝置要最先試，量到訊號就停手。實際順序：${JSON.stringify(opened)}`);

  // 全部裝置都是殭屍：這時才看得到完整的候選順序
  opened.length = 0;
  const allDead = new Function(
    "listMicDeviceIds", "openMicStream", "waitForTrackUsable", "probeStreamPeak",
    "stopStream", "AUDIO_MUTE_GRACE_MS", "AUDIO_SIGNAL_FLOOR",
    `${src}; return acquireLiveMic;`
  )(
    async () => ["default", "communications", "dead-mic", "good-mic"],
    async (deviceId) => { opened.push(deviceId); return mkStream(deviceId); },
    async () => true,
    async () => 0,
    (s) => { try { s?.getTracks().forEach((t) => t.stop()); } catch {} },
    3000, 1e-4,
  );
  const nothing = await allDead("dead-mic");

  assert.equal(nothing.silent, true, "全部量到零就要老實回報 silent，不能假裝換源成功");
  assert.ok(!opened.includes("communications"),
    "Windows 的 communications 裝置是最常被 Teams／Line 搶走的那條，不該當候選");
  assert.deepEqual(opened, ["good-mic", "default", "dead-mic"],
    `候選順序：實體裝置 →「default」（會跟著系統預設跑）→ 剛死掉的那條排最後。實際：${JSON.stringify(opened)}`);
  assert.ok(stopped.length >= 2, "沒被採用的候選 stream 要關掉，不能佔著裝置");
});

test("開錄前先驗聲：量到全零時要當場擋下來，不是錄完 40 分鐘才發現是空的", () => {
  const fn = app.match(/async function startAudio\(entryId\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /acquireLiveMic\(/, "開錄要走會驗收訊號的取麥克風流程");
  assert.match(fn, /mic\.silent\s*&&\s*!confirm\(/,
    "驗出靜音時要先問使用者要不要照錄，不能默默錄一段空的");
  assert.match(fn, /micDeviceId: mic\.deviceId/, "要記住用的是哪個裝置，換源時才知道要避開誰");
});

test("換源失敗不是死路：維持現狀繼續錄，不宣告錄音報廢", async () => {
  const src = extractFns(app, ["attemptMicSwap"]);
  const oldTrack = { readyState: "live", muted: false, stop() { assert.fail("換不到新的就不可停舊音軌"); } };
  const status = [];
  const AUDIO = {
    ending: false, swapping: false, lastSwapAt: 0, deadSince: Date.now() - 6000,
    startedAt: Date.now() - 60000, segIndex: 2, entryId: 7,
    stream: { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] },
    micSource: { disconnect() { assert.fail("換不到新的就不可拔舊源"); } },
    audioCtx: {}, analyser: {}, dest: {}, lastSignalAt: 0,
  };
  const run = new Function(
    "AUDIO", "navigator", "document", "AUDIO_CONSTRAINTS", "AUDIO_RECOVERY_ATTEMPTS",
    "AUDIO_RECOVERY_RETRY_MS", "AUDIO_MUTE_GRACE_MS", "AUDIO_MIN_SWAP_INTERVAL_MS",
    "waitForTrackUsable", "watchAudioStream", "setAudioStatus", "noteAudioInterruption", "fmtSecs",
    `${src}; return attemptMicSwap;`
  )(
    AUDIO,
    { mediaDevices: { async getUserMedia() { const e = new Error("in use"); e.name = "NotReadableError"; throw e; } } },
    { hidden: false },
    { audio: {} }, 2, 0, 10, 15000,
    async () => true, () => {},
    (msg) => status.push(String(msg)),
    async () => {}, (n) => String(n),
  );
  await run();

  assert.equal(AUDIO.segIndex, 2, "失敗不可動段號");
  assert.ok(!status.some((m) => m.includes("請結束後重新錄音")),
    `不可出現「請結束後重新錄音」死路訊息（v119 的災難），實際：${JSON.stringify(status)}`);
  assert.ok(status.some((m) => m.includes("持續嘗試")), "要告知還在嘗試中");
});

test("回前景：recorder 還活著就不換段；recorder 死了在同一條 stream 上開新段（不重取麥克風）", async () => {
  const src = extractFns(app, ["resumeAudioOnForeground"]);
  const build = (AUDIO, calls) => new Function(
    "AUDIO", "document", "fmtSecs", "setAudioStatus", "noteAudioInterruption",
    "startAudioSegRecorder", "checkMicSignal", "navigator",
    `${src}; return resumeAudioOnForeground;`
  )(
    AUDIO, { hidden: false }, (n) => String(n), () => {},
    async (id, line) => { calls.notes.push(line); },
    () => { calls.startSeg++; },
    () => { calls.signalCheck++; },
    { mediaDevices: { async getUserMedia() { calls.getUserMedia++; return {}; } } },
  );

  // recorder 活著：不換段，但要做一次訊號檢查（殭屍是這裡抓的）
  const a = { ending: false, backgroundAt: Date.now() - 60000, backgroundSecs: 0, startedAt: Date.now() - 120000, segIndex: 1, entryId: 7, recorderFailed: false, recorder: { state: "recording" }, audioCtx: { state: "running", resume: async () => {} } };
  const ca = { startSeg: 0, getUserMedia: 0, signalCheck: 0, notes: [] };
  await build(a, ca)();
  assert.equal(ca.startSeg, 0, "recorder 活著不可換段");
  assert.equal(ca.getUserMedia, 0, "不可重取麥克風");
  assert.equal(ca.signalCheck, 1, "回前景要立刻量一次訊號");

  // recorder 死了：同一條 destination stream 開新段，一樣不重取麥克風
  const b = { ending: false, backgroundAt: Date.now() - 60000, backgroundSecs: 0, startedAt: Date.now() - 120000, segIndex: 1, entryId: 7, recorderFailed: false, recorder: { state: "inactive" }, audioCtx: { state: "running", resume: async () => {} } };
  const cb = { startSeg: 0, getUserMedia: 0, signalCheck: 0, notes: [] };
  await build(b, cb)();
  assert.equal(cb.startSeg, 1, "recorder 死了要開新段接續");
  assert.equal(b.segIndex, 2, "段號要前進");
  assert.equal(cb.getUserMedia, 0, "收音圖沒壞，開新段不需要重取麥克風");
  assert.ok(cb.notes.length === 1, "recorder 死亡要留永久記錄");
});
