# CIIF 2026 團隊 App 交接檔（給 Codex）

## 目的

長儒下一個要出的展是 **CIIF 2026**（第 26 屆中國國際工業博覽會，機械／工業展，
跟 Medtec 是完全不同的展）。他要求「比照 Medtec 那套」蓋一個新的團隊 App，
交給你（Codex）獨立完成，我（Claude）只負責寫這份交接檔把架構、現有資料、
還缺什麼都寫清楚，實際動手蓋站與後續補資料是你的工作。

**尚未拿到的資料（機票、飯店、行程細節等）一律先留空**，做出可以之後
直接填資料的骨架就好，不要編造內容。展商資料我已經先附上目前查到的
（見下方「展商資料現況」），你要接續查完剩下的部分。

這份文件讀完應該就知道：這個網站的技術架構、要有哪些頁面／功能、資料表
長怎樣、現有資料在哪裡、還缺什麼。不需要另外回來問我，可以直接動工；
真的卡住再另外寫文件回報（可以比照 repo 根目錄既有的
`CLAUDE-FINDINGS-FOR-CODEX.md` 那種格式，留言在檔案裡对齐）。

---

## 1. 展會基本資訊

| 項目 | 內容 |
|---|---|
| 展會名稱 | CIIF 2026（第 26 屆中國國際工業博覽會 / China International Industry Fair） |
| 時間 | 2026/10/12（一）–10/16（五） |
| 地點 | 上海國家會展中心（虹橋，NECC）——**注意跟 Medtec 的新國際博覽中心（SNIEC，浦東）是不同館**，動線／住宿建議都不能沿用 Medtec 那份 |
| 官方分類 | 9 大專業展：<br>`MWCS` 數控機床與金屬加工展、`IAS` 工業自動化展、`RS` 機器人展、`GLCS` 綠色低碳與工業節能配套展、`ICTS` 工業新一代信息技術與應用展、`FTIS` 空天陸裝備展、`ES` 智慧能源展、`STIS` 科技創新展、`NMIS` 新材料產業展 |
| 規劃面積 | 官方稱超過 30 萬平方米（比 Medtec 大很多，展商總數約 2,670 家，見下方展商資料） |

來源：CIIF 官網 <https://www.ciif-expo.com/> 與官方展商名錄 PDF（見下方展商資料章節）。

## 2. 團隊名單（7 位，先留空 email／2 位待補）

不要在網站前端顯示 email（長儒明確要求 email 不用 show，只在後端/內部文件保留即可，且目前只給了部分人的 email，先不放）。

| 姓名 | 部門 | 備註 |
|---|---|---|
| 吳玉政 | 品質管理部 | |
| 陳慶倫 | 研發一部 | |
| 李明彥 | 自動化設計課 | |
| 廖建智 | 龍德廠 | |
| 俞淑娟 | （待補部門） | |
| ＿＿＿＿ | （待補） | 第 6 位，姓名待補 |
| ＿＿＿＿ | （待補） | 第 7 位，姓名待補 |

> 這份名單先當佔位骨架用，等於 Medtec 那套 `MEMBER_PROFILES` / `PREP_ORDER`
> 的雛形（見下方 config.js schema）。實際部署前要跟長儒確認：(a) 剩下兩位
> 是誰、(b) 每個人的職掌／關注分類要對到哪個 CIIF 展區分類（品保/研發/自動化
> 設計課這幾個部門名稱，直接對應 MWCS／IAS／RS／NMIS 的邏輯要重新設計，不能
> 照抄 Medtec 那套醫材部門對應）。

## 3. 明確留空、之後才填的資料

以下欄位**先做出結構、留空／放 TBD 佔位文字**，不要編造內容：

- 機票、航班時間、去回程日期
- 住宿飯店
- 地面接駁／包車（比照 Medtec `shuttleContact` 的欄位形狀留著即可，內容空）
- 逐日行程（`TRIP_DAYS` 對應的內容，只做資料結構，日期/事項全部留空或 `TBD`）
- 展中／展外會談對象、時間、聯絡窗口（對應 Medtec 的 `KEY_VISITS`，目前完全沒有，等長儒 / 團隊之後給）
- 展館分區導覽圖（`HALL_GUIDE` 用的平面圖圖檔，目前沒有官方圖檔，先不做這個功能，等圖進來再加）
- 我方公司若有參展攤位（目前不確定是參觀還是參展，先當「純參觀考察團」設計，若之後改成也參展要另外處理報名/攤位資訊）

## 4. 展商資料現況

已放在同一個 repo：**`ciif-2026/EXHIBITOR-RESEARCH.md`**（我把長儒上傳的檔案原封
不動複製過來，你直接讀那份，內容包含：

- 資料來源：CIIF 官方展商名錄 PDF（<https://static.ciif-expo.com/annex/2026-09-16/124257/2026.pdf>），共 **2,670 筆**展商紀錄
- 防重主鍵格式：`CIIF26-R0001` ～ `CIIF26-R2670`，每一筆固定對應「PDF 頁碼＋攤位號＋原始公司名稱」，之後補資料只能更新同一列、不能新增別名列（這點很重要，理由見下方第 7 節「id 穩定性」）
- **進度：目前只完成第 1 批（R0001–R0267，267 家）**，第 2–10 批（R0268–R2670，共 2,403 家）都還沒查
- 該檔案裡已經內建一套完整的「10 階段檢索 SOP」「信心度規則 L1–L5」「醫療器材關聯性四類判定」，這是原本鎖定「機械展裡有沒有跟邦特醫材業務相關的廠商」的篩選邏輯——**這套判定邏輯是幫邦特（醫材廠）在機械展裡找潛在供應商用的，你可以照抄同一套 SOP 繼續查完第 2–10 批**，不用另外發明新規則
- 已用這套 SOP 篩出 **10 家醫療器材關聯候選廠商**（`CIIF-MD-001`～`CIIF-MD-010`，含官網、產品錨點、優先級 S1–S4），可以直接當第一批「重點廠商」種子資料

### 你要做的事（展商資料）

1. **接續查第 2–10 批**（R0268–R2670），完全比照該檔案裡已經寫好的 SOP／信心度規則／醫療關聯判定，不要自創格式。
2. 把整份（含未完成部分持續累積）轉成本 repo 既有 App 用的 `exhibitors.json` 格式（schema 見下方第 6 節），存到 `ciif-2026/public/data/exhibitors.json`。
3. 轉檔時把 `CIIF26-R00xx` 當成穩定主鍵沿用（例如轉成 `id: "ex-ciif-r0001"` 之類，只要固定不再變動即可），額外欄位（醫療關聯性、信心度、優先級 S1–S5）**不在原本 Medtec 的 schema 裡，屬於新增欄位**，直接加在每筆展商物件上即可（App 前端要不要顯示是另一回事，資料先留著）。

## 5. 建議架構：完整比照 Medtec 那套（`cloudflare/`）

Medtec 那套（`cloudflare/` 目錄）技術棧是 **Cloudflare Workers + D1（SQL）+ 靜態
assets**，功能完整、已經在真實團隊出差中驗證過好幾輪，直接複製這個架構最快、
風險最低。新專案放在 repo 根目錄新資料夾 **`ciif-2026/`**（我已建好空資料夾），
結構完全比照：

```
ciif-2026/
├── README.md              # 比照 cloudflare/README.md，部署步驟／啟用選用功能
├── wrangler.jsonc          # Cloudflare Worker 設定
├── EXHIBITOR-RESEARCH.md   # 已放好（見上方第 4 節）
├── public/
│   ├── index.html
│   ├── app.js
│   ├── config.js           # 展會設定檔（團隊、行程、展商分類對應）
│   ├── style.css
│   ├── manifest.json
│   ├── sw.js
│   ├── data/
│   │   └── exhibitors.json
│   ├── images/
│   └── icons/
└── src/
    ├── worker.js            # /api/* 後端
    └── imageSkill.js        # 若要做照片 OCR／PDF 附件功能才需要，可選
```

### 5.1 `wrangler.jsonc`（比照 `cloudflare/wrangler.jsonc`）

```jsonc
{
  "name": "ciif-2026",
  "main": "src/worker.js",
  "compatibility_date": "2026-07-01",
  "keep_vars": true,               // 一定要留，不然每次 deploy 會把 TEAM_PIN 等 Secret 清掉
  "assets": {
    "directory": "public",
    "binding": "ASSETS",
    "run_worker_first": true
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ciif-2026",
      "database_id": "＿＿部署時到 Cloudflare Dashboard 建好 D1 後填入＿＿"
    }
  ]
  // r2_buckets（照片/錄音上傳）與 ai（Workers AI 轉錄）都是選用，
  // 沿用 cloudflare/wrangler.jsonc 的寫法，暫時不需要就先不加
}
```

部署方式（Cloudflare Dashboard → Workers → Create a Worker → Continue with
GitHub → 選這個 repo，**Root directory 填 `ciif-2026`**）跟 `cloudflare/README.md`
第 1–3 節完全一樣，照抄流程即可，我不重複貼一次；`TEAM_PIN` 這組共用密碼要
另外跟長儒要新的一組（不要沿用 Medtec 的 `bioteq2026`，避免兩個展的權限混用）。

### 5.2 `public/config.js` schema（每個常數的欄位形狀）

這是靜態設定檔，改這個檔案就能調整篩選/顯示邏輯，不用動程式主體。
比照 `cloudflare/public/config.js`（705 行），把以下常數依 CIIF 情境重寫：

```js
// 展區視角：CIIF 官方 9 大專業展，取代 Medtec 的 DEPT_PRESETS（品保/RA/設備…）
// 這裡改成直接對應 CIIF 官方分類，因為公司內部部門（品質管理部/研發一部/
// 自動化設計課/龍德廠）跟 Medtec 那套「品保/RA/文管/設備…」不是同一套邏輯，
// 要重新設計每個人對應哪些展區比較有感
const SECTOR_PRESETS = [
  { id: "mwcs", name: "數控機床與金屬加工", icon: "⚙️", keywords: [...] },
  { id: "ias",  name: "工業自動化",         icon: "🤖", keywords: [...] },
  { id: "rs",   name: "機器人",             icon: "🦾", keywords: [...] },
  { id: "glcs", name: "綠色低碳與工業節能", icon: "🌱", keywords: [...] },
  { id: "icts", name: "工業新一代信息技術", icon: "💻", keywords: [...] },
  { id: "ftis", name: "空天陸裝備",         icon: "🚀", keywords: [...] },
  { id: "es",   name: "智慧能源",           icon: "🔋", keywords: [...] },
  { id: "stis", name: "科技創新",           icon: "🧪", keywords: [...] },
  { id: "nmis", name: "新材料產業",         icon: "🧱", keywords: [...] },
];

// 團隊成員與職掌：登入時選名字，決定預設看到哪個展區視角
// 欄位形狀比照 Medtec 的 MEMBER_PROFILES：{ name, duty, chips: [{k, id}] }
const MEMBER_PROFILES = [
  { name: "吳玉政", duty: "品質管理", chips: [{ k: "sector", id: "?" }] },  // TBD：對應哪個展區待確認
  { name: "陳慶倫", duty: "研發一部", chips: [{ k: "sector", id: "?" }] },
  { name: "李明彥", duty: "自動化設計", chips: [{ k: "sector", id: "ias" }] },
  { name: "廖建智", duty: "龍德廠", chips: [{ k: "sector", id: "?" }] },
  { name: "俞淑娟", duty: "", chips: [] },
  // 剩下兩位名字/職掌待補
];

// 舊拼法/改名對照，沒有的話留空陣列即可
const NAME_ALIASES = {};
const HIDDEN_MEMBERS = [];

// 行程：全部留空/TBD，等長儒補資料
const TRIP = { depart: "", return: "" };   // ISO 時間字串，機票確認後填
const TRIP_DAYS = [];                       // 逐日行程，形狀比照 Medtec TRIP_DAYS（date/label/weekday/kind/am/pm/stay/transit），先空陣列
const KEY_VISITS = [];                      // 展中/展外會談對象，形狀比照 Medtec（match/when/contact/note），先空陣列
const HALL_GUIDE = null;                    // 沒有官方平面圖前先不做這個功能

// 拜訪狀態／索取資料／觀展目標等選項，可直接沿用 Medtec 同名常數的選項設計
// （STATUS_OPTIONS、COLLECTED_OPTIONS、GOAL_OPTIONS、QUAL_OPTIONS、
// POST_CLASS_OPTIONS、OBTAINED_OPTIONS、NEXT_STEP_OPTIONS、NOTE_TYPES），
// 這些是通用的展會拜訪流程，不是 Medtec 專屬，照抄即可省事。
```

### 5.3 `src/worker.js`：D1 資料表（比照 `cloudflare/src/worker.js` 的 `SCHEMA`）

核心表（**必做**，這是共筆功能的骨幹）：

```sql
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  dept TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exhibitor_state (
  exhibitor_id TEXT PRIMARY KEY,
  status TEXT DEFAULT '未排定',      -- STATUS_OPTIONS
  assignee TEXT DEFAULT '',
  dept_tags TEXT DEFAULT '[]',       -- JSON 陣列
  collected TEXT DEFAULT '[]',
  goal_tags TEXT DEFAULT '[]',
  quals TEXT DEFAULT '[]',
  post_class TEXT DEFAULT '',
  pocket INTEGER DEFAULT 0,
  updated_by TEXT DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibitor_id TEXT NOT NULL,
  author TEXT NOT NULL,
  type TEXT DEFAULT '現場紀錄',
  content TEXT NOT NULL,
  deleted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS history (        -- append-only 稽核軌跡，不可刪改
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibitor_id TEXT,
  author TEXT,
  action TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
```

**工作重點看板**（比照這次幫長儒改過好幾輪、最後定案的 Medtec 版 Artifact
設計，見下方第 8 節「工作重點看板設計教訓」，直接照那個定案版本做，不要重蹈
覆轍先做複雜版再被打掉重練）：

```sql
CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  order_no INTEGER DEFAULT 0,
  topic TEXT DEFAULT '',
  member TEXT DEFAULT '[]',     -- JSON 陣列，可複選負責人
  notes TEXT DEFAULT '',        -- 單一自由文字欄，廠商/設備/現場發現都寫在這裡
  updated_by TEXT DEFAULT '',
  updated_at TEXT
);
```

選用進階表（**不急，等核心功能穩了再看要不要加**，Medtec 那邊分別對應
附件上傳、LINE 每日摘要、論壇議程、參訪前報告、自訂展商、出發前清單）：
`attachments`、`line_recipients`、`custom_exhibitors`、`sessions` /
`session_notes`、`prep_notes` / `prep_overrides`、`pretrip_checklist`、
`help_requests`（廠商協尋看板，AI 幫忙從展商目錄挑候選）。這些表的完整欄位
定義直接讀 `cloudflare/src/worker.js` 第 17–172 行照抄即可，這裡不重複貼。

### 5.4 API 認證機制（一定要照做，不要簡化掉）

所有 `/api/*` 請求要帶 `x-team-pin` header，跟 Worker 的 `TEAM_PIN`
Secret 比對；**`TEAM_PIN` 未設定時一律拒絕（fail-closed）**，正式環境與本機
測試都要求有 PIN，不要為了方便開發就留後門繞過。部署後到 Cloudflare
Dashboard → Settings → Variables and Secrets 設定 `TEAM_PIN`（Secret 類型），
存檔後 redeploy 一次才生效。

### 5.5 核心 API 端點（比照 `cloudflare/src/worker.js` 既有命名）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/config` | 回傳前端需要的設定 |
| GET/POST | `/api/members` | 團隊成員名單（登入時自動登記） |
| GET/PUT | `/api/state` , `/api/state/:id` | 展商拜訪狀態共筆 |
| GET/POST/PUT/DELETE | `/api/notes` , `/api/notes/:id` | 現場紀錄（軟刪除） |
| GET | `/api/history` | 稽核軌跡 |
| GET | `/api/export.csv` | 匯出 CSV |
| GET/PUT/DELETE | `/api/highlights` 系列 | 工作重點看板（若採用 D1 版而非獨立 Artifact，見第 8 節） |

進階功能對應的端點（`/api/custom-exhibitors`、`/api/help-requests`、
`/api/upload`、`/api/attachments`、`/api/sessions`、`/api/prep-notes`、
`/api/pretrip-checklist` 等）等核心功能穩定後再依需求加，做法直接照抄
`cloudflare/src/worker.js` 對應區塊。

## 6. `exhibitors.json` 目標格式（展商資料要轉成這個形狀）

```json
{
  "event": {
    "name_zh": "CIIF 2026（第26屆中國國際工業博覽會）",
    "name_en": "China International Industry Fair 2026",
    "dates": "2026-10-12 至 2026-10-16",
    "venue_zh": "上海國家會展中心（虹橋）",
    "venue_en": "National Exhibition and Convention Center (Shanghai)",
    "official_site": "https://www.ciif-expo.com/",
    "exhibitor_directory": "https://static.ciif-expo.com/annex/2026-09-16/124257/2026.pdf",
    "note": "資料來源見 ciif-2026/EXHIBITOR-RESEARCH.md，持續補查中"
  },
  "categories": [
    { "id": "mwcs", "name_zh": "數控機床與金屬加工展", "name_en": "..." },
    { "id": "ias",  "name_zh": "工業自動化展", "name_en": "..." }
    // ... 其餘 7 個官方分類
  ],
  "exhibitors": [
    {
      "id": "ex-ciif-r0001",
      "source_id": "CIIF26-R0001",
      "name_zh": "上海京就医疗器械有限公司",
      "name_en": "",
      "booth_no": "7.2H-A320",
      "hall": "7.2H",
      "country": "中國",
      "category": "nmis",
      "tags": [],
      "description": "醫用熱敏／乾式雷射膠片、醫用影像印表機",
      "products": ["醫用熱敏膠片", "醫用乾式雷射膠片", "醫用影像印表機"],
      "website": "https://www.shjjyl.cn/",
      "directory_url": "",
      "pdfs": [],
      "photo": "",
      "in_directory": true,

      "medical_relevance": "直接相關",
      "confidence_level": "L5",
      "priority": "S4",
      "verified_at": "2026-09-18"
    }
  ]
}
```

跟 Medtec 版 `exhibitors.json`（`cloudflare/public/data/exhibitors.json`）比：
`id`/`name_zh`/`name_en`/`booth_no`/`hall`/`country`/`category`/`tags`/
`description`/`products`/`website`/`directory_url`/`pdfs`/`photo`/
`in_directory` 這些欄位完全照抄同一個形狀；`source_id`/`medical_relevance`/
`confidence_level`/`priority`/`verified_at` 是這次新增的欄位，來自
`EXHIBITOR-RESEARCH.md` 既有的判定資料，前端要不要顯示可以晚點再決定，
但轉檔時資料要保留，不要丟掉。

## 7. 重要教訓：展商 id 絕對不能因為重新匯入而改變

`scripts/import_exhibitors.py`（repo 根目錄）這支腳本的開頭寫了一段慘痛教訓，
直接引用給你參考，CIIF 這邊要用同樣的原則：

> D1 裡好幾張表全部用 `exhibitor_id` 這個字串當外鍵（拜訪狀態、現場紀錄、
> 照片、稽核軌跡）。如果每次重新匯入展商名單都用「列序」重新編號 id，
> 名單只要新增/移除/排序變了，後面所有公司的 id 就整批位移，於是每一則
> 現場紀錄、每一張照片、每一筆拜訪狀態都會安靜地掛到「別家公司」身上，
> 沒有任何錯誤訊息。

CIIF 這邊你已經有 `CIIF26-R0001`～`CIIF26-R2670` 這組穩定主鍵可以直接沿用
（`EXHIBITOR-RESEARCH.md` 裡已經講得很清楚：「每筆固定對應 PDF 頁碼＋攤位
號＋原始公司名稱，後續只更新同一列，不新增別名列」），轉成 `exhibitors.json`
的 `id` 時務必保留這個對應關係（可以直接拿 `source_id` 欄位存原始
`CIIF26-Rxxxx`，`id` 欄位另外決定格式但兩者要能對回去），之後不管補查多少
批、修改多少次資料，同一家公司的 id 都不能變。

## 8. 工作重點看板設計教訓（如果 CIIF 網站也要做這個功能）

這次幫長儒改 Medtec 的「展後工作重點」看板（獨立 Artifact，不是這次
`cloudflare/` App 的一部分，但邏輯值得參考），一路被打回來重做好幾次，
最後定案的設計原則，直接抄結論可以少走很多冤枉路：

1. **不要幫使用者做「結構化」**。一開始設計成「關聯廠商（可搜尋 900 家展商
   自動帶入）＋對應設備＋現場發現」三個獨立欄位，使用者反而要在文字裡用
   括號手動標註「這句話是哪家廠商的」，等於同一份資訊寫兩遍。長儒最後要求
   **後面幾個相關欄位全部合併成一個自由文字欄**，讓人自己寫，不要系統幫忙
   結構化。
2. **負責人要可複選**，不要用單選下拉——一個工作重點常常是兩三個人一起
   負責的。
3. **不要放「狀態：已完成」這種沒意義的核取方塊**——填了內容就代表有東西
   要報告，不需要額外標記完成與否。
4. 前端**淺色固定版面**，不要深色系＋強調色跳色那種一眼看出來是 AI 生成的
   視覺——長儒明確嫌「太 AI」。
5. 如果要做即時共筆（多人同時編輯同一份），**重畫畫面時要用 diff 比對，
   只在順序真的變了才搬動 DOM 節點**，不要每次收到更新就整個重建，否則
   正在打字的輸入框會因為節點被搬移而失焦、游標跳走（這是真實踩過的 bug，
   根因是防手震自動存檔觸發的即時同步回音，把自己打的字存回去又觸發重畫）。

如果 CIIF 也要類似的「工作重點」或「拜訪重點回報」功能，直接照這個定案
設計做，不要重新從複雜版本開始再被打掉。

## 9. 完成後你要回報的東西

不用回來問我，但建議完工或卡關時，比照 repo 既有的 handoff 慣例
（`CLAUDE-WEEKLY-CHANGES-FOR-CODEX-2026-08-20.md` 這種命名），另外寫一份
`CIIF-2026-CODEX-PROGRESS.md`，簡單列：

- 做到哪個階段（骨架完成／展商資料查到第幾批／已部署到哪個網址）
- 有沒有偏離這份交接檔的地方，為什麼
- 還缺什麼資料需要長儒補（機票、飯店、會談對象等，第 3 節那份清單）
