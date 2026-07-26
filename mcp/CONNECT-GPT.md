# 把 Mywiki 接進 GPT（MCP 連接器設定說明）

> 這份文件給要在 ChatGPT／GPT 裡設定 MCP 連接器的人看。伺服器本身叫
> `medapi-mcp`，在 ChatGPT 連接器列表裡的顯示名稱是你自己命名的（本文件範例
> 用「Mywiki」）。技術細節（工具清單、驗證方式）以 `mcp/src/worker.js` 的實際
> 程式碼為準；本檔案內容是照那支程式碼核對過的，不是憑印象寫的。

## 這是什麼

長儒的個人知識層窗口，跨四個來源做自然語言問答：

- **策略地圖 Wiki**——披膜技術條目，Markdown、git 版控
- **隨身記（fieldlog）**——個人現場採集：參展／拜訪／實驗的逐字稿、照片文字、
  記事與記事之間的交叉關聯（引用標準、對照廠商產品…），以及不用猜關鍵字
  就能列目錄的工具
- **Medtec 2026 參展系統**——585 家展商名單＋團隊拜訪紀錄＋附件全文
- **LitDB**——長儒另一個獨立文獻/專利知識庫（親水塗層、活檢針機構、醫材
  包裝三個收藏），資料即時讀自 GitHub Pages 公開 JSON，不搬資料過來

**預設唯讀。** 20 個工具裡 18 個只做 SELECT／fetch，唯二例外是
`create_fieldlog_entry`／`create_relation`，而且鎖死在「只能新增一筆全新的
記事或關聯」——沒有任何一支工具會修改或刪除既有資料。要改內容、刪東西，
一律要回隨身記／參展系統前台親自操作；wiki 收錄一律走 git 人審。

## 連線資訊

| 項目 | 值 |
|---|---|
| 協定 | MCP，Streamable HTTP（`POST /mcp`），JSON-RPC 2.0 |
| 端點 URL | `https://medapi-mcp.<你的帳號>.workers.dev/mcp?pin=<你的MCP_PIN>` |
| 驗證方式 | PIN，掛在網址上的 `?pin=` 參數 |
| 支援的 protocolVersion | `2024-11-05`／`2025-03-26`／`2025-06-18` |

**PIN 從哪裡拿**：Cloudflare Dashboard → 這個 Worker（`medapi-mcp`）→
Settings → Variables and Secrets → `MCP_PIN`。這串 PIN 等同一把鑰匙，
**不要貼到會被公開分享的地方**（例如公開的對話紀錄、GitHub issue）。

**這個端點刻意不支援 OAuth**——如果連接器設定畫面要求「OAuth Client ID」
之類的欄位，那一格留空或跳過即可，只要把 PIN 帶在網址的 `?pin=` 就能通過驗證。
伺服器對 `/.well-known/oauth-*` 這類探測路徑一律回 404，是刻意設計成這樣，
避免客戶端誤判成「這台支援 OAuth」而卡在動態註冊流程上。

## 在 ChatGPT 裡設定連接器

ChatGPT 的連接器設定畫面偶爾會改版，下面是目前（2026-07）常見的路徑，
如果畫面上文字不完全一樣，找「新增連接器／自訂連接器／Add custom
connector」這類選項即可：

1. ChatGPT → 設定 → Connectors（或 Settings → Connectors）
2. 選「新增自訂連接器 / Add custom connector」
3. **Name**：自己取一個看得懂的名字，例如「Mywiki」
4. **Server URL / MCP endpoint**：貼上面那條完整網址（含 `?pin=`）
5. 認證方式若有選項，選「No authentication」或「None」——PIN 已經包在網址裡了，
   不需要再另外設定認證
6. 儲存後，ChatGPT 應該會呼叫一次 `tools/list` 抓到下面這 20 個工具；
   如果連線失敗，先確認網址結尾的 PIN 有沒有貼對、貼完整

設定好之後，直接在對話裡問就好，例如：「幫我查展商裡做親水塗層的」
「上次實驗紀錄裡提到的固化溫度是多少」「wiki 的抗結痂條目現在寫到哪」——
GPT 會自己判斷該呼叫哪個工具。

## 可用工具（20 個）

**先列目錄、再決定要不要細看，不要一開始就猜關鍵字。** `search_*` 查不到不代表
沒有這份資料，可能只是關鍵字沒猜對——先用 `list_fieldlog_entries`／
`list_attachments`／`list_exhibitor_files` 直接看資料夾或展商底下實際有什麼，
檔名通常就足以判斷要不要細看。這是 2026-07-25 實測發現的最大瓶頸：AI 沒有
「看得見架上有什麼書」的工具，只能靠猜詞，猜不中就誤判成「沒有這份資料」。

### 策略地圖 Wiki
| 工具 | 用途 |
|---|---|
| `list_wiki_pages` | 列出所有條目（分組：核心技術／支撐知識／資源網絡），回答技術問題前先看這份地圖 |
| `read_wiki_page` | 讀單一條目的完整 Markdown 內容 |
| `search_wiki` | 全文關鍵字搜尋，回傳命中行；適合「哪個條目講過 XX」 |

### 隨身記（目錄層——不用猜關鍵字）
| 工具 | 用途 |
|---|---|
| `list_fieldlog_folders` | 列出所有資料夾（四層知識架構：產品／文件類型／主題／年份），先查 folder id 用 |
| `list_fieldlog_entries` | 列出資料夾（或全庫）底下的紀錄，**含每筆的附件檔名**；支援分頁 |
| `list_attachments` | 列出附件清單（可用 entry_id／folder_id 縮小範圍），附內容長度，判斷要不要細讀 |

### 隨身記（搜尋／讀取）
| 工具 | 用途 |
|---|---|
| `search_fieldlog` | 搜紀錄標題／內文／欄位＋附件檔名／逐字稿／擷取文字；可用 folder_id／folder_type 縮小範圍 |
| `get_fieldlog_entry` | 讀單筆紀錄完整內容（欄位、內文、附件摘要，超長內容會截斷並提示） |
| `get_fieldlog_attachment` | 讀單一附件全文；單次上限 20000 字，超過會明確標示總長度並可用 `offset`／`length` 分段接續讀完 |
| `get_related` | 查一筆記事跟哪些其他記事有關聯（雙向）；關聯要先手動建立過才查得到 |

### 隨身記（僅限新增，唯二可寫工具）
| 工具 | 用途 |
|---|---|
| `create_fieldlog_entry` | 新增一筆記事（標題／內文／選填歸檔資料夾／選填自訂欄位）。只會 INSERT，不會動到任何既有內容 |
| `create_relation` | 把兩筆**已存在**的記事建立關聯。兩筆記事都必須先存在，不能用猜的編號 |

### Medtec 2026 參展系統
| 工具 | 用途 |
|---|---|
| `search_exhibitors` | 搜 585 家展商（名稱／攤位／國家／產品／分類），附團隊共筆狀態 |
| `get_exhibitor` | 讀單一展商完整資料（主檔＋拜訪狀態＋部門標籤＋附件清單） |
| `search_visit_notes` | 搜團隊拜訪紀錄全文（誰記了什麼） |
| `search_exhibitor_files` | 搜展商附件內容全文（現場錄音逐字稿、型錄 OCR）——問「某家廠商的塗層方案細節」用這個 |
| `list_exhibitor_files` | 列出某展商全部附件（不用先猜關鍵字），附內容長度 |

### LitDB（另一個獨立文獻/專利知識庫）
LitDB 是長儒獨立維護的 GitHub Pages 靜態網站（`chiuchangru/litdb`），沒有自己的
後端，這幾支工具在查詢當下直接讀取它公開的 JSON 資料檔——LitDB 那邊之後照樣
用它自己的方式更新，這裡永遠讀得到最新版，不需要另外同步。

| 工具 | 用途 |
|---|---|
| `list_litdb_collections` | 列出目前有哪三個收藏（親水塗層／活檢針機構／醫材包裝）與各自筆數、範圍 |
| `search_litdb` | 搜標題／作者／標籤／摘要／專利分析摘要；可用 `collection` 縮小到單一收藏，同樣支援多詞查詢與同義詞展開 |
| `get_litdb_paper` | 讀單篇文獻/專利的完整摘要、對專案的價值評估、專利分析全文與連結（用 `collection` + `id`，來自 search_litdb 回傳的 `[collection/id]`） |

### 搜尋工具的共同行為
`search_*` 系列全部支援：
- **簡繁通用**：繁體查得到簡體庫、簡體查得到繁體庫（型錄常是簡體、個人記事常是繁體）
- **多詞查詢**：關鍵字用空白隔開，預設全部詞都要命中；全部命中查不到時會自動放寬
  成任一詞命中，並在回應裡標示「以下為部分符合」
- **同義詞展開**：慣用語會自動對應到正式名稱（例如查「HD管」找得到「體外血液處理
  用導管」），對照表在 `mcp/src/synonyms.json`，公司內部代號可以自己往裡面加
- **查無結果會誠實回報**：不會只回一句「查無資料」，會說明實際嘗試過哪些詞，
  讓你分辨「真的沒有」還是「用詞沒對上」

## 安全設計摘要

- **fail-closed**：`MCP_PIN` 沒設定時，這個端點會拒絕所有請求，不會裸奔
- **預設唯讀**：程式碼裡絕大多數是 SELECT／fetch；`create_fieldlog_entry`／
  `create_relation` 是唯二例外，程式碼裡沒有任何 UPDATE／DELETE 語句碰得到
  entries／attachments／folders／relations——就算透過對話下指令，也不可能
  改掉或刪掉既有的任何一筆資料
- 四個後端來源（策略地圖 Wiki、隨身記、Medtec、LitDB）各自獨立——前三個是
  獨立的 Cloudflare Worker／資料庫，LitDB 是完全外部的 GitHub Pages 靜態
  網站，這個 MCP 只是加一層查詢介面，不做跨系統的資料庫合併，也不搬 LitDB
  的資料過來

## 疑難排解

- **連線失敗／401**：PIN 錯了或沒帶——確認網址結尾是完整的 `?pin=<值>`
- **工具清單是空的／連不上**：確認 URL 是 `.../mcp?pin=...`，不是少了 `/mcp`
  或多打了字元
- **查詢回「查無資料」但你確定有**：先確認關鍵字沒有打錯字；試試拿掉
  `folder_id`／`folder_type` 這類縮小範圍的參數，改成全庫查；同義詞沒收錄的
  慣用語（例如很冷門的公司內部代號）本來就查不到，可以請維護者在
  `mcp/src/synonyms.json` 補一組對照
