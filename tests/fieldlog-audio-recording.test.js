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

test("桌機回前台要用非空 dataavailable 驗證錄音資料流，不再一律誤報可能缺口", () => {
  assert.match(app, /const AUDIO_FLOW_PROBE_TIMEOUT_MS = 2000;/,
    "資料流探測要有逾時，不能讓回前台流程永久卡住");
  assert.match(app, /function probeAudioRecorderData\(recorder\)/,
    "要有獨立的 recorder 資料流探測函式");
  assert.match(app, /addEventListener\("dataavailable", onData\)/,
    "探測要等待 recorder 實際交出資料");
  assert.match(app, /event\.data\?\.size/,
    "空事件不能被誤判成仍有錄到音訊資料");
  assert.match(app, /recorder\.requestData\(\)/,
    "回前台要主動要求交出目前累積資料，不必等下一個 timeslice");
  const resume = app.match(/async function resumeAudioOnForeground[\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(resume, /await probeAudioRecorderData\(probedRecorder\)/,
    "track 與 state 正常時仍要用資料塊驗證，不可只看表面狀態");
  assert.match(resume, /背景 .* 錄音持續；已收到音訊資料/,
    "探測成功要明確顯示仍在錄，不能再用故障語氣誤導使用者");
  assert.doesNotMatch(app, /系統無法保證此段完整/,
    "健康的桌機切分頁不可再一律顯示可能缺口");
});

test("probeAudioRecorderData：收到非空資料回 true，inactive recorder 直接回 false", async () => {
  const start = app.indexOf("function probeAudioRecorderData(recorder)");
  const end = app.indexOf("\n\n// 行動瀏覽器可能只把麥克風 track", start);
  assert.ok(start > -1 && end > start, "要能取出完整的資料流探測函式");
  const source = app.slice(start, end);
  const probe = new Function("AUDIO_FLOW_PROBE_TIMEOUT_MS", `${source}; return probeAudioRecorderData;`)(20);

  class FakeRecorder extends EventTarget {
    constructor(state, bytes = 0) {
      super();
      this.state = state;
      this.bytes = bytes;
    }
    requestData() {
      queueMicrotask(() => {
        const event = new Event("dataavailable");
        Object.defineProperty(event, "data", { value: { size: this.bytes } });
        this.dispatchEvent(event);
      });
    }
  }

  assert.equal(await probe(new FakeRecorder("recording", 128)), true,
    "桌機 recorder 能交出資料時必須判定錄音仍在流動");
  assert.equal(await probe(new FakeRecorder("inactive", 128)), false,
    "已停止的 recorder 不可被資料探測誤判成健康");
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

// 2026-08-16 v115 實測回報：改成延後重試後，錯誤換成「⛔ 錄音無法自動接續
// （Error：麥克風音軌喚醒逾時）」。原因是 v114 只替「新取得的音軌」留了暖機
// 緩衝（waitForUsableAudioStream），舊音軌卻還是用 !track.muted 瞬間判斷——
// 同一件事只修了一半。觸發恢復的往往就是那一次短暫 muted，舊音軌在那個瞬間
// 當然也是 muted，於是還能繼續錄的 recorder 被判成報廢。

/**
 * ⛔ 2026-08-18 迴歸測試：背景錄音「看起來好、實際錄到靜音」
 *
 * 8/14 版可以正常背景錄音；8/15–8/17 疊了四層「恢復保護」之後就壞了，而且
 * 四層都有測試護著、全綠——因為那些測試比對的是原始碼字串，不是行為。
 *
 * 真正的缺陷：判定「麥克風其實還活著」用的是 recorder.requestData() 有沒有
 * 交出資料。這個判準無效——音軌被系統靜音時，編碼器照樣吐出「編碼過的靜音」，
 * size 一樣大於 0。於是明明已經有中斷跡證（track mute／ended／recorder 失效），
 * 卻被這個假陽性推翻，直接 return、不換段、不重取麥克風，畫面還顯示
 * 「✓ 已自行恢復，錄音持續中」，實際錄下來整段是靜音。
 *
 * 所以這裡測的是行為不是字串：餵一個「有中斷跡證、但 recorder 仍宣稱 recording
 * 且交得出資料」的情境進去，要求它照樣重取麥克風並開新的一段。
 */
test("有中斷跡證時，不可因為 recorder 還交得出資料就宣告已恢復（靜音也是資料）", async () => {
  const source = app.match(/async function resumeAudioOnForeground\(\)[\s\S]*?\n\}\n/)?.[0];
  assert.ok(source, "找不到 resumeAudioOnForeground");

  const calls = { getUserMedia: 0, startSeg: 0, status: [] };
  const liveTrack = () => ({ readyState: "live", muted: false, stop() {}, addEventListener() {} });
  const AUDIO = {
    ending: false, resuming: false, backgroundAt: Date.now() - 30_000, backgroundSecs: 0,
    startedAt: Date.now() - 60_000, segIndex: 1, entryId: 7,
    // 中斷跡證：音軌曾經 mute 過
    trackInterrupted: true, trackInterruptedAt: Date.now() - 30_000, recorderFailed: false,
    // 但 recorder 仍宣稱在錄，而且 requestData 交得出（靜音）資料
    recorder: { state: "recording", stop() {} },
    stream: { getAudioTracks: () => [liveTrack()] },
  };

  const run = new Function(
    "AUDIO", "navigator", "document", "fmtSecs", "setAudioStatus", "showToast",
    "noteAudioInterruption", "probeAudioRecorderData", "watchAudioStream",
    // 壞掉的版本才會用到這兩個；一併注入，讓測試是因為「行為不同」而失敗，
    // 不是因為「少一個相依」而失敗。
    "waitForUsableAudioStream", "acquireAudioRecoveryStream",
    "startAudioSegRecorder", "AUDIO_SEG_OVERLAP_MS", "setTimeout",
    `${source}; return resumeAudioOnForeground;`
  )(
    AUDIO,
    { mediaDevices: { async getUserMedia() {
        calls.getUserMedia++;
        return { getAudioTracks: () => [liveTrack()], getTracks: () => [liveTrack()] };
      } } },
    { hidden: false },
    (s) => String(s),
    (msg) => calls.status.push(String(msg)),
    () => {},
    async () => {},
    async () => true,           // ← recorder 交得出資料（實際是靜音）
    () => {},
    async () => true,           // waitForUsableAudioStream：音軌回前景後已 unmute
    async () => ({ getAudioTracks: () => [liveTrack()], getTracks: () => [liveTrack()] }),
    () => { calls.startSeg++; },
    0,
    (fn) => fn(),
  );

  await run();

  assert.equal(calls.getUserMedia, 1,
    "有中斷跡證就必須重取麥克風——舊音軌交得出資料不代表它錄得到聲音（靜音也是資料）");
  assert.equal(calls.startSeg, 1, "重取麥克風後要開新的一段接續");
  assert.equal(AUDIO.segIndex, 2, "段號要往前推，讓事後看得出這裡接過");
  assert.ok(calls.status.some((s) => s.includes("接續")),
    `狀態列要說明曾中斷並已接續，不能顯示「已自行恢復」，實際收到：${JSON.stringify(calls.status)}`);
});
