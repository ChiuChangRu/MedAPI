# Mywiki MCP 工具定義（待實作）

> 針對 Mywiki MCP Server 的工具定義清單  
> 後端 fieldlog API 已完成，下列工具待 MCP 端實作

---

## 工具 1：原始附件存取

### 名稱
```
mcp__Mywiki__get_fieldlog_attachment_raw
```

### 描述
取得 fieldlog 附件的原始檔案（圖片或 PDF）。圖片小檔直接回傳 base64，大檔案回傳簽名 URL。

### 輸入 Schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "number",
      "description": "attachment ID"
    },
    "mode": {
      "type": "string",
      "enum": ["inline", "url"],
      "description": "回傳模式。inline: 直接 base64; url: 簽名網址。預設 url"
    }
  },
  "required": ["id"]
}
```

### 回傳格式

#### mode=inline（圖片 ≤2MB）
```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "/9j/4AAQSkZJRgABA..."
  },
  "metadata": {
    "id": 266,
    "filename": "photo.jpg"
  }
}
```

#### mode=url（大檔案或 PDF）
```json
{
  "type": "text",
  "text": "## photo.jpg\n\n📎 [下載](https://.../api/file/...) (842 KB) \n⏰ 有效期：2026-07-31T12:10:42Z",
  "metadata": {
    "id": 266,
    "url": "https://.../api/file/...",
    "expires_at": "2026-07-31T12:10:42Z",
    "size_bytes": 842213,
    "mime_type": "image/jpeg"
  }
}
```

### 實作重點
- 呼叫 `GET /api/attachments/:id/raw?mode={mode}`
- 沿用 FIELD_PIN 認證（header 或 query param）
- inline 模式返回 Claude image content block（可直接嵌入報告）
- url 模式返回簽名 URL 及過期時間

### 典型用法

**用於 Word 報告嵌圖**：
```
user: 把 fieldlog 附件 #266 的照片放進報告
↓
MCP 工具 → get_fieldlog_attachment_raw(id=266, mode="inline")
↓ (回傳 base64)
Claude 用 docx 工具嵌入圖片
↓ (完成！無需手動下載)
```

---

## 工具 2：批次自動轉文字

### 名稱
```
mcp__Mywiki__process_fieldlog_batch
```

### 描述
自動為 fieldlog 資料夾或紀錄內未處理的附件觸發 OCR（照片）和語音轉文字（錄音）。

### 輸入 Schema

```json
{
  "type": "object",
  "properties": {
    "folder_id": {
      "type": "number",
      "description": "資料夾 ID"
    },
    "entry_id": {
      "type": "number",
      "description": "紀錄 ID"
    }
  }
}
```

**注意**：`folder_id` 或 `entry_id` 二選一

### 回傳格式

```json
{
  "type": "text",
  "text": "✅ 已處理 5 個附件\n\n- 🎙️ rec.m4a: ✓ 轉文字成功，2847 字\n- 📷 photo1.jpg: ✓ 擷取文字成功，156 字 + 對話關聯\n- 📷 photo2.jpg: ✗ 擷取文字失敗：模型輸出異常",
  "metadata": {
    "processed_count": 5,
    "success_count": 4,
    "details": [
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
        "filename": "photo1.jpg",
        "success": true,
        "message": "擷取文字成功，156 字 + 對話關聯"
      },
      {
        "attachment_id": 3,
        "kind": "photo",
        "filename": "photo2.jpg",
        "success": false,
        "message": "擷取文字失敗：模型輸出異常"
      }
    ]
  }
}
```

### 實作重點
- 呼叫 `POST /api/batch/process-attachments` (body: `{folder_id}` 或 `{entry_id}`)
- 沿用 FIELD_PIN 認證
- 掃描未處理附件（transcript 或 ocr_text 為空）
- 逐項處理，失敗繼續（非全部失敗就停止）
- ⚠️ Worker 30 秒超時，建議一次最多 10-20 個附件

### 典型用法

**資料夾整理流程**：
```
user: 幫我把資料夾 #42 的所有照片和錄音都整理一遍
↓
MCP 工具 → process_fieldlog_batch(folder_id=42)
↓ (Worker 掃描、轉文字、OCR)
返回處理結果摘要
↓ (後續 GET /api/export/folder/42 時已包含所有文字)
```

---

## 工具 3：PDF 分頁提取

### 名稱
```
mcp__Mywiki__extract_pdf_page
```

### 狀態
⏳ **待實作**（低優先度，框架預留）

### 描述
從 PDF 附件提取指定頁面，轉成圖片或文字。

### 輸入 Schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "number",
      "description": "PDF attachment ID"
    },
    "page": {
      "type": "number",
      "description": "頁碼（1-based）"
    }
  },
  "required": ["id", "page"]
}
```

### 回傳格式

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgoAAAA..."
  },
  "metadata": {
    "id": 267,
    "filename": "spec.pdf",
    "page": 2,
    "total_pages": 15
  }
}
```

### 實作建議

**方案 A：pdf.js（推薦）**
```javascript
import * as pdfjsLib from "pdfjs-dist";

async function extractPdfPage(url, pageNumber) {
  const pdf = await pdfjsLib.getDocument(url).promise;
  const page = await pdf.getPage(pageNumber);
  
  const canvas = document.createElement("canvas");
  const scale = 2;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  
  return canvas.toDataURL("image/png");
}
```

**方案 B：外部 API（CloudConvert 等）**
- 更簡單但需付費
- 適合不想引入重型依賴的場景

### 實作流程
1. 首先呼叫 `GET /api/attachments/:id/raw?page=N` 取簽名 URL
2. 用 web_fetch 下載 PDF
3. 用 pdf.js 或外部 API 轉圖片
4. 回傳 base64 或 URL

---

## 工具 4：匯出資料夾（既有）

### 名稱
```
mcp__Mywiki__export_fieldlog_folder
```

### 描述
匯出整個資料夾為 Markdown，含所有紀錄、轉錄文字、擷取文字、照片時間點。

### 輸入 Schema

```json
{
  "type": "object",
  "properties": {
    "folder_id": {
      "type": "number",
      "description": "資料夾 ID"
    }
  },
  "required": ["folder_id"]
}
```

### 回傳格式

```markdown
# 資料夾名稱（類型）

> raw data 匯出 | 共 12 筆紀錄 | 匯出於 2026-07-31T12:00:00Z

---

## 紀錄標題

建立：2026-07-31 12:00:00Z

- **欄位1**：值
- **欄位2**：值

紀錄內容...

### 錄音轉文字

**rec.m4a**（起於 12:34）
錄音逐字稿全文...

### 照片（共 3 張）

- photo1.jpg｜錄音 12:34 時拍攝｜分類：設備
  - 照片內文字（AI 擷取）：文字內容...

...
```

### 典型用法

```
user: 把資料夾匯出給我，我要貼給 Claude 彙整
↓
MCP 工具 → export_fieldlog_folder(folder_id=42)
↓ (回傳 Markdown)
user 複製 → 貼給 Claude → 得到報告
```

---

## 工具 5：查詢資料夾（既有）

### 名稱
```
mcp__Mywiki__list_fieldlog_folders
```

### 輸入
無（列表所有）

### 回傳
```json
[
  {
    "id": 1,
    "name": "Medtec 2026 參展",
    "type": "參展",
    "status": "進行中",
    "entry_count": 12
  }
]
```

---

## 工具 6：查詢紀錄（既有）

### 名稱
```
mcp__Mywiki__list_fieldlog_entries
```

### 輸入

```json
{
  "type": "object",
  "properties": {
    "folder_id": { "type": "number" },
    "inbox": { "type": "boolean", "description": "true 時顯示收件匣" }
  }
}
```

### 回傳
```json
[
  {
    "id": 100,
    "folder_id": 1,
    "title": "紀錄標題",
    "created_at": "2026-07-31T12:00:00Z",
    "att_count": 3
  }
]
```

---

## 優先實作順序

| 優先度 | 工具 | 原因 |
|---|---|---|
| 🔴 高 | `get_fieldlog_attachment_raw` | 立即支援 Word 嵌圖 |
| 🟡 中 | `process_fieldlog_batch` | 自動化轉文字 |
| 🟢 低 | `extract_pdf_page` | 進階功能，可後做 |

---

## 認證與配置

### API 基底 URL
```
https://fieldlog.<account>.workers.dev
```

### 認證方式
```
Header: x-pin: <FIELD_PIN>
或
Query:  ?pin=<FIELD_PIN>
```

### 環境變數
```javascript
const FIELDLOG_API = "https://fieldlog.example.workers.dev";
const FIELD_PIN = "<your-pin>";  // 從環境變數或密鑰管理取得
```

---

## 測試檢查清單

- [ ] 小圖片 (jpg <2MB) inline 模式 → base64 可用
- [ ] 大檔案 (>2MB) url 模式 → 簽名 URL 有效
- [ ] 過期 URL → 403 Forbidden
- [ ] 篡改簽名 → 403 Forbidden
- [ ] 批次 5 個混合附件 → 全部轉文字
- [ ] 批次失敗附件 → 繼續處理其他
- [ ] 原始檔內容準確 → base64/URL 有效
- [ ] FIELD_PIN 驗證 → 錯誤時 401

---

## 常見問題

### Q：inline base64 可以直接用在 docx 嗎？
**A：** 可以。Claude 的 docx 工具接受 base64 圖片。

### Q：批次轉文字超時了怎麼辦？
**A：** 分批。一次最多 10-20 個，改用定時任務逐批處理。

### Q：簽名 URL 可以分享給別人嗎？
**A：** 不行。`/api/*` 的 FIELD_PIN 驗證在簽名檢查之前就先擋下來了，所以沒有 PIN 的人拿到簽名 URL 也是 401。
簽名目前的作用是「限定這個 key + 10 分鐘內」，是給已經持有 PIN 的呼叫端（MCP server）用的額外約束，
不是對外分享機制。若之後真的需要免 PIN 的臨時分享連結，要另外把 `/api/file/` 從 PIN 閘門豁免出來，
那是一個需要另外評估的安全決策。

### Q：PDF 分頁提取何時做？
**A：** 框架已預留，實作延後（低優先度）。可先用 pdf.js。

---

## 參考資源

- 後端 API 完整文檔：`fieldlog-api-reference.md`
- 整合指南：`Mywiki-MCP-integration-guide.md`
- 原始 Spec：`MyWiki附件原始檔存取層（Raw Attachment Access）開發規格.md`
