# fieldlog API 參考（2026-07-31 擴展版）

## 概覽

fieldlog Cloudflare Worker 提供的所有 API 端點及其使用方法。本文檔用於 AI（Claude、Mywiki MCP）集成。

---

## 驗證

所有 `/api/*` 路徑需提供 PIN：

```
Header: x-pin: <FIELD_PIN>
或
Query:  ?pin=<FIELD_PIN>
```

未設定 PIN 時所有請求被拒（fail-closed）。

---

## 1. 附件相關

### 1.1 上傳附件

**端點**：`POST /api/upload`

**Headers**：
```
x-pin: <PIN>
x-entry-id: <entry_id>
x-filename: <filename>
x-offset-secs: <offset>  (選填，照片時的錄音秒數)
content-type: <mime>
```

**Body**：Binary file (≤50MB)

**回傳**：
```json
{
  "id": 266,
  "key": "12/1722336842921-photo.jpg",
  "ok": true
}
```

---

### 1.2 取得附件原始檔案（新）

**端點**：`GET /api/attachments/:id/raw`

**Parameters**：
```
id          attachment ID (必填)
mode        "inline" | "url" (預設 "url")
```

**回傳（mode=inline）**：
```json
{
  "id": 266,
  "filename": "photo.jpg",
  "mime_type": "image/jpeg",
  "encoding": "base64",
  "data": "/9j/4AAQSkZJRgABA..."
}
```

**回傳（mode=url）**：
```json
{
  "id": 266,
  "filename": "photo.jpg",
  "mime_type": "image/jpeg",
  "url": "/api/file/12/1722336842921-photo.jpg?expires=1722337442&sig=abc123...",
  "expires_at": "2026-07-31T12:10:42Z",
  "size_bytes": 842213
}
```

**邏輯**：
- ≤2MB 圖片 + mode=inline → 直接回傳 base64
- 否則 → 回傳簽名 URL（10 分鐘有效）

---

### 1.3 編輯附件元資料

**端點**：`PUT /api/attachments/:id`

**Body**：
```json
{
  "ocr_text": "提取後的文字",
  "category": "分類標籤"
}
```

---

### 1.4 刪除附件

**端點**：`DELETE /api/attachments/:id`

**回傳**：`{ "ok": true }`

---

### 1.5 錄音轉文字

**端點**：`POST /api/attachments/:id/transcribe`

**說明**：使用 Whisper 模型轉錄（需 Workers AI 啟用）

**回傳**：
```json
{
  "text": "錄音的轉錄文字..."
}
```

---

### 1.6 照片擷取文字（新）

**端點**：`POST /api/attachments/:id/ocr`

**邏輯**：
1. 用 OCR 模型提取照片中的文字
2. 若有同時段錄音逐字稿，判斷「對話關聯」
3. 附加關聯句（如有）

**回傳**：
```json
{
  "ocr_text": "照片內的文字...\n\n【對話關聯】提及的內容..."
}
```

---

## 2. 批處理（新）

### 2.1 批次自動轉文字

**端點**：`POST /api/batch/process-attachments`

**Body**：
```json
{
  "folder_id": 123    // 或 "entry_id": 456（二選一）
}
```

**邏輯**：
1. 掃描指定資料夾/紀錄內所有未處理附件
   - 照片：ocr_text 為空
   - 錄音：transcript 為空
2. 逐項觸發轉文字（可能並行或串行，取決於實作）
3. 失敗時記錄錯誤但繼續處理
4. 返回結果清單

**回傳**：
```json
{
  "processed": 5,
  "results": [
    {
      "attachment_id": 1,
      "kind": "audio",
      "filename": "rec.m4a",
      "success": true,
      "message": "轉文字成功，2847 字"
    },
    {
      "attachment_id": 2,
      "kind": "photo",
      "filename": "pic.jpg",
      "success": true,
      "message": "擷取文字成功，156 字 + 對話關聯"
    },
    {
      "attachment_id": 3,
      "kind": "photo",
      "filename": "bad.jpg",
      "success": false,
      "message": "OCR 失敗：模型輸出異常"
    }
  ]
}
```

**注意**：
- Worker 30 秒超時限制，建議一次最多 10-20 個附件
- 若資料夾很大，建議分批（定時任務每次 5 個）

---

## 3. 檔案存取

### 3.1 下載檔案（簽名驗證）

**端點**：`GET /api/file/:key`

**Parameters**：
```
key     R2 key (如 "12/1722336842921-photo.jpg")
expires 時間戳（秒）(選填，若帶則需驗證簽名)
sig     HMAC 簽名 (選填，若帶則需驗證)
```

**邏輯**：
- 若無 expires/sig → 直接返回檔案（舊模式，無時間限制）
- 若有 expires/sig → 驗證簽名和過期時間
  - 超過 expires → 403 Forbidden
  - 簽名不符 → 403 Forbidden
  - 驗證通過 → 返回檔案

**簽名算法**：
```
payload = "{key}:{expires}"
signature = HMAC-SHA256(payload, FIELD_PIN)
```

---

## 4. 匯出

### 4.1 資料夾匯出 Markdown

**端點**：`GET /api/export/folder/:id`

**說明**：整個資料夾匯出為 Markdown，含所有紀錄、附件、轉錄文字、OCR 文字、照片時間點

**回傳**：Content-Type: `text/markdown`

**格式**：
```markdown
# 資料夾名稱（類型）

> raw data 匯出 | 共 N 筆紀錄

---

## 紀錄標題

建立：2026-07-31 12:00:00Z | 更新：...

- **欄位1**：值
- **欄位2**：值

紀錄內容...

### 錄音轉文字

**檔名**（起於 12:34）
錄音逐字稿全文...

### 照片（共 3 張）

- photo1.jpg｜錄音 12:34 時拍攝｜分類：設備
  - 照片內文字（AI 擷取）：文字內容...
- photo2.jpg｜錄音 15:46 時拍攝
- photo3.jpg｜2026-07-31 12:50:00Z

### 其他檔案

- document.pdf（2.3MB）

---

## 第二筆紀錄
...
```

---

## 5. 資料夾與紀錄

### 5.1 列表資料夾

**端點**：`GET /api/folders`

**回傳**：
```json
[
  {
    "id": 1,
    "name": "Medtec 2026 參展",
    "type": "參展",
    "status": "進行中",
    "created_at": "2026-07-01 10:00:00Z",
    "entry_count": 12,
    "notion_page_id": "...",
    "notion_synced_at": "..."
  }
]
```

---

### 5.2 新增資料夾

**端點**：`POST /api/folders`

**Body**：
```json
{
  "name": "資料夾名稱",
  "type": "參展 | 拜訪 | 實驗 | 上課 | 其他"
}
```

---

### 5.3 更新資料夾

**端點**：`PUT /api/folders/:id`

**Body**：
```json
{
  "name": "新名稱",
  "status": "進行中 | 完成"
}
```

---

### 5.4 列表紀錄

**端點**：`GET /api/entries`

**Parameters**：
```
folder_id  資料夾 ID (或用 inbox=1 獲取收件匣)
```

**回傳**：
```json
[
  {
    "id": 100,
    "folder_id": 1,
    "title": "紀錄標題",
    "fields_json": "{\"欄位1\": \"值\"}",
    "body": "紀錄內容",
    "created_at": "2026-07-31 12:00:00Z",
    "updated_at": "2026-07-31 14:30:00Z",
    "att_count": 3
  }
]
```

---

### 5.5 新增紀錄

**端點**：`POST /api/entries`

**Body**：
```json
{
  "folder_id": 1,
  "title": "紀錄標題",
  "fields": {
    "欄位1": "值",
    "欄位2": "值"
  },
  "body": "紀錄內容"
}
```

---

### 5.6 更新紀錄

**端點**：`PUT /api/entries/:id`

**Body**：
```json
{
  "folder_id": 1,
  "title": "新標題",
  "fields": { ... },
  "body": "..."
}
```

---

### 5.7 刪除紀錄

**端點**：`DELETE /api/entries/:id`

**說明**：連同所有附件一起刪除

---

## 6. 欄位模板

預設四種資料夾類型各有欄位模板（`app.js` 中 `FOLDER_TEMPLATES` 定義）：

| 類型 | 欄位 |
|---|---|
| 參展 | 廠商名、攤位、目標、取得資料、下一步 |
| 拜訪 | 對象、聯絡人、討論事項、結論、待辦 |
| 實驗 | 主題、條件／參數、觀察結果、判定、下次調整 |
| 上課 | 課程名、講者、重點、待查資料 |
| 其他 | (無預設欄位) |

---

## 7. 錯誤碼

| 狀態 | 說明 |
|---|---|
| 400 | Bad Request（參數錯誤、缺必填欄位等） |
| 401 | Unauthorized（PIN 錯誤或未提供） |
| 403 | Forbidden（簽名驗證失敗、URL 過期） |
| 404 | Not Found（資源不存在） |
| 500 | Server Error |
| 501 | Not Implemented（功能未啟用，如 R2 未設定） |

---

## 8. 工作流程範例

### 8.1 現場採集 → 整理 → 匯出

```
1. POST /api/entries (新增收件匣紀錄)
2. POST /api/upload (多次上傳照片/錄音)
3. POST /api/attachments/:id/transcribe (逐項轉文字)
4. POST /api/attachments/:id/ocr (逐項擷取文字)
   或
   POST /api/batch/process-attachments (批次轉文字)
5. PUT /api/entries/:id (補欄位、歸檔)
6. PUT /api/folders/:id (更新資料夾狀態)
7. GET /api/export/folder/:id (匯出 Markdown)
```

### 8.2 Word 報告嵌圖

```
1. GET /api/attachments/:id/raw?mode=inline (取圖片 base64)
2. 用 docx 工具嵌入圖片
3. 生成 .docx 檔案
```

### 8.3 批次整理資料夾

```
1. POST /api/batch/process-attachments?folder_id=X (自動轉文字)
   返回 processed=N 個
2. GET /api/export/folder/X (包含所有新轉錄文字)
3. 貼給 Claude/GPT 彙整報告
```

---

## 9. 常數與限制

| 項目 | 值 | 備註 |
|---|---|---|
| 檔案上限 | 50 MB | POST /api/upload |
| 簽名 URL 有效期 | 10 分鐘 | GET /api/file (簽名模式) |
| Worker 超時 | 30 秒 | 批處理建議 ≤20 個附件 |
| inline base64 上限 | 2 MB | GET /api/attachments/:id/raw |
| 時區 | ISO 8601 (Z) | 2026-07-31T12:00:00Z |

---

## 10. 開發與部署

**所在檔案**：`fieldlog/src/worker.js`

**部署**：
```bash
cd fieldlog
npx wrangler deploy
```

**本地開發**：
```bash
cd fieldlog
npx wrangler dev
```

**必要環境**：
- D1 database: `fieldlog`
- R2 bucket: `fieldlog-files`
- Workers AI (無需另外設定)
- Secret: `FIELD_PIN`

---

## 11. 資料庫 Schema

### attachments 表

```sql
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'file',           -- 'photo' | 'audio' | 'file'
  filename TEXT NOT NULL,
  key TEXT NOT NULL,                   -- R2 key
  size INTEGER DEFAULT 0,              -- bytes
  mime TEXT DEFAULT '',                -- MIME type
  transcript TEXT DEFAULT '',          -- 錄音逐字稿
  ocr_text TEXT DEFAULT '',            -- 照片擷取文字
  offset_secs INTEGER,                 -- 錄音第幾秒拍照
  category TEXT DEFAULT '',            -- 分類標籤
  created_at TEXT NOT NULL
);
```

### 其他表

見 `worker.js` SCHEMA 定義：folders、entries、history

---

## 12. 安全性檢查

- ✅ PIN 驗證（fail-closed）
- ✅ 簽名 URL 限定單一檔案
- ✅ 10 分鐘自動過期
- ✅ HMAC-SHA256 防篡改
- ✅ raw data 只增不刪（軟刪除）
