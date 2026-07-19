# medapi-mcp（跨系統唯讀問答層）

讓 **claude.ai 當你的窗口**：連上這個 MCP Server 之後，直接用自然語言
跨三個來源問答——

| 工具 | 查什麼 | 資料來源 |
|---|---|---|
| `list_wiki_pages`／`read_wiki_page`／`search_wiki` | 策略地圖 Wiki 條目 | fieldlog Worker 的 `/wiki/*`（Service Binding＋PIN） |
| `list_fieldlog_folders`／`search_fieldlog`／`get_fieldlog_entry` | 隨身記紀錄、逐字稿、照片文字 | fieldlog D1（共綁，只下 SELECT） |
| `search_exhibitors`／`get_exhibitor`／`search_visit_notes`／`search_exhibitor_files` | 展商名單＋團隊拜訪共筆＋附件內容全文（逐字稿/OCR） | medtec-2026 D1（共綁）＋ Service Binding 抓 `exhibitors.json` |

**鐵律：全部唯讀。** 程式碼裡只有 SELECT 與 fetch——不寫入、不刪除，
所以三個系統的前台怎麼改版都不受影響；只有**資料表結構**變動時才需要
回頭同步這裡的查詢。

**簡繁互通：** 所有 `search_*` 工具都做「摺疊比對」——查詢字與庫內文字
先正規化（繁→簡、全形→半形、小寫）成同一種形再比對，所以**繁體查得到
簡體庫、簡體查得到繁體庫**（廠商型錄多為簡體、個人記事常為繁體，這一步
把兩邊接起來）。摺疊表在 `src/textFold.js`，是常用字＋領域字精選，要補直接
往 `T2S` 加一對。注意：這只解「同一個字的簡繁差異」，**不解同義詞**
（抗結痂↔抗結晶是不同詞，屬另一層要做的同義詞擴展）。因為 SQL LIKE
無法做簡繁摺疊，這些工具改成「撈候選列→JS 端摺疊過濾」，`SCAN_CAP`
是記憶體保險上限（現階段資料量遠低於此）。

**為什麼是 Service Binding，不是直接 fetch 網址：** 一開始版本是用
`FIELDLOG_URL`／`MEDTEC_URL` 兩個環境變數存對方的 `*.workers.dev` 網址，
runtime 直接 `fetch()`。實測發現 Cloudflare **不允許一個 Worker 用一般
fetch() 打同帳號下另一個 workers.dev Worker**（會拿到 404，即使那個
網址從瀏覽器打完全正常）。改用 `wrangler.jsonc` 的 `services` binding
後，直接呼叫對方 Worker 的程式碼、不經對外網路，這是 Cloudflare 官方
推薦的 Worker 對 Worker 溝通方式，也因此不再需要 `FIELDLOG_URL`／
`MEDTEC_URL` 這兩個變數。

## 部署步驟（約 5 分鐘）

1. **建 Worker**：Cloudflare Dashboard → Workers → Create →
   Continue with GitHub → 選這個 repo 與分支，這個簡化流程沒有獨立的
   「Root directory」欄位，把 **Deploy command** 改成
   `npx wrangler deploy --config mcp/wrangler.jsonc`（Build command 留空）
   （D1 跟 Service Binding 都不用另外建：`wrangler.jsonc` 直接共綁
   fieldlog 與 medtec-2026 既有的資料庫與 Worker 服務；那兩邊若改名或
   換庫，記得回來改這裡的 `database_id`／`service`）
2. **設變數**：Worker 建好後 Settings → Variables and Secrets 新增：
   | 名稱 | 類型 | 值 |
   |---|---|---|
   | `MCP_PIN` | Secret | 這個端點自己的通行碼（自己取，別跟其他 PIN 共用） |
   | `FIELD_PIN` | Secret | 與 fieldlog Worker 的 `FIELD_PIN` 同值（讀 wiki 用） |
3. **驗證**：瀏覽器開 `https://medapi-mcp.<帳號>.workers.dev/` 看到
   「medapi-mcp OK」即部署成功

## 接上 claude.ai（自訂連接器）

1. claude.ai → Settings → Connectors → **Add custom connector**
2. URL 填：
   ```
   https://medapi-mcp.<帳號>.workers.dev/mcp?pin=<你的MCP_PIN>
   ```
   （claude.ai 的自訂連接器不能自帶 header，所以 PIN 掛在 URL 上；
   這條 URL 等同鑰匙，**不要分享給別人**）
3. 之後在對話裡就能直接問：「幫我查展商裡做親水塗層的」「上次實驗
   紀錄裡提到的固化溫度是多少」「wiki 的抗結痂條目現在寫到哪」

Claude Code 也可以連：`claude mcp add --transport http medapi
"https://medapi-mcp.<帳號>.workers.dev/mcp?pin=<PIN>"`。

## 安全設計

- **fail-closed**：`MCP_PIN` 未設定時所有請求一律 401
- PIN 接受三種帶法：`?pin=`／`x-pin` header／`Authorization: Bearer`
- 對 fieldlog 與 medtec 的 D1 是唯讀存取（程式碼層面約束，只有 SELECT）
- wiki 內容經 fieldlog 的 PIN 通道取得，不另存副本；展商主檔
  `exhibitors.json` 本來就是公開靜態資產，runtime 抓取＋記憶體快取 5 分鐘

## 跟其他系統的關係

```
claude.ai / Claude Code
        │  自然語言問答
        ▼
   medapi-mcp（本 Worker，唯讀）
        │
        ├── Service Binding → fieldlog /wiki/*（PIN）      … Wiki 條目
        ├── D1 共綁 → fieldlog DB（SELECT）                … 隨身記紀錄/逐字稿/OCR
        ├── D1 共綁 → medtec-2026 DB（SELECT）             … 拜訪狀態/紀錄/附件清單
        └── Service Binding → medtec /data/exhibitors.json … 展商主檔
```

LitDB 建好之後，在這裡加一組 `search_litdb` 工具就能併入同一個窗口，
不用重新設計。
