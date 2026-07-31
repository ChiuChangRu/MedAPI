# fieldlog MCP 工具集成

> Mywiki MCP Server 接線方案：把 fieldlog Worker API 連接到 Claude MCP 工具系統

---

## 📋 文件清單

| 檔案 | 用途 | 對象 |
|---|---|---|
| **INTEGRATION-GUIDE.md** | 🔧 **【必讀】** 完整集成步驟、測試檢查清單、排查指南 | Mywiki 開發人員 |
| **mcp-fieldlog-tools-implementation.py** | 🐍 Python 實現（推薦用 FastAPI + httpx） | Mywiki MCP Server (Python) |
| **mcp-fieldlog-tools-implementation.js** | 🟨 Node.js 實現（推薦用 Express + MCP SDK） | Mywiki MCP Server (Node.js) |
| **fieldlog-api-reference.md** | 📖 後端 API 完整參考（12 章） | AI / 開發人員 |
| **mcp-tools-definition.md** | 🔌 MCP 工具規格定義（6 工具） | AI / 開發人員 |

---

## 🚀 快速開始（5 分鐘）

### 1. 環境設定

```bash
# 在 Mywiki MCP Server 專案中設定
export FIELDLOG_API="https://fieldlog.<account>.workers.dev"
export FIELD_PIN="<your-pin>"
```

### 2. 選擇語言並驗證

**Python**：
```bash
python mcp-fieldlog-tools-implementation.py test-inline 266
```

**Node.js**：
```bash
node mcp-fieldlog-tools-implementation.js test-inline 266
```

### 3. 集成到 MCP Server

參照 `INTEGRATION-GUIDE.md` 的「2. 快速開始」章節，複製代碼、註冊工具定義

---

## 🔧 新增的兩個工具

### 工具 1：`get_fieldlog_attachment_raw`

取得 fieldlog 附件的原始檔案（圖片或 PDF）

**參數**：
- `id` (number) - attachment ID
- `mode` (string, optional) - `"inline"` | `"url"` (預設 `"url"`)

**典型用法**：
```
user: 把 fieldlog 附件 #266 的照片嵌進 Word 報告
↓
Claude 呼叫 get_fieldlog_attachment_raw(id=266, mode="inline")
↓ (回傳 base64)
Claude 用 docx 工具嵌入圖片
↓ 完成！
```

---

### 工具 2：`process_fieldlog_batch`

自動為資料夾或紀錄內未處理附件觸發 OCR 和語音轉文字

**參數**：
- `folder_id` (number, optional) - 資料夾 ID
- `entry_id` (number, optional) - 紀錄 ID（二選一）

**典型用法**：
```
user: 幫我把資料夾 #42 的所有照片和錄音都轉文字
↓
Claude 呼叫 process_fieldlog_batch(folder_id=42)
↓ (Worker 掃描、轉文字、OCR)
返回結果清單
↓ 完成！
```

---

## 📖 後端 API 對應

| MCP 工具 | 後端 API | 狀態 |
|---|---|---|
| `get_fieldlog_attachment_raw` | `GET /api/attachments/:id/raw` | ✅ 已實作 |
| `process_fieldlog_batch` | `POST /api/batch/process-attachments` | ✅ 已實作 |

見 `fieldlog-api-reference.md` 完整文檔

---

## ✅ 集成檢查清單

完成集成後，按下列順序驗證：

1. **環境變數**：`FIELDLOG_API` 和 `FIELD_PIN` 已設定
2. **依賴**：httpx (Python) 或 @modelcontextprotocol/sdk (Node.js) 已安裝
3. **工具定義**：MCP Server 可列出兩個新工具
4. **Test 4.1**：小圖片 inline 模式 → base64 可顯示
5. **Test 4.2**：大檔案 url 模式 → 簽名 URL 有效
6. **Test 4.3**：簽名 URL 過期驗證 → 10 分鐘後 403
7. **Test 4.4**：批量轉文字 → 結果正確
8. **Test 4.5**：失敗恢復 → 單一附件失敗不中斷其他
9. **Test 4.6**：認證 (PIN 錯誤) → 401
10. **Test 4.7**：認證 (PIN 缺失) → 啟動失敗

詳細步驟見 `INTEGRATION-GUIDE.md` 第 4 章「功能測試」

---

## 📚 更多資源

- **fieldlog 架構**：見 `CLAUDE.md`（repo root）
- **fieldlog Worker 代碼**：`fieldlog/src/worker.js`
- **MCP 原始規格**：見 project uploads 中的 `MyWiki附件原始檔存取層開發規格.md`

---

## 🔄 版本歷史

| 日期 | 版本 | 說明 |
|---|---|---|
| 2026-07-31 | 1.0 | 初版發佈：原始檔存取 + 批量轉文字 |

---

## 🤝 支援與回報

若集成過程中發現問題：

1. 檢查 `INTEGRATION-GUIDE.md` 的「6. 常見問題 & 排查」
2. 驗證 API 連線：`curl -H "x-pin: $FIELD_PIN" "$FIELDLOG_API/api/config"`
3. 本地測試：`python mcp-fieldlog-tools-implementation.py test-*`
4. 若仍有問題，記錄錯誤訊息與環境，提交 issue

---

**準備好了嗎？** 📖 從 `INTEGRATION-GUIDE.md` 開始！
