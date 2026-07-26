# medapi-mcp（跨系統問答層，預設唯讀）

讓 **claude.ai 當你的窗口**：連上這個 MCP Server 之後，直接用自然語言
跨三個來源問答——

| 工具 | 查什麼 | 資料來源 |
|---|---|---|
| `list_wiki_pages`／`read_wiki_page`／`search_wiki` | 策略地圖 Wiki 條目 | fieldlog Worker 的 `/wiki/*`（Service Binding＋PIN） |
| `list_fieldlog_folders`／`list_fieldlog_entries`／`list_attachments` | 目錄層：資料夾、資料夾底下的紀錄與附件檔名清單，不用猜關鍵字 | fieldlog D1（共綁，只下 SELECT） |
| `search_fieldlog`／`get_fieldlog_entry`／`get_fieldlog_attachment` | 隨身記紀錄、逐字稿、照片文字、附件全文（超長時可分段讀）——含每日同步進來的 LitDB 文獻/專利與 AI 深度解析內容（見下方說明） | fieldlog D1（共綁，只下 SELECT） |
| `get_related` | 兩筆記事之間的關聯（交叉比對） | fieldlog D1 的 `relations` 表 |
| `create_fieldlog_entry`／`create_relation` | 可寫入工具（之一、之二）：新增一筆記事／建立兩筆記事的關聯 | fieldlog D1（只 INSERT，見下方說明） |
| `search_exhibitors`／`get_exhibitor`／`search_visit_notes`／`search_exhibitor_files`／`list_exhibitor_files` | 展商名單＋團隊拜訪共筆＋附件內容全文（逐字稿/OCR）＋不用猜關鍵字的附件目錄 | medtec-2026 D1（共綁）＋ Service Binding 抓 `exhibitors.json` |
| `sync_status` | 外部知識庫（litdb 等）的最後同步時間與最近同步紀錄——懷疑資料過時直接查事實 | fieldlog D1 的 `sources`／`sync_log` 表 |
| `add_synonym` | **第三支能寫入的工具**：搜不到但確定是「用詞沒對上」時，當場補一組同義詞對照，立刻生效 | fieldlog D1 的 `synonyms` 表（只 INSERT） |

> **LitDB（`chiuchangru/litdb`，長儒另一個獨立文獻/專利知識庫）已併入
> fieldlog**（2026-07-26，「LitDB 文獻庫」資料夾，152 筆親水塗層／活檢針
> 機構／醫材包裝資料，只搬文字不下載 PDF），並由 fieldlog 的每日 cron
> 自動同步（sources 表驅動，見 `fieldlog/src/lib/sync.js`）。原本在這裡
> 加過三支即時查詢工具，為了產品單一化已經拿掉——直接用 `search_fieldlog`／
> `list_fieldlog_entries` 查就好。litdb 的 `patentResults`（配方、FTO 風險、
> 迴避設計）存進 `analysis_json`，搜尋掃得到，呈現時會明確標示是 AI 產出。

> **先列目錄、再決定要不要細看，別一開始就猜關鍵字。** `search_*` 查不到不代表
> 沒有這份資料，可能只是關鍵字沒猜對——2026-07-25 實測發現的最大瓶頸正是
> AI 沒有「看得見架上有什麼」的工具，只能反覆猜詞，猜不中就誤判成「沒有資料」。
> `list_fieldlog_entries`／`list_attachments`／`list_exhibitor_files` 就是為此而加。

**鐵律：預設唯讀，例外全部鎖死在「只能新增」。** 其餘 16 個工具程式碼裡
只有 SELECT 與 fetch；`create_fieldlog_entry`／`create_relation`／
`add_synonym` 是僅有的三支會寫入的工具，各自只做一次 INSERT，
程式碼裡沒有任何 `UPDATE`／`DELETE` 語句碰得到 entries／attachments／
folders／relations／synonyms——也就是說就算透過 claude.ai 對話下指令，
也不可能改掉或刪掉既有的任何一筆資料，只能加新的。想改內容、刪東西，
一律要回隨身記前台親自操作；wiki 收錄一律走 git 人審。（外部來源的同步
更新走 fieldlog 自己的 cron，不經過 MCP。）三個系統的前台怎麼改版
都不受影響；只有**資料表結構**變動時才需要回頭同步這裡的查詢。

## 搜尋怎麼比對（五個 `search_*` 工具共用同一套）

比對層在 `src/search.js`，三件事依序做：

**1. 空白斷詞（AND，掛零降級 OR）**
多個關鍵字用空白隔開即可（半形／全形／tab／連續空白都算分隔），預設
**全部詞都要命中**；找不到同時符合的才自動放寬成「任一詞命中」，並在回應
開頭標示「以下為部分符合」。中文不含空白時維持整串比對。

> 這一段原本是 bug：舊版把整個查詢字當「一整串」去比對子字串，所以
> 「7886 注射器」會去找帶空格的連續子字串 `7886 注射器`。檔名實際長相是
> `ISO_7886-1_2017_無菌皮下注射器…`，兩個詞都在裡面卻永遠比不到，而且
> 靜默無錯。五個工具當時共用同一段比對，所以全部中。

**2. 同義詞展開**
對照表在 fieldlog D1 的 `synonyms` 表（2026-07-26 起；`src/synonyms.json`
降級為出廠預設值＋D1 讀不到時的 fallback，第一次使用會自動 seed 進資料表）。
每一組把「正式標準名 ＋ 慣用語 ＋ 英文 ＋ 標準編號」綁在一起，查任一個成員
就會一併去找同組其他成員——文件寫「體外血液處理用導管」、人查「HD管」，
字面零重疊也找得到。**要補一組直接在對話裡用 `add_synonym` 工具**，補完
下一次查詢立刻生效，不用改程式碼、不用重新部署；要幫既有的組加講法，
canonical 填同一個名稱再給新的 aliases 即可（載入時自動合併）。

排序：**原詞命中永遠排在同義詞展開命中前面**，其次命中詞數多者優先。
所以單詞查詢只會「多找到」不會「少找到」。

**3. 簡繁／全半形摺疊**
查詢字與庫內文字都先正規化（繁→簡、全形→半形、小寫）成同一種形再比對，
所以**繁體查得到簡體庫、簡體查得到繁體庫**（廠商型錄多為簡體、個人記事常為
繁體）。摺疊表在 `src/textFold.js`，是常用字＋領域字精選，要補直接往 `T2S`
加一對。這只解「同一個字的簡繁差異」；「不同的詞講同一件事」由上面第 2 步處理。

因為 SQL LIKE 無法做簡繁摺疊，這些工具是「撈候選列→JS 端摺疊過濾」，
`SCAN_CAP` 是記憶體保險上限（現階段資料量遠低於此）。

**查無結果會誠實回報**：說出斷成哪幾個詞、展開後實際查了哪些詞、哪些詞
不在同義詞表裡（並提示可以自己補一組）。這是刻意的——只回一句「查無」的話，
使用者分不出「資料庫真的沒有」還是「有、但用詞沒對上」。

**向量／語意搜尋：決議不做**（理由與保留條件見 `HANDOVER.md` 搜尋層那一節）。
回歸測試在 `tests/search-tokenize.test.js`，44 個案例，日後要動搜尋請先跑它。

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

**接 ChatGPT／GPT** 的連接器設定步驟與完整工具清單見 [`CONNECT-GPT.md`](./CONNECT-GPT.md)。

## 安全設計

- **fail-closed**：`MCP_PIN` 未設定時所有請求一律 401
- PIN 接受三種帶法：`?pin=`／`x-pin` header／`Authorization: Bearer`
- 對 fieldlog 與 medtec 的 D1 幾乎全是唯讀存取（程式碼層面約束，只有
  SELECT）；`create_fieldlog_entry`／`create_relation`／`add_synonym` 是
  僅有的三個例外，範圍鎖死在「只能 INSERT 一筆全新的記事／關聯／同義詞
  對照」，沒有任何工具能 UPDATE 或 DELETE 既有資料——改內容、刪東西
  一律要回前台
- wiki 內容經 fieldlog 的 PIN 通道取得，不另存副本；展商主檔
  `exhibitors.json` 本來就是公開靜態資產，runtime 抓取＋記憶體快取 5 分鐘

## 跟其他系統的關係

```
claude.ai / Claude Code / ChatGPT
        │  自然語言問答
        ▼
   medapi-mcp（本 Worker，預設唯讀）
        │
        ├── Service Binding → fieldlog /wiki/*（PIN）      … Wiki 條目
        ├── D1 共綁 → fieldlog DB（幾乎全 SELECT，僅 3 支工具 INSERT）… 隨身記紀錄/逐字稿/OCR/關聯/每日同步的 LitDB 文獻/同義詞表/同步紀錄
        ├── D1 共綁 → medtec-2026 DB（SELECT）             … 拜訪狀態/紀錄/附件清單
        └── Service Binding → medtec /data/exhibitors.json … 展商主檔
```

LitDB（`chiuchangru/litdb`）曾經短暫用一般 `fetch()` 即時查詢它的 GitHub
Pages 公開 JSON，但 2026-07-26 為了產品單一化改為併入 fieldlog：資料由
fieldlog 的每日 cron 從 litdb 的公開 JSON 單向同步進 fieldlog D1（sources
表驅動，見 `fieldlog/src/lib/sync.js`），這個 MCP 不再對 litdb 做任何查詢，
`mcp/src/litdb.js` 已刪除。同步狀態用 `sync_status` 工具查。
