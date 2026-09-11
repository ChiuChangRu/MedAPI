# 維護與部署規則

本文件是 GPT、Claude、其他 AI 代理與人工維護者共同遵守的唯一入口。  
系統細節以程式碼、測試與各目錄 README 為準；若文件與程式碼衝突，先停止部署並修正文檔或程式，不可自行猜測。

## 現役系統（2026-08-12）

以下三個 Worker 目前都在使用，不得因「整理架構」而停用、改成唯讀、改網址、刪除資料或切換正式流量：

| 系統 | 目錄 | 用途 | 狀態 |
|---|---|---|---|
| `medtec-2026` | `cloudflare/` | Medtec 2026 展會團隊共筆 | 現役，展會與報告完成前維持完整功能 |
| `fieldlog` | `fieldlog/` | 隨身記／MyWiki 採集與前台 | 長期現役 |
| `medapi-mcp` | `mcp/` | MyWiki 的 GPT／Claude 問答層 | 長期現役 |

`fieldlog` 與 `medapi-mcp` 合稱 MyWiki，但仍是兩個獨立 Worker；不可合併成單一部署，也不可假設其中一個可以代替另一個。

`docs/` 與 `app/` 是已停用的舊版展場系統，不要修改或重新啟用。

## 不可破壞的契約

1. 所有變更都從 `main` 建立短期分支，經 PR、測試與人工確認後才合併。
2. 禁止直接對正式 Worker 執行 `wrangler deploy`、Promote、Rollback 或切換 Production branch，除非 PR 明確記錄目標版本、驗證結果與回復方案。
3. 三份 `wrangler.jsonc` 的 Worker 名稱、D1/R2/service bindings 與 `keep_vars: true` 是正式環境契約；未完成相依盤點不得更名或移除。
4. `fieldlog` 的 service worker、localStorage 快照、待同步佇列、`syncPending()` 與 `isNetworkError(err)` fallback 必須保留。
5. MyWiki MCP 的內容權限維持預設唯讀；新增工具只能建立新資料。不得新增可修改或刪除記事、附件內容的 MCP 工具。
6. `fieldlog/public/wiki/` 只接受 git PR 與人工審查；AI 不得繞過 PR 自動寫入正式 Wiki。
7. Secrets 不得寫入 repo。部署後必須確認 PIN 驗證仍是 fail-closed。

## 每次修改的固定流程

1. 從 `main` 建立短期分支。
2. 只修改本次需求涉及的目錄；不要順手整理另一個現役系統。
3. 執行：

   ```bash
   npm install
   npm run validate
   ```

4. PR 說明必須列出：
   - 影響哪一個 Worker；
   - 是否改 API、資料表、bindings、快取或離線流程；
   - 驗證方式；
   - 回復方式；
   - 另外兩個 Worker 為何不受影響。
5. 合併後只部署有變更的 Worker，再對三個現役端點做基本健康檢查。

## 最小健康檢查

| 系統 | 合併／部署前後至少確認 |
|---|---|
| `medtec-2026` | 首頁、PIN 登入、主要頁籤、一次讀取；涉及寫入時再測新增與附件 |
| `fieldlog` | PIN 登入、讀取、新增／修改、附件上傳與讀取；涉及離線碼時測斷網寫入與恢復補傳 |
| `medapi-mcp` | MCP 初始化、工具列表、一次唯讀查詢；涉及新增工具時再測只新增、不覆寫既有資料 |

PWA 前端部署後要用強制重新整理或無痕視窗驗證，避免 service worker 快取造成誤判。

## 展會退役條件

目前禁止退役 `medtec-2026`。只有下列條件全部完成，才可另開 PR 討論「唯讀封存」：

- 展會結束且報告完成；
- D1、R2、附件與報告已完成可驗證備份／匯出；
- 已確認 MyWiki 不依賴展會 Worker 或資料庫；
- 舊網址與歷史查詢的處理方式已決定；
- 有明確的回復方案與人工核准。

退役必須是獨立變更，不得混在一般功能 PR 中。

## 文件分工

- 本文件：跨 AI、跨系統的維護與部署規則。
- `GPT-HANDOVER.md`：現有詳細架構、資料表、API 與踩坑紀錄。
- `mcp/CONNECT-GPT.md`：只供連接與使用 MCP，不是部署手冊。
- 各目錄 README：該子系統的局部操作說明。

AI 專用入口檔（例如 `AGENTS.md`、`CLAUDE.md`）只指向本文件與必要技術文件，不複製整套規則，避免內容漂移。
