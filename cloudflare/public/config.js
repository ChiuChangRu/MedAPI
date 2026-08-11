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
// 行程重點（依 2026-07-27 簽呈附件行程表；與 TRIP_DAYS 同一份來源，改這裡也要一起改）
const KEY_VISITS = [
  {
    match: "康德萊",
    when: "9/01（二）10:00 展位 N1-A401 會談",
    contact: "顧會平 18221635289",
    note: "展中會談（脈通）",
  },
  {
    match: "海醫達",
    when: "9/01（二）14:00 展位 N2-A709 會談",
    contact: "蔣總",
    note: "展中會談",
  },
  {
    match: "常美",
    when: "9/02（三）10:00 展位會談",
    contact: "顧克霞",
    note: "展中會談；簽呈寫展位 3F408，官方名冊為 N3-D408，出發前請再確認",
  },
  {
    match: "冠博",
    when: "9/02（三）14:00 展位 N1-D102 會談",
    contact: "韓總",
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
    contact: "汪柯妏 18301880817",
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
    name: "宗銘",
    duty: "導管開發主管",
    chips: [
      { k: "line", id: "tpu" },
      { k: "line", id: "cardio_vascular" },
      { k: "tech", id: "braid" },
      { k: "tech", id: "balloon" },
    ],
  },
  {
    name: "長儒",
    duty: "塗層",
    chips: [
      { k: "tech", id: "coating" },
      { k: "cats", label: "表面處理", ids: ["cat-14"] },
    ],
  },
  {
    name: "政哲",
    duty: "EO 滅菌・檢驗",
    chips: [
      { k: "dept", id: "eo" },
      { k: "dept", id: "qc" },
    ],
  },
  {
    name: "和凌",
    duty: "編織管・壓管",
    chips: [
      { k: "tech", id: "braid" },
      { k: "cats", label: "管件與擠壓", ids: ["cat-05", "cat-12"] },
    ],
  },
  {
    name: "昌毅",
    duty: "生產主管・化學背景",
    chips: [
      { k: "dept", id: "prod" },
      { k: "cats", label: "材料／黏著／化學", ids: ["cat-01", "cat-03", "cat-04"] },
    ],
  },
  {
    name: "帛辰",
    duty: "電子／電路工程・現場主管",
    chips: [
      { k: "cats", label: "電子模組（8.x 全系列）", ids: ["cat-08-1", "cat-08-2", "cat-08-3", "cat-08-4", "cat-08-5", "cat-08-6"] },
      { k: "dept", id: "prod" },
    ],
  },
  {
    name: "柏宏",
    duty: "工業工程／生產管理・現場主管・採購",
    chips: [
      { k: "dept", id: "prod" },
      { k: "dept", id: "equip" },
    ],
  },
  {
    name: "灝翰",
    duty: "模具射出技術・製圖設計",
    chips: [
      // 射出成型的本業：塑膠成型服務與設備廠商
      { k: "cats", label: "塑膠成型服務與裝置", ids: ["cat-09"] },
      // 射出件／Luer 接頭／精密零件（keywords 含「注塑」「模具」）
      { k: "line", id: "parts" },
      // 工程視角：模具治具、加工製程、設備整合與代加工
      { k: "dept", id: "eng" },
      // 製圖／設計服務（CAD、研發設計外包）
      { k: "cats", label: "研發設計／製圖服務", ids: ["cat-16"] },
    ],
  },
];

// 舊拼法 → 正名（曾經打錯或改過名字的登入紀錄，指派選單自動歸戶不重複顯示）
const NAME_ALIASES = { "振哲": "政哲" };

// 不顯示在任何人員選單的名字（測試帳號、非使用系統的支援人員）
const HIDDEN_MEMBERS = ["測試員", "龍欽", "沈龍欽"];

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

// 觀展目標標籤（勾在每家展商上，展後匯出可按目標分組）
const GOAL_OPTIONS = ["Cost Down", "第二供應商", "新材料", "新設備", "自動化", "AI"];

// 資質確認（現場詢問後勾選）
const QUAL_OPTIONS = [
  { id: "iso13485", label: "ISO 13485" },
  { id: "fda", label: "FDA" },
  { id: "ce_mdr", label: "CE/MDR" },
];

// 展後供應商分類（回台彙整用）
const POST_CLASS_OPTIONS = ["立即導入", "追蹤", "備用", "不採用"];
const POST_CLASS_COLORS = { "立即導入": "#15803d", "追蹤": "#1d4ed8", "備用": "#8a8a82", "不採用": "#b45309" };

// 策略地圖廠商檢索：對應公司未來五年技術開發主題（親水／抗結痂／抗菌披膜已合併），
// 每顆按鈕帶一組關鍵字，展商資料命中任一關鍵字即列出（OR 邏輯）。
// 關鍵字已對應展商資料用語（大陸展商寫「激光」不寫「雷射」）。覺得哪顆撈太雜，改這裡即可。
const TECH_MAP = [
  { id: "laser", label: "雷射加工", keywords: ["雷射", "激光", "打孔", "鑽孔", "印刷", "移印", "油墨", "標線", "laser"] },
  { id: "coating", label: "披膜三兄弟", keywords: ["親水", "塗層", "塗佈", "潤滑", "hydrophilic", "coating", "抗結痂", "結晶沉積", "生物膜", "抗菌", "抗微生物", "antimicrobial", "藥物塗層"] },
  { id: "coil", label: "薄壁繞簧管", keywords: ["繞簧", "彈簧管", "線圈", "coil", "薄壁", "鞘管", "sheath"] },
  { id: "braid", label: "編織管", keywords: ["編織", "braid", "增強導管"] },
  { id: "extrusion", label: "變徑異型押出", keywords: ["變徑", "異型", "錐形", "taper", "多腔", "押出模具", "擠出模具", "流道"] },
  { id: "balloon", label: "TPU 球囊導管", keywords: ["球囊", "balloon", "爆壓", "球囊成型", "tpu", "聚氨酯"] },
];

// 拜訪成果——取得了什麼（勾選式，展後可統計）
const OBTAINED_OPTIONS = ["名片", "型錄／DM", "樣品", "報價單", "技術資料", "同意後續寄樣"];

// 下一步（每次拜訪結束後選一個）
const NEXT_STEP_OPTIONS = ["無需跟進", "索取報價", "安排寄樣", "進一步開會", "轉介其他同事"];

// 紀錄類型
const NOTE_TYPES = ["現場紀錄", "想詢問的問題", "RFQ 需求", "索取資料備註", "後續追蹤"];

// 論壇議程（官網研討會場次）狀態與現場紀錄類型
const SESSION_STATUS_OPTIONS = ["未排定", "已排定", "已完成"];
const SESSION_STATUS_COLORS = { "未排定": "#8a8a82", "已排定": "#1d4ed8", "已完成": "#15803d" };
const SESSION_NOTE_TYPES = ["現場紀錄", "Go／Hold／Stop 判定", "後續追蹤"];

// 照片分類（上傳後點一下自己分類，方便展後整理）
const ATT_CATEGORIES = ["型錄", "產品", "展場", "設備", "名片", "證書", "合照"];

// ===== 行程設定：模式自動切換 =====
// 出發前＝連線版（綠燈），起飛後＝離線版（紅燈），回台後自動恢復連線版。
// 測試用：網址加 ?trip=before / ?trip=during / ?trip=after 可強制模擬各階段。
const TRIP = {
  depart: "2026-08-31T12:30:00+08:00",   // 8/31（一）CI201 松山 → 虹橋
  return: "2026-09-05T18:15:00+08:00",   // 9/05（六）CI202 虹橋 → 松山 抵達
};

// ===== 六天行程（依 2026-07-27 簽呈附件「看展上海 MEDTEC 暨考察行程表」）=====
// 「📅 行程總覽」頁籤與頁首的今日行程橫幅共用這份資料，離線也看得到。
//
// 個資原則：團隊成員一律去姓留名（跟 MEMBER_PROFILES 一致），接駁只到路名不含門牌。
// 外部窗口姓名與電話是公務聯絡資訊，照簽呈保留（跟 KEY_VISITS 既有做法一致）。
//
// item 欄位：time 時間｜title 主標｜sub 補充說明｜addr 地址｜contact 外部窗口
//            booth 攤位號｜ex 對應的展商 id（有值就能點進該展商詳情頁寫紀錄）
//            icon 行別圖示｜warn 出發前要再確認的疑點
const TRIP_DAYS = [
  {
    date: "2026-08-31", label: "8/31", weekday: "一",
    kind: "move", kindLabel: "移動日",
    headline: "宜蘭 → 松山 → 虹橋 → 上海市區",
    // 接駁只有 Day 1 有；總經理未列在包車名單內
    shuttle: [
      { time: "08:00", who: "灝翰", at: "宜蘭市金六結路" },
      { time: "08:05", who: "宗銘", at: "宜蘭市泰山路" },
      { time: "08:15", who: "柏宏", at: "宜蘭市宜興路" },
      { time: "08:30", who: "政哲", at: "員山鄉惠深二路" },
      { time: "08:50", who: "長儒", at: "冬山鄉柯林路" },
      { time: "09:05", who: "帛辰", at: "羅東鎮維揚路" },
      { time: "09:20", who: "昌毅", at: "五結鄉文昌路" },
    ],
    shuttleNote: "10:30 前抵達松山機場一航，中華航空櫃台報到",
    am: [
      { time: "12:30", title: "華航 CI201　松山 → 虹橋", sub: "14:15 抵達虹橋一號航站", icon: "✈️" },
    ],
    pm: [
      { time: "14:15", title: "虹橋機場 → 酒店", sub: "27km・約 1 小時", icon: "🚌" },
      { time: "", title: "宇樹科技 Unitree 具身智能體驗館", sub: "亞洲首店", addr: "靜安區南京西路 1618 號 久光百貨 2 樓", icon: "📍" },
    ],
    stay: "上海帝盛酒店（浦東新區花木路 800 號）",
    transit: "機場 → 酒店 27km・1 小時",
  },
  {
    date: "2026-09-01", label: "9/01", weekday: "二",
    kind: "expo", kindLabel: "看展日",
    headline: "MEDTEC 全天　上海新國際博覽中心",
    am: [
      { time: "09:00", title: "MEDTEC 開展", sub: "09:00–17:00　浦東新區", icon: "🎪" },
      { time: "10:00", title: "康德萊／脈通　展位會談", booth: "N1-A401", ex: "ex-0069", contact: "顧會平 18221635289", icon: "🤝" },
    ],
    pm: [
      { time: "14:00", title: "海醫達　展位會談", booth: "N2-A709", ex: "ex-0045", contact: "蔣總", icon: "🤝" },
    ],
    stay: "同上（上海帝盛酒店）",
    transit: "酒店 → 會場　步行 800m",
  },
  {
    date: "2026-09-02", label: "9/02", weekday: "三",
    kind: "expo", kindLabel: "看展日",
    headline: "MEDTEC 全天　上海新國際博覽中心",
    am: [
      { time: "09:00", title: "MEDTEC 開展", sub: "09:00–17:00　浦東新區", icon: "🎪" },
      // 簽呈寫展位 3F408，官方展商名冊上常美是 N3-D408；出發前需向對方確認
      { time: "10:00", title: "常美醫療器械　展位會談", booth: "N3-D408", ex: "ex-0712", contact: "顧克霞", icon: "🤝",
        warn: "簽呈寫 3F408，官方名冊為 N3-D408，出發前請再確認" },
    ],
    pm: [
      { time: "14:00", title: "冠博　展位會談", booth: "N1-D102", ex: "ex-0118", contact: "韓總", icon: "🤝" },
    ],
    stay: "同上（上海帝盛酒店）",
    transit: "酒店 → 會場　步行 800m",
  },
  {
    date: "2026-09-03", label: "9/03", weekday: "四",
    kind: "visit", kindLabel: "拜訪日",
    headline: "辰邦（浦東）→ 脈康（嘉定）",
    am: [
      { time: "", title: "辰邦醫療裝置（上海）", addr: "浦東新區康橋東路 1365 弄 28 號", contact: "董双波 13636499675",
        booth: "N3-D102", ex: "ex-0081", sub: "亦有參展", icon: "🏭" },
    ],
    pm: [
      { time: "", title: "上海脈康醫療器械用品", addr: "嘉定區高浪路 658 號", contact: "顧會平 18221635289", icon: "🏭" },
    ],
    stay: "同上（上海帝盛酒店）",
    transit: "酒店 → 辰邦 20KM・30 分　｜　辰邦 → 脈康 40KM・1 小時",
  },
  {
    date: "2026-09-04", label: "9/04", weekday: "五",
    kind: "visit", kindLabel: "拜訪日",
    headline: "南通　優邦 → 伊諾（單程 180KM）",
    am: [
      { time: "", title: "江蘇優邦精密製造", addr: "南通市崇川區高新路 259 號 26 號樓", contact: "董双波 13636499675", icon: "🏭" },
    ],
    pm: [
      { time: "", title: "南通伊諾精密塑膠導管", addr: "南通市崇川區觀音山街道新勝路 252 號", contact: "秦曉鵬 13962987900",
        booth: "N2-D702", ex: "ex-0353", sub: "亦有參展", icon: "🏭" },
    ],
    stay: "同上（上海帝盛酒店）",
    transit: "酒店 → 優邦 180KM・2.5–3 小時　｜　優邦 → 伊諾 15KM・30 分",
  },
  {
    date: "2026-09-05", label: "9/05", weekday: "六",
    kind: "move", kindLabel: "拜訪＋回程",
    headline: "銳淅（閔行）→ 虹橋 → 松山",
    am: [
      { time: "09:00", title: "銳淅醫學", addr: "閔行區聯航路 1588 號 科創樓 1 號", contact: "汪柯妏 18301880817",
        booth: "N3-C502", ex: "ex-0216", sub: "亦有參展", icon: "🏭" },
    ],
    pm: [
      { time: "16:15", title: "華航 CI202　虹橋 → 松山", sub: "18:15 抵達松山", icon: "✈️" },
    ],
    stay: "—　當日返台",
    transit: "酒店 → 銳淅 25KM・0.5–1 小時　｜　銳淅 → 虹橋一號航站 30KM・1 小時",
  },
];
