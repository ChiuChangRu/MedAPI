# MyWiki 效能與穩定性修正報告

- 日期：2026-08-20
- 正式分支：`codex/kiwi-integration`
- 修正版本：v128
- 修正前基準：`52bcf64`

## 結論

系統變慢不應只歸因於網路。程式中存在三個會隨資料量放大的確定瓶頸：首頁重複查詢資料夾、資料夾統計使用逐資料夾相關子查詢、開啟資料夾時回傳不需要的記事全文與附件逐字稿/OCR/AI 分析。這些都是資料越多越慢的結構性問題。

正式 D1 筆數與索引的遠端唯讀查詢曾嘗試執行，但目前工作環境在 Cloudflare 網路核准完成前斷線，因此本報告不虛構正式資料量或改善百分比。

## v128 修正

### 1. 首頁少一次重複 API

登入驗證與已有 PIN 的啟動流程原本先呼叫 `/folders` 確認權限，隨後 `boot()` 又透過 `loadFolders()` 再呼叫一次相同 API。現在第一次回應直接交給 `boot(folders)` 重用。

### 2. 資料夾統計改為一次聚合

原 `/folders` 對每個資料夾分別執行記事數與子資料夾數兩個相關子查詢。資料夾數量增加時，重複工作跟著增加。現在先各自 `GROUP BY folder_id`／`GROUP BY parent_id`，再一次 JOIN 回資料夾清單。

### 3. 資料夾內容改回真正的摘要資料

原 `/entries?folder_id=...&include=attachments` 使用 `e.*` 與 `SELECT * FROM attachments`。因此只為顯示檔名、日期與圖示，也會把以下大型欄位傳到瀏覽器：

- 記事完整 body、fields、AI analysis
- 錄音逐字稿 transcript
- OCR／PDF 全文 ocr_text
- 附件 AI analysis 與 embedding 狀態

現在只回檔案總管畫面實際需要的欄位。打開單筆記事時仍由 `/entries/:id` 取得完整內容，功能不受影響。

### 4. 補熱路徑索引

新增 active partial indexes：

- `folders(parent_id)`：子資料夾統計與樹狀導覽
- `entries(folder_id, parent_entry_id)`：資料夾根層紀錄
- 最近待分類使用的日期 expression + id 排序

索引放在欄位 migration 之後，避免舊資料庫尚未具備 `deleted_at`／`parent_entry_id` 時建立失敗。

## 沒有貿然修改的部分

關鍵字搜尋目前最多把 5,000 筆記事及 5,000 筆附件文字讀入 Worker，再做繁簡、同義詞與多詞比對。這是下一個明確的擴充瓶頸，但不能直接降低上限，否則會讓較舊資料搜尋不到；也不能未經遷移設計就改成 FTS，否則繁簡與同義詞行為可能退步。本輪保留正確性，列為下一階段的 FTS/索引化搜尋專案。

錄音 v126/v127 剛完成架構收斂，本輪不再重寫錄音主體，避免效能修改又引入錄音回歸；保留現有診斷與測試。

## 驗證原則

- 版本、Service Worker 與 HTML 資源版本必須一致。
- 新增效能回歸測試，鎖住「不重複 `/folders`」、「不再相關子查詢」、「資料夾清單不傳大型全文欄位」與必要索引。
- 相關測試 44/44 通過（含錄音、首頁、時區、版本與效能測試）。
- 完整測試 465 項：388 pass／77 fail；失敗數與修正前週報記錄相同，沒有新增紅燈。77 項主要是舊 SQL mock 與垃圾桶重構不一致，仍需另案清理。
- Wrangler dry-run 與正式 D1 唯讀統計皆因本工作環境在 Cloudflare 網路核准完成前斷線，未在本機完成；發布後以 GitHub Actions 的正式部署結果為準。
- 保留使用者未提交的 `MYWIKI-AI-LIBRARY-PLAN.md`，不納入本次提交。

## 後續建議

1. 在 Cloudflare Dashboard 觀察 `/api/folders`、`/api/entries`、`/api/entries/recent`、`/api/search` 的 p50/p95 latency。
2. 下一階段為關鍵字搜尋建立可持續更新的搜尋索引，不能以縮小掃描上限換速度。
3. 清理長期 77 筆舊 mock 測試失敗，否則真正回歸可能被紅燈噪音掩蓋。
