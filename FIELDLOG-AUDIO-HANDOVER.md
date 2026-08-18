# 隨身記（fieldlog）背景錄音問題 — 交接文件

**寫給接手的開發者（Codex）**
**日期**：2026-08-18
**狀態**：⛔ **未解決**。Claude Code 於 8/15–8/18 嘗試四次修正，全部失敗。
**線上版本**：v121（`codex/kiwi-integration` → 已部署）

---

## 0. 先講結論

**這個問題我沒修好，四次都沒有。** 使用者最後放棄並要求轉交。

我在 §4 誠實列出每一次改了什麼、為什麼當時認為有理、實測結果如何。
在 §6 提出我認為 Codex 應該優先做的事——**其中第一件不是改程式碼，是先取得真實裝置的行為數據**，
因為這四次失敗有一個共同點：**沒有任何一次是根據實際觀測到的瀏覽器行為做的判斷，全部是推論。**

---

## 1. 系統與部署（先搞清楚這個，不然改了不會上線）

| 項目 | 內容 |
|---|---|
| 應用 | 隨身記 fieldlog（Cloudflare Worker + D1 + R2） |
| 主要程式 | `fieldlog/public/app.js`（前端，約 4500 行，無框架無建置） |
| 後端 | `fieldlog/src/worker.js` |
| 線上網址 | `https://fieldlog.gogoyankee.workers.dev` |

### ⚠️ 部署分支很反直覺

```
.github/workflows/deploy-fieldlog.yml   →  只在 codex/kiwi-integration 觸發
.github/workflows/deploy.yml            →  只在 main 觸發，且 paths 限 cloudflare/**
```

**合併 fieldlog 的改動到 `main` 不會部署任何東西。**
要上線必須進 `codex/kiwi-integration`。

我在 8/18 一度誤開了一支從 `main` 長出來的 PR 要合進 `codex/kiwi-integration`，
diff 有 35 個檔案（整個 cloudflare 展商系統都會被灌進去）。**已關閉（PR #61）**，
改用只 cherry-pick 單顆 commit 的乾淨分支。接手時請注意同樣的陷阱。

### 版本號要四處同步（有測試把關）

```
fieldlog/public/app.js     const APP_VERSION = "121"
fieldlog/src/worker.js     const UI_VERSION  = "121"
fieldlog/public/sw.js      const CACHE = "fieldlog-v121-..."  + ASSETS 裡的 ?v=121
fieldlog/public/index.html ?v=121（4 處）
```

漏掉任何一處，使用者的 service worker 會繼續餵舊檔，看起來就像「改了沒效」。

---

## 2. 問題描述（使用者原話）

> 「背景錄音一直修不好，使用 codex 可背景錄音，**8/14 使用上就很順**，切換頁面都可以銜接，
> 後來 codex token 不夠轉交 Claude Code 就被改壞，改了再改也沒修好」

> 「當然是切換電腦的頁面 chrome 或切換別的 app 都不行」

**使用環境**：桌機 Windows Chrome，切換分頁或切換到別的 App。

**時間分界（使用者確認）**：
- 8/13 版：不行
- **8/14 版：可以正常背景錄音** ← 已知良好基準
- 8/15 之後：壞掉

---

## 3. 最有價值的一筆數據（使用者 8/18 實測 v120）

使用者停止錄音後，一段 **3 分 34 秒（214 秒）** 的錄音被切成 6 段：

| 段 | 起點 | 長度 | 覆蓋到 | 與前段的空隙 |
|---|---|---|---|---|
| 1 | 00:00 | 0:00 | 00:00 | — |
| 2 | 00:07 | 0:29 | 00:36 | 7 秒 |
| 3 | 00:38 | 0:10 | 00:48 | 2 秒 |
| 4 | 00:49 | 0:15 | 01:04 | 1 秒 |
| 5 | 01:08 | 0:51 | 01:59 | 4 秒 |
| 6 | 03:32 | 0:02 | 03:34 | 93 秒 |

**總跨度 214 秒，實際只錄到 107 秒 — 一半的音訊掉在換段的空隙裡。**
而且六段全部顯示「已整理（無語音內容）」。

### 從這筆數據可以確定的事

1. **「換段／重建 stream」這個動作本身正在破壞錄音。** 每次換段都掉幾秒。
2. 中斷偵測觸發得太頻繁（3 分半觸發 5 次）。
3. 第 6 段前有 93 秒的空白，代表有一次長時間完全沒有任何 recorder 在收音。

### ⚠️ 尚未釐清的事（重要）

「無語音內容」是 Whisper 轉錄的結果。**我沒有辦法確認這是「真的錄到靜音」還是
「使用者測試時本來就沒說話」。** 這一點會大幅影響診斷方向，請優先釐清（見 §6.1）。

---

## 4. 四次修正嘗試的完整記錄

### 背景：8/15 之前的狀態

8/13 有四個 PR（#49–#52）連續修背景錄音，最後一顆 `834fa47` 在 8/13 22:42 合併。
使用者 8/14 測試 → 可用。**所以 8/14 的行為 ≒ 8/13 那批修正的結果。**

8/14 之後到 8/18 之前，有四顆 commit 動到錄音：

| commit | 日期 | 說明 |
|---|---|---|
| `71c8b79` | 08-16 | keep fieldlog audio alive across pagehide |
| `a86d212` | 08-16 | retry microphone recovery after backgrounding |
| `3577a98` | 08-16 | 恢復到一半頁面又切走只延後重試 |
| `f6a27c0` | 08-16 | 舊音軌也要給暖機緩衝 |
| `daa8a4f` | 08-17 | 過濾 Whisper 對靜音的幻覺輸出 |

`resumeAudioOnForeground` 從 8/14 的 97 行膨脹到 8/17 的約 180 行。

---

### 嘗試 #1 — v119「還原成 8/14 版」（失敗）

**我當時的判斷**：`f6a27c0` 加了這段：

```js
if (await probeAudioRecorderData(AUDIO.recorder)) {
  AUDIO.trackInterrupted = false;
  setAudioStatus("✓ 麥克風短暫中斷後已自行恢復，錄音持續中");
  return;              // ← 不重取麥克風、不換段
}
```

它用「recorder 交不交得出資料」當作「麥克風還活著」的證據。
我判斷這個判準無效：**音軌被系統靜音時，編碼器照樣吐出「編碼過的靜音」，size 一樣大於 0**，
所以會產生假陽性——畫面顯示綠色的「已自行恢復」，實際錄到靜音。
`daa8a4f`（過濾 Whisper 靜音幻覺）看起來就是在擦這個 bug 的屁股。

**做法**：把 `resumeAudioOnForeground` 逐字還原成 8/14 版，刪掉
`waitForUsableAudioStream` / `acquireAudioRecoveryStream` / `audioRecoveryDeferred`。

**實測結果**：❌ **更糟**。使用者收到連續三次
「⛔ 錄音無法自動接續，請結束後重新錄音」（00:20 / 00:31 / 00:36）。

**這次錯在哪**：我假設「回到已知良好的時間點」就會恢復良好行為。
但 8/14 的程式碼在使用者當時的環境剛好沒踩到坑，不代表它本身是對的。
**還原不等於修正。**

---

### 嘗試 #2 — v120「先釋放舊裝置＋重試」（失敗）

**我當時的判斷**：v119 判定中斷後只呼叫一次 `getUserMedia`，
而且**從沒 `stop()` 過舊 stream 的音軌**。部分 Windows 音效裝置是獨佔的，
舊音軌即使已 mute/ended，沒被明確 stop 就會讓系統認為裝置還被佔用，
導致重取立刻失敗；失敗後舊 stream 依然沒釋放，下次再撞同樣的牆 → 連續失敗迴圈。

**做法**：判定中斷後先 `stop()` 舊音軌，再帶 3 次重試去 `getUserMedia`。

**實測結果**：❌ 「無法自動接續」的訊息消失了，改成連續顯示
「⚠️ 已從第 2 / 3 / 5 段接續」——看起來像成功，
但停止錄音後就是 §3 那張表：**被剁成 6 段、掉了一半音訊**。

**這次錯在哪**：我修好了「接不上」，卻讓「接得太頻繁」浮現。
更關鍵的是——**無條件先 stop 舊音軌再重取，必然製造空隙**。
我為了解決獨佔裝置問題，主動製造了資料遺失。

---

### 嘗試 #3 — v121「預設不換段」（失敗，目前線上版本）

**我當時的判斷**（基於 §3 的數據，這是我唯一一次有實測數據支撐的判斷）：
方向從頭就錯了。桌機 Chrome 切分頁時錄音其實照常進行，
是程式每次回前景都判定中斷、拆掉重建，**重建的空窗才是掉掉的音訊**。

**做法**：把原則反過來——預設什麼都不做。

- 新增 `audioStillAlive()`：只有「音軌全部 `ended`」或「recorder 不在 `recording`」才算真的死了
- `track.muted` 不算死亡，先給 `AUDIO_MUTE_GRACE_MS`（3 秒）等它自行恢復
- `watchAudioStream` 收到 `mute` 不再立刻重建，改成排一次緩衝後的重新檢查
- 新增換段節流 `AUDIO_MIN_ROTATE_INTERVAL_MS`（20 秒）
- 重建改成「先重取、失敗才放掉舊裝置」，避免主動製造空隙
- 重取後等音軌真的可用才開始錄（等於還原 8/16 的 `waitForUsableAudioStream`，
  我在 v119 把它一起刪掉是矯枉過正）

**實測結果**：❌ 使用者回報「失敗」（未提供進一步細節）。

**這次可能錯在哪**（推測，未驗證）：
- 3 秒的 mute 緩衝可能不夠，或 Chrome 根本不是走 mute 這條路
- 可能問題根本不在 `resumeAudioOnForeground`，而在別處（見 §5）
- `AUDIO_MIN_ROTATE_INTERVAL_MS` 節流時只顯示警告不換段，
  若此時 recorder 真的死了，**那 20 秒就是完全沒錄到**

---

### 嘗試 #4 — 測試策略的修正（這部分是有效的，建議保留）

**發現**：8/15–8/17 那四次修正，每次都有測試護著、全綠，但實際越修越壞。
原因是那些測試比對的是**原始碼裡有沒有某段字串**，不是**錄音有沒有真的收到聲音**：

```js
// 舊測試長這樣 —— 這種測試永遠不會抓到行為錯誤
assert.match(resume, /const oldTracksUsable = oldRecorder\?\.state === "recording"/);
```

**做法**：改用 `new Function()` 把 `resumeAudioOnForeground` 抽出來、注入假的
`navigator` / `document` / `AUDIO`，**實際跑一遍**再斷言行為。
並且每次都驗證「新測試在壞掉的版本上會失敗」，否則測試本身也是假的。

目前 `tests/fieldlog-audio-recording.test.js` 有 4 個這種行為測試：

| 測試 | 驗證內容 |
|---|---|
| 桌機切分頁回來、錄音還活著 | 不換段、不重取麥克風 |
| 音軌短暫 muted 後自行 unmute | 不換段 |
| 音軌真的 ended | 才重取並開新的一段 |
| 短時間內反覆中斷 | 節流擋下，段號不前進 |

**建議 Codex 保留這個測試風格。** 但也要知道它的極限：
這些測試驗證的是「程式碼在我假設的情境下行為正確」，
**不能證明我假設的情境就是真實裝置的行為**——這正是四次都失敗的根本原因。

---

## 5. 目前程式碼現況（v121）

### 相關函式位置（`fieldlog/public/app.js`）

| 函式 | 作用 |
|---|---|
| `startAudio(entryId)` | 開始錄音，建立 `AUDIO` 狀態物件 |
| `startAudioSegRecorder()` | 建立一個 `MediaRecorder`，`start(AUDIO_DATA_SLICE_MS)` |
| `rotateAudioSegment()` | **正常的**10 分鐘換段（重疊 800ms，不是問題所在） |
| `watchAudioStream(stream)` | 監聽 track 的 `mute` / `ended` |
| `waitForTrackUsable(stream, ms)` | 等音軌變成 live 且非 muted |
| `audioStillAlive()` | 判斷錄音是否還活著 |
| `resumeAudioOnForeground()` | 回前景時的入口（目前 25 行） |
| `rebuildAudioAfterInterruption()` | 確定斷了才走這裡，重取麥克風＋開新段 |
| `onPageHidden()` / `onPageHide()` | 頁面隱藏處理 |
| `stopAudio()` / `finalizeAudioStop()` | 收尾 |

### 相關常數

```js
const SEG_MINUTES = 10;
const AUDIO_LIVE_SEG_SECONDS = SEG_MINUTES * 60;   // 正常換段間隔
const AUDIO_DATA_SLICE_MS = 5000;                  // MediaRecorder timeslice
const AUDIO_SEG_OVERLAP_MS = 800;                  // 換段重疊
const AUDIO_RECOVERY_ATTEMPTS = 3;                 // 重取麥克風重試次數
const AUDIO_RECOVERY_RETRY_MS = 600;               // 重試退避基數
const AUDIO_MUTE_GRACE_MS = 3000;                  // muted 自行恢復緩衝
const AUDIO_MIN_ROTATE_INTERVAL_MS = 20000;        // 換段節流
```

### 事件註冊（`init()` 內）

```js
document.addEventListener("visibilitychange", () => {
  if (document.hidden) onPageHidden();
  else resumeAudioOnForeground();
});
window.addEventListener("pageshow", resumeAudioOnForeground);
document.addEventListener("resume", resumeAudioOnForeground);
document.addEventListener("freeze", onPageHidden);
window.addEventListener("beforeunload", guardRecordingNavigation);
window.addEventListener("pagehide", onPageHide);
```

### ⚠️ 一項與 8/14 不同、我刻意沒有還原的地方

```js
// 8/14（使用者說可用的版本）
function onPageHide(event) {
  if (event.persisted) { onPageHidden(); return; }
  stopAnyActiveCapture();      // ← 非 bfcache 的 pagehide 會直接收掉錄音
}

// v121（目前）
function onPageHide(event) {
  onPageHidden();              // ← 從不主動停止
}
```

我當時判斷「還原它反而可能讓切 App 時錄音中止」，所以保留了 8/16 的版本。
**這是一個未經驗證的判斷，而且它剛好落在使用者說的分界線上。**
如果 Codex 要做「精確二分」，這是必須納入的變因之一。

---

## 6. 給 Codex 的建議（依優先順序）

### 6.1 【最高優先】先取得真實裝置的行為數據，不要先改程式碼

**四次失敗的共同點：全部是推論，沒有一次基於實際觀測。**
我在容器裡用 Playwright + 假音訊裝置測過，只能確認一件事：

```
track.stop() 之後 → readyState=ended，但 recorder.state 仍然是 "recording"
```

假裝置無法重現真實 Windows 音效卡在切分頁 / 切 App 時的行為。

**建議做法**：加一個臨時的診斷模式（可用 URL 參數或設定開關打開），
在錄音期間把下列事件連同時間戳直接寫進記事內文，讓使用者實測一次就能把真實數據帶回來：

- `visibilitychange`（含 `document.hidden`）
- `pagehide`（含 `event.persisted`）、`freeze`、`resume`、`pageshow`
- 每個 audio track 的 `mute` / `unmute` / `ended`
- 每次 `dataavailable` 的 `size`（能直接判斷是否真的收到音訊）
- 每次進入 `resumeAudioOnForeground` 時的 `recorder.state`、
  `track.readyState`、`track.muted`
- 每次 `audioStillAlive()` 的判定結果與依據
- 每次呼叫 `getUserMedia` 的時間、耗時、成功或錯誤 name

**有了這份 log，才能知道 Chrome 在使用者的機器上到底走哪條路。**
在那之前的任何修改都是繼續猜。

### 6.2 釐清「無語音內容」的真正含義

§3 那六段全部顯示「已整理（無語音內容）」。請先確認：
- 使用者測試時有沒有實際說話？
- 若有說話，可以直接下載那幾個音檔確認是否為靜音（R2 上有原始檔）。

**若音檔實際有聲音**，那問題只是「被切太多段」，嚴重度低很多，
而且 §6.4 的合併方案可以直接繞過。
**若音檔真的是靜音**，那 `getUserMedia` 重取後拿到的是一條不會產出聲音的音軌，
方向要往「重取到的裝置是哪一個」查（可能重取到了錯誤的預設裝置）。

**這一題會決定整個修法方向，值得優先花時間。**

### 6.3 考慮「根本不要處理背景中斷」這個選項

桌機 Chrome 對正在擷取音訊的分頁是不做節流的，MediaRecorder 通常會持續運作。
**有可能最正確的行為就是：`visibilitychange` 完全不做任何事。**

我在 v121 已經往這個方向走了一半（預設不換段），但仍保留了偵測與重建路徑。
可以考慮做一個實驗版本：**把 `resumeAudioOnForeground` 整個拿掉**，
只留 10 分鐘的正常換段，讓使用者實測。
如果這樣就正常，那所有的「中斷恢復」機制都是在解決一個桌機上不存在的問題
（那些機制原本是為 iOS 寫的）。

**必要時把桌機與行動裝置分開處理**，不要用同一套邏輯。

### 6.4 不論如何都該做的：停止後自動合併分段

即使中斷偵測完全修好，使用者的核心訴求是
**「被分成很多段！這不是我要的」**。

建議在 `stopAudio()` / `finalizeAudioStop()` 收尾時，
把同一次錄音的多個分段在後端合併成單一音檔（或至少在 UI 上呈現為一筆、
播放時連續播放）。這樣即使偶爾發生換段，使用者體感仍是一段完整錄音。

**這件事跟中斷偵測正不正確是獨立的，可以先做，風險低、效益直接。**

### 6.5 若要做精確二分（bisect）

已知：8/13 不行、8/14 可以。8/13 的四顆 commit 都在 21:44–22:42 之間：

```
7903ffe 08-13 21:44  fix: recover fieldlog audio after backgrounding
a45ac30 08-13 21:54  fix: recover fieldlog audio after backgrounding
4d1de39 08-13 22:12  fix: verify desktop audio flow after backgrounding
834fa47 08-13 22:42  fix: unify recording bundles in folders
```

8/14 良好版的完整樹：`076ff72`

可以直接把 `076ff72` 的 `fieldlog/public/app.js` 整份部署上去讓使用者實測，
**先確認「8/14 可用」這件事在今天的環境下仍然成立**。
如果連它都不行，那表示變因不在程式碼（可能是 Chrome 版本更新、
Windows 音訊驅動、或使用者的操作方式改變），整個調查方向要重來。

**這一步我沒有做，是我的疏漏 —— 我一直假設使用者的記憶是可靠的基準，
但從來沒有實際驗證過。建議 Codex 第一步就做這個。**

---

## 7. 其他已知問題（同一套系統，未處理）

使用者在 8/18 同時反映了另外兩件事，我診斷了但**沒有修**：

### 7.1 MyWiki 搜尋「是假的」

- `fieldlog/src/worker.js` 的 `/search` 路由**沒有任何全文索引**
  （schema 只有 8 個 btree 索引，沒有 FTS5）
- 做法是把最新 5000 筆記事＋5000 筆附件（`SEARCH_SCAN_CAP = 5000`）
  **含整份逐字稿與 OCR 文字**全部撈進 Worker，再用 JS 逐筆比對
- 後果：更舊的資料搜不到、資料越多越慢、量大時整支請求可能超時

### 7.2 搜尋時「整個內容都不見」

`fieldlog/public/app.js` 的 `initHomeSearch()`：

```js
const setActive = (active) => {
  resultsBox.hidden = !active;
  mainSections.hidden = active;   // ← 只要搜尋框有字就把整個首頁藏起來
  clearBtn.hidden = !input.value;
};
```

唯一還原的方式是把搜尋框清空。搜尋一失敗，畫面就只剩一行紅字配空白頁。
**這個修起來很便宜**，建議順手處理。

### 7.3 `npm test` 有 77 個既有失敗 — 但不是系統壞掉

這 77 筆看起來嚇人，實際上是**測試用的假資料庫過期**，不是產品故障：

```
假資料庫比對： "SELECT * FROM entries WHERE id = ?"
worker 實際送出："SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''"
```

假資料庫（`tests/` 裡多個檔案的 `makeDB`）是用**字串完全相等**比對 SQL 的。
8/14 加垃圾桶功能時所有查詢都多了軟刪除條件，假資料庫沒跟著更新，
就一律回空 → 路由回 404 → 測試紅。

我抽驗了兩個檔案確認是這個模式，**沒有逐一驗證全部 77 筆**。

---

## 8. 相關 PR 與 commit 索引

| PR | 目標分支 | 內容 | 狀態 |
|---|---|---|---|
| #61 | codex/kiwi-integration | v119（分支基底錯誤，35 檔案） | **已關閉，勿合併** |
| #62 | main | v119 | 已合併 |
| #63 | codex/kiwi-integration | v119（乾淨版） | 已合併並部署 |
| #64 | codex/kiwi-integration | v120 | 已合併並部署 |
| #65 | main | v120 | 已合併 |
| #66 | codex/kiwi-integration | v121 | 已合併並部署 |
| #67 | main | v121 | 已合併 |

| commit | 版本 | 內容 |
|---|---|---|
| `076ff72` | — | **8/14 良好基準版**（使用者確認可用） |
| `daa8a4f` | v118 | 壞掉的狀態（Claude 接手前） |
| `a407923` | v119 | 嘗試 #1 還原 |
| `df05ff9` | v120 | 嘗試 #2 釋放裝置＋重試 |
| `57dd6e5` | v121 | 嘗試 #3 預設不換段（目前線上） |

`fieldlog-audio-fix-clean` 是我用來 cherry-pick 到 `codex/kiwi-integration` 的分支。

---

## 9. 最後

這份文件的重點不是「我做了什麼」，而是**「哪些路已經走過而且走不通」**，
希望能省下接手者的時間。

我最大的失誤是：**在沒有真實裝置行為數據的情況下改了四次**。
每一次的推理在紙上都成立，但沒有一次被實際驗證過，
結果就是修好一個症狀、冒出另一個症狀。

**建議 Codex 的第一步不要改任何邏輯**，先做 §6.1 的診斷模式與 §6.5 的基準驗證。
