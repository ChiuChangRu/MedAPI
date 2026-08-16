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

test("回前景的新麥克風音軌可先 muted、稍後 unmute，不可立即判定接續失敗", async () => {
  const start = app.indexOf("function waitForUsableAudioStream(stream");
  const end = app.indexOf("\n\nasync function acquireAudioRecoveryStream", start);
  assert.ok(start > -1 && end > start, "要有獨立的麥克風暖機等待函式");
  const source = app.slice(start, end);
  const waitForStream = new Function("AUDIO_RECOVERY_TRACK_TIMEOUT_MS",
    `${source}; return waitForUsableAudioStream;`)(100);

  class FakeTrack extends EventTarget {
    constructor() {
      super();
      this.readyState = "live";
      this.muted = true;
    }
    unmute() {
      this.muted = false;
      this.dispatchEvent(new Event("unmute"));
    }
  }
  const track = new FakeTrack();
  const waiting = waitForStream({ getAudioTracks: () => [track] }, 100);
  setTimeout(() => track.unmute(), 10);
  assert.equal(await waiting, true, "短暫 muted 後恢復的音軌應成功接續");
});

test("麥克風恢復會有限次重試，不因第一次暫時失敗就要求重錄", () => {
  const fn = app.match(/async function acquireAudioRecoveryStream[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /AUDIO_RECOVERY_ATTEMPTS/, "恢復流程必須有有限次重試");
  assert.match(fn, /await waitForUsableAudioStream\(stream\)/,
    "新 stream 建立後要等待音軌真正可用");
  assert.match(fn, /AUDIO_RECOVERY_RETRY_MS \* attempt/,
    "重試間要留給瀏覽器與作業系統恢復裝置的時間");
  assert.match(app, /const recoveryError = \[err\?\.name, err\?\.message\]/,
    "最後仍失敗時要永久留下瀏覽器錯誤種類，不能只顯示無法接續");
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
test("恢復到一半頁面又切走，只能延後重試，不可宣告錄音無法接續", () => {
  const acquire = app.match(/async function acquireAudioRecoveryStream[\s\S]*?\n\}/)?.[0] || "";
  assert.match(acquire, /throw audioRecoveryDeferred\(\)/,
    "頁面切到背景要丟可延後的錯誤，不能跟真正的裝置失敗混為一談");

  const helper = app.match(/function audioRecoveryDeferred\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(helper, /err\.deferred = true/, "可延後的錯誤要有明確標記供呼叫端判斷");

  const resume = app.match(/async function resumeAudioOnForeground\(\)[\s\S]*?\n\}\n/)?.[0] || "";
  const deferredBranch = resume.indexOf("err?.deferred");
  const fatalMessage = resume.indexOf("錄音無法自動接續");
  assert.ok(deferredBranch > -1, "catch 要先辨認出可延後的錯誤");
  assert.ok(fatalMessage > -1 && deferredBranch < fatalMessage,
    "可延後的分支必須擋在「無法自動接續」的永久失敗訊息之前");

  const branch = resume.slice(deferredBranch, fatalMessage);
  assert.match(branch, /AUDIO\.trackInterrupted = true/,
    "延後時要保留中斷標記，下次回到前景才會再試一次");
  assert.doesNotMatch(branch, /stopAudio|stopAnyActiveCapture/,
    "延後重試不可順手把還在錄的 recorder 收掉");
});

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
