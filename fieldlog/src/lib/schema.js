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
    transcript_vtt TEXT DEFAULT '',
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
  `CREATE TABLE IF NOT EXISTS share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    entry_id INTEGER NOT NULL,
    attachment_id INTEGER,
    snapshot_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT DEFAULT '',
    allow_attachments INTEGER DEFAULT 1,
    allow_download INTEGER DEFAULT 0,
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
    client_key TEXT PRIMARY KEY,
    failures INTEGER DEFAULT 0,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT DEFAULT ''
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
  // 系統層 key-value。早期曾存「暫存區放幾天後 AI 自動歸類」；該功能移除後，
  // 現在改用於後臺維護版本標記。版本標記存在 D1，而不是 localStorage，才能確保
  // 換瀏覽器或換電腦時不會再次掃描整個資料庫。
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // 垃圾桶只記「被刪除的根項目」。資料夾／紀錄本身仍保留原本的父子關係，
  // deleted_at 只負責把整棵樹從一般查詢隱藏；還原時才能原封不動回到原位置。
  `CREATE TABLE IF NOT EXISTS trash_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    deleted_at TEXT NOT NULL,
    purge_after TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'trashed',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT DEFAULT '',
    purge_started_at TEXT DEFAULT '',
    UNIQUE(item_type, item_id)
  )`,
  // 人工核准過的固定分類規則（keyword → folder_id）與歷史修正紀錄。
  // 2026-08-09 曾停用，v142 B 模式只重新啟用 status='active' 的人工規則；
  // suggested 規則與舊修正資料不會自行生效。
  `CREATE TABLE IF NOT EXISTS autofile_hints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS autofile_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    from_folder_id INTEGER,
    to_folder_id INTEGER NOT NULL,
    keyword_guess TEXT DEFAULT '',
    reviewed_at TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  // v142 B 模式：AI 只處理待分類中的新／已更新資料。建議、已自動套用、
  // 已接受、已拒絕、已復原各自有明確狀態，不能只靠 entries.auto_filed_at
  // 一個欄位猜現在走到哪一步。entry_id 唯一＝同一筆只保留最新判斷；
  // source_updated_at 改變才允許重算，避免每天對同一內容重複扣 AI 額度。
  `CREATE TABLE IF NOT EXISTS filing_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL UNIQUE,
    suggested_folder_id INTEGER,
    previous_folder_id INTEGER,
    ai_folder_id INTEGER,
    vector_folder_id INTEGER,
    confidence REAL DEFAULT 0,
    vector_score REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    basis TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    source_updated_at TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reviewed_at TEXT DEFAULT ''
  )`,
  // 搜尋同義詞表（mcp/src/search.js 的 setSynonymGroups 用）。原本只由 medapi-mcp
  // 那支 Worker 在第一次搜尋時建立（見 mcp/src/worker.js 的 ensureSynonyms），
  // 是「只有 fieldlog 帶 migration」這個原則下的一個例外；fieldlog 首頁的
  // /search 端點（2026-08-09）同樣要用到這張表，補進這裡才符合原本的原則，
  // IF NOT EXISTS 對已經由 mcp 建過的既有資料庫是無害的 no-op。
  `CREATE TABLE IF NOT EXISTS synonyms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical TEXT NOT NULL,
    aliases_json TEXT DEFAULT '[]',
    codes_json TEXT DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash_items(purge_after)`,
  `CREATE INDEX IF NOT EXISTS idx_filing_suggestions_status ON filing_suggestions(status, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique ON categories(kind, level, name)`,
];

// 舊表補欄位用（D1 沒有 ADD COLUMN IF NOT EXISTS，欄位已存在時失敗直接忽略即可）
export const MIGRATIONS = [
  `ALTER TABLE folders ADD COLUMN parent_id INTEGER`,
  // 資料夾的特殊身分。目前只有一種：role='staging'＝「暫存區」，現場來不及分類
  // 的東西先丟這裡。用欄位而不是靠名字認，是因為名字可以被使用者改掉，改完
  // 之後自動歸類就再也找不到那個資料夾（而且不會有任何錯誤訊息）。
  `ALTER TABLE folders ADD COLUMN role TEXT DEFAULT ''`,
  // AI 自動歸類的標記。v142 B 模式重新寫入，供待分類清單顯示、確認與復原：
  // ''＝沒被自動歸類過；ISO 時間＝AI 歸的；'failed'＝跑過但 AI 判斷不出來。
  `ALTER TABLE entries ADD COLUMN auto_filed_at TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN auto_filed_reason TEXT DEFAULT ''`,
  `ALTER TABLE folders ADD COLUMN notion_page_id TEXT DEFAULT ''`,
  `ALTER TABLE folders ADD COLUMN notion_last_entry_id INTEGER DEFAULT 0`,
  `ALTER TABLE folders ADD COLUMN notion_synced_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_text TEXT DEFAULT ''`,
  // 「處理過但結果是空的」（照片沒文字、錄音無語音）要跟「還沒處理」分開，
  // 否則空結果的附件永遠被當成待整理，每按一次整理就重跑重扣一次費用
  `ALTER TABLE attachments ADD COLUMN transcribed_at TEXT DEFAULT ''`,
  // Whisper 的時間碼用來把逐字稿和拍照依真實錄音秒數穿插進同一份 Word 內文。
  // transcript 保留純文字供搜尋；VTT 另外存，不能互相取代。
  `ALTER TABLE attachments ADD COLUMN transcript_vtt TEXT DEFAULT ''`,
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
  // 記事內文格式：'text'（純文字／Markdown）或 'html'（富文字編輯器產生的
  // HTML 片段，照片以 <img> 內嵌）。欄位預設值仍是 'text'，因為既有資料庫
  // 裡的每一列在這個 migration 跑之前就已經存在，一律先是純文字；但 2026-08-01
  // 起新記事一律直接建成 'html'（見 worker.js 的 POST /entries），舊的純
  // 文字記事打開時就自動以富文字編輯、存檔時一併轉檔，使用者不用知道有
  // 「升級」這件事，也沒有對應的手動按鈕。唯一維持 'text' 的例外是來源
  // 同步管理的記事（fields_json._sid／litdb_id 有值）——sync.js 靠
  // <!-- sync:start/end --> 這組純文字標記圈出同步管理區，換成富文字編輯器
  // 容易在瀏覽器序列化時弄丟標記，所以這類記事永遠鎖在 text，不會遇到
  // html 格式。
  `ALTER TABLE entries ADD COLUMN body_format TEXT DEFAULT 'text'`,
  // 照片顯示用的旋轉角度（0/90/180/270，每次點旋轉鈕 +90 mod 360）。純顯示層
  // 中繼資料，不動 R2 裡的原始檔案——raw data 只增不刪，旋轉只是前端渲染時
  // 加一個 CSS transform。
  `ALTER TABLE attachments ADD COLUMN rotation INTEGER DEFAULT 0`,
  // 資料夾的色系分組（2026-08-08 分類重整）。跟既有的 folders.type 是兩個不同的軸，
  // 不要混用：
  //   type     ＝活動性質（參展／拜訪／實驗／上課／會議／查廠／其他…），已被
  //              folder_type 搜尋參數、匯出檔名等大量既有邏輯使用，維持不動
  //   category ＝色系分組（見 FOLDER_CATEGORIES），只用來讓資料夾清單依「性質
  //              大類」分色分組顯示與排序，不影響 type 既有的任何行為
  // 新增時一律是 NULL（尚未分類），前端／排序邏輯要把 NULL 當成 misc（最後一組）
  // 處理，不能排到最前面造成視覺混亂。
  `ALTER TABLE folders ADD COLUMN category TEXT`,
  // 同一層級內的手動排序，數字小的排前面；NULL／相同值時退回既有的
  // id／status 排序，不影響原本沒設定過排序的資料夾。
  `ALTER TABLE folders ADD COLUMN sort_order INTEGER`,
  // v109：紀錄本身也是 Windows 式資料包，可以一層包一層；正式資料夾與
  // 紀錄刪除都先進垃圾桶，60 天後才永久清除。
  `ALTER TABLE entries ADD COLUMN parent_entry_id INTEGER`,
  `ALTER TABLE entries ADD COLUMN deleted_at TEXT DEFAULT ''`,
  `ALTER TABLE folders ADD COLUMN deleted_at TEXT DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(deleted_at)`,
  // 首頁與檔案總管的熱路徑索引。放在 MIGRATIONS（不是 SCHEMA），因為舊資料庫
  // 要先補 parent_id／parent_entry_id／deleted_at 欄位後才能建立這些索引。
  `CREATE INDEX IF NOT EXISTS idx_folders_parent_active ON folders(parent_id) WHERE COALESCE(deleted_at, '') = ''`,
  `CREATE INDEX IF NOT EXISTS idx_entries_folder_root_active ON entries(folder_id, parent_entry_id) WHERE COALESCE(deleted_at, '') = ''`,
  `CREATE INDEX IF NOT EXISTS idx_entries_recent_active ON entries(COALESCE(NULLIF(updated_at, ''), created_at) DESC, id DESC) WHERE COALESCE(deleted_at, '') = '' AND parent_entry_id IS NULL`,
  `ALTER TABLE trash_items ADD COLUMN state TEXT NOT NULL DEFAULT 'trashed'`,
  `ALTER TABLE trash_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE trash_items ADD COLUMN last_error TEXT DEFAULT ''`,
  `ALTER TABLE trash_items ADD COLUMN purge_started_at TEXT DEFAULT ''`,
  // 語意搜尋（Vectorize）：附件與記事各自的向量化狀態。vector_id 存的是
  // Vectorize 那邊的 id（附件可能對應多支分段向量，這裡存主 id 前綴，實際
  // 分段 id 用 att-{id}-{n} 規則算出來，不用另外存清單）。
  `ALTER TABLE attachments ADD COLUMN vector_id TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN embedding_status TEXT DEFAULT 'pending'`,
  `ALTER TABLE attachments ADD COLUMN embedding_error TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN vector_id TEXT DEFAULT ''`,
  `ALTER TABLE entries ADD COLUMN embedding_status TEXT DEFAULT 'pending'`,
  `ALTER TABLE entries ADD COLUMN embedding_error TEXT DEFAULT ''`,
];

// folders.category 的合法值——色系分組，見上面 MIGRATIONS 裡的說明。
// 陣列順序＝顯示優先序（category_rank），不是字母序：越前面代表「預期會長越大」，
// 不是「現在筆數比較多」，避免之後又要重排一次。
export const FOLDER_CATEGORIES = [
  "project",
  "training",
  "admin",
  "literature",
  "routine_report",
  "ai_adoption",
  "qa_reg",
  "misc",
];

// 資料夾清單依 category 分組排序用的 SQL 片段（§B5）。放這裡讓 fieldlog／mcp
// 兩支 worker 的 /folders 查詢共用同一份順序定義，不用各自寫一次、之後
// FOLDER_CATEGORIES 順序調整時兩邊還要記得一起改。NULL／不在清單內的值
// 一律落在 ELSE（排最後，等同 misc），不會排到最前面造成視覺混亂。
export const FOLDER_CATEGORY_RANK_SQL =
  "CASE f.category " + FOLDER_CATEGORIES.map((c, i) => `WHEN '${c}' THEN ${i + 1}`).join(" ") + ` ELSE ${FOLDER_CATEGORIES.length} END`;

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
  await ensurePatrolCategory(db, timestamp);
  schemaReady = true;
}

/**
 * 一次性補上「巡廠」資料夾分類（2026-08-09，Jeremy 假日巡廠回報功能規格）。
 * seedCategories() 只在 categories 表完全空的時候跑一次，那時已經跑過了、
 * 不會再自動長出新分類，這裡用同一套「標記列」手法補一筆，不放進 cron
 * （applyFolderReorg20260808 那種），而是掛在 ensureSchema()——它本來就每次
 * 冷啟動都跑，這樣部署完立刻能用，不用等下一次排程。
 */
export async function ensurePatrolCategory(db, timestamp) {
  const applied = await db
    .prepare("SELECT id FROM categories WHERE kind = '_patrol_category_2026_08_09' LIMIT 1")
    .first()
    .catch(() => null);
  if (applied) return;
  await db.batch([
    db.prepare(
      "INSERT INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at) VALUES ('_patrol_category_2026_08_09', 0, 'applied', '', '', '[]', 0, ?)"
    ).bind(timestamp),
    db.prepare(
      "INSERT OR IGNORE INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at) VALUES ('folder_type', 0, '巡廠', '🚶', '假日巡廠出勤與生產紀錄', '[]', 999, ?)"
    ).bind(timestamp),
  ]);
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

/**
 * 一次性的資料夾分類重整（2026-08-08，依「MyWiki 隨身記系統改造規格」§B
 * 對照表套用）。標記機制跟上面兩支種子函式同一個做法：用 categories 表的
 * 標記列記住「套用過了」，之後使用者自己再調整名稱／category／歸檔位置，
 * 不會被這裡的舊值蓋回去。
 *
 * 刻意不掛在 ensureSchema()（每個請求／每個測試冷啟動都會跑一次）——
 * 改由 worker.js 的 scheduled()（daily cron）呼叫，跟 syncSources 那些
 * 每日任務同一批，一次性資料搬移只需要在部署後的下一次排程套用一次，
 * 不需要出現在所有測試的 ensureSchema 呼叫路徑上。
 *
 * 範圍刻意只包含兩類不需要知道「現在實際的 parent_id／深度」也能安全做
 * 的動作：
 *   1. 改名＋設定 category——純文字／metadata，不影響資料夾樹狀結構
 *   2. 規格 §B4 明確列出、id 對 id 的資料搬移／刪除（11 的 3 筆記事併入
 *      13 後刪掉 11；26 直接刪除；entry 262 從 folder 36 搬到 folder 35）
 *
 * 規格裡用「｜」表示的巢狀關係（例如「專案｜檢體針｜設備請購」暗示可能要
 * 搬到 folder 19 底下）刻意不在這裡做：那是搬動資料夾在樹狀結構裡的位置，
 * 需要先知道現在實際的 parent_id／深度才能安全判斷會不會超過
 * MAX_FOLDER_DEPTH，這支遷移拿不到那個資訊，硬搬有搬錯或超過層數上限的
 * 風險。要做那部分，改用已經有深度檢查與防循環邏輯的 update_folder／
 * move_folder（MCP 工具，或 App 裡的搬移功能）逐一確認著做。
 */
export async function applyFolderReorg20260808(db, timestamp) {
  const applied = await db
    .prepare("SELECT id FROM categories WHERE kind = '_folder_reorg_2026_08_08' LIMIT 1")
    .first()
    .catch(() => null);
  if (applied) return;

  const rename = (id, name, category) =>
    db.prepare("UPDATE folders SET name = ?, category = ? WHERE id = ?").bind(name, category, id);
  const setCategory = (id, category) =>
    db.prepare("UPDATE folders SET category = ? WHERE id = ?").bind(category, id);

  const statements = [
    db.prepare(
      "INSERT INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at) VALUES ('_folder_reorg_2026_08_08', 0, 'applied', '', '', '[]', 0, ?)"
    ).bind(timestamp),

    // ---- 專案開發（project）----
    rename(19, "專案｜檢體針", "project"),
    rename(38, "專案｜檢體針｜設備請購", "project"),
    rename(34, "專案｜檢體針｜拉拔試驗", "project"),
    rename(33, "專案｜檢體針｜設計輸入", "project"),
    rename(22, "專案｜檢體針｜原料資訊", "project"),
    setCategory(23, "project"), // 廠商｜北回化學：保留名稱，維持在 22 底下
    setCategory(24, "project"), // 廠商｜LOCTITE(上澄)：保留名稱，維持在 22 底下
    rename(25, "專案｜HD導管", "project"),
    rename(29, "專案｜HD導管｜再回流測試", "project"),
    rename(27, "專案｜編織管", "project"),
    rename(28, "專案｜編織管｜POM熱分析", "project"), // §B4 已確認歸專案
    rename(36, "專案｜Pigtail｜親水塗層", "project"),
    rename(40, "專案｜CVC／輸尿管", "project"),
    rename(10, "專案｜高壓注射筒", "project"), // §B4 已確認

    // ---- 品保與法規（qa_reg）----
    rename(7, "品保法規｜ISO標準", "qa_reg"),
    rename(8, "品保法規｜IFU", "qa_reg"),
    rename(30, "品保法規｜驗證測試｜流速壓力", "qa_reg"),
    rename(32, "品保法規｜驗證測試｜UV膠", "qa_reg"),
    rename(43, "品保法規｜稽核｜宜蘭二廠", "qa_reg"),

    // ---- 文獻與知識庫（literature）：命名已清楚，只設定 category ----
    setCategory(15, "literature"),
    setCategory(16, "literature"),
    setCategory(17, "literature"),
    setCategory(18, "literature"),

    // ---- 教育訓練（training）----
    rename(13, "教育訓練（根）", "training"),
    rename(35, "教育訓練｜FMEA", "training"),
    rename(31, "教育訓練｜AI", "training"),
    rename(12, "教育訓練｜資料庫入門", "training"),

    // ---- 行政與廠商（admin）----
    rename(37, "行政｜一般行政", "admin"),
    rename(41, "行政｜設備", "admin"), // §B4 已確認歸行政
    rename(3, "行政｜月會", "admin"),
    rename(42, "行政｜週報月報KPI", "admin"),

    // ---- 暫存／其他（misc）----
    rename(39, "暫存區（待歸類）", "misc"),
    rename(9, "暫存區｜高壓注射筒（待確認）", "misc"), // §B4 已確認：不確定歸屬先進暫存區

    // ---- §B4：明確的 id 對 id 資料搬移／刪除 ----
    // 11「其他專案｜課程」（3 筆）併入 13「教育訓練（根）」，記事搬完再刪 11。
    // 順手把可能存在的子資料夾上移一層，跟 App 刪除資料夾按鈕的安全邏輯一致
    // （規格沒提到 11 有子資料夾，這裡是防禦性處理，沒有的話這句只是無事發生）。
    db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?").bind(13, timestamp, 11),
    db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").bind(13, 11),
    db.prepare("DELETE FROM folders WHERE id = ?").bind(11),
    // 26「其他｜月報與周報」0 筆、跟 42 重複，直接刪除。
    db.prepare("UPDATE entries SET folder_id = NULL, updated_at = ? WHERE folder_id = ?").bind(timestamp, 26),
    db.prepare("UPDATE folders SET parent_id = NULL WHERE parent_id = ?").bind(26),
    db.prepare("DELETE FROM folders WHERE id = ?").bind(26),
    // entry 262（FMEA 課程筆記）誤歸在 folder 36（親水塗層），搬到 folder 35（FMEA）。
    db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?").bind(35, timestamp, 262),
  ];
  await db.batch(statements);
}
