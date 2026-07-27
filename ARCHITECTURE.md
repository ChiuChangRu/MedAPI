# 整體架構：知識採集系統（詳盡版）

> 這份文件記錄「隨身記＋參展系統＋策略地圖 Wiki＋LitDB」彼此的關係、
> 已經定案的設計決策，以及目前待改的方向。給未來的自己/AI 快速對齊全貌用，
> 不是給同事看的操作說明（操作說明在各子專案自己的 README）。

## 一、系統地圖（現況）

```
                          ┌─────────────────────────┐
                          │   策略地圖 Wiki（知識層）  │
                          │  fieldlog/public/wiki/    │
                          │  純 Markdown，git 版控     │
                          │  A/B/C 條目 + pages.json  │
                          └────────────▲──────────────┘
                                       │ 人審 git diff 後收錄
                                       │（AI 不可直接寫入生產內容）
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     ┌────────┴────────┐     ┌─────────┴─────────┐     ┌────────┴────────┐
     │  隨身記 fieldlog  │     │ Medtec 參展系統     │     │  LitDB           │
     │  個人現場採集      │     │  cloudflare/        │     │  chiuchangru/litdb│
     │  獨立 Worker+D1+R2 │     │  9人團隊共筆         │     │  GitHub Pages 靜態│
     └───────────────────┘     │  獨立 Worker+D1+R2   │     │  網站，無後端      │
                                └─────────────────────┘     └─────────────────┘
```

四個系統**各自獨立**：不同 Worker（或完全在自己帳號外的 GitHub Pages）、
不同 D1、不同 R2，互不影響、互不依賴。Wiki 是唯一的「匯流點」，靠人工＋AI
協作把各源頭的原始資料編譯成有結構的知識條目。**沒有、也決定不做雙向的
跨系統資料庫合併**——唯一的資料流入是「外部來源單向同步」：fieldlog 的
sources 表登記了哪些公開 JSON（目前是 litdb 三個收藏），每天凌晨 cron
單向拉文字進隨身記（content hash 判斷有沒有變，沒變不動、變了只改寫
同步區、人工註記永不覆蓋），詳見第二節之 D 與 `fieldlog/src/lib/sync.js`。
litdb 那邊照它自己的方式活著，隨身記永遠不寫回去。

## 二、各子系統詳細架構

### A. 隨身記（`fieldlog/`）—— 個人現場採集

- **定位**：參展／拜訪／實驗／上課的原始資料採集器（錄音、照片、速記），
  AI 事後彙整成報告，人再貼進 Notion
- **技術棧**：Cloudflare Worker + D1（SQLite）+ R2（檔案）+ Workers AI
  （Whisper 轉錄、圖片 OCR）
- **資料表**：
  | 表 | 用途 |
  |---|---|
  | `folders` | 活動/工作項目，`type` 決定欄位模板 |
  | `entries` | 一筆紀錄，`folder_id` 空＝收件匣 |
  | `attachments` | 照片/錄音段/檔案（存 R2），`offset_secs` 記錄「錄音第幾秒拍的」，`transcript`/`ocr_text` 存 AI 處理結果 |
  | `history` | append-only 歷程 |
- **驗證**：`FIELD_PIN`（Secret）比對，fail-closed（PIN 未設一律拒絕）
- **核心流程**：現場錄音/拍照/速記 → 「🪄 一鍵整理」批次轉文字＋OCR
  （先錄音後照片，照片靠 `offset_secs` 對應到同一段錄音的逐字稿，
  AI 判斷對話關聯）→ 資料夾「匯出給 AI」產出 Markdown 原料包 → 人貼給
  Claude/GPT 彙整成報告 → 存進 Notion
- **未完成／死代碼**：`folders` 表已有 `notion_page_id`／
  `notion_last_entry_id`／`notion_synced_at` 欄位，`parseNotionPageId()`
  也寫好了，但**目前沒有任何 API 路徑呼叫它**——Notion 自動同步只做了一半，
  現在還是「人工貼上」

### B. Medtec 參展系統（`cloudflare/`）—— 團隊共筆

- **定位**：9 位同事出發前瀏覽展商名單、篩選分類、留言洽談需求；
  現場則記錄拜訪狀態、部門標籤、資質確認
- **技術棧**：Cloudflare Worker + D1 + R2 + Workers AI（同一份
  `imageSkill.js` 模組，與隨身記共用圖片 OCR/關聯判斷邏輯）
- **資料表**：`members`、`exhibitor_state`（狀態/指派/部門標籤/資質勾選）、
  `notes`（現場紀錄，軟刪除）、`history`、`attachments`、
  `line_recipients`（LINE 每日摘要推播名單）
- **驗證**：同樣走 PIN，另有 LINE Messaging API webhook（選用）
- **另有兩個平行版本**：`docs/`（GitHub Pages 靜態版，純瀏覽+寄信）、
  `app/`（FastAPI + SQLite，需自架主機）——`cloudflare/` 是目前推薦的
  團隊版，585 家展商真實資料已匯入（2026-07-09）

### C. 策略地圖 Wiki（`fieldlog/public/wiki/`）—— 知識沉澱層

- **定位**：長儒的個人知識庫，把 A（採集系統）跟 B（參展系統）的原始
  素材編譯成可疊代的技術論述
- **技術棧**：純 Markdown 檔＋`pages.json`（選單索引）＋`wiki.html`
  前端渲染，靠 fieldlog 的 Worker 做 PIN 驗證後轉發（`/wiki/*` 路由），
  **沒有自己的資料庫**，內容即檔案、檔案即產出
- **條目分類與收錄原則**：
  - **A（核心技術主題）**：A1 親水披膜／A2 抗結痂披膜／A3 抗菌披膜，
    各自對應產品＋負責人
  - **B（支撐知識庫）**：B1 塗層材料化學／B2 表面處理製程／B3 性能測試
    失效分析／B4 生物安全與法規——**跨產品共用的內容只寫一份**，
    A 頁若牽涉到，用一兩句話帶過＋`→ [連結]` 指過去，不整段複製
    （例：ISO 10993 的一般規格住在 B4；「這個規格對 DJ 導管的具體意涵」
    才寫在 A2）
  - **C（資源網絡）**：C1 供應商與設備圖譜（進料＝參展系統）／
    C2 文獻與課程（進料＝隨身記上課紀錄＋文獻閱讀／LitDB）
- **更新關卡**：事件驅動（展會/課程/實驗結束後跟 AI 說「更新 wiki」）→
  AI 抓「上次更新後」的新素材改寫條目、commit → **人看 git diff 決定
  收錄／修改／退回**——這一關是防止 AI 幻覺污染知識庫的關鍵，不可省略

### D. LitDB（文獻／專利閱讀）

- **2026-07-26 更新（產品單一化，同日再依規格書 I/II 升級為自動同步）**：
  `chiuchangru/litdb` 是獨立運作的系統（GitHub Pages 靜態網站＋JSON 資料
  檔），152 筆整理過的文獻/專利（親水塗層 102、活檢針機構 44、醫材包裝 6）。
  當天演進了三步：(1) 先做 MCP 即時查詢三工具 →(2) 為「產品單一化」改成
  一次性匯入隨身記、拿掉那三支工具 →(3) 依「第二大腦架構改善規格書 I」
  把一次性匯入升級成 **sources 表驅動的每日單向同步**：
  - **來源是資料不是程式碼**：`sources` 表登記 key／url／items_path／
    id_field 等（categories 表同一個判斷第三次套用）；新增一個知識庫＝
    `POST /api/sources` 加一列，全程不碰 .js
  - **通用渲染（黑名單制）**：`fieldlog/src/lib/render.js` 把任意 JSON 樹
    展開成 Markdown 進 body，任何沒列舉過的新欄位自動可搜尋——修掉了
    第一版白名單匯入「patentResults 的配方/FTO/迴避設計九成搜不到」的病灶
  - **AI 產出與人工內容分離**：litdb 的 `patentResults`／`patent_core` 進
    `entries.analysis_json`（`analysis_model='litdb-原生'`），MCP 呈現時
    明確標示「AI 深度解析」段落；body 裡的同步區用 `<!-- sync:start/end -->`
    標記，人工加註在標記外永不被同步覆蓋
  - **content-hash upsert**：沒變跳過、變了更新（寫 history）、來源端消失
    標 `_orphaned` 不刪除
  - **每日 cron**（wrangler triggers `0 18 * * *`＝台灣 02:00）自動跑
    `syncSources()`，每次寫 `sync_log`；MCP 的 `sync_status` 工具隨時可查
    「最後同步是什麼時候、漏了什麼」
  - 仍然**不下載任何 PDF、不建附件**，原始檔案/全文連結留在 litdb
  - 真相來源考證：litdb 根目錄 `papers.json`（107 筆）沒有被任何頁面引用，
    是殘留檔；多出的 R01–R05 是五筆同標題同連結、其餘全空的佔位資料。
    同步以各子目錄的檔案（coating 102／biopsy 44／packaging 6）為準
- **仍未建置的部分**：把讀完的文獻折進 A/B 技術條目本文的採集介面/
  流程（下面「定位」那段講的東西），目前還是規劃，沒有實作——同步進
  隨身記只是「查得到」，不是「自動掛回 wiki 條目」
- **定位**（已在對話中定案）：舊 LitDB 按「文獻」自身分類，新做法**不
  再獨立分類**，讀完直接掛回對應的 A/B 技術條目，C2 只留一行索引
  （日期｜標題｜一句話結論｜掛到哪個條目）
- **專利場景的特殊要求**：專利需要嚴謹的證據鏈（誰在何時記錄了什麼、
  原始素材不可篡改）——這也是三個系統決定不合併、且 wiki 走 git 版控
  的原因之一：git log 本身就是「這個論述何時、依據什麼素材寫下」的
  可稽核紀錄

## 二之二、fieldlog 的程式碼結構（2026-07-25 整併後）

整併前 fieldlog 是一條**八層 Worker 包裝鏈**：`worker-entry.js` → `worker-v49`
→ `v46` → `v45` → `v43` → `v40` → `v37` → `worker.js`，每加一個功能就包一層新
Worker，用 `previousWorker.fetch()` 轉呼叫下一層；前端行為則靠「把一大段 JS
字串接在 `app.js` 後面、在瀏覽器執行期覆寫函式」實現。

那樣疊出來的具體代價（都是實際發生過的，不是理論風險）：
- 同一個功能散在多層，改一個行為要先讀懂八層才知道哪一層在管
- **兩份標準檔名對照表互相打架**：批次整理與單檔改名各有一份，內容不一致，
  同一份 PDF 走不同入口會得到不同結果
- **字串比對式的 patch 會靜默失效**：v43 對 `app.js` 原始碼做字串替換，
  `app.js` 一改字串就對不上，功能無聲消失、不報錯
- 每個請求都要穿過八層 `fetch`，且 `/` 與 `/app.js` 都得先進 Worker 加工

整併後只有一支入口，前端是 `public/` 裡的正常檔案：

```
fieldlog/
├── src/
│   ├── worker.js          唯一入口：PIN 驗證 + 路由 + 各端點
│   ├── imageSkill.js      AI 擷取／原生文件文字擷取（與 cloudflare/ 共用，見下）
│   └── lib/
│       ├── schema.js      資料表、遷移、分類種子（CATEGORY_SEED）
│       ├── categories.js  分類字典 CRUD（含改名同步、刪除保留既有資料）
│       ├── standards.js   標準編號辨識與中文檔名（唯一一份對照表）
│       ├── attachments.js 單檔搬移／刪除／改名、資料夾深度
│       └── cleanup.js     批次檔名統一＋重複檔清除（預設不呼叫 AI）
└── public/
    ├── index.html         全部 UI 骨架（含管理分類對話框）
    ├── app.js             全部前端邏輯（不再有執行期覆寫）
    ├── style.css          全部樣式（不再有注入的 <style>）
    ├── pdf-editor.js      PDF 塗鴉；只掛 window.fieldlogOpenPdfEditor
    ├── home.js / home.css 首頁用量面板
    └── wiki/              策略地圖 Markdown（git 版控）
```

`tests/fieldlog-consolidation.test.js` 有一組**結構性測試**擋住包裝鏈重新長回來：
斷言沒有 `worker-vNN` 檔案、`worker.js` 裡沒有 `previousWorker`、沒有
`String.raw` 注入區塊、`wrangler.jsonc` 不再把 `/` 與 `/app.js` 導進 Worker。
要加新功能就直接改 `worker.js` 與 `public/`，不要再包一層。

## 三、已定案的設計決策（避免之後重新討論一遍）

1. **系統不常態性合併資料庫**。原因：使用情境形狀互斥——隨身記是單人
   移動採集，參展系統是多人即時協作，硬塞進同一張表只會讓每個場景都
   變彆扭，且參展系統是同事在用的共筆工具，改壞 schema 影響範圍大。
   **外部來源單向同步是唯一的資料流入**：sources 表登記的公開 JSON
   （目前是 litdb 三收藏）每天單向拉文字進隨身記（「產品單一化」，見
   第二節之 D），不搬 PDF、永不寫回來源——跟這條決策的精神——不做
   雙向的跨系統資料庫合併——並不衝突
2. **MCP 只當預設唯讀的問答層**（已實作於 `mcp/`）。獨立的 Cloudflare
   Worker，絕大多數工具不動任何現有生產資料；例外只有三支「只能新增」
   的工具：`create_fieldlog_entry`／`create_relation`／`add_synonym`
   （只 INSERT，沒有 UPDATE／DELETE 碰得到任何既有資料）。對外開 wiki／
   隨身記／參展系統的查詢工具，讓 claude.ai／Claude Code 可以跨三個來源
   做自然語言問答。這是「加一層查詢介面」，不是「合併儲存」——前台 UI
   怎麼改版都不影響 MCP，只有 D1 資料表結構變動時要回頭同步
   `mcp/src/worker.js` 的查詢
3. **Wiki 內容單一權威來源＋連結，不重複寫**。判斷標準：這段內容對其他
   產品是否也成立——成立就歸到 B 頁寫一份，不成立（產品特有）才留在
   A 頁，兩邊用連結互通
4. **AI 不能直接寫入 wiki 生產內容**，一定要人看過 git diff 才收錄

## 四、目前要改的方向與待解問題

- [x] **LitDB 併入隨身記＋攝取層永續化（2026-07-26，規格書 I 全數落地）**：
  sources 表（來源即資料）、通用黑名單渲染（任何欄位自動可搜尋）、
  content-hash upsert（同步區標記保護人工註記、來源消失標 _orphaned）、
  每日 cron 自動同步、sync_log 可追溯、同義詞入庫＋`add_synonym` 對話中
  即補即用、SCAN_CAP 命中上限明確警示、stripPdfMetadata 大綱誤殺修正。
  詳見上面第二節之 D。FTS5 全文索引刻意延後（資料量接近 3000 筆再做）。
- [~] **深度解析層（規格書 II）：欄位層已就緒，解析引擎決議暫緩（2026-07-26）**
  - **已完成**：entries／attachments 各加 analysis_json／analysis_at／
    analysis_model／analysis_profile／analysis_hash 五欄；litdb 的
    patentResults 已寫入 analysis_json（`analysis_model='litdb-原生'`），
    `search_fieldlog` 掃得到、`get_fieldlog_entry`／`get_fieldlog_attachment`
    呈現時明確標示「AI 產出，非現場紀錄」。也就是說：**已經有的分析查得到、
    看得到、而且不會被誤當成現場證據**——這一段的價值不依賴解析引擎
  - **暫緩**：analysis_profiles 模板表＋呼叫 Claude 的解析引擎（項目 9／10）、
    跨件綜整 syntheses（項目 13）。長儒 2026-07-26 決議先不做
  - **決議前提（之後要做時直接照這個做，不用重新討論）**：
    1. **金鑰**：規格書建議「Service Binding 綁 litdb-worker（它已是 Claude
       API proxy）」——**這個前提不成立**：查證過 `chiuchangru/litdb` 是純
       GitHub Pages 靜態網站，沒有任何 Cloudflare Worker、沒有後端。所以
       只剩「fieldlog 自持 `ANTHROPIC_API_KEY` secret 直接打
       api.anthropic.com」一條路，要做時就走這條
    2. **模型**：一律 Sonnet（不做 Opus 分級）。模型名存進 analysis_profiles
       表，之後隨時可改，不寫死在程式碼
    3. **範圍**：**只解析新資料，舊資料一律不動**；另外提供手動按鈕，讓長儒
       針對單筆重要的型錄／標準當下解析。不做全量回補（避免一次燒完預算才
       發現 prompt 模板要改）
- [x] **MCP Server 已完成並上線（2026-07-18，持續加工具）**：`mcp/` 目錄，
  獨立 Worker `medapi-mcp`，19 個工具跨三個來源（wiki 3 個、隨身記 9 個
  ——含資料夾階層、`list_fieldlog_entries`／`list_attachments` 目錄層
  （2026-07-25 補上：不用猜關鍵字就能看資料夾/附件實際有什麼）、
  folder_id/folder_type 篩選、附件全文（超長可用 offset/length 分段讀）、
  `get_related` 交叉比對、限定新增的 `create_fieldlog_entry`／
  `create_relation`、參展系統 5 個——含 `search_exhibitor_files`
  搜附件逐字稿/OCR 全文、`list_exhibitor_files` 目錄層、跨域 2 個——
  `sync_status` 查同步狀態、`add_synonym` 補同義詞）。共綁兩個既有
  D1、wiki 與展商主檔走 Service Binding。自有 `MCP_PIN` 驗證
  （fail-closed），claude.ai 自訂連接器已接通實測，另有
  `mcp/CONNECT-GPT.md` 給 ChatGPT 接。預設唯讀，僅三支新增工具例外
- [ ] **隨身記的 Notion 同步是半成品**：`notion_page_id` 等欄位跟
  `parseNotionPageId()` 已經寫好，但沒有任何 API 路徑真的呼叫它，
  現在還是人工把 AI 彙整完的報告貼進 Notion——要嘛補完自動同步，
  要嘛乾脆把這些死代碼清掉
- [ ] **參展系統（`cloudflare/`）既有待辦**（README 裡列的，一併記在
  這裡免得漏掉）：`docs/app.js` 的 `TEAM_EMAIL` 還是佔位字串；
  GitHub Pages 靜態版部署還沒在 repo Settings 開啟；完整版
  （`app/`）後台沒有登入驗證
- [ ] **實驗資源不夠**——晚點再寫
- [x] **Tier 2 深度處理已完成（2026-07-19）**：圖形型 PDF（無文字層）
  一般整理抽不到本文，新增手動觸發的「🔬 深度處理」——瀏覽器端用
  pdf.js 把 PDF 逐頁 render 成圖片，餵給既有的照片 OCR（不新建 Tier 2
  儲存/搜尋機制，頁面截圖就是一般照片附件，自動進既有搜尋與 MCP）。
  `attachments` 加 `source_pdf_id`／`page_no` 兩欄追蹤衍生頁面。
  絕對不背景批次，一次只處理使用者手動指定的單一 PDF。詳見
  `DATA-MODEL.md` 第五節。跨文件比對（需求文件選配項）尚未做

## 更新日誌
- 2026-07-18｜初版：整理隨身記／參展系統／wiki／LitDB 現況與已定案決策
- 2026-07-19｜加入 Tier 2 深度處理（PDF 逐頁 render + OCR，手動觸發）
- 2026-07-26｜LitDB 併入隨身記；攝取層永續化（規格書 I：sources 表／通用
  渲染／hash upsert／每日 cron／sync_log／同義詞入庫）；深度解析層（規格書
  II）欄位就緒、引擎待三個決策
