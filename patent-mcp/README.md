# patent-mcp（USPTO 美國專利唯讀查詢）

Cloudflare Worker 版的 MCP Server，改寫自
[riemannzeta/patent_mcp_server](https://github.com/riemannzeta/patent_mcp_server)（MIT，v1.8.1）
的 Patent Public Search（ppubs.uspto.gov）部分。**不需要 USPTO API key。**

| 工具 | 用途 |
|---|---|
| `patent_search` | 全文檢索（核准專利／公開申請案），USPTO BRS 語法 |
| `patent_get` | 用專利號取全文，可只取書目／摘要／請求項／說明書 |
| `patent_get_document` | 用檢索結果的 guid 取全文（公開申請案用這支） |
| `patent_citing` | 被引用：後來引用這件的核准專利 |

只涵蓋美國。審查歷程（ODP）、PTAB、商標需要另外申請 key，這版沒做。

## 部署（比照 medapi-mcp 的 Git 連動）

1. Cloudflare Dashboard → Workers & Pages → Create → **Import a repository** → 選 `ChiuChangRu/MedAPI`
2. 設定：
   - Project name：`patent-mcp`
   - Production branch：`patent-mcp`
   - Root directory：（留空＝repo 根目錄）
   - Build command：（留空）
   - Deploy command：`npx wrangler deploy --config patent-mcp/wrangler.jsonc`
3. 部署完成後 → 這個 Worker → Settings → Variables and Secrets → 新增 **Secret** `MCP_PIN`（自訂通行碼）
4. 健康檢查：瀏覽器開 `https://patent-mcp.<你的子網域>.workers.dev/` → 應顯示「patent-mcp OK … 工具數：4」

## 接到 claude.ai

Settings → Connectors → Add custom connector：
- 名稱：`USPTO Patents`（醫材統計網頁會用這個名稱呼叫，請照打）
- URL：`https://patent-mcp.<你的子網域>.workers.dev/mcp?pin=<MCP_PIN>`

## 驗證方式

`?pin=`、`x-pin` header 或 `Authorization: Bearer <MCP_PIN>` 擇一。MCP_PIN 沒設定時一律 401。
`wrangler.jsonc` 有 `keep_vars: true`，重新部署不會清掉 Secret。

## 測試

`node patent-mcp/test/mock.test.mjs`：用假的 USPTO 回應測 MCP 協定、PIN、session／cookie、
403 重建、工具輸出整理（16 項）。**不連網**——實際能不能從 Cloudflare 連到 USPTO，要部署後實測。

## 已知風險

- ppubs 是 USPTO 網頁內部 API，沒有官方文件，USPTO 改版就可能失效（原專案也是同樣做法）。
- USPTO 有限流（HTTP 429）；遇到時會等一次再試。
