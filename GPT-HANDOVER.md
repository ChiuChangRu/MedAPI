# GPT 交接清單：MyWiki ＋ 展場資料

> 這份給 **GPT／其他 AI 開發代理** 用，目的是讓你在沒有前情的情況下，
> 能直接**改程式、跑驗證、部署上線**（vibe coding），而不只是查資料。
>
> - 只想「接上去問問題」而不改程式 → 看 [`mcp/CONNECT-GPT.md`](mcp/CONNECT-GPT.md)
> - 想了解設計決策的來龍去脈 → 看 [`ARCHITECTURE.md`](ARCHITECTURE.md)
> - 這份文件**不含任何密碼／PIN／Token 的實際值**，那些私下交付。
>
> 最後校對：2026-08-11。文件內容都是照當下的程式碼實際核對過的，
> 不是憑印象寫的。與程式碼牴觸時**一律以程式碼為準**，並請順手更新這份。

---

## 〇、30 秒總覽

一個 repo（`ChiuChangRu/MedAPI`）裡有 **3 個各自獨立的 Cloudflare Worker**，
共用同一個 Cloudflare 帳號，但各自有 D1／R2，互不依賴：

| 子系統 | 目錄 | 是什麼 | 線上網址 |
|---|---|---|---|
| **medtec-2026**（展場資料） | `cloudflare/` | 9 人團隊共筆：881 家展商、拜訪紀錄、行程、論壇議程、參訪前報告 | `https://medtec-2026.gogoyankee.workers.dev` |
| **fieldlog**（隨身記） | `fieldlog/` | 個人現場採集：錄音／拍照／速記，AI 轉文字 | `https://fieldlog.gogoyankee.workers.dev` |
| **medapi-mcp**（MyWiki 問答層） | `mcp/` | MCP 伺服器，讓 GPT／Claude 跨三來源自然語言查詢 | `https://medapi-mcp.gogoyankee.workers.dev` |
| 策略地圖 Wiki（知識層） | `fieldlog/public/wiki/` | 10 篇 Markdown 技術條目，git 版控、**人審才收錄** | 在隨身記內 `wiki.html` |

另有兩份**已停用的舊版展場系統**：`docs/`（GitHub Pages 靜態版）、
`app/`（FastAPI 版）。**主線是 `cloudflare/`，那兩個不要動**。

---

## 一、最重要的一件事：部署管線（先讀完再改任何東西）

這裡踩過坑，寫清楚免得重蹈覆轍。

### medtec-2026 是靠 GitHub Actions 部署的，不是 Cloudflare Git 整合

```
push 到 main（且動到 cloudflare/**）
    → .github/workflows/deploy.yml
    → cloudflare/wrangler-action@v3（wranglerVersion: "4.120.1"）
    → wrangler deploy（工作目錄 cloudflare/）
```

**兩個絕對不能動的地方：**

1. **`wranglerVersion: "4.120.1"` 不可移除。**
   wrangler-action@v3 預設安裝 **3.90.0**，而 wrangler 要到 **3.91.0**
   才看得懂 `wrangler.jsonc`（`.jsonc` 副檔名）。少了這行，它會完全
   讀不到設定檔，以 `Missing entry-point` 失敗。
   這個 workflow 從 2026-08-05 建立到 2026-08-11 之間跑了 4 次、**全部失敗**，
   原因就是這個；正式站因此卡在舊版好幾天沒人發現。

2. **`wrangler.jsonc` 的 `keep_vars: true` 不可移除。**
   沒有它，每次 `wrangler deploy` 都會把 Dashboard 上設定的 Secret 清掉。
   `TEAM_PIN` 一不見全隊就進不去系統；LINE token 不見則是推播無聲失效。
   （`tests/` 裡有專門的測試在守這一條，別把它改掉。）

### 分支的坑

Cloudflare Dashboard 上 medtec-2026 的 **Production branch 設定成
`claude/medtec-exhibitor-directory-kbs2i8`**，不是 `main`。歷史因素。

**目前的做法：兩條分支保持內容完全相同。** 每次改動走兩個 PR：

```
feature-branch → main                                （PR 1，觸發 GitHub Actions 部署）
main → claude/medtec-exhibitor-directory-kbs2i8       （PR 2，fast-forward，保持同步）
```

> 曾試著在 Dashboard 把 Production branch 改成 `main`，存檔一直噴
> `Invalid request body` 改不動，所以改用「兩邊同步」繞過。
> 如果哪天 Dashboard 修好了，把它改成 `main` 就能省掉 PR 2。

### fieldlog 與 medapi-mcp

這兩個走 **Cloudflare 自己的 Git 整合**（push 就自動建置），跟上面
GitHub Actions 那條無關。PR 上會看到 bot 貼三則部署留言，**注意看是哪一個
Worker**，不要拿 fieldlog 的 Preview URL 去驗 medtec 的功能（踩過）。

### 部署後怎麼確認

前端是 PWA、有 service worker 快取，**一般重新整理看不到新版**。
一定要 `Ctrl+Shift+R`（Mac 是 `Cmd+Shift+R`）強制重新整理。
還是舊的就開無痕視窗，或到 DevTools → Application → Service Workers → Unregister。

---

## 二、動手前的固定流程

```bash
npm install                  # 第一次一定要跑，沒裝 @cf-wasm/photon 會有 11 個 mcp 測試假性失敗
npm run validate             # 語法檢查 + 418 個測試 + 三個 Worker 的 dry-run 打包
```

**基準狀態（2026-08-11 實測）：`npm run validate` 全綠，418 個測試全過。**
所以你跑出來只要有紅的，就是你改壞的，不是本來就壞。

個別指令：

| 指令 | 做什麼 |
|---|---|
| `npm run check` | 六支 worker 原始碼的 `node --check` 語法檢查 |
| `npm test` | `node --test tests/*.test.js`，41 個檔、418 個測試 |
| `npm run validate:medtec` | 展場系統 `wrangler deploy --dry-run`，驗設定檔與 binding |
| `npm run validate:fieldlog` / `:mcp` | 同上，另外兩個 Worker |

> `--dry-run` 不需要憑證、不會真的部署，可以放心跑。

### 前端改動請實際看畫面

`cloudflare/public/` 是純靜態，可以直接起本機伺服器看：

```bash
cd cloudflare/public && python3 -m http.server 8765
# 然後用 Playwright（環境已預裝 Chromium，PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers）
# 開 http://127.0.0.1:8765/index.html 截圖檢查
```

登入需要 PIN，測試時可在 console 裡直接設狀態繞過：

```js
const d = await (await fetch('data/exhibitors.json')).json();
EXHIBITORS = d.exhibitors; CATEGORIES = d.categories;
for (const c of CATEGORIES) CAT_MAP[c.id] = c;
computeLineMatches();
localStorage.setItem('medtec_user', '長儒');
API_OK = true; STATE = {};
document.body.classList.remove('locked');
renderTaskSummary(); setView('itinerary');
```

---

## 三、展場資料（`cloudflare/`）

### 檔案結構

| 檔案 | 內容 | 大小感 |
|---|---|---|
| `src/worker.js` | 全部後端 API（單檔） | ~1400 行 |
| `src/imageSkill.js` | OCR／文件解析／關聯判斷，與 fieldlog 共用同一份 | ~340 行 |
| `public/index.html` | 版面骨架、所有 modal 與頁籤 | ~270 行 |
| `public/app.js` | 全部前端邏輯（單檔、無框架、無建置流程） | ~3400 行 |
| `public/config.js` | **設定與內容都在這**——改這裡就能改行為，不用動邏輯 | ~630 行 |
| `public/style.css` | 樣式 | ~1150 行 |
| `public/data/exhibitors.json` | 897 筆展商（其中 881 筆在最新名冊） | 1.1MB |
| `public/data/data-changelog.json` | 名冊每次重新匯入的異動說明 | — |
| `wrangler.jsonc` | Worker 設定、D1／R2／AI binding | — |

**沒有 npm 建置流程，沒有框架。** `public/` 直接就是部署出去的東西，
改完存檔重新整理就看得到。這是刻意的（展場現場要能快速修）。

### `config.js`：優先改這裡

前端的「內容」幾乎都抽到 `config.js`，改這裡不用碰邏輯：

| 常數 | 控制什麼 |
|---|---|
| `DEPT_PRESETS` | 單位視角入口（品保／生產／設備…）對應的分類與關鍵字 |
| `PRODUCT_LINES` | 產品／科別入口（TPU 導管、心血管…）的關鍵字比對 |
| `TECH_MAP` | **五年技術地圖**：雷射加工／披膜三兄弟／薄壁繞簧管／編織管／變徑異型押出／TPU 球囊導管 |
| `MEMBER_PROFILES` | 團隊成員與職掌，決定登入後推薦哪些視角 |
| `NAME_ALIASES` / `HIDDEN_MEMBERS` | 名字正規化（如 `振哲`→`政哲`）、不顯示的帳號 |
| `KEY_VISITS` | 行程重點廠商（展中會談／工廠拜訪），會在展商清單標記 |
| `TRIP` / `TRIP_DAYS` | 行程期間判定、六天行程總覽的全部內容 |
| `PREP_REPORT` / `PREP_ORDER` | 參訪前報告：七人各自的關注重點與必問 |
| `STATUS_OPTIONS` / `GOAL_OPTIONS` / `NOTE_TYPES` 等 | 各種下拉與標籤選項 |

> 家數一律**即時算出**，`config.js` 裡不寫死數字——名冊更新時才不會脫節。

### D1 資料表（10 張）

資料庫 `medtec-2026`，`database_id` 見 `wrangler.jsonc`。
Schema 定義在 `src/worker.js` 開頭的 `SCHEMA` 陣列，Worker 第一次收到請求時
自動建表；後加的欄位放 `MIGRATIONS` 陣列（用 `ALTER TABLE`，重複執行安全）。

| 表 | 主鍵 | 用途 |
|---|---|---|
| `members` | name | 團隊成員 |
| `exhibitor_state` | exhibitor_id | 拜訪狀態、負責人、部門標籤、索取資料、口袋名單、拜訪成果 |
| `notes` | id | 展商的團隊紀錄（軟刪除 `deleted`） |
| `attachments` | id | 照片／錄音／影片／文件，檔案本體在 R2，這裡只存 metadata 與 OCR／逐字稿 |
| `history` | id | 所有異動留痕（**追加不刪**） |
| `line_recipients` | user_id | LINE 每日摘要推播名單 |
| `custom_exhibitors` | id（`custom-` 前綴） | 官方名冊以外、團隊自己加的廠商 |
| `sessions` | id | 論壇議程場次（8 筆種子資料） |
| `session_notes` | id | 議程的現場紀錄 |
| `prep_notes` | member | 參訪前報告每人一欄自由文字 |

**兩個重要慣例：**

- **不真的刪資料。** `notes`／`custom_exhibitors` 用 `deleted` 軟刪除；
  官方名冊下架的展商標 `in_directory: false` 保留（目前 16 筆），
  否則既有的拜訪紀錄會變成查不到名字的孤兒。
  → 所以「共 N 家展商」顯示 **881**（`in_directory !== false`），
  但資料庫裡是 **897** 筆。這是刻意的，不要「修正」成一致。
- **異動要寫 `history`。** 用 `logHistory(db, exhibitorId, author, action, detail)`。
  不屬於任何展商的異動（議程、參訪前報告）`exhibitorId` 傳 `null`，
  前端會標成「🗣 論壇議程」之類，不會顯示成空白展商名。

### API（全部在 `/api/*`，需帶 `x-team-pin`）

驗證是 **fail-closed**：`TEAM_PIN` 未設定時**所有請求一律拒絕**。
不要為了方便測試把這個改成 fail-open。

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/config` | 前端功能開關（R2／AI 有沒有啟用） |
| GET/POST | `/members` | 團隊成員 |
| GET | `/state` | 一次撈全部展商共筆狀態 |
| PUT | `/state/:id` | 局部更新展商狀態 |
| GET/POST | `/notes`、PUT/DELETE `/notes/:id` | 展商紀錄 |
| POST | `/upload`；GET `/attachments`；GET `/file/:key` | 附件（R2） |
| PUT/DELETE | `/attachments/:id` | 說明、分類、逐字稿、擷取文字、略過整理 |
| POST | `/attachments/:id/transcribe`、`/ocr` | Workers AI 轉文字／擷取文字 |
| GET | `/search-texts` | 附件全文彙整，讓搜尋框搜得到照片裡的字 |
| GET | `/history` | 團隊動態 |
| GET | `/sessions`；PUT `/sessions/:id` | 論壇議程 |
| GET/POST | `/session-notes`；PUT/DELETE `/session-notes/:id` | 議程紀錄 |
| GET | `/prep-notes`；PUT `/prep-notes/:member` | 參訪前報告自由欄 |
| GET/POST | `/custom-exhibitors`；DELETE `/custom-exhibitors/:id` | 自訂廠商 |
| GET | `/report?author=` | 個人參訪報告（HTML，可列印存 PDF） |
| GET | `/export.csv` | 全隊資料匯出 |
| GET | `/ai-usage` | 今日 AI 用量（與 fieldlog 共用額度，粗估值） |

### 前端頁籤（`setView(view)`）

`itinerary`（首頁）→ `search` → `assigned` → `visited` → `agenda` → `prep`。

切換機制：`setActiveViewTab()` 在 `<body>` 加 class（`itinerary-view`／
`agenda-view`／`prep-view`／`todo-view`），CSS 再把不相干的區塊 `display:none`。
**加新頁籤時三個地方都要改**：`index.html` 的按鈕與 section、`app.js` 的
`setView`／`setActiveViewTab`、`style.css` 的 `body.xxx-view` 規則。

### 離線設計（不要破壞）

展場現場網路很差，這套刻意做了離線韌性：

- service worker 快取靜態檔（`public/sw.js`，網路優先、失敗退快取）
- 共筆狀態／筆記快照存 localStorage，斷網照樣能瀏覽與寫
- 寫入失敗會進待同步佇列，連上網自動補傳（`syncPending()`）
- 行程期間（`TRIP.depart` ~ `TRIP.return`）自動進離線模式，不等連線逾時

改寫入路徑時，記得 `isNetworkError(err)` 那條 fallback 要留著。

---

## 四、MyWiki（`mcp/` ＋ `fieldlog/`）

### medapi-mcp：問答層

一台 MCP 伺服器（`mcp/src/worker.js`），**27 個工具**，跨三個來源查詢。
它用 service binding 呼叫另外兩個 Worker（`FIELDLOG`、`MEDTEC`），
也直接綁了兩個 D1（`DB_FIELDLOG`、`DB_MEDTEC`）。

**權限模型是這個系統的核心設計，改之前先想清楚：**

- **19 個工具只做 SELECT／fetch**，完全唯讀
- **4 個只能新增**：`create_fieldlog_entry`、`create_fieldlog_attachment`、
  `create_relation`、`add_synonym`——鎖死在「只能加一筆全新的」，
  不能修改或刪除既有內容
- **4 個資料夾整理工具**會真的 UPDATE／DELETE，但範圍限定在資料夾名稱／
  分類／排序／巢狀位置與記事的歸檔位置：`update_folder`、`move_folder`、
  `move_entry`、`delete_folder`（刪資料夾不會遺失內容，會搬到上一層）
- **記事與附件的實際內容，沒有任何工具能改或刪。** 要改請走各系統前台。

工具清單與逐支說明在 [`mcp/README.md`](mcp/README.md) 與
[`mcp/CONNECT-GPT.md`](mcp/CONNECT-GPT.md)（後者已照程式碼核對過）。

### 策略地圖 Wiki：**AI 不可直接寫入**

`fieldlog/public/wiki/` 底下 10 篇 Markdown（A1–A3 披膜、B1–B2 材料製程…），
**走 git 人審才收錄**。這是刻意的架構決策：wiki 是唯一的知識匯流點，
內容品質靠人把關，AI 產出的整理不能直接進生產內容。

→ **你可以提 PR 修改 wiki，但不要設計任何讓 AI 自動寫入 wiki 的機制。**

### fieldlog：採集端

`fieldlog/src/worker.js` ＋ `src/lib/` 底下九個模組（schema、sync、
autofile、attachments、richtext、standards、categories、render、cleanup）。
每天 UTC 18:00 有 cron 從外部來源（LitDB 三個收藏）**單向**同步文字進來——
只改寫同步區、人工註記永不覆蓋、content hash 沒變就不動。
**fieldlog 永遠不寫回外部來源。**

### 引用紀律（寫功能時要保留的語意）

記事裡標示「**AI 深度解析**」的段落是 AI 產出的整理／推論，**不是現場原始紀錄**。
任何呈現或匯出都要保留這個標示，不要把它跟原始逐字稿混在一起呈現。

---

## 五、Secrets 與環境（值私下交付，不要寫進任何檔案）

| 名稱 | 位置 | 用途 |
|---|---|---|
| `TEAM_PIN` | medtec-2026 Worker Secret | 展場系統登入（fail-closed） |
| `FIELD_PIN` | fieldlog Worker Secret | 隨身記登入＋wiki |
| `MCP_PIN` | medapi-mcp Worker Secret | MCP 端點驗證 |
| `CLOUDFLARE_API_TOKEN` | **GitHub repo Secret** | GitHub Actions 部署用 |
| `CLOUDFLARE_ACCOUNT_ID` | **GitHub repo Secret** | 同上 |
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | medtec-2026 Worker Secret | 每日摘要推播（選用） |

> `CLOUDFLARE_API_TOKEN` 曾經失效導致部署連續失敗（錯誤訊息是
> `Authentication error [code: 10000]` 與 `Invalid access token [code: 9109]`）。
> 需要的權限：Workers Scripts `Edit`、D1 `Edit`、Workers R2 Storage `Edit`、
> Workers AI `Edit`、Account Settings `Read`、User Details `Read`。
> 建 token 時**建議不要設到期日**，不然過期又會無聲失敗。

---

## 六、守則（會被 code review 擋下來的事）

1. **不要刪資料。** 一律軟刪除或標記；`history` 只追加。
2. **不要拿掉 `keep_vars: true` 與 `wranglerVersion` 釘版。**（見第一節）
3. **不要把 PIN 驗證改成 fail-open。**
4. **不要在前端靜態檔寫入個資。** `config.js` 是公開可讀的——
   團隊成員一律**去姓留名**（與 `MEMBER_PROFILES` 一致），
   接駁地點只到路名不含門牌，內部公文名稱與日期不要出現在畫面或註解。
5. **不要讓 AI 直接寫入 wiki。**（見第四節）
6. **不要動 `docs/` 與 `app/`。** 那是停用的舊版。
7. **不要憑印象寫數字。** 家數、筆數一律從資料即時算，或先跑腳本確認。
8. **前端改動要實際看畫面。** 這套會被主管看，版面壞掉很明顯。

---

## 七、常見任務怎麼做

### 加一個新頁籤

1. `index.html`：`.view-tabs` 加 `<button class="view-tab" data-view="xxx">`，
   容器裡加 `<section id="xxx-section">`
2. `app.js`：`setActiveViewTab()` 加 `document.body.classList.toggle("xxx-view", view === "xxx")`；
   `setView()` 加分支呼叫你的 render 函式與 scroll 目標
3. `style.css`：加 `body.xxx-view` 把其他區塊藏起來，`#xxx-section` 預設 `display:none`
4. 參考現成的：論壇議程（`agenda`）、行程總覽（`itinerary`）、參訪前報告（`prep`）

### 加一張 D1 資料表

1. `src/worker.js` 的 `SCHEMA` 陣列加 `CREATE TABLE IF NOT EXISTS`
2. **既有環境已經建過表**，新欄位要另外加進 `MIGRATIONS` 陣列的 `ALTER TABLE`
   （`ensureSchema` 會吞掉 `duplicate column` 錯誤，重跑安全）
3. 加對應的 API 路由，異動記得 `logHistory`

### 更新展商名冊

用 `scripts/` 底下的腳本（`scrape_exhibitor_list.js`、
`merge_exhibitor_sources.py`、`import_exhibitors.py` 等）。
**規則：既有的 `ex-XXXX` id 絕對不變**（否則團隊的拜訪紀錄會全部對不上），
新名冊沒有的公司標 `in_directory: false` 保留不刪，
並在 `public/data/data-changelog.json` 補一則異動說明。

---

## 八、目前已知、還沒處理的事

- **常美的展位號有出入**：內部行程表寫 `3F408`，官方名冊是 `N3-D408`
  （`N3-F408` 是另一家「上海凡雲新材料」）。程式兩處都標了待確認提示，
  出發前要跟對方確認。見 `config.js` 的 `KEY_VISITS` 與 `TRIP_DAYS`。
- **伊諾窗口姓氏**：系統記「秦曉鵬」，內部文件掃描件看起來像「蔡」，
  未確認前維持系統原值。
- **Cloudflare Production branch 改不動**（見第一節），目前用雙 PR 繞過。
- 其他既有問題見 [`BUG-LIST.md`](BUG-LIST.md)。

---

## 九、延伸閱讀

| 文件 | 講什麼 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 設計決策與全貌：為什麼三系統不合併、MCP 為何預設唯讀、wiki 為何走人審 |
| [`DATA-MODEL.md`](DATA-MODEL.md) | 資料存哪裡（R2 檔案／D1 文字）、四種整理狀態、PDF 三種辨識差異、查證 SQL |
| [`HANDOVER.md`](HANDOVER.md) | 給人類接手者的交接（權限授予流程）。⚠️ 部分內容較舊（例如仍寫 585 家） |
| [`SECOND-BRAIN.md`](SECOND-BRAIN.md) | 日常操作流程：採集 → 整理 → 更新 wiki → 問答 |
| [`mcp/README.md`](mcp/README.md) | MCP 伺服器完整說明與 27 支工具 |
| [`mcp/CONNECT-GPT.md`](mcp/CONNECT-GPT.md) | 在 ChatGPT 設定 MCP 連接器的步驟 |
| [`cloudflare/README.md`](cloudflare/README.md) | 展場系統的部署與選用功能（R2／LINE／轉文字）設定 |
| [`REPORT.md`](REPORT.md) | Medtec 2026 展會準備報告（七條機會，議程與參訪前報告的內容來源） |
