# 隨身記（fieldlog）

隨身助理的記事本子項目：現場採集**參展／拜訪／實驗／上課／會議／查廠**的原始資料
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
> binding。免費額度每天 10,000 Neurons；Fieldlog 自動轉錄用完當天免費額度
> 就停（這一層完全在免費範圍內，不會產生費用），本月實際 AI 付費（USD，
> 是 Cloudflare 帳單的計價單位，跟其他平台的計費幣別無關）達 USD 4.50 時
> 停止新的 AI 處理（錄音與記事仍正常）。

## AI 費用雙層保護

1. AI Gateway 建立專用 Gateway（例如 `fieldlog-budget`）。
2. 在 Gateway 的 Spend limits 建立固定月週期 USD 5 規則。Cloudflare 的
   spend limit 採最終一致性，短時間並行請求仍可能有少量超出。
3. Worker → Settings → Variables and Secrets 新增一般變數
   `AI_GATEWAY_ID=fieldlog-budget`，再重新部署。
4. 首頁用量區必須顯示「AI Gateway 已接入」；若仍顯示尚未設定，USD 5
   硬停止就還沒有生效。

一般 Billing Budget Alert 只會通知、不會停止服務；不能替代 Gateway spend limit。

## 使用流程

1. 首頁按大顆「開始採集」→ 錄音（每 10 分鐘自動分段、即切即傳）＋
   隨時拍照（自動標「錄音第幾分幾秒拍的」）。採集畫面上就能歸類；
   來不及就按「⏳ 很急，先放暫存區」，一鍵帶過
2. 有空時打開紀錄：轉文字、補欄位、移動到資料夾（四層任一層都可以，
   已經歸過檔的也能再搬）。暫存區裡放滿 `AUTO_FILE_DAYS`（預設 4 天，
   建議 3–5）沒人動的，排程會用 AI 從**現有資料夾**裡挑一個歸進去，
   並在記事上標 🤖，點一下可以確認或改掉
3. 活動結束後，資料夾按「匯出給 AI」→ 得到一份 Markdown 原料包
   （速記＋轉錄全文＋照片時間點）→ 貼給 Claude/GPT：「彙整成報告」
   → 成品貼進 Notion

## 資料表（D1，自動建立）

| 表 | 用途 |
|---|---|
| `folders` | 活動/工作項目（type 決定欄位模板；`role='staging'`＝暫存區，靠欄位認不靠名字） |
| `entries` | 紀錄（folder_id 空＝收件匣；`auto_filed_at`／`auto_filed_reason`＝AI 自動歸類的標記） |
| `attachments` | 照片/錄音段/檔案（R2），offset_secs＝錄音時間點 |
| `history` | append-only 歷程 |

原始資料只增不刪（raw data 是彙整的根據，AI 整理錯了隨時能重來）。

## 給 MCP／外部工具的兩支端點

其餘 `/api/*` 都是前台在用的；這兩支是專門給 Mywiki MCP server 之類的外部呼叫端。
一樣要帶 `x-pin`（或 `?pin=`）。

### `GET /api/attachments/:id/raw` — 拿原始檔案

既有的附件端點回的是「擷取後的文字」，這支回的是**原始 bytes**，用在把照片直接嵌進
Word 報告這種場合。

| 參數 | 說明 |
|---|---|
| `mode` | `inline`＝直接回 base64；`url`＝回帶簽名的下載網址。**不給就自動選**：4MB 以內走 inline，超過走 url |

```jsonc
// mode=inline
{ "id": 266, "filename": "photo.jpg", "mime_type": "image/jpeg",
  "encoding": "base64", "data": "...", "size_bytes": 842213 }

// mode=url
{ "id": 267, "filename": "spec.pdf", "mime_type": "application/pdf",
  "url": "https://…/api/file/…?expires=…&sig=…",
  "expires_at": "2026-08-01T06:13:08Z", "size_bytes": 6000009 }
```

超過 4MB 還硬指定 `mode=inline` 會回 413 並要求改用 `url`（base64 會再膨脹約 4/3，
硬塞會讓 Worker 回應和呼叫端的 JSON 解析都爆掉）。

簽名網址**不是免驗證的對外分享連結**——`/api/*` 的 FIELD_PIN 閘門在簽名檢查之前，
沒有 PIN 的人拿到一樣是 401。簽名的作用是把持有 PIN 的呼叫端再限縮到「這一個
檔案、這 10 分鐘」。要做真正的對外分享連結得另外把 `/api/file/` 從 PIN 閘門豁免，
那是另一個安全決策。

### `POST /api/batch/ocr` — 批次把照片擷取成文字

body 給 `{"folder_id": 42}` 或 `{"entry_id": 100}`（擇一），可選 `limit`（預設 8，
上限 20——一張 OCR 要好幾秒，一次收太多會撞上 Worker 的 30 秒上限，逾時的話已經
扣掉的額度也拿不回來）。

```jsonc
{ "processed": 3,
  "results": [ { "attachment_id": 1, "filename": "a.jpg", "success": true, "message": "擷取文字成功，156 字" } ],
  "remaining": 5,                    // 這個範圍還剩幾張沒處理，可以再打一次
  "pending_audio_entry_ids": [12] }  // 還有錄音沒轉的紀錄
```

**這支只做照片，不碰錄音。** 錄音請打 `POST /api/entries/:id/auto-transcribe`——那支
帶了 Neurons 預估、`ai_usage_reservations` 佔位與 `transcribed_at` 鎖，能防重複扣額度、
也會在逼近門檻時提早收手。在批次端點另寫一套等於繞過那層保護，所以這裡改成把還有
錄音待處理的 entry id 回報出去，由呼叫端去打那支正規端點。

照片這邊同樣有保護：跑 AI 前先過 `enforceAiSoftBudget`（過不了直接 429／503，
且不會動到任何資料），每張用 `ocr_at` 搶鎖避免重複跑，單張失敗標成 `failed`
而不是還原成待辦（還原的話下次批次又會重跑同一張、再失敗一次，白白耗額度）。
