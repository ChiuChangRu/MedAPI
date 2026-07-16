# 隨身記（fieldlog）

隨身助理的記事本子項目：現場採集**參展／拜訪／實驗／上課**的原始資料
（錄音自動分段、拍照帶錄音時間戳、速記、轉文字），資料夾一鍵匯出
Markdown 原料包，貼給 AI 彙整成報告後放進 Notion。

與 `cloudflare/`（Medtec 參訪系統）**完全獨立**：不同 Worker、不同
D1、不同 R2，互不影響。

## 部署步驟（Cloudflare Dashboard，約 10 分鐘）

1. **建 D1**：Storage & Databases → D1 → Create Database，名稱
   `fieldlog`。把 Database ID 貼到本目錄 `wrangler.jsonc` 的
   `database_id`，commit + push
2. **建 R2 bucket**：R2 Object Storage → Create bucket，名稱
   `fieldlog-files`
3. **建 Worker**：Workers → Create → Continue with GitHub → 選這個
   repo 與分支，**Root directory 填 `fieldlog`**，Deploy command 用
   預設 `npx wrangler deploy`
4. **設 PIN**：Worker 建好後 Settings → Variables and Secrets →
   Add Secret，名稱 `FIELD_PIN`，值填自己的密碼（沒設定時 API 一律
   拒絕，fail-closed）
5. 完成。網址 `https://fieldlog.<你的帳號>.workers.dev`，手機開啟後
   「加入主畫面」變成 App

> Workers AI（錄音轉文字）不用另外開通，`wrangler.jsonc` 已含 AI
> binding，第一次部署即生效。免費額度每天 10,000 Neurons，單人用不完。

## 使用流程

1. 首頁按大顆「開始採集」→ 錄音（每 10 分鐘自動分段、即切即傳）＋
   隨時拍照（自動標「錄音第幾分幾秒拍的」）→ 結束後自動存成一筆
   收件匣紀錄
2. 有空時打開紀錄：轉文字、補欄位、歸檔到資料夾（參展／拜訪／實驗／
   上課各有欄位模板）
3. 活動結束後，資料夾按「匯出給 AI」→ 得到一份 Markdown 原料包
   （速記＋轉錄全文＋照片時間點）→ 貼給 Claude/GPT：「彙整成報告」
   → 成品貼進 Notion

## 資料表（D1，自動建立）

| 表 | 用途 |
|---|---|
| `folders` | 活動/工作項目（type 決定欄位模板） |
| `entries` | 紀錄（folder_id 空＝收件匣） |
| `attachments` | 照片/錄音段/檔案（R2），offset_secs＝錄音時間點 |
| `history` | append-only 歷程 |

原始資料只增不刪（raw data 是彙整的根據，AI 整理錯了隨時能重來）。
