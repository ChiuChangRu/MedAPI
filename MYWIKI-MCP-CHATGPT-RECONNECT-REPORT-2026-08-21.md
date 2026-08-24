# MyWiki MCP 重新連接修正報告（2026-08-21）

## 目標

重新處理 ChatGPT 連接 `https://medapi-mcp.gogoyankee.workers.dev/mcp` 時，授權頁輸入 PIN 後沒有完成連接，以及先前曾出現 `CSRF validation failed` 的問題。

## 已確認的根因

舊授權頁使用 double-submit Cookie 驗證 CSRF。ChatGPT 的授權頁可能開在分割瀏覽器環境，瀏覽器即使收到 `SameSite=None; Partitioned` Cookie，仍可能不在表單 POST 時送回，因此正確輸入 PIN 也會被 Worker 拒絕。

另外，原實作只有 DCR。DCR 仍受 ChatGPT 支援，但目前官方優先建議 Client ID Metadata Document（CIMD），並要求完整的 issuer identification、PKCE 與 `resource` 驗證。

## 程式修正

### 1. 新增 CIMD，相容保留 DCR

- OAuth metadata 新增 `client_id_metadata_document_supported: true`。
- 僅允許讀取 `https://chatgpt.com/oauth/.../client.json` 形式的官方 ChatGPT client metadata，避免任意 URL 形成 SSRF。
- 驗證 metadata 的 redirect URI 與 public-client `none` token authentication method。
- 原本 DCR `/register` 流程保留，不影響舊連接器。

### 2. 修正授權頁 CSRF 判斷

- CSRF nonce 的 SHA-256 雜湊寫進伺服器簽章的短效 request token。
- 表單 POST 必須先通過簽章 nonce 驗證。
- Cookie 有送回時維持原驗證；Cookie 被嵌入式瀏覽器擋下時，允許相同來源的表單 POST 通過。
- 跨站 Origin 且沒有有效 Cookie 時仍拒絕，不是直接移除 CSRF 防護。

### 3. 補齊 issuer identification

- OAuth metadata 新增 `authorization_response_iss_parameter_supported: true`。
- 成功與拒絕的 authorization response 都回傳完全相同的 `iss`。
- `resource`、PKCE S256、redirect URI、token audience 與 scope 驗證維持不變。

### 4. 可觀測性

- MCP server version 更新為 `1.1.0`。
- 健康檢查頁會顯示 `OAuth 2.1 CIMD＋DCR`，方便確認正式 Worker 是否已部署新版。

## 測試

- OAuth discovery：protected-resource、issuer、CIMD、DCR、PKCE。
- 完整 DCR authorization-code + PKCE + token + MCP initialize。
- 完整 CIMD authorization-code + PKCE + token + MCP initialize。
- 模擬 Cookie 被封鎖，同源表單仍能授權。
- 模擬跨站 POST，仍回 `CSRF validation failed`。
- authorization code 不可重放。
- 舊 PIN query/header/bearer 相容性。
- MCP tool annotations 與 plugin package 檢查。

## ChatGPT 端重新連接

1. 刪除或中斷舊的 MyWiki 草稿連接器，避免沿用舊 client/token cache。
2. 開啟 Developer mode。
3. 新增 developer-mode app，Server URL 只填 `https://medapi-mcp.gogoyankee.workers.dev/mcp`。
4. 驗證選 OAuth；優先 CIMD，沒有 CIMD 才選 DCR。
5. PIN 只在 MyWiki Worker 的授權頁輸入。
6. 授權完成後重新整理工具清單，再以唯讀查詢測試。

## 仍需實機確認

本地測試可證明 OAuth 與 MCP 協定流程完整，但 ChatGPT 帳號中的 app 安裝、瀏覽器回呼和工具快取仍屬平台端狀態，必須在部署後由帳號本人完成一次授權。不要以「看到授權頁」當作成功；要以 ChatGPT 能列出 MyWiki 工具並成功執行唯讀查詢為準。
