// ===== 團隊版設定檔 =====
// 這裡的對應（部門 → 分類、產品線 → 關鍵字）是初版草稿，
// 直接改這個檔案就能調整入口的篩選結果，不用動程式其他部分。

// 單位視角：每個單位對應官方分類組合＋引導說明
const DEPT_PRESETS = [
  {
    id: "qa",
    name: "品保",
    icon: "🛡️",
    cats: ["cat-16", "cat-17"],
    keywords: ["檢測", "測試", "認證", "驗證", "法規", "註冊", "體系", "諮詢", "審核"],
    hint: "品質體系、驗證認證、檢測服務與法規諮詢——QA 面向的服務型廠商。",
  },
  {
    id: "qc",
    name: "品管",
    icon: "🔍",
    cats: ["cat-17"],
    hint: "檢測、計量、檢驗與校準設備——進料/製程/成品檢驗要用的儀器設備。",
  },
  {
    id: "ra",
    name: "RA / 法規",
    icon: "📋",
    cats: ["cat-16"],
    hint: "法規顧問、註冊申報服務、臨床前測試諮詢。",
  },
  {
    id: "eo",
    name: "EO 滅菌",
    icon: "☣️",
    cats: ["cat-13"],
    keywords: ["滅菌", "環氧乙烷", "輻照", "消毒"],
    hint: "滅菌設備與服務、環氧乙烷/輻照、滅菌驗證、無菌包裝。",
  },
  {
    id: "doc",
    name: "文管",
    icon: "🗂️",
    cats: ["cat-16"],
    keywords: ["軟體", "系統", "資料", "追溯", "標籤"],
    hint: "文件/eQMS 軟體、標籤與追溯系統、資料管理服務。",
  },
  {
    id: "equip",
    name: "設備",
    icon: "⚙️",
    cats: ["cat-09", "cat-10", "cat-11", "cat-12", "cat-14"],
    hint: "成型設備、雷射加工/機床、自動化、擠出設備、表面處理。",
  },
  {
    id: "prod",
    name: "生產",
    icon: "🏭",
    cats: ["cat-09", "cat-11", "cat-13", "cat-14"],
    hint: "產線自動化、包裝滅菌、潔淨室、表面處理——提升量能與良率。",
  },
  {
    id: "eng",
    name: "工程",
    icon: "🔧",
    cats: ["cat-10", "cat-11", "cat-12", "cat-14", "cat-08-6"],
    hint: "加工製程、模具治具、設備整合與代加工模組。",
  },
  {
    id: "rd",
    name: "研發",
    icon: "🧪",
    cats: ["cat-01", "cat-02", "cat-03", "cat-04", "cat-05", "cat-07", "cat-08-1", "cat-08-2", "cat-08-3", "cat-08-4", "cat-08-5"],
    hint: "新材料、塗層、黏著劑、管材、感測器與電子模組——產品線延伸的技術來源。",
  },
  {
    id: "it",
    name: "資訊",
    icon: "💻",
    cats: ["cat-16", "cat-08-1"],
    keywords: ["軟體", "系統", "資訊", "數位", "資料", "演算法", "晶片", "追溯"],
    hint: "軟體服務、資訊系統、數位化與 AI、資料追溯——IT 面向的廠商。",
  },
  {
    id: "sales",
    name: "營業",
    icon: "🤝",
    cats: ["cat-15", "cat-06", "cat-07"],
    hint: "OEM/ODM 代工、IVD、給藥系統——潛在客戶、代工夥伴與市場拓展對象。",
  },
];

// 產品／科別視角：合併「自家產品線」與「醫院科別」成一個維度，
// 每項用關鍵字比對展商的名稱/簡介/產品（展商資料與關鍵字均已轉為繁體）。
// 為避免選項過多，重疊的品項已合併（例如透析＋腎臟科、血管通路＋
// 心血管介入），與邦特業務關聯低或家數極少的科別（居家照護、骨科、
// 牙科、眼科）已移除。
const PRODUCT_LINES = [
  {
    id: "tpu",
    name: "TPU 導管（核心技術）",
    desc: "既有技術重點：TPU 材料、導管押出",
    keywords: ["tpu", "聚氨酯", "擠出", "導管", "pebax", "醫用管"],
  },
  {
    id: "braided",
    name: "編織管（未來重點）",
    desc: "未來技術重點：編織增強導管",
    keywords: ["編織", "braid", "增強導管", "編織管"],
  },
  {
    id: "balloon",
    name: "球囊（未來重點）",
    desc: "未來技術重點：球囊導管、球囊成型",
    keywords: ["球囊", "balloon", "氣球導管", "球囊成型"],
  },
  {
    id: "hydrophilic",
    name: "親水塗層（未來重點）",
    desc: "親水/潤滑/功能性塗層材料、塗佈製程與設備",
    keywords: ["親水", "塗層", "coating"],
  },
  {
    id: "cardio_vascular",
    name: "心血管／血管通路",
    desc: "心血管介入、中心靜脈導管、導引器材",
    keywords: ["中心靜脈", "靜脈導管", "導引", "鞘管", "picc", "cvc", "血管介入", "導管擠出", "心血管", "心臟", "介入", "支架", "導絲"],
  },
  {
    id: "dialysis_renal",
    name: "透析／腎臟",
    desc: "血液回路管、血液透析導管組、內廔管翼狀針",
    keywords: ["透析", "血液迴路", "血液淨化", "內瘻", "穿刺針", "血路", "腎"],
  },
  {
    id: "respiratory",
    name: "呼吸治療",
    desc: "封閉式抽痰管組、氧氣/麻醉面罩、噴霧器、氣管內管",
    keywords: ["呼吸", "氧氣", "面罩", "氣管插管", "霧化", "麻醉", "吸痰", "氣管"],
  },
  {
    id: "urology",
    name: "泌尿科",
    desc: "輸尿管導管、Guidewire、推進管、取石網",
    keywords: ["泌尿", "輸尿管", "導絲", "取石", "碎石", "guidewire"],
  },
  {
    id: "gi",
    name: "消化內科",
    desc: "胃腸相關導管及配件",
    keywords: ["胃腸", "胃管", "腸內營養", "內窺鏡", "內鏡", "消化"],
  },
  {
    id: "drainage",
    name: "經皮引流",
    desc: "引流導管、引流套件",
    keywords: ["引流"],
  },
  {
    id: "infusion",
    name: "輸液治療",
    desc: "注射器、高壓注射器、輸液延長管、三通",
    keywords: ["輸液", "注射器", "三通", "魯爾", "luer", "延長管"],
  },
  {
    id: "mis",
    name: "微創／內視鏡",
    desc: "微創手術器械、內視鏡相關耗材",
    keywords: ["微創", "內視鏡", "內窺鏡", "腹腔鏡", "內鏡"],
  },
  {
    id: "neuro",
    name: "神經科",
    desc: "神經介入、顱內相關耗材",
    keywords: ["神經", "顱", "腦"],
  },
  {
    id: "parts",
    name: "醫療零件",
    desc: "Luer Connector、射出件、OEM 零件",
    keywords: ["連接器", "注塑", "接頭", "精密零件", "模具", "luer"],
  },
  {
    id: "lab_ivd",
    name: "檢驗科／IVD",
    desc: "體外診斷試劑、檢驗耗材",
    keywords: ["ivd", "診斷", "試劑", "檢驗"],
  },
];

// 行程重點廠商：出發前排定的展中會談與工廠拜訪對象
// match 以公司名稱關鍵字比對展商資料，命中的展商會標上「行程重點」
const KEY_VISITS = [
  {
    match: "海醫達",
    when: "9/01（二）14:00 展位 N2-A709 會談",
    contact: "蔣總",
    note: "展中會談",
  },
  {
    match: "辰邦",
    when: "9/03（四）上午 工廠拜訪",
    contact: "董双波 13636499675",
    note: "浦東新區康橋東路1365弄28號；亦參展（N3-D102）",
  },
  {
    match: "伊諾",
    when: "9/04（五）下午 工廠拜訪",
    contact: "秦曉鵬 13962987900",
    note: "南通市崇川區觀音山街道新勝路252號；亦參展（N2-D702）",
  },
  {
    match: "銳淅",
    when: "9/05（六）09:00 拜訪",
    contact: "",
    note: "上海市閔行區聯航路1588號科創樓1號；亦參展（N3-C502）",
  },
];

// 參展團隊成員與職掌：登入時一鍵選名字，登入後依職掌顯示推薦視角
// chips: k = dept（單位入口）| line（產品別）| spec（科別）| cats（直接指定分類組合）
const MEMBER_PROFILES = [
  {
    name: "總經理",
    duty: "",
    chips: [{ k: "dept", id: "sales" }],
  },
  {
    name: "呂宗銘",
    duty: "導管開發主管",
    chips: [
      { k: "line", id: "tpu" },
      { k: "line", id: "cardio_vascular" },
      { k: "line", id: "braided" },
      { k: "line", id: "balloon" },
    ],
  },
  {
    name: "邱長儒",
    duty: "塗層",
    chips: [
      { k: "line", id: "hydrophilic" },
      { k: "cats", label: "表面處理", ids: ["cat-14"] },
    ],
  },
  {
    name: "梁振哲",
    duty: "EO 滅菌・檢驗",
    chips: [
      { k: "dept", id: "eo" },
      { k: "dept", id: "qc" },
    ],
  },
  {
    name: "宋和凌",
    duty: "編織管・壓管",
    chips: [
      { k: "line", id: "braided" },
      { k: "cats", label: "管件與擠壓", ids: ["cat-05", "cat-12"] },
    ],
  },
  {
    name: "林昌毅",
    duty: "生產主管・化學背景",
    chips: [
      { k: "dept", id: "prod" },
      { k: "cats", label: "材料／黏著／化學", ids: ["cat-01", "cat-03", "cat-04"] },
    ],
  },
  {
    name: "陳帛辰",
    duty: "電子／電路工程・現場主管",
    chips: [
      { k: "cats", label: "電子模組（8.x 全系列）", ids: ["cat-08-1", "cat-08-2", "cat-08-3", "cat-08-4", "cat-08-5", "cat-08-6"] },
      { k: "dept", id: "prod" },
    ],
  },
  {
    name: "陳柏宏",
    duty: "工業工程／生產管理・現場主管・採購",
    chips: [
      { k: "dept", id: "prod" },
      { k: "dept", id: "equip" },
    ],
  },
];

// 依展商分類把「相關廠商」再分成三種關聯，方便判讀
const CAT_ROLES = {
  "cat-01": "supply", "cat-02": "supply", "cat-03": "supply", "cat-04": "supply",
  "cat-05": "supply", "cat-07": "supply",
  "cat-08-1": "tech", "cat-08-2": "tech", "cat-08-3": "tech",
  "cat-08-4": "tech", "cat-08-5": "tech", "cat-08-6": "tech",
  "cat-09": "process", "cat-10": "process", "cat-11": "process",
  "cat-12": "process", "cat-13": "process", "cat-14": "process",
  "cat-06": "market", "cat-15": "market",
  "cat-16": "service", "cat-17": "service",
};

const ROLE_LABELS = {
  supply: "上游材料與零件",
  process: "製程與設備",
  tech: "技術延伸（電子/感測/模組）",
  market: "市場與代工合作",
  service: "檢測與顧問服務",
};

// 拜訪狀態
const STATUS_OPTIONS = ["未排定", "已排定", "已拜訪", "需追蹤"];
const STATUS_COLORS = { "未排定": "#8a8a82", "已排定": "#1d4ed8", "已拜訪": "#15803d", "需追蹤": "#b45309" };

// 索取資料選項
const COLLECTED_OPTIONS = [
  { id: "catalog", label: "型錄" },
  { id: "card", label: "名片" },
  { id: "sample", label: "樣品" },
  { id: "quote", label: "報價" },
];
