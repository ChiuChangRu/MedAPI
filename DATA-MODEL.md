# 資料結構與操作手冊

> 這份文件回答三個問題：**資料存在哪裡、長什麼樣子、怎麼查怎麼看**。
> 給人看的日常操作在 [`SECOND-BRAIN.md`](SECOND-BRAIN.md)，工程決策在
> [`ARCHITECTURE.md`](ARCHITECTURE.md)，這份專講資料層。

## 一、資料存在哪裡（兩層儲存）

每個系統的資料都分兩層存在 Cloudflare 上：

| 層 | 存什麼 | 參展系統（medtec-2026） | 隨身記（fieldlog） |
|---|---|---|---|
| **R2**（物件儲存） | 檔案本體：照片、PDF、錄音、影片 | bucket `medtec-2026-files` | bucket `fieldlog-files` |
| **D1**（SQLite 資料庫） | 結構化資料：紀錄、狀態、**AI 擷取出來的文字** | database `medtec-2026` | database `fieldlog` |

**關鍵觀念：檔案本體（圖片/PDF）在 R2，但「可搜尋的文字」在 D1。**
你按「Cloudflare AI 整理」時，AI 把 R2 裡的檔案讀出來、辨識成文字，
把文字寫回 D1 的 `transcript`／`ocr_text` 欄位。之後不管是前台搜尋、
還是 claude.ai 透過 MCP 問答，查的都是 D1 裡的這些文字，**不是**重新
去讀圖片。所以「一份檔案有沒有料」＝「D1 裡它的文字欄位有沒有東西」。

## 二、一份附件的生命週期（資料怎麼流動）

```
  手機拍照/錄音/選 PDF
        │  上傳
        ▼
  檔案本體 → R2（key 記在 D1 的 attachments.key）
  一筆附件紀錄 → D1 attachments（filename, mime, size…，此時 transcript/ocr_text 還是空的）
        │
        │  按「🪄 Cloudflare AI 整理」
        ▼
  Cloudflare Workers AI 讀 R2 檔案 → 辨識成文字：
     · 錄音  → Whisper           → 寫回 attachments.transcript
     · 照片  → Llama Vision(OCR) → 寫回 attachments.ocr_text
     · PDF   → toMarkdown        → 寫回 attachments.ocr_text（剝掉檔案 metadata）
        │  同時蓋上處理時間戳 transcribed_at / ocr_at
        ▼
  D1 裡有了可搜尋文字
        │
        ├─ 前台搜尋框、「加說明/編輯」直接讀 D1
        └─ claude.ai ──MCP（唯讀）──► 讀 D1（查詢時再做簡繁摺疊＋PDF metadata 剝除）
```

## 三、資料表結構（重點欄位白話版）

### 參展系統 `medtec-2026`

**`attachments`（附件）**——最常查的表：
| 欄位 | 意思 |
|---|---|
| `id` | 附件編號 |
| `exhibitor_id` | 屬於哪家展商（例 `ex-0150`） |
| `filename` | 原始檔名 |
| `key` | 在 R2 的檔案路徑 |
| `mime` | 類型：`image/jpeg`、`application/pdf`、`audio/webm`… |
| `size` | 檔案大小（bytes） |
| `transcript` | 錄音逐字稿（AI 寫入） |
| `ocr_text` | 照片/PDF 擷取文字（AI 寫入）← **就是「912 字」存的地方** |
| `transcribed_at` / `ocr_at` | 處理時間戳（判斷狀態用，見第四節） |
| `caption` | 人工加的說明 |
| `category` | 照片分類（型錄/產品/展場…） |
| `offset_secs` | 採集模式照片「錄音第幾秒拍的」 |
| `source_pdf_id` / `page_no` | Tier 2 深度處理產生的頁面截圖才有值：指回來源 PDF 的 `id`、第幾頁 |
| `created_at` | 上傳時間 |

**`exhibitor_state`（展商共筆狀態）**：`status`（拜訪狀態）、`assignee`
（指派給誰）、`dept_tags`（部門標籤）、`quals`（資質）、`pocket`
（口袋名單）、`visit_record`（拜訪成果 JSON：取得什麼/聯絡人/下一步）。

**`notes`（團隊拜訪紀錄）**：`exhibitor_id`、`author`、`type`、`content`
（紀錄內文）、`deleted`（軟刪除，內容不會真的消失）。

**`history`**：append-only 歷程，誰在何時改了什麼。
**`members`**：團隊成員。**`line_recipients`**：LINE 每日摘要名單。

### 隨身記 `fieldlog`

**`folders`（資料夾＝活動）**：`name`、`type`（參展/拜訪/實驗/上課，
決定欄位模板）、`status`。
**`entries`（紀錄）**：`folder_id`（空＝收件匣）、`title`、`body`（速記）、
`fields_json`（模板欄位值）。
**`attachments`（附件）**：跟參展系統幾乎一樣，差別是用 `entry_id`
（屬於哪筆紀錄）、`kind`（photo/audio/file），同樣有 `transcript`／
`ocr_text`／`transcribed_at`／`ocr_at`。
**`history`**：歷程。

## 四、四種「整理狀態」怎麼由欄位決定

前台每個附件顯示的狀態，是看 `ocr_text`／`ocr_at`（照片/PDF）或
`transcript`／`transcribed_at`（錄音）這兩個欄位算出來的：

| 顯示 | 條件 | 意思 |
|---|---|---|
| **⏳ 未整理** | 文字欄空 且 時間戳空 | 還沒跑過 AI |
| **✅ 已整理｜<預覽>** | 文字欄有內容 | 跑過，有抓到文字 |
| **✅ 已整理（沒有文字內容）** | 時間戳有值 但 文字欄空 | 跑過了，但這檔案抽不到字（見下） |
| **🚫 不整理** | 時間戳＝`skipped` | 你手動按「略過」，不花 AI 額度 |

「已整理但沒有文字內容」最常見於**圖形型 PDF**——見下一節。

## 五、三種附件的差異（尤其 PDF 的坑）

| 類型 | 用什麼辨識 | 效果 |
|---|---|---|
| **錄音** | Whisper | 逐字稿，通常不錯 |
| **照片** | Llama Vision（真的「看」圖） | 能抄出圖片上的字，展場型錄拍照效果好 |
| **PDF** | toMarkdown（只抽**文字層**，不看圖） | **看 PDF 是怎麼做的** |

**PDF 分兩種，差很多：**
- **文字型 PDF**（用文書軟體匯出、文字是真的文字）→ 抽得到本文，可搜尋
- **圖形型 PDF**（用 Affinity Designer/InDesign 等排版、文字排成圖形、
  沒有文字層）→ **toMarkdown 抽不到本文**，只吐得出頁面骨架
  （`## Contents / ### Page 1…`）。系統會判定「沒有文字內容」，
  誠實標記，不會假裝有料。

> **實例**：百賽飛的 SurfCleanMD 输尿管支架宣傳冊就是圖形型 PDF，
> 抽不到字。但**同樣的內容你現場拍的照片 OCR 抄得到**——所以重要
> 宣傳冊「拍照」比「上傳 PDF」可靠。若某內容只有圖形 PDF、又沒拍照，
> 一般整理抽不到，要靠下面的 **Tier 2 深度處理**。

### Tier 2 深度處理（手動、單一 PDF，2026-07-19 上線）

一般整理（上面講的 Tier 1）遇到圖形型 PDF 就沒轍。Tier 2 的做法：
**把這份 PDF 每一頁在瀏覽器裡 render 成一張圖片，直接餵給既有的照片 OCR**
（Llama Vision）。原本排版成圖形的文字、向量繪製的圖表，一旦變成整頁
截圖就都是看得見的像素，OCR 抄得到，也自動流進既有的搜尋索引與 MCP
查詢——**不是另外蓋一套 Tier 2 儲存/搜尋機制**，只是多了一步「先把
PDF 轉成照片」。

**鐵律：絕對不是背景自動批次。** 每個 PDF 附件旁有「🔬 深度處理」按鈕，
**你手動點哪份就只處理那一份**，其他附件完全不受影響、不會被自動升級。
成本比一般整理高（一份 20 頁的 PDF＝20 次 OCR 呼叫），所以刻意設計成
「你判斷值得才點」，不是全庫自動跑。

**技術實作**：Cloudflare Worker 沒有 PDF 渲染能力，這步只能在瀏覽器端
用 `pdf.js`（CDN 載入）逐頁畫成 canvas → 轉成 PNG → 用既有的上傳＋
OCR 端點處理，跟你手動拍照上傳走的是同一條路。產生的頁面截圖會標記
`source_pdf_id`（指回來源 PDF 的 `attachments.id`）與 `page_no`（第幾
頁），前台看得到「這份 PDF 已深度處理成 N 頁截圖」，可重新處理但不會
重複自動疊加。

## 六、怎麼查、怎麼看

### 方法 A：前台（最簡單，日常用這個）
打開展商/紀錄 → 附件區 → 每個附件的狀態列（⏳/✅/🚫）一眼看出有沒有料，
點開看擷取文字、按「編輯」改、按「重抄」重跑。**不用進 Cloudflare。**

### 方法 B：claude.ai 問（跨檔案找內容）
直接問「XX 廠商的塗層方案細節」「哪份資料提到抗結晶」，簡繁不拘。

### 方法 C：Cloudflare D1 Console（要看原始存了什麼、字數多少時）
Dashboard → **Storage & Databases → D1 → medtec-2026**（或 fieldlog）
→ **Console** 分頁，貼 SQL 執行（**只下 SELECT，別下 UPDATE/DELETE**）：

看某展商每個附件有沒有料、各幾字：
```sql
SELECT id, filename, mime,
       length(ocr_text)  AS ocr字數,
       length(transcript) AS 逐字稿字數,
       ocr_at, transcribed_at
FROM attachments WHERE exhibitor_id = 'ex-0150' ORDER BY id;
```

看某份 PDF 實際存的開頭內容（確認是本文還是骨架）：
```sql
SELECT filename, length(ocr_text) AS 字數, substr(ocr_text,1,300) AS 開頭
FROM attachments
WHERE exhibitor_id='ex-0150' AND filename LIKE '%SurfCleanMD%';
```

檔案本體要看/下載：Dashboard → **R2 → medtec-2026-files**，
用附件的 `key` 找到那個物件。

## 七、MCP（claude.ai 窗口）怎麼讀這些資料

`medapi-mcp` 這個 Worker 唯讀共綁兩個 D1，claude.ai 查詢時它會即時做兩件
清洗，所以你不必為了查得到而先整理資料：
- **簡繁摺疊**：查詢字與庫內文字都轉成同一種寫法，繁體查得到簡體庫
  （廠商型錄多為簡體）、反之亦然
- **PDF metadata 剝除**：現有已存的髒 PDF 資料查詢時即時剝掉 metadata，
  不用重跑整理

要改資料一律回前台；MCP 只讀不寫。

## 更新日誌
- 2026-07-19｜初版：資料兩層儲存（R2/D1）、附件生命週期、資料表結構、
  四種整理狀態、PDF 三種辨識差異、查證方式、MCP 讀取清洗
