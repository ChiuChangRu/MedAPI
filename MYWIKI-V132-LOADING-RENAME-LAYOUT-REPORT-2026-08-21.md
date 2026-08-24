# MyWiki v132 變更報告：載入進度、清單標題與全面重新命名

日期：2026-08-21

正式分支：`codex/kiwi-integration`

正式 Worker：`fieldlog`

正式網址：`https://fieldlog.gogoyankee.workers.dev/`

## 問題

1. Cloudflare Access 第一次驗證後，MyWiki 初次讀取資料時間較久；原有進度條要等前端 JavaScript 開始執行才出現，而且只有百分比，使用者容易誤認為沒有反應。
2. 桌機開啟預覽欄後，記事清單的標題與路徑、時間、移動、合併、刪除擠在同一行，長標題可能被壓成一字一行。
3. 資料夾名稱可以修改，但記事、錄音資料包與附件的改名入口不一致，資料久了難以整理。

## v132 修改

### 1. 首屏載入進度

- `index.html` 預設直接顯示載入遮罩，不必等 `app.js` 執行才出現。
- 進度改為分階段文字：檢查登入、連線、讀取資料夾、系統設定、分類、記事清單、畫面整理。
- 12 秒後提示資料量較多仍在讀取。
- 30 秒後顯示重新載入按鈕，避免永久卡在無回饋狀態。
- 登入畫面出現前會先關閉載入遮罩。
- 這不是精準的傳輸百分比；各 API 沒有提供可換算位元組總量，因此百分比代表已完成的啟動階段，避免製造虛假精度。

### 2. 清單欄位重新分配

- 桌機清單／詳細模式將記事標題設為主要欄，保留至少 `220px`。
- 資料夾路徑、建立／更新時間及附件數移到第二行。
- 視窗與預覽欄寬度縮小時，次要資訊不再搶占標題寬度。
- 手機仍使用換行清單，不改成桌機網格。

### 3. 全面重新命名

新增以下入口：

- 一般記事清單：標題旁 `✏️`。
- 錄音／多附件資料包：卡片右上 `✏️`。
- 單一檔案：`⋯` 管理頁中的「重新命名」。
- 記事詳情的每個附件：附件列上的「重新命名」。

附件後端規則：

- 名稱不可空白或超過 240 字元。
- 禁止 `/`、反斜線與控制字元，避免名稱被當成路徑。
- 原檔有副檔名時必須保留；前端漏填會自動補回，嘗試改成其他副檔名時後端拒絕。
- 第一次手動改名會保留 `original_filename`，操作寫入 history。
- 只更新 D1 的顯示檔名，不更改 R2 的內部 key。R2 key 是儲存識別碼，不是公開顯示名稱；不搬動物件可避免大型檔案複製、失敗中間態及額外 R2 操作。

## 版本同步

- `fieldlog/src/worker.js`：`UI_VERSION = "132"`
- `fieldlog/public/app.js`：`APP_VERSION = "132"`
- `index.html` 靜態資源查詢版本：`v=132`
- Service Worker cache：`fieldlog-v132-boot-progress`

## 驗證

執行：

```text
node --check fieldlog/public/app.js
node --check fieldlog/src/worker.js
node --test tests/fieldlog-rename-layout.test.js \
  tests/fieldlog-security-sharing.test.js \
  tests/fieldlog-folder-routing-preview.test.js \
  tests/fieldlog-audio-recording.test.js \
  tests/fieldlog-home-toolbar.test.js \
  tests/fieldlog-performance.test.js \
  tests/fieldlog-timezone-display.test.js
```

結果：59/59 通過。

## 後續注意

- Cloudflare Access 本身的 Email 驗證頁發生在 MyWiki HTML 送達之前，因此 MyWiki 進度條無法顯示 Access 驗證流程；它會在 Access 放行、瀏覽器開始取得 MyWiki HTML 後立即出現。
- 若實際資料讀取持續變慢，進度條只能改善回饋，不能取代效能調查。應另外記錄 `/api/folders`、`/api/categories`、`/api/entries` 各階段耗時，找出真正瓶頸。
