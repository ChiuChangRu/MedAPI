# 把 Mywiki 接進 GPT（MCP 連接器設定說明）

> 這份文件給要在 ChatGPT／GPT 裡設定 MCP 連接器的人看。伺服器本身叫
> `medapi-mcp`，在 ChatGPT 連接器列表裡的顯示名稱是你自己命名的（本文件範例
> 用「Mywiki」）。技術細節（工具清單、驗證方式）以 `mcp/src/worker.js` 的實際
> 程式碼為準；本檔案內容是照那支程式碼核對過的，不是憑印象寫的。

## 這是什麼

長儒的個人知識層窗口，跨三個來源做自然語言問答：

- **策略地圖 Wiki**——披膜技術條目，Markdown、git 版控
- **隨身記（fieldlog）**——個人現場採集：參展／拜訪／實驗的逐字稿、照片文字、
  記事與記事之間的交叉關聯（引用標準、對照廠商產品…），以及不用猜關鍵字
  就能列目錄的工具；也含每日自動同步進來的 LitDB 文獻/專利（152 筆親水
  塗層／活檢針機構／醫材包裝資料，只有文字不含 PDF，專利分析存於
  「AI 深度解析」段落並明確標示）
- **Medtec 2026 參展系統**——585 家展商名單＋團隊拜訪紀錄＋附件全文

**對記事內容預設唯讀，例外分兩組。** 27 個工具裡 19 個只做 SELECT／fetch。
第一組`create_fieldlog_entry`／`create_fieldlog_attachment`／`create_relation`／
`add_synonym` 四支鎖死在「只能新增一筆全新的記事／附件／關聯／同義詞對照」，
不會修改或刪除既有資料。第二組是 2026-08-08 新增的資料夾整理工具
`update_folder`／`move_folder`／`move_entry`／`delete_folder`，範圍限定在
資料夾名稱／分類／排序／巢狀位置與記事的歸檔位置，會真的 UPDATE／DELETE，
但不會動到任何記事或附件的內容（`delete_folder` 也不會遺失資料，見下方
工具表說明）。除了這兩組之外，要改內容、刪東西，一律要回隨身記／參展系統
前台親自操作；wiki 收錄一律走 git 人審。

## 連線資訊

| 項目 | 值 |
|---|---|
| 協定 | MCP，Streamable HTTP（`POST /mcp`），JSON-RPC 2.0 |
| 端點 URL | `https://medapi-mcp.<你的帳號>.workers.dev/mcp` |
| 驗證方式 | OAuth 2.1（DCR＋authorization code＋S256 PKCE） |
| 支援的 protocolVersion | `2024-11-05`／`2025-03-26`／`2025-06-18` |

**PIN 從哪裡拿**：Cloudflare Dashboard → 這個 Worker（`medapi-mcp`）→
Settings → Variables and Secrets → `MCP_PIN`。這串 PIN 等同一把鑰匙，
**不要貼到會被公開分享的地方**（例如公開的對話紀錄、GitHub issue）。

PIN 只在 MCP Worker 自己顯示的授權頁輸入，不要放進 Server URL。伺服器支援
OAuth 動態用戶端註冊（DCR）、PKCE、access token 與 refresh token；若畫面讓你
選註冊方式，選「動態用戶端註冊」。

## 在 ChatGPT 裡設定連接器

ChatGPT 的連接器設定畫面偶爾會改版，下面是目前（2026-07）常見的路徑，
如果畫面上文字不完全一樣，找「新增連接器／自訂連接器／Add custom
connector」這類選項即可：

1. ChatGPT → 設定 → Connectors（或 Settings → Connectors）
2. 選「新增自訂連接器 / Add custom connector」
3. **Name**：自己取一個看得懂的名字，例如「Mywiki」
4. **Server URL / MCP endpoint**：只貼 `https://medapi-mcp.<帳號>.workers.dev/mcp`
5. 驗證選 **OAuth**，用戶端選 **動態註冊（DCR）**，不要自行填 Client ID／Secret
6. 儲存後會開啟 MyWiki 授權頁；在那裡輸入 `MCP_PIN` 並按「允許」
7. ChatGPT 會完成 token 交換並呼叫 `tools/list`，抓到下面這 27 個工具

設定好之後，直接在對話裡問就好，例如：「幫我查展商裡做親水塗層的」
「上次實驗紀錄裡提到的固化溫度是多少」「wiki 的抗結痂條目現在寫到哪」
「litdb 裡有沒有講活檢針擊發機構的文獻」（LitDB 已併入隨身記並每日自動
同步，`search_fieldlog` 就查得到）——GPT 會自己判斷該呼叫哪個工具。

## 可用工具（27 個）

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
| `search_fieldlog` | 搜紀錄標題／內文／欄位＋附件檔名／逐字稿／擷取文字＋AI 深度解析內容（命中在解析段時會標示）；可用 folder_id／folder_type 縮小範圍；也涵蓋每日同步的 LitDB 文獻/專利（「LitDB 文獻庫」資料夾） |
| `get_fieldlog_entry` | 讀單筆紀錄完整內容（欄位、內文、附件摘要；「AI 深度解析」段落會明確標示是 AI 產出，引用前回原始內容確認） |
| `get_fieldlog_attachment` | 讀單一附件全文；單次上限 20000 字，超過會明確標示總長度並可用 `offset`／`length` 分段接續讀完 |
| `get_fieldlog_image` | 讀照片附件的「圖片本身」（MCP ImageContent，base64＋mimeType）讓 AI 直接看圖——限 4MB 內 JPEG/PNG/GIF/WebP；型錄文件類請優先走擷取文字 |
| `get_fieldlog_image_base64` | 讀照片附件的原始位元組，以純文字（base64）回傳，不轉成圖片內容——用在組內嵌照片的 HTML 報告，或需要重新上傳／核對位元組是否一致的場景；跟 `get_fieldlog_image` 同一個 4MB 上限，但不做自動縮圖 |
| `image_probe` | 診斷用：回傳內建 96×96 四色測試圖，驗證 client 是否支援 MCP 圖片顯示；不讀任何使用者資料 |
| `get_related` | 查一筆記事跟哪些其他記事有關聯（雙向）；關聯要先手動建立過才查得到 |

### 隨身記（僅限新增的可寫工具）
| 工具 | 用途 |
|---|---|
| `create_fieldlog_entry` | 新增一筆記事（標題／內文／選填歸檔資料夾／選填自訂欄位）。只會 INSERT，不會動到任何既有內容 |
| `create_fieldlog_attachment` | 上傳檔案（Word／Excel／PDF／圖片等，base64 傳入，伺服器端上限 8MB）掛到一筆**已存在**的記事底下。跟該記事既有附件內容重複會自動略過，不會重複存 |
| `create_relation` | 把兩筆**已存在**的記事建立關聯。兩筆記事都必須先存在，不能用猜的編號 |
| `add_synonym` | 新增一組同義詞對照（例：把「BaClear」掛到「抗結痂披膜」）。查不到但確定只是用詞沒對上時當場補，下一次查詢立刻生效；只會 INSERT，改不掉也刪不掉既有對照 |

### 隨身記（資料夾整理工具，2026-08-08 新增）
會真的 UPDATE／DELETE，但範圍鎖死在資料夾結構與記事的歸檔位置，不會動到
任何記事或附件的實際內容：
| 工具 | 用途 |
|---|---|
| `update_folder` | 改資料夾的名稱／色系分類 `category`（`project`／`qa_reg`／`literature`／`training`／`admin`／`misc`）／手動排序 `sort_order`。`category` 跟既有的 `type`（活動性質）是兩個不同的欄位，互不覆蓋 |
| `move_folder` | 把資料夾搬到另一個上層資料夾，或搬回最上層；超過四層知識架構上限或搬到自己子孫底下會被擋下 |
| `move_entry` | 把一筆記事搬到另一個資料夾，或搬回收件匣；只改歸檔位置，不動標題／內文／附件 |
| `delete_folder` | 刪除一個資料夾——底下的記事與子資料夾會自動搬到上一層（最上層則搬回收件匣），不會遺失任何資料，跟 App 裡的刪除按鈕行為一致 |

### Medtec 2026 參展系統
| 工具 | 用途 |
|---|---|
| `search_exhibitors` | 搜 585 家展商（名稱／攤位／國家／產品／分類），附團隊共筆狀態 |
| `get_exhibitor` | 讀單一展商完整資料（主檔＋拜訪狀態＋部門標籤＋附件清單） |
| `search_visit_notes` | 搜團隊拜訪紀錄全文（誰記了什麼） |
| `search_exhibitor_files` | 搜展商附件內容全文（現場錄音逐字稿、型錄 OCR）——問「某家廠商的塗層方案細節」用這個 |
| `list_exhibitor_files` | 列出某展商全部附件（不用先猜關鍵字），附內容長度 |

### 系統狀態
| 工具 | 用途 |
|---|---|
| `sync_status` | 查外部知識庫（litdb 等）最後同步時間與最近同步紀錄——懷疑「資料是不是過時」直接查事實，不用猜 |

### 搜尋工具的共同行為
`search_*` 系列全部支援：
- **簡繁通用**：繁體查得到簡體庫、簡體查得到繁體庫（型錄常是簡體、個人記事常是繁體）
- **多詞查詢**：關鍵字用空白隔開，預設全部詞都要命中；全部命中查不到時會自動放寬
  成任一詞命中，並在回應裡標示「以下為部分符合」
- **同義詞展開**：慣用語會自動對應到正式名稱（例如查「HD管」找得到「體外血液處理
  用導管」），對照表存在資料庫裡，公司內部代號直接在對話裡用 `add_synonym` 補
- **查無結果會誠實回報**：不會只回一句「查無資料」，會說明實際嘗試過哪些詞，
  讓你分辨「真的沒有」還是「用詞沒對上」

## 安全設計摘要

- **fail-closed**：`MCP_PIN` 沒設定時，這個端點會拒絕所有請求，不會裸奔
- **預設唯讀，例外分兩組**：程式碼裡絕大多數是 SELECT／fetch。第一組
  `create_fieldlog_entry`／`create_fieldlog_attachment`／`create_relation`／
  `add_synonym` 全部只會新增（`create_fieldlog_attachment` 上傳檔案是透過
  fieldlog 自己的 `/api/upload`，跟其餘三支直接 INSERT D1 的路徑不同，但
  一樣只新增一筆附件），沒有任何 UPDATE／DELETE 語句碰得到 entries 的內容／
  attachments／relations／synonyms。第二組 `update_folder`／`move_folder`／
  `move_entry`／`delete_folder`（2026-08-08 新增）會真的造成 UPDATE／DELETE，
  但透過 FIELDLOG Service Binding 代理呼叫 fieldlog 自己既有的
  `PUT`／`DELETE /api/folders`、`PUT /api/entries` 端點，範圍鎖死在資料夾
  結構與記事歸檔位置，不會動到任何記事或附件的標題／內文／附件內容，
  `delete_folder` 也不會遺失資料（內容自動搬到上一層）
- 三個後端來源（策略地圖 Wiki、隨身記、Medtec）各自獨立的 Cloudflare
  Worker／資料庫，這個 MCP 只是加一層查詢介面，不做跨系統的資料庫合併。
  LitDB（`chiuchangru/litdb`）已於 2026-07-26 併入隨身記，由 fieldlog 的
  每日 cron 單向同步，這個 MCP 不對外部的 litdb repo 做任何查詢

## 疑難排解

- **OAuth 組態擷取失敗**：確認 URL 是 `.../mcp`，且 Worker 已部署含 OAuth 的版本
- **授權頁 PIN 錯誤**：檢查 Cloudflare `medapi-mcp` 的 `MCP_PIN`，不要誤用 `FIELD_PIN`
- **工具清單是空的／連不上**：中斷舊連線後，以乾淨的 `.../mcp` URL 重新連接
- **查詢回「查無資料」但你確定有**：先確認關鍵字沒有打錯字；試試拿掉
  `folder_id`／`folder_type` 這類縮小範圍的參數，改成全庫查；同義詞沒收錄的
  慣用語（例如很冷門的公司內部代號）本來就查不到，直接在對話裡用
  `add_synonym` 補一組對照，補完立刻生效
