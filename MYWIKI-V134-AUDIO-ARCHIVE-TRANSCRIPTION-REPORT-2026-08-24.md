# MyWiki v134 錄音歸檔與轉錄修正報告

日期：2026-08-24  
分支：`codex/kiwi-integration`

## 使用者回報

錄音建立並歸檔至「高壓注射筒」後，只看得到錄音記事與麥克風無訊號診斷，附件區沒有錄音檔，也無法判斷是否能正常轉錄。

## 根因

1. 音檔上傳失敗時會寫入瀏覽器 IndexedDB 離線佇列，但記事畫面完全不顯示本機待補傳檔案，造成「音檔消失」的錯覺。
2. 離線佇列沒有保存 `durationSecs`，補傳至 R2 後 `attachments.duration_secs` 為空，無法進入既有自動轉錄候選條件。
3. 頂層附件原本在整個資料夾內依 SHA-256 去重。這對一般文件合理，但兩次內容相同的錄音（尤其靜音錄音）可能被跨記事判定為重複，留下沒有附件的新記事。
4. MediaRecorder 若回傳 0-byte Blob，舊版會靜默略過，最後仍顯示「錄音完成」，無法區分已上傳、待補傳與實際未產生檔案。

## 修正內容

- 記事附件區會顯示本機待補傳檔案數與「立即補傳」按鈕。
- 網路恢復時會主動重試離線補傳。
- IndexedDB 離線佇列保存並在補傳時帶回錄音 `durationSecs`。
- 相容 v133 以前已補傳但缺少 `duration_secs` 的錄音；以單段上限 10 分鐘保守估算 AI 額度後允許自動轉錄。
- 錄音只在同一筆 entry 內去重，不再跨記事合併；一般文件仍維持資料夾層級去重。
- 0-byte 音檔會在記事中留下明確失敗紀錄，完成提示依實際狀態回報：已上傳、暫存本機或未產生音檔。
- UI、Worker 與 Service Worker 快取版本同步升級為 v134。

## 既有錄音判讀

畫面中的 `peak=0` 表示瀏覽器實際量到麥克風訊號為零。檔案若仍有編碼資料，可能可以播放，但內容很可能是靜音；Whisper 對靜音產生的重複幻覺文字會被系統捨棄。因此「附件成功找回」不代表該次錄音一定能得到有效逐字稿。

## 驗證

- `node --check fieldlog/public/app.js`
- `node --check fieldlog/src/worker.js`
- `node --test tests/fieldlog-audio-recording.test.js tests/fieldlog-auto-transcribe.test.js`
- 相關測試：30 項通過、0 項失敗。

