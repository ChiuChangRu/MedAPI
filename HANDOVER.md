# 交接文件（給接手的 Claude / 開發者）

> 這份文件讓你在**完全不知道前情**的情況下，接手維護這整套系統。
> 讀完這份＋下面列的四份文件，你就有全貌。
> **本檔案刻意不含任何密碼/PIN 的實際值**——那些是私下另外交付的（見第一節）。

---

## 〇、30 秒總覽

一套「醫療器材塗層」領域的**個人知識採集系統**，三個獨立的 Cloudflare
Worker ＋一個 git 版控的知識庫：

| 子系統 | 是什麼 | 目錄 | 線上網址 |
|---|---|---|---|
| **fieldlog（隨身記）** | 個人現場採集：錄影/拍照/錄音/速記，AI 轉文字 | `fieldlog/` | `https://fieldlog.gogoyankee.workers.dev` |
| **medtec-2026（參展系統）** | 9 人團隊共筆：585 家展商名單、拜訪紀錄、附件 | `cloudflare/` | `https://medtec-2026.gogoyankee.workers.dev` |
| **medapi-mcp（MCP 問答層）** | 預設唯讀（僅 create_fieldlog_entry／create_relation 例外，只能新增），讓 claude.ai 跨三來源自然語言查詢 | `mcp/` | `https://medapi-mcp.gogoyankee.workers.dev` |
| **策略地圖 Wiki（知識層）** | 純 Markdown、git 版控的技術知識條目 | `fieldlog/public/wiki/` | `.../wiki.html`（隨身記內，PIN 保護） |

還有兩個參展系統的平行舊版本（`docs/` GitHub Pages 靜態版、`app/`
FastAPI 版），目前主線是 `cloudflare/`，那兩個少碰。

---

## 一、接手前必做：三種存取權限（本人 gogoyankee 要授予）

接手的帳號要能動這套系統，需要三塊獨立的存取權，**由原持有人操作授予，
密碼/值私下給，不要寫進任何會分享的檔案**：

1. **GitHub 原始碼**：repo `ChiuChangRu/MedAPI`。把接手帳號加為
   collaborator（Settings → Collaborators）。開發分支是
   `claude/medtec-exhibitor-directory-kbs2i8`（見第五節）。
2. **Cloudflare 帳號**（三個 Worker、D1、R2 都在這帳號底下，帳號代稱
   `gogoyankee`）：改**程式碼**只要 GitHub 就夠（推 code 會自動部署）；
   但要看**部署狀態、改 Secret、查 D1 Console、看 R2 檔案**，需要
   Cloudflare 儀表板存取——用 Cloudflare 的 **Members**（Manage
   Account → Members）邀請，或由原持有人代為操作。
3. **MCP 問答連接器**（要在 claude.ai 用自然語言查live資料時）：
   連接器 URL 是 `https://medapi-mcp.gogoyankee.workers.dev/mcp?pin=<MCP_PIN>`。
   把 `<MCP_PIN>` 的實際值私下給接手人，讓他在自己的 claude.ai →
   Settings → Connectors → Add custom connector 貼上。

> **要私下交付的密碼清單（值不寫在這）**：`FIELD_PIN`（隨身記登入＋wiki）、
> `TEAM_PIN`（參展系統登入）、`MCP_PIN`（MCP 端點）。選用的還有 LINE 的
> 兩個 token（見 `cloudflare/README.md`）。

---

## 二、先讀這四份文件（照順序）

| 文件 | 講什麼 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 工程決策與全貌：為什麼三系統不合併、MCP 預設唯讀（僅限定新增兩支工具例外）、wiki 走 git 人審。含「待解問題」清單 |
| [`DATA-MODEL.md`](DATA-MODEL.md) | 資料存哪裡（R2 檔案／D1 文字）、資料表欄位、四種整理狀態、PDF 三種辨識差異、查證 SQL |
| [`SECOND-BRAIN.md`](SECOND-BRAIN.md) | 給人看的操作手冊：採集→整理→更新 wiki→claude.ai 問答的日常流程 |
| 各子目錄 `README.md` | `cloudflare/`、`fieldlog/`、`mcp/`、`fieldlog/public/wiki/` 各有一份，含各自的部署步驟 |

---

## 三、Cloudflare 資源清單（名稱，非機密值）

| 類型 | 名稱 | 綁在哪 | 備註 |
|---|---|---|---|
| Worker | `fieldlog` | root `fieldlog/` | 隨身記後端＋前端靜態資產 |
| Worker | `medtec-2026` | root `cloudflare/` | 參展系統，含每日 LINE 摘要 cron |
| Worker | `medapi-mcp` | deploy `mcp/wrangler.jsonc` | MCP 問答層，無自己的儲存，預設唯讀（僅 2 支工具能 INSERT，見 mcp/README.md） |
| D1 資料庫 | `fieldlog` | id `41483c93-9398-4be6-a670-a3120c880781` | fieldlog Worker＋medapi-mcp 共綁 |
| D1 資料庫 | `medtec-2026` | id `bbb39534-bcf7-45b3-b068-60be5c3b198b` | medtec Worker＋medapi-mcp 共綁；medtec 另唯讀共綁 fieldlog 庫做「今日 AI 用量」 |
| R2 bucket | `fieldlog-files` | fieldlog Worker（binding `FILES`） | 隨身記的照片/錄音/PDF |
| R2 bucket | `medtec-2026-files` | medtec Worker（binding `FILES`） | 參展系統的附件 |
| Workers AI | binding `AI` | 三個採集 Worker 都有 | Whisper 轉錄、Llama Vision OCR、toMarkdown |
| Service Binding | `FIELDLOG`／`MEDTEC` | medapi-mcp → 另兩個 Worker | MCP 讀 wiki／展商主檔用（不能用 fetch 打 workers.dev） |

**各 Worker 需要的 Secret／Variable（值私下給）**：
- `fieldlog`：`FIELD_PIN`
- `medtec-2026`：`TEAM_PIN`；選用 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`
- `medapi-mcp`：`MCP_PIN`、`FIELD_PIN`（與 fieldlog 同值，讀 wiki 用）

---

## 四、部署模型（重要，跟一般 CI 不同）

- 三個 Worker 都是 **Cloudflare 連 GitHub 的自動部署**：**推 code 到開發
  分支 → Cloudflare 自動 build＋部署**，不需要手動跑任何指令。
- **實際在部署的分支以 Cloudflare Dashboard 的 Build → Branch control →
  Production branch 為準**（2026-08-01 查為 `codex/kiwi-integration`）。這份
  文件會過時，那個設定不會——有疑問一律去 Dashboard 看，不要相信這裡的字面值。
- ⚠️ **`main` 遠遠落後實際主線**（2026-08-01 落後 371 個 commit，連 `mcp/`
  目錄都還沒有）。**不要把功能分支合併進 main 再部署**，那等於把線上打回舊版。
  新分支要從目前的 production branch 開，PR 也開回去那條。
- **不要另外加 GitHub Actions 部署這三個 Worker。** 已經有 Cloudflare 自動部署，
  再加一套會變成同一次 push 被部署兩次、順序還不保證，之後也沒人分得清線上
  跑的是哪一套推上去的。`.github/workflows/deploy.yml` 只管 `cloudflare/`
  那個 Worker 的 `cloudflare/**` 路徑，是既有例外，不要擴大。
- `medapi-mcp` 比較特別：它的 Deploy command 是
  `npx wrangler deploy --config mcp/wrangler.jsonc`（因為這個簡化流程
  沒有獨立的 Root directory 欄位）。另兩個是 root directory 設成
  `fieldlog/`、`cloudflare/`。
- **前端是網路優先的 PWA**：改了 `public/app.js` 等靜態檔，使用者要
  **重新整理頁面**才會載到新版（已開著的分頁仍跑舊記憶體裡的程式）。

### 「畫面還是舊版」的排查順序（2026-07-25 為此耗掉一整輪來回）

**先看首頁標頭的版本號**（例如 `輸入、整理、歸檔 v55`）。app.js 啟動時會拿自己的
`APP_VERSION` 跟 `/api/config` 回的 `UI_VERSION` 對版，對不上就直接在畫面最上面
顯示橘色橫幅，並提供一顆「清除快取並載入最新版」（會 unregister service worker、
清空 cache storage、帶時間戳重載）。所以：

1. **版本號就是最新的** → 不是快取問題，去查程式碼本身有沒有被覆寫（見下）。
2. **版本號比伺服器舊** → 按橫幅那顆按鈕，會自己修好。
3. **完全沒有版本號** → 載到的是 v55 之前的版本，才需要手動清快取。

版本號要同步四個地方（有測試把關，任一處沒跟上就失敗）：
`worker.js` 的 `UI_VERSION`、`app.js` 的 `APP_VERSION`、`index.html` 的 `?v=`、
`sw.js` 的 `CACHE` 名稱與 `?v=`。改前端時記得一起加。

**當時真正的兩個原因（都不是快取）：**

- `public/home.js` 用 `loadUsage = loadActiveUsageOnly` 在執行期覆寫掉 app.js 的
  用量面板，所以改 app.js 完全沒有效果（改在死碼上），而且不會報錯。它還用
  MutationObserver 持續刪掉 index.html 的元素。已折進 app.js 並刪除，
  另有結構性測試禁止 `public/` 底下任何檔案覆寫 app.js 的頂層函式。
- `wrangler.jsonc` 的 `run_worker_first` 一度沒有列 `/`、`/app.js` 等 App 殼路徑。
  **不在那份名單裡的路徑，Cloudflare Assets 會直接回應、Worker 完全不會執行**，
  就沒機會蓋掉 Assets 預設的快取表頭。那份名單要跟 worker.js 的
  `NO_CACHE_SHELL_PATHS` 一致（有測試交叉比對）。

### 「D1 說某個欄位不存在，但程式碼明明有那條 migration」（2026-08-01 為此耗掉一整輪）

症狀：MCP 的 `search_fieldlog` 100% 失敗，回
`D1_ERROR: no such column: e.body_format`，但 `fieldlog` 早就部署了含
`ALTER TABLE entries ADD COLUMN body_format` 的版本，Version History 也看得到。

原因是 **migration 的執行時機**，不是部署失敗：

- 三個 Worker 綁**同一個 D1**，但**只有 `fieldlog` 帶 migration**（`ensureSchema`）。
- `ensureSchema` 只在 **帶正確 PIN 的 `/api/*` 請求**進來時才跑——PIN 閘門在前，
  401 的請求根本走不到那一行。
- `medapi-mcp` 直接讀 D1，**完全不經過那條路徑**。

所以「fieldlog 部署完成」不等於「欄位已建立」。只要部署後沒有人真的帶 PIN
打開過隨身記 App，欄位就一直不存在，而 MCP 一直在讀同一個資料庫 → 一直失敗。
`fieldlog` 的排程（每天 UTC 18:00）也會跑 `ensureSchema`，但那代表最壞情況
要等一整天。

**排查順序：**

1. 先確認 `fieldlog` 部署的版本**有沒有**那條 migration（看 Version History 的
   commit 訊息，或 `git show <production-branch>:fieldlog/src/lib/schema.js`）。
   沒有 → 是部署問題，往部署方向查。
2. 有 → 就是這個時序問題。**帶 PIN 打開一次隨身記 App**（或
   `curl -H "x-pin: …" .../api/config`）即可，30 秒。
3. 之後 `medapi-mcp` 會自己處理：遇到 `no such column` 會用 `FIELDLOG`
   service binding ＋ `FIELD_PIN` 打一次 `/api/config` 觸發 `ensureSchema`
   再重試（`mcp/src/worker.js` 的 `triggerFieldlogSchemaMigration`，
   `tests/mcp-schema-selfheal.test.js` 有把關）。正常路徑不會多打任何請求。

**加新欄位時**：migration 寫在 `fieldlog/src/lib/schema.js` 的 `MIGRATIONS`。
注意 `ensureSchema` 對每條 migration 都 `.catch(() => {})`——它吞掉的不只是
「欄位已存在」，**任何錯誤都會被吞掉且無聲**。改動 migration 後要實際確認欄位
真的建出來了，不要只看部署成功。

**另外：不要用 Cloudflare Dashboard 的「Edit code」手動部署這個專案。** 當時有一筆
`Manually deployed`（無 commit 記錄）蓋掉了正確的 git 自動部署並拿走 100% 流量，
而且 Rollback 疑似不會一併還原靜態資源，導致 Worker 程式碼與 assets 對不上。
一律靠 push 到開發分支自動部署。

---

## 五、開發流程

- **開發分支**：以 Cloudflare 的 Production branch 為準（2026-08-01 是
  `codex/kiwi-integration`）。從那條開分支、PR 也開回去那條。**不要直接推
  main，也不要合併進 main**（見第四節：main 已經遠遠落後）。
- **改完就 push**，Cloudflare 自動部署（見第四節）。
- **commit 慣例**：清楚的英文標題＋內文說明「為什麼」，結尾帶
  `Co-Authored-By:` 與 `Claude-Session:` 兩行（照現有 commit 的格式）。
- **測試**：`tests/` 底下有正式測試（2026-08-01 為 20 檔、237 項）。

  ```bash
  npm run check   # 三個 worker 的語法檢查
  npm test        # node --test tests/*.test.js
  ```

  改動前後都跑一次。寫法是 mock 出 `env.DB`／`env.FILES`／service binding，
  再打 `worker.fetch(req, env)`——照既有測試的樣子加就好。
  改了行為卻沒有測試跟上，等於下一個接手的人（或 AI）沒有依據判斷有沒有壞。
- **本機實跑**：`cd fieldlog && npx wrangler dev --local`（`--local` 不會碰到
  線上 D1／R2）。要帶 PIN 就在 `fieldlog/.dev.vars` 寫 `FIELD_PIN=...`，
  該檔已被 `.gitignore` 擋住。注意本機**沒有** Workers AI 與 Cloudflare
  用量 API，所以 OCR／轉文字／`enforceAiSoftBudget` 這幾條路徑驗不到，
  只能到實際部署後驗。
- **共用模組**：`imageSkill.js`（照片 OCR／鬼打牆處理／PDF metadata 剝除）
  正本在 `cloudflare/src/`，用 `cp` 同步到 `fieldlog/src/`——改一邊要
  記得同步另一邊（兩份必須一致）。
- **兩系統邏輯要一致**：使用者明確要求「參展系統」與「個人記事」的
  附件/整理邏輯保持同步，改一邊通常要照著改另一邊。

---

## 六、進行中／待辦／已知限制（接手最需要知道的）

**進行中（卡在部署）**
- **背景錄音**：`fieldlog` 切分頁不中斷錄音的修正已完成並 push，卡 GitHub
  故障未部署。**只針對桌機 Chrome**（iOS 系統層不允許背景錄音，範圍外）。
  部署後要在真桌機 Chrome 驗證（錄音→切分頁→切回→停止＝一段連續、
  無缺口無重複）。同樣機制的參展系統「採集模式」**還沒改**。
- **Tier 2 深度處理**（PDF 逐頁 render 成圖再 OCR，手動觸發）：已完成
  並 push，但 pdf.js 那半邊**沒辦法在無瀏覽器環境測**，要真桌機驗證。

**待辦／缺口**
- **前台顯示端 PDF metadata 即時剝除**：MCP 已即時剝，但**前台顯示**舊
  PDF 仍會show出 metadata（除非對該 PDF 按「重抄」）。可補一個前台
  render-time 剝除（曾提議、未做）。
- ~~**同義詞／語意搜尋**~~：**2026-07-25 已做**，見下方「搜尋層」。
- **隨身記 Notion 自動同步**：`folders` 表有 `notion_*` 欄位、
  `parseNotionPageId()` 也寫好了，但**沒有 API 路徑真的呼叫**，等於死代碼；
  目前是人工把 AI 彙整報告貼進 Notion。要嘛補完、要嘛清掉。
- **LitDB（文獻／專利）→ 外部來源同步**：2026-07-26 依「第二大腦架構改善
  規格書 I」把一次性匯入升級成 sources 表驅動的每日單向同步（台灣 02:00
  cron，引擎在 `fieldlog/src/lib/sync.js`）：通用黑名單渲染讓任何欄位自動
  可搜尋、patentResults 進 analysis_json（MCP 呈現時標示 AI 產出）、
  content-hash upsert（人工註記在 `<!-- sync:start/end -->` 標記外永不被
  覆蓋、來源消失標 _orphaned 不刪）。新增知識庫＝`POST /api/sources` 加一列，
  不改程式碼；同步狀態用 MCP 的 `sync_status` 查。仍然不下載 PDF、不建附件。
  把讀完的文獻折進 wiki A/B 技術條目本文，仍只是待讀清單，還沒做。
- **深度解析層（規格書 II）**：entries/attachments 的 analysis_* 五欄已就緒
  並接上搜尋/呈現（litdb 既有的專利分析查得到、且標示為 AI 產出）。**解析
  引擎本身長儒決議暫緩**，之後要做時三個前提已定案，不用重新討論：
  (1) 金鑰走 fieldlog 自持 `ANTHROPIC_API_KEY`——規格書原本建議綁
  litdb-worker 當 proxy，但查證後 `chiuchangru/litdb` 是純 GitHub Pages
  靜態站、根本沒有 Worker，那個前提不成立；(2) 一律 Sonnet，不做 Opus
  分級，模型名放 analysis_profiles 表可隨時改；(3) 只解析新資料、舊資料
  不動，另給手動按鈕逐筆解析——不做全量回補。
- **參展系統既有待辦**：`docs/app.js` 的 `TEAM_EMAIL` 還是佔位字串；
  GitHub Pages 靜態版部署未開；`app/` FastAPI 版後台無登入驗證。

**搜尋層（2026-07-25 大改，先讀這段再改搜尋）**

實測發現兩個問題，都已修好，全部五個 `search_*` 工具共用同一套比對層
（`mcp/src/search.js`）：

1. **多詞查詢曾經完全失效（純 bug）**。舊做法把整個查詢字當「一整串」去
   `includes()`，所以「7886 注射器」會去找帶空格的連續子字串；檔名實際是
   `ISO_7886-1_2017_無菌皮下注射器…`，兩個詞都在裡面卻永遠比不到。
   現在會以空白斷詞（含全形空白），預設全詞都要命中（AND）；AND 掛零才
   降級成 OR 並在回應開頭標示「以下為部分符合」。
2. **慣用語查不到正式標準名**。文件寫「體外血液處理用導管」，人查「HD管」，
   字面零重疊就靜默漏掉。現在比對前會過一層同義詞展開。**2026-07-26 起
   同義詞表存在 fieldlog D1 的 `synonyms` 表**（`mcp/src/synonyms.json`
   降級為出廠預設值＋讀不到 D1 時的 fallback）：查不到的當下用 MCP 的
   `add_synonym` 工具在對話裡補一組，立刻生效，不用改程式碼重新部署。

⚠️ 關於同義詞表：**這份交接文件先前記載「使用者明確反對手寫同義詞字典」，
該決定已於 2026-07-25 由使用者本人推翻**（依其提供的《MyWiki 搜尋功能改善
規格書 v2》施工）。推翻的理由值得記住：13 次實測失敗最大宗（4 次）是上面
那個斷詞 bug，屬純程式錯誤；其次（2 次）才是同義詞。而且同義詞表做成
**獨立 JSON 資料檔、使用者自己就能增修**，不是散在程式碼裡的特例補丁——
公司內部代號（`BT-SBNS`、料號）只有使用者本人知道，本來就只能靠這種
可持續擴充的對照表。

**向量化（語意搜尋）本案決議：不做。** 理由：向量解決的是佔比最小的第三順位
問題；對數字編號（`7886`、`10555`）語意表徵弱，導入反而有讓現行正常查詢
退化的風險；embedding 沒學過公司內部代號；且可解釋性差、維護成本對單人
維護的系統不成比例。**保留條件**：若 P0+P1 上線後仍頻繁出現「查詢詞無法
預先收錄」的偽陰性，再評估 Hybrid（關鍵字＋向量 RRF 合併），且必須以
`tests/search-tokenize.test.js` 當不得退化的基準線。

**目錄層（2026-07-25，同一天稍晚加的，讀規格書 v3）**：實測發現比比對演算法
更大的瓶頸是「AI 看不見架上有什麼書」——`search_fieldlog` 查不到不代表沒有
這份資料，可能只是關鍵字沒猜對，猜不中就會誤判成「沒有這份資料」（實際案例：
查「HD管 驗證」「血液透析導管」都落空，但資料夾裡明明有那份 ISO PDF，只是
檔名沒被猜中）。修法不是把比對做得更聰明，是**直接讓 AI 能列目錄**：新增
`list_fieldlog_entries`（資料夾底下的紀錄，含附件檔名——檔名本身通常就足以
判斷要不要細看）、`list_attachments`（附件清單＋內容長度）、展商側對應的
`list_exhibitor_files`。同時 `get_fieldlog_attachment` 加 `offset`／`length`
分段讀取，超長附件（例如整份 ISO 標準 OCR 全文）會明確標示總長度，不會
默默截斷。**以後查不到東西，先 list 再判斷是不是真的沒有，不要只靠 search 就
下結論。**

**查無結果一律誠實回報**：會說出斷成哪幾個詞、展開後實際查了哪些詞、
哪些詞不在同義詞表裡。原本只回一句「查無」，使用者分不出「資料庫真的沒有」
還是「有、但用詞沒對上」——那是這套系統最危險的失效模式。

**fieldlog 程式碼結構（2026-07-25 整併，先讀這段再改 fieldlog）**

整併前是一條八層 Worker 包裝鏈（`worker-entry.js` → `v49` → `v46` → `v45`
→ `v43` → `v40` → `v37` → `worker.js`），前端靠「執行期把 JS 字串接在
`app.js` 後面並覆寫函式」。**那些檔案已全部刪除**，現在只有一支
`fieldlog/src/worker.js` ＋ `fieldlog/src/lib/*`，前端全在 `fieldlog/public/`
的正常檔案裡。細節與當初為什麼要整併，見 `ARCHITECTURE.md` 第二之二節。

**要加新功能就直接改那兩處，不要再包一層。** `tests/fieldlog-consolidation.test.js`
有結構性測試會擋住包裝鏈長回來。

**分類已經可以自己管理（不用再改程式碼）**：資料夾的四層分類與檔案的醫材
分類都存在 D1 的 `categories` 表，前台「⚙️ 管理分類」可新增／改名／刪除。
刪除只拿掉選項、既有資料上的分類文字保留；改名會同步更新既有資料。
預設分類只在表空的時候寫入一次（用 `kind='_seeded'` 標記列記住），
所以使用者刪掉的預設分類不會在冷啟動時被倒回來。

**設計鐵律（別踩）**
- MCP **預設唯讀**，只有 SELECT／fetch；唯二例外是 `create_fieldlog_entry`／
  `create_relation`，範圍鎖死在「只能 INSERT 一筆全新的記事或關聯」，
  沒有任何工具能 UPDATE 或 DELETE 既有資料。改內容、刪東西要走各前台。
- wiki 收錄**一律人審 git diff**，AI 不直接寫入生產內容。
- Tier 2 **絕不背景全庫批次**，只處理使用者手動指定的單一 PDF。
- **不為單一問題／單一公司寫程式**——改就改通用的系統層。
- Cloudflare Workers AI 有**每日免費 10,000 Neurons 額度**（帳號已升級
  Workers Paid，超過按量計費）；批次整理會顯示今日用量，額度用完會回
  錯誤碼 `4006`，程式碼多處有針對它中止的保護。

---

## 七、快速上手檢查清單

1. [ ] 拿到 GitHub collaborator 權限，clone repo，切到開發分支
2. [ ] 拿到 Cloudflare 儀表板存取（看部署/改 Secret/查 D1）
3. [ ] 拿到三個 PIN 的實際值（私下），把 MCP 連接器接上自己的 claude.ai
4. [ ] 讀完第二節那四份文件
5. [ ] 確認 GitHub 故障是否已解除、fieldlog 是否部署到最新版
6. [ ] 真桌機 Chrome 驗證背景錄音＋Tier 2 深度處理這兩個待驗證項

## 更新日誌
- 2026-08-01｜修正過時陳述（開發分支、「沒有 test 目錄」已不成立）；
  補上「D1 說欄位不存在但 migration 明明有」的排查段落與 migration 時序說明；
  明確標註 main 已遠遠落後、不要合併進去，以及不要另加 GitHub Actions 部署
- 2026-07-19｜初版交接文件
