# Bug 清單（2026-08-07 盤點）

對應 2026-08-07 的七點回報。第 (1) 點「列出 bug 清單」就是這份文件；
第 (2)–(7) 點的內容混在下面各條裡——回報時說的「希望可以…」，追下去大多不是
缺功能，而是**原本就壞掉的地方**（例如「貼 MD 存檔後格式跑掉」不是編輯器沒做，
是存檔時被清理函式吃掉了）。

驗收方式：`npm install && npm run validate`（318 個測試）。
新測試在 `tests/fieldlog-ui-requests-2026-08-07.test.js`、
`tests/fieldlog-staging-autofile.test.js`、`tests/fieldlog-richtext.test.js`。

---

## A. 這次修掉的（全部已上這個分支）

### A1. 貼進來的 Markdown 一存檔，標題／程式碼／分隔線整個消失〔對應 (3)〕

- **在哪**：`fieldlog/src/lib/richtext.js` 的 `sanitizeEntryHtml()`
- **為什麼**：白名單 `ALLOWED_TAGS` 只有 `p/br/strong/em/u/s/b/i/ul/ol/li/blockquote/a/img/span`，
  沒有 `h1`–`h6`、`pre`、`code`、`hr`。存檔時這些標籤被整個拿掉（文字留著），
  所以「畫面上明明是標題，存完變成一句普通句子」。
- **怎麼修**：白名單補上這些標籤；`htmlToPlainText()` 也補上標題／`pre`／`hr`
  的換行，否則匯出給 AI 的 Markdown 會整段黏在一起。

### A2. 項目符號清單存檔後變成編號清單〔對應 (3)〕

- **在哪**：同上
- **為什麼**：Quill 2 的項目符號清單也是 `<ol>`，靠 `<li data-list="bullet">` 區分。
  `data-list` 不在允許屬性裡，一被剝掉，重新開啟整串就變成 1. 2. 3.。
- **怎麼修**：允許 `li` 的 `data-list`（值限定 Quill 的四種），
  並允許 `ql-*` 開頭的 `class`（縮排 `ql-indent-N`、對齊 `ql-align-*`）。
  `style` 屬性維持一律不收——它能直接畫東西，沒有理由開放。

### A3. 編輯器沒有標題，也沒有畫重點的工具〔對應 (3)(7)〕

- **在哪**：`fieldlog/public/richtext-editor.js` 的 `TOOLBAR`
- **為什麼**：工具列只有粗體／斜體／底線／刪除線／清單／引言／連結。
- **怎麼修**：補上標題層級（H1–H3）、程式碼區塊，以及 **🖍 蠟筆**（黃綠藍粉橘五色）。
  蠟筆刻意存成 `class="ql-bg-yellow"` 而不是 Quill 預設的行內 `style` —— A2 說過
  `style` 一律會被清掉，用行內樣式的話蠟筆一存檔就消失。
  顏色 CSS 寫在 `style.css` 並多墊一層 class 提高特異度：`index.html` 是先載
  `style.css` 再載 `quill.snow.css`，同分特異度會被 Quill 的預設色蓋掉。

### A4. 貼上的 Markdown 只會變成一行行純文字〔對應 (3)〕

- **在哪**：同上
- **為什麼**：Quill 對純文字貼上就是照字面放，`## 標題` 就是一行 `## 標題`。
- **怎麼修**：新增 `mdToHtml()`，在**捕獲階段**攔截 paste（一定要早於 Quill 建構時
  掛上的冒泡監聽，否則 Quill 會先把它貼成純文字），把 Markdown 轉成 HTML 再交給
  Quill。只輸出白名單內的標籤，所以「貼進來看到什麼，存檔後就是什麼」。
  表格轉成 `<pre>` 保留原本的對齊——Quill 沒有表格格式，硬轉表格標籤反而會被拆散。

### A5. 資料夾裡的檔案永遠照檔名排，新加的沉在中間〔對應 (4)〕

- **在哪**：`fieldlog/public/app.js` 的 `openFolder()`
- **為什麼**：檔案清單寫死 `localeCompare(filename)`。
- **怎麼修**：預設改成**新到舊**（建立時間，同秒用 attachment id 當第二鍵，順序才穩定）；
  資料夾工具列多一顆 `🆕 新到舊 / 🔤 檔名排序` 切換鈕，選擇記在 localStorage
  ——依標準編號連號瀏覽仍然是有用的，不該直接拿掉。

### A6. AI 的背景資訊全部攤開，把正文擠出畫面〔對應 (5)〕

- **在哪**：`app.js` 的 `openEntry()` 與 `loadProvenance()`
- **為什麼**：「這筆資料的來歷」「AI 對這筆做過什麼」「操作履歷」「合併逐字稿」
  都是直接展開的區塊。附件一多、處理過幾輪之後可以長到幾十行。
- **怎麼修**：四段全部改成預設收合的 `<details>`，摘要那一行先講結論（幾項、幾筆、幾字）。
  順帶修掉一個浪費：履歷 API 現在等到真的展開才打，收著的區塊不會先花一趟往返。

### A7. 檔案只搬得到「目前資料夾底下的子資料夾」〔對應 (2)〕

- **在哪**：`app.js` 的 `bindFolderDropTargets()`（只把 `.child-folder-card` 當落點）
- **為什麼**：唯一的搬移方式是拖曳，而拖曳的落點只有畫面上那幾張子資料夾卡片。
  跨分支、往上一層、從第 4 層搬回第 1 層，全都做不到。
- **怎麼修**：新增共用的**樹狀資料夾選擇器**（`openFolderPicker()`），四層全部列出來、
  縮排標層級、可打字過濾。檔案詳情多一顆 `📂 移動`，走的還是既有的
  `POST /attachments/:id/move`，只是目標不再受限。拖曳照舊可用。

### A8. 已經歸檔的記事完全沒有改位置的入口〔對應 (2)〕

- **在哪**：`app.js` 的 `openEntry()`
- **為什麼**：「歸檔到」那一列被 `${!folder ? ... : ""}` 包住——只有還在收件匣的草稿看得到。
  歸錯了就只剩「合併到另一筆」這種殺傷力大得多的手段。
- **怎麼修**：改成每筆都顯示「位置：<完整路徑>」＋`📂 移動…`。
  移動跟著「儲存」一起送出，不會沖掉正在編輯的內文。

### A9. 移動用的下拉是一串平的清單，四層下分不出誰是誰〔對應 (2)〕

- **在哪**：`app.js` 舊的 `openMoveEntryDialog()`
- **為什麼**：`類型｜名稱` 的平清單。「法規與標準」「年份／版本」這種名字會在好幾個
  分支底下重複出現，選項看起來一模一樣。
- **怎麼修**：換成 A7 那個樹狀選擇器，每一列都有完整路徑（滑鼠停留可看）與層級標示。

### A10. 資料夾本身不能搬，建錯只能刪掉重建〔對應 (2)〕

- **在哪**：`fieldlog/src/worker.js` 的 `PUT /folders/:id`
- **為什麼**：只收 `name`／`status`／`type`，不收 `parent_id`。四層架構一旦分錯層，
  唯一的辦法是刪掉重建，裡面的記事與附件跟著陪葬。
- **怎麼修**：`PUT /folders/:id` 接受 `parent_id`，並擋掉三件事：搬到自己底下、
  搬到自己的子孫底下（`isDescendantOf()`）、搬過去會超過四層
  （`folderDepth(新家) + subtreeHeight(被搬的子樹) > 4`——只檢查新家的深度不夠，
  被搬的那一整棵樹有多高也要算）。前台在資料夾選單與子資料夾卡片上都給了入口。

### A11. 合併資料夾會把子資料夾丟到來源的上層〔對應 (2)〕

- **在哪**：`worker.js` 的 `POST /folders/:id/merge`
- **為什麼**：`UPDATE folders SET parent_id = source.parent_id WHERE parent_id = sourceId`。
  結果是：記事進了目標資料夾，子資料夾卻跑到另一個分支去——同一批資料被劈成兩半，
  而且畫面上完全看不出發生過這件事。確認對話框也沒提到子資料夾。
- **怎麼修**：子資料夾改成跟著進目標資料夾；合併前先算層數，會超過四層就擋下並說明；
  另外擋掉「合併到自己的子資料夾」。確認對話框與完成訊息都會講移動了幾個子資料夾。

### A12. 收件匣空了整個面板消失，沒歸類的東西在首頁沒有入口〔對應 (6)〕

- **在哪**：`app.js` 舊的 `loadInbox()`：`display = entries.length ? "block" : "none"`
- **為什麼**：面板只在有東西時出現。而「還沒分類的東西」正是最需要一直被看到的東西。
- **怎麼修**：見下面 B 節——整區改成「最近作業」，並加上看得見的暫存區與自動歸類。

---

## B. 這次做的新行為〔對應 (6)〕

「收件夾改最近作業的項目，一開始就要先歸類。若很急來不及歸類先放在一個
可以看到的暫存資料夾，三五天後會自動歸類，並標記是 AI 分類的」

| 要求 | 做法 |
|---|---|
| 收件夾改最近作業 | 首頁那一區改成 **🕒 最近作業**（`GET /entries/recent`），列最後動過的 25 筆、不分資料夾，每列標出現在待在哪裡。空的時候也在。 |
| 一開始就先歸類 | 採集畫面的資料夾 chip 改成樹狀四層清單並直接顯示「點我歸類」；錄音因為沒有全螢幕畫面，改在浮動列上加一顆 📂；✏️ 記事寫完直接問要放哪裡。 |
| 很急先放暫存資料夾 | chip 第一項就是「⏳ 很急，先放暫存區」。暫存區是**真的資料夾**（`folders.role='staging'`），跟其他資料夾一樣出現在首頁；靠 `role` 欄位辨識而不是名字，使用者改名之後自動歸類仍找得到。 |
| 三五天後自動歸類 | cron（每天 02:00 台灣時間）跑 `autoFileStagedEntries()`：撈出暫存區／收件匣裡放滿 `AUTO_FILE_DAYS`（預設 4，可設 3–5）的記事，餵標題＋內文＋附件擷取文字給 `@cf/meta/llama-3.2-3b-instruct`，**只能從使用者現有的資料夾裡挑**。 |
| 標記是 AI 分類的 | 歸完寫 `entries.auto_filed_at`／`auto_filed_reason` 與一筆 history。最近作業上顯示 **🤖 AI 分類**，點一下可「確認正確」（拿掉標記）或自己改位置。AI 判斷不出來的不亂塞，留在暫存區標成 **🤖 待人工**。 |

守住的界線（有測試）：沒滿天數的一律不碰；AI 回不存在的編號或亂回一律當沒挑到；
外部來源同步管理的記事（`fields_json._sid`）不插手；AI 掛掉不會讓整批停下來；
單次最多處理 10 筆，不會一次爆量呼叫。

---

## D. 2026-08-09 追加：天數改成使用者自訂、資料夾加排序切換

原本 B 節的「三～五天」是寫死在 Worker 環境變數 `AUTO_FILE_DAYS`——要改就得進
Cloudflare Dashboard、還要重新部署，一般使用者碰不到。回報是「或是不要硬性規定，
我可以自行選擇天數，並且時間序排，把時間或命名序排功能加到每個階層」，拆成兩件事：

| 要求 | 做法 |
|---|---|
| 天數自己選，不要硬性規定 | 新增 `settings` 表（key-value，`fieldlog/src/lib/settings.js`），首頁「最近作業」下方多一個輸入框＋「套用」鈕，直接改數字（1–30 天）就生效，不用重新部署。`resolveAutoFileDays(db, env)` 優先讀使用者存過的設定，沒設定過才退回 `AUTO_FILE_DAYS` 環境變數，都沒有才用預設值 4 天——三層退路，舊的部署方式沒被拿掉，只是不再是唯一的路。 |
| 時間或命名排序加到每個階層 | 資料夾清單（不是資料夾裡的檔案，是資料夾本身）新增一個全域排序開關 `FOLDER_SORT`（`"name"` 或 `"time"`），**同時套用在首頁根層、每一層子資料夾、搬移選擇器、採集畫面的資料夾 chip**——不是切了首頁、子資料夾還是舊排序。時間排序一樣把「⏳ 暫存區」置頂（它裝的是需要回頭看的東西，不該被排到後面）。首頁與資料夾內頁工具列各有一顆 `🔤 名稱排序 / 🆕 新到舊` 按鈕，跟原本「資料夾裡的檔案清單」那顆 `🆕 新到舊 / 🔤 檔名排序`（A5）是兩個獨立的開關，管的是不同層級的東西。 |

新增測試：`tests/fieldlog-settings.test.js`（settings 表的 upsert 邏輯）、
`tests/fieldlog-staging-autofile.test.js`（`resolveAutoFileDays`／`saveAutoFileDays` 的
優先順序與範圍防呆）、`tests/fieldlog-auto-file-settings.test.js`（走完整 Worker 的
`PUT /settings/auto-file-days` 端點）、`tests/fieldlog-days-and-folder-sort.test.js`
（前端接線）。

---

## E. 2026-08-09 追加：改成 1 天後，「最近作業」最上面還是一堆舊資料〔真正的 bug〕

回報附了截圖：把天數改成 1 之後，「最近作業」清單最上面還是看得到 `07-30`
這種一週前的日期，夾在一堆 `08-06`／`08-05` 中間，順序看起來完全沒照時間排。

- **根因**：`/entries/recent` 是照 `COALESCE(updated_at, created_at) DESC` 排的，
  但 D 節那次的自動歸類 `UPDATE` 語句把 `folder_id`／`auto_filed_at`／
  `auto_filed_reason` 一起連 `updated_at` 也蓋成「現在」。天數一改小，排程（或按
  「現在就跑一次」）馬上把一大批放在暫存區好幾天、使用者早就沒再碰的舊記事
  全部掃過一輪，這些記事的 `updated_at` 全部變成剛剛，於是**集體跳回清單最上面**
  ——而畫面上顯示的日期是 `created_at`（沒跟著變），兩個資料對不上，看起來就像
  「排序完全沒在動」。天數設得越小，這個現象越明顯，剛好對上回報的操作順序。
- **怎麼修**：
  1. `fieldlog/src/lib/autofile.js`——AI 自動歸類的 `UPDATE` 不再寫 `updated_at`，
     只動 `folder_id`／`auto_filed_at`／`auto_filed_reason`。有沒有被 AI 動過看
     `auto_filed_at` 就夠了；`updated_at` 專門留給「使用者真的動過這筆」（編輯、
     手動搬移、合併…），排程這種背景動作不該冒充成使用者剛剛做的事。
  2. `fieldlog/public/app.js`——`entryRowHtml()` 新增 `showRecency` 選項：「最近
     作業」現在顯示的日期改成 `updated_at`（沒有才退回 `created_at`），跟實際
     排序依據對齊，不會再出現「畫面上的日期跟排序結果對不上」的錯覺。資料夾
     內頁的筆記清單維持顯示 `created_at`（那邊本來就是照 id／建立順序排的，
     不受影響）。

新增測試：`tests/fieldlog-staging-autofile.test.js` 加了一項直接斷言自動歸類前後
`updated_at` 不變；`tests/fieldlog-days-and-folder-sort.test.js` 加了兩項鎖住
UPDATE 語句與 `entryRowHtml` 的接線。前端版本號 88 → 89。

---

## F. 2026-08-09 追加：天數開放到 0（「再做一個 0 天的！全部歸檔！」）

D 節把天數範圍定在 1–30，把 0 當成打錯字擋掉。但「0 天」其實是一個合理的操作：
不想等排程慢慢篩，就是要把暫存區裡的東西**現在立刻**全部丟給 AI 分類。

- `fieldlog/src/lib/autofile.js`：`AUTO_FILE_DAYS_MIN` 從 1 改成 0；`clampDays()`
  的判斷從 `n <= 0` 改成 `n < 0`——只有負數／非數字才是打錯字退回預設值，0 是
  刻意允許的合法輸入。`cutoffTimestamp(0)` 本來就等於「現在」，`created_at <=
  cutoff` 對暫存區裡所有既有記事（含剛剛才建立的）都成立，不用改查詢邏輯。
- `worker.js`：`PUT /settings/auto-file-days` 的範圍檢查連帶放寬。過程中補上一個
  真正的既有 bug——`Number(null)` 會是 `0`，範圍放寬到含 0 之後，`{"days": null}`
  這種「根本沒帶值」的請求會被誤判成「使用者要設 0」而悄悄存進去；改成先擋掉
  `null`／`undefined`／空字串，不能只靠 `Number.isFinite()` 判斷有沒有帶值。
- `fieldlog/public/app.js`：新增 `autoFileDaysPhrase()`，0 顯示成「不等待，下次
  排程（或手動按「現在就跑一次」）就立即由 AI 自動歸類」，不是印出「放滿 0 天」
  這種看起來像打錯字的字串。四個講天數的地方（快速備忘標題、暫存區歸檔說明、
  採集畫面的資料夾 chip、套用後的 toast）都改用這支。

新增測試：`resolveAutoFileDays`／`saveAutoFileDays` 對 0 的邊界行為、
`autoFileStagedEntries` 用 `days: 0` 時連剛建立的記事都立即歸檔（不是只歸掉
本來就過期的）、worker 端點的 `days: null` 迴歸測試、前端 `autoFileDaysPhrase`
接線。前端版本號 89 → 90。

---

## C. 已知但這次沒動（要不要處理請指示）

### C1. ⚠️ `main` 分支的 `fieldlog/` 是舊快照，照它部署會讓隨身記整個退版

`main` 上的 `fieldlog/src/worker.js` 只有 20 KB（沒有四層資料夾的 `parent_id`、
沒有 wiki、沒有來源同步、沒有富文字），開發分支 `codex/kiwi-integration` 上是 96 KB。
`main` 之所以有一個 `fieldlog/` 目錄，是因為 `mcp/` 會 `import
../../fieldlog/src/lib/render.js`，為了讓 mcp 的 Worker 能從 main 建置而補上去的。

也就是說：**現在如果把 fieldlog 這個 Worker 指到 `main`，會用一份好幾十個功能之前的
程式碼覆蓋掉線上版本**，而且 Cloudflare 那邊看起來會是一次「成功的部署」。
本次的修改因此做在 `codex/kiwi-integration` 的基礎上（分支 `claude/feature-requirements-list-przkdr`）。

建議二選一：把 `main` 的 `fieldlog/` 更新成開發分支的版本，或把它整個拿掉、
改用 npm 依賴的方式讓 `mcp/` 取得那兩支 lib——現在這個中間狀態最危險。

### C2. `runLegacyCleanupOnce()` 的 "running" 標記寫了沒人讀

`app.js` 寫入 `localStorage.fieldlog_legacy_cleanup = "running"`，但判斷式只看
`=== "done"`。兩個分頁同時開資料夾時會各跑一次批次整理。影響有限（只用既有的
OCR／逐字稿，不呼叫 AI、不花額度），所以這次沒動。

### C3. 乾淨 clone 直接 `npm test` 會有 9 個測試失敗

不是程式問題：`mcp/src/worker.js` 依賴 `@cf-wasm/photon`，沒跑 `npm install` 就
`Cannot find package`。第一次看到很容易誤判成「MCP 壞了」。跑測試前先 `npm install`。
