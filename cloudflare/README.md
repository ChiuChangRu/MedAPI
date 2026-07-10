# Medtec China 2026 展商作戰地圖（邦特團隊版）

部署在 Cloudflare Workers + D1 的完整版：

- **展商目錄**：585 家官方真實展商，靜態 JSON 直接進瀏覽器，篩選零延遲。
- **部門視角**：品保 / RA / 文管 / 設備 / 生產 / 工程 / 研發 / 營業，一鍵看「跟自己工作有關」的廠商。
- **邦特產品線視角**：透析、血管通路、呼吸治療…12 條產品線（含 TPU 導管核心技術、編織管與球囊兩個未來重點），用關鍵字自動比對相關展商，再依「上游材料／製程設備／技術延伸／市場合作／檢測顧問」分組呈現。
- **交叉檢索**：關鍵字（空格分隔多詞 AND 檢索）× 分類（可多選）× 展館 × 國家 × 拜訪狀態。
- **共筆（存 D1）**：每家展商可設定拜訪狀態、負責同事、部門標籤（誰想看）、已索取資料（型錄/名片/樣品/報價）、口袋名單；任何人可新增與修改紀錄，**所有修改保留歷程**（誰、何時、改了什麼）；一鍵匯出 CSV。
- **登入**：共用 PIN 碼 + 選名字署名，8 位同事直接用。

## 部署步驟（Cloudflare Dashboard，約 10 分鐘）

### 1. 建立 D1 資料庫

Dashboard 左側 **Storage & Databases → D1 SQL Database → Create Database**，
名稱填 `medtec-2026`。建立後複製它的 **Database ID**（UUID），
貼到本目錄 `wrangler.jsonc` 的 `database_id` 欄位，commit + push。

> 資料表不用手動建——Worker 第一次收到請求時會自動建表。

### 2. 建立 Worker（連 GitHub）

你截圖那個「Create a Worker」頁面：

1. 選 **Continue with GitHub**，選這個 repo（MedAPI）與分支
2. **Root directory** 填 `cloudflare`
3. Build command 留空、Deploy command 用預設的 `npx wrangler deploy`
4. Create and deploy

之後每次 push 這個分支，Cloudflare 會自動重新部署。

### 3. 設定團隊 PIN 碼（重要）

Worker 建好後：**Settings → Variables and Secrets → Add**，
Type 選 **Secret**，名稱 `TEAM_PIN`，值填你們團隊的共用密碼（例如 `bioteq2026`）。
存檔後 redeploy 一次。

> 沒設 TEAM_PIN 時 API 不驗證（方便本機測試），正式使用前務必設定。

### 4. 完成

網址會是 `https://medtec-2026.<你的帳號>.workers.dev`，
分享給 8 位同事，第一次進入輸入 PIN + 自己的名字即可開始共筆。

## 啟用照片／錄音／影片上傳（選用，約 3 分鐘）

附件功能把檔案存在 Cloudflare R2（同帳號、免費額度 10GB，
超過才計費）。未設定時網站其他功能不受影響，只是上傳按鈕
顯示未啟用。

1. Dashboard 左側 **R2 Object Storage** → **Create bucket**，
   名稱填 `medtec-2026-files`（第一次用 R2 會要求綁定付款方式，
   免費額度內不會扣款）
2. 打開 `cloudflare/wrangler.jsonc`，把 `r2_buckets` 那段的註解
   拿掉，commit + push
3. 部署完成後重新整理網站，展商詳情頁就會出現「拍照／上傳檔案」

> 單檔上限 50MB（約 1-2 分鐘手機影片）。更長的影片建議手機
> 原生錄影，回飯店後上傳到公司雲端硬碟，把連結貼在該廠商的
> 紀錄裡即可。

## 本機開發

```bash
cd cloudflare
npx wrangler dev   # 本機模擬（含本機 D1，資料存 .wrangler/ 不會動到線上）
```

## 資料更新

展商資料在 `public/data/exhibitors.json`，與 repo 根目錄
`scripts/import_exhibitors.py` 同步維護（該腳本會同時更新
`app/`、`docs/`、`cloudflare/public/` 三份）。

部門對應與產品線關鍵字都在 `public/config.js`，改完 push 即生效。

## 資料表（D1，自動建立）

| 表 | 用途 |
|---|---|
| `members` | 團隊成員名單（登入時自動登記） |
| `exhibitor_state` | 每家展商的拜訪狀態、負責人、部門標籤、索取資料、口袋名單 |
| `notes` | 團隊紀錄（軟刪除，內容不會真的消失） |
| `history` | 所有變更的歷程（append-only，誰在何時改了什麼） |
