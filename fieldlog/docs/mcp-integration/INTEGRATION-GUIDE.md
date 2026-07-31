# Mywiki MCP Server - fieldlog 工具集成指南

**目標**：在 Mywiki MCP Server 中接線兩個 fieldlog 工具，使 Claude 可以調用附件 API。

---

## 1. 前置條件

- ✅ fieldlog Worker 已部署，API 可用（`FIELDLOG_API` 地址已知）
- ✅ `FIELD_PIN` 已設定（Secret 值）
- ✅ Mywiki MCP Server 源代碼已可修改
- ⏳ Python 版本（推薦 3.8+）或 Node.js 版本（18+）

---

## 2. 快速開始（選擇一種語言）

### 方案 A：Python (FastAPI + MCP SDK)

#### 2.1 安裝依賴

```bash
pip install httpx mcp
# 或
pip install httpx "@modelcontextprotocol/sdk"
```

#### 2.2 複製實現檔案

將 `mcp-fieldlog-tools-implementation.py` 複製到 Mywiki MCP Server 專案：

```bash
cp mcp-fieldlog-tools-implementation.py /path/to/mywiki-mcp-server/tools/
```

#### 2.3 設定環境變數

```bash
export FIELDLOG_API="https://fieldlog.<account>.workers.dev"
export FIELD_PIN="<your-pin>"
```

或在 `.env` 檔案中：

```
FIELDLOG_API=https://fieldlog.example.workers.dev
FIELD_PIN=your-secret-pin
```

#### 2.4 在 MCP Server 中註冊工具

編輯 `mywiki_mcp_server/tools.py`（或相應的工具註冊檔）：

```python
from tools.mcp_fieldlog_tools_implementation import (
    get_fieldlog_attachment_raw,
    process_fieldlog_batch,
    TOOLS_DEFINITIONS
)

# 在工具列表中新增
ALL_TOOLS = [
    # ... 既有工具 ...
    {
        "name": "get_fieldlog_attachment_raw",
        "definition": TOOLS_DEFINITIONS[0],
        "handler": get_fieldlog_attachment_raw
    },
    {
        "name": "process_fieldlog_batch",
        "definition": TOOLS_DEFINITIONS[1],
        "handler": process_fieldlog_batch
    }
]

# 在 tool_handler 函數中新增分支
async def handle_tool_call(name: str, arguments: dict):
    if name == "get_fieldlog_attachment_raw":
        return await get_fieldlog_attachment_raw(
            id=arguments.get("id"),
            mode=arguments.get("mode", "url")
        )
    elif name == "process_fieldlog_batch":
        return await process_fieldlog_batch(
            folder_id=arguments.get("folder_id"),
            entry_id=arguments.get("entry_id")
        )
    # ... 其他工具 ...
```

#### 2.5 本地測試

```bash
# 測試 1：取圖片 (inline)
python tools/mcp_fieldlog_tools_implementation.py test-inline 266

# 測試 2：取檔案 (url)
python tools/mcp_fieldlog_tools_implementation.py test-url 267

# 測試 3：批量轉文字
python tools/mcp_fieldlog_tools_implementation.py test-batch 42
```

---

### 方案 B：Node.js (Express + MCP SDK)

#### 2.1 安裝依賴

```bash
npm install @modelcontextprotocol/sdk
# 若需要 node-fetch（Node <18）
npm install node-fetch
```

#### 2.2 複製實現檔案

```bash
cp mcp-fieldlog-tools-implementation.js /path/to/mywiki-mcp-server/tools/
```

#### 2.3 設定環境變數

`.env` 或 `docker-compose.yml`：

```
FIELDLOG_API=https://fieldlog.example.workers.dev
FIELD_PIN=your-secret-pin
```

#### 2.4 在 MCP Server 中註冊工具

編輯 `server.js` 或 `src/server.ts`：

```javascript
import {
  getFieldlogAttachmentRaw,
  processFieldlogBatch,
  TOOLS_DEFINITIONS
} from "./tools/mcp-fieldlog-tools-implementation.js";

const server = new Server({
  name: "mywiki-mcp",
  version: "1.0.0"
});

// 列出所有工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ... 既有工具定義 ...
    ...TOOLS_DEFINITIONS
  ]
}));

// 調用工具
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request;

  if (name === "get_fieldlog_attachment_raw") {
    const result = await getFieldlogAttachmentRaw(args.id, args.mode);
    if (result.type === "image") {
      return {
        content: [{
          type: "image",
          data: result.source.data,
          mimeType: result.source.media_type
        }]
      };
    } else {
      return {
        content: [{ type: "text", text: result.text }]
      };
    }
  }

  if (name === "process_fieldlog_batch") {
    const result = await processFieldlogBatch(args.folder_id, args.entry_id);
    return {
      content: [{ type: "text", text: result.text }]
    };
  }

  // ... 其他工具 ...
});
```

#### 2.5 本地測試

```bash
# 測試 1：取圖片 (inline)
node tools/mcp-fieldlog-tools-implementation.js test-inline 266

# 測試 2：取檔案 (url)
node tools/mcp-fieldlog-tools-implementation.js test-url 267

# 測試 3：批量轉文字
node tools/mcp-fieldlog-tools-implementation.js test-batch 42
```

---

## 3. 集成驗證檢查清單

完成上述步驟後，逐項驗證：

- [ ] **環境變數正確**
  ```bash
  echo $FIELDLOG_API
  echo $FIELD_PIN
  # 應該回傳實際值，不是空
  ```

- [ ] **Python 依賴安裝**
  ```bash
  python -c "import httpx; print(httpx.__version__)"
  ```

- [ ] **Node.js 依賴安裝**
  ```bash
  npm list @modelcontextprotocol/sdk
  ```

- [ ] **工具定義可見**
  - 啟動 MCP Server
  - 在 Claude 中呼叫 `tools_available` 或類似指令
  - 應該能看到 `get_fieldlog_attachment_raw` 和 `process_fieldlog_batch`

---

## 4. 功能測試（測試檢查清單）

### 測試 4.1：小圖片 inline 模式

```
Claude: 請用 get_fieldlog_attachment_raw 取得附件 266，mode=inline
↓
MCP → fieldlog Worker: GET /api/attachments/266/raw?mode=inline
↓
回傳：base64 圖片
↓
驗證：圖片可在對話中顯示，可嵌入 docx
```

**預期結果**：✅ 圖片顯示正常，base64 大小合理（<2MB）

---

### 測試 4.2：大檔案 url 模式

```
Claude: 請用 get_fieldlog_attachment_raw 取得附件 267，mode=url
↓
MCP → fieldlog Worker: GET /api/attachments/267/raw?mode=url
↓
回傳：簽名 URL + 到期時間
↓
驗證：URL 可訪問，含 expires_at 時間戳
```

**預期結果**：✅ URL 有效期內可下載，過期時間正確

---

### 測試 4.3：簽名 URL 過期驗證

```
1. 取得簽名 URL（Test 4.2）
2. 等待 10+ 分鐘
3. 嘗試訪問該 URL
```

**預期結果**：❌ 403 Forbidden（過期）

---

### 測試 4.4：批量轉文字

```
Claude: 請用 process_fieldlog_batch 處理資料夾 42
↓
MCP → fieldlog Worker: POST /api/batch/process-attachments
       Body: {"folder_id": 42}
↓
回傳：處理結果清單（成功/失敗）
↓
驗證：摘要文字含 emoji、計數準確、失敗附件有錯誤訊息
```

**預期結果**：✅ 返回結果清單，format 正確

---

### 測試 4.5：單一附件失敗不中斷

```
Claude: 處理資料夾，其中有損壞的照片
↓
预期：損壞照片失敗，其他附件繼續處理
↓
驗證：結果中有失敗記錄，但 success_count > 0
```

**預期結果**：✅ 失敗附件標記為失敗，其他照常處理

---

### 測試 4.6：認證測試（FIELD_PIN 錯誤）

```
1. 臨時修改 FIELD_PIN 為錯誤值
2. 嘗試呼叫任一工具
```

**預期結果**：❌ 401 Unauthorized

---

### 測試 4.7：認證測試（FIELD_PIN 缺失）

```
1. 未設定 FIELD_PIN 環境變數
2. 嘗試啟動 MCP Server
```

**預期結果**：❌ 啟動失敗，錯誤訊息提及 FIELD_PIN

---

## 5. 典型使用案例

### 場景 1：Word 報告嵌圖

```
user: 幫我把 fieldlog 附件 #266 的照片嵌進 Word 報告

Claude:
1. 呼叫 get_fieldlog_attachment_raw(id=266, mode="inline")
   → 得到 base64 圖片
2. 用 docx 工具 insert_image
   → 圖片嵌入報告
3. 完成！
```

### 場景 2：整理資料夾

```
user: 幫我把資料夾 #42 的所有照片和錄音都轉文字

Claude:
1. 呼叫 process_fieldlog_batch(folder_id=42)
   → Worker 掃描、轉文字、OCR
   → 返回結果清單
2. 摘要進度給用戶
3. 後續 export/folder 時已包含所有文字
```

### 場景 3：驗證簽名 URL

```
Claude 取得簽名 URL 後，記錄到期時間，
在 10 分鐘內提醒用戶 "請盡快下載"
```

---

## 6. 常見問題 & 排查

### Q1：`FIELDLOG_API` 連線失敗

**症狀**：呼叫工具返回 "Failed to get attachment: [connection error]"

**排查**：
```bash
# 1. 檢查 API URL
curl -H "x-pin: $FIELD_PIN" "https://fieldlog.example.workers.dev/api/config"
# 應該回傳 JSON，不是 404

# 2. 檢查 PIN 正確性
# 若回傳 {"error": "..."} 且狀態 401，PIN 錯誤
```

---

### Q2：`mode=inline` 回傳 `{"error": "..."}` (不是 base64)

**症狀**：期望圖片，實際回傳錯誤

**排查**：
```bash
# 檢查附件大小是否超過 2MB
curl -I "https://fieldlog.example.workers.dev/api/file/12/..."
# Content-Length 應 < 2097152
```

---

### Q3：過期時間計算錯誤

**症狀**：10 分鐘後 URL 仍可訪問

**排查**：
```bash
# 檢查 Worker 伺服器時間是否同步
# 若時間偏差過大，會影響簽名驗證
```

---

### Q4：批量轉文字超時（Timeout）

**症狀**：附件超過 20 個，工具回傳超時

**排查**：
```
Worker 限制 30 秒超時
→ 建議一次最多 10-20 個附件
→ 分批處理：for folder in folders: process_batch(folder_id)
```

---

## 7. 部署前檢查清單

- [ ] 環境變數已設定（`FIELDLOG_API`、`FIELD_PIN`）
- [ ] 依賴已安裝（httpx / @modelcontextprotocol/sdk）
- [ ] 代碼已複製到正確位置
- [ ] MCP Server 已註冊兩個工具定義
- [ ] 本地測試通過（test-inline / test-url / test-batch）
- [ ] 認證測試通過（正確 PIN / 錯誤 PIN / 缺失 PIN）
- [ ] API 端點可訪問（curl 測試）
- [ ] 簽名 URL 過期驗證通過（10 分鐘後 403）

---

## 8. 部署步驟

### 8.1 Staging 環境

```bash
# 1. 部署到測試環境
docker-compose -f docker-compose.test.yml up -d

# 2. 執行完整測試套件
./run-tests.sh

# 3. 檢查日誌
docker logs mywiki-mcp-server
```

### 8.2 Production 環境

```bash
# 1. 備份既有 MCP Server 配置
cp -r mywiki-mcp-server mywiki-mcp-server.backup

# 2. 部署新代碼
docker-compose -f docker-compose.yml up -d

# 3. 驗證工具可見
curl http://localhost:3000/api/tools

# 4. 簡單健康檢查
curl -X POST http://localhost:3000/api/tools/get_fieldlog_attachment_raw \
  -d '{"id": 1, "mode": "url"}'
```

---

## 9. 後續優化

- [ ] 添加工具調用日誌（成功/失敗）
- [ ] 實作工具超時重試邏輯
- [ ] 添加批量工具進度追蹤（當前 N/總數 M）
- [ ] 為大檔案下載添加進度條
- [ ] 實現 PDF 分頁提取（低優先度）

---

## 10. 參考資源

- **API 完整文檔**：`fieldlog-api-reference.md`
- **工具規格**：`mcp-tools-definition.md`
- **Python 實現**：`mcp-fieldlog-tools-implementation.py`
- **Node.js 實現**：`mcp-fieldlog-tools-implementation.js`
- **原始規格**：`MyWiki附件原始檔存取層開發規格.md`
