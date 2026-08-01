/**
 * 資料庫結構與遷移——fieldlog 的單一真相來源。
 *
 * D1 沒有 ALTER TABLE ... IF NOT EXISTS，所以 MIGRATIONS 一律「跑了失敗就忽略」，
 * 每次冷啟動重跑一遍是安全的（欄位已存在就是失敗、忽略）。
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT '其他',
    status TEXT DEFAULT '進行中',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER,
    title TEXT DEFAULT '',
    fields_json TEXT DEFAULT '{}',
    body TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    kind TEXT DEFAULT 'file',
    filename TEXT NOT NULL,
    original_filename TEXT DEFAULT '',
    key TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime TEXT DEFAULT '',
    transcript TEXT DEFAULT '',
    offset_secs INTEGER,
    category TEXT DEFAULT '',
    content_hash TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    folder_id INTEGER,
    action TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_usage_reservations (
    attachment_id INTEGER PRIMARY KEY,
    usage_date TEXT NOT NULL,
    estimated_neurons REAL NOT NULL,
    status TEXT DEFAULT 'reserved',
    created_at TEXT NOT NULL
  )`,
  // 記事與記事之間的關聯（例：這次實驗引用了這份 ISO 標準、這份專利對照這家廠商的產品）。
  // 刻意不分「主從」、也不限制 relation_type 的字典——用途橫跨標準/實驗/廠商/專利，
  // 關係種類會一直長，寫死列表反而綁死用法。方向性用 relation_type 的文字本身表達
  // （例："引用標準"／"被引用於"是同一件事的兩個方向，查詢時雙向都會找到）。
  `CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entry_id INTEGER NOT NULL,
    to_entry_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  // 分類字典——資料夾層級分類與醫材分類都放這裡，使用者自己在前台就能增刪改。
  //
  // 為什麼要有這張表：這兩套分類原本是寫死在程式碼陣列裡的，要加一個分類就得改程式、
  // 重新部署，使用者自己動不了。分類本身是「會一直長」的東西（新產品線、新文件類型），
  // 寫死等於每次都要工程介入，所以搬進資料庫。
  //
  // kind  — 'folder_type'：建立資料夾時選的分類；'device'：檔案的醫材分類
  // level — folder_type 專用：1..4 對應四層架構的第幾層；0＝每一層都出現（通用分類）
  // fields_json — 這個分類的記事欄位模板（JSON 字串陣列），空陣列＝不帶模板
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'folder_type',
    level INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🗂️',
    note TEXT DEFAULT '',
    fields_json TEXT DEFAULT '[]',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  // 外部資料來源清單——「要同步哪些 JSON、陣列鍵叫什麼、進哪個資料夾」全是資料，
  // 不寫死在程式碼裡。理由與 categories 表完全相同：來源是「會一直長」的東西
  // （今天是 litdb 三個收藏，明天可能加市場分析），寫死等於每加一個就要改程式
  // 重新部署。新增一個知識庫＝往這張表加一列，全程不碰 .js。
  //
  // items_path — 資料陣列在來源 JSON 裡的鍵名（litdb 叫 papers，別的來源可能叫
  //              reports／items），這個欄位就是「不用為新格式改程式」的關鍵
  // folder_parent — 目標資料夾的上層資料夾名稱（空＝放最上層）；沿用現有
  //                 「LitDB 文獻庫」母資料夾＋各收藏子資料夾的結構
  `CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    items_path TEXT DEFAULT 'papers',
    id_field TEXT DEFAULT 'id',
    title_field TEXT DEFAULT 'title',
    folder_parent TEXT DEFAULT '',
    folder_type TEXT DEFAULT '文獻庫',
    enabled INTEGER DEFAULT 1,
    last_synced_at TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  // 同步紀錄——每跑一次同步（手動或排程）記一列，讓「資料庫是不是過時、
  // 上次漏了什麼」變成查得到的事實，不用靠記憶（ALCOA 的可追溯精神）。
  `CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT,
    started_at TEXT,
    finished_at TEXT,
    inserted INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    orphaned INTEGER DEFAULT 0,
    errors TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entry_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique ON categories(kind, level, name)`,
];

// 舊表補欄位用（D1 沒有 ADD COLUMN IF NOT EXISTS，欄位已存在時失敗直接忽略即可）
export const MIGRATIONS = [
  `ALTER TABLE folders ADD COLUMN parent_id INTEGER`,
  `ALTER TABLE folders ADD COLUMN notion_page_id TEXT DEFAULT ''`,
  `ALTER TABLE folders ADD COLUMN notion_last_entry_id INTEGER DEFAULT 0`,
  `ALTER TABLE folders ADD COLUMN notion_synced_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_text TEXT DEFAULT ''`,
  // 「處理過但結果是空的」（照片沒文字、錄音無語音）要跟「還沒處理」分開，
  // 否則空結果的附件永遠被當成待整理，每按一次整理就重跑重扣一次費用
  `ALTER TABLE attachments ADD COLUMN transcribed_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_at TEXT DEFAULT ''`,
  // Tier 2 深度處理（手動指定，見 DATA-MODEL.md）：把來源 PDF 逐頁 render 成圖片，
  // 存成一般照片附件、走既有 OCR 流程。source_pdf_id 指回來源 PDF 的 attachments.id，
  // page_no 是第幾頁，兩者都空＝不是深度處理產生的附件。
  `ALTER TABLE attachments ADD COLUMN source_pdf_id INTEGER`,
  `ALTER TABLE attachments ADD COLUMN page_no INTEGER`,
  `ALTER TABLE attachments ADD COLUMN duration_secs INTEGER`,
  // 檔案內容 SHA-256：同一筆記事重複上傳完全相同的檔案時直接略過
  `ALTER TABLE attachments ADD COLUMN content_hash TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN original_filename TEXT DEFAULT ''`,
  // 只屬於單一檔案的附屬記事（跟 entries.body 分開——一筆記事可以掛多個檔案）
  `ALTER TABLE attachments ADD COLUMN note TEXT DEFAULT ''`,
  // 醫材分類（選項來自 categories 表 kind='device'；這裡存的是分類名稱文字，
  // 刪掉分類選項時既有檔案上的分類文字仍然留著，不會靜默消失）
  `ALTER TABLE attachments ADD COLUMN device_category TEXT DEFAULT ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_att_entry_hash ON attachments(entry_id, content_hash) WHERE content_hash IS NOT NULL AND content_hash <> ''`,
  // 深度解析欄位（規格書 II 項目 8）——AI 理解後的「結構化結論」與人工內容永久分離：
  // 解析結果只進這幾欄，永不覆蓋 body／note，人的判斷是最終權威。
  // analysis_at 沿用 ocr_at 的三態設計：''=未做／'skipped'=不做／'processing'／
  // 'failed'／ISO 時間=完成。analysis_hash 存「被解析當下的來源內容 hash」，
  // 內容沒變就不重跑——這是成本控制的核心。
  `ALTER TABLE entries ADD COLUMN analysis_json TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN analysis_at TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN analysis_model TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN analysis_profile TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN analysis_hash TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN analysis_json TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN analysis_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN analysis_model TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN analysis_profile TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN analysis_hash TEXT DEFAULT ''`,
  // 標準文件可能只是節錄／預覽版（例如從 standards.iteh.ai 等預覽站下載，
  // 官方全文其實更長）。source_url 讓上傳時選填記下下載來源，用來比對已知
  // 預覽站網域；total_pages 存 Tier 2 深度處理時 pdf.js 讀到的「這個檔案實際
  // 有幾頁」，用來跟目錄推算的頁數互相比對，抓出頁數不夠的節錄版（2026-07-27
  // 長儒回報：ISO 10555-8 只到 p6、缺 Annex A/B，之後這種情況要能自動標警示，
  // 不要靠人記）。
  `ALTER TABLE attachments ADD COLUMN source_url TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN total_pages INTEGER`,
  // 記事內文格式：'text'（預設，含所有既有資料與來源同步管理的記事，body 是
  // 純文字／Markdown，走舊的 <textarea>）或 'html'（富文字編輯器產生的 HTML
  // 片段，照片以 <img> 內嵌）。不做批次轉換，使用者自己按「升級為富文字」
  // 才會把某一筆從 text 換成 html；同步管理的記事（fields_json._sid／
  // litdb_id 有值）永遠鎖在 text，sync.js 的 SYNC_START/SYNC_END 標記完全
  // 不會遇到 html 格式。
  `ALTER TABLE entries ADD COLUMN body_format TEXT DEFAULT 'text'`,
];

/**
 * 外部來源的初始內容——litdb 的三個收藏。跟 CATEGORY_SEED 一樣只在第一次寫入，
 * 之後使用者增刪改（含整列刪掉）都不會被倒回來。
 *
 * 真相來源考證（2026-07-26）：litdb 根目錄的 papers.json（107 筆）沒有被任何
 * 頁面引用（root index.html 零個 fetch），是殘留檔；多出的 R01–R05 是五筆
 * 一模一樣的空殼（同標題同連結、其餘欄位全空）。coating/index.html 實際讀的
 * 是 coating/papers.json（102 筆），所以這裡以各子目錄的檔案為準。
 */
export const SOURCE_SEED = [
  { key: "coating", label: "親水塗層文獻", url: "https://chiuchangru.github.io/litdb/coating/papers.json", folder_parent: "LitDB 文獻庫" },
  { key: "biopsy", label: "活檢針機構", url: "https://chiuchangru.github.io/litdb/biopsy/biopsy_patents.json", folder_parent: "LitDB 文獻庫" },
  { key: "packaging", label: "醫材包裝技術", url: "https://chiuchangru.github.io/litdb/packaging/papers.json", folder_parent: "LitDB 文獻庫" },
];

/**
 * 分類字典的初始內容——只在 categories 表「完全空的」時寫入一次。
 * 之後使用者在前台怎麼增刪改都不會被這裡覆蓋回去。
 *
 * 這份種子就是原本寫死在程式碼裡的那兩套清單（四層架構的層級分類 ＋ 醫材分類），
 * 搬進資料庫當起始值，讓使用者從現有狀態繼續改，而不是從空白開始。
 */
export const CATEGORY_SEED = [
  // ---- 通用（level 0）：每一層都可以選，沿用原本的活動型資料夾分類 ----
  { kind: "folder_type", level: 0, name: "參展", icon: "🏢", note: "展會與廠商", fields: ["廠商名", "攤位", "目標", "取得資料", "下一步"] },
  { kind: "folder_type", level: 0, name: "拜訪", icon: "🤝", note: "客戶與供應商", fields: ["對象", "聯絡人", "討論事項", "結論", "待辦"] },
  { kind: "folder_type", level: 0, name: "實驗", icon: "🧪", note: "條件與結果", fields: ["主題", "條件／參數", "觀察結果", "判定", "下次調整"] },
  { kind: "folder_type", level: 0, name: "上課", icon: "🎓", note: "課程與筆記", fields: ["課程名", "講者", "重點", "待查資料"] },
  { kind: "folder_type", level: 0, name: "會議", icon: "👥", note: "決議與待辦", fields: ["會議主題", "與會者", "討論事項", "決議", "待辦／負責人"] },
  { kind: "folder_type", level: 0, name: "查廠", icon: "🔎", note: "查核與改善", fields: ["廠商／廠區", "查核範圍", "觀察結果", "缺失／風險", "改善追蹤"] },
  { kind: "folder_type", level: 0, name: "標準", icon: "📐", note: "ISO／ASTM 等規範", fields: ["標準編號", "版本／年份", "適用範圍", "關鍵要求", "對應產品／實驗"] },
  { kind: "folder_type", level: 0, name: "廠商", icon: "🏭", note: "供應商與產品", fields: ["攤位／位置", "國家", "產品", "聯絡窗口", "評估結果"] },
  { kind: "folder_type", level: 0, name: "專利", icon: "💡", note: "專利與技術", fields: ["專利號", "申請／公告日", "專利權人", "技術重點", "與我方關聯"] },
  { kind: "folder_type", level: 0, name: "其他", icon: "🗂️", note: "自由分類", fields: [] },

  // ---- 第 1 層：產品／專案 ----
  { kind: "folder_type", level: 1, name: "中央靜脈導管（CVC）", icon: "🩺", note: "中央靜脈導管產品資料", fields: [] },
  { kind: "folder_type", level: 1, name: "血液透析導管（HD）", icon: "🩸", note: "透析導管產品資料", fields: [] },
  { kind: "folder_type", level: 1, name: "引流導管（Pigtail）", icon: "🧫", note: "引流導管產品資料", fields: [] },
  { kind: "folder_type", level: 1, name: "高壓注射筒組", icon: "💉", note: "高壓注射相關產品", fields: [] },
  { kind: "folder_type", level: 1, name: "輸液器具／逆止閥", icon: "💧", note: "輸液與流體控制產品", fields: [] },
  { kind: "folder_type", level: 1, name: "共通法規／標準", icon: "📚", note: "跨產品共用規範", fields: [] },
  { kind: "folder_type", level: 1, name: "供應商／合作夥伴", icon: "🏭", note: "跨產品合作資料", fields: [] },
  { kind: "folder_type", level: 1, name: "其他專案", icon: "🗂️", note: "其他產品或專案", fields: [] },

  // ---- 第 2 層：文件類型 ----
  { kind: "folder_type", level: 2, name: "法規與標準", icon: "📘", note: "ISO、ASTM、FDA、MDR 等", fields: [] },
  { kind: "folder_type", level: 2, name: "設計開發", icon: "🧩", note: "需求、規格、圖面與變更", fields: [] },
  { kind: "folder_type", level: 2, name: "驗證與確效", icon: "🧪", note: "計畫書、原始資料與報告", fields: ["主題", "條件／參數", "觀察結果", "判定", "下次調整"] },
  { kind: "folder_type", level: 2, name: "風險管理", icon: "⚠️", note: "風險分析、控制與追蹤", fields: ["危害／情境", "風險評估", "控制措施", "殘餘風險", "追蹤"] },
  { kind: "folder_type", level: 2, name: "臨床／仿單", icon: "🩺", note: "臨床情境與使用說明", fields: ["臨床情境", "使用者", "使用步驟", "關鍵功能", "注意事項"] },
  { kind: "folder_type", level: 2, name: "註冊送件", icon: "📮", note: "查驗登記與送件版本", fields: ["市場／國家", "送件版本", "主管機關問題", "回覆內容", "待辦"] },
  { kind: "folder_type", level: 2, name: "製造／供應商", icon: "🏭", note: "製程、原料與供應商", fields: ["廠商／廠區", "材料／製程", "規格", "問題／風險", "改善追蹤"] },
  { kind: "folder_type", level: 2, name: "會議／紀錄", icon: "👥", note: "決議、拜訪、查廠與課程", fields: ["會議主題", "與會者", "討論事項", "決議", "待辦／負責人"] },
  { kind: "folder_type", level: 2, name: "其他文件", icon: "🗂️", note: "其他文件類型", fields: [] },

  // ---- 第 3 層：主題／試驗／標準系列 ----
  { kind: "folder_type", level: 3, name: "標準系列／章節", icon: "📚", note: "例如 ISO 8536、ISO 10555", fields: [] },
  { kind: "folder_type", level: 3, name: "試驗項目", icon: "🧪", note: "例如流量、洩漏、抗拉、顯影", fields: [] },
  { kind: "folder_type", level: 3, name: "零組件／功能", icon: "⚙️", note: "依結構、零件或功能細分", fields: [] },
  { kind: "folder_type", level: 3, name: "國家／市場", icon: "🌏", note: "台灣、美國、歐盟等", fields: [] },
  { kind: "folder_type", level: 3, name: "供應商／型號", icon: "🏭", note: "依來源或型號細分", fields: [] },
  { kind: "folder_type", level: 3, name: "專案階段", icon: "🗓️", note: "設計、驗證、送件、上市後", fields: [] },
  { kind: "folder_type", level: 3, name: "其他主題", icon: "🗂️", note: "其他主題分類", fields: [] },

  // ---- 第 4 層：年份／版本／文件群 ----
  { kind: "folder_type", level: 4, name: "年份／版本", icon: "🗓️", note: "依年份、版次或修訂版", fields: [] },
  { kind: "folder_type", level: 4, name: "單一標準／文件", icon: "📄", note: "特定標準或正式文件", fields: [] },
  { kind: "folder_type", level: 4, name: "試驗批次／報告", icon: "🧪", note: "特定批次、計畫或報告", fields: [] },
  { kind: "folder_type", level: 4, name: "送件版本", icon: "📮", note: "補件、變更或核准版本", fields: [] },
  { kind: "folder_type", level: 4, name: "會議日期", icon: "👥", note: "依日期或會議場次", fields: [] },
  { kind: "folder_type", level: 4, name: "其他細分", icon: "🗂️", note: "最後一層自由分類", fields: [] },

  // ---- 醫材分類（掛在單一檔案上）----
  { kind: "device", level: 0, name: "中央靜脈導管（CVC）", icon: "🩺", note: "", fields: [] },
  { kind: "device", level: 0, name: "血液透析導管（HD）", icon: "🩸", note: "", fields: [] },
  { kind: "device", level: 0, name: "引流導管（Pigtail）", icon: "🧫", note: "", fields: [] },
  { kind: "device", level: 0, name: "高壓注射筒組", icon: "💉", note: "", fields: [] },
  { kind: "device", level: 0, name: "輸液器具／逆止閥", icon: "💧", note: "", fields: [] },
  { kind: "device", level: 0, name: "其他", icon: "🗂️", note: "", fields: [] },
];

// 資料夾最多幾層（四層知識架構）
export const MAX_FOLDER_DEPTH = 4;

let schemaReady = false;

/** 建表、補欄位、必要時寫入分類種子。整個 Worker 生命週期只跑一次。 */
export async function ensureSchema(db, timestamp) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    await db.prepare(sql).run().catch(() => {});
  }
  await seedCategories(db, timestamp);
  await seedSources(db, timestamp);
  schemaReady = true;
}

// 測試用：重置「已初始化」旗標
export function resetSchemaCacheForTests() {
  schemaReady = false;
}

/**
 * 只在分類表完全空的時候寫入種子。
 * 使用者刪光所有分類是合法狀態（例如想全部換成自己的），所以用一個標記列
 * 記住「種子已經放過了」，避免下次冷啟動又把預設分類倒回來。
 */
async function seedCategories(db, timestamp) {
  const seeded = await db
    .prepare("SELECT id FROM categories WHERE kind = '_seeded' LIMIT 1")
    .first()
    .catch(() => null);
  if (seeded) return;

  const statements = [
    db.prepare(
      "INSERT INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at) VALUES ('_seeded', 0, 'seeded', '', '', '[]', 0, ?)"
    ).bind(timestamp),
  ];
  CATEGORY_SEED.forEach((item, index) => {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.kind,
        item.level,
        item.name,
        item.icon || "🗂️",
        item.note || "",
        JSON.stringify(item.fields || []),
        index,
        timestamp
      )
    );
  });
  await db.batch(statements);
}

/**
 * 只在第一次寫入外部來源種子。跟分類一樣用標記列記住「放過了」——
 * 使用者刪掉某個來源（不想再同步）是合法狀態，冷啟動不能倒回來。
 * 標記列借放 categories 表（kind='_sources_seeded'），不另開表。
 */
async function seedSources(db, timestamp) {
  const seeded = await db
    .prepare("SELECT id FROM categories WHERE kind = '_sources_seeded' LIMIT 1")
    .first()
    .catch(() => null);
  if (seeded) return;

  const statements = [
    db.prepare(
      "INSERT INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at) VALUES ('_sources_seeded', 0, 'seeded', '', '', '[]', 0, ?)"
    ).bind(timestamp),
  ];
  for (const s of SOURCE_SEED) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO sources (key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).bind(
        s.key,
        s.label,
        s.url,
        s.items_path || "papers",
        s.id_field || "id",
        s.title_field || "title",
        s.folder_parent || "",
        s.folder_type || "文獻庫",
        timestamp
      )
    );
  }
  await db.batch(statements);
}
