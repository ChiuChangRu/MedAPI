// ===== 隨身記（fieldlog）=====
// 採集優先：先記再說，分類與移動留到之後處理。

const $ = (id) => document.getElementById(id);

// 這份 app.js 的版本。要跟 worker.js 的 UI_VERSION、index.html 的 ?v=、
// sw.js 的 CACHE 名稱一致（有測試在把關）。
// 為什麼需要：曾經發生「Cloudflare 部署確認是最新版，但瀏覽器跑的是快取住的舊
// app.js」，而畫面上完全看不出版本，只能靠反覆試誤。現在啟動時會跟伺服器對版，
// 不一致就直接在畫面上講，並給一顆按鈕清掉 service worker 與快取。
const APP_VERSION = "138";

// 資料夾採四層知識架構：1 產品／專案 → 2 文件類型 → 3 主題／試驗／標準系列 → 4 年份／版本。
const MAX_FOLDER_DEPTH = 4;
const LEVEL_HINTS = {
  1: "產品／專案",
  2: "文件類型",
  3: "主題／試驗／標準系列",
  4: "年份／版本／特定文件群",
};

// 分類字典——從 /api/categories 載入，使用者可以自己增刪改（見「管理分類」）。
// 下面那份寫死的清單只是 API 讀不到時的退路，不是真相來源；平常都以 API 為準。
let CATEGORIES = { folder_type: [], device: [] };

// API 讀不到分類時的退路（離線、或第一次啟動還沒建表），至少讓建資料夾不會壞掉
const FALLBACK_FOLDER_TYPES = [
  { level: 0, name: "參展", icon: "🏢", note: "展會與廠商", fields: ["廠商名", "攤位", "目標", "取得資料", "下一步"] },
  { level: 0, name: "拜訪", icon: "🤝", note: "客戶與供應商", fields: ["對象", "聯絡人", "討論事項", "結論", "待辦"] },
  { level: 0, name: "實驗", icon: "🧪", note: "條件與結果", fields: ["主題", "條件／參數", "觀察結果", "判定", "下次調整"] },
  { level: 0, name: "上課", icon: "🎓", note: "課程與筆記", fields: ["課程名", "講者", "重點", "待查資料"] },
  { level: 0, name: "會議", icon: "👥", note: "決議與待辦", fields: ["會議主題", "與會者", "討論事項", "決議", "待辦／負責人"] },
  { level: 0, name: "查廠", icon: "🔎", note: "查核與改善", fields: ["廠商／廠區", "查核範圍", "觀察結果", "缺失／風險", "改善追蹤"] },
  { level: 0, name: "標準", icon: "📐", note: "ISO／ASTM 等規範", fields: ["標準編號", "版本／年份", "適用範圍", "關鍵要求", "對應產品／實驗"] },
  { level: 0, name: "廠商", icon: "🏭", note: "供應商與產品", fields: ["攤位／位置", "國家", "產品", "聯絡窗口", "評估結果"] },
  { level: 0, name: "專利", icon: "💡", note: "專利與技術", fields: ["專利號", "申請／公告日", "專利權人", "技術重點", "與我方關聯"] },
  { level: 0, name: "其他", icon: "🗂️", note: "自由分類", fields: [] },
];

function folderTypes() {
  return CATEGORIES.folder_type.length ? CATEGORIES.folder_type : FALLBACK_FOLDER_TYPES;
}

/** 這個分類的記事欄位模板 */
function templateFor(type) {
  const found = folderTypes().find((item) => item.name === type);
  return found ? found.fields || [] : [];
}

/** 建第 N 層資料夾時可以選的分類：該層專屬 ＋ level 0 的通用分類 */
function choicesForLevel(level) {
  const wanted = Math.min(MAX_FOLDER_DEPTH, Math.max(1, Number(level || 1)));
  const list = folderTypes().filter((item) => item.level === wanted);
  const general = folderTypes().filter((item) => item.level === 0);
  return [...list, ...general];
}

/** 色系分類的卡片底色（未分類或 misc／透明不覆蓋，維持預設白底），純色碼，不含 style= 包裝——
 * 呼叫端如果自己還要加別的 inline style（例如樹狀縮排的 margin-left），要合併成同一個 style
 * 屬性，不能各自輸出一個 style="..."：同一個元素出現兩個 style 屬性時瀏覽器只認第一個，
 * 第二個會被靜默忽略（2026-08-09 樹狀清單上線時就是這樣把顏色弄不見的）。 */
function folderCategoryBg(f) {
  const meta = FOLDER_CATEGORY_META[f.category];
  if (!meta || f.category === "misc" || meta.bg === "transparent") return "";
  return meta.bg;
}

/** 給只需要單獨這一個 style 屬性的呼叫端用（沒有其他 inline style 要合併時） */
function folderCategoryStyle(f) {
  const bg = folderCategoryBg(f);
  return bg ? ` style="background:${bg}"` : "";
}

/** 色系分類徽章：未分類或 misc 不顯示，避免每個資料夾都掛一個「暫存／其他」而失去辨識度 */
function folderCategoryChipHtml(f) {
  const meta = FOLDER_CATEGORY_META[f.category];
  if (!meta || f.category === "misc") return "";
  return `<span class="folder-category">${esc(meta.label)}</span>`;
}

/** 分類排序用的位置（資料夾清單依分類分群時用） */
function typeOrderOf(type) {
  const index = folderTypes().findIndex((item) => item.name === type);
  return index < 0 ? 999 : index;
}

// 資料夾的色系分組（folders.category，2026-08-08 分類重整）。跟上面的
// folder_type／typeOrderOf（既有的「活動性質」欄位，例如「參展／實驗／
// 會議」）是完全不同的軸，這裡刻意不共用同一份清單——category 是固定的
// 六個色系，不像 type 可以在「管理分類」裡自由增刪。rank 決定排序順序，
// 是「預期會長多大」不是「現在筆數多少」，避免之後又要重排一次。
const FOLDER_CATEGORY_META = {
  project: { label: "專案開發", bg: "#FFE5E5", rank: 1 },
  qa_reg: { label: "品保與法規", bg: "#FFEDD5", rank: 2 },
  literature: { label: "文獻與知識庫", bg: "#DBEAFE", rank: 3 },
  training: { label: "教育訓練", bg: "#DCFCE7", rank: 4 },
  admin: { label: "行政與廠商", bg: "#FEF9C3", rank: 5 },
  misc: { label: "暫存／其他", bg: "transparent", rank: 6 },
};

/** 還沒設定 category 的資料夾（NULL）當 misc 處理，排在最後，不排最前面造成視覺混亂 */
function categoryRankOf(category) {
  return FOLDER_CATEGORY_META[category]?.rank ?? FOLDER_CATEGORY_META.misc.rank;
}

async function loadCategories() {
  try {
    const data = await api("/categories");
    const all = data.categories || [];
    CATEGORIES = {
      folder_type: all.filter((item) => item.kind === "folder_type"),
      device: all.filter((item) => item.kind === "device"),
    };
  } catch (err) {
    console.error("分類清單載入失敗，改用內建預設清單", err);
  }
}

let FOLDERS = [];
let CURRENT_FOLDER = null; // 開啟中的資料夾物件
let TRANSCRIBE_ENABLED = false;
let INNER_FOLDER_VIEW = localStorage.getItem("fieldlog_inner_folder_view") || (matchMedia("(max-width: 719px)").matches ? "list" : "grid");
// 待分類預設清單模式（本來就是待整理的內容，清單本來就夠緊湊），卡片模式
// 是給想要一眼看縮圖式排版的人選的，不像資料夾內頁的卡片那麼大張。
let INBOX_VIEW = localStorage.getItem("fieldlog_inbox_view") || "list";
// 資料夾內的檔案排序。預設「新到舊」：一直往資料夾裡加東西的人，最需要看到的
// 是剛剛丟進來的那一份，它不該被排在幾十個舊檔案後面。想按檔名找（同一系列的
// 標準編號連號排在一起）再切到 name。
let FILE_SORT = localStorage.getItem("fieldlog_file_sort") || "new";
// 桌機右欄是唯一的閱讀／編輯表面，不再允許用舊偏好把它關掉後退回置中 modal。
// 手機沒有三欄空間，才使用原本的單頁詳情流程。
let PREVIEW_ENABLED = true;

function usesDesktopRightPane() {
  return !!CURRENT_FOLDER && matchMedia("(min-width: 1000px)").matches;
}
let MERGE_SOURCE_ID = null;
let MERGE_ENTRY_SOURCE_ID = null;
let CREATE_FOLDER_RESOLVE = null;
// 開啟「單一檔案」詳情時記住是哪一份，這樣整理完重新開啟仍停在同一個檔案上
let FOCUSED_FILE = null;
// 待分類系統容器的 id，由 /api/staging 帶回來。純手動整理，不做自動分類。
let STAGING_FOLDER_ID = null;

// 資料夾排序模式：套用在每一層——首頁根層、每一層子資料夾、搬移選擇器、
// 採集畫面的資料夾 chip，全部共用同一個開關，不用每層各記各的。
// "name"＝原本的規則（進行中優先／依類型分組／再依名稱）；"time"＝新到舊。
let FOLDER_SORT = localStorage.getItem("fieldlog_folder_sort") || "name";

function compareFolders(a, b) {
  // 待分類系統容器永遠排第一：它裝的是「還沒分類、需要你回頭看一眼」的東西，
  // 排在一堆已經整理好的資料夾後面就失去意義了
  const staging = Number(b.role === "staging") - Number(a.role === "staging");
  if (staging) return staging;
  // 色系分組（category）優先於進行中／類型——同一色系的資料夾要能連在一起看，
  // 不然上色分組也沒有意義。未分類（NULL）當 misc 排最後。
  const byCategory = categoryRankOf(a.category) - categoryRankOf(b.category);
  if (byCategory) return byCategory;
  const active = Number(b.status === "進行中") - Number(a.status === "進行中");
  if (active) return active;
  // 手動排序（sort_order）：同一色系內數字小的排前面，沒設定的（null/undefined）排最後
  const bySortOrder = (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity);
  if (bySortOrder) return bySortOrder;
  const byType = typeOrderOf(a.type) - typeOrderOf(b.type);
  if (byType) return byType;
  return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", {
    numeric: true,
    sensitivity: "base",
  });
}

/** 新到舊：待分類系統容器一樣置頂，其餘依建立時間；同時間建立的用 id 當第二鍵。 */
function compareFoldersByTime(a, b) {
  const staging = Number(b.role === "staging") - Number(a.role === "staging");
  if (staging) return staging;
  return String(b.created_at || "").localeCompare(String(a.created_at || ""))
    || Number(b.id) - Number(a.id);
}

/** 目前排序模式對應的比較函式——資料夾清單無論在哪一層都呼叫這支，不要直接寫死 compareFolders */
function folderComparator() {
  return FOLDER_SORT === "time" ? compareFoldersByTime : compareFolders;
}

// ---------- API ----------
function pin() { return localStorage.getItem("fieldlog_pin") || ""; }

async function api(path, options = {}) {
  const res = await fetch("/api" + path, {
    ...options,
    headers: { "content-type": "application/json", "x-pin": pin(), ...(options.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error("PIN 錯誤"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 後端 now() 存的是 UTC（"YYYY-MM-DD HH:MM:SSZ"），畫面一律要轉台北時間再顯示，
// 不能直接切字串——半夜 0~8 點建立的記事切字串會顯示成前一天的日期。
function taipeiParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** "2026-08-10" */
function localDate(iso) {
  const p = taipeiParts(iso);
  return p ? `${p.year}-${p.month}-${p.day}` : "";
}

/** "08-13 22:19" —— 資料夾／記事清單常用的精簡格式 */
function localDateTimeShort(iso) {
  const p = taipeiParts(iso);
  return p ? `${p.month}-${p.day} ${p.hour}:${p.minute}` : "";
}

/** "2026-08-13 22:19:05" —— 記事詳情、履歷這類需要看完整時間的地方 */
function localDateTime(iso) {
  const p = taipeiParts(iso);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : "";
}

function isPdfAtt(a) {
  return (a.mime || "") === "application/pdf" || (a.filename || "").toLowerCase().endsWith(".pdf");
}

// docx／xlsx／pptx／純文字：後端直接從檔案結構解出文字，不經過 AI（見 imageSkill.js
// 的 detectNativeTextKind），前端只需要知道「這種檔案也可以按擷取文字」
function isNativeDocAtt(a) {
  return /\.(docx|xlsx|pptx|txt|md|csv|json|log)$/i.test(a.filename || "");
}

// 標準文件節錄版偵測（2026-07-27 長儒回報：ISO 10555-8 只到 p6、缺 Annex A/B）。
// 已知只提供節錄頁數的標準預覽站——這份清單會一直長，遇到新的直接加進來即可
const PREVIEW_SOURCE_DOMAINS = ["standards.iteh.ai", "sai-global.com", "webstore.ansi.org"];
function matchPreviewDomain(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  return PREVIEW_SOURCE_DOMAINS.find((d) => lower.includes(d)) || null;
}

// 從目錄文字 best-effort 推算「這份標準應該有幾頁」：目錄常見「Annex A ... 3」
// 這種章節名稱後面跟著頁碼（不論用點狀引導線還是純空白對齊），取抓到的最大
// 頁碼。抓不到就回 null——這只是提示用的粗略推算，不是精確剖析，不能保證每份
// 文件的目錄格式都吃得到，抓錯或抓不到都不該讓人以為「系統說沒問題」。
function deriveExpectedPages(text) {
  if (!text) return null;
  let max = null;
  for (const line of text.split(/\n+/)) {
    if (!/\b(Annex|Bibliography|Appendix)\b/i.test(line)) continue;
    const m = line.match(/(\d{1,4})\s*$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > 0 && n < 2000 && (max === null || n > max)) max = n;
  }
  return max;
}

// 長文（PDF 全文可達數萬字）在清單裡只顯示開頭
function clipText(s, n) {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字）` : s;
}

function showToast(text, { actionLabel, onAction } = {}) {
  const t = $("toast");
  t.innerHTML = `<span>${esc(text)}</span>`;
  t.classList.toggle("has-action", !!actionLabel);
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.onclick = () => { t.classList.remove("show"); onAction(); };
    t.appendChild(btn);
  }
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), actionLabel ? 6000 : 2600);
}

// 全螢幕編輯框：轉文字稿／擷取文字（PDF 全文可達數萬字）用瀏覽器原生 prompt()
// 編輯區太小根本編不動，改用這個大文字框＋明確的儲存/取消按鈕
const EDIT_MODAL_FONT_SIZES = [15, 17, 19, 21, 24, 28];
function editModalFontSize() {
  const saved = Number(localStorage.getItem("editModalFontSize") || 15);
  return EDIT_MODAL_FONT_SIZES.includes(saved) ? saved : 15;
}
function setEditModalFontSize(px) {
  localStorage.setItem("editModalFontSize", String(px));
  $("edit-modal-textarea").style.fontSize = `${px}px`;
}
function openEditModal({ title, value, onSave }) {
  $("edit-modal-title").textContent = title;
  const ta = $("edit-modal-textarea");
  ta.value = value || "";
  setEditModalFontSize(editModalFontSize());
  const countEl = $("edit-modal-count");
  const updateCount = () => { countEl.textContent = `${ta.value.length} 字`; };
  updateCount();
  ta.oninput = updateCount;
  const overlay = $("edit-overlay");
  overlay.classList.add("open");
  ta.focus();
  const close = () => { overlay.classList.remove("open"); ta.oninput = null; };
  $("edit-modal-close").onclick = close;
  $("edit-modal-cancel").onclick = close;
  $("edit-modal-font-smaller").onclick = () => {
    const i = EDIT_MODAL_FONT_SIZES.indexOf(editModalFontSize());
    if (i > 0) setEditModalFontSize(EDIT_MODAL_FONT_SIZES[i - 1]);
  };
  $("edit-modal-font-bigger").onclick = () => {
    const i = EDIT_MODAL_FONT_SIZES.indexOf(editModalFontSize());
    if (i < EDIT_MODAL_FONT_SIZES.length - 1) setEditModalFontSize(EDIT_MODAL_FONT_SIZES[i + 1]);
  };
  $("edit-modal-save").onclick = async () => {
    const saveBtn = $("edit-modal-save");
    saveBtn.disabled = true;
    try {
      await onSave(ta.value.trim());
      close();
    } catch (err) {
      showToast("儲存失敗：" + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  };
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** R2 key 可能含資料夾斜線；逐段編碼，避免把整條 key 編成一個路徑段。 */
function fileUrlForKey(key) {
  return `/api/file/${String(key || "").split("/").map(encodeURIComponent).join("/")}`;
}

function fmtBytes(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function recordingStatus(audioAttachments) {
  const audio = audioAttachments || [];
  if (!audio.length) return { tone: "failed", label: "找不到錄音附件" };
  if (audio.some((item) => item.transcribed_at === "processing")) return { tone: "working", label: "轉錄中" };
  if (audio.some((item) => item.transcribed_at === "auto_failed")) return { tone: "failed", label: "部分轉錄失敗" };
  if (audio.every((item) => item.transcribed_at === "skipped")) return { tone: "muted", label: "已設為不轉錄" };
  if (audio.every((item) => item.transcribed_at)) {
    return audio.some((item) => String(item.transcript || "").trim())
      ? { tone: "done", label: "轉錄完成" }
      : { tone: "done", label: "已轉錄，沒有可辨識語音" };
  }
  return { tone: "pending", label: "等待轉錄" };
}

function fmtUsageNumber(n) {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(Number(n || 0));
}

// 「查詢時間」（Worker 剛剛去問 Cloudflare 的時間點）跟「帳單資料本身是哪天的」
// 是兩件事，混在一起講就是使用者會誤會「剛更新＝數字是最新的」的根源。
// 這裡統一算好，個別項目的落後天數只在跟這個總覽數字不同時才需要額外提醒。
function overviewBanner(data) {
  const lag = Number(data.billingDataLagDays);
  const queryTime = new Date(data.updatedAt).toLocaleString("zh-TW");
  const dataLine = data.billingDataDate
    ? (lag >= 1
      ? `⚠ 帳單資料最新到 ${data.billingDataDate}（落後 ${lag} 天，Cloudflare 平台本身的限制，不是這裡沒去抓最新資料）`
      : `✓ 帳單資料最新到 ${data.billingDataDate}（沒有回報延遲）`)
    : "";
  return `<div class="usage-overview">
    <p class="sub">查詢時間：${esc(queryTime)}</p>
    ${dataLine ? `<p class="${lag >= 1 ? "usage-lag-warn" : "sub"}">${dataLine}</p>` : ""}
  </div>`;
}

function renderAiUsage(item, overallLagDays) {
  const used = Number(item.used || 0);
  const freeLimit = Number(item.limit || 10000);
  const safeLimit = Number(item.safeLimit || 7000);
  const paidCost = Number(item.monthlyPaidCost || 0);
  const softBudget = Number(item.softBudget || 4.5);
  const hardBudget = Number(item.hardBudget || 5);
  // 帳單資料本來就有回報延遲（幾乎每天都有）。後端判斷「今天要不要暫停自動
  // 轉錄」時，只認「日期正好是今天」的帳單數字，差一天都當成 0（見 worker.js
  // 的 cloudUsed = aiLimit?.label.includes(today) ? aiLimit.used : 0）。這裡
  // 的 used／limit 顯示的卻是「目前拿得到的最新一天」，只要有延遲就不是
  // 「今天」的數字——「已停止自動轉錄」這種斷言只能在資料確實是今天時講，
  // 不然只是拿舊數字嚇人，讓人誤以為今天已經被擋住了（2026-07-27 使用者
  // 回報：面板連續四天顯示「已停止」，但那其實是回報延遲那一天的舊數字）。
  const isLive = item.dataLagDays === 0; // 嚴格比較：null（沒有日期資訊）不算「今天」
  const bar = (label, value, limit, tone, note, digits = 0) => `<div class="ai-budget-row ${tone}">
    <div><b>${label}</b><span>${digits ? Number(value).toFixed(digits) : fmtUsageNumber(value)} / ${digits ? Number(limit).toFixed(digits) : fmtUsageNumber(limit)}</span></div>
    <div class="usage-bar"><i style="width:${Math.min(100, Number(value) / Number(limit) * 100)}%"></i></div>
    <small>${note}</small>
  </div>`;
  const staleNote = item.dataLagDays === null
    ? "尚無帳單資料可判斷——不代表今天已經被擋，系統只認「當天」的帳單資料才會暫停自動轉錄"
    : `這是 ${fmtUsageNumber(item.dataLagDays)} 天前的數字（帳單回報延遲），不代表今天已經被擋——系統只認「當天」的帳單資料才會暫停自動轉錄`;
  // 三條額度各自獨立判斷是否超過 10%，只顯示真的有量的那幾條——
  // 之前是「這個 AI 項目本身有沒有超過 10%」擋一次就三條全出，0% 的那條也會佔畫面
  // 安全門檻是「免費額度的幾成」用算的，不寫死百分比字面——上次
  // AI_AUTO_SAFE_NEURONS 從 7000 調到 10000（等於免費上限本身，因為這一層
  // 完全不花錢，拉滿也沒風險）之後，畫面若還寫死「70% 安全門檻」就會變成
  // 誤導：其實已經是 100%、用完免費額度才停，不再是留 30% 緩衝。
  const safePct = freeLimit ? Math.round(safeLimit / freeLimit * 100) : 100;
  const rows = [
    { pct: safeLimit ? used / safeLimit * 100 : 0, html: bar("① 自動安全額度", Math.min(used, safeLimit), safeLimit, "safe", isLive ? (used >= safeLimit ? "今日已停止自動轉錄" : safePct >= 100 ? "用完免費額度才停" : `${safePct}% 安全門檻`) : staleNote) },
    { pct: freeLimit ? used / freeLimit * 100 : 0, html: bar("② 免費額度", Math.min(used, freeLimit), freeLimit, "daily", isLive ? (used > freeLimit ? "今日已進入按量計費" : "每日 00:00 UTC 重置") : staleNote) },
    { pct: hardBudget ? paidCost / hardBudget * 100 : 0, html: bar("③ 本月付費 AI 預算（USD）", paidCost, hardBudget, "paid", paidCost >= softBudget ? `已達 USD ${softBudget.toFixed(2)}，Fieldlog AI 已軟停止` : `USD ${softBudget.toFixed(2)} 軟停止｜USD ${hardBudget.toFixed(2)} Gateway 硬停`, 4) },
  ];
  const visible = rows.filter((r) => r.pct >= 10);
  const gridHtml = visible.length ? visible.map((r) => r.html).join("") : `<p class="usage-quiet">✓ 三項額度目前都低於 10%。</p>`;
  // 面板頂端已經統一講過一次落後天數；這裡只在「這一項自己」跟那個總覽數字
  // 不一樣時才需要額外提醒（例如 AI 落後 3 天、但其他項目只落後 1 天）
  const lagNote = Number(item.dataLagDays) >= 1 && Number(item.dataLagDays) !== overallLagDays
    ? `<p class="ai-plan-note">⚠ 這一項的帳單資料另外落後 ${item.dataLagDays} 天，跟上方總覽的天數不同。</p>` : "";
  return `<div class="usage-limit ai-usage">
    <div><strong>${esc(item.label)}</strong><span>${fmtUsageNumber(used)} Neurons</span></div>
    <div class="ai-budget-grid">${gridHtml}</div>
    ${lagNote}
    <p class="ai-plan-note">${item.gatewayConfigured ? "✓ AI Gateway 已接入；請確認 Dashboard 的每月 USD 5 Spend Limit 已啟用。" : "⚠ 尚未設定 AI_GATEWAY_ID；USD 5 Gateway 硬停止尚未生效。"}</p>
  </div>`;
}

function renderUsageLimit(item, overallLagDays) {
  if (item.key === "ai") return renderAiUsage(item, overallLagDays);
  const percent = item.limit ? item.used / item.limit * 100 : 0;
  return `<div class="usage-limit ${percent > 100 ? "over" : ""}">
    <div><strong>${esc(item.label)}</strong><span>${fmtUsageNumber(item.used)} / ${fmtUsageNumber(item.limit)} ${esc(item.unit)}</span></div>
    <div class="usage-bar" role="progressbar" aria-valuenow="${Math.round(percent)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, percent)}%"></i></div>
    <small>${percent > 100 ? `已超出免費額度 ${fmtUsageNumber(percent - 100)}%` : `已使用 ${fmtUsageNumber(percent)}%`}</small>
  </div>`;
}

// 首頁只列「真的有用量」的項目：完全沒動到的額度列出來只是佔畫面。
// （AI 那三條額度各自的 10% 判斷在 renderAiUsage 裡，是另一層、不衝突。）
function hasActualUsage(item) {
  if (!item) return false;
  if (item.key === "ai") return Number(item.used || 0) > 0 || Number(item.monthlyPaidCost || 0) > 0;
  return Number(item.used || 0) > 0;
}

/** 收合區只顯示綠/黃/紅小圓點：取所有額度裡使用率最高的一個換算燈號 */
function usageStatusOf(data) {
  const percents = (data.limits || [])
    .filter((item) => item.key !== "ai" && item.limit)
    .map((item) => item.used / item.limit * 100);
  if (!percents.length) return "ok";
  const worst = Math.max(...percents);
  if (worst > 100) return "danger";
  if (worst >= 70) return "warn";
  return "ok";
}

function setUsageStatusDot(status) {
  const dot = $("usage-status-dot");
  if (!dot) return;
  if (!status) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.className = `usage-status-dot usage-status-${status}`;
}

async function loadUsage() {
  const wrap = $("usage-content");
  if (!wrap) return;
  wrap.innerHTML = `<p class="usage-quiet">正在讀取 Cloudflare 帳單用量…</p>`;
  try {
    const data = await api("/usage");
    const status = usageStatusOf(data);
    setUsageStatusDot(status);
    localStorage.setItem("fieldlog_usage_status", status);
    const activeLimits = (data.limits || []).filter(hasActualUsage);
    const totalCost = Number(data.totalCost || 0);
    const ai = (data.limits || []).find((item) => item.key === "ai");
    const gatewayWarning = ai && !ai.gatewayConfigured
      ? `<p class="usage-error">⚠ AI Gateway 尚未接入，USD 5 硬停止尚未生效。</p>` : "";

    if (!activeLimits.length && totalCost <= 0) {
      wrap.innerHTML = `${overviewBanner(data)}
        <p class="usage-quiet">目前沒有可顯示的用量。</p>${gatewayWarning}`;
      return;
    }
    const overallLagDays = Number(data.billingDataLagDays);
    const costHtml = totalCost > 0
      ? `<div class="usage-total"><span>本期費用</span><strong>${esc(data.currency || "USD")} ${fmtUsageNumber(totalCost)}</strong></div>`
      : "";
    const limitsHtml = activeLimits.length
      ? `<div class="usage-limits active-usage-list">${activeLimits.map((item) => renderUsageLimit(item, overallLagDays)).join("")}</div>`
      : "";
    wrap.innerHTML = `${overviewBanner(data)}${costHtml}${limitsHtml}${gatewayWarning}
      <p class="sub usage-updated">${data.source === "billable" ? "實際帳單資料" : "Pay-as-you-go 帳單資料"}</p>`;
  } catch (err) {
    // 取數失敗要讓使用者知道「查不到」，不能默默留白讓人誤以為用量是 0
    wrap.innerHTML = `<p class="usage-error">暫時無法讀取用量：${esc(err.message)}</p>`;
  }
}

/** 用量區塊：預設收合，第一次展開才打 /usage；收合時的燈號只讀上次快取，不額外發請求 */
function initUsageDetails() {
  const details = $("usage-details");
  if (!details) return;
  const OPEN_KEY = "fieldlog_usage_expanded";
  if (localStorage.getItem(OPEN_KEY) === "1") details.open = true;
  setUsageStatusDot(localStorage.getItem("fieldlog_usage_status"));
  let loaded = false;
  const maybeLoad = () => {
    if (details.open && !loaded) { loaded = true; loadUsage(); }
  };
  details.addEventListener("toggle", () => {
    localStorage.setItem(OPEN_KEY, details.open ? "1" : "0");
    maybeLoad();
  });
  maybeLoad();
}

// ---------- 登入 ----------
function showLogin() {
  hideBootProgress();
  $("login-overlay").classList.add("open");
}

async function doLogin() {
  const err = $("login-error");
  err.style.display = "none";
  try {
    const response = await fetch("/api/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: $("login-pin").value.trim() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    localStorage.removeItem("fieldlog_pin");
    $("login-pin").value = "";
    const folders = await api("/folders");
    $("login-overlay").classList.remove("open");
    boot(folders);
  } catch (e) {
    err.textContent = e.message;
    err.style.display = "block";
  }
}

async function migrateLegacyPinToSession() {
  const legacyPin = pin();
  if (!legacyPin) return;
  const response = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: legacyPin }),
  });
  if (response.ok) localStorage.removeItem("fieldlog_pin");
}

// ---------- 版本對版：避免「部署是新的、瀏覽器跑的是舊的」無聲卡住 ----------

// 把 service worker 與所有快取清乾淨，然後帶一個時間戳重新載入（順便打破 HTTP 快取）
async function forceReloadLatest(button) {
  if (button) { button.disabled = true; button.textContent = "清除中…"; }
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (err) {
    console.error("清除快取失敗", err);
  }
  location.replace(`${location.pathname}?fresh=${Date.now()}`);
}

function showVersion(serverVersion) {
  const stamp = $("app-version");
  if (stamp) stamp.textContent = `v${APP_VERSION}`;
  const banner = $("stale-version-banner");
  if (!banner) return;
  // 伺服器沒回版本（舊後端）就不判斷，避免誤報
  if (!serverVersion || String(serverVersion) === APP_VERSION) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <strong>⚠ 你現在看到的是舊版介面</strong>
    <p>這台瀏覽器載到的是 v${esc(APP_VERSION)}，伺服器上已經是 v${esc(String(serverVersion))}。
    這通常是瀏覽器或已安裝的 App 快取住舊檔案，按下面的按鈕清掉就會拿到最新版。</p>
    <button class="btn primary" id="stale-version-reload" type="button">🔄 清除快取並載入最新版</button>`;
  $("stale-version-reload").onclick = (event) => forceReloadLatest(event.currentTarget);
}

// ---------- 首頁搜尋（MyWiki 首頁改版規格 §1.1）----------
// 傳統關鍵字全文搜尋，刻意不是語意搜尋——Vectorize 目前命中率太差，不適合
// 當首頁主要入口（見規格文件）。多詞空白分隔＝AND，查無自動降級成 OR 並
// 標示，簡繁互通，套用既有同義詞表；比對邏輯在後端 /search（worker.js）。

function searchHitHtml(kind, item) {
  if (kind === "entry") {
    const where = item.folder_name
      ? `${esc(item.folder_type)}｜${esc(item.folder_name)}`
      : "⏳ 待分類";
    return `<button type="button" class="search-hit" data-kind="entry" data-id="${item.id}">
      <span class="search-hit-title">${esc(item.title || "（未命名）")}<span class="search-hit-where">${where}</span></span>
      <p class="search-hit-snippet">${esc(item.snippet)}</p>
    </button>`;
  }
  const off = item.offset_secs !== null && item.offset_secs !== undefined ? `｜錄音 ${fmtSecs(item.offset_secs)}` : "";
  const where = item.folder_name ? `${esc(item.folder_type)}｜${esc(item.folder_name)}` : "⏳ 待分類";
  return `<button type="button" class="search-hit" data-kind="attachment" data-id="${item.entry_id}">
    <span class="search-hit-title">📎 ${esc(item.filename)}<span class="search-hit-where">${where}${off}</span></span>
    <p class="search-hit-snippet">所屬記事：${esc(item.entry_title || "（未命名）")}｜${esc(item.snippet)}</p>
  </button>`;
}

function renderSearchResults(data) {
  const box = $("home-search-results");
  const notes = [];
  if (data.degraded) notes.push("⚠ 沒有同時符合全部關鍵字的結果，以下為部分符合。");
  if (data.truncated) notes.push("⚠ 資料量較大，較舊的資料可能未納入本次搜尋。");
  const groups = [];
  if (data.entries.length) {
    groups.push(`<div class="search-hit-group"><h3>紀錄（${data.entries.length}）</h3>${data.entries.map((e) => searchHitHtml("entry", e)).join("")}</div>`);
  }
  if (data.attachments.length) {
    groups.push(`<div class="search-hit-group"><h3>附件（${data.attachments.length}）</h3>${data.attachments.map((a) => searchHitHtml("attachment", a)).join("")}</div>`);
  }
  if (!groups.length) {
    box.innerHTML = `<p class="sub">找不到「${esc(data.query)}」的相關內容（簡繁已互通）。</p>`;
  } else {
    box.innerHTML = `${notes.map((n) => `<p class="home-search-note">${esc(n)}</p>`).join("")}${groups.join("")}`;
  }
  box.querySelectorAll(".search-hit").forEach((btn) => {
    btn.onclick = () => openEntry(Number(btn.dataset.id));
  });
}

const runHomeSearch = debounce(async (q) => {
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    // 使用者可能在請求飛行中又改了字或清空——只接受跟目前輸入框內容一致的結果，
    // 避免慢的那次請求晚到蓋掉快的那次（經典的 race condition）
    if ($("home-search-input").value.trim() !== q) return;
    renderSearchResults(data);
  } catch (err) {
    $("home-search-results").innerHTML = `<p class="usage-error">搜尋失敗：${esc(err.message)}</p>`;
  }
}, 300);

function initHomeSearch() {
  const input = $("home-search-input");
  const clearBtn = $("home-search-clear");
  const resultsBox = $("home-search-results");
  // 首頁第一列（輸入與草稿）跟第三～五列分成兩個容器，中間夾著檢索本身——
  // 搜尋啟動時兩個都要藏起來，讓出空間給搜尋結果。
  const mainSections = [$("home-main-top"), $("home-main-sections")].filter(Boolean);
  if (!input) return;
  const setActive = (active) => {
    resultsBox.hidden = !active;
    mainSections.forEach((el) => { el.hidden = active; });
    clearBtn.hidden = !input.value;
  };
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearBtn.hidden = !input.value;
    if (!q) { setActive(false); return; }
    setActive(true);
    resultsBox.innerHTML = `<p class="sub">搜尋中…</p>`;
    runHomeSearch(q);
  });
  input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { input.value = ""; setActive(false); } });
  clearBtn.onclick = () => { input.value = ""; setActive(false); input.focus(); };
}

// ---------- 首頁 ----------
// 開啟 App 到畫面填滿內容之間，要打好幾支 API（設定／分類／資料夾／待分類），
// 資料夾、記事、附件越多這幾支就越慢；空白畫面撐久了容易被誤會當機，用
// 百分比讓使用者知道還在跑。
let BOOT_SLOW_TIMER = null;
let BOOT_RETRY_TIMER = null;

function clearBootTimers() {
  clearTimeout(BOOT_SLOW_TIMER);
  clearTimeout(BOOT_RETRY_TIMER);
  BOOT_SLOW_TIMER = null;
  BOOT_RETRY_TIMER = null;
}

function showBootProgress(message = "檢查登入狀態…") {
  clearBootTimers();
  $("boot-loading-overlay")?.classList.add("open");
  $("boot-loading-overlay")?.setAttribute("aria-busy", "true");
  const retry = $("boot-loading-retry");
  const hint = $("boot-loading-hint");
  if (retry) retry.hidden = true;
  if (hint) hint.textContent = "第一次通過安全驗證時可能需要稍等。";
  setBootProgress(5, message);
  BOOT_SLOW_TIMER = setTimeout(() => {
    if (hint) hint.textContent = "資料量較多，系統仍在讀取，請不要關閉頁面。";
  }, 12000);
  BOOT_RETRY_TIMER = setTimeout(() => {
    if (hint) hint.textContent = "載入時間異常偏長，可重新載入後再試。";
    if (retry) retry.hidden = false;
  }, 30000);
}
function setBootProgress(pct, message = "") {
  const fill = $("boot-loading-bar-fill");
  const label = $("boot-loading-pct");
  const stage = $("boot-loading-stage");
  const bar = fill?.parentElement;
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${pct}%`;
  if (stage && message) stage.textContent = message;
  bar?.setAttribute("aria-valuenow", String(pct));
}
function hideBootProgress() {
  clearBootTimers();
  $("boot-loading-overlay")?.setAttribute("aria-busy", "false");
  $("boot-loading-overlay")?.classList.remove("open");
}

// ---------- 分頁／右側內容載入視窗 ----------
// 首頁啟動已有百分比進度；這一組專門處理之後每次切換資料夾、待分類、垃圾桶、
// 紀錄／檔案與分類管理。載入層會蓋住舊內容，避免把空白或上一頁誤認成新結果。
// 計數器讓巢狀載入（例如重新整理資料夾後再開檔案）不會被較早完成的請求提早關掉。
let VIEW_LOADING_COUNT = 0;
const VIEW_LOADING_MIN_MS = 180;

function beginViewLoading(label = "正在載入…") {
  VIEW_LOADING_COUNT += 1;
  const overlay = $("view-loading-overlay");
  const title = $("view-loading-title");
  if (title) title.textContent = label;
  overlay?.classList.add("open");
  document.body.setAttribute("aria-busy", "true");
  return performance.now();
}

async function endViewLoading(startedAt) {
  const remaining = VIEW_LOADING_MIN_MS - (performance.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  VIEW_LOADING_COUNT = Math.max(0, VIEW_LOADING_COUNT - 1);
  if (VIEW_LOADING_COUNT > 0) return;
  $("view-loading-overlay")?.classList.remove("open");
  document.body.removeAttribute("aria-busy");
}

async function withViewLoading(label, task) {
  const startedAt = beginViewLoading(label);
  try {
    return await task();
  } finally {
    await endViewLoading(startedAt);
  }
}

async function boot(preloadedFolders = null) {
  showBootProgress("讀取系統設定…");
  try {
    const cfg = await api("/config");
    TRANSCRIBE_ENABLED = cfg.transcribe;
    localStorage.setItem("fieldlog_config", JSON.stringify(cfg));
    showVersion(cfg.ui_version);
  } catch {
    // /config 偶發失敗（手機網路不穩）時退回上次成功的值，
    // 避免整理/轉文字按鈕憑空消失；就算誤開，後端也會擋
    TRANSCRIBE_ENABLED = !!JSON.parse(localStorage.getItem("fieldlog_config") || "{}").transcribe;
    showVersion(null);
  }
  setBootProgress(25, "載入分類設定…");
  initHomeSearch();
  // 分類清單要先載入：建資料夾的對話框、資料夾排序、記事欄位模板都靠它
  await loadCategories();
  setBootProgress(50, "建立資料夾與記事清單…");
  await Promise.all([loadFolders(preloadedFolders), loadRecent()]);
  setBootProgress(90, "整理畫面與待同步資料…");
  initUsageDetails();
  syncPendingFiles();
  setBootProgress(100, "載入完成");
  setTimeout(hideBootProgress, 180);
}

async function loadFolders(preloadedFolders = null) {
  FOLDERS = preloadedFolders || await api("/folders");
  renderFolders();
}

// 2026-08-09：卡片模式拿掉了——跟清單模式顯示的是同一批資料夾（只有根層），
// 只是排版不同，沒有提供額外功能。改成縮排樹狀清單，重用「移動到資料夾」
// 選擇器已經在用的 folderTreeOrdered()（排序／縮排邏輯只寫一份）。
//
// 預設只顯示根層（跟拿掉卡片模式之前的畫面一樣），有子資料夾的項目前面有
// 展開／收合箭頭，按下去才往下展開一層——不是一次全部攤開整棵樹，跟
// Notion 側欄的頁面樹是同一種互動。EXPANDED_FOLDER_IDS 只存在記憶體裡、
// 重新整理就重置，符合「預設跟上一版一樣」的要求。
let EXPANDED_FOLDER_IDS = new Set();

/** 只留下「目前看得到」的列：根層一定看得到，其餘要一路往上追到全部祖先都展開才算 */
function visibleFolderRows() {
  const byId = new Map(FOLDERS.map((f) => [Number(f.id), f]));
  const childCountOf = new Map();
  for (const f of FOLDERS) {
    if (!f.parent_id) continue;
    const key = Number(f.parent_id);
    childCountOf.set(key, (childCountOf.get(key) || 0) + 1);
  }
  const isVisible = (folder) => {
    let current = folder;
    while (current.parent_id) {
      const parent = byId.get(Number(current.parent_id));
      // parent_id 指向已經不存在的資料夾（孤兒）：folderTreeOrdered() 把這種
      // 情況當成根層處理，這裡要跟它一致，不然孤兒資料夾會憑空消失
      if (!parent) return true;
      if (!EXPANDED_FOLDER_IDS.has(Number(current.parent_id))) return false;
      current = parent;
    }
    return true;
  };
  return folderTreeOrdered()
    .filter(({ folder }) => isVisible(folder))
    .map(({ folder, depth }) => ({ folder, depth, childCount: childCountOf.get(Number(folder.id)) || 0 }));
}

function renderFolders() {
  const wrap = $("folder-list");
  const rows = visibleFolderRows();
  wrap.className = "folder-list";
  syncFolderSortButtons();
  if (!rows.length) {
    wrap.innerHTML = `<p class="sub">還沒有資料夾。新資料會先進待分類；建立資料夾後再移動進去。</p>`;
    renderDesktopFolderTree();
    return;
  }
  wrap.innerHTML = rows.map(({ folder: f, depth, childCount }) => {
    const expanded = EXPANDED_FOLDER_IDS.has(Number(f.id));
    const bg = folderCategoryBg(f);
    // 色系底已經表達了分類，卡片裡再重複一個「專案開發」之類的白底文字
    // 標籤是多餘的（folderCategoryChipHtml，2026-08-08 分類重整時加的）；
    // 首頁這份清單拿掉，child-folder-card（資料夾內頁的子資料夾卡片）沒有
    // 底色可以借，那邊繼續保留文字標籤。
    const style = `margin-left:${depth * 28}px${bg ? `;background:${bg}` : ""}`;
    const expandBtn = childCount
      ? `<button class="folder-expand" type="button" data-id="${f.id}" aria-expanded="${expanded}" aria-label="${expanded ? "收合" : "展開"}「${esc(f.name)}」的子資料夾">${expanded ? "▾" : "▸"}</button>`
      : `<span class="folder-expand-spacer" aria-hidden="true"></span>`;
    return `
    <div class="folder-card ${f.status !== "進行中" ? "done" : ""}" data-id="${f.id}" style="${style}">
      <button class="folder-drag" type="button" draggable="true" title="拖曳移動或放入垃圾桶" aria-label="拖曳${esc(f.name)}">⠿</button>
      ${expandBtn}
      <div class="folder-card-main">
        <span class="folder-type-group">${f.parent_id ? "📁" : "📂"} <span class="folder-type">${esc(f.type)}</span></span>
        <span class="folder-name">${esc(f.name)}</span>
        <span class="folder-count">${f.entry_count} 筆記事${childCount ? `｜${childCount} 個子資料夾` : ""}</span>
        <span class="folder-date">建立於 ${esc(localDate(f.created_at))}</span>
      </div>
      <button class="folder-more" type="button" aria-label="${esc(f.name)}操作選單">⋯</button>
      <div class="folder-menu" hidden>
        <button type="button" data-act="add-child">新增子資料夾</button>
        <button type="button" data-act="rename">編輯（名稱／類型）</button>
        <button type="button" data-act="move">移動到其他資料夾</button>
        <button type="button" data-act="merge">合併至其他資料夾</button>
        <button type="button" data-act="delete" class="danger">刪除資料夾</button>
      </div>
    </div>`;
  }).join("");
  renderDesktopFolderTree();
  wrap.querySelectorAll(".folder-expand").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.id);
      if (EXPANDED_FOLDER_IDS.has(id)) EXPANDED_FOLDER_IDS.delete(id); else EXPANDED_FOLDER_IDS.add(id);
      renderFolders();
    };
  });
  wrap.querySelectorAll(".folder-card").forEach((el) => {
    el.querySelector(".folder-card-main").onclick = () => openFolder(Number(el.dataset.id));
    el.querySelector(".folder-more").onclick = (ev) => {
      ev.stopPropagation();
      wrap.querySelectorAll(".folder-menu").forEach((m) => { if (m !== el.querySelector(".folder-menu")) m.hidden = true; });
      el.querySelector(".folder-menu").hidden = !el.querySelector(".folder-menu").hidden;
    };
    el.querySelector('[data-act="add-child"]').onclick = async () => {
      const id = Number(el.dataset.id);
      const createdId = await createSubfolderUnder(id);
      // createSubfolderUnder() 內部已經 loadFolders() 重繪過一次，但那時
      // EXPANDED_FOLDER_IDS 還沒加進這個 id，剛建好的子資料夾會被收合藏起來、
      // 看起來像沒建成功——這裡補加狀態後要再重繪一次才看得到
      if (createdId) { EXPANDED_FOLDER_IDS.add(id); renderFolders(); }
    };
    el.querySelector('[data-act="rename"]').onclick = () => renameFolder(Number(el.dataset.id));
    el.querySelector('[data-act="move"]').onclick = () => moveFolder(Number(el.dataset.id));
    el.querySelector('[data-act="merge"]').onclick = () => openMergeFolderDialog(Number(el.dataset.id));
    el.querySelector('[data-act="delete"]').onclick = () => deleteFolder(Number(el.dataset.id));
    const drag = el.querySelector(".folder-drag");
    drag.ondragstart = (ev) => {
      const sourceId = Number(el.dataset.id);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("application/x-fieldlog-folder", String(sourceId));
      el.classList.add("dragging");
      document.body.classList.add("folder-dragging");
    };
    drag.ondragend = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("folder-dragging");
      wrap.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
    };
    el.ondragover = (ev) => { ev.preventDefault(); el.classList.add("drop-target"); ev.dataTransfer.dropEffect = "move"; };
    el.ondragleave = () => el.classList.remove("drop-target");
    el.ondrop = (ev) => {
      ev.preventDefault();
      el.classList.remove("drop-target");
      const targetId = Number(el.dataset.id);
      const entryId = Number(ev.dataTransfer.getData("application/x-fieldlog-entry"));
      if (entryId) {
        const prevFolder = ev.dataTransfer.getData("application/x-fieldlog-entry-folder");
        moveInboxEntry(entryId, targetId, prevFolder ? Number(prevFolder) : null);
        return;
      }
      const sourceId = Number(ev.dataTransfer.getData("application/x-fieldlog-folder"));
      if (sourceId && sourceId !== targetId) moveFolderDirect(sourceId, targetId);
    };
  });
}

async function moveFolderDirect(sourceId, targetId) {
  try {
    await api(`/folders/${sourceId}`, { method: "PUT", body: JSON.stringify({ parent_id: targetId }) });
    showToast("資料夾已移動");
    await loadFolders();
  } catch (error) { showToast("移動失敗：" + error.message); }
}

function renderDesktopFolderTree() {
  const wrap = $("desktop-folder-tree");
  if (!wrap) return;
  const rows = visibleFolderRows();
  wrap.innerHTML = rows.map(({ folder, depth, childCount }) => {
    const expanded = EXPANDED_FOLDER_IDS.has(Number(folder.id));
    return `<div class="desktop-tree-row ${CURRENT_FOLDER?.id === folder.id ? "active" : ""}" data-id="${folder.id}" style="padding-left:${8 + depth * 17}px">
      ${childCount ? `<button class="desktop-tree-toggle" type="button">${expanded ? "▾" : "▸"}</button>` : `<span class="desktop-tree-toggle-spacer"></span>`}
      <span>${folder.parent_id ? "📁" : "📂"} ${esc(folder.name)}</span>
    </div>`;
  }).join("") || `<p class="sub" style="padding:8px;">尚無資料夾</p>`;
  wrap.querySelectorAll(".desktop-tree-row").forEach((row) => {
    row.onclick = () => openFolder(Number(row.dataset.id));
    row.querySelector(".desktop-tree-toggle")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = Number(row.dataset.id);
      if (EXPANDED_FOLDER_IDS.has(id)) EXPANDED_FOLDER_IDS.delete(id); else EXPANDED_FOLDER_IDS.add(id);
      renderFolders();
    });
    row.ondragover = (event) => {
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("application/x-fieldlog-folder") && !types.includes("application/x-fieldlog-attachment")) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "move"; row.classList.add("drop-target");
    };
    row.ondragleave = () => row.classList.remove("drop-target");
    row.ondrop = (event) => {
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("application/x-fieldlog-folder") && !types.includes("application/x-fieldlog-attachment")) return;
      event.preventDefault(); event.stopPropagation(); row.classList.remove("drop-target");
      const targetId = Number(row.dataset.id);
      const entryId = Number(event.dataTransfer.getData("application/x-fieldlog-entry"));
      const folderId = Number(event.dataTransfer.getData("application/x-fieldlog-folder"));
      if (types.includes("application/x-fieldlog-attachment")) {
        let payload;
        try { payload = JSON.parse(event.dataTransfer.getData("application/x-fieldlog-attachment")); }
        catch { showToast("無法讀取拖曳的檔案"); return; }
        if (payload?.attachmentId) moveAttachmentToFolder(payload, targetId);
      } else if (entryId) moveInboxEntry(entryId, targetId, Number(event.dataTransfer.getData("application/x-fieldlog-entry-folder")) || null);
      else if (folderId && folderId !== targetId) moveFolderDirect(folderId, targetId);
    };
  });
}

async function moveAttachmentToFolder(payload, targetId) {
  const sourceId = Number(payload.sourceFolderId || 0);
  if (!targetId || targetId === sourceId) { showToast("檔案已經在這個資料夾"); return; }
  const target = FOLDERS.find((folder) => Number(folder.id) === Number(targetId));
  try {
    const result = await api(`/attachments/${payload.attachmentId}/move`, {
      method: "POST", body: JSON.stringify({ folder_id: targetId }),
    });
    if (!result.moved) { showToast("檔案已經在這個資料夾"); return; }
    showToast(`已移到「${target?.name || "資料夾"}」`, sourceId ? {
      actionLabel: "復原",
      onAction: async () => {
        try {
          await api(`/attachments/${payload.attachmentId}/move`, {
            method: "POST", body: JSON.stringify({ folder_id: sourceId }),
          });
          showToast("已復原移動");
          await refreshFolderView();
        } catch (error) { showToast("復原失敗：" + error.message); }
      },
    } : {});
    await refreshFolderView();
  } catch (error) { showToast("移動失敗：" + error.message); }
}

// 側欄寬度：可拖曳調整，記住使用者選的寬度（手機不套用雙欄檔案總管，
// 這裡的寬度只影響桌機）。CSS 變數 --sidebar-width 同時驅動側欄本身的
// width 與 .container 的 margin-left，拖曳時只要改這一個變數就好，
// 不用分別去動兩個元素的 inline style。
const SIDEBAR_WIDTH_KEY = "fieldlog_sidebar_width";
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 480;

function initDesktopSidebarResize() {
  const handle = $("desktop-explorer-resize");
  if (!handle) return;

  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (saved) {
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, saved));
    document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
  }

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("sidebar-resizing");

    const onMove = (moveEvent) => {
      const width = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, moveEvent.clientX));
      document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
      const previewWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--preview-width"), 10);
      if (previewWidth) setPreviewWidth(previewWidth);
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("sidebar-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const current = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim();
      if (current) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(parseInt(current, 10)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });

  // 鍵盤可及性：側欄邊界本身是 role="separator"，方向鍵微調寬度
  handle.addEventListener("keydown", (event) => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10) || 276;
    let next = null;
    if (event.key === "ArrowLeft") next = current - 16;
    else if (event.key === "ArrowRight") next = current + 16;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, next));
    document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  });
}

// 編輯資料夾：名稱＋類型一起改。類型也能改是因為建立時選錯很常見
// （或舊資料/匯入資料類型跟預期不同），之前只能刪掉重建才能修正。
async function renameFolder(id) {
  const folder = FOLDERS.find((f) => f.id === id);
  if (!folder) return;
  const details = await askFolderDetails({ title: "編輯資料夾", desc: "調整名稱或類型（分類選錯了也能在這裡修正）", name: folder.name, type: folder.type });
  if (!details) return;
  if (details.name === folder.name && details.type === folder.type) return;
  await api(`/folders/${id}`, { method: "PUT", body: JSON.stringify({ name: details.name, type: details.type }) });
  showToast("資料夾已更新");
  loadFolders();
}

/**
 * 搬動整個資料夾（連同底下的子資料夾與記事）。
 * 四層架構一旦建錯，沒有這個就只能刪掉重建，裡面的東西跟著陪葬；
 * 層數會超過上限、或想搬進自己的子資料夾時，後端會擋下並說清楚原因。
 */
async function moveFolder(id) {
  const folder = FOLDERS.find((f) => f.id === id);
  if (!folder) return;
  const picked = await openFolderPicker({
    title: `移動資料夾「${folder.name}」`,
    desc: "選一個新的上層資料夾；選「最上層」就是搬成第 1 層。底下的子資料夾與記事會一起搬。",
    currentId: folder.parent_id || null,
    allowInbox: false,
    rootLabel: "⬆️ 移到最上層（第 1 層）",
    excludeSubtreeOf: id,
  });
  if (!picked) return;
  if (Number(picked.id) === id) { showToast("不能搬到自己底下"); return; }
  try {
    await api(`/folders/${id}`, { method: "PUT", body: JSON.stringify({ parent_id: picked.id }) });
    showToast(picked.id ? "資料夾已移動" : "已移到最上層");
    await loadFolders();
    if (CURRENT_FOLDER && CURRENT_FOLDER.id === id) openFolder(id);
  } catch (err) {
    showToast("移動失敗：" + err.message);
  }
}

async function deleteFolder(id) {
  const folder = FOLDERS.find((f) => f.id === id);
  if (!folder) return;
  const detail = `${folder.entry_count ? `直接包含 ${folder.entry_count} 筆紀錄。` : ""}${folder.child_count ? ` 另有 ${folder.child_count} 個子資料夾及其全部內容。` : ""}`;
  if (!confirm(`將資料夾「${folder.name}」整棵移到垃圾桶？\n\n${detail}\n垃圾桶保留 60 天，可在期間內還原。`)) return;
  const result = await api(`/folders/${id}`, { method: "DELETE" });
  showToast(`已移到垃圾桶：${result.folder_count || 1} 個資料夾、${result.entry_count || 0} 筆紀錄`);
  await Promise.all([loadFolders(), loadRecent()]);
}

function openMergeFolderDialog(sourceId) {
  const source = FOLDERS.find((f) => f.id === sourceId);
  // 自己的子孫不能當合併目標（後端也會擋）：那等於把父資料夾併進自己底下
  const descendants = new Set();
  const walk = (id) => {
    descendants.add(Number(id));
    for (const f of FOLDERS) if (Number(f.parent_id) === Number(id) && !descendants.has(Number(f.id))) walk(f.id);
  };
  walk(sourceId);
  const targets = FOLDERS.filter((f) => !descendants.has(Number(f.id)));
  if (!source || !targets.length) { showToast("沒有其他資料夾可以合併"); return; }
  MERGE_SOURCE_ID = sourceId;
  $("merge-folder-desc").textContent = `將「${source.name}」的記事移入另一個資料夾；原資料夾會在合併後刪除。`;
  $("merge-folder-target").innerHTML = targets.map((f) => `<option value="${f.id}">${esc(f.type)}｜${esc(f.name)}（${f.entry_count} 筆）</option>`).join("");
  $("merge-folder-overlay").classList.add("open");
}

function closeMergeFolderDialog() {
  MERGE_SOURCE_ID = null;
  $("merge-folder-overlay").classList.remove("open");
}

async function mergeFolder(sourceId, targetId) {
  const source = FOLDERS.find((f) => f.id === sourceId);
  const target = FOLDERS.find((f) => f.id === targetId);
  if (!source || !target) return;
  const childBit = source.child_count ? `，${source.child_count} 個子資料夾也會一起移進去` : "";
  if (!confirm(`確定將「${source.name}」合併到「${target.name}」？\n\n${source.entry_count} 筆記事與附件${childBit}會移入目標資料夾，來源資料夾才會刪除。`)) return;
  let result;
  try {
    result = await api(`/folders/${sourceId}/merge`, { method: "POST", body: JSON.stringify({ target_id: targetId }) });
  } catch (err) {
    showToast("合併失敗：" + err.message);
    return;
  }
  closeMergeFolderDialog();
  showToast(`已合併，移動 ${result.moved} 筆記事${result.moved_children ? `、${result.moved_children} 個子資料夾` : ""}`);
  await Promise.all([loadFolders(), loadRecent()]);
}

function setInboxView(view) {
  INBOX_VIEW = view;
  localStorage.setItem("fieldlog_inbox_view", view);
  loadRecent();
}

// 「待分類」＝只列尚未放入正式資料夾的內容，以及歷史上 AI 分類後尚未確認的內容。
// 不是「不分資料夾、最後動過的全部」。2026-08-07 曾經做成後者，但代價是
// 使用者剛手動搬移／編輯過的已分類記事
// 會佔著最上面的位置，擠掉真正還沒處理的（2026-08-09 實際回報：套用天數
// 會占住最上面的位置，擠掉真正需要處理的內容。
async function loadRecent() {
  const entries = await api("/entries/recent?limit=25");
  $("inbox-count").textContent = entries.length ? `（${entries.length}）` : "";
  $("inbox-panel").style.display = "block";
  $("btn-inbox-grid").classList.toggle("active", INBOX_VIEW === "grid");
  $("btn-inbox-list").classList.toggle("active", INBOX_VIEW === "list");
  $("inbox-list").className = `entry-list ${INBOX_VIEW}-view`;
  // 全部處理完了不再另外印一句「太好了」——標題旁的數字本來就會歸零，
  // 清單留白就是最直接的訊號，多一句話反而是視覺雜訊。
  $("inbox-list").innerHTML = entries.length
    ? entries.map((e) => entryRowHtml(e, { showRecency: true })).join("")
    : "";
  bindEntryRows($("inbox-list"));
}

/** 這筆現在待在哪裡：待處理清單要一眼看得出來，不然「移動」按下去也不知道從哪搬 */
function entryLocationLabel(e) {
  if (e.folder_role === "staging") return "⏳ 待分類";
  if (e.folder_name) return `📂 ${e.folder_name}`;
  if (e.folder_id) {
    const folder = FOLDERS.find((f) => f.id === e.folder_id);
    return folder ? `📂 ${folder.name}` : "📂 資料夾";
  }
  return "⏳ 待分類";
}

/**
 * showRecency：true 時顯示的日期要跟排序依據一致——只有「最近作業」是照
 * updated_at（沒有就退回 created_at）DESC 排的，資料夾內頁的筆記清單是照
 * id DESC（＝建立順序），兩邊排序依據不同，硬套同一顯示邏輯會變成「畫面上
 * 的日期看起來沒照順序排」（2026-08-09 實際回報：明明設定只留 1 天，最近
 * 作業最上面卻還看得到一週前的日期——因為顯示的是 created_at，但排序用的
 * 是 updated_at，兩者對不上，使用者根本看不出排序邏輯有沒有在動）。
 */
function entryRowHtml(e, { showRecency = false, explorer = false } = {}) {
  // 🤖＝這個位置是 AI 挑的，不是人放的。這個區別對法規／專利場景很重要：
  // 引用之前要知道哪些判斷出自機器。點一下可以確認或改掉。
  const aiChip = e.auto_filed_at && e.auto_filed_at !== "failed"
    ? `<button class="entry-ai-chip" type="button" data-id="${e.id}" title="歷史 AI 分類：${esc(e.auto_filed_reason || "未說明理由")}。點一下確認或改位置">🤖 AI 分類</button>`
    : e.auto_filed_at === "failed"
      ? `<span class="entry-ai-chip failed" title="${esc(e.auto_filed_reason || "AI 判斷不出來")}">🤖 待人工</span>`
      : "";
  const dateLabel = showRecency
    ? `${e.updated_at ? "動過" : "建立"} ${esc(localDateTimeShort(e.updated_at || e.created_at))}`
    : esc(localDateTimeShort(e.created_at));
  return `<div class="entry-row${explorer ? " explorer-item" : ""}" data-id="${e.id}" data-folder-id="${e.folder_id ?? ""}">
    <button class="entry-drag" draggable="true" type="button" aria-label="拖曳${esc(e.title || "未命名記事")}">⠿</button>
    <span class="entry-main"><span class="entry-title">${esc(e.title || "（未命名）")}</span>
      <button class="entry-rename" data-id="${e.id}" type="button" title="重新命名" aria-label="重新命名${esc(e.title || "未命名記事")}">✏️</button>
    </span>
    <span class="entry-secondary"><span class="entry-where">${esc(entryLocationLabel(e))}</span>${aiChip}
      <span class="entry-meta">${dateLabel}${e.att_count ? `｜📎${e.att_count}` : ""}</span></span>
    <button class="entry-move" data-id="${e.id}" type="button" title="移至資料夾">移動</button>
    <button class="entry-merge" data-id="${e.id}" type="button" title="合併到另一筆記事">合併</button>
    <button class="entry-del" data-id="${e.id}" type="button" title="刪除這筆紀錄">🗑</button>
  </div>`;
}

function bindEntryRows(wrap) {
  wrap.querySelectorAll(".entry-row").forEach((el) => {
    el.onclick = () => {
      const entryId = Number(el.dataset.id);
      if (CURRENT_FOLDER && PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) {
        showEntryPreview(entryId).catch((error) => showToast("預覽失敗：" + error.message));
      } else {
        openEntry(entryId);
      }
    };
    // 拖一筆紀錄資料包到另一筆＝完整放入，不再破壞式合併。
    el.ondragover = (ev) => {
      const types = Array.from(ev.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("Files")) return;
      ev.preventDefault();
      el.classList.add("merge-target");
      ev.dataTransfer.dropEffect = types.includes("application/x-fieldlog-entry") ? "move" : "copy";
    };
    el.ondragleave = () => el.classList.remove("merge-target");
    el.ondrop = (ev) => {
      const types = Array.from(ev.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.remove("merge-target");
      if (types.includes("application/x-fieldlog-entry")) {
        const sourceId = Number(ev.dataTransfer.getData("application/x-fieldlog-entry"));
        const targetId = Number(el.dataset.id);
        if (sourceId && targetId && sourceId !== targetId) nestEntry(sourceId, targetId);
        return;
      }
      const files = Array.from(ev.dataTransfer.files || []);
      if (files.length) uploadFiles(Number(el.dataset.id), files);
    };
  });
  wrap.querySelectorAll(".entry-del").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation(); // 不要連帶觸發外層 .entry-row 的開啟
      const id = Number(btn.dataset.id);
      if (!confirm("將這筆紀錄資料包及其中全部內容移到垃圾桶？垃圾桶保留 60 天。")) return;
      try {
        await api(`/entries/${id}`, { method: "DELETE" });
        showToast("已移到垃圾桶");
        if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadRecent(); loadFolders(); }
      } catch (err) { showToast("刪除失敗：" + err.message); }
    };
  });
  wrap.querySelectorAll(".entry-rename").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (usesDesktopRightPane()) {
        showEntryEditor(Number(btn.dataset.id)).catch((err) => showToast("開啟編輯失敗：" + err.message));
        return;
      }
      const row = btn.closest(".entry-row");
      renameEntry(Number(btn.dataset.id), row?.querySelector(".entry-title")?.textContent || "")
        .catch((err) => showToast("重新命名失敗：" + err.message));
    };
  });
  wrap.querySelectorAll(".entry-move").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      openMoveEntryDialog(Number(btn.dataset.id)).catch((err) => showToast("移動失敗：" + err.message));
    };
  });
  wrap.querySelectorAll(".entry-merge").forEach((btn) => {
    btn.onclick = (ev) => { ev.stopPropagation(); openMergeEntryDialog(Number(btn.dataset.id), wrap); };
  });
  wrap.querySelectorAll(".entry-ai-chip[data-id]").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.id);
      if (confirm(`${btn.title}\n\n按「確定」表示分類正確（拿掉 🤖 標記）；按「取消」則改由你自己選位置。`)) {
        try {
          await api(`/entries/${id}/confirm-filing`, { method: "POST", body: "{}" });
          showToast("已確認分類");
          await refreshFolderView();
        } catch (err) { showToast("確認失敗：" + err.message); }
        return;
      }
      openMoveEntryDialog(id).catch((err) => showToast("移動失敗：" + err.message));
    };
  });
  wrap.querySelectorAll(".entry-drag").forEach((drag) => {
    drag.onclick = (ev) => ev.stopPropagation();
    drag.ondragstart = (ev) => {
      ev.stopPropagation();
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("application/x-fieldlog-entry", drag.closest(".entry-row").dataset.id);
      ev.dataTransfer.setData("application/x-fieldlog-entry-title", drag.closest(".entry-row").querySelector(".entry-title")?.textContent || "新資料夾");
      ev.dataTransfer.setData("application/x-fieldlog-entry-folder", drag.closest(".entry-row").dataset.folderId || "");
      drag.closest(".entry-row").classList.add("dragging");
      document.body.classList.add("entry-dragging");
    };
    drag.ondragend = () => {
      drag.closest(".entry-row").classList.remove("dragging");
      document.body.classList.remove("entry-dragging");
      $("entry-new-folder-zone").classList.remove("active");
    };
  });
}

async function nestEntry(sourceId, targetId) {
  try {
    await api(`/entries/${sourceId}`, { method: "PUT", body: JSON.stringify({ parent_entry_id: targetId }) });
    showToast("紀錄資料包已移入");
    await refreshFolderView();
  } catch (error) { showToast("移動失敗：" + error.message); }
}

// ---------- 搬移用的資料夾選擇器（樹狀，四層通吃）----------
// 為什麼不是原本那個平的 <select>：四層架構下「法規與標準」「年份／版本」這種
// 名字會在好幾個分支底下重複出現，平的清單裡看起來一模一樣，選錯了也不知道。
// 這裡列成有縮排的樹並附完整路徑；已分類的檔案／記事也能搬到任何一層，
// 或移回待分類。
let FOLDER_PICKER_RESOLVE = null;

/** 依樹狀順序（父在子之前）攤平成 [{ folder, depth }]，同層照既有排序規則 */
function folderTreeOrdered() {
  const byParent = new Map();
  for (const f of FOLDERS) {
    // role='staging' 是待分類系統容器，不屬於第一～四階資料夾樹。
    if (f.role === "staging") continue;
    const key = f.parent_id ? Number(f.parent_id) : 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  const out = [];
  const seen = new Set();
  const walk = (parentKey, depth) => {
    for (const f of (byParent.get(parentKey) || []).slice().sort(folderComparator())) {
      if (seen.has(f.id)) continue; // parent_id 有環時不會無限遞迴
      seen.add(f.id);
      out.push({ folder: f, depth });
      walk(Number(f.id), depth + 1);
    }
  };
  walk(0, 0);
  // parent_id 指向已刪除資料夾的孤兒也要出現，不然它們永遠選不到
  for (const f of FOLDERS) {
    if (f.role !== "staging" && !seen.has(f.id)) out.push({ folder: f, depth: 0 });
  }
  return out;
}

function renderFolderPickerList(filter, { currentId, allowInbox, rootLabel, excludeSubtreeOf }) {
  const wrap = $("folder-picker-list");
  const keyword = String(filter || "").trim().toLowerCase();
  const rows = [];
  // 搬資料夾時「不掛在任何人底下」也是一個合法目的地，跟搬記事時的「待分類」
  // 共用同一列（都是 folder_id = null），只是說法不一樣
  if (allowInbox || rootLabel) {
    rows.push(`<button class="fp-row" type="button" data-id="" ${currentId === null ? "disabled" : ""}>
      <span class="fp-name">${esc(rootLabel || "⏳ 待分類")}</span>${currentId === null ? `<span class="fp-here">目前位置</span>` : ""}
    </button>`);
  }
  // 搬資料夾不能選自己或自己的子孫（搬進自己底下＝把整棵樹從畫面上弄丟）
  const excluded = new Set();
  if (excludeSubtreeOf) {
    const walk = (id) => {
      excluded.add(Number(id));
      for (const f of FOLDERS) if (Number(f.parent_id) === Number(id) && !excluded.has(Number(f.id))) walk(f.id);
    };
    walk(excludeSubtreeOf);
  }
  for (const { folder, depth } of folderTreeOrdered()) {
    if (excluded.has(Number(folder.id))) continue;
    const path = folderPathOf(folder).join(" ／ ");
    if (keyword && !path.toLowerCase().includes(keyword) && !String(folder.type || "").toLowerCase().includes(keyword)) continue;
    const here = Number(currentId) === Number(folder.id);
    rows.push(`<button class="fp-row" type="button" data-id="${folder.id}" style="padding-left:${12 + depth * 18}px" ${here ? "disabled" : ""} title="${esc(path)}">
      <span class="fp-name">${folder.parent_id ? "📁" : "📂"} ${esc(folder.name)}</span>
      <span class="fp-meta">第${depth + 1}層｜${esc(folder.type)}｜${folder.entry_count} 筆</span>
      ${here ? `<span class="fp-here">目前位置</span>` : ""}
    </button>`);
  }
  wrap.innerHTML = rows.length ? rows.join("") : `<p class="sub">沒有符合的資料夾。可以按下面「＋ 建立新資料夾」。</p>`;
  wrap.querySelectorAll(".fp-row").forEach((el) => {
    el.onclick = () => closeFolderPicker({ id: el.dataset.id ? Number(el.dataset.id) : null });
  });
}

/**
 * 開啟資料夾選擇器。回傳 Promise：選了資料夾得到 { id }（待分類是 { id: null }），
 * 取消是 null——呼叫端要能分辨「選了待分類」跟「按取消」，所以不能都用 null。
 */
function openFolderPicker({ title = "移動到資料夾", desc = "", currentId, allowInbox = true, rootLabel, excludeSubtreeOf } = {}) {
  if (FOLDER_PICKER_RESOLVE) closeFolderPicker(null);
  $("folder-picker-title").textContent = title;
  $("folder-picker-desc").textContent = desc;
  $("folder-picker-search").value = "";
  const options = { currentId: currentId === undefined ? undefined : currentId, allowInbox, rootLabel, excludeSubtreeOf };
  renderFolderPickerList("", options);
  $("folder-picker-search").oninput = (ev) => renderFolderPickerList(ev.target.value, options);
  $("folder-picker-new").onclick = async () => {
    const folder = await createFolderForArchive("");
    if (!folder) return;
    closeFolderPicker({ id: Number(folder.id) });
  };
  $("folder-picker-overlay").classList.add("open");
  setTimeout(() => $("folder-picker-search").focus(), 0);
  return new Promise((resolve) => { FOLDER_PICKER_RESOLVE = resolve; });
}

function closeFolderPicker(result = null) {
  $("folder-picker-overlay").classList.remove("open");
  const resolve = FOLDER_PICKER_RESOLVE;
  FOLDER_PICKER_RESOLVE = null;
  if (resolve) resolve(result);
}

/** 記事的「移動」：待分類內容與已分類記事共用同一條路 */
async function openMoveEntryDialog(entryId, { currentFolderId, title } = {}) {
  const row = document.querySelector(`.entry-row[data-id="${entryId}"]`);
  const entryTitle = title || row?.querySelector(".entry-title")?.textContent || "這筆記事";
  const previous = currentFolderId !== undefined
    ? currentFolderId
    : (row?.dataset.folderId ? Number(row.dataset.folderId) : null);
  const picked = await openFolderPicker({
    title: "移動記事",
    desc: `把「${entryTitle}」移到哪裡？已分類的也可以再搬，或移回待分類。`,
    currentId: previous,
    allowInbox: true,
  });
  if (!picked) return;
  if (picked.id === null) {
    await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: null }) });
    showToast("已移回待分類");
    await refreshFolderView();
    return;
  }
  await moveInboxEntry(entryId, picked.id, previous);
}

// 合併目標直接從同一個列表容器（待分類或資料夾內頁）現有的 .entry-row 讀，
// 不用另外呼叫 API——候選名單自動只列出「目前畫面上看得到的」那些記事
function openMergeEntryDialog(sourceId, wrap) {
  const rows = [...wrap.querySelectorAll(".entry-row[data-id]")].filter((el) => Number(el.dataset.id) !== sourceId);
  if (!rows.length) { showToast("沒有其他記事可以合併"); return; }
  const sourceTitle = wrap.querySelector(`.entry-row[data-id="${sourceId}"] .entry-title`)?.textContent || "這筆記事";
  MERGE_ENTRY_SOURCE_ID = sourceId;
  $("merge-entry-desc").textContent = `將「${sourceTitle}」合併進另一筆記事；合併後這筆會被刪除，無法復原。`;
  $("merge-entry-target").innerHTML = rows.map((el) =>
    `<option value="${el.dataset.id}">${esc(el.querySelector(".entry-title")?.textContent || "（未命名）")}</option>`
  ).join("");
  $("merge-entry-overlay").classList.add("open");
}

function closeMergeEntryDialog() {
  MERGE_ENTRY_SOURCE_ID = null;
  $("merge-entry-overlay").classList.remove("open");
}

async function mergeEntry(sourceId, targetId) {
  if (!confirm("確定合併這兩筆記事？來源記事會被刪除，無法復原。")) return;
  try {
    const result = await api(`/entries/${sourceId}/merge`, { method: "POST", body: JSON.stringify({ target_id: targetId }) });
    closeMergeEntryDialog();
    showToast(`已合併，移動 ${result.moved} 個附件${result.duplicates_removed ? `，略過 ${result.duplicates_removed} 個重複檔` : ""}`);
    if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadRecent(); loadFolders(); }
  } catch (err) { showToast("合併失敗：" + err.message); }
}

function closeCreateFolderDialog(result = null) {
  $("create-folder-overlay").classList.remove("open");
  if (CREATE_FOLDER_RESOLVE) CREATE_FOLDER_RESOLVE(result);
  CREATE_FOLDER_RESOLVE = null;
}

/** 資料夾在四層架構裡的深度（用已載入的 FOLDERS 往上追，1＝最上層） */
function folderDepthOf(folder) {
  if (!folder) return 0;
  let depth = 0;
  let current = folder;
  const visited = new Set();
  while (current) {
    const id = Number(current.id || 0);
    if (!id || visited.has(id)) break;
    visited.add(id);
    depth++;
    current = current.parent_id ? FOLDERS.find((item) => Number(item.id) === Number(current.parent_id)) : null;
  }
  return depth;
}

/** 從最上層到這個資料夾的完整路徑（麵包屑標題用） */
function folderPathOf(folder) {
  const path = [];
  let current = folder;
  const visited = new Set();
  while (current) {
    const id = Number(current.id || 0);
    if (!id || visited.has(id)) break;
    visited.add(id);
    path.unshift(current.name);
    current = current.parent_id ? FOLDERS.find((item) => Number(item.id) === Number(current.parent_id)) : null;
  }
  return path;
}

/**
 * 建資料夾的對話框。分類選項依「這是第幾層」給——第 1 層問的是產品／專案，
 * 第 2 層問文件類型，不會把四層的選項混在一起讓人選錯。
 */
function askFolderDetails({ title = "", desc = "", name = "", type = "", parentId = null } = {}) {
  if (CREATE_FOLDER_RESOLVE) closeCreateFolderDialog(null);
  const parent = parentId ? FOLDERS.find((item) => Number(item.id) === Number(parentId)) : null;
  const level = parent ? Math.min(MAX_FOLDER_DEPTH, folderDepthOf(parent) + 1) : 1;
  const choices = choicesForLevel(level);
  const selected = choices.some((item) => item.name === type) ? type : (choices[0]?.name || "其他");

  $("create-folder-title").textContent = title || (level === 1 ? "新增產品／專案" : `新增第 ${level} 層資料夾`);
  $("create-folder-desc").textContent =
    `${desc || "建立可延伸到所有文件的共用架構"}｜第 ${level} 層：${LEVEL_HINTS[level]}`;
  $("create-folder-name").value = name;
  $("create-folder-types").innerHTML = choices.map((item) => `
    <label class="folder-type-option">
      <input type="radio" name="folder-type" value="${esc(item.name)}" ${item.name === selected ? "checked" : ""}>
      <span><b>${esc(item.icon || "🗂️")}</b><strong>${esc(item.name)}</strong><small>${esc(item.note || "")}</small></span>
    </label>`).join("");
  $("create-folder-overlay").classList.add("open");
  setTimeout(() => $("create-folder-name").focus(), 0);
  return new Promise((resolve) => { CREATE_FOLDER_RESOLVE = resolve; });
}

async function createFolderForArchive(suggestedName) {
  const defaultName = String(suggestedName || "待分類專案").replace(/（未命名）/g, "").trim() || "待分類專案";
  const details = await askFolderDetails({
    title: "建立產品／專案並移入",
    desc: "先建立第 1 層，後續可再加入文件類型與主題",
    name: defaultName,
    parentId: null,
  });
  if (!details) return null;
  const folder = await api("/folders", { method: "POST", body: JSON.stringify(details) });
  return { id: Number(folder.id), ...details };
}

async function createFolderAndMoveEntry(entryId, title) {
  const folder = await createFolderForArchive(title);
  if (!folder) return;
  try {
    await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: folder.id }) });
  } catch (err) {
    // 移動失敗時清掉剛建的空資料夾，避免留下半套結果；原記事仍在待分類。
    await api(`/folders/${folder.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
  showToast(`已建立「${folder.name}」並移入`);
  await Promise.all([loadFolders(), loadRecent()]);
}

// previousFolderId：搬移前所在的資料夾（待分類是 null）。拖曳偶爾會放錯位置，
// 資料夾，這裡記住原本位置，讓 toast 上的「上一動」能一鍵搬回去，不用重新找。
async function moveInboxEntry(entryId, folderId, previousFolderId = null) {
  const folder = FOLDERS.find((f) => f.id === folderId);
  if (!folder) return;
  await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: folderId }) });
  showToast(`已移至「${folder.name}」`, {
    actionLabel: "上一動",
    onAction: async () => {
      await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: previousFolderId }) });
      showToast(previousFolderId ? "已復原" : "已復原至待分類");
      await refreshFolderView();
    },
  });
  await refreshFolderView();
}

async function newFolder() {
  const details = await askFolderDetails({
    title: "新增產品／專案",
    desc: "第 1 層不限定 ISO，可建立任何產品、共通法規或合作專案",
    parentId: null,
  });
  if (!details) return;
  await api("/folders", { method: "POST", body: JSON.stringify(details) });
  showToast("產品／專案資料夾已建立");
  loadFolders();
}

/**
 * 在指定資料夾底下建一個子資料夾。抽出來是因為現在有兩個入口都要用同一套
 * 邏輯（深度檢查／問名稱類型／建立／重新整理）：資料夾內頁的「＋ 子資料夾」
 * 按鈕（parent 就是目前開著的 CURRENT_FOLDER），跟首頁樹狀清單每一列
 * 「⋯」選單新增的「新增子資料夾」（parent 是選單所在那一列，不用先點進去）。
 * 回傳新建資料夾的 id；使用者取消或超過層數上限則回傳 null。
 */
async function createSubfolderUnder(parentId) {
  const parent = FOLDERS.find((f) => Number(f.id) === Number(parentId));
  if (!parent) return null;
  const nextLevel = folderDepthOf(parent) + 1;
  if (nextLevel > MAX_FOLDER_DEPTH) {
    showToast(`資料夾最多 ${MAX_FOLDER_DEPTH} 層，「${parent.name}」這一層不能再新增子資料夾`);
    return null;
  }
  const details = await askFolderDetails({
    title: `新增第 ${nextLevel} 層資料夾`,
    desc: `建立在「${parent.name}」裡面`,
    parentId,
  });
  if (!details) return null;
  const created = await api("/folders", { method: "POST", body: JSON.stringify({ ...details, parent_id: parentId }) });
  await loadFolders();
  showToast(`已建立第 ${nextLevel} 層資料夾`);
  return Number(created.id);
}

async function newSubfolder() {
  if (!CURRENT_FOLDER) return;
  const parentId = CURRENT_FOLDER.id;
  const createdId = await createSubfolderUnder(parentId);
  if (createdId) openFolder(parentId);
}

/** 已經在第 4 層時就藏起「＋ 子資料夾」，而不是讓使用者按下去才被拒絕 */
function syncSubfolderButton() {
  const button = $("btn-new-subfolder");
  if (!button) return;
  const depth = folderDepthOf(CURRENT_FOLDER);
  const atLimit = depth >= MAX_FOLDER_DEPTH;
  button.hidden = atLimit;
  button.disabled = atLimit;
  button.title = atLimit
    ? `資料夾最多 ${MAX_FOLDER_DEPTH} 層`
    : `新增第 ${Math.max(1, depth + 1)} 層子資料夾（最多 ${MAX_FOLDER_DEPTH} 層）`;
}

function renderChildFolders(parentId) {
  const activeView = matchMedia("(max-width: 719px)").matches ? "list" : INNER_FOLDER_VIEW;
  const children = FOLDERS
    .filter((f) => Number(f.parent_id) === Number(parentId))
    .sort(folderComparator());
  const wrap = $("folder-children");
  wrap.innerHTML = children.length ? `<h3>📂 子資料夾</h3><div class="child-folder-list ${activeView}-view">${children.map(childFolderHtml).join("")}</div>` : "";
  bindChildFolderCards(wrap);
  bindFolderDropTargets();
}

function childFolderHtml(f) {
  return `<div class="child-folder-card explorer-item" data-id="${f.id}"${folderCategoryStyle(f)}>
    <span>📁</span><strong>${esc(f.name)}</strong><small>${folderCategoryChipHtml(f)}${esc(f.type)}<span class="folder-level-chip">第${folderDepthOf(f)}層</span>｜${f.entry_count} 筆${f.child_count ? `｜${f.child_count} 個子資料夾` : ""}</small>
    <button class="child-folder-edit" type="button" data-id="${f.id}" title="編輯資料夾名稱／類型" aria-label="編輯${esc(f.name)}資料夾">✏️</button>
    <button class="child-folder-move" type="button" data-id="${f.id}" title="把這個子資料夾搬到別的地方" aria-label="移動${esc(f.name)}資料夾">📂</button>
  </div>`;
}

function bindChildFolderCards(wrap) {
  wrap.querySelectorAll(".child-folder-card").forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest(".child-folder-edit") || ev.target.closest(".child-folder-move")) return;
      openFolder(Number(el.dataset.id));
    };
    el.querySelector(".child-folder-edit").onclick = (ev) => { ev.stopPropagation(); renameFolder(Number(el.dataset.id)); };
    el.querySelector(".child-folder-move").onclick = (ev) => { ev.stopPropagation(); moveFolder(Number(el.dataset.id)); };
  });
}

function folderFileHtml(a, entryId) {
  const url = fileUrlForKey(a.key);
  const ext = (a.filename || "").split(".").pop().toLowerCase();
  const icon = isPdfAtt(a) ? "📕" : a.kind === "photo" ? "🖼️" : a.kind === "audio" ? "🎙️"
    : ["doc", "docx"].includes(ext) ? "📘" : ["xls", "xlsx", "csv"].includes(ext) ? "📊"
      : ["ppt", "pptx"].includes(ext) ? "📙" : "📄";
  // 照片走站內檢視器；其他檔案（PDF、Office）交給瀏覽器開新分頁，那邊的檢視器比較好用
  const nameLink = isImageAtt(a)
    ? `<a class="folder-file-name is-photo" href="${url}" data-image-url="${url}" data-image-name="${esc(a.filename)}" data-image-id="${a.id}" data-image-rotation="${Number(a.rotation) || 0}">${esc(a.filename)}</a>`
    : `<a class="folder-file-name" href="${url}" target="_blank" rel="noopener">${esc(a.filename)}</a>`;
  // 每一列是「一份檔案」而不是「一筆記事」：可以拖到上方子資料夾搬移，
  // 🗑 只刪這一份，⋯ 開這一份的詳情（附屬記事、分類、AI 整理）
  return `<div class="folder-file-row explorer-item" draggable="true" data-entry-id="${entryId}" data-att-id="${a.id}" data-filename="${esc(a.filename)}" data-key="${esc(a.key)}" data-mime="${esc(a.mime || "")}" data-kind="${esc(a.kind || "")}">
    <span class="folder-file-icon" title="拖曳到上方子資料夾">${icon}</span>
    ${nameLink}
    <span class="folder-file-meta">${esc(localDateTimeShort(a.created_at))}</span>
    <button class="folder-file-delete" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="刪除這份檔案" aria-label="刪除這份檔案">🗑</button>
    <button class="folder-file-manage" type="button" data-entry-id="${entryId}" data-att-id="${a.id}" title="管理／重新命名這一份檔案" aria-label="管理或重新命名這一份檔案">⋯</button>
  </div>`;
}

/**
 * 資料夾內的檔案排序：預設新到舊（剛加進來的排最上面），可切成檔名排序。
 * 新舊用 created_at，同一秒內建立的（一次拖進來一整批）再用 attachment id
 * 當第二鍵，順序才穩定，不會每次重整都跳來跳去。
 */
function sortFolderFiles(items) {
  const byName = (a, b) => String(a.attachment.filename || "").localeCompare(
    String(b.attachment.filename || ""), "zh-Hant", { numeric: true, sensitivity: "base" },
  );
  if (FILE_SORT === "name") return items.sort(byName);
  return items.sort((a, b) =>
    String(b.attachment.created_at || "").localeCompare(String(a.attachment.created_at || ""))
    || Number(b.attachment.id) - Number(a.attachment.id));
}

function setFileSort(sort) {
  FILE_SORT = sort;
  localStorage.setItem("fieldlog_file_sort", sort);
  if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id);
}

function syncFileSortButton() {
  const button = $("btn-file-sort");
  if (!button) return;
  button.textContent = FILE_SORT === "name" ? "🔤 名稱排序" : "🆕 新到舊";
  button.title = FILE_SORT === "name"
    ? "目前依名稱排序，點一下改成新到舊（子資料夾仍排在內容前面）"
    : "目前新到舊，點一下改成依名稱排序（子資料夾仍排在內容前面）";
}

function sortExplorerItems(items) {
  return items.sort((a, b) => {
    // Windows 檔案總管的常見行為：資料夾先於內容，但全部仍在同一個內容區。
    const group = Number(a.kind !== "folder") - Number(b.kind !== "folder");
    if (group) return group;
    if (FILE_SORT === "name") {
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true, sensitivity: "base" })
        || Number(b.id || 0) - Number(a.id || 0);
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
      || Number(b.id || 0) - Number(a.id || 0);
  });
}

/**
 * 資料夾排序：不分層級，一個開關同時管首頁根層跟每一層子資料夾。
 * 不做「每層各自記自己的排序」——那樣使用者切一次只影響眼前這層，別的層還是
 * 舊排序，反而搞不清楚哪層改了、哪層沒改。
 */
function setFolderSort(sort) {
  FOLDER_SORT = sort;
  localStorage.setItem("fieldlog_folder_sort", sort);
  renderFolders();
  if (CURRENT_FOLDER) renderChildFolders(CURRENT_FOLDER.id);
}

function toggleFolderSort() {
  setFolderSort(FOLDER_SORT === "time" ? "name" : "time");
}

function syncFolderSortButtons() {
  const label = FOLDER_SORT === "time" ? "🆕 新到舊" : "🔤 名稱排序";
  const title = FOLDER_SORT === "time"
    ? "資料夾目前新到舊排序（首頁與每一層子資料夾都適用），點一下改成依名稱排序"
    : "資料夾目前依名稱排序（首頁與每一層子資料夾都適用），點一下改成新到舊排序";
  for (const id of ["btn-folder-sort-home", "btn-folder-sort-inner"]) {
    const button = $(id);
    if (!button) continue;
    button.textContent = label;
    button.title = title;
  }
}

// ---------- 資料夾內頁 ----------
async function openFolder(id) {
  CURRENT_FOLDER = FOLDERS.find((f) => f.id === id);
  if (!CURRENT_FOLDER) return;
  return withViewLoading(`正在載入「${CURRENT_FOLDER.name}」…`, async () => {
  $("desktop-pending")?.classList.remove("active");
  $("desktop-trash")?.classList.remove("active");
  $("view-home").style.display = "none";
  $("view-folder").style.display = "block";
  const parent = CURRENT_FOLDER.parent_id ? FOLDERS.find((f) => f.id === CURRENT_FOLDER.parent_id) : null;
  $("btn-back").textContent = parent ? `‹ ${parent.name}` : "‹ 回首頁";
  // 標題顯示完整路徑，四層架構下才看得出「現在在哪一層的哪個分支」
  $("folder-title").textContent = folderPathOf(CURRENT_FOLDER).join(" ／ ");
  const activeView = matchMedia("(max-width: 719px)").matches ? "list" : INNER_FOLDER_VIEW;
  $("btn-inner-grid").classList.toggle("active", activeView === "grid");
  $("btn-inner-list").classList.toggle("active", activeView === "list");
  $("btn-inner-details").classList.toggle("active", activeView === "details");
  syncFileSortButton();
  syncFolderSortButtons();
  syncSubfolderButton();
  $("folder-children").innerHTML = "";
  clearFilePreview();
  await runLegacyCleanupOnce();
  // 一次帶附件回來，不要每筆有附件的記事各發一支 /entries/:id——資料夾裡
  // 記事、附件越多，原本開資料夾要打的 API 數就跟著等比例變多，越用越慢。
  const entries = await api(`/entries?folder_id=${id}&include=attachments`);
  const visibleAtts = (e) => (e.attachments || []).filter((a) => !a.source_pdf_id);
  // 錄音不論只有一段或多段，都維持「一筆錄音紀錄」：先錄音再分類，和先進
  // 資料夾再錄音，最後都會看到同一種結構。舊邏輯把單段錄音攤成檔案列、多段錄音
  // 包成紀錄卡，導致同一次操作只因錄音長短不同就變成兩種檔案結構。
  // 非錄音仍沿用原規則：單一附件可直接瀏覽，多附件要整筆一起顯示，避免被排序拆散。
  const isRecordingEntry = (e) => visibleAtts(e).some((a) => a.kind === "audio");
  const children = FOLDERS.filter((f) => Number(f.parent_id) === Number(id));
  const explorerItems = [
    ...children.map((f) => ({
      kind: "folder", id: f.id, name: f.name, createdAt: f.updated_at || f.created_at,
      html: childFolderHtml(f),
    })),
    ...entries.flatMap((e) => {
      const atts = visibleAtts(e);
      if (atts.length === 1 && !isRecordingEntry(e)) {
        const a = atts[0];
        return [{ kind: "file", id: a.id, name: a.filename, createdAt: a.created_at || e.created_at, html: folderFileHtml(a, e.id) }];
      }
      if (isRecordingEntry(e) || atts.length > 1) {
        return [{ kind: "package", id: e.id, name: e.title, createdAt: e.created_at, html: recordGroupCardHtml(e, atts) }];
      }
      return [{ kind: "note", id: e.id, name: e.title, createdAt: e.created_at, html: entryRowHtml(e, { explorer: true }) }];
    }),
  ];
  sortExplorerItems(explorerItems);
  $("folder-entries").className = `folder-content-list ${activeView}-view`;
  $("folder-entries").innerHTML = explorerItems.length
    ? explorerItems.map((item) => item.html).join("")
    : `<p class="sub">這個資料夾還沒有內容。</p>`;
  bindChildFolderCards($("folder-entries"));
  bindFolderDropTargets();
  bindEntryRows($("folder-entries"));
  bindFileRows();
  bindRecordGroupCards();
  });
}

// 多檔案記事（分段錄音等）的卡片：跟子資料夾用同一套 .child-folder-card
// 樣式，看起來就是資料夾把附件包在裡面，不是攤平成一堆檔案列（也不是借用
// note 那組會被 grid-view 的 min-height/flex-wrap 撐得歪七扭八的 entry-row 樣式）。
function recordGroupCardHtml(e, atts) {
  const kindLabel = { audio: "🎙️ 錄音", photo: "🖼️ 照片", video: "🎥 影片" };
  const counts = atts.reduce((acc, a) => { acc[a.kind] = (acc[a.kind] || 0) + 1; return acc; }, {});
  const summary = Object.entries(counts).map(([k, n]) => `${kindLabel[k] || k} ×${n}`).join("、");
  const icon = counts.audio ? "🎙️" : "📁";
  // 刻意不共用 .child-folder-card 這個 class 名稱：bindFolderDropTargets() 用
  // ".child-folder-card[data-id]" 當拖曳檔案的落點，抓的是真正的資料夾 id；
  // 這張卡片的 data-id 其實是記事 id，混進同一個 class 會讓拖檔案誤觸到這裡，
  // 把檔案搬去一個根本不存在的資料夾。視覺樣式另外在 CSS 裡共用選取器套用。
  //
  // 拖曳／📂 移動：跟 entryRowHtml 的 .entry-drag／.entry-move 共用同一套
  // application/x-fieldlog-entry payload 與 openMoveEntryDialog()，這樣多檔案
  // 記事（分段錄音一類）才能跟純文字筆記一樣在分類後繼續移動，不用先
  // 刪掉重建（entry 266：之前這裡只有刪除鍵，完全搬不動）。
  return `<div class="record-group-card explorer-item" data-id="${e.id}" data-recording="${counts.audio ? "1" : "0"}">
    <button class="record-group-drag" type="button" draggable="true" title="拖曳到子資料夾" aria-label="拖曳${esc(e.title || "未命名記事")}">⠿</button>
    <span>${icon}</span><strong>${esc(e.title || "（未命名）")}</strong>
    <small>${esc(localDateTimeShort(e.created_at))}｜📎${atts.length}${summary ? `｜${summary}` : ""}</small>
    ${counts.audio
      ? `<button class="record-group-manage" type="button" data-id="${e.id}" title="錄音操作" aria-label="錄音操作">⋯</button>`
      : `<button class="record-group-rename" type="button" data-id="${e.id}" title="重新命名資料包" aria-label="重新命名這筆紀錄">✏️</button>
         <button class="record-group-move" type="button" data-id="${e.id}" title="移動到其他資料夾" aria-label="移動這筆紀錄">📂</button>
         <button class="record-group-del" type="button" data-id="${e.id}" title="刪除這筆紀錄" aria-label="刪除這筆紀錄">🗑</button>`}
  </div>`;
}

function bindRecordGroupCards() {
  document.querySelectorAll(".record-group-card[data-id]").forEach((card) => {
    card.onclick = (ev) => {
      if (ev.target.closest(".record-group-del") || ev.target.closest(".record-group-move") || ev.target.closest(".record-group-rename") || ev.target.closest(".record-group-manage") || ev.target.closest(".record-group-drag")) return;
      const entryId = Number(card.dataset.id);
      if (card.dataset.recording === "1") {
        if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) {
          showRecordingPreview(entryId).catch((error) => showToast("錄音預覽失敗：" + error.message));
        } else {
          openRecordingEditor(entryId).catch((error) => showToast("開啟錄音失敗：" + error.message));
        }
        return;
      }
      if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) {
        showEntryPreview(entryId).catch((error) => showToast("資料包預覽失敗：" + error.message));
      } else {
        openEntry(entryId);
      }
    };
    card.ondragover = (event) => {
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = types.includes("application/x-fieldlog-entry") ? "move" : "copy";
      card.classList.add("file-drop-target");
    };
    card.ondragleave = () => card.classList.remove("file-drop-target");
    card.ondrop = (event) => {
      event.preventDefault(); event.stopPropagation(); card.classList.remove("file-drop-target");
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry")) {
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) uploadFiles(Number(card.dataset.id), files);
        return;
      }
      const sourceId = Number(event.dataTransfer.getData("application/x-fieldlog-entry"));
      const targetId = Number(card.dataset.id);
      if (sourceId && sourceId !== targetId) nestEntry(sourceId, targetId);
    };
    const manage = card.querySelector(".record-group-manage");
    if (manage) manage.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const entryId = Number(card.dataset.id);
      const open = PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches
        ? openRecordingEditor(entryId)
        : openRecordingActions(entryId);
      open.catch((error) => showToast("開啟錄音操作失敗：" + error.message));
    };
    const del = card.querySelector(".record-group-del");
    if (del) del.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!confirm("將這筆紀錄資料包及其中全部內容移到垃圾桶？垃圾桶保留 60 天。")) return;
      try {
        await api(`/entries/${card.dataset.id}`, { method: "DELETE" });
        showToast("已移到垃圾桶");
        await refreshFolderView();
      } catch (err) { showToast("刪除失敗：" + err.message); }
    };
    const move = card.querySelector(".record-group-move");
    if (move) move.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const title = card.querySelector("strong")?.textContent || "這筆記事";
      openMoveEntryDialog(Number(card.dataset.id), { currentFolderId: CURRENT_FOLDER?.id ?? null, title })
        .catch((err) => showToast("移動失敗：" + err.message));
    };
    const rename = card.querySelector(".record-group-rename");
    if (rename) rename.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (usesDesktopRightPane()) {
        showEntryEditor(Number(card.dataset.id)).catch((err) => showToast("開啟編輯失敗：" + err.message));
        return;
      }
      renameEntry(Number(card.dataset.id), card.querySelector("strong")?.textContent || "")
        .catch((err) => showToast("重新命名失敗：" + err.message));
    };
    const drag = card.querySelector(".record-group-drag");
    drag.onclick = (ev) => ev.stopPropagation();
    drag.ondragstart = (ev) => {
      ev.stopPropagation();
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("application/x-fieldlog-entry", String(card.dataset.id));
      ev.dataTransfer.setData("application/x-fieldlog-entry-title", card.querySelector("strong")?.textContent || "新資料夾");
      ev.dataTransfer.setData("application/x-fieldlog-entry-folder", CURRENT_FOLDER?.id != null ? String(CURRENT_FOLDER.id) : "");
      card.classList.add("dragging");
      document.body.classList.add("entry-dragging");
    };
    drag.ondragend = () => {
      card.classList.remove("dragging");
      document.body.classList.remove("entry-dragging");
    };
  });
}

/**
 * 既有附件的一次性整理：統一檔名、移除內容完全相同的重複檔。
 * 只用已入庫的 OCR／逐字稿，不呼叫 AI（不花額度）；整個瀏覽器只跑一次。
 */
async function runLegacyCleanupOnce() {
  if (localStorage.getItem("fieldlog_legacy_cleanup") === "done") return;
  localStorage.setItem("fieldlog_legacy_cleanup", "running");
  try {
    const result = await api("/attachments/rename-existing", { method: "POST", body: "{}" });
    localStorage.setItem("fieldlog_legacy_cleanup", "done");
    if (result.renamed || result.duplicates_removed) {
      showToast(`已整理 ${result.renamed || 0} 個檔名，移除 ${result.duplicates_removed || 0} 個重複檔`);
    }
  } catch (err) {
    localStorage.removeItem("fieldlog_legacy_cleanup");
    console.error("舊檔名自動整理失敗", err);
  }
}

/** 手動整理檔名（資料夾工具列的 🏷 按鈕） */
async function cleanupFilenames(button) {
  if (!confirm("整理全部檔名？會統一成「標準編號_年份_中文標題」，並移除內容完全相同的重複檔。不會呼叫 AI。")) return;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "整理中…";
  try {
    const result = await api("/attachments/rename-existing", { method: "POST", body: "{}" });
    showToast(`檔名整理完成：更新 ${result.renamed || 0} 個，移除重複檔 ${result.duplicates_removed || 0} 個`);
    if (CURRENT_FOLDER) await openFolder(CURRENT_FOLDER.id);
  } catch (err) {
    showToast("整理失敗：" + err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- 檔案列：拖曳搬移、單檔刪除、單檔詳情 ----------

async function refreshFolderView() {
  await loadFolders();
  if (CURRENT_FOLDER) await openFolder(CURRENT_FOLDER.id);
  else await loadRecent();
}

async function renameEntry(entryId, currentTitle) {
  const next = prompt("輸入新的名稱", currentTitle || "");
  if (next === null) return;
  const title = next.trim();
  if (!title) { showToast("名稱不可空白"); return; }
  if (title === currentTitle) return;
  await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ title }) });
  showToast("名稱已更新");
  await refreshFolderView();
}

function fileExtension(filename) {
  const match = String(filename || "").match(/(\.[^./\\]+)$/);
  return match ? match[1] : "";
}

async function renameAttachment(attachmentId, currentFilename, { reopenEntryId = null } = {}) {
  const ext = fileExtension(currentFilename);
  const base = ext ? currentFilename.slice(0, -ext.length) : currentFilename;
  const entered = prompt(ext ? `輸入新的檔名（${ext} 會自動保留）` : "輸入新的檔名", base || currentFilename || "");
  if (entered === null) return;
  let filename = entered.trim();
  if (!filename) { showToast("檔名不可空白"); return; }
  if (ext && !filename.toLowerCase().endsWith(ext.toLowerCase())) filename += ext;
  if (filename === currentFilename) return;
  await api(`/attachments/${attachmentId}`, { method: "PUT", body: JSON.stringify({ filename }) });
  showToast("檔名已更新");
  await refreshFolderView();
  if (reopenEntryId) await openEntry(reopenEntryId);
}

async function removeOneFile(attachmentId, filename, closeDetail) {
  if (!confirm(`確定刪除「${filename}」？只會刪除這一份檔案。`)) return;
  await api(`/attachments/${attachmentId}`, { method: "DELETE" });
  showToast("檔案已刪除");
  if (closeDetail) {
    FOCUSED_FILE = null;
    $("entry-overlay").classList.remove("open");
    unlockBodyScroll();
  }
  await refreshFolderView();
}

function bindFileRows() {
  document.querySelectorAll(".folder-file-row[data-att-id]").forEach((row) => {
    row.onclick = (event) => {
      if (event.target.closest("button") || !PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return;
      event.preventDefault();
      showFilePreview({
        entryId: Number(row.dataset.entryId), attachmentId: Number(row.dataset.attId),
        filename: row.dataset.filename || "檔案", key: row.dataset.key || "",
        mime: row.dataset.mime || "", kind: row.dataset.kind || "",
      }).catch((error) => showToast("預覽失敗：" + error.message));
    };
    row.ondblclick = (event) => {
      if (event.target.closest("button")) return;
      const link = row.querySelector(".folder-file-name");
      if (link?.href) window.open(link.href, "_blank", "noopener");
    };
    const manage = row.querySelector(".folder-file-manage");
    if (manage) {
      manage.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const entryId = Number(manage.dataset.entryId);
        const attachmentId = Number(manage.dataset.attId);
        const open = PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches
          ? showFileEditor(entryId, attachmentId)
          : openFileDetail(entryId, attachmentId);
        open.catch((error) => showToast("開啟檔案失敗：" + error.message));
      };
    }
    const deleteButton = row.querySelector(".folder-file-delete");
    if (deleteButton) {
      deleteButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeOneFile(Number(deleteButton.dataset.attId), row.dataset.filename || "這份檔案", false)
          .catch((error) => showToast("刪除失敗：" + error.message));
      };
    }
    row.ondragstart = (event) => {
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-fieldlog-attachment", JSON.stringify({
        attachmentId: Number(row.dataset.attId),
        entryId: Number(row.dataset.entryId),
        filename: row.dataset.filename || "檔案",
        sourceFolderId: CURRENT_FOLDER?.id || null,
      }));
    };
    row.ondragend = () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".child-folder-card.file-drop-target")
        .forEach((card) => card.classList.remove("file-drop-target"));
    };
  });
  bindImageLinks();
}

function clearFilePreview(message = "選取一份檔案以預覽") {
  const pane = $("folder-preview");
  const body = $("folder-preview-body");
  if (!pane || !body) return;
  pane.dataset.attachmentId = "";
  pane.dataset.entryId = "";
  if ($("folder-preview-title")) $("folder-preview-title").textContent = "預覽";
  if ($("folder-preview-open")) {
    $("folder-preview-open").hidden = false;
    $("folder-preview-open").textContent = "開啟原檔";
    $("folder-preview-open").href = "#";
    $("folder-preview-open").onclick = (event) => event.preventDefault();
  }
  if ($("folder-preview-edit")) {
    $("folder-preview-edit").hidden = true;
    $("folder-preview-edit").onclick = null;
  }
  if ($("folder-preview-manage")) {
    $("folder-preview-manage").disabled = true;
    $("folder-preview-manage").onclick = null;
  }
  body.innerHTML = `<p class="folder-preview-empty">${esc(message)}</p>`;
  document.querySelectorAll(".preview-selected").forEach((row) => row.classList.remove("preview-selected"));
}

function recordingPreviewTranscript(audioAttachments) {
  return (audioAttachments || [])
    .filter((item) => String(item.transcript || "").trim())
    .sort((a, b) => Number(a.offset_secs || 0) - Number(b.offset_secs || 0) || Number(a.id) - Number(b.id))
    .map((item) => (audioAttachments.length > 1
      ? `【${fmtSecs(item.offset_secs || 0)}｜${item.filename}】\n${String(item.transcript).trim()}`
      : String(item.transcript).trim()))
    .join("\n\n");
}

function visibleEntryFields(entry) {
  try {
    return Object.entries(JSON.parse(entry.fields_json || "{}"))
      .filter(([key]) => !key.startsWith("_") && !["litdb_id", "medtec_exhibitor_id"].includes(key));
  } catch {
    return [];
  }
}

async function showEntryPreview(entryId) {
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return openEntry(entryId);
  return withViewLoading("正在載入紀錄…", () => renderEntryPreview(entryId));
}

async function renderEntryPreview(entryId) {
  const entry = await api(`/entries/${entryId}`);
  const body = $("folder-preview-body");
  const fields = visibleEntryFields(entry);
  const attachments = (entry.attachments || []).filter((item) => !item.source_pdf_id);
  document.querySelectorAll(".preview-selected").forEach((row) => row.classList.remove("preview-selected"));
  document.querySelector(`.entry-row[data-id="${entryId}"], .record-group-card[data-id="${entryId}"]`)?.classList.add("preview-selected");
  $("folder-preview").dataset.entryId = String(entryId);
  $("folder-preview").dataset.attachmentId = "";
  $("folder-preview-title").textContent = entry.title || "記事";
  body.innerHTML = `<article class="entry-side-preview">
    ${plainEntryBody(entry).trim() ? `<section><h3>內容</h3><pre>${esc(plainEntryBody(entry).trim())}</pre></section>` : ""}
    ${fields.map(([key, value]) => `<section><h3>${esc(key)}</h3><pre>${esc(String(value || ""))}</pre></section>`).join("")}
    ${attachments.length ? `<section><h3>附件（${attachments.length}）</h3><div class="entry-side-attachments">${attachments.map((item) =>
      `<button type="button" data-id="${item.id}">${esc(item.filename || "附件")}<small>${esc(fmtBytes(item.size))}</small></button>`).join("")}</div></section>` : ""}
    ${!plainEntryBody(entry).trim() && !fields.length && !attachments.length ? '<p class="folder-preview-empty">這筆記事目前沒有內容。</p>' : ""}
  </article>`;
  body.querySelectorAll(".entry-side-attachments button").forEach((button) => {
    button.onclick = () => {
      const attachment = attachments.find((item) => Number(item.id) === Number(button.dataset.id));
      if (!attachment) return;
      showFilePreview({ entryId, attachmentId: attachment.id, filename: attachment.filename,
        key: attachment.key, mime: attachment.mime, kind: attachment.kind })
        .catch((error) => showToast("附件預覽失敗：" + error.message));
    };
  });
  $("folder-preview-open").hidden = true;
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "編輯";
  $("folder-preview-edit").onclick = () => showEntryEditor(entryId).catch((error) => showToast("開啟編輯失敗：" + error.message));
  $("folder-preview-manage").disabled = false;
  $("folder-preview-manage").onclick = () => showEntryEditor(entryId)
    .catch((error) => showToast("開啟編輯失敗：" + error.message));
}

async function showEntryEditor(entryId) {
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return openEntry(entryId);
  return withViewLoading("正在載入編輯欄…", () => renderEntryEditor(entryId));
}

async function renderEntryEditor(entryId) {
  const entry = await api(`/entries/${entryId}`);
  const body = $("folder-preview-body");
  const fields = visibleEntryFields(entry);
  const isWeeklyReport = (() => {
    try { return JSON.parse(entry.fields_json || "{}")._kind === "weekly_report"; } catch { return false; }
  })();
  const hasLegacyRichBody = entry.body_format === "html";
  $("folder-preview-title").textContent = `編輯｜${entry.title || "記事"}`;
  body.innerHTML = `<form class="preview-editor" id="entry-preview-editor">
    <label for="preview-entry-title">名稱</label>
    <input id="preview-entry-title" maxlength="160" value="${esc(entry.title || "")}" ${isWeeklyReport ? "disabled" : ""} />
    ${!isWeeklyReport && !hasLegacyRichBody ? `<label for="preview-entry-body">內容</label><textarea id="preview-entry-body">${esc(plainEntryBody(entry))}</textarea>` : ""}
    ${hasLegacyRichBody ? '<p class="sub">這是舊版富文字資料。為避免破壞原排版，舊內文維持唯讀；名稱與欄位仍只在右欄修改，不再開啟第二套編輯框。</p>' : ""}
    ${fields.map(([key, value], index) => `<label for="preview-entry-field-${index}">${esc(key)}</label>
      <textarea id="preview-entry-field-${index}" data-field="${esc(key)}">${esc(String(value || ""))}</textarea>`).join("")}
    <div class="preview-editor-actions"><button class="btn primary" id="preview-entry-save" type="submit">儲存</button><button class="btn" id="preview-entry-cancel" type="button">取消</button></div>
  </form>`;
  const returnToPreview = () => showEntryPreview(entryId).catch((error) => showToast("預覽失敗：" + error.message));
  $("folder-preview-open").hidden = true;
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "取消";
  $("folder-preview-edit").onclick = returnToPreview;
  $("folder-preview-manage").disabled = true;
  $("folder-preview-manage").onclick = null;
  $("preview-entry-cancel").onclick = returnToPreview;
  $("entry-preview-editor").onsubmit = async (event) => {
    event.preventDefault();
    const save = $("preview-entry-save");
    const title = $("preview-entry-title").value.trim();
    if (!isWeeklyReport && !title) return showToast("名稱不可空白");
    const patch = { fields: {} };
    if (!isWeeklyReport) {
      patch.title = title;
      if (!hasLegacyRichBody) {
        patch.body = $("preview-entry-body").value.trim();
        patch.body_format = "text";
      }
    }
    body.querySelectorAll("textarea[data-field]").forEach((textarea) => { patch.fields[textarea.dataset.field] = textarea.value.trim(); });
    save.disabled = true;
    save.textContent = "儲存中…";
    try {
      await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify(patch) });
      showToast("記事已儲存");
      await refreshFolderView();
      await showEntryPreview(entryId);
    } catch (error) {
      showToast("儲存失敗：" + error.message);
      save.disabled = false;
      save.textContent = "儲存";
    }
  };
}

async function showRecordingPreview(entryId) {
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return;
  return withViewLoading("正在載入錄音…", () => renderRecordingPreview(entryId));
}

async function renderRecordingPreview(entryId) {
  const pane = $("folder-preview");
  const body = $("folder-preview-body");
  const title = $("folder-preview-title");
  if (!pane || !body || !title) return;
  const entry = await api(`/entries/${entryId}`);
  const audio = (entry.attachments || []).filter((item) => item.kind === "audio" && !item.source_pdf_id);
  if (!audio.length) {
    // 不是錄音資料包或舊資料已缺錄音附件時才退回舊詳情，避免新介面硬猜。
    return openEntry(entryId);
  }
  document.querySelectorAll(".preview-selected").forEach((row) => row.classList.remove("preview-selected"));
  document.querySelector(`.record-group-card[data-id="${entryId}"]`)?.classList.add("preview-selected");
  pane.dataset.attachmentId = "";
  pane.dataset.entryId = String(entryId);
  title.textContent = entry.title || "錄音";

  const totalSize = audio.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const knownDuration = audio.filter((item) => Number(item.duration_secs) > 0);
  const totalDuration = knownDuration.reduce((sum, item) => sum + Number(item.duration_secs), 0);
  const status = recordingStatus(audio);
  const transcript = recordingPreviewTranscript(audio);
  const note = String(entry.body || "").trim();
  body.innerHTML = `<div class="recording-preview">
    <div class="recording-preview-summary">
      <span class="recording-status ${status.tone}">${esc(status.label)}</span>
      <dl>
        <div><dt>錄音時間</dt><dd>${esc(localDateTime(entry.created_at))}</dd></div>
        <div><dt>長度</dt><dd>${knownDuration.length === audio.length ? esc(fmtSecs(totalDuration)) : "部分檔案未記錄"}</dd></div>
        <div><dt>檔案大小</dt><dd>${esc(fmtBytes(totalSize))}</dd></div>
        <div><dt>錄音段數</dt><dd>${audio.length}</dd></div>
      </dl>
    </div>
    <div class="recording-segments">${audio.map((item, index) => `<section class="recording-segment">
      <div><strong>${audio.length > 1 ? `第 ${index + 1} 段` : "錄音檔"}</strong><span>${esc(fmtBytes(item.size))}${Number(item.duration_secs) > 0 ? `｜${esc(fmtSecs(item.duration_secs))}` : ""}</span></div>
      <audio controls preload="metadata" src="${fileUrlForKey(item.key)}"></audio>
      <a class="recording-download" href="${fileUrlForKey(item.key)}" download="${esc(item.filename)}">下載 ${esc(item.filename)}</a>
    </section>`).join("")}</div>
    <section class="recording-preview-section"><h3>逐字稿</h3>
      ${transcript ? `<pre>${esc(transcript)}</pre>` : `<p class="folder-preview-empty compact">${esc(status.label)}</p>`}
    </section>
    ${note ? `<section class="recording-preview-section"><h3>速記</h3><pre>${esc(note)}</pre></section>` : ""}
  </div>`;

  const firstUrl = fileUrlForKey(audio[0].key);
  $("folder-preview-open").hidden = false;
  $("folder-preview-open").textContent = audio.length === 1 ? "下載錄音" : "下載第 1 段";
  $("folder-preview-open").href = firstUrl;
  $("folder-preview-open").setAttribute("download", audio[0].filename || "recording");
  $("folder-preview-open").onclick = null;
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "編輯";
  $("folder-preview-edit").onclick = () => openRecordingEditor(entryId)
    .catch((error) => showToast("開啟錄音編輯失敗：" + error.message));
  $("folder-preview-manage").disabled = false;
  $("folder-preview-manage").onclick = () => openRecordingEditor(entryId)
    .catch((error) => showToast("開啟錄音編輯失敗：" + error.message));
}

function parseCsvPreviewRow(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value); value = "";
    } else value += char;
  }
  cells.push(value);
  return cells;
}

function renderDelimitedTable(text, { spreadsheet = false } = {}) {
  const source = String(text || "").trim();
  if (!source) return "";
  const blocks = spreadsheet ? source.split(/^== 工作表 (\d+) ==$/m) : ["", "資料", source];
  const sheets = [];
  for (let index = 1; index < blocks.length; index += 2) {
    const name = spreadsheet ? `工作表 ${blocks[index]}` : "資料";
    const rows = String(blocks[index + 1] || "").trim().split(/\r?\n/).filter(Boolean)
      .slice(0, 500).map((line) => (spreadsheet || line.includes("\t") ? line.split("\t") : parseCsvPreviewRow(line)).slice(0, 80));
    if (rows.length) sheets.push({ name, rows });
  }
  if (!sheets.length) return "";
  return `<div class="spreadsheet-preview">${sheets.map(({ name, rows }) => {
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    return `<section><h3>${esc(name)}</h3><div class="spreadsheet-scroll"><table><tbody>${normalized.map((row, rowIndex) =>
      `<tr>${row.map((cell) => `<${rowIndex === 0 ? "th" : "td"}>${esc(cell)}</${rowIndex === 0 ? "th" : "td"}>`).join("")}</tr>`
    ).join("")}</tbody></table></div>${rows.length >= 500 ? '<p class="sub">預覽只顯示前 500 列，完整內容請開啟原檔。</p>' : ""}</section>`;
  }).join("")}</div>`;
}

async function attachmentWithText(entryId, attachmentId, { extract = false } = {}) {
  const entry = await api(`/entries/${entryId}`);
  let attachment = (entry.attachments || []).find((item) => Number(item.id) === Number(attachmentId));
  if (!attachment) throw new Error("這份檔案已不存在");
  if (extract && !String(attachment.ocr_text || "").trim() && !attachment.ocr_at) {
    try {
      const result = await api(`/attachments/${attachmentId}/ocr`, { method: "POST", body: "{}" });
      attachment = { ...attachment, ocr_text: result.ocr_text || "", ocr_at: new Date().toISOString() };
    } catch (error) {
      attachment = { ...attachment, preview_error: error.message };
    }
  }
  return { entry, attachment };
}

async function renderPdfPreview(url, body, filename) {
  if (!window.pdfjsLib?.getDocument) {
    body.innerHTML = `<p class="folder-preview-empty">PDF 預覽程式尚未載入。可先按「開啟原檔」。</p>`;
    return;
  }
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF 讀取失敗（HTTP ${response.status}）`);
  const pdf = await window.pdfjsLib.getDocument({ data: await response.arrayBuffer() }).promise;
  body.innerHTML = `<div class="pdf-sidebar-preview">
    <div class="pdf-sidebar-toolbar"><button class="btn small" type="button" data-dir="-1">‹ 上一頁</button><span>第 <b>1</b> / ${pdf.numPages} 頁</span><button class="btn small" type="button" data-dir="1">下一頁 ›</button></div>
    <div class="pdf-sidebar-canvas-wrap"><canvas aria-label="${esc(filename)} PDF 預覽"></canvas></div>
  </div>`;
  const canvas = body.querySelector("canvas");
  const pageLabel = body.querySelector(".pdf-sidebar-toolbar b");
  const buttons = [...body.querySelectorAll(".pdf-sidebar-toolbar button")];
  let pageNo = 1;
  let rendering = false;
  const render = async () => {
    if (rendering) return;
    rendering = true;
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const available = Math.max(260, body.clientWidth - 28);
      const viewport = page.getViewport({ scale: Math.min(2, available / base.width) });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      pageLabel.textContent = String(pageNo);
    } finally {
      rendering = false;
      buttons[0].disabled = pageNo <= 1;
      buttons[1].disabled = pageNo >= pdf.numPages;
    }
  };
  buttons.forEach((button) => {
    button.onclick = async () => {
      const next = pageNo + Number(button.dataset.dir || 0);
      if (next < 1 || next > pdf.numPages || rendering) return;
      pageNo = next;
      await render();
    };
  });
  await render();
}

async function showFilePreview({ entryId, attachmentId, filename, key, mime, kind }) {
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return;
  return withViewLoading("正在載入檔案…", () => renderFilePreview({ entryId, attachmentId, filename, key, mime, kind }));
}

async function renderFilePreview({ entryId, attachmentId, filename, key, mime, kind }) {
  const pane = $("folder-preview");
  const body = $("folder-preview-body");
  const title = $("folder-preview-title");
  if (!pane || !body || !title) return;
  document.querySelectorAll(".preview-selected").forEach((row) => row.classList.remove("preview-selected"));
  document.querySelector(`.folder-file-row[data-att-id="${attachmentId}"]`)?.classList.add("preview-selected");
  pane.dataset.attachmentId = String(attachmentId);
  pane.dataset.entryId = String(entryId);
  title.textContent = filename;
  body.innerHTML = `<p class="folder-preview-empty">載入預覽中…</p>`;
  const url = fileUrlForKey(key);
  const ext = String(filename).split(".").pop().toLowerCase();
  const image = kind === "photo" || /^image\//i.test(mime);
  const audio = kind === "audio" || /^audio\//i.test(mime);
  const video = kind === "video" || /^video\//i.test(mime);
  const pdf = mime === "application/pdf" || ext === "pdf";
  const html = /^text\/html/i.test(mime) || ["html", "htm"].includes(ext);
  const plain = /^text\//i.test(mime) || ["txt", "md", "csv", "json", "xml"].includes(ext);
  const modernOffice = ["docx", "xlsx", "pptx"].includes(ext);
  if (image) body.innerHTML = `<img class="folder-preview-image" src="${url}" alt="${esc(filename)}" />`;
  else if (audio) body.innerHTML = `<audio class="folder-preview-media" controls preload="metadata" src="${url}"></audio>`;
  else if (video) body.innerHTML = `<video class="folder-preview-media" controls preload="metadata" src="${url}"></video>`;
  else if (pdf) await renderPdfPreview(url, body, filename);
  else if (html) body.innerHTML = `<iframe class="folder-preview-frame" sandbox src="${url}" title="${esc(filename)}"></iframe>`;
  else if (ext === "csv") {
    const { text, truncated } = await fetchTextPreview(url, 200000);
    body.innerHTML = renderDelimitedTable(text) || `<pre class="folder-preview-text">${esc(text)}</pre>`;
    if (truncated) body.insertAdjacentHTML("beforeend", '<p class="sub preview-limit-note">預覽只顯示前 200,000 字。</p>');
  } else if (plain) {
    const { text, truncated } = await fetchTextPreview(url, 200000);
    body.innerHTML = `<pre class="folder-preview-text">${esc(text)}${truncated ? "\n\n［預覽只顯示前 200,000 字］" : ""}</pre>`;
  } else if (modernOffice) {
    const loaded = await attachmentWithText(entryId, attachmentId, { extract: true });
    const extracted = String(loaded.attachment.ocr_text || "").trim();
    if (ext === "xlsx") {
      body.innerHTML = renderDelimitedTable(extracted, { spreadsheet: true }) ||
        `<p class="folder-preview-empty">${esc(loaded.attachment.preview_error || "這份 Excel 沒有可顯示的儲存格內容。")}</p>`;
    } else {
      body.innerHTML = extracted
        ? `<pre class="folder-preview-text office-text-preview">${esc(extracted.slice(0, 200000))}</pre>`
        : `<p class="folder-preview-empty">${esc(loaded.attachment.preview_error || `這份 ${ext === "docx" ? "Word" : "PowerPoint"} 沒有可顯示的文字內容。`)}</p>`;
    }
  } else if (["doc", "xls", "ppt"].includes(ext)) {
    body.innerHTML = `<div class="folder-preview-empty"><strong>舊版 Office 格式無法可靠預覽</strong><p>請用 Office 另存為 .${ext}x 後重新上傳；原檔仍可下載。</p></div>`;
  } else if (["odt", "ods", "odp", "rtf"].includes(ext)) {
    body.innerHTML = `<div class="folder-preview-empty"><strong>此 OpenDocument／RTF 目前只提供原檔</strong><p>可另存為 docx、xlsx 或 pptx，以取得右欄文字或表格預覽。</p></div>`;
  } else body.innerHTML = `<p class="folder-preview-empty">此格式目前無法在側欄預覽，可開啟原檔。</p>`;
  $("folder-preview-open").hidden = false;
  $("folder-preview-open").href = url;
  $("folder-preview-open").removeAttribute("download");
  $("folder-preview-open").textContent = "開啟原檔";
  $("folder-preview-open").onclick = null;
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "編輯";
  $("folder-preview-edit").onclick = () => showFileEditor(entryId, attachmentId)
    .catch((error) => showToast("開啟檔案編輯失敗：" + error.message));
  $("folder-preview-manage").disabled = false;
  $("folder-preview-manage").onclick = () => showFileEditor(entryId, attachmentId)
    .catch((error) => showToast("開啟檔案編輯失敗：" + error.message));
}

async function showFileEditor(entryId, attachmentId) {
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return openFileDetail(entryId, attachmentId);
  return withViewLoading("正在載入檔案編輯欄…", () => renderFileEditor(entryId, attachmentId));
}

async function renderFileEditor(entryId, attachmentId) {
  const body = $("folder-preview-body");
  const title = $("folder-preview-title");
  const { entry, attachment } = await attachmentWithText(entryId, attachmentId);
  const sourceAttachments = (entry.attachments || []).filter((item) => !item.source_pdf_id);
  const deepPages = (entry.attachments || [])
    .filter((item) => Number(item.source_pdf_id) === Number(attachmentId))
    .sort((left, right) => Number(left.page_no || 0) - Number(right.page_no || 0));
  const deepText = deepPages.map((item) => String(item.ocr_text || "").trim()).filter(Boolean).join("\n\n");
  const initialIndexText = String(attachment.ocr_text || "").trim() || deepText;
  const legacyNote = sourceAttachments.length === 1 ? String(entry.body || "").trim() : "";
  const note = String(attachment.note || "").trim() || legacyNote;
  const canExtract = TRANSCRIBE_ENABLED && (attachment.kind === "photo" || isPdfAtt(attachment) || isNativeDocAtt(attachment));
  const extractStatus = initialIndexText
    ? `已擷取 ${initialIndexText.length.toLocaleString()} 字${!attachment.ocr_text && deepText ? "（逐頁結果）" : ""}`
    : attachment.ocr_at === "skipped" ? "已設定略過"
      : attachment.ocr_at ? "已擷取，但未找到文字" : "尚未擷取";
  title.textContent = `編輯｜${attachment.filename}`;
  body.innerHTML = `<form class="preview-editor" id="file-preview-editor">
    <label for="preview-file-name">檔案名稱</label>
    <input id="preview-file-name" maxlength="240" value="${esc(attachment.filename || "")}" />
    <label for="preview-file-note">附屬記事</label>
    <textarea id="preview-file-note" placeholder="這份檔案的摘要、用途或待辦">${esc(note)}</textarea>
    <label for="preview-file-category">醫療器材分類</label>
    <select id="preview-file-category"><option value="">讀取分類中…</option></select>
    <section class="preview-processing-panel">
      <div class="preview-processing-head"><div><strong>擷取／索引文字</strong><p class="sub" id="preview-file-ocr-status">${esc(extractStatus)}</p></div>
        <div class="preview-processing-actions">
          ${canExtract ? `<button class="btn small" id="preview-file-ocr" type="button">${initialIndexText ? "重新擷取" : "擷取文字"}</button>` : ""}
          ${isPdfAtt(attachment) && TRANSCRIBE_ENABLED ? '<button class="btn small" id="preview-file-deep" type="button">逐頁深度擷取</button>' : ""}
          <button class="btn small" id="preview-file-copy" type="button">複製文字</button>
        </div>
      </div>
      <p class="sub">供搜尋與 AI 使用；可直接修正，不會改動原始檔案。</p>
      <textarea id="preview-file-index" class="preview-index-text" placeholder="尚無文字。可按「擷取文字」，或自行貼上摘要與關鍵字。">${esc(initialIndexText)}</textarea>
    </section>
    <section class="preview-management-panel">
      <strong>檔案管理</strong>
      <div class="preview-management-actions">
        <button class="btn small" id="preview-file-normalize" type="button">整理中文檔名</button>
        <button class="btn small" id="preview-file-move" type="button">移動</button>
        <button class="btn small" id="preview-file-share" type="button">唯讀分享</button>
        ${isPdfAtt(attachment) ? '<button class="btn small" id="preview-file-doodle" type="button">PDF 塗鴉</button>' : ""}
        <button class="btn small danger" id="preview-file-delete" type="button">刪除檔案</button>
      </div>
    </section>
    <div class="preview-editor-actions"><button class="btn primary" id="preview-file-save" type="submit">儲存</button><button class="btn" id="preview-file-cancel" type="button">取消</button></div>
  </form>`;
  const categorySelect = $("preview-file-category");
  try {
    const category = await api(`/attachments/${attachmentId}/category`);
    categorySelect.innerHTML = `<option value="">未分類</option>${(category.categories || []).map((name) =>
      `<option value="${esc(name)}" ${name === category.category ? "selected" : ""}>${esc(name)}</option>`).join("")}`;
  } catch (error) {
    categorySelect.innerHTML = `<option value="">分類讀取失敗</option>`;
    categorySelect.disabled = true;
  }
  const returnToPreview = () => showFilePreview({
    entryId, attachmentId, filename: attachment.filename, key: attachment.key, mime: attachment.mime, kind: attachment.kind,
  }).catch((error) => showToast("預覽失敗：" + error.message));
  $("folder-preview-open").hidden = false;
  $("folder-preview-open").href = fileUrlForKey(attachment.key);
  $("folder-preview-open").textContent = "開啟原檔";
  $("folder-preview-open").removeAttribute("download");
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "取消";
  $("folder-preview-edit").onclick = returnToPreview;
  $("folder-preview-manage").disabled = true;
  $("folder-preview-manage").onclick = null;
  $("preview-file-cancel").onclick = returnToPreview;
  $("preview-file-copy").onclick = async () => {
    const text = $("preview-file-index").value;
    if (!text.trim()) return showToast("目前沒有可複製的文字");
    try { await navigator.clipboard.writeText(text); showToast("索引文字已複製"); }
    catch { showToast("瀏覽器無法自動複製，請在文字框內全選複製"); }
  };
  if ($("preview-file-ocr")) $("preview-file-ocr").onclick = async () => {
    const button = $("preview-file-ocr");
    if (initialIndexText && !confirm("重新擷取會覆蓋目前文字框的內容，確定繼續？")) return;
    button.disabled = true;
    button.textContent = "擷取中…";
    $("preview-file-ocr-status").textContent = "AI 正在擷取文字，請稍候…";
    try {
      const result = await api(`/attachments/${attachmentId}/ocr`, { method: "POST", body: "{}" });
      const text = String(result.ocr_text || "").trim();
      $("preview-file-index").value = text;
      $("preview-file-ocr-status").textContent = text ? `已擷取 ${text.length.toLocaleString()} 字` : "已擷取，但未找到文字";
      button.textContent = "重新擷取";
      showToast(text ? "文字擷取完成，可修正後儲存" : "擷取完成，但未找到文字");
    } catch (error) {
      $("preview-file-ocr-status").textContent = `擷取失敗：${error.message}`;
      button.textContent = initialIndexText ? "重新擷取" : "擷取文字";
      showToast("擷取失敗：" + error.message);
    } finally { button.disabled = false; }
  };
  if ($("preview-file-deep")) $("preview-file-deep").onclick = () => {
    deepProcessPdf(entryId, attachment, $("preview-file-deep"), deepPages,
      () => showFileEditor(entryId, attachmentId));
  };
  $("preview-file-normalize").onclick = async () => {
    const button = $("preview-file-normalize");
    button.disabled = true;
    button.textContent = "整理中…";
    try {
      const result = await api(`/attachments/${attachmentId}/normalize-name`, { method: "POST", body: "{}" });
      showToast(result.renamed ? "已更新中文檔名" : result.incomplete_year ? "尚未確認年份，請先擷取文字" : "檔名已是目前可確認的格式");
      await refreshFolderView();
      await showFileEditor(entryId, attachmentId);
    } catch (error) {
      showToast("整理檔名失敗：" + error.message);
      button.disabled = false;
      button.textContent = "整理中文檔名";
    }
  };
  $("preview-file-move").onclick = async () => {
    const picked = await openFolderPicker({
      title: "移動檔案",
      desc: `把「${attachment.filename}」移到哪個資料夾？`,
      currentId: entry.folder_id || null,
      allowInbox: false,
    });
    if (!picked?.id) return;
    try {
      const result = await api(`/attachments/${attachmentId}/move`, { method: "POST", body: JSON.stringify({ folder_id: picked.id }) });
      showToast(result.moved ? `已移到「${FOLDERS.find((folder) => folder.id === picked.id)?.name || "資料夾"}」` : "已經在這個資料夾了");
      await refreshFolderView();
      clearFilePreview("檔案已移動，請從左側資料夾重新選取。");
    } catch (error) { showToast("移動失敗：" + error.message); }
  };
  $("preview-file-share").onclick = () => createReadOnlyShare(entryId, attachmentId)
    .catch((error) => showToast("分享失敗：" + error.message));
  if ($("preview-file-doodle")) $("preview-file-doodle").onclick = () => {
    if (typeof window.fieldlogOpenPdfEditor !== "function") return showToast("PDF 塗鴉程式還在載入，請稍後再試");
    window.fieldlogOpenPdfEditor(entryId, attachment).catch((error) => showToast("開啟塗鴉失敗：" + error.message));
  };
  $("preview-file-delete").onclick = async () => {
    if (!confirm(`確定刪除「${attachment.filename}」？只會刪除這一份檔案。`)) return;
    try {
      await api(`/attachments/${attachmentId}`, { method: "DELETE" });
      showToast("檔案已刪除");
      await refreshFolderView();
      clearFilePreview("檔案已刪除。");
    } catch (error) { showToast("刪除失敗：" + error.message); }
  };
  $("file-preview-editor").onsubmit = async (event) => {
    event.preventDefault();
    const save = $("preview-file-save");
    const nextFilename = $("preview-file-name").value.trim();
    if (!nextFilename) return showToast("檔案名稱不可空白");
    save.disabled = true;
    save.textContent = "儲存中…";
    try {
      if (nextFilename !== attachment.filename) await api(`/attachments/${attachmentId}`, { method: "PUT", body: JSON.stringify({ filename: nextFilename }) });
      const nextNote = $("preview-file-note").value.trim();
      if (nextNote !== note) await api(`/attachments/${attachmentId}/note`, { method: "PUT", body: JSON.stringify({ note: nextNote }) });
      if (!categorySelect.disabled) await api(`/attachments/${attachmentId}/category`, { method: "PUT", body: JSON.stringify({ category: categorySelect.value }) });
      const index = $("preview-file-index");
      if (index.value.trim() !== initialIndexText) {
        await api(`/attachments/${attachmentId}`, { method: "PUT", body: JSON.stringify({ ocr_text: index.value.trim() }) });
      }
      showToast("檔案資料已儲存");
      await refreshFolderView();
      const refreshed = await attachmentWithText(entryId, attachmentId);
      await showFilePreview({ entryId, attachmentId, filename: refreshed.attachment.filename, key: refreshed.attachment.key,
        mime: refreshed.attachment.mime, kind: refreshed.attachment.kind });
    } catch (error) {
      showToast("儲存失敗：" + error.message);
      save.disabled = false;
      save.textContent = "儲存";
    }
  };
}

async function fetchTextPreview(url, maxChars) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body?.getReader) {
    const text = await response.text();
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (text.length <= maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) { truncated = true; break; }
    }
    text += decoder.decode();
  } finally {
    if (truncated) await reader.cancel();
  }
  return { text: text.slice(0, maxChars), truncated };
}

const PREVIEW_WIDTH_KEY = "fieldlog_preview_width";
const PREVIEW_WIDTH_MIN = 280;
const PREVIEW_MAIN_MIN = 480;

function syncPreviewLayout() {
  const workspace = document.querySelector(".folder-workspace");
  const button = $("btn-toggle-preview");
  if (!workspace || !button) return;
  PREVIEW_ENABLED = true;
  workspace.classList.remove("preview-off");
  button.classList.toggle("active", PREVIEW_ENABLED);
  button.textContent = PREVIEW_ENABLED ? "▣ 預覽：開" : "□ 預覽：關";
  button.setAttribute("aria-pressed", PREVIEW_ENABLED ? "true" : "false");
}

function clampPreviewWidth(width) {
  const workspace = document.querySelector(".folder-workspace");
  const available = workspace?.getBoundingClientRect().width || window.innerWidth;
  const max = Math.max(PREVIEW_WIDTH_MIN, available - PREVIEW_MAIN_MIN - 8);
  return Math.min(max, Math.max(PREVIEW_WIDTH_MIN, width));
}

function setPreviewWidth(width, persist = false) {
  const clamped = clampPreviewWidth(width);
  document.documentElement.style.setProperty("--preview-width", `${clamped}px`);
  if (persist) localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(clamped)));
}

function initPreviewLayout() {
  const handle = $("folder-preview-resize");
  const button = $("btn-toggle-preview");
  if (!handle || !button) return;
  localStorage.setItem("fieldlog_preview_enabled", "1");
  button.hidden = true;
  const saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  if (saved) setPreviewWidth(saved);
  syncPreviewLayout();
  button.onclick = null;
  handle.addEventListener("pointerdown", (event) => {
    if (!PREVIEW_ENABLED) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("preview-resizing");
    const workspace = document.querySelector(".folder-workspace");
    const onMove = (moveEvent) => setPreviewWidth(workspace.getBoundingClientRect().right - moveEvent.clientX);
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("preview-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--preview-width"), 10);
      if (current) setPreviewWidth(current, true);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
  handle.addEventListener("keydown", (event) => {
    if (!PREVIEW_ENABLED || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--preview-width"), 10) || 400;
    setPreviewWidth(current + (event.key === "ArrowLeft" ? 16 : -16), true);
  });
  window.addEventListener("resize", () => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--preview-width"), 10) || 400;
    setPreviewWidth(current);
  });
}

function hasAttachmentDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("application/x-fieldlog-attachment");
}

function hasEntryDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("application/x-fieldlog-entry");
}

/**
 * 子資料夾卡片當放置目標：把檔案或已分類記事拖進去就搬過去。
 *
 * entry 266：這裡原本只接檔案（application/x-fieldlog-attachment），記事
 * （筆記／多檔案記事）拖上來完全沒反應——根本原因是「子資料夾建立時間比
 * 記事晚」：記事還在待分類或上層資料夾時拖到首頁清單能移動，但一旦子資料夾
 * 是後來才在這個資料夾內頁建的，使用者只能在這裡看到它，這裡卻沒接
 * application/x-fieldlog-entry，於是卡住、只能請人手動搬。跟檔案共用同一張
 * 卡片當落點，兩種 payload 分開判斷、分開處理。
 */
function bindFolderDropTargets() {
  document.querySelectorAll(".child-folder-card[data-id]").forEach((card) => {
    card.ondragover = (event) => {
      if (!hasAttachmentDrag(event) && !hasEntryDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      card.classList.add("file-drop-target");
    };
    card.ondragleave = () => card.classList.remove("file-drop-target");
    card.ondrop = async (event) => {
      if (!hasAttachmentDrag(event) && !hasEntryDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove("file-drop-target");
      const targetId = Number(card.dataset.id || 0);
      const targetName = card.querySelector("strong")?.textContent?.trim() || "子資料夾";
      if (!targetId) return;
      if (hasEntryDrag(event)) {
        const entryId = Number(event.dataTransfer.getData("application/x-fieldlog-entry"));
        const prevFolder = event.dataTransfer.getData("application/x-fieldlog-entry-folder");
        if (!entryId) return;
        await moveInboxEntry(entryId, targetId, prevFolder ? Number(prevFolder) : null);
        return;
      }
      let payload;
      try {
        payload = JSON.parse(event.dataTransfer.getData("application/x-fieldlog-attachment"));
      } catch {
        showToast("無法讀取拖曳的檔案");
        return;
      }
      if (!payload?.attachmentId) return;
      if (!confirm(`將「${payload.filename}」移入「${targetName}」？`)) return;
      try {
        await api(`/attachments/${payload.attachmentId}/move`, {
          method: "POST",
          body: JSON.stringify({ folder_id: targetId }),
        });
        showToast(`已移入「${targetName}」`);
        await refreshFolderView();
      } catch (error) {
        showToast("移動失敗：" + error.message);
      }
    };
  });
}

function setInnerFolderView(view) {
  INNER_FOLDER_VIEW = view;
  localStorage.setItem("fieldlog_inner_folder_view", view);
  if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id);
}

async function loadTrash() {
  const data = await api("/trash");
  const items = data.items || [];
  $("desktop-trash-count").textContent = items.length ? String(items.length) : "";
  $("trash-list").innerHTML = items.length ? items.map((item) => {
    const counts = [item.folder_count ? `${item.folder_count} 個資料夾` : "", item.entry_count ? `${item.entry_count} 筆紀錄` : "", item.attachment_count ? `${item.attachment_count} 個附件` : ""].filter(Boolean).join("｜");
    const daysLeft = Math.max(0, Math.ceil((new Date(item.purge_after).getTime() - Date.now()) / 86400000));
    return `<div class="trash-row" data-id="${item.id}" data-type="${item.item_type}">
      <span class="trash-row-icon">${item.item_type === "folder" ? "📁" : "📦"}</span>
      <span class="trash-row-main"><strong>${esc(item.title || "（未命名）")}</strong><small>${counts || "空資料包"}｜${daysLeft} 天後永久刪除</small></span>
      <button class="btn small trash-restore" type="button">還原</button>
      <button class="btn small danger trash-delete" type="button">永久刪除</button>
    </div>`;
  }).join("") : `<p class="sub">垃圾桶是空的。</p>`;
  $("trash-list").querySelectorAll(".trash-row").forEach((row) => {
    row.querySelector(".trash-restore").onclick = async () => {
      try {
        await api(`/trash/${row.dataset.id}/restore`, { method: "POST", body: "{}" });
        showToast("已還原"); await Promise.all([loadTrash(), loadFolders(), loadRecent()]);
      } catch (error) {
        if (!error.message.includes("請選擇新的還原位置")) { showToast("還原失敗：" + error.message); return; }
        const picked = await openFolderPicker({
          title: "選擇還原位置",
          desc: "原本的上層已不存在，請選一個新的位置。",
          allowInbox: true,
          rootLabel: row.dataset.type === "folder" ? "最上層" : "待分類",
        });
        if (!picked) return;
        const destination = row.dataset.type === "folder"
          ? { parent_folder_id: picked.id }
          : { folder_id: picked.id };
        try {
          await api(`/trash/${row.dataset.id}/restore`, { method: "POST", body: JSON.stringify(destination) });
          showToast("已還原到新位置"); await Promise.all([loadTrash(), loadFolders(), loadRecent()]);
        } catch (retryError) { showToast("還原失敗：" + retryError.message); }
      }
    };
    row.querySelector(".trash-delete").onclick = async () => {
      const name = row.querySelector("strong").textContent;
      if (!confirm(`永久刪除「${name}」及其中全部內容？\n\n這次無法復原。`)) return;
      try { await api(`/trash/${row.dataset.id}`, { method: "DELETE" }); showToast("已永久刪除"); await loadTrash(); }
      catch (error) { showToast("永久刪除失敗：" + error.message); }
    };
  });
}

async function openTrash() {
  return withViewLoading("正在載入垃圾桶…", async () => {
  $("desktop-pending")?.classList.remove("active");
  $("desktop-trash")?.classList.add("active");
  $("trash-overlay").classList.add("open");
  await loadTrash().catch((error) => { $("trash-list").innerHTML = `<p class="sub">載入失敗：${esc(error.message)}</p>`; });
  });
}

async function openPendingFromDesktop() {
  return withViewLoading("正在載入待分類…", async () => {
    await Promise.all([loadFolders(), loadRecent()]);
    $("desktop-pending")?.classList.add("active");
    $("desktop-trash")?.classList.remove("active");
    CURRENT_FOLDER = null;
    $("view-folder").style.display = "none";
    $("view-home").style.display = "block";
    $("inbox-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function backHome() {
  if (CURRENT_FOLDER?.parent_id) return openFolder(CURRENT_FOLDER.parent_id);
  return withViewLoading("正在載入首頁…", async () => {
    await Promise.all([loadFolders(), loadRecent()]);
    CURRENT_FOLDER = null;
    $("view-folder").style.display = "none";
    $("view-home").style.display = "block";
  });
}

// ---------- 紀錄 ----------
async function createEntry(folderId, title) {
  const r = await api("/entries", { method: "POST", body: JSON.stringify({ folder_id: folderId, title }) });
  return r.id;
}

async function openCurrentWeeklyReport() {
  const button = $("btn-weekly-report");
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = "⏳<span>建立中…</span>";
  try {
    const report = await api("/weekly-reports/current", { method: "POST" });
    await loadFolders();
    CURRENT_FOLDER = FOLDERS.find((folder) => Number(folder.id) === Number(report.folder_id)) || null;
    await openEntry(report.id);
  } catch (error) {
    showToast("開啟週報失敗：" + error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

// 打字沒有「錄影錄到一半」的時間壓力，所以寫完可以選位置；取消就留在待分類。
function quickNote() {
  openEditModal({
    title: "快速備忘（先存入待分類，之後可選擇資料夾）",
    value: "",
    onSave: async (text) => {
      if (!text) return;
      // 先落地再問位置：文字永遠先存入待分類，
      // 選擇器等編輯框關掉之後才開——編輯框的 z-index 比它高，同時開會被壓住看不見。
      const folderId = CURRENT_FOLDER ? CURRENT_FOLDER.id : await stagingFolderId();
      const created = await api("/entries", {
        method: "POST",
        body: JSON.stringify({ folder_id: folderId, title: text.slice(0, 30), body: text }),
      });
      await Promise.all([loadFolders(), loadRecent()]);
      if (CURRENT_FOLDER) { showToast("已存入這個資料夾"); return; }
      setTimeout(() => askQuickNoteFolder(Number(created.id)), 0);
    },
  });
}

/** 快速備忘存好之後詢問位置；不選就留在待分類。 */
async function askQuickNoteFolder(entryId) {
  const picked = await openFolderPicker({
    title: "這則備忘放哪裡？",
    desc: `選一個資料夾就移入；按取消會留在「⏳ 待分類」。`,
    currentId: STAGING_FOLDER_ID,
    allowInbox: false,
  });
  if (!picked?.id) { showToast("已存入待分類"); return; }
  try {
    await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: picked.id }) });
    showToast(`已存入「${FOLDERS.find((f) => f.id === picked.id)?.name || "資料夾"}」`);
    await Promise.all([loadFolders(), loadRecent()]);
  } catch (err) { showToast("分類失敗：" + err.message); }
}

async function createReadOnlyShare(entryId, attachmentId = null) {
  const daysRaw = prompt("分享幾天後到期？請輸入 1～30 天", "7");
  if (daysRaw === null) return;
  const expiresDays = Math.min(Math.max(Number(daysRaw) || 7, 1), 30);
  const allowAttachments = attachmentId ? true : confirm("是否包含這筆資料的附件？\n按「取消」只分享文字內容。");
  const allowDownload = allowAttachments && confirm("是否允許附件下載？\n建議按「取消」，只提供線上預覽。");
  const result = await api("/shares", {
    method: "POST",
    body: JSON.stringify({ entry_id: entryId, attachment_id: attachmentId, expires_days: expiresDays, allow_attachments: allowAttachments, allow_download: allowDownload }),
  });
  try { await navigator.clipboard.writeText(result.url); } catch { /* 非安全環境時仍用提示框顯示 */ }
  prompt(`唯讀分享已建立，${expiresDays} 天後到期。\n連結已嘗試複製；需要時可在這裡再複製：`, result.url);
}

async function openEntry(id) {
  // 從單一檔案詳情觸發的重新開啟（存檔、AI 整理完成）要停在同一份檔案上，
  // 不要跳回整筆記事——否則使用者每整理一次就被彈回上一層
  const entryId = Number(id || 0);
  if (usesDesktopRightPane()) return showEntryEditor(entryId);
  if (FOCUSED_FILE && FOCUSED_FILE.entryId === entryId) {
    return openFileDetail(FOCUSED_FILE.entryId, FOCUSED_FILE.attachmentId);
  }
  return withViewLoading("正在載入紀錄…", async () => {
  const e = await api(`/entries/${id}`);
  // 上傳失敗的錄音會先留在瀏覽器 IndexedDB；以前這批檔案完全不會顯示，
  // 使用者只看得到空記事，以為錄音已遺失。即使還沒進 R2，也要把待補傳狀態
  // 顯示在同一筆記事的附件區，才能清楚知道檔案目前在哪裡。
  const pendingUploads = await pendingFilesForEntry(entryId);
  // Tier 2 會把 PDF 每頁轉成圖檔供 OCR 使用；這些是處理用的衍生附件，
  // 不逐張顯示在附件清單，避免數十頁 PDF 產生大量縮圖。處理進度仍顯示在來源 PDF 上。
  const visibleAttachments = (e.attachments || []).filter((a) => !a.source_pdf_id);
  const folder = e.folder_id ? FOLDERS.find((f) => f.id === e.folder_id) : null;
  const template = templateFor(folder ? folder.type : "其他");
  const fields = JSON.parse(e.fields_json || "{}");
  const isWeeklyReport = fields._kind === "weekly_report";
  // 來源同步管理的記事（fields_json._sid／litdb_id 有值）永遠鎖在純文字：
  // sync.js 用 <!-- sync:start/end --> 這組純文字標記圈出管理區，換成富文字
  // 編輯器很容易在瀏覽器序列化時弄丟標記，下次同步會整段覆蓋掉使用者手動
  // 加的備註，所以這類記事不給升級入口。
  const isSynced = !!(fields._sid || fields.litdb_id);
  // 記事內文只有一種編輯方式：富文字。不再有「純文字 vs 富文字」兩種格式、
  // 也不用手動按「升級為富文字」——舊的純文字記事打開時就直接以富文字編輯，
  // 存檔時一併轉成 html（storedAsText 就是在標記這件事）。
  // 唯一的例外是來源同步管理的記事：它的 body 夾著 <!-- sync:start/end --> 標記，
  // 富文字存檔會把註解清掉，下次同步就會整段覆蓋掉使用者手寫的備註（見
  // src/lib/sync.js）。那類記事維持純文字編輯框。
  const bodyFormat = isSynced ? "text" : "html";
  const storedAsText = e.body_format !== "html";
  const weeklyReportSection = `<section class="weekly-report-editor">
      <div class="weekly-report-meta"><strong>${esc(fields["週次"] || "週報")}</strong><span>${esc(fields["期間"] || "")}</span></div>
      <label for="weekly-long-term">一、本部門中長期（六個月以上）規劃（課長級及以上主管－含副總）</label>
      <textarea id="weekly-long-term" class="weekly-report-textarea fixed" readonly>${esc(fields["中長期規劃"] || "")}</textarea>
      <p class="sub">固定範本，不會由 Claude 或一般存檔流程改寫。</p>
      <label for="weekly-current">二、本週工作報告</label>
      <textarea id="weekly-current" class="e-field weekly-report-textarea current" data-key="本週工作報告" placeholder="可自行填寫，或請 Claude MCP 整理後寫入。">${esc(fields["本週工作報告"] || "")}</textarea>
      <label for="weekly-next">三、下週重要工作計畫</label>
      <textarea id="weekly-next" class="e-field weekly-report-textarea" data-key="下週重要工作計畫" placeholder="保留給你自行填寫。">${esc(fields["下週重要工作計畫"] || "")}</textarea>
    </section>`;
  const bodySection = isWeeklyReport ? weeklyReportSection : bodyFormat === "html"
    ? `<div class="field-label-row"><label>內文／速記</label></div>
       <div id="e-body-rich" class="rich-editor"></div>`
    : `<div class="field-label-row">
        <label for="e-body">內文／速記</label>
        <span class="body-format-actions">
          <span class="sub" title="這筆記事的內文由外部來源同步管理，改成富文字會弄丟同步標記">🔒 來源同步管理</span>
          <button class="btn small ghost" id="e-body-expand" type="button" title="全螢幕編輯，字體大小可調">⤢ 展開編輯</button>
        </span>
      </div>
      <textarea id="e-body">${esc(e.body)}</textarea>`;
  const mergedTranscript = (e.attachments || [])
    .filter((a) => a.kind === "audio" && (a.transcript || "").trim())
    .sort((a, b) => (a.offset_secs ?? 0) - (b.offset_secs ?? 0) || a.id - b.id)
    .map((a) => `【${fmtSecs(a.offset_secs ?? 0)}｜${a.filename}】\n${a.transcript.trim()}`)
    .join("\n\n");
  const modal = $("entry-modal");
  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="e-close" type="button" aria-label="關閉記事" title="關閉記事">✕</button></div>
    <div class="detail-head">
      <input id="e-title" class="title-input" value="${esc(e.title)}" placeholder="標題" />
    </div>
    <p class="sub">${esc(localDateTime(e.created_at))}｜${folder ? esc(folder.name) : "⏳ 待分類"}</p>
    <section class="merged-transcript ${mergedTranscript ? "" : "empty"}">
      <div><strong>📝 合併逐字稿</strong><button class="btn small" id="e-copy-transcript" type="button" ${mergedTranscript ? "" : "disabled"}>複製</button></div>
      ${mergedTranscript
        ? `<details class="ai-fold"><summary>展開逐字稿全文（${mergedTranscript.length} 字，AI 轉錄）</summary><pre>${esc(mergedTranscript)}</pre></details>`
        : `<p class="sub" id="e-auto-status">新錄音會在每日免費額度內自動轉錄並合併；舊錄音請使用下方「Cloudflare AI 整理」。</p>`}
      ${mergedTranscript ? `<p class="sub" id="e-auto-status">正在檢查是否有新的安全轉錄項目…</p>` : ""}
    </section>
    <!-- 已分類的記事也要能再搬，所以這一列不只給待分類內容看。 -->
    <div class="archive-row">
      <label>位置：</label>
      <span class="archive-current" id="e-folder-path">${folder ? esc(folderPathOf(folder).join(" ／ ")) : "⏳ 待分類"}</span>
      <button class="btn small" id="e-move" type="button">📂 移動…</button>
    </div>
    ${(e.children || []).length ? `<section class="entry-children"><h3 class="section-title">內含紀錄資料包</h3>
      <div class="child-folder-list list-view">${e.children.map((child) => `<div class="record-group-card entry-child-card" draggable="true" data-id="${child.id}">
        <span>📁</span><strong>${esc(child.title || "（未命名）")}</strong>
        <small>📎${child.att_count || 0}${child.child_count ? `｜${child.child_count} 個子資料包` : ""}</small>
      </div>`).join("")}</div></section>` : ""}
    ${isWeeklyReport ? "" : template.map((k) => `<label>${esc(k)}</label><input class="e-field" data-key="${esc(k)}" value="${esc(fields[k] || "")}" />`).join("")}
    ${bodySection}
    <div class="modal-actions"><button class="btn primary" id="e-save">儲存</button><button class="btn" id="e-share" type="button">🔗 唯讀分享</button></div>
    <hr/>
    <h3 class="section-title">附件</h3>
    <div class="upload-row">
      <button class="btn small capture-btn" id="e-video">🎥 錄影</button>
      <button class="btn small capture-btn" id="e-photo">📷 拍照</button>
      <button class="btn small capture-btn" id="e-audio">🎙 錄音</button>
      <label class="btn small upload-btn">📁 上傳<input type="file" id="e-file" accept="image/*,video/*,audio/*,application/pdf,.docx,.xlsx,.pptx,.txt,.md,.csv" multiple hidden /></label>
      <button class="btn small" id="e-process" type="button" title="用 Cloudflare AI 把還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取（已處理過的不會重跑）">🪄 Cloudflare AI 整理</button>
      <button class="btn small" id="e-rename-files" type="button" title="利用既有 OCR、逐字稿與記事資訊整理全部舊附件名稱，不會重新呼叫 AI">🏷 整理舊檔名</button>
      <span id="e-upload-status" class="sub"></span>
    </div>
    ${pendingUploads.length ? `<div class="pending-upload-notice">
      <strong>⏳ ${pendingUploads.length} 個檔案暫存在這台電腦，尚未補傳完成</strong>
      <span class="sub">請保留目前瀏覽器資料；補傳完成前不要清除網站資料。</span>
      <button class="btn small" id="e-sync-pending" type="button">立即補傳</button>
    </div>` : ""}
    <div id="e-attachments" class="att-list">${visibleAttachments.map((a) => attHtml(a, e.attachments)).join("") || (pendingUploads.length ? `<p class="sub">伺服器上尚無附件；上方檔案仍保存在本機。</p>` : `<p class="sub">尚無附件</p>`)}</div>
    <hr/>
    <h3 class="section-title">關聯 <button class="btn small" id="e-add-relation" type="button" title="關聯到另一筆記事，例如這次實驗引用的標準、對照的廠商產品">🔗 新增關聯</button></h3>
    <div id="e-relations"><p class="sub">載入中…</p></div>
    <hr/>
    <!-- AI 處理的背景資訊（來源、AI 動過哪裡、操作履歷、原始資料列）預設收合：
         這些是「要查的時候才看」的稽核資料，攤開來會把真正在寫的內容擠到畫面外 -->
    <details class="ai-fold prov-fold">
      <summary class="section-title">🔍 這筆資料的來歷（AI 處理與操作紀錄）</summary>
      <div id="e-provenance"><p class="sub">載入中…</p></div>
    </details>
    <div class="entry-danger-zone">
      <button class="btn entry-delete" id="e-delete" type="button">🗑 刪除整筆記事</button>
      <p class="sub">整個資料包會移到垃圾桶，保留 60 天。</p>
    </div>
  `;
  $("entry-overlay").classList.add("open");
  lockBodyScroll();
  $("e-close").onclick = closeEntry;
  $("e-share").onclick = () => createReadOnlyShare(entryId).catch((error) => showToast("分享失敗：" + error.message));
  modal.querySelectorAll(".entry-child-card").forEach((card) => {
    card.onclick = () => openEntry(Number(card.dataset.id));
    card.ondragover = (event) => {
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry") && !types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = types.includes("application/x-fieldlog-entry") ? "move" : "copy";
      card.classList.add("file-drop-target");
    };
    card.ondragleave = () => card.classList.remove("file-drop-target");
    card.ondrop = (event) => {
      event.preventDefault(); event.stopPropagation(); card.classList.remove("file-drop-target");
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("application/x-fieldlog-entry")) {
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) uploadFiles(Number(card.dataset.id), files);
        return;
      }
      const sourceId = Number(event.dataTransfer.getData("application/x-fieldlog-entry"));
      if (sourceId && sourceId !== Number(card.dataset.id)) nestEntry(sourceId, Number(card.dataset.id));
    };
    card.ondragstart = (event) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-fieldlog-entry", String(card.dataset.id));
    };
  });
  $("e-copy-transcript").onclick = async () => {
    if (!mergedTranscript) return;
    await navigator.clipboard.writeText(mergedTranscript);
    showToast("已複製合併逐字稿");
  };
  $("e-delete").onclick = async () => {
    const childCount = (e.children || []).length;
    if (!confirm(`將「${e.title || "（未命名）"}」整個資料包移到垃圾桶？${childCount ? `\n\n內含的 ${childCount} 個子資料包也會一起移入。` : ""}\n垃圾桶保留 60 天。`)) return;
    try {
      await api(`/entries/${id}`, { method: "DELETE" });
      showToast("已移到垃圾桶");
      closeEntry();
      if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadRecent(); loadFolders(); }
    } catch (err) { showToast("刪除失敗：" + err.message); }
  };
  if (isWeeklyReport) {
    // 週報使用三段固定表單，不載入一般富文字編輯器。
  } else if (bodyFormat === "html") {
    // 還存成純文字的舊記事：載進編輯器前先轉成 HTML 段落，使用者看到的內容
    // 不變（換行、空行都保留），存檔時才真的寫回 body_format='html'
    const initialHtml = storedAsText ? textToHtmlForEditor(e.body || "") : (e.body || "");
    window.fieldlogRichEditor?.init($("e-body-rich"), injectFilePinForDisplay(initialHtml), {
      onImagePaste: (file) => insertFilesIntoRichEditor(id, $("e-body-rich"), [file]),
    });
  } else {
    $("e-body-expand").onclick = () => {
      openEditModal({
        title: "內文／速記",
        value: $("e-body").value,
        onSave: async (text) => { $("e-body").value = text; },
      });
    };
  }
  // 移動不即時送出，跟著「儲存」一起走：正在編輯內文時被強制存檔／重整，
  // 未存的字就沒了。undefined＝這次沒改位置。
  let pendingFolderId;
  $("e-move").onclick = async () => {
    const picked = await openFolderPicker({
      title: "移動記事",
      desc: "選一個資料夾（四層都可以選），或移回待分類。按下方「儲存」才會生效。",
      currentId: pendingFolderId !== undefined ? pendingFolderId : (e.folder_id || null),
      allowInbox: true,
    });
    if (!picked) return;
    pendingFolderId = picked.id;
    const target = picked.id ? FOLDERS.find((f) => f.id === picked.id) : null;
    $("e-folder-path").textContent = target
      ? `${folderPathOf(target).join(" ／ ")}（按儲存才生效）`
      : "⏳ 待分類（按儲存才生效）";
  };
  $("e-save").onclick = async () => {
    const newFields = isWeeklyReport ? {
      _kind: "weekly_report",
      "週次": fields["週次"] || "",
      "期間": fields["期間"] || "",
      "中長期規劃": fields["中長期規劃"] || "",
    } : {};
    modal.querySelectorAll(".e-field").forEach((i) => { newFields[i.dataset.key] = i.value.trim(); });
    const bodyValue = isWeeklyReport
      ? [
          `週次：${fields["週次"] || ""}`,
          `期間：${fields["期間"] || ""}`,
          "", "一、本部門中長期（六個月以上）規劃（課長級及以上主管－含副總）", newFields["中長期規劃"] || "",
          "", "二、本週工作報告", newFields["本週工作報告"] || "",
          "", "三、下週重要工作計畫", newFields["下週重要工作計畫"] || "",
        ].join("\n").trim()
      : bodyFormat === "html"
        ? stripFilePinForSave(window.fieldlogRichEditor?.getHtml($("e-body-rich")) || "")
        : $("e-body").value.trim();
    const patch = { title: $("e-title").value.trim(), body: bodyValue, fields: newFields };
    if (isWeeklyReport) patch.body_format = "text";
    // 舊記事第一次存檔時順手把格式定下來，不用使用者自己按升級。
    // 同步管理的記事不送 body_format，維持 text（後端也有第二道防線會擋）。
    if (!isWeeklyReport && bodyFormat === "html" && storedAsText) patch.body_format = "html";
    if (pendingFolderId !== undefined) patch.folder_id = pendingFolderId;
    await api(`/entries/${id}`, { method: "PUT", body: JSON.stringify(patch) });
    showToast("已儲存");
    closeEntry();
    if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadRecent(); loadFolders(); }
  };
  // 錄影／拍照要開全螢幕鏡頭預覽，跟詳情頁沒辦法同時顯示，關掉合理
  // （結束後 finishPhoto／onVideoSegmentStop 會自動 openEntry 帶你回來）。
  // 錄音不需要畫面、只是背景跑的浮動小工具（z-index 高於詳情頁），
  // 沒有理由把整頁關掉——按下去卻整個畫面跳走，讓人搞不清楚錄音到底
  // 有沒有接對這一筆，也是這次要修的「除了打叉不要自動關掉」。
  $("e-video").onclick = () => { closeEntry(); startVideo(id); };
  $("e-photo").onclick = () => { closeEntry(); startPhoto(id); };
  $("e-audio").onclick = () => startAudio(id);
  const fileInput = $("e-file");
  fileInput.onchange = () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    uploadFiles(id, files);
  };
  setupFileDropZone($("entry-modal"), (files) => uploadFiles(id, files));
  if (!isWeeklyReport && bodyFormat === "html") setupRichImageDropZone($("e-body-rich"), id);
  const processBtn = $("e-process");
  if (processBtn) processBtn.onclick = () => processEntryAttachments(id, processBtn);
  const syncPendingBtn = $("e-sync-pending");
  if (syncPendingBtn) syncPendingBtn.onclick = async () => {
    syncPendingBtn.disabled = true;
    syncPendingBtn.textContent = "補傳中…";
    const result = await syncPendingFiles({ entryId });
    if (result.synced) {
      showToast(`已補傳 ${result.synced} 個檔案`);
      openEntry(entryId);
      return;
    }
    showToast(result.error ? `補傳失敗：${result.error}` : "目前仍無法補傳，檔案繼續保存在本機");
    syncPendingBtn.disabled = false;
    syncPendingBtn.textContent = "立即補傳";
  };
  const renameBtn = $("e-rename-files");
  if (renameBtn) renameBtn.onclick = async () => {
    if (!confirm("確定整理全部舊附件的檔名？只會改能安全判定的名稱，原始檔名仍會保留。")) return;
    renameBtn.disabled = true;
    renameBtn.textContent = "整理中…";
    try {
      const result = await api("/attachments/rename-existing", { method: "POST", body: "{}" });
      showToast(`已檢查 ${result.checked} 個舊附件，重新命名 ${result.renamed} 個`);
      openEntry(id);
    } catch (err) {
      showToast("整理舊檔名失敗：" + err.message);
      renameBtn.disabled = false;
      renameBtn.textContent = "🏷 整理舊檔名";
    }
  };
  bindAttActions(id);
  loadRelations(id);
  // 預設收合，所以連履歷 API 都等到真的展開才打——關著的區塊沒有理由先花一趟往返
  const provFold = modal.querySelector(".prov-fold");
  if (provFold) {
    provFold.addEventListener("toggle", () => {
      if (!provFold.open || provFold.dataset.loaded) return;
      provFold.dataset.loaded = "1";
      loadProvenance(e);
    });
  }
  $("e-add-relation").onclick = () => openRelationPicker(id, () => loadRelations(id));
  api(`/entries/${id}/auto-transcribe`, { method: "POST", body: "{}" }).then((r) => {
    if (r.processed) {
      showToast(`已安全自動轉錄 ${r.processed} 段`);
      openEntry(id);
      return;
    }
    const status = $("e-auto-status");
    if (status && r.reason) status.textContent = r.reason;
  }).catch((err) => {
    const status = $("e-auto-status");
    if (status) status.textContent = `自動轉錄未執行：${err.message}`;
  });
  });
}

/**
 * 把一批檔案直接上傳到目前資料夾——每個檔案自成一筆記事。
 * 重複檔（後端以 SHA-256 判定）會被略過，並把剛建的空記事收掉，
 * 不留下「有記事但沒檔案」的殘骸。
 */
async function uploadStandaloneFiles(files, folderId, { button = null, destination = "" } = {}) {
  if (!files || !files.length) return;

  const label = button?.textContent || "";
  if (button) button.disabled = true;
  let uploaded = 0;
  let duplicates = 0;
  let failed = 0;

  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (button) button.textContent = `上傳中 ${index + 1}/${files.length}`;
      if (file.size > 50 * 1024 * 1024) {
        failed++;
        showToast(`${file.name} 超過 50MB，已略過`);
        continue;
      }
      let entryId = 0;
      try {
        const rawName = String(file.name || "上傳檔案");
        const dotIndex = rawName.lastIndexOf(".");
        const title = dotIndex > 0 ? rawName.slice(0, dotIndex) : rawName;
        entryId = Number(await createEntry(folderId, title));
        const result = await putFile(entryId, file, file.name, null);
        if (result && result.duplicate) {
          duplicates++;
          await api(`/entries/${entryId}`, { method: "DELETE" }).catch(() => {});
        } else {
          uploaded++;
        }
      } catch (error) {
        failed++;
        if (entryId) await api(`/entries/${entryId}`, { method: "DELETE" }).catch(() => {});
        console.error(`檔案上傳失敗 [${file.name}]`, error);
      }
    }
    const parts = [`已加入 ${uploaded} 個檔案${destination ? `到${destination}` : ""}`];
    if (duplicates) parts.push(`略過 ${duplicates} 個重複檔`);
    if (failed) parts.push(`${failed} 個失敗`);
    showToast(parts.join("，"));
    await Promise.all([loadFolders(), loadRecent()]);
    if (CURRENT_FOLDER && Number(CURRENT_FOLDER.id) === Number(folderId)) await openFolder(Number(folderId));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/** 按工具列選檔是明確指定目前資料夾，維持直接放入目前位置。 */
async function uploadFilesToFolder(files) {
  if (!CURRENT_FOLDER) return;
  await uploadStandaloneFiles(files, Number(CURRENT_FOLDER.id), {
    button: $("btn-folder-upload-file"),
    destination: `「${CURRENT_FOLDER.name}」`,
  });
}

/** 外部檔案放在資料夾頁就直接歸入目前資料夾；首頁放下才進待分類。 */
async function uploadDroppedFilesToCurrentLocation(files) {
  if (CURRENT_FOLDER) {
    await uploadStandaloneFiles(files, Number(CURRENT_FOLDER.id), {
      destination: `「${CURRENT_FOLDER.name}」`,
    });
    return;
  }
  const folderId = await stagingFolderId();
  await uploadStandaloneFiles(files, folderId, { destination: "「待分類」" });
}

// ---------- 管理分類 ----------
// 分類清單存在資料庫（categories 表），這個畫面就是它的維護介面：
// 新增、改名、刪除都在這裡做完，不用改程式碼也不用重新部署。
let FILE_CATEGORY_REFRESH = null; // 檔案詳情頁開著時，改完分類要順手刷新那邊的下拉

function categoryManagerRows(kind) {
  const list = CATEGORIES[kind] || [];
  if (!list.length) return `<p class="sub">目前沒有分類，用下面的欄位新增第一個。</p>`;
  const groups = kind === "device"
    ? [{ level: 0, label: "醫材分類" }]
    : [
      { level: 0, label: "通用（每一層都可以選）" },
      { level: 1, label: `第 1 層：${LEVEL_HINTS[1]}` },
      { level: 2, label: `第 2 層：${LEVEL_HINTS[2]}` },
      { level: 3, label: `第 3 層：${LEVEL_HINTS[3]}` },
      { level: 4, label: `第 4 層：${LEVEL_HINTS[4]}` },
    ];
  return groups.map((group) => {
    const items = list.filter((item) => item.level === group.level);
    if (!items.length) return "";
    return `<div class="cat-group">
      <h4>${esc(group.label)}</h4>
      ${items.map((item) => `
        <div class="cat-row" data-id="${item.id}">
          <span class="cat-icon">${esc(item.icon || "🗂️")}</span>
          <span class="cat-name">${esc(item.name)}${item.note ? `<small>${esc(item.note)}</small>` : ""}</span>
          <button class="btn small ghost cat-rename" type="button" data-id="${item.id}" data-name="${esc(item.name)}">改名</button>
          <button class="btn small ghost cat-delete" type="button" data-id="${item.id}" data-name="${esc(item.name)}">刪除</button>
        </div>`).join("")}
    </div>`;
  }).join("");
}

async function renderCategoryManager(kind) {
  return withViewLoading("正在載入分類…", async () => {
  await loadCategories();
  const body = $("category-manager-body");
  if (!body) return;
  const levelPicker = kind === "device" ? "" : `
    <label for="cat-new-level">放在哪一層</label>
    <select id="cat-new-level">
      <option value="0">通用（每一層都可以選）</option>
      <option value="1">第 1 層：${esc(LEVEL_HINTS[1])}</option>
      <option value="2">第 2 層：${esc(LEVEL_HINTS[2])}</option>
      <option value="3">第 3 層：${esc(LEVEL_HINTS[3])}</option>
      <option value="4">第 4 層：${esc(LEVEL_HINTS[4])}</option>
    </select>`;
  body.innerHTML = `
    <div class="cat-tabs">
      <button class="btn small ${kind === "folder_type" ? "primary" : ""}" type="button" data-kind="folder_type">📁 資料夾分類</button>
      <button class="btn small ${kind === "device" ? "primary" : ""}" type="button" data-kind="device">🏷 醫材分類</button>
    </div>
    <div class="cat-list">${categoryManagerRows(kind)}</div>
    <div class="cat-add">
      <h4>新增分類</h4>
      <label for="cat-new-name">分類名稱</label>
      <input id="cat-new-name" maxlength="60" placeholder="${kind === "device" ? "例如：導引導管" : "例如：抗菌導管產品線"}" />
      <label for="cat-new-icon">圖示（選填，一個表情符號）</label>
      <input id="cat-new-icon" maxlength="4" placeholder="🗂️" />
      <label for="cat-new-note">說明（選填）</label>
      <input id="cat-new-note" maxlength="120" placeholder="這個分類放什麼" />
      ${levelPicker}
      <button class="btn primary" id="cat-add-submit" type="button">＋ 新增</button>
    </div>
    <p class="sub">刪除分類只會拿掉「選項」，已經套用在資料夾或檔案上的分類文字會留著，不會被清空。改名則會同步更新既有資料。</p>
  `;

  body.querySelectorAll(".cat-tabs button").forEach((button) => {
    button.onclick = () => renderCategoryManager(button.dataset.kind);
  });

  body.querySelectorAll(".cat-rename").forEach((button) => {
    button.onclick = async () => {
      const next = prompt(`把「${button.dataset.name}」改成什麼名稱？`, button.dataset.name);
      if (next === null) return;
      const name = next.trim();
      if (!name || name === button.dataset.name) return;
      try {
        const result = await api(`/categories/${button.dataset.id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        showToast(result.renamed ? `已改名，同步更新 ${result.renamed} 筆既有資料` : "已改名");
        await renderCategoryManager(kind);
        await afterCategoryChange();
      } catch (error) {
        showToast("改名失敗：" + error.message);
      }
    };
  });

  body.querySelectorAll(".cat-delete").forEach((button) => {
    button.onclick = async () => {
      if (!confirm(`刪除分類「${button.dataset.name}」？\n\n只會拿掉這個選項，已經用這個分類的資料夾／檔案不會被改動。`)) return;
      try {
        const result = await api(`/categories/${button.dataset.id}`, { method: "DELETE" });
        showToast(result.still_used
          ? `已刪除選項；仍有 ${result.still_used} ${result.still_used_label}沿用這個分類名稱`
          : "分類已刪除");
        await renderCategoryManager(kind);
        await afterCategoryChange();
      } catch (error) {
        showToast("刪除失敗：" + error.message);
      }
    };
  });

  $("cat-add-submit").onclick = async () => {
    const name = $("cat-new-name").value.trim();
    if (!name) { showToast("請先填分類名稱"); return; }
    try {
      await api("/categories", {
        method: "POST",
        body: JSON.stringify({
          kind,
          name,
          icon: $("cat-new-icon").value.trim() || "🗂️",
          note: $("cat-new-note").value.trim(),
          level: kind === "device" ? 0 : Number($("cat-new-level")?.value || 0),
        }),
      });
      showToast(`已新增分類「${name}」`);
      await renderCategoryManager(kind);
      await afterCategoryChange();
    } catch (error) {
      showToast("新增失敗：" + error.message);
    }
  };
  });
}

// 分類改完之後，把正在顯示分類的地方一起更新，不用重新整理頁面
async function afterCategoryChange() {
  if (typeof FILE_CATEGORY_REFRESH === "function") await FILE_CATEGORY_REFRESH();
  if (CURRENT_FOLDER) renderChildFolders(CURRENT_FOLDER.id);
  else renderFolders();
}

function openCategoryManager(kind = "folder_type") {
  $("category-manager-overlay").classList.add("open");
  renderCategoryManager(kind);
}

function closeCategoryManager() {
  $("category-manager-overlay").classList.remove("open");
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// 關聯：這筆記事跟另一筆記事的關係（例：實驗引用標準、專利對照廠商產品）。
// 雙向都查得到——本記事是起點時箭頭朝右，是別人關聯過來的終點時箭頭朝左。
// ---------- 「這筆資料的來歷」面板 ----------
//
// 為什麼不是直接把 D1 的資料列倒出來：raw row 有一半是雜訊（key 是 R2 內部
// 路徑、content_hash 是 64 字 hex），看了不會更懂這筆資料。真正要回答的是
// 四個具體問題——這筆哪來的、誰改過、AI 動過哪裡、還跟外部來源同步嗎。
// 所以先用人看得懂的話講這四件事，真的想看原始欄位再展開最底下那一段。
//
// history 表從第一版就在寫，但一直沒有任何地方讀得到（等於白記）。這個面板
// 是它第一個讀取端——對專利／法規場景要的證據鏈來說，「誰在何時做了什麼」
// 是最基本的一環。

// 同步機制與匯入器寫在 fields_json 裡的內部欄位（前面加 _ 或是舊版識別碼）
const PROVENANCE_FIELD_LABELS = {
  _sid: "同步識別碼",
  _source_key: "來源代號",
  _content_hash: "內容指紋",
  _orphaned: "來源已移除",
  litdb_id: "舊版 litdb 識別碼",
  medtec_exhibitor_id: "Medtec 展商 id",
};

// 三態時間戳（transcribed_at／ocr_at／analysis_at）翻成人看得懂的狀態
function stateLabel(value) {
  if (!value) return { text: "尚未處理", cls: "prov-pending" };
  if (value === "skipped") return { text: "已判定不需處理", cls: "prov-skip" };
  if (value === "processing") return { text: "處理中", cls: "prov-pending" };
  if (value === "failed" || value === "auto_failed") return { text: "處理失敗", cls: "prov-warn" };
  return { text: `已完成 ${value}`, cls: "prov-ok" };
}

function provenanceOrigin(fields, history) {
  const sid = fields._sid || fields.litdb_id;
  if (sid) {
    const source = fields._source_key || String(sid).split(":")[0];
    return {
      title: `外部知識庫自動同步（來源：${source}）`,
      detail: "這筆的內容由每日排程從外部公開資料同步進來。同步只會改寫內文裡"
        + "「同步區」那一段，你自己在同步區之外加的註記不會被覆蓋。",
      warn: fields._orphaned
        ? "⚠ 這筆的原始資料已經從外部來源移除，之後不會再更新。記事本身保留，要不要刪由你決定。"
        : "",
    };
  }
  if (fields.medtec_exhibitor_id) {
    return { title: "從 Medtec 參展系統匯入", detail: "一次性匯入，之後不會自動更新。", warn: "" };
  }
  if (history.some((h) => (h.detail || "").includes("透過 MCP"))) {
    return { title: "透過 claude.ai／MCP 新增", detail: "在對話裡建立的，不是在 App 現場採集的。", warn: "" };
  }
  return { title: "在 App 裡建立", detail: "現場採集或手動新增。", warn: "" };
}

// raw 檢視用：超長的文字欄位只留開頭，否則一份 ISO 標準的 OCR 全文會把
// 整個面板撐爆。截斷一律明講長度，不靜默砍掉
function clipForRaw(row) {
  const LONG_KEYS = ["body", "transcript", "ocr_text", "analysis_json", "fields_json"];
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "attachments") continue;
    if (LONG_KEYS.includes(k) && typeof v === "string" && v.length > 400) {
      out[k] = `${v.slice(0, 400)}…（共 ${v.length} 字，此處僅顯示開頭）`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function loadProvenance(entry) {
  const box = $("e-provenance");
  if (!box) return; // modal 可能已經關閉（切換太快）

  let history = [];
  let historyError = "";
  try {
    history = (await api(`/entries/${entry.id}/history`)).history || [];
  } catch (err) {
    historyError = err.message;
  }

  let fields = {};
  try { fields = JSON.parse(entry.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
  const internal = Object.entries(fields).filter(([k]) => PROVENANCE_FIELD_LABELS[k] !== undefined);
  const origin = provenanceOrigin(fields, history);
  const atts = entry.attachments || [];

  const rows = [];
  rows.push(`<div class="prov-line"><span class="prov-key">來源</span><span>${esc(origin.title)}</span></div>`);
  rows.push(`<p class="sub prov-detail">${esc(origin.detail)}</p>`);
  if (origin.warn) rows.push(`<p class="prov-orphan">${esc(origin.warn)}</p>`);

  rows.push(`<div class="prov-line"><span class="prov-key">資料庫編號</span><span>entry ${entry.id}${entry.folder_id ? `／folder ${entry.folder_id}` : "（待分類）"}</span></div>`);
  rows.push(`<div class="prov-line"><span class="prov-key">建立</span><span>${esc(entry.created_at ? localDateTime(entry.created_at) : "—")}</span></div>`);
  rows.push(`<div class="prov-line"><span class="prov-key">最後更新</span><span>${esc(entry.updated_at ? localDateTime(entry.updated_at) : "未曾更新")}</span></div>`);

  for (const [k, v] of internal) {
    const shown = k === "_content_hash" ? `${String(v).slice(0, 12)}…` : String(v);
    rows.push(`<div class="prov-line"><span class="prov-key">${esc(PROVENANCE_FIELD_LABELS[k])}</span><span class="prov-mono">${esc(shown)}</span></div>`);
  }

  // AI 動過哪些地方——人工內容與 AI 產出必須分得清楚
  const aiRows = [];
  if (entry.analysis_at || entry.analysis_json) {
    const st = stateLabel(entry.analysis_at);
    aiRows.push(`<div class="prov-line"><span class="prov-key">深度解析</span><span class="${st.cls}">${esc(st.text)}${entry.analysis_model ? `｜模型 ${esc(entry.analysis_model)}` : ""}</span></div>`);
  }
  for (const a of atts) {
    const parts = [];
    if (a.kind === "audio" || a.transcript || a.transcribed_at) {
      const st = stateLabel(a.transcribed_at);
      parts.push(`轉文字：<span class="${st.cls}">${esc(st.text)}</span>`);
    }
    if (a.kind !== "audio" || a.ocr_text || a.ocr_at) {
      const st = stateLabel(a.ocr_at);
      parts.push(`擷取文字：<span class="${st.cls}">${esc(st.text)}</span>`);
    }
    if (a.analysis_at) {
      const st = stateLabel(a.analysis_at);
      parts.push(`深度解析：<span class="${st.cls}">${esc(st.text)}</span>`);
    }
    if (parts.length) {
      aiRows.push(`<div class="prov-line"><span class="prov-key">${esc(a.filename)}</span><span>${parts.join("｜")}</span></div>`);
    }
  }
  // AI 做過什麼、操作履歷各自再收一層：這兩段的長度跟附件數、操作次數成正比，
  // 一筆跑過深度處理的記事可以長到幾十行，攤開來就把「來源是什麼」這個真正
  // 常看的一行擠到看不見。摘要那一行先講結論，要細節再點開。
  const aiBlock = aiRows.length
    ? `<details class="ai-fold"><summary class="prov-sub">AI 對這筆做過什麼（${aiRows.length} 項）</summary>${aiRows.join("")}
       <p class="sub prov-detail">「已判定不需處理」代表跑過但沒有可擷取的內容（例如照片裡沒有文字），不是漏掉——所以不會被重複扣費。</p></details>`
    : `<h4 class="prov-sub">AI 對這筆做過什麼</h4><p class="sub">還沒有任何 AI 處理紀錄。</p>`;

  const historyBlock = historyError
    ? `<h4 class="prov-sub">操作履歷</h4><p class="sub">載入失敗：${esc(historyError)}</p>`
    : history.length
      ? `<details class="ai-fold"><summary class="prov-sub">操作履歷（${history.length} 筆，新到舊，只增不刪）</summary>
         <ul class="prov-history">${history.map((h) =>
           `<li><span class="prov-mono">${esc(localDateTime(h.created_at))}</span> <strong>${esc(h.action)}</strong>${h.detail ? `：${esc(h.detail)}` : ""}</li>`
         ).join("")}</ul></details>`
      : `<h4 class="prov-sub">操作履歷</h4><p class="sub">沒有履歷紀錄（這筆可能建立於履歷功能之前）。</p>`;

  const rawBlock = `
    <details class="prov-raw">
      <summary>原始資料列（Cloudflare D1 實際存的欄位）</summary>
      <p class="sub">超長的文字欄位只顯示開頭並標示總長度，避免整份 OCR 全文塞爆畫面。</p>
      <pre>entries：
${esc(JSON.stringify(clipForRaw(entry), null, 2))}</pre>
      ${atts.length ? `<pre>attachments（${atts.length} 筆）：
${esc(JSON.stringify(atts.map(clipForRaw), null, 2))}</pre>` : ""}
    </details>`;

  box.innerHTML = `<div class="prov-box">${rows.join("")}${aiBlock}${historyBlock}${rawBlock}</div>`;
}

async function loadRelations(entryId) {
  const box = $("e-relations");
  if (!box) return; // modal 可能已經關閉（切換太快）
  try {
    const rels = await api(`/relations?entry_id=${entryId}`);
    if (!rels.length) { box.innerHTML = `<p class="sub">尚無關聯</p>`; return; }
    box.innerHTML = rels.map((r) => {
      const otherId = r.is_from ? r.to_entry_id : r.from_entry_id;
      const arrow = r.is_from ? "→" : "←";
      const where = r.other_folder_name ? `${esc(r.other_folder_type)}｜${esc(r.other_folder_name)}` : "待分類";
      return `<div class="relation-row" data-id="${r.id}">
        <span class="relation-arrow">${arrow}</span>
        <span class="relation-type">${esc(r.relation_type)}</span>
        <a href="#" class="relation-link" data-open="${otherId}">${esc(r.other_title || "（未命名）")}</a>
        <span class="sub">${where}</span>
        ${r.note ? `<span class="sub">「${esc(r.note)}」</span>` : ""}
        <button class="btn small ghost relation-del" data-id="${r.id}" type="button" title="刪除這個關聯">✕</button>
      </div>`;
    }).join("");
    box.querySelectorAll(".relation-link").forEach((el) => {
      el.onclick = (ev) => { ev.preventDefault(); openEntry(Number(el.dataset.open)); };
    });
    box.querySelectorAll(".relation-del").forEach((el) => {
      el.onclick = async () => {
        if (!confirm("確定刪除這個關聯？")) return;
        try {
          await api(`/relations/${el.dataset.id}`, { method: "DELETE" });
          loadRelations(entryId);
        } catch (err) { showToast("刪除關聯失敗：" + err.message); }
      };
    });
  } catch (err) {
    box.innerHTML = `<p class="sub">關聯載入失敗：${esc(err.message)}</p>`;
  }
}

let RELATION_PICKED = null;

function openRelationPicker(fromEntryId, onDone) {
  RELATION_PICKED = null;
  const overlay = $("relation-picker-overlay");
  const input = $("relation-search-input");
  const results = $("relation-search-results");
  const picked = $("relation-picked");
  const typeInput = $("relation-type-input");
  const confirmBtn = $("relation-picker-confirm");
  input.value = "";
  results.innerHTML = "";
  picked.style.display = "none";
  typeInput.value = "";
  $("relation-note-input").value = "";
  confirmBtn.disabled = true;
  overlay.classList.add("open");
  input.focus();

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (!q || (RELATION_PICKED && q === RELATION_PICKED.title)) { results.innerHTML = ""; return; }
    try {
      const rows = await api(`/entries/search?q=${encodeURIComponent(q)}&exclude_id=${fromEntryId}`);
      results.innerHTML = rows.length
        ? rows.map((r) => `<div class="relation-result" data-id="${r.id}" data-title="${esc(r.title || "（未命名）")}">
            <strong>${esc(r.title || "（未命名）")}</strong>
            <span class="sub">${r.folder_name ? `${esc(r.folder_type)}｜${esc(r.folder_name)}` : "待分類"}</span>
          </div>`).join("")
        : `<p class="sub">沒有符合的記事</p>`;
      results.querySelectorAll(".relation-result").forEach((el) => {
        el.onclick = () => {
          RELATION_PICKED = { id: Number(el.dataset.id), title: el.dataset.title };
          $("relation-picked-title").textContent = RELATION_PICKED.title;
          picked.style.display = "";
          results.innerHTML = "";
          input.value = RELATION_PICKED.title;
          confirmBtn.disabled = !typeInput.value.trim();
        };
      });
    } catch (err) {
      results.innerHTML = `<p class="sub">搜尋失敗：${esc(err.message)}</p>`;
    }
  }, 300);
  input.oninput = runSearch;
  typeInput.oninput = () => { confirmBtn.disabled = !RELATION_PICKED || !typeInput.value.trim(); };

  const close = () => { overlay.classList.remove("open"); input.oninput = null; typeInput.oninput = null; };
  $("relation-picker-cancel").onclick = close;
  confirmBtn.onclick = async () => {
    if (!RELATION_PICKED || !typeInput.value.trim()) return;
    confirmBtn.disabled = true;
    try {
      await api("/relations", {
        method: "POST",
        body: JSON.stringify({
          from_entry_id: fromEntryId,
          to_entry_id: RELATION_PICKED.id,
          relation_type: typeInput.value.trim(),
          note: $("relation-note-input").value.trim(),
        }),
      });
      showToast("已新增關聯");
      close();
      onDone();
    } catch (err) {
      showToast("新增關聯失敗：" + err.message);
      confirmBtn.disabled = false;
    }
  };
}

// 🪄 一鍵整理：這筆紀錄還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取。
// 先錄音後照片——照片的【對話關聯】需要逐字稿先就位。失敗跳過，可個別重試。
async function processEntryAttachments(id, btn) {
  if (!TRANSCRIBE_ENABLED) { showToast("尚未啟用 AI 功能"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const e = await api(`/entries/${id}`);
    // 「處理過但結果是空的」（transcribed_at/ocr_at 有時間戳）不算待整理，不重跑
    const audioTodo = (e.attachments || []).filter((a) => a.kind === "audio" && !a.transcript && !a.transcribed_at);
    const photoTodo = (e.attachments || []).filter((a) => (a.kind === "photo" || isPdfAtt(a) || isNativeDocAtt(a)) && !a.ocr_text && !a.ocr_at);
    const total = audioTodo.length + photoTodo.length;
    if (!total) { showToast("沒有需要整理的附件，都處理過了"); return; }
    let done = 0;
    let failed = 0;
    const errCounts = new Map(); // 各種失敗原因各出現幾次，跑完常駐顯示（toast 幾秒就消失，來不及看）
    let quotaHit = false; // Cloudflare AI 每日額度用完（4006）就立刻停，不再逐筆撞牆
    const queue = [
      ...audioTodo.map((a) => ({ a, ep: "transcribe" })),
      ...photoTodo.map((a) => ({ a, ep: "ocr" })),
    ];
    let gotText = 0;
    let gotEmpty = 0;
    const processedIds = [];
    for (const { a, ep } of queue) {
      btn.textContent = `🪄 ${++done}/${total}`;
      try {
        const res = await api(`/attachments/${a.id}/${ep}`, { method: "POST", body: "{}" });
        const resultText = (res.text ?? res.ocr_text ?? "").trim();
        if (resultText) gotText++; else gotEmpty++;
        processedIds.push(String(a.id));
      } catch (err) {
        failed++;
        errCounts.set(err.message, (errCounts.get(err.message) || 0) + 1);
        console.error(`整理失敗 [${a.filename}]`, err);
        if (/4006|neuron/i.test(err.message)) { quotaHit = true; break; }
      }
    }
    const errSummary = [...errCounts.entries()].map(([m, c]) => `${m}（×${c}）`).join("；");
    const okSummary = `有內容 ${gotText} 筆・無內容 ${gotEmpty} 筆`;
    await openEntry(id); // 先重新渲染，再把摘要寫進狀態欄（否則會被重繪洗掉）
    // 這次剛整理的附件標綠邊條＋自動展開結果，一眼看到新結果
    for (const pid of processedIds) {
      const item = document.querySelector(`.att-item[data-id="${pid}"]`);
      if (!item) continue;
      item.classList.add("just-processed");
      item.querySelectorAll("details.att-ai").forEach((d) => { d.open = true; });
    }
    const statusEl = $("e-upload-status");
    if (quotaHit) {
      showToast(`⛔ Cloudflare AI 每日免費額度已用完，已停止整理`);
      if (statusEl) statusEl.textContent = `⛔ 額度用完（台北早上 8 點重置後再按一次續跑）`;
    } else if (failed) {
      showToast(`整理完成，${failed} 筆失敗（原因見按鈕旁）`);
      if (statusEl) statusEl.textContent = `⚠️ ${failed} 筆失敗：${errSummary}${processedIds.length ? `｜成功 ${processedIds.length} 筆（${okSummary}），結果標綠在下方 ↓` : ""}`;
    } else {
      showToast(`整理完成：${total} 筆`);
      if (statusEl) statusEl.textContent = `✓ 本次整理 ${total} 筆：${okSummary}，結果標綠在下方 ↓`;
    }
  } catch (err) {
    showToast("整理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🪄 Cloudflare AI 整理";
  }
}

// 🔬 Tier 2 深度處理：手動指定單一 PDF 才會跑，絕不背景全庫批次（見 DATA-MODEL.md）。
// Cloudflare Worker 沒有 PDF 渲染能力，這步只能在瀏覽器端用 pdf.js 把每一頁畫成圖片，
// 再把每張頁面圖丟進既有的照片 OCR 流程——向量圖表跟排版化的技術參數文字都變成看得見
// 的像素，Llama Vision 抄得到，也自動進搜尋索引，不用另外蓋一套 Tier 2 儲存/搜尋機制。
async function deepProcessPdf(entryId, pdfAtt, btn, existingPages = [], onComplete = null) {
  if (!window.pdfjsLib) { showToast("PDF 渲染程式庫載入失敗，請檢查網路連線後重新整理頁面再試"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  const finish = async () => {
    if (typeof onComplete === "function") await onComplete();
    else await openEntry(entryId);
  };
  try {
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }
    btn.textContent = "下載 PDF…";
    const fileRes = await fetch(fileUrlForKey(pdfAtt.key));
    if (!fileRes.ok) throw new Error(`下載 PDF 失敗（HTTP ${fileRes.status}）`);
    const pdf = await pdfjsLib.getDocument({ data: await fileRes.arrayBuffer() }).promise;
    const total = pdf.numPages;
    // 記下這份 PDF「實際」有幾頁（pdf.js 讀出來的真數字），用來跟目錄推算的
    // 頁數比對、抓節錄版——即使這次沒有新頁面要處理也要記，不然永遠沒機會存到
    if (Number(pdfAtt.total_pages) !== total) {
      await api(`/attachments/${pdfAtt.id}`, { method: "PUT", body: JSON.stringify({ total_pages: total }) }).catch(() => {});
      pdfAtt.total_pages = total;
    }
    const completedPageNos = new Set(existingPages.filter((a) => a.ocr_at).map((a) => Number(a.page_no)));
    const pendingCount = Math.max(0, total - completedPageNos.size);
    if (!pendingCount) {
      showToast(`深度處理已完成：${total} 頁都已有結果，不會重複扣額度`);
      await finish(); // total_pages 可能剛補上，重繪才會秀出節錄版偵測結果
      return;
    }
    if (total > 40 && !confirm(`這份 PDF 有 ${total} 頁，已有 ${completedPageNos.size} 頁完成，尚有 ${pendingCount} 頁。接續處理只會執行未完成頁面，確定繼續嗎？`)) {
      return;
    }
    // 同一頁若因舊版重跑而有重複附件，優先取已有 OCR 狀態的那一筆。
    const existingByPage = new Map();
    for (const a of existingPages) {
      const pageNo = Number(a.page_no);
      const current = existingByPage.get(pageNo);
      if (!current || (!current.ocr_at && a.ocr_at)) existingByPage.set(pageNo, a);
    }
    let done = 0, skipped = 0, failed = 0;
    const baseName = pdfAtt.filename.replace(/\.pdf$/i, "");
    for (let p = 1; p <= total; p++) {
      try {
        const existing = existingByPage.get(p);
        if (existing?.ocr_at) { skipped++; continue; }
        let attachmentId = existing?.id;
        if (!attachmentId) {
          btn.textContent = `渲染第 ${p}/${total} 頁…`;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 2 }); // scale 2：解析度足夠給 OCR 辨識文字
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("畫布輸出失敗");
          const uploaded = await putFile(entryId, blob, `${baseName}-p${p}.png`, null, { sourcePdfId: pdfAtt.id, pageNo: p });
          attachmentId = uploaded.id;
        }
        btn.textContent = `辨識第 ${p}/${total} 頁…`;
        await api(`/attachments/${attachmentId}/ocr`, { method: "POST", body: "{}" });
        done++;
      } catch (err) {
        failed++;
        console.error(`Tier 2 第 ${p} 頁失敗`, err);
        if (/4006|429|neuron|budget|額度|上限/i.test(err.message || "")) {
          showToast("⛔ AI 額度或預算保護已啟動，接續處理已停止（完成頁面已保留）");
          break;
        }
      }
    }
    showToast(`接續處理完成：新完成 ${done} 頁、跳過 ${skipped} 頁${failed ? `、失敗 ${failed} 頁` : ""}`);
    await finish();
  } catch (err) {
    showToast("深度處理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// 詳情頁開啟時鎖住底層頁面捲動（iOS Safari 光 overflow:hidden 不夠，
// 要用 position:fixed 才真的鎖得住），關閉時還原原本的捲動位置
function lockBodyScroll() {
  if (document.body.classList.contains("modal-open")) return; // 重複開啟（整理後刷新）時別把捲動位置蓋成 0
  document.body.dataset.scrollY = String(window.scrollY);
  document.body.style.top = `-${window.scrollY}px`;
  document.body.classList.add("modal-open");
}
function unlockBodyScroll() {
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, Number(document.body.dataset.scrollY || 0));
}

// ---------- 站內圖片檢視器 ----------
// 照片原本是 <a target="_blank"> 開原始圖片 URL。在 PWA（display:standalone）裡
// 那會變成一個沒有瀏覽器介面的畫面：沒有返回、沒有關閉，只能強制關掉 App。
// 改成在覆蓋層裡看，關閉鈕永遠在。

// 開圖片時如果底層已經有其他 modal 開著（例如檔案詳情），關圖片時就不能解鎖
// 底層捲動——那個 modal 還開著。記住是不是由圖片檢視器自己鎖的。
let IMAGE_VIEWER_LOCKED_SCROLL = false;

function openImageViewer(url, filename, attachmentId, rotation) {
  const overlay = $("image-viewer-overlay");
  const img = $("image-viewer-img");
  img.src = url;
  img.alt = filename || "照片";
  img.dataset.id = attachmentId || "";
  img.dataset.rotation = Number(rotation) || 0;
  $("image-viewer-name").textContent = filename || "";
  $("image-viewer-open").href = url;
  const rotateBtn = $("image-viewer-rotate");
  if (rotateBtn) rotateBtn.hidden = !attachmentId;
  overlay.classList.add("open");
  if (!document.body.classList.contains("modal-open")) {
    lockBodyScroll();
    IMAGE_VIEWER_LOCKED_SCROLL = true;
  }
}

function closeImageViewer() {
  const overlay = $("image-viewer-overlay");
  if (!overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  $("image-viewer-img").src = ""; // 放掉大圖記憶體
  if (IMAGE_VIEWER_LOCKED_SCROLL) {
    unlockBodyScroll();
    IMAGE_VIEWER_LOCKED_SCROLL = false;
  }
}

// 旋轉只改 attachments.rotation 這個顯示用中繼資料，R2 原始檔完全不動
// （raw data 只增不刪）。轉完同時更新縮圖列裡同一張照片，不用整頁重新整理。
async function rotateCurrentImage() {
  const img = $("image-viewer-img");
  const id = Number(img.dataset.id || 0);
  if (!id) return;
  const btn = $("image-viewer-rotate");
  if (btn) btn.disabled = true;
  try {
    const result = await api(`/attachments/${id}/rotate`, { method: "POST", body: "{}" });
    img.dataset.rotation = result.rotation;
    document.querySelectorAll(`.att-thumb[data-id="${id}"]`).forEach((thumb) => {
      thumb.dataset.rotation = result.rotation;
    });
    document.querySelectorAll(`a[data-image-id="${id}"]`).forEach((link) => {
      link.dataset.imageRotation = result.rotation;
    });
  } catch (error) {
    showToast("旋轉失敗：" + error.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function isImageAtt(a) {
  return a.kind === "photo" || /^image\//i.test(a.mime || "");
}

// 把「連到圖片的連結」改成開站內檢視器。保留 href 讓長按／另開分頁仍然可用，
// 只是攔掉一般點擊。
function bindImageLinks(root = document) {
  root.querySelectorAll("a[data-image-url]").forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = link.closest(".folder-file-row[data-att-id]");
      if (row && PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) {
        showFilePreview({
          entryId: Number(row.dataset.entryId), attachmentId: Number(row.dataset.attId),
          filename: row.dataset.filename || "檔案", key: row.dataset.key || "",
          mime: row.dataset.mime || "", kind: row.dataset.kind || "",
        }).catch((error) => showToast("預覽失敗：" + error.message));
        return;
      }
      openImageViewer(link.dataset.imageUrl, link.dataset.imageName || "", link.dataset.imageId, link.dataset.imageRotation);
    };
  });
}

function closeEntry() {
  FOCUSED_FILE = null;
  // 檔案詳情關掉之後，它註冊的分類刷新函式就失效了（指向已被替換掉的 DOM），
  // 這裡清掉，避免之後從首頁改分類時去刷新一個已經不存在的下拉
  FILE_CATEGORY_REFRESH = null;
  $("entry-overlay").classList.remove("open");
  unlockBodyScroll();
}

function plainEntryBody(entry) {
  const value = String(entry?.body || "");
  if (entry?.body_format !== "html") return value;
  const holder = document.createElement("div");
  holder.innerHTML = value;
  return holder.textContent || "";
}

function hasLegacyRecordingFields(entry) {
  let fields = {};
  try { fields = JSON.parse(entry?.fields_json || "{}"); } catch { return true; }
  return entry?.body_format === "html" || Object.entries(fields)
    .some(([key, value]) => !key.startsWith("_") && String(value || "").trim());
}

async function openRecordingEditor(entryId) {
  entryId = Number(entryId || 0);
  if (!entryId) return;
  if (usesDesktopRightPane()) {
    return withViewLoading("正在載入錄音編輯欄…", () => loadRecordingEditor(entryId));
  }
  return loadRecordingEditor(entryId);
}

async function loadRecordingEditor(entryId) {
  FOCUSED_FILE = null;
  const entry = await api(`/entries/${entryId}`);
  const audio = (entry.attachments || []).filter((item) => item.kind === "audio" && !item.source_pdf_id);
  if (!audio.length) return usesDesktopRightPane() ? showEntryEditor(entryId) : openEntry(entryId);
  // 桌機的資料夾工作區以右欄作為唯一的閱讀／編輯表面；手機仍沿用既有詳情頁。
  if (!PREVIEW_ENABLED || !matchMedia("(min-width: 1000px)").matches) return openEntry(entryId);
  return renderRecordingEditor(entryId, entry, audio);
}

async function renderRecordingEditor(entryId, entry, audio) {
  if ($("entry-overlay")?.classList.contains("open")) closeEntry();
  const body = $("folder-preview-body");
  $("folder-preview-title").textContent = `編輯｜${entry.title || "錄音"}`;
  body.innerHTML = `<form class="recording-editor preview-editor" id="recording-preview-editor">
      <label for="recording-edit-title">名稱</label>
      <input id="recording-edit-title" maxlength="160" value="${esc(entry.title || "")}" />
      <label for="recording-edit-note">速記</label>
      <textarea id="recording-edit-note" placeholder="會議重點、待辦或錄音備註">${esc(plainEntryBody(entry))}</textarea>
      <div class="recording-editor-transcripts">
        <h3>逐字稿</h3>
        ${audio.map((item, index) => `<section>
          <div class="recording-editor-segment-head"><strong>${audio.length > 1 ? `第 ${index + 1} 段` : "錄音逐字稿"}</strong><span>${esc(item.filename)}｜${esc(fmtBytes(item.size))}${Number(item.duration_secs) > 0 ? `｜${esc(fmtSecs(item.duration_secs))}` : ""}</span></div>
          <audio controls preload="metadata" src="${fileUrlForKey(item.key)}"></audio>
          <textarea class="recording-transcript-input" data-audio-id="${item.id}" placeholder="尚無逐字稿">${esc(item.transcript || "")}</textarea>
        </section>`).join("")}
      </div>
      <section class="preview-management-panel recording-editor-management">
        <strong>錄音資料包管理</strong>
        <p class="sub">音訊、逐字稿與照片仍保留在同一資料包。</p>
        <div class="preview-management-actions">
          <button class="btn small" id="recording-edit-transcribe" type="button">重新轉錄全部</button>
          <button class="btn small" id="recording-edit-move" type="button">移動資料包</button>
          <button class="btn small danger" id="recording-edit-delete" type="button">刪除資料包</button>
        </div>
        <div class="recording-editor-downloads">${audio.map((item, index) => `<a href="${fileUrlForKey(item.key)}" download="${esc(item.filename)}">下載${audio.length > 1 ? `第 ${index + 1} 段` : "錄音"}｜${esc(item.filename)}</a>`).join("")}</div>
      </section>
      <div class="preview-editor-actions"><button class="btn primary" id="recording-edit-save" type="submit">儲存</button><button class="btn" id="recording-edit-cancel" type="button">取消</button></div>
    </form>`;
  const returnToPreview = () => showRecordingPreview(entryId).catch((error) => showToast("預覽失敗：" + error.message));
  $("folder-preview-open").hidden = false;
  $("folder-preview-open").textContent = audio.length === 1 ? "下載錄音" : "下載第 1 段";
  $("folder-preview-open").href = fileUrlForKey(audio[0].key);
  $("folder-preview-open").setAttribute("download", audio[0].filename || "recording");
  $("folder-preview-edit").hidden = false;
  $("folder-preview-edit").textContent = "取消";
  $("folder-preview-edit").onclick = returnToPreview;
  $("folder-preview-manage").disabled = true;
  $("folder-preview-manage").onclick = null;
  $("recording-edit-cancel").onclick = returnToPreview;
  $("recording-edit-transcribe").onclick = async () => {
    if (!confirm(`重新轉錄 ${audio.length} 段錄音？\n\n目前逐字稿會被覆蓋，並使用 Cloudflare AI 額度。`)) return;
    const button = $("recording-edit-transcribe");
    button.disabled = true;
    try {
      for (let index = 0; index < audio.length; index++) {
        button.textContent = `轉錄中 ${index + 1}/${audio.length}`;
        await api(`/attachments/${audio[index].id}/transcribe`, { method: "POST", body: "{}" });
      }
      showToast("錄音已重新轉錄");
      await refreshFolderView();
      await openRecordingEditor(entryId);
    } catch (error) {
      showToast("重新轉錄失敗：" + error.message);
      button.disabled = false;
      button.textContent = "重新轉錄全部";
    }
  };
  $("recording-edit-move").onclick = async () => {
    const picked = await openFolderPicker({
      title: "移動錄音資料包",
      desc: `把「${entry.title || "錄音"}」連同音訊、逐字稿及照片一起移到哪裡？`,
      currentId: entry.folder_id || null,
      allowInbox: true,
    });
    if (!picked) return;
    try {
      if (picked.id === null) {
        await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: null }) });
        showToast("錄音資料包已移回待分類");
      } else {
        await moveInboxEntry(entryId, picked.id, entry.folder_id || null);
      }
      await refreshFolderView();
      clearFilePreview("錄音資料包已移動，請從左側資料夾重新選取。");
    } catch (error) { showToast("移動失敗：" + error.message); }
  };
  $("recording-edit-delete").onclick = async () => {
    if (!confirm(`將「${entry.title || "錄音"}」整個資料包移到垃圾桶？\n\n音訊、逐字稿與照片會一起移入，保留 60 天。`)) return;
    try {
      await api(`/entries/${entryId}`, { method: "DELETE" });
      showToast("錄音資料包已移到垃圾桶");
      await refreshFolderView();
      clearFilePreview("錄音資料包已移到垃圾桶。");
    } catch (error) { showToast("刪除失敗：" + error.message); }
  };
  $("recording-preview-editor").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("recording-edit-save");
    const title = $("recording-edit-title").value.trim();
    if (!title) { showToast("名稱不可空白"); return; }
    button.disabled = true;
    button.textContent = "儲存中…";
    try {
      await api(`/entries/${entryId}`, {
        method: "PUT",
        body: JSON.stringify({ title, body: $("recording-edit-note").value.trim(), body_format: "text" }),
      });
      for (const textarea of body.querySelectorAll(".recording-transcript-input")) {
        await api(`/attachments/${textarea.dataset.audioId}`, {
          method: "PUT",
          body: JSON.stringify({ transcript: textarea.value.trim() }),
        });
      }
      showToast("錄音名稱、速記與逐字稿已儲存");
      await refreshFolderView();
      if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) await showRecordingPreview(entryId);
    } catch (error) {
      showToast("錄音儲存失敗：" + error.message);
      button.disabled = false;
      button.textContent = "儲存";
    }
  };
}

async function openRecordingActions(entryId) {
  entryId = Number(entryId || 0);
  if (!entryId) return;
  if (usesDesktopRightPane()) return openRecordingEditor(entryId);
  FOCUSED_FILE = null;
  const entry = await api(`/entries/${entryId}`);
  const audio = (entry.attachments || []).filter((item) => item.kind === "audio" && !item.source_pdf_id);
  if (!audio.length) return openEntry(entryId);
  const status = recordingStatus(audio);
  const legacy = hasLegacyRecordingFields(entry);
  const modal = $("entry-modal");
  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="recording-actions-close" type="button" aria-label="關閉錄音操作">✕</button></div>
    <div class="detail-head"><div><h2 style="margin:0;overflow-wrap:anywhere">${esc(entry.title || "錄音")}</h2><p class="sub">錄音資料包｜${audio.length} 段｜${esc(status.label)}</p></div></div>
    <div class="recording-action-list">
      <button class="recording-action" id="recording-action-edit" type="button"><span>✏️</span><strong>編輯</strong><small>名稱、速記與逐字稿</small></button>
      <button class="recording-action" id="recording-action-transcribe" type="button"><span>📝</span><strong>重新轉錄</strong><small>覆蓋目前逐字稿，會使用 AI 額度</small></button>
      <button class="recording-action" id="recording-action-rename" type="button"><span>🏷️</span><strong>重新命名</strong><small>只改資料包名稱</small></button>
      <button class="recording-action" id="recording-action-move" type="button"><span>📂</span><strong>移動</strong><small>音訊、逐字稿及照片一起移動</small></button>
      <section class="recording-download-list"><h3>⬇️ 下載錄音</h3>${audio.map((item, index) => `<a href="${fileUrlForKey(item.key)}" download="${esc(item.filename)}">${audio.length > 1 ? `第 ${index + 1} 段｜` : ""}${esc(item.filename)} <small>${esc(fmtBytes(item.size))}</small></a>`).join("")}</section>
      <button class="recording-action danger" id="recording-action-delete" type="button"><span>🗑️</span><strong>刪除</strong><small>整個資料包移到垃圾桶，保留 60 天</small></button>
    </div>
    ${legacy ? `<details class="recording-legacy-fallback"><summary>舊資料相容工具</summary><p class="sub">只有這筆帶有舊欄位，因此保留舊版資料框供核對。</p><button class="btn small" id="recording-open-legacy" type="button">開啟舊版資料框</button></details>` : ""}`;
  $("entry-overlay").classList.add("open");
  lockBodyScroll();
  $("recording-actions-close").onclick = closeEntry;
  $("recording-action-edit").onclick = () => openRecordingEditor(entryId).catch((error) => showToast("開啟編輯失敗：" + error.message));
  $("recording-action-rename").onclick = async () => {
    const next = prompt("輸入新的錄音名稱", entry.title || "");
    if (next === null) return;
    const title = next.trim();
    if (!title) { showToast("名稱不可空白"); return; }
    try {
      await api(`/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ title }) });
      showToast("錄音名稱已更新");
      await refreshFolderView();
      await openRecordingActions(entryId);
    } catch (error) { showToast("重新命名失敗：" + error.message); }
  };
  $("recording-action-move").onclick = async () => {
    closeEntry();
    await openMoveEntryDialog(entryId, { currentFolderId: entry.folder_id || null, title: entry.title || "錄音" });
  };
  $("recording-action-transcribe").onclick = async () => {
    if (!confirm(`重新轉錄 ${audio.length} 段錄音？\n\n目前逐字稿會被覆蓋，並使用 Cloudflare AI 額度。`)) return;
    const button = $("recording-action-transcribe");
    button.disabled = true;
    button.querySelector("strong").textContent = "轉錄中…";
    try {
      for (let index = 0; index < audio.length; index++) {
        button.querySelector("small").textContent = `正在處理第 ${index + 1} / ${audio.length} 段`;
        await api(`/attachments/${audio[index].id}/transcribe`, { method: "POST", body: "{}" });
      }
      showToast("錄音已重新轉錄");
      closeEntry();
      await refreshFolderView();
      if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches) await showRecordingPreview(entryId);
    } catch (error) {
      showToast("重新轉錄失敗：" + error.message);
      button.disabled = false;
      button.querySelector("strong").textContent = "重新轉錄";
      button.querySelector("small").textContent = "覆蓋目前逐字稿，會使用 AI 額度";
    }
  };
  $("recording-action-delete").onclick = async () => {
    if (!confirm(`將「${entry.title || "錄音"}」整個資料包移到垃圾桶？\n\n音訊、逐字稿與照片會一起移入，保留 60 天。`)) return;
    try {
      await api(`/entries/${entryId}`, { method: "DELETE" });
      showToast("錄音資料包已移到垃圾桶");
      closeEntry();
      await refreshFolderView();
    } catch (error) { showToast("刪除失敗：" + error.message); }
  };
  if (legacy) $("recording-open-legacy").onclick = () => {
    closeEntry();
    openEntry(entryId).catch((error) => showToast("舊資料框開啟失敗：" + error.message));
  };
}

/**
 * 單一檔案的詳情頁。
 *
 * 為什麼不直接用記事詳情：使用者在資料夾裡看到的是「一份一份的檔案」，
 * 而一筆記事可能掛好幾份檔案。點某一份檔案應該只看到那一份的東西
 * （它自己的附屬記事、它自己的醫材分類、只刪它自己），不是整筆記事。
 */
async function openFileDetail(entryId, attachmentId) {
  entryId = Number(entryId || 0);
  attachmentId = Number(attachmentId || 0);
  if (!entryId || !attachmentId) return;
  if (usesDesktopRightPane()) return showFileEditor(entryId, attachmentId);
  return withViewLoading("正在載入檔案…", async () => {
  FOCUSED_FILE = { entryId, attachmentId };

  const entry = await api(`/entries/${entryId}`);
  const sourceAttachments = (entry.attachments || []).filter((item) => !item.source_pdf_id);
  const attachment = sourceAttachments.find((item) => Number(item.id) === attachmentId);
  if (!attachment) {
    closeEntry();
    showToast("這份檔案已不存在");
    await refreshFolderView();
    return;
  }

  // 舊資料相容：以前單一檔案的記事寫在 entries.body，現在改存在 attachments.note。
  // 只有一份檔案時才把舊的 body 當成這份檔案的記事顯示，避免多檔案時張冠李戴。
  const legacyNote = sourceAttachments.length === 1 ? String(entry.body || "").trim() : "";
  const noteValue = String(attachment.note || "").trim() || legacyNote;
  const fileUrl = fileUrlForKey(attachment.key);
  const canDoodle = isPdfAtt(attachment) && typeof window.fieldlogOpenPdfEditor === "function";
  const originalName = attachment.original_filename && attachment.original_filename !== attachment.filename
    ? `<p class="sub">原始檔名：${esc(attachment.original_filename)}</p>` : "";

  const modal = $("entry-modal");
  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="file-detail-close" type="button" aria-label="關閉檔案" title="關閉檔案">✕</button></div>
    <div class="detail-head"><h2 style="margin:0;overflow-wrap:anywhere">${esc(attachment.filename)}</h2></div>
    <div class="file-primary-actions">
      ${isImageAtt(attachment)
        ? `<a id="file-read-action" href="${fileUrl}" data-image-url="${fileUrl}" data-image-name="${esc(attachment.filename)}">📖 閱讀</a>`
        : `<a id="file-read-action" href="${fileUrl}" target="_blank" rel="noopener">📖 閱讀</a>`}
      <button id="file-doodle-action" type="button" ${canDoodle ? "" : 'class="disabled" disabled'}>✍️ 塗鴉</button>
      <button id="file-move-action" type="button">📂 移動</button>
      <button id="file-category-action" type="button">🏷 分類</button>
      <button id="file-note-action" type="button">📝 Note</button>
      <button id="file-rename-action" type="button">✏️ 重新命名</button>
      <button id="file-share-action" type="button">🔗 分享</button>
    </div>
    <div class="file-category-panel" id="file-category-panel">
      <strong>醫療器材分類</strong>
      <div class="file-category-row">
        <select id="file-device-category"><option value="">讀取分類中…</option></select>
        <button class="btn primary" id="file-category-save" type="button">儲存分類</button>
      </div>
      <p class="file-category-current" id="file-category-current">讀取分類中…</p>
      <p class="sub"><button class="btn small ghost" id="file-category-manage" type="button">⚙️ 管理分類（新增／刪除選項）</button></p>
    </div>
    <p class="sub">${esc(localDateTime(attachment.created_at || entry.created_at))}${CURRENT_FOLDER ? `｜${esc(CURRENT_FOLDER.name)}` : ""}</p>
    ${originalName}
    <div class="file-note-box">
      <label for="file-note">Note 文字（只屬於這一份檔案）</label>
      <textarea id="file-note" placeholder="只屬於這一份檔案的記事">${esc(noteValue)}</textarea>
    </div>
    <div class="file-detail-actions">
      <button class="btn primary" id="file-note-save" type="button">儲存 Note</button>
      <button class="btn small" id="file-normalize-name" type="button">🏷 整理中文檔名</button>
      <span id="e-upload-status" class="sub"></span>
    </div>
    <h3 class="section-title">檔案處理</h3>
    <div id="e-attachments" class="att-list">${attHtml(attachment, entry.attachments || [])}</div>
    <div class="file-detail-danger">
      <button class="btn entry-delete" id="file-delete" type="button">🗑 刪除這份檔案</button>
      <p class="sub">只刪除目前檔案，不刪除其他附件。</p>
    </div>
  `;

  $("entry-overlay").classList.add("open");
  lockBodyScroll();
  $("file-detail-close").onclick = closeEntry;
  $("file-rename-action").onclick = () => renameAttachment(attachmentId, attachment.filename)
    .then(() => FOCUSED_FILE && openFileDetail(entryId, attachmentId))
    .catch((error) => showToast("重新命名失敗：" + error.message));
  $("file-share-action").onclick = () => createReadOnlyShare(entryId, attachmentId).catch((error) => showToast("分享失敗：" + error.message));
  bindAttActions(entryId);
  bindImageLinks(modal);
  setupFileDropZone(modal, (files) => uploadFiles(entryId, files));

  const panel = $("file-category-panel");
  const select = $("file-device-category");
  const current = $("file-category-current");

  $("file-note-action").onclick = () => {
    const textarea = $("file-note");
    textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    textarea.focus();
  };
  $("file-category-action").onclick = () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) select.focus();
  };
  if (canDoodle) {
    $("file-doodle-action").onclick = () => {
      window.fieldlogOpenPdfEditor(entryId, attachment)
        .catch((error) => showToast("開啟塗鴉失敗：" + error.message));
    };
  }
  $("file-category-manage").onclick = () => openCategoryManager("device");
  // 拖曳只搬得到「目前資料夾底下的子資料夾」，跨分支、往上一層、從第 4 層搬回
  // 第 1 層都做不到；這顆按鈕走同一支 /attachments/:id/move，但目標可以是任何
  // 一層的任何一個資料夾。
  $("file-move-action").onclick = async () => {
    const picked = await openFolderPicker({
      title: "移動檔案",
      desc: `把「${attachment.filename}」移到哪個資料夾？四層裡的任何一個都可以，已分類的也能再搬。`,
      currentId: entry.folder_id || null,
      allowInbox: false, // 單一檔案的搬移端點只收資料夾；要回待分類請移動整筆記事
    });
    if (!picked?.id) return;
    const target = FOLDERS.find((f) => f.id === picked.id);
    try {
      const result = await api(`/attachments/${attachmentId}/move`, {
        method: "POST",
        body: JSON.stringify({ folder_id: picked.id }),
      });
      showToast(result.moved ? `已移到「${target?.name || "資料夾"}」` : "已經在這個資料夾了");
      FOCUSED_FILE = null;
      closeEntry();
      await refreshFolderView();
    } catch (error) {
      showToast("移動失敗：" + error.message);
    }
  };

  async function renderCategoryOptions() {
    try {
      const result = await api(`/attachments/${attachmentId}/category`);
      select.innerHTML = `<option value="">未分類</option>${(result.categories || [])
        .map((name) => `<option value="${esc(name)}" ${name === result.category ? "selected" : ""}>${esc(name)}</option>`)
        .join("")}`;
      // 分類選項被刪掉、但這份檔案還套著舊分類名稱時，仍要看得到目前的值
      if (result.category && !(result.categories || []).includes(result.category)) {
        select.insertAdjacentHTML("beforeend",
          `<option value="${esc(result.category)}" selected>${esc(result.category)}（已不在分類清單）</option>`);
      }
      current.textContent = `目前分類：${result.category || "未分類"}`;
    } catch (error) {
      current.textContent = "讀取分類失敗：" + error.message;
    }
  }
  renderCategoryOptions();
  FILE_CATEGORY_REFRESH = renderCategoryOptions;

  $("file-category-save").onclick = async () => {
    const button = $("file-category-save");
    button.disabled = true;
    try {
      const result = await api(`/attachments/${attachmentId}/category`, {
        method: "PUT",
        body: JSON.stringify({ category: select.value }),
      });
      current.textContent = `目前分類：${result.category || "未分類"}`;
      showToast("醫療器材分類已儲存");
    } catch (error) {
      showToast("分類儲存失敗：" + error.message);
    } finally {
      button.disabled = false;
    }
  };

  $("file-note-save").onclick = async () => {
    const button = $("file-note-save");
    button.disabled = true;
    try {
      await api(`/attachments/${attachmentId}/note`, {
        method: "PUT",
        body: JSON.stringify({ note: $("file-note").value.trim() }),
      });
      showToast("附屬記事已儲存");
    } catch (error) {
      showToast("記事儲存失敗：" + error.message);
    } finally {
      button.disabled = false;
    }
  };

  $("file-normalize-name").onclick = async () => {
    const button = $("file-normalize-name");
    button.disabled = true;
    button.textContent = "整理中…";
    try {
      const result = await api(`/attachments/${attachmentId}/normalize-name`, { method: "POST", body: "{}" });
      showToast(result.renamed
        ? "已更新中文檔名"
        : result.incomplete_year
          ? "尚未確認年份，請先擷取文字或深度處理"
          : "檔名已是目前可確認的格式");
      await refreshFolderView();
      await openFileDetail(entryId, attachmentId);
    } catch (error) {
      showToast("整理檔名失敗：" + error.message);
      button.disabled = false;
      button.textContent = "🏷 整理中文檔名";
    }
  };

  $("file-delete").onclick = () => {
    removeOneFile(attachmentId, attachment.filename, true)
      .catch((error) => showToast("刪除失敗：" + error.message));
  };
  });
}

function attHtml(a, siblings) {
  const url = fileUrlForKey(a.key);
  const originalName = a.original_filename && a.original_filename !== a.filename
    ? `<div class="att-original">原始名稱：${esc(a.original_filename)}</div>` : "";
  const docIcon = (a.filename || "").toLowerCase();
  const fileIcon = isPdfAtt(a) ? "📕"
    : docIcon.endsWith(".docx") ? "📘" : docIcon.endsWith(".xlsx") ? "📊" : docIcon.endsWith(".pptx") ? "📙"
      : isNativeDocAtt(a) ? "📄" : "📎";
  let preview = `<a href="${url}" target="_blank" rel="noopener">${fileIcon} ${esc(a.filename)}</a>`;
  // 照片點縮圖開站內檢視器（不是 target=_blank——在 PWA 裡那會跳到沒有關閉鈕的畫面）
  if (isImageAtt(a)) {
    const rotation = Number(a.rotation) || 0;
    preview = `<a class="att-photo-link" href="${url}" data-image-url="${url}" data-image-name="${esc(a.filename)}" data-image-id="${a.id}" data-image-rotation="${rotation}"><img class="att-thumb" data-id="${a.id}" data-rotation="${rotation}" src="${url}" loading="lazy" alt="${esc(a.filename)}" /></a>`;
  }
  if (a.kind === "audio") preview = `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
  const offset = a.offset_secs !== null && a.offset_secs !== undefined ? `<span class="att-offset">📸 錄音 ${fmtSecs(a.offset_secs)}</span>` : "";
  // AI 整理區塊預設收合，只露一行狀態（附件一多頁面才不會被文字撐爆），點狀態展開全文與操作
  const aiFold = (summary, body) =>
    `<details class="att-ai"><summary>${summary}</summary><div class="att-ai-body">${body}</div></details>`;
  const transcribeBit = a.kind === "audio" && TRANSCRIBE_ENABLED
    ? (a.transcript
      ? aiFold(`📝 已整理｜${esc(clipText(a.transcript, 40))}`,
          `<p class="att-transcript">📝 ${esc(a.transcript)} <a href="#" class="att-transcribe skip-link" data-id="${a.id}" title="重新跑 AI 辨識並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
      : a.transcribed_at === "skipped"
        ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" class="att-transcribe" data-id="${a.id}">還是要辨識</a></p>`)
        : a.transcribed_at === "auto_failed"
          ? aiFold(`⚠️ 自動轉錄失敗`, `<p class="att-transcript">系統不會自動重試，以免重複計費。<a href="#" class="att-transcribe" data-id="${a.id}">手動重試</a></p>`)
          : a.transcribed_at === "processing"
            ? aiFold(`⏳ 自動轉錄中`, `<p class="att-transcript">正在安全轉錄，請稍後重新開啟記事。</p>`)
        : a.transcribed_at
          ? aiFold(`📝 已整理（無語音內容）`, `<p class="att-transcript">辨識過，沒有語音內容 <a href="#" class="att-transcribe" data-id="${a.id}">重新辨識</a></p>`)
          : aiFold(`⏳ 未整理`, `<a href="#" class="att-transcribe" data-id="${a.id}">轉文字</a> <a href="#" class="att-skip skip-link" data-id="${a.id}" data-field="skip_transcribe" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`))
    : "";
  const ocrBit = (a.kind === "photo" || isPdfAtt(a) || isNativeDocAtt(a)) && TRANSCRIBE_ENABLED
    ? (a.ocr_text
      ? aiFold(`🔍 已整理｜${esc(clipText(a.ocr_text, 40))}`,
          `<p class="att-transcript">🔍 ${esc(clipText(a.ocr_text, 600))} <a href="#" class="att-ocr-edit" data-id="${a.id}">編輯</a> <a href="#" class="att-ocr skip-link" data-id="${a.id}" title="重新跑 AI 擷取並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
      : a.ocr_at === "skipped"
        ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" class="att-ocr" data-id="${a.id}">還是要擷取</a></p>`)
        : a.ocr_at
          ? aiFold(`🔍 已整理（沒有文字內容）`, `<p class="att-transcript">擷取過，沒有文字內容 <a href="#" class="att-ocr" data-id="${a.id}">重新擷取</a></p>`)
          : aiFold(`⏳ 未整理`, `<a href="#" class="att-ocr" data-id="${a.id}">🔍 擷取文字</a> <a href="#" class="att-skip skip-link" data-id="${a.id}" data-field="skip_ocr" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`))
    : "";
  // Tier 2 深度處理：只給 PDF，手動觸發，絕不自動全庫跑（見 DATA-MODEL.md）
  const tier2Pages = (siblings || []).filter((x) => x.source_pdf_id === a.id);
  const tier2Count = tier2Pages.length;
  const tier2Done = new Set(tier2Pages.filter((x) => x.ocr_at).map((x) => Number(x.page_no))).size;
  // 節錄版偵測：實際頁數優先用 total_pages（pdf.js 讀到的真數字），還沒跑過深度
  // 處理、拿不到真數字時，退回用「已建立的深度頁面數」頂著用
  const actualPages = a.total_pages || tier2Count || null;
  const tocText = tier2Pages
    .slice().sort((x, y) => Number(x.page_no) - Number(y.page_no))
    .slice(0, 5)
    .map((x) => x.ocr_text || "")
    .join("\n");
  const expectedPages = deriveExpectedPages(tocText);
  const previewDomain = matchPreviewDomain(a.source_url);
  const tier2Warnings = [];
  if (expectedPages && actualPages && expectedPages > actualPages) {
    tier2Warnings.push(`⚠️ 依目錄推算原始文件應有 ${expectedPages} 頁，這份只有 ${actualPages} 頁，可能是節錄版`);
  }
  if (previewDomain) {
    tier2Warnings.push(`⚠️ 來源網址含「${esc(previewDomain)}」，這類預覽站常只提供節錄頁數，建議人工確認`);
  }
  const tier2Warn = tier2Warnings.length ? `<p class="tier2-warn">${tier2Warnings.join("；")}</p>` : "";
  const tier2Core = tier2Count
    ? `<p class="att-tier2">🔬 深度頁面：${tier2Done} 頁完成／${tier2Count} 頁已建立 <a href="#" class="att-tier2-btn" data-id="${a.id}">檢查並接續</a></p>`
    : `<p class="att-tier2"><a href="#" class="att-tier2-btn" data-id="${a.id}" title="把這份 PDF 逐頁轉成圖片並跑 AI 辨識，補齊一般擷取抓不到的圖形化排版/圖表內容。手動觸發、只處理這一份，較耗時間與額度">🔬 深度處理（逐頁轉圖辨識）</a></p>`;
  const tier2Bit = !isPdfAtt(a) || !TRANSCRIBE_ENABLED ? "" : `${tier2Core}${tier2Warn}`;
  // PDF 塗鴉：實作在 pdf-editor.js（獨立載入，因為要動態抓 pdf-lib）。
  // 那支檔案載入後會掛上 window.fieldlogOpenPdfEditor；還沒載入完就先不顯示這個入口。
  const doodleBit = isPdfAtt(a) ? `<a href="#" class="att-pdf-doodle" data-id="${a.id}">✍️ 塗鴉</a>` : "";
  return `<div class="att-item" data-id="${a.id}" data-ocr="${esc(a.ocr_text || "")}">
    <div class="att-meta">${esc(localDateTimeShort(a.created_at))} ${offset}
      ${doodleBit}<a href="#" class="att-rename" data-id="${a.id}" data-filename="${esc(a.filename)}">重新命名</a>
      <a href="#" class="att-delete" data-id="${a.id}">刪除</a>
    </div>
    ${preview}${originalName}${ocrBit}${transcribeBit}${tier2Bit}
  </div>`;
}

function bindAttActions(entryId) {
  document.querySelectorAll(".att-rename").forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      renameAttachment(Number(el.dataset.id), el.dataset.filename || "檔案", { reopenEntryId: entryId })
        .catch((error) => showToast("重新命名失敗：" + error.message));
    };
  });
  document.querySelectorAll(".att-transcribe").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      el.textContent = "轉錄中…";
      try {
        await api(`/attachments/${el.dataset.id}/transcribe`, { method: "POST", body: "{}" });
        openEntry(entryId);
      } catch (e) { el.textContent = "失敗，點我重試"; showToast(e.message); }
    };
  });
  document.querySelectorAll(".att-delete").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      if (!confirm("確定刪除這個附件？刪除後無法復原。")) return;
      try {
        await api(`/attachments/${el.dataset.id}`, { method: "DELETE" });
        openEntry(entryId);
      } catch (e) { showToast("刪除失敗：" + e.message); }
    };
  });
  document.querySelectorAll(".att-ocr").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      el.textContent = "擷取中…（約 10–20 秒）";
      try {
        await api(`/attachments/${el.dataset.id}/ocr`, { method: "POST", body: "{}" });
        openEntry(entryId);
      } catch (e) { el.textContent = "🔍 擷取失敗，點我重試"; showToast(e.message); }
    };
  });
  document.querySelectorAll(".att-ocr-edit").forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      const current = el.closest(".att-item").dataset.ocr || "";
      openEditModal({
        title: "修改擷取文字（AI 抄錯的地方直接改成正確內容）",
        value: current,
        onSave: async (text) => {
          await api(`/attachments/${el.dataset.id}`, { method: "PUT", body: JSON.stringify({ ocr_text: text }) });
          openEntry(entryId);
        },
      });
    };
  });
  // 「略過」＝標成不整理（不呼叫 AI），待整理數與批次都會跳過；可從「還是要辨識/擷取」反悔
  document.querySelectorAll(".att-skip").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      try {
        await api(`/attachments/${el.dataset.id}`, { method: "PUT", body: JSON.stringify({ [el.dataset.field]: true }) });
        openEntry(entryId);
      } catch (e) { showToast("設定失敗：" + e.message); }
    };
  });
  bindImageLinks();
  // PDF 塗鴉：開啟 pdf-editor.js 提供的編輯器
  document.querySelectorAll(".att-pdf-doodle").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      if (typeof window.fieldlogOpenPdfEditor !== "function") {
        showToast("PDF 塗鴉程式還在載入，請稍後再試");
        return;
      }
      try {
        const entry = await api(`/entries/${entryId}`);
        const attachment = (entry.attachments || []).find((item) => String(item.id) === el.dataset.id);
        if (!attachment) throw new Error("找不到 PDF 附件");
        await window.fieldlogOpenPdfEditor(entryId, attachment);
      } catch (e) { showToast("開啟塗鴉失敗：" + e.message); }
    };
  });
  // Tier 2 深度處理：手動觸發，一次只處理使用者點的這一份 PDF
  document.querySelectorAll(".att-tier2-btn").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      const e = await api(`/entries/${entryId}`);
      const pdfAtt = (e.attachments || []).find((x) => String(x.id) === el.dataset.id);
      if (!pdfAtt) return;
      const existingPages = (e.attachments || []).filter((x) => x.source_pdf_id === pdfAtt.id);
      deepProcessPdf(entryId, pdfAtt, el, existingPages);
    };
  });
}

// ---------- 富文字記事內文（entries.body_format = 'html'）的圖片網址處理 ----------
// 存進資料庫的 HTML 絕對不能帶 ?pin=——那是跟 x-pin header 同一份、擁有完整 API
// 權限的主 PIN，燒進永久保存的內容比分享一次性檔案連結更嚴重。畫面上要顯示時
// 才動態補上，存檔前一定要剝掉。這裡假設檔案網址永遠是 `/api/file/{key}` 後面
// 最多接一個 `?pin=...`（app.js 全部檔案連結都是這個形狀，見 attHtml 等處）。
function injectFilePinForDisplay(html) {
  return html;
}
function stripFilePinForSave(html) {
  if (!html) return html;
  return html.replace(/(<img\b[^>]*\bsrc="\/api\/file\/[^"?]+)\?pin=[^"]*(")/gi, "$1$2");
}

// 把純文字 body 轉成安全轉義過的 HTML，換行變段落。用在兩個地方：載入還存成
// body_format='text' 的舊記事到富文字編輯器、以及合併記事時接上純文字來源。
// 跟 fieldlog/src/lib/richtext.js 的 textToHtml() 邏輯一致（那支是給後端 import
// 的 ES module，app.js 是一般 <script> 沒有 import，所以這裡另外寫一份同邏輯）。
function textToHtmlForEditor(text) {
  const escaped = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = escaped.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  return paragraphs.map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
}

// ---------- 上傳（含離線佇列保底）----------
async function putFile(entryId, blob, filename, offsetSecs, meta) {
  const headers = {
    "content-type": blob.type || "application/octet-stream",
    "x-pin": pin(),
    "x-entry-id": String(entryId),
    "x-filename": encodeURIComponent(filename),
  };
  if (offsetSecs !== null && offsetSecs !== undefined) headers["x-offset-secs"] = String(offsetSecs);
  if (meta?.durationSecs) headers["x-duration-secs"] = String(Math.round(meta.durationSecs));
  // Tier 2 深度處理：PDF 逐頁 render 成圖片時，帶回來源 PDF id 與頁碼
  if (meta && meta.sourcePdfId !== undefined && meta.sourcePdfId !== null) headers["x-source-pdf-id"] = String(meta.sourcePdfId);
  if (meta && meta.pageNo !== undefined && meta.pageNo !== null) headers["x-page-no"] = String(meta.pageNo);
  if (meta && meta.sourceUrl) headers["x-source-url"] = encodeURIComponent(meta.sourceUrl);
  const res = await fetch("/api/upload", { method: "POST", headers, body: blob });
  const responseBody = await res.json().catch(() => ({}));
  if (res.status === 409 && responseBody.duplicate) {
    return { ...responseBody, duplicate: true };
  }
  if (!res.ok) {
    throw new Error(responseBody.error || `HTTP ${res.status}`);
  }
  return responseBody;
}

// 標準文件常是從網路下載，之後可能發現只是節錄／預覽版（見 deriveExpectedPages
// 與 PREVIEW_SOURCE_DOMAINS）。上傳時順手問一句來源網址，選填、不擋流程，之後
// 才有辦法自動標「這可能是預覽站抓下來的」，不用靠人記住每份文件的來歷。
function isDocLikeFile(f) {
  return /\.(pdf|docx?|xlsx?|pptx?)$/i.test(f.name || "");
}

// 從桌面拖檔案／照片進來直接上傳，不用先點「上傳」再選檔。用
// dataTransfer.types 判斷是不是真的在拖 OS 檔案，避免跟站內自己的拖曳
// （拖記事去合併、拖檔案去搬資料夾…那些用的是自訂 MIME type）互相干擾。
function setupFileDropZone(el, onFiles) {
  if (!el) return;
  const isFileDrag = (ev) => Array.from(ev.dataTransfer?.types || []).includes("Files");
  el.ondragover = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    el.classList.add("file-drag-over");
  };
  el.ondragleave = (ev) => {
    if (ev.target === el) el.classList.remove("file-drag-over");
  };
  el.ondrop = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.classList.remove("file-drag-over");
    const files = Array.from(ev.dataTransfer.files || []);
    if (files.length) onFiles(files);
  };
}

async function uploadFiles(entryId, files) {
  if (!files || !files.length) return;
  const status = $("e-upload-status");
  const sourceUrl = files.some(isDocLikeFile)
    ? (prompt("這份文件的來源網址（選填，例如標準官網的下載頁；之後可用來提醒可能是節錄版）：") || "").trim()
    : "";
  let done = 0;
  let duplicates = 0;
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { showToast(`${f.name} 超過 50MB，略過`); continue; }
    if (status) status.textContent = `上傳中…（${done + 1}/${files.length}）`;
    const meta = sourceUrl && isDocLikeFile(f) ? { sourceUrl } : null;
    try {
      const uploaded = await putFile(entryId, f, f.name, null, meta);
      if (uploaded.duplicate) duplicates++; else done++;
    }
    catch { await queueFile(entryId, f, f.name, null); done++; }
  }
  if (status) status.textContent = "";
  showToast(`已上傳 ${done} 個檔案${duplicates ? `，略過 ${duplicates} 個重複檔案` : ""}`);
  openEntry(entryId);
}

// 富文字記事的編輯框：拖圖片進來直接插進游標位置（跟 Word 一樣），不是只掛在
// 附件清單下面；非圖片檔（PDF、錄音…）維持原本「附件」流程，走 uploadFiles
// 既有的整批上傳＋略過重複＋離線佇列，這裡不重複實作一次。
function setupRichImageDropZone(el, entryId) {
  if (!el) return;
  const isFileDrag = (ev) => Array.from(ev.dataTransfer?.types || []).includes("Files");
  el.ondragover = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation(); // 蓋掉外層 entry-modal 的拖放區，避免同一次拖放被處理兩次
    ev.dataTransfer.dropEffect = "copy";
  };
  el.ondrop = (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const files = Array.from(ev.dataTransfer.files || []);
    if (files.length) insertFilesIntoRichEditor(entryId, el, files);
  };
}

async function insertFilesIntoRichEditor(entryId, editorEl, files) {
  const images = files.filter((f) => (f.type || "").startsWith("image/"));
  const others = files.filter((f) => !(f.type || "").startsWith("image/"));
  for (const f of images) {
    if (f.size > 50 * 1024 * 1024) { showToast(`${f.name} 超過 50MB，已略過`); continue; }
    try {
      const uploaded = await putFile(entryId, f, f.name, null);
      if (uploaded.duplicate) { showToast(`${f.name} 是重複檔案，已略過`); continue; }
      const url = fileUrlForKey(uploaded.key);
      window.fieldlogRichEditor?.insertImage(editorEl, url, uploaded.id);
      await refreshEntryAttachmentsPanel(entryId);
    } catch (err) { showToast(`${f.name} 上傳失敗：${err.message}`); }
  }
  // 非圖片走既有附件上傳流程；uploadFiles 結尾會整個重開記事，不能跟上面
  // 插圖流程共用同一輪迴圈（插圖故意不整個重開，才不會把正在打的字沖掉）
  if (others.length) uploadFiles(entryId, others);
}

// 插圖後只重畫附件清單那一小塊（沿用附件卡片跟按鈕綁定邏輯），不整個重開
// 記事——重開會把 Quill 編輯框裡還沒存檔的內容整個蓋掉
async function refreshEntryAttachmentsPanel(entryId) {
  const panel = $("e-attachments");
  if (!panel) return;
  const fresh = await api(`/entries/${entryId}`);
  const visible = (fresh.attachments || []).filter((a) => !a.source_pdf_id);
  panel.innerHTML = visible.map((a) => attHtml(a, fresh.attachments)).join("") || `<p class="sub">尚無附件</p>`;
  bindAttActions(entryId);
}

// 離線佇列：IndexedDB 先存後傳（沿用 Medtec 驗證過的模式）
const FILE_DB = "fieldlog_pending";
function openFileDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pending", { keyPath: "tmp_id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueFile(entryId, blob, filename, offsetSecs, meta = null) {
  const db = await openFileDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("pending", "readwrite");
    tx.objectStore("pending").put({
      tmp_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      entry_id: entryId, filename, offset_secs: offsetSecs, blob,
      // durationSecs 是自動轉錄的安全估算依據；舊版在離線補傳時把它丟掉，
      // 導致音檔雖然補傳成功，仍永遠不會進入自動轉錄候選。
      meta: meta || null,
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function pendingFilesForEntry(entryId) {
  let db;
  try { db = await openFileDB(); } catch { return []; }
  return new Promise((resolve) => {
    const req = db.transaction("pending", "readonly").objectStore("pending").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((f) => Number(f.entry_id) === Number(entryId)));
    req.onerror = () => resolve([]);
  });
}

async function syncPendingFiles({ entryId = null } = {}) {
  if (!navigator.onLine) return { synced: 0, pending: 0, error: "目前沒有網路" };
  let db;
  try { db = await openFileDB(); } catch (err) { return { synced: 0, pending: 0, error: err.message }; }
  const all = await new Promise((resolve) => {
    const req = db.transaction("pending", "readonly").objectStore("pending").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  const targets = entryId === null ? all : all.filter((f) => Number(f.entry_id) === Number(entryId));
  let synced = 0;
  let lastError = "";
  for (const f of targets) {
    try {
      await putFile(f.entry_id, f.blob, f.filename, f.offset_secs, f.meta || null);
      await new Promise((resolve) => {
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").delete(f.tmp_id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      synced++;
    } catch (err) {
      lastError = err.message || "上傳失敗";
      break;
    }
  }
  if (synced) showToast(`已補傳 ${synced} 個離線檔案`);
  return { synced, pending: Math.max(0, targets.length - synced), error: lastError };
}

// ---------- 現場採集：錄影／拍照／錄音是三個獨立入口，不互相綁定 ----------
// 各自獨立的理由：按「拍照」不該順便開始錄音；按「錄音」也不該
// 順便打開鏡頭全螢幕——只有按「錄影」才是真的要錄影。
// 拍照永遠要看得到即時畫面才拍（不做隱藏鏡頭盲拍那套）。
const SEG_MINUTES = 10;
// 跟錄影分段用同一個單位（10 分鐘），不要各自寫一個數字之後兜不起來
const AUDIO_LIVE_SEG_SECONDS = SEG_MINUTES * 60;
// 定期要求 MediaRecorder 交出資料。這不會切斷音檔；所有 chunk 最後仍會合成同一段。
// 好處是切到背景前後都能持續看到 dataavailable，並降低瀏覽器突然凍結頁面時，
// 尚未交給 JavaScript 的錄音資料量。timeslice 不是背景錄音保證，真正的中斷仍由
// MediaStreamTrack mute/ended 與回前台重取麥克風處理。
const AUDIO_DATA_SLICE_MS = 5000;
// 換下一段錄音時，新的一段提前這麼多毫秒先開始收音，跟舊的一段重疊一下再收尾舊的
// （見 rotateAudioSegment）——比起先收尾舊的、才開始收新的，重疊比空隙安全：
// 頂多兩段音檔開頭/結尾多重複這一小段，不會真的漏錄。
const AUDIO_SEG_OVERLAP_MS = 800;
// ===== 2026-08-18 架構重寫：錄音改走 Web Audio 中繼 =====
//
// 四個版本（v118–v121）修背景錄音全部失敗，把失敗現象放在一起看，指向同一件事：
// 這類機器（Windows Chrome）上的麥克風音軌會變成「殭屍」——readyState=live、
// muted=false、recorder 照樣吐資料，但樣本內容是數位零。所有靠「狀態旗標」的
// 偵測（v118 的資料探測、v121 的 stillAlive）都會被它騙過；而唯一有效的恢復
// （重新 getUserMedia）在舊架構下必須重建 MediaRecorder，每重建一次就剁一段、
// 掉幾秒音訊（實測 214 秒被剁成 6 段、只錄到 107 秒）。
//
// 新架構把「換麥克風」跟「錄音檔」脫鉤：
//
//   麥克風 stream ──▶ MediaStreamSource ──┬─▶ AnalyserNode（量測真實音量）
//     （死了就換這個，換幾次都免費）        └─▶ MediaStreamDestination ──▶ MediaRecorder
//                                             （這條 stream 永遠不換 → 檔案永遠連續）
//
// - MediaRecorder 錄的是 AudioContext 的 destination stream，從錄音開始到結束
//   都是同一條，不因任何麥克風事故換段。分段只剩正常的 10 分鐘輪替。
// - 偵測不再看旗標，看 AnalyserNode 量到的實際樣本：真實麥克風連安靜房間都有
//   底噪，持續「精確全零」＝音軌死了，自動換上新的 getUserMedia 訊號源。
// - 換源是無縫的（先接新的、再拔舊的），換錯了也零成本——所以可以大膽換。
// - 無訊號期間檔案裡是等長的靜音：時間軸保持連續，事後聽得出「這裡斷過多久」，
//   並寫警示進記事。若作業系統整段拒絕給音訊（背景鎖麥），網頁端無解，但至少
//   誠實呈現，不再假裝有錄。
const AUDIO_CONSTRAINTS = {
  audio: {
    // 回音消除／降噪／自動增益是「通話」用的處理管線：會吃掉環境語音，且在
    // Windows 上走 communications 裝置路徑，更容易被其他 App（Teams/Line 等）
    // 的搶佔弄壞。現場錄音要的是原始收音，Whisper 對原始音訊的辨識也更穩。
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};
// 這個音量以上視為「有訊號」。真實麥克風的底噪 peak 通常 >0.001；殭屍音軌給的
// 是精確的 0。門檻抓低一點，安靜房間不會誤判。
const AUDIO_SIGNAL_FLOOR = 1e-4;
// 連續全零多久才判定音軌死亡。太短會在硬體靜音鍵、拔插裝置的瞬間誤觸發；
// 反正換源免費，5 秒是「確定不是巧合」跟「少漏錄」的折衷。
const AUDIO_DEAD_SIGNAL_MS = 5000;
// 兩次換源之間的最短間隔：麥克風被硬體靜音（實體 mute 鍵）時換源救不回來，
// 節流避免無意義地反覆要裝置。
const AUDIO_MIN_SWAP_INTERVAL_MS = 15000;
// 錄音浮動列的音量指示更新頻率（僅前景時跑）
const AUDIO_METER_TICK_MS = 150;
// 換源時重取 getUserMedia 的重試次數／退避基數，吃掉「裝置剛釋放、系統還沒
// 反應過來」這類瞬時失敗
const AUDIO_RECOVERY_ATTEMPTS = 3;
const AUDIO_RECOVERY_RETRY_MS = 600;
// 剛取得的新音軌可能短暫 muted、幾百毫秒後才送 unmute，給它這段喚醒時間
const AUDIO_MUTE_GRACE_MS = 3000;
// 驗收一條候選音軌要量多久才敢說「這條是靜音」。量到訊號會立刻提早結束。
const AUDIO_PROBE_MS = 900;
// 2026-08-19：分貝計（純 AnalyserNode 讀值）錄音正常，但 fieldlog 錄出來的檔案
// 仍是整段 Thank you——代表訊號監測看到的「圖上有沒有訊號」跟「MediaRecorder
// 真的編碼進檔案的東西」是兩回事，之前的訊號偵測完全沒有涵蓋到編碼這一段。
// opus／AAC 對純靜音的壓縮率極高，真人講話的位元組率跟靜音差好幾倍，所以拿
// 「這一段實際編碼出來的檔案大小」當作跟訊號偵測互補、獨立的第二判準：這個
// 數字量的是真正寫進檔案的東西，不是圖上的即時讀值，兩者可能不同步失敗。
const AUDIO_SILENT_BYTES_PER_SEC = 400;

function segOffset(session) { return Math.floor((Date.now() - session.startedAt) / 1000); }

/**
 * 待分類系統容器的 id（沒有就請後端建一個）。它不計入四層資料夾樹。
 */
async function stagingFolderId() {
  // 快取的 id 要先確認系統容器還在，避免拿舊 id 建出孤兒記事。
  if (STAGING_FOLDER_ID && FOLDERS.some((f) => Number(f.id) === Number(STAGING_FOLDER_ID))) return STAGING_FOLDER_ID;
  STAGING_FOLDER_ID = null;
  try {
    const result = await api("/staging", { method: "POST", body: "{}" });
    STAGING_FOLDER_ID = Number(result.id);
    FOLDERS = await api("/folders");
    return STAGING_FOLDER_ID;
  } catch {
    return null; // 建不出來就退回 folder_id=null，採集本身不能被分類卡住
  }
}

async function ensureEntryForCapture(entryId, titlePrefix) {
  if (entryId) return { entryId, folderId: CURRENT_FOLDER ? CURRENT_FOLDER.id : null };
  // 沒指定 entryId 時，若已有進行中的錄音／錄影，併入同一次採集——例如
  // 錄音中誤按主畫面較顯眼的「📷 拍照」，而不是浮動列裡的小相機鈕
  const active = AUDIO || VIDEO;
  if (active) return { entryId: active.entryId, folderId: active.folderId };
  // 在資料夾裡採集＝當下就選好位置；從首頁採集則先進待分類。
  const folderId = CURRENT_FOLDER ? CURRENT_FOLDER.id : await stagingFolderId();
  const d = new Date();
  const title = `${titlePrefix} ${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const newId = await createEntry(folderId, title);
  return { entryId: newId, folderId };
}

// 採集中「記一句」：走後端的原子附加端點（POST /entries/:id/notes）。
// 刻意不用「讀出 body → 前端串接 → 整段寫回」——連續記好幾句時，只要有一次
// 請求交錯，後寫回的那次就會拿舊 body 蓋掉前一句。後端用一句 SQL 完成附加。
async function addTimedNote(session) {
  if (!session) return;
  const text = prompt("記一句（會標上目前的時間點）：");
  if (!text || !text.trim()) return;
  const line = `[${fmtSecs(segOffset(session))}] ${text.trim()}`;
  try {
    await api(`/entries/${session.entryId}/notes`, { method: "POST", body: JSON.stringify({ line }) });
    showToast("已記錄");
  } catch (err) { showToast("記錄失敗：" + err.message); }
}

// ---- 資料夾／專案歸屬 chip：video/photo 兩個全螢幕模式共用同一套邏輯 ----
function folderChipLabel(folderId) {
  const folder = folderId ? FOLDERS.find((f) => f.id === folderId) : null;
  if (!folder) return "⏳ 待分類（點我分類）";
  if (folder.role === "staging") return "⏳ 待分類（點我分類）";
  return `📂 ${folder.name}`;
}

async function createFolderInline() {
  const details = await askFolderDetails({ title: "拍攝到新資料夾", desc: "建立後會自動選取這個資料夾" });
  if (!details) return undefined;
  const r = await api("/folders", { method: "POST", body: JSON.stringify(details) });
  FOLDERS = await api("/folders");
  return r.id;
}

function setupFolderChip(chipId, pickerId, getSession) {
  const chip = $(chipId);
  const picker = $(pickerId);
  chip.onclick = () => {
    if (picker.style.display === "block") { picker.style.display = "none"; return; }
    // 四層架構下用一串沒縮排的平清單根本分不出「同名的是哪一個分支」，
    // 這裡跟搬移用的選擇器一樣列成樹狀並縮排
    picker.innerHTML = [
      `<div class="cfp-item cfp-staging" data-staging="1">⏳ 待分類（之後再移動）</div>`,
      ...folderTreeOrdered()
        .filter(({ folder }) => folder.role !== "staging")
        .map(({ folder, depth }) =>
          `<div class="cfp-item" data-id="${folder.id}" style="padding-left:${12 + depth * 16}px">${depth ? "📁" : "📂"} ${esc(folder.name)}</div>`),
      `<div class="cfp-item cfp-new" data-new="1">＋ 新資料夾</div>`,
    ].join("");
    picker.querySelectorAll(".cfp-item").forEach((el) => {
      el.onclick = async () => {
        picker.style.display = "none";
        const session = getSession();
        if (!session) return;
        let folderId = el.dataset.id ? Number(el.dataset.id) : null;
        if (el.dataset.staging) folderId = await stagingFolderId();
        if (el.dataset.new) {
          const created = await createFolderInline();
          if (created === undefined) return;
          folderId = created;
        }
        try {
          await api(`/entries/${session.entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: folderId }) });
          session.folderId = folderId;
          chip.textContent = folderChipLabel(folderId);
        } catch (err) { showToast("分類失敗：" + err.message); }
      };
    });
    picker.style.display = "block";
  };
}

// ================= 🎥 錄影（開鏡頭，錄音+錄影全螢幕） =================
let VIDEO = null;

function startVideoSegRecorder() {
  const audioTrack = new MediaStream(VIDEO.stream.getAudioTracks());
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = mimeType ? new MediaRecorder(audioTrack, { mimeType }) : new MediaRecorder(audioTrack);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onVideoSegmentStop(recorder, chunks);
  VIDEO.recorder = recorder;
  VIDEO.segStartMs = Date.now();
  recorder.start();
}

async function startVideo(entryId) {
  if (VIDEO) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { showToast("這個瀏覽器不支援錄影"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true,
    });
  } catch (err) { showToast("無法開啟相機或麥克風：" + err.message); return; }
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "錄影"); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); showToast("無法建立紀錄：" + err.message); return; }
  $("capture-video").srcObject = stream;
  VIDEO = { stream, recorder: null, startedAt: Date.now(), segIndex: 1, segStartMs: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId, ending: false, autoStopped: false, timerId: 0 };
  startVideoSegRecorder();
  $("capture-count").textContent = "";
  $("capture-timer").textContent = "00:00";
  $("capture-folder-chip").textContent = folderChipLabel(VIDEO.folderId);
  $("capture-overlay").style.display = "flex";
  VIDEO.timerId = setInterval(() => {
    if (!VIDEO || VIDEO.ending) return;
    $("capture-timer").textContent = fmtSecs(segOffset(VIDEO));
    if (VIDEO.recorder.state === "recording" && Date.now() - VIDEO.segStartMs >= SEG_MINUTES * 60 * 1000) {
      VIDEO.recorder.stop();
    }
  }, 1000);
}

async function videoSnap() {
  if (!VIDEO) return;
  const video = $("capture-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const offset = segOffset(VIDEO);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("capture-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  VIDEO.photos++;
  $("capture-count").textContent = `📷 ${VIDEO.photos}`;
  const { entryId } = VIDEO;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${fmtSecs(offset).replace(":", "")}.jpg`;
  try { await putFile(entryId, blob, filename, offset); }
  catch { await queueFile(entryId, blob, filename, offset); showToast("網路不穩，照片先存手機"); }
}

function stopVideo() {
  if (!VIDEO) return;
  VIDEO.ending = true;
  if (VIDEO.recorder && VIDEO.recorder.state !== "inactive") VIDEO.recorder.stop();
}

async function onVideoSegmentStop(recorder, chunks) {
  if (!VIDEO) return;
  const { stream, entryId, photos, timerId, ending, autoStopped, segIndex, segStartMs, startedAt, folderId } = VIDEO;
  const segStartOffset = Math.floor((segStartMs - startedAt) / 1000);
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `錄影音軌-段${segIndex}.${ext}`;

  if (ending) {
    clearInterval(timerId);
    stream.getTracks().forEach((t) => t.stop());
    $("capture-video").srcObject = null;
    $("capture-folder-picker").style.display = "none";
    $("capture-overlay").style.display = "none";
    VIDEO = null;
    if (blob.size) {
      showToast(autoStopped ? "偵測到切換 App，已自動結束並存檔" : "錄影中的錄音上傳中…");
      try { await putFile(entryId, blob, filename, segStartOffset); }
      catch { await queueFile(entryId, blob, filename, segStartOffset); }
    }
    showToast(`錄影完成：錄音 ${segIndex} 段＋照片 ${photos} 張`);
    if (CURRENT_FOLDER && folderId === CURRENT_FOLDER.id) openFolder(CURRENT_FOLDER.id);
    else { loadRecent(); loadFolders(); }
    openEntry(entryId);
  } else {
    VIDEO.segIndex++;
    startVideoSegRecorder();
    if (blob.size) {
      putFile(entryId, blob, filename, segStartOffset)
        .catch(() => queueFile(entryId, blob, filename, segStartOffset));
    }
  }
}

// ================= 📷 拍照（單獨鏡頭，不錄音） =================
let PHOTO = null;

async function startPhoto(entryId) {
  if (PHOTO) return;
  if (!navigator.mediaDevices) { showToast("這個瀏覽器不支援拍照"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "拍照"); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); showToast("無法建立紀錄：" + err.message); return; }
  $("photo-video").srcObject = stream;
  PHOTO = { stream, startedAt: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId };
  $("photo-count").textContent = "";
  $("photo-folder-chip").textContent = folderChipLabel(PHOTO.folderId);
  $("photo-overlay").style.display = "flex";
}

async function photoSnap() {
  if (!PHOTO) return;
  const video = $("photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("photo-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  PHOTO.photos++;
  $("photo-count").textContent = `📷 ${PHOTO.photos}`;
  const { entryId } = PHOTO;
  // 若這筆紀事剛好是進行中的錄音／錄影，offset 要照它的時間軸算，跟
  // audioPhotoSnap／videoSnap 的既有作法一致，逐字稿才能對得上這張照片
  const session = (AUDIO && AUDIO.entryId === entryId) ? AUDIO
    : (VIDEO && VIDEO.entryId === entryId) ? VIDEO : null;
  const offset = session ? segOffset(session) : null;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${Date.now()}.jpg`;
  try { await putFile(entryId, blob, filename, offset); }
  catch { await queueFile(entryId, blob, filename, offset); showToast("網路不穩，照片先存手機"); }
}

function finishPhoto() {
  if (!PHOTO) return;
  const { stream, entryId, photos, folderId } = PHOTO;
  stream.getTracks().forEach((t) => t.stop());
  $("photo-video").srcObject = null;
  $("photo-folder-picker").style.display = "none";
  $("photo-overlay").style.display = "none";
  PHOTO = null;
  if (photos) showToast(`已拍 ${photos} 張`);
  if (CURRENT_FOLDER && folderId === CURRENT_FOLDER.id) openFolder(CURRENT_FOLDER.id);
  else { loadRecent(); loadFolders(); }
  if (photos) openEntry(entryId);
}

// ================= 🎙 錄音（不開鏡頭；浮動控制列，拍照時才臨時開鏡頭預覽） =================
let AUDIO = null;

function setAudioStatus(text = "", interrupted = false) {
  const el = $("audio-status");
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("interrupted", interrupted);
}

function resetAudioLiveTranscript() {
  const el = $("audio-live-transcript");
  el.innerHTML = "";
  el.hidden = true;
}

function appendAudioLiveTranscripts(items = []) {
  if (!AUDIO || !items.length) return;
  AUDIO.liveLines.push(...items.filter((item) => (item.text || "").trim()));
  AUDIO.liveLines = AUDIO.liveLines.slice(-6); // 浮動列只留最近六段，完整內容仍存於記事
  const el = $("audio-live-transcript");
  el.innerHTML = `<strong>即時逐字稿</strong>${AUDIO.liveLines.map((item) =>
    `<p><time>${fmtSecs(Number(item.offsetSecs || 0))}</time>${esc(item.text)}</p>`
  ).join("")}`;
  el.hidden = !AUDIO.liveLines.length;
  el.scrollTop = el.scrollHeight;
}

function startAudioSegRecorder() {
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  // 2026-08-19：改回直接錄麥克風原始 stream（audioRecordStream() = AUDIO.stream）
  // ——跟錄影一律直接錄 track、不經過 AudioContext 是同一招。原本讓 recorder
  // 錄 Web Audio 的 destination stream 是為了讓換源不用重建 recorder，但使用者
  // 用同一台機器測「錄影有聲音、錄音沒聲音」，兩者差異就只有這層收音圖中繼
  // ——這是目前唯一有實測證據支持的假說，換源因此改回「開新段」（見
  // attemptMicSwap 的 overlap 技巧，不是重建整個 recorder，不會掉音訊）。
  const recStream = audioRecordStream();
  const recorder = mimeType ? new MediaRecorder(recStream, { mimeType }) : new MediaRecorder(recStream);
  const chunks = [];
  // 把這一段的中繼資料快照進閉包，不在 onstop 時才去讀 AUDIO——這樣「背景被系統中斷
  // 的舊 recorder」與「前台回復時接續的新 recorder」不會互相搶 segIndex/offset。
  const seg = { index: AUDIO.segIndex, startOffset: Math.floor((Date.now() - AUDIO.startedAt) / 1000), entryId: AUDIO.entryId, startedAt: Date.now() };
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onerror = () => {
    if (!AUDIO || AUDIO.recorder !== recorder || AUDIO.ending) return;
    AUDIO.recorderFailed = true;
    if (!document.hidden) resumeAudioOnForeground();
  };
  recorder.onstop = () => onAudioSegmentStop(recorder, chunks, seg);
  AUDIO.recorder = recorder;
  AUDIO.segStartMs = Date.now();
  recorder.start(AUDIO_DATA_SLICE_MS);
  return recorder;
}

// 音軌的 mute/ended 事件只當「線索」，不當「判決」：mute 常是一瞬間，真死了
// 訊號監測（checkMicSignal 的全零判定）自然會量到。這裡只把死亡計時提前起跑，
// 並排一次稍後的複查，讓背景→前景之間的死亡也能盡快被接住。
function watchAudioStream(stream) {
  for (const track of stream.getAudioTracks()) {
    const onTrouble = () => {
      if (!AUDIO || AUDIO.stream !== stream || AUDIO.ending) return;
      AUDIO.deadSince ||= Date.now();
      clearTimeout(AUDIO.recheckTimer);
      AUDIO.recheckTimer = setTimeout(() => {
        if (AUDIO && !AUDIO.ending) checkMicSignal();
      }, AUDIO_DEAD_SIGNAL_MS + 200);
    };
    track.addEventListener("mute", onTrouble);
    track.addEventListener("ended", onTrouble);
  }
}

// 等音軌真的可用（live 且非 muted）。已經可用就立刻回 true；全部 ended 立刻
// 回 false；否則監聽 unmute／ended，最多等 timeoutMs。
// （這個等待在 8/16 版就存在過，用意是對的；我 8/18 為了拔掉別的問題把它一起
// 刪掉，是矯枉過正——沒有它，一次瞬間的 muted 就會被當成錄音報廢。）
function waitForTrackUsable(stream, timeoutMs) {
  const tracks = stream?.getAudioTracks?.() || [];
  if (!tracks.length) return Promise.resolve(false);
  if (tracks.some((t) => t.readyState === "live" && !t.muted)) return Promise.resolve(true);
  if (tracks.every((t) => t.readyState === "ended")) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timerId = 0;
    let settled = false;
    const finish = (usable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      for (const t of tracks) {
        t.removeEventListener("unmute", check);
        t.removeEventListener("ended", check);
      }
      resolve(usable);
    };
    const check = () => {
      if (tracks.some((t) => t.readyState === "live" && !t.muted)) finish(true);
      else if (tracks.every((t) => t.readyState === "ended")) finish(false);
    };
    for (const t of tracks) {
      t.addEventListener("unmute", check);
      t.addEventListener("ended", check);
    }
    timerId = setTimeout(() => finish(false), timeoutMs);
  });
}

// 換下一段：同一個麥克風 stream 可以同時被兩個 MediaRecorder 消費，不會互相
// 干擾——先讓新的一段開始收音，過 AUDIO_SEG_OVERLAP_MS 才收尾舊的那個
// recorder，兩段音檔會有一小段重疊，但中間不會出現真正收不到音的空隙。
// （舊寫法是「先 stop 舊的，onstop 觸發後才 start 新的」，中間有個小空隙。）
function rotateAudioSegment() {
  const oldRecorder = AUDIO.recorder;
  AUDIO.segIndex++;
  startAudioSegRecorder();
  setTimeout(() => {
    try { if (oldRecorder.state !== "inactive") oldRecorder.stop(); } catch {}
  }, AUDIO_SEG_OVERLAP_MS);
}

async function startAudio(entryId) {
  if (AUDIO) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { showToast("這個瀏覽器不支援錄音"); return; }
  // 開錄前先驗聲：真實麥克風連安靜房間都有底噪，量到精確全零就是收不到聲音。
  // 寧可在這裡花一秒鐘擋下來，也不要錄完 40 分鐘才發現整段是空的。
  let mic;
  try { mic = await acquireLiveMic(null); }
  catch (err) { showToast("無法開啟麥克風：" + err.message); return; }
  if (mic.silent && !confirm(
    "⚠️ 麥克風目前收不到任何聲音（音量是 0）。\n\n" +
    "這台電腦上每一個收音裝置都試過了，全部都是靜音。常見原因：Windows 音效設定裡麥克風被靜音、筆電實體靜音鍵、或被其他程式（Teams／Line／Zoom）佔用。\n\n" +
    "按「確定」仍要開始錄音（很可能整段都是空的）；建議按「取消」先處理好麥克風再錄。"
  )) { stopStream(mic.stream); return; }
  const stream = mic.stream;
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "錄音"); }
  catch (err) { stopStream(stream); showToast("無法建立紀錄：" + err.message); return; }
  AUDIO = { stream, micDeviceId: mic.deviceId, recorder: null, startedAt: Date.now(), segIndex: 1, segStartMs: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId, ending: false, autoStopped: false, timerId: 0, backgroundAt: 0, backgroundSecs: 0, interrupted: false, resuming: false, recorderFailed: false, recheckTimer: 0, audioCtx: null, analyser: null, micSource: null, deadSince: 0, lastSignalAt: Date.now(), lastSwapAt: 0, swapping: false, meterTimer: 0, diagPeakMax: 0, diagWarnedThisDeath: false, liveLines: [], liveTranscriptionStopped: false, silentSegStreak: 0, uploadedSegments: 0, pendingSegments: 0, emptySegments: 0 };
  initAudioGraph();
  watchAudioStream(stream);
  startAudioSegRecorder();
  startAudioMeter();
  setAudioStatus();
  resetAudioLiveTranscript();
  $("audio-timer").textContent = "00:00";
  $("audio-badge").style.display = "flex";
  AUDIO.timerId = setInterval(() => {
    if (!AUDIO || AUDIO.ending) return;
    $("audio-timer").textContent = fmtSecs(segOffset(AUDIO));
    checkMicSignal();
    if (AUDIO.recorder.state === "recording" && Date.now() - AUDIO.segStartMs >= AUDIO_LIVE_SEG_SECONDS * 1000) {
      rotateAudioSegment();
    }
  }, 1000);
}

function stopAudio() {
  if (!AUDIO) return;
  AUDIO.ending = true;
  if (AUDIO.recorder && AUDIO.recorder.state !== "inactive") {
    AUDIO.recorder.stop(); // → onstop 走 ending 收尾路徑（會上傳最後一段）
  } else {
    finalizeAudioStop(); // recorder 已被系統停掉（背景中斷）：沒有新段可傳，直接收尾
  }
}

// 收尾：關麥克風、藏浮動列、跳完成提示、重開紀錄。stopAudio 與 onstop 收尾路徑共用
function finalizeAudioStop() {
  if (!AUDIO) return;
  const { stream, timerId, recheckTimer, meterTimer, micSource, audioCtx, photos, entryId, segIndex, diagPeakMax, uploadedSegments, pendingSegments, emptySegments } = AUDIO;
  clearInterval(timerId);
  clearInterval(meterTimer);
  clearTimeout(recheckTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  try { micSource?.disconnect(); } catch {}
  try { audioCtx?.close(); } catch {}
  $("audio-badge").style.display = "none";
  setAudioStatus();
  resetAudioLiveTranscript();
  AUDIO = null;
  const diagBit = diagPeakMax !== undefined
    ? (diagPeakMax > AUDIO_SIGNAL_FLOOR
        ? ""
        : "　⚠️ 全程量到的最高音量是 0，這段錄音可能整個是靜音，建議先播放確認再離開")
    : "";
  const savedBit = uploadedSegments ? `已上傳 ${uploadedSegments} 段` : "尚無已上傳音檔";
  const pendingBit = pendingSegments ? `，${pendingSegments} 段暫存在本機待補傳` : "";
  const emptyBit = emptySegments ? `，${emptySegments} 段未產生音檔` : "";
  showToast(`錄音結束：${savedBit}${pendingBit}${emptyBit}${photos ? `＋照片 ${photos} 張` : ""}${diagBit}`);
  openEntry(entryId);
}

async function onAudioSegmentStop(recorder, chunks, seg) {
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `錄音-段${seg.index}.${ext}`;
  const durationSecs = Math.max(1, Math.ceil((Date.now() - seg.startedAt) / 1000));

  // 這一段實際編碼出來的位元組率——量的是真的寫進檔案的東西，跟訊號監測（圖上
  // 即時讀值）是兩條獨立的判準，兩者可能不同步失敗（分貝計正常≠錄音檔有聲音）。
  // 2026-08-19：錄音已改回直接錄麥克風原始 stream（不再有收音圖可以「切換」），
  // 這裡純粹留診斷記錄，讓「訊號表顯示有音量但檔案其實是空的」這種情況第一次
  // 變成看得到、可驗證的——如果切換架構後這個警告還會出現，代表問題不在收音
  // 中繼，要往 MediaRecorder 編碼器或更底層查。
  if (AUDIO && AUDIO.recorder === recorder && blob.size / durationSecs < AUDIO_SILENT_BYTES_PER_SEC) {
    AUDIO.silentSegStreak = (AUDIO.silentSegStreak || 0) + 1;
    const bps = Math.round(blob.size / durationSecs);
    noteAudioInterruption(seg.entryId,
      `🔬 診斷：第 ${seg.index} 段編碼後只有約 ${bps} bytes/秒（正常人聲通常有數千 bytes/秒），這段錄音檔可能是靜音，即使當時訊號表顯示有音量。`);
  } else if (AUDIO && AUDIO.recorder === recorder) {
    AUDIO.silentSegStreak = 0;
  }

  const uploadSeg = async () => {
    if (!blob.size) {
      if (AUDIO) AUDIO.emptySegments = (AUDIO.emptySegments || 0) + 1;
      await noteAudioInterruption(seg.entryId, `⛔ 第 ${seg.index} 段未產生錄音檔（0 bytes），無法播放或轉錄。`);
      return;
    }
    try {
      await putFile(seg.entryId, blob, filename, seg.startOffset, { durationSecs });
      if (AUDIO) AUDIO.uploadedSegments = (AUDIO.uploadedSegments || 0) + 1;
    }
    catch {
      await queueFile(seg.entryId, blob, filename, seg.startOffset, { durationSecs });
      if (AUDIO) AUDIO.pendingSegments = (AUDIO.pendingSegments || 0) + 1;
      return;
    }
    // 錄音仍持續時才做準即時轉錄；最後一段由記事頁的既有安全流程接手。
    if (AUDIO && !AUDIO.ending && AUDIO.entryId === seg.entryId && !AUDIO.liveTranscriptionStopped && navigator.onLine) {
      try {
        const result = await api(`/entries/${seg.entryId}/auto-transcribe`, { method: "POST", body: "{}" });
        appendAudioLiveTranscripts(result.transcripts || []);
        if (result.stopped) {
          AUDIO.liveTranscriptionStopped = true;
          setAudioStatus(`即時轉錄已停止：${result.reason || "額度保護已啟動"}`, true);
        }
      } catch (err) {
        // 音檔已成功保存；轉錄失敗絕不把同一音檔再排入上傳佇列，避免重複附件。
        if (AUDIO && /429|budget|額度|上限|費用/i.test(err.message || "")) AUDIO.liveTranscriptionStopped = true;
        if (AUDIO) setAudioStatus(`即時轉錄暫停：${err.message}`, true);
      }
    }
  };

  // AUDIO 已整個結束（stopAudio 收尾時把 AUDIO 設成 null）：這是最後一段，只上傳
  if (!AUDIO) { await uploadSeg(); return; }

  // 只有「仍是當前 recorder」的 onstop 才負責收尾或接續下一段——避免背景中被系統
  // 停掉的舊 recorder，其延遲觸發的 onstop 跟前台回復時已接續的新 recorder 重複啟動
  const isCurrent = AUDIO.recorder === recorder;

  if (AUDIO.ending && isCurrent) {
    if (blob.size) showToast(AUDIO.autoStopped ? "頁面關閉，已自動存檔" : "錄音上傳中…");
    await uploadSeg();
    finalizeAudioStop();
    return;
  }

  // 一般段落輪替，或背景中被系統停掉：仍是當前 recorder 才接續下一段
  if (isCurrent && !AUDIO.ending && !document.hidden && !AUDIO.resuming) {
    AUDIO.segIndex++;
    startAudioSegRecorder();
  }
  await uploadSeg();
}

// 中斷這件事要留在記事裡，不能只靠浮動列上一閃而過的提示——事後回顧記事
// 才是真正會發現「怎麼接不上」的時候，那時浮動列早就不在了。寫失敗（離線／
// 網路不穩）就算了，不影響錄音本身，安靜略過即可。
async function noteAudioInterruption(entryId, line) {
  try { await api(`/entries/${entryId}/notes`, { method: "POST", body: JSON.stringify({ line }) }); }
  catch {}
}

// ---------- 取得「真的收得到聲音」的麥克風 ----------
//
// 2026-08-19：v122／v123 把換源做到無縫了，實測卻仍然整段靜音，而診斷埋點顯示
// 「換源後立即量測 peak 依然是 0」。原因在這裡：舊的換源是重新
// getUserMedia(AUDIO_CONSTRAINTS)——沒有指定 deviceId，拿回來的永遠是同一個
// 系統預設裝置。Windows 的預設／communications 裝置被別的程式（Teams／Line／
// Zoom）搶佔或驅動卡住之後就會固定吐數位零，再要一百次也還是那條殭屍。
// 所以換源必須換到「不同的實體裝置」，而且每一條候選都要先量過真的有樣本
// 才敢採用——「拿得到 track 物件」從來就不等於「收得到聲音」。

function stopStream(stream) {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
}

function micDeviceIdOf(stream) {
  try { return stream?.getAudioTracks()[0]?.getSettings?.().deviceId || null; } catch { return null; }
}

function openMicStream(deviceId) {
  const constraints = deviceId
    ? { audio: { ...AUDIO_CONSTRAINTS.audio, deviceId: { exact: deviceId } } }
    : AUDIO_CONSTRAINTS;
  return navigator.mediaDevices.getUserMedia(constraints);
}

// 量一條 stream 真正送出的樣本峰值（0–1）。用完就關，與主收音圖無關。
// null＝量不出來（瀏覽器不支援等），此時一律當作「無從判斷」，不擋錄音。
async function probeStreamPeak(stream, ms = AUDIO_PROBE_MS) {
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      if (peak > AUDIO_SIGNAL_FLOOR) break; // 已證明活著，不必等滿
      await new Promise((r) => setTimeout(r, 50));
    }
    try { src.disconnect(); } catch {}
    return peak;
  } catch {
    return null;
  } finally {
    try { await ctx?.close(); } catch {}
  }
}

async function listMicDeviceIds() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput" && d.deviceId).map((d) => d.deviceId);
  } catch { return []; }
}

/**
 * 取一條量得到聲音的麥克風 stream。
 * 回傳 { stream, deviceId, peak, silent }；silent=true 代表這台機器上每一個收音
 * 裝置都試過、全部是靜音（此時仍回傳一條 stream，由呼叫端決定要不要照錄）。
 * 一條都開不起來時，把最後一個錯誤丟出去，讓呼叫端能顯示真正的原因（權限被拒等）。
 */
async function acquireLiveMic(avoidDeviceId, { singlePass = false } = {}) {
  const ids = (await listMicDeviceIds()).filter((id) => id !== "communications");
  // 實體裝置優先；"default" 會跟著 Windows 預設／通訊裝置跑，放後面；
  // 剛判定死掉的那一條排到最後（真的沒別的選擇時才回頭用它）。
  const order = [...new Set([
    ...ids.filter((id) => id !== "default" && id !== avoidDeviceId),
    ...ids.filter((id) => id === "default" && id !== avoidDeviceId),
    ...(avoidDeviceId ? [avoidDeviceId] : []),
  ])];
  if (!order.length) order.push(null); // 還沒授權、拿不到裝置清單：只能要系統預設
  const candidates = singlePass ? order.slice(0, 1) : order;
  let fallback = null;
  let lastErr = null;
  for (const deviceId of candidates) {
    let stream = null;
    try { stream = await openMicStream(deviceId); }
    catch (err) { lastErr = err; continue; }
    if (!(await waitForTrackUsable(stream, AUDIO_MUTE_GRACE_MS))) {
      stopStream(stream);
      lastErr = new Error("麥克風音軌喚醒逾時");
      continue;
    }
    const peak = await probeStreamPeak(stream);
    if (peak === null || peak > AUDIO_SIGNAL_FLOOR) {
      stopStream(fallback?.stream);
      return { stream, deviceId: micDeviceIdOf(stream), peak, silent: false };
    }
    if (fallback) stopStream(stream);
    else fallback = { stream, deviceId: micDeviceIdOf(stream), peak, silent: true };
  }
  if (fallback) return fallback;
  throw lastErr || new Error("找不到可用的收音裝置");
}

// ---------- Web Audio 收音圖：建立／量測／換源 ----------

// 建立 AudioContext 收音圖。建不起來（極舊瀏覽器）就退回直接錄麥克風 stream，
// 此時沒有訊號監測，行為等同舊版。
// 2026-08-19：AudioContext 只用來做即時音量監測（analyser），不再建立
// destination node、不再參與錄音編碼路徑。錄影功能一直是直接把麥克風原始
// track 塞進 MediaRecorder、完全不經過 Web Audio，而且錄影錄得到聲音；音訊
// 這邊之前錄的是收音圖的 destination stream，同一台機器上使用者實測「錄影
// 有聲音、錄音沒聲音」——這是目前唯一有實測證據支持的假說，所以把兩者的
// 錄製路徑拉齊：analyser 純讀值監測，MediaRecorder 錄的是 AUDIO.stream 本身。
function initAudioGraph() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const src = ctx.createMediaStreamSource(AUDIO.stream);
    src.connect(analyser);
    AUDIO.audioCtx = ctx;
    AUDIO.analyser = analyser;
    AUDIO.micSource = src;
    // iOS 切背景會 suspend context；回前景時 resume（也掛在 resumeAudioOnForeground）
    ctx.onstatechange = () => {
      if (AUDIO && !AUDIO.ending && ctx.state !== "running" && !document.hidden) ctx.resume().catch(() => {});
    };
  } catch {
    AUDIO.audioCtx = null; AUDIO.analyser = null; AUDIO.micSource = null;
  }
}

// MediaRecorder 要錄的 stream：一律是麥克風原始 stream，跟錄影同一招。
function audioRecordStream() {
  return AUDIO.stream;
}

// 這一瞬間的音量峰值（0–1）。null＝沒有收音圖可量
function readMicPeak() {
  if (!AUDIO || !AUDIO.analyser) return null;
  const buf = new Float32Array(AUDIO.analyser.fftSize);
  AUDIO.analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

// 訊號記帳：任何一次取樣（1 秒監測或 150ms 音量表）看到訊號就清掉死亡計時。
// 單一瞬時取樣窗（約 43ms）可能剛好落在語句之間的無聲片刻讀到零——Chromium
// 假音訊裝置實測就抓到過——所以「活著」由任一取樣證明，「死亡」要所有取樣
// 連續全零撐滿 AUDIO_DEAD_SIGNAL_MS 才成立。真殭屍永遠全零，逃不掉。
function noteMicPeak(peak) {
  if (!AUDIO || peak === null) return;
  if (peak > AUDIO_SIGNAL_FLOOR) {
    AUDIO.deadSince = 0;
    AUDIO.diagWarnedThisDeath = false;
    AUDIO.lastSignalAt = Date.now();
  } else {
    AUDIO.deadSince ||= Date.now();
  }
}

// 浮動列的紅點跟著實際音量跳動；持續無訊號時轉灰——使用者一眼就看得出
// 「現在真的有在收音嗎」，不用等事後轉文字才發現錄到空的。
function startAudioMeter() {
  const dot = document.querySelector("#audio-badge .audio-badge-dot");
  if (!dot || !AUDIO.analyser) return;
  AUDIO.meterTimer = setInterval(() => {
    if (!AUDIO || AUDIO.ending || document.hidden) return;
    const peak = readMicPeak();
    if (peak === null) return;
    noteMicPeak(peak);
    const dead = AUDIO.deadSince && Date.now() - AUDIO.deadSince > 2500;
    dot.classList.toggle("no-signal", !!dead);
    if (!dead) dot.style.transform = `scale(${1 + Math.min(1, peak * 14) * 0.9})`;
  }, AUDIO_METER_TICK_MS);
}

// 量實際訊號判斷麥克風死活。全零持續超過 AUDIO_DEAD_SIGNAL_MS → 換訊號源。
// 這是整個偵測的唯一判準：不看 muted、不看 recorder.state、不看資料塊大小
// ——那些旗標在殭屍音軌上全部會說謊（v118–v121 的教訓）。
//
// 2026-08-18（三）新增診斷紀錄：v122 上線後使用者實測「不再被剁段，但整段
// 播放沒聲音」。查歷史錄音發現這不是這次架構重寫造成的——8/14 版（已知良好
// 基準）同一場 3.5 小時的錄音，前 131 分鐘逐字稿正常，但一次背景中斷接續後，
// 後面 70 分鐘全部是 Whisper 對靜音的幻覺輸出（"Thank you" 反覆）。代表換上
// 全新的 getUserMedia 音軌，在某些情況下依然量不到真實訊號——比較像作業系統
// 層級把瀏覽器的錄音整個靜音掉，不是任何換源策略能在網頁端繞過的。
// 在下一次真的猜對之前，先讓程式老實記下它量到的數字，不要再靠盲猜。
function checkMicSignal() {
  if (!AUDIO || AUDIO.ending) return;
  const peak = readMicPeak();
  if (peak === null) return; // 沒有收音圖（退回模式）：無從量測
  noteMicPeak(peak);
  AUDIO.diagPeakMax = Math.max(AUDIO.diagPeakMax || 0, peak);
  if (!AUDIO.deadSince) return;
  const deadMs = Date.now() - AUDIO.deadSince;
  if (deadMs >= AUDIO_DEAD_SIGNAL_MS) {
    attemptMicSwap();
  } else if (deadMs >= 1000 && !AUDIO.diagWarnedThisDeath) {
    // 死亡計時進行中就先留一筆記錄，換源萬一「假裝成功」（新音軌其實也是
    // 靜音），至少事後能對照這裡的時間點，不用整段錄完才發現整個是空的。
    AUDIO.diagWarnedThisDeath = true;
    const at = fmtSecs(Math.max(0, Math.floor((AUDIO.deadSince - AUDIO.startedAt) / 1000)));
    noteAudioInterruption(AUDIO.entryId, `🔬 診斷：約 ${at} 起偵測到麥克風無訊號（peak=0），持續中。`);
  }
}

// 換訊號源：重新 getUserMedia，先把新源接上收音圖、再拔舊的。
// recorder 全程不動——不換段、檔案時間軸連續，換失敗也只是維持現狀稍後再試，
// 不存在「錄音報廢」這種結局（除非 recorder 本身死掉，那是另一條路）。
async function attemptMicSwap() {
  if (!AUDIO || AUDIO.ending || AUDIO.swapping || !AUDIO.audioCtx) return;
  if (Date.now() - AUDIO.lastSwapAt < AUDIO_MIN_SWAP_INTERVAL_MS) return;
  AUDIO.swapping = true;
  AUDIO.lastSwapAt = Date.now();
  const deadFrom = AUDIO.deadSince || Date.now();
  const deadDeviceId = AUDIO.micDeviceId;
  const oldStream = AUDIO.stream;
  const oldSource = AUDIO.micSource;
  try {
    let picked = null;
    let lastErr = null;
    // 背景分頁只試一次（getUserMedia 在背景可能被擋），回前景時會立刻再檢查
    const attempts = document.hidden ? 1 : AUDIO_RECOVERY_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // 避開剛死掉的那一個裝置：換回同一條殭屍是 v118–v123 一路失敗的主因
        picked = await acquireLiveMic(AUDIO.micDeviceId, { singlePass: document.hidden });
        if (!picked.silent) break; // 量到真訊號才算換成功
        // 全部裝置都是靜音：先留著這條當備案，退避後再試一輪
        if (attempt < attempts) { stopStream(picked.stream); picked = null; }
      } catch (err) {
        lastErr = err;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, AUDIO_RECOVERY_RETRY_MS * attempt));
      }
    }
    const fresh = picked?.stream || null;
    if (!AUDIO || AUDIO.ending) {
      stopStream(fresh);
      return;
    }
    if (!fresh) {
      // 換不到就維持現狀：舊源說不定會自己活過來，訊號監測也會在節流過後再試。
      // 絕不因此停止錄音。
      if (!document.hidden) {
        const reason = [lastErr?.name, lastErr?.message].filter(Boolean).join("：") || "未知錯誤";
        setAudioStatus(`⚠️ 麥克風無訊號且暫時換不到新的（${reason}），持續嘗試中`, true);
      }
      return;
    }
    let src;
    try {
      src = AUDIO.audioCtx.createMediaStreamSource(fresh);
      src.connect(AUDIO.analyser);
    } catch (err) {
      // 極少數情況（取樣率不合等）接不上監測用的收音圖：放掉新 stream 維持現狀
      stopStream(fresh);
      return;
    }
    // recorder 現在直接錄麥克風原始 stream，換源就不能再「悄悄接上同一顆
    // recorder」——用跟 rotateAudioSegment 一樣的重疊技巧開新段：先在新
    // stream 上開始收音，過 AUDIO_SEG_OVERLAP_MS 才收尾舊 recorder、拔舊
    // stream，中間有一小段重疊，不會出現真正收不到音的空隙。
    const oldRecorder = AUDIO.recorder;
    AUDIO.stream = fresh;
    AUDIO.micDeviceId = picked.deviceId;
    AUDIO.micSource = src;
    AUDIO.deadSince = 0;
    AUDIO.lastSignalAt = Date.now();
    watchAudioStream(fresh);
    AUDIO.segIndex++;
    startAudioSegRecorder();
    setTimeout(() => {
      try { oldSource?.disconnect(); } catch {}
      try { if (oldRecorder.state !== "inactive") oldRecorder.stop(); } catch {}
      stopStream(oldStream);
    }, AUDIO_SEG_OVERLAP_MS);
    const fromS = fmtSecs(Math.max(0, Math.floor((deadFrom - AUDIO.startedAt) / 1000)));
    const changedDevice = picked.deviceId && picked.deviceId !== deadDeviceId;
    // 換源不再是「重要一次同一個預設裝置」，而是逐一驗收過實體裝置的結果，
    // 所以這裡如實記下換到哪一類裝置、量到多少，事後才有得對照。
    const verdict = picked.silent
      ? `（⚠️ 這台電腦上每個收音裝置都試過，量到的仍是 peak=0——不是換裝置能解決的，比較可能是系統層級把麥克風靜音或被其他程式佔用）`
      : `（新來源實測 peak=${(picked.peak ?? 0).toFixed(4)}，確認收得到聲音）`;
    setAudioStatus(
      picked.silent
        ? `⚠️ 麥克風無訊號（約 ${fromS} 起），所有收音裝置都是靜音；錄音檔仍持續但可能是空的`
        : `⚠️ 麥克風曾無訊號（約 ${fromS} 起），已${changedDevice ? "改用另一個收音裝置" : "重新取得收音來源"}；錄音檔連續未中斷`,
      true);
    noteAudioInterruption(AUDIO.entryId,
      `⚠️ 錄音在約 ${fromS} 偵測到麥克風無訊號（可能遭系統靜音或裝置切換），已自動${changedDevice ? "改用另一個收音裝置" : "重新取得收音來源"}。無訊號期間在錄音檔中為等長靜音，檔案時間軸連續。${verdict}`);
  } finally {
    if (AUDIO) AUDIO.swapping = false;
  }
}

// 回到前台：喚醒 AudioContext、立刻量一次訊號。麥克風的事交給訊號監測與換源，
// 這裡只需要處理「recorder 本身被系統停掉」——收音圖不受影響，直接在同一條
// destination stream 上開新的一段接續，連 getUserMedia 都不用。
async function resumeAudioOnForeground() {
  if (!AUDIO || AUDIO.ending) return;
  const backgroundStartedAt = AUDIO.backgroundAt;
  const backgroundSecs = backgroundStartedAt ? Math.max(1, Math.round((Date.now() - backgroundStartedAt) / 1000)) : 0;
  AUDIO.backgroundAt = 0;
  AUDIO.backgroundSecs += backgroundSecs;
  if (AUDIO.audioCtx && AUDIO.audioCtx.state !== "running") AUDIO.audioCtx.resume().catch(() => {});
  if (AUDIO.recorder?.state !== "recording" || AUDIO.recorderFailed) {
    const at = fmtSecs(Math.max(0, Math.floor(((backgroundStartedAt || Date.now()) - AUDIO.startedAt) / 1000)));
    AUDIO.interrupted = true;
    AUDIO.recorderFailed = false;
    AUDIO.segIndex++;
    startAudioSegRecorder();
    setAudioStatus(`⚠️ 錄音器曾中斷（背景 ${fmtSecs(backgroundSecs)}），已從第 ${AUDIO.segIndex} 段接續`, true);
    noteAudioInterruption(AUDIO.entryId,
      `⚠️ 錄音器在約 ${at} 曾被系統中止（App／分頁切到背景），已自動開新的一段接續。`);
  } else if (backgroundSecs) {
    setAudioStatus(`✓ 背景 ${fmtSecs(backgroundSecs)}；錄音持續中`, false);
  }
  checkMicSignal();
}

// 錄音中臨時拍照：另外開一個鏡頭串流，看得到畫面才拍，拍完立刻關閉鏡頭
// （錄音本身走另一條 stream，鏡頭開關不會中斷錄音）
let AUDIO_PHOTO_STREAM = null;

async function openAudioPhotoPopup() {
  if (!AUDIO || AUDIO_PHOTO_STREAM) return;
  try {
    AUDIO_PHOTO_STREAM = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  $("audio-photo-video").srcObject = AUDIO_PHOTO_STREAM;
  $("audio-photo-popup").style.display = "flex";
}

function closeAudioPhotoPopup() {
  if (AUDIO_PHOTO_STREAM) AUDIO_PHOTO_STREAM.getTracks().forEach((t) => t.stop());
  AUDIO_PHOTO_STREAM = null;
  $("audio-photo-video").srcObject = null;
  $("audio-photo-popup").style.display = "none";
}

async function audioPhotoSnap() {
  if (!AUDIO || !AUDIO_PHOTO_STREAM) return;
  const video = $("audio-photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const offset = segOffset(AUDIO);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  AUDIO.photos++;
  const { entryId } = AUDIO;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${fmtSecs(offset).replace(":", "")}.jpg`;
  closeAudioPhotoPopup();
  showToast(`已拍照（第 ${AUDIO.photos} 張）`);
  try { await putFile(entryId, blob, filename, offset); }
  catch { await queueFile(entryId, blob, filename, offset); showToast("網路不穩，照片先存手機"); }
}

// 切到別的分頁/App（頁面隱藏）：錄影要用鏡頭、背景無法運作，維持自動結束存檔；
// 純錄音則「不結束」，繼續在背景錄——Android 真的會繼續，iOS 系統會暫停但回前台
// 自動接續、切走前錄的都保住。真正離開頁面前由 beforeunload 警告使用者。
function onPageHidden() {
  if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
  if (AUDIO && !AUDIO.ending) {
    AUDIO.backgroundAt ||= Date.now();
    setAudioStatus("背景錄音中；請保留 Mywiki 頁籤，手機系統仍可能暫停麥克風");
    // 先要求瀏覽器交出目前資料，降低稍後遭系統暫停時遺失整段的風險。
    try { if (AUDIO.recorder?.state === "recording") AUDIO.recorder.requestData(); } catch {}
  }
  if (AUDIO_PHOTO_STREAM) closeAudioPhotoPopup(); // 拍照鏡頭關掉，但錄音續錄
}

function stopAnyActiveCapture() {
  if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
  if (AUDIO) { AUDIO.autoStopped = true; stopAudio(); }
  if (AUDIO_PHOTO_STREAM) closeAudioPhotoPopup();
}

// pagehide 不是可靠的「真正關頁」訊號：手機切換 App、分頁凍結或記憶體回收前
// 都可能送出，而且 persisted 在各瀏覽器生命週期中並不一致。這裡只切出目前資料，
// 不主動 stopAudio；否則使用者只是把 Mywiki 放到背景，錄音就會被網頁自己終止。
function onPageHide(event) {
  onPageHidden();
}

// 真正用同一個頁籤離開 Mywiki 時，網頁不可能在文件被銷毀後繼續使用麥克風。
// 用瀏覽器原生確認保護使用者：要查別頁請開新頁籤；若仍選擇離開，就正常收尾。
function guardRecordingNavigation(event) {
  if (!AUDIO || AUDIO.ending) return;
  try { if (AUDIO.recorder?.state === "recording") AUDIO.recorder.requestData(); } catch {}
  event.preventDefault();
  event.returnValue = "";
}

// ---------- 匯出 ----------
function exportFolder() {
  if (!CURRENT_FOLDER) return;
  window.open(`/api/export/folder/${CURRENT_FOLDER.id}`, "_blank", "noopener");
}

// ---------- init ----------
function init() {
  // 沒接住的檔案拖放，瀏覽器預設行為是直接開啟該檔案、整頁跳走——不管拖去哪
  // 都先擋掉這個預設行為，實際上傳邏輯交給各自的 setupFileDropZone。
  window.addEventListener("dragover", (ev) => {
    if (Array.from(ev.dataTransfer?.types || []).includes("Files")) ev.preventDefault();
  });
  window.addEventListener("drop", (ev) => {
    if (Array.from(ev.dataTransfer?.types || []).includes("Files")) ev.preventDefault();
  });
  // 離線錄音補傳不能只依賴「重新登入／重開頁面」。網路恢復時主動重試，
  // 同時保留記事內的待補傳提示，讓使用者在成功前知道檔案仍在本機。
  window.addEventListener("online", () => { syncPendingFiles(); });
  $("btn-login").onclick = doLogin;
  $("login-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("btn-video").onclick = () => startVideo(null);
  $("btn-photo").onclick = () => startPhoto(null);
  $("btn-audio").onclick = () => startAudio(null);
  $("btn-quick-note").onclick = quickNote;
  $("btn-weekly-report").onclick = openCurrentWeeklyReport;
  $("btn-new-folder").onclick = newFolder;
  $("btn-new-subfolder").onclick = newSubfolder;
  $("btn-manage-categories").onclick = () => openCategoryManager("folder_type");
  $("category-manager-close").onclick = closeCategoryManager;
  $("category-manager-overlay").addEventListener("click", (e) => {
    if (e.target === $("category-manager-overlay")) closeCategoryManager();
  });
  $("btn-cleanup-filenames").onclick = (e) => cleanupFilenames(e.currentTarget);
  // 資料夾工具列與資料夾頁拖放都代表已指定目前資料夾；首頁拖放才進待分類。
  // 每個檔案自成一筆記事（標題＝去掉副檔名的檔名）
  const folderUploadInput = $("folder-upload-file-input");
  $("btn-folder-upload-file").onclick = () => {
    if (!CURRENT_FOLDER) { showToast("請先進入要存放檔案的資料夾"); return; }
    folderUploadInput.click();
  };
  folderUploadInput.onchange = () => {
    const files = Array.from(folderUploadInput.files || []);
    folderUploadInput.value = "";
    uploadFilesToFolder(files);
  };
  setupFileDropZone($("view-home"), uploadDroppedFilesToCurrentLocation);
  setupFileDropZone($("view-folder"), uploadDroppedFilesToCurrentLocation);
  setupFileDropZone($("desktop-explorer-nav"), uploadDroppedFilesToCurrentLocation);
  initDesktopSidebarResize();
  initPreviewLayout();
  $("btn-inbox-grid").onclick = () => setInboxView("grid");
  $("btn-inbox-list").onclick = () => setInboxView("list");
  $("btn-inner-grid").onclick = () => setInnerFolderView("grid");
  $("btn-inner-list").onclick = () => setInnerFolderView("list");
  $("btn-inner-details").onclick = () => setInnerFolderView("details");
  $("desktop-pending").onclick = openPendingFromDesktop;
  $("desktop-new-folder").onclick = newFolder;
  $("desktop-trash").onclick = openTrash;
  const closeTrash = () => { $("trash-overlay").classList.remove("open"); $("desktop-trash").classList.remove("active"); };
  $("trash-close").onclick = closeTrash;
  $("trash-overlay").addEventListener("click", (event) => { if (event.target === $("trash-overlay")) closeTrash(); });
  $("trash-empty").onclick = async () => {
    if (!confirm("永久刪除垃圾桶內全部內容？\n\n這次無法復原。")) return;
    try { await api("/trash", { method: "DELETE" }); showToast("垃圾桶已清空"); await loadTrash(); }
    catch (error) { showToast("清空失敗：" + error.message); }
  };
  $("btn-file-sort").onclick = () => setFileSort(FILE_SORT === "name" ? "new" : "name");
  $("btn-folder-sort-home").onclick = toggleFolderSort;
  $("btn-folder-sort-inner").onclick = toggleFolderSort;
  syncFolderSortButtons();
  $("merge-folder-cancel").onclick = closeMergeFolderDialog;
  $("merge-folder-confirm").onclick = () => {
    const targetId = Number($("merge-folder-target").value);
    if (MERGE_SOURCE_ID && targetId) mergeFolder(MERGE_SOURCE_ID, targetId);
  };
  $("merge-folder-overlay").addEventListener("click", (e) => { if (e.target === $("merge-folder-overlay")) closeMergeFolderDialog(); });
  $("folder-picker-cancel").onclick = () => closeFolderPicker(null);
  $("folder-picker-close").onclick = () => closeFolderPicker(null);
  $("folder-picker-overlay").addEventListener("click", (e) => { if (e.target === $("folder-picker-overlay")) closeFolderPicker(null); });
  $("merge-entry-cancel").onclick = closeMergeEntryDialog;
  $("merge-entry-confirm").onclick = () => {
    const targetId = Number($("merge-entry-target").value);
    if (MERGE_ENTRY_SOURCE_ID && targetId) mergeEntry(MERGE_ENTRY_SOURCE_ID, targetId);
  };
  $("merge-entry-overlay").addEventListener("click", (e) => { if (e.target === $("merge-entry-overlay")) closeMergeEntryDialog(); });
  $("create-folder-cancel").onclick = () => closeCreateFolderDialog(null);
  $("create-folder-overlay").addEventListener("click", (e) => { if (e.target === $("create-folder-overlay")) closeCreateFolderDialog(null); });
  $("create-folder-form").onsubmit = (e) => {
    e.preventDefault();
    const name = $("create-folder-name").value.trim();
    const type = document.querySelector('input[name="folder-type"]:checked')?.value || "其他";
    if (!name) { $("create-folder-name").focus(); return; }
    closeCreateFolderDialog({ name, type });
  };
  const trash = $("folder-trash-zone");
  trash.ondragover = (ev) => { ev.preventDefault(); trash.classList.add("active"); ev.dataTransfer.dropEffect = "move"; };
  trash.ondragleave = () => trash.classList.remove("active");
  trash.ondrop = (ev) => {
    ev.preventDefault();
    trash.classList.remove("active");
    const sourceId = Number(ev.dataTransfer.getData("application/x-fieldlog-folder"));
    if (sourceId) deleteFolder(sourceId);
  };
  const newFolderZone = $("entry-new-folder-zone");
  newFolderZone.ondragover = (ev) => {
    if (!ev.dataTransfer.types.includes("application/x-fieldlog-entry")) return;
    ev.preventDefault();
    newFolderZone.classList.add("active");
    ev.dataTransfer.dropEffect = "move";
  };
  newFolderZone.ondragleave = () => newFolderZone.classList.remove("active");
  newFolderZone.ondrop = (ev) => {
    ev.preventDefault();
    newFolderZone.classList.remove("active");
    document.body.classList.remove("entry-dragging");
    const entryId = Number(ev.dataTransfer.getData("application/x-fieldlog-entry"));
    const title = ev.dataTransfer.getData("application/x-fieldlog-entry-title") || "新資料夾";
    if (entryId) createFolderAndMoveEntry(entryId, title).catch((err) => showToast("建立並移動失敗：" + err.message));
  };
  $("btn-usage-refresh").onclick = loadUsage;
  $("btn-back").onclick = backHome;
  $("btn-new-subfolder").onclick = newSubfolder;
  $("btn-video-f").onclick = () => startVideo(null);
  $("btn-photo-f").onclick = () => startPhoto(null);
  $("btn-audio-f").onclick = () => startAudio(null);
  $("btn-folder-entry").onclick = async () => {
    const id = await createEntry(CURRENT_FOLDER.id, "");
    openFolder(CURRENT_FOLDER.id);
    openEntry(id);
  };
  $("btn-folder-export").onclick = exportFolder;

  // 🎥 錄影
  $("capture-snap").onclick = videoSnap;
  $("capture-stop").onclick = stopVideo;
  $("capture-note").onclick = () => addTimedNote(VIDEO);
  setupFolderChip("capture-folder-chip", "capture-folder-picker", () => VIDEO);

  // 📷 拍照
  $("photo-snap").onclick = photoSnap;
  $("photo-done").onclick = finishPhoto;
  setupFolderChip("photo-folder-chip", "photo-folder-picker", () => PHOTO);

  // 🎙 錄音
  // 錄音沒有全螢幕畫面、也就沒有錄影／拍照那顆資料夾 chip，改在浮動列上給一顆：
  // 錄音中也能選擇資料夾，而且開選擇器不會中斷錄音。
  $("audio-folder-btn").onclick = async () => {
    if (!AUDIO) return;
    const picked = await openFolderPicker({
      title: "這段錄音移到哪裡？",
      desc: "現在選好，之後就不用回頭找。錄音不會中斷。",
      currentId: AUDIO.folderId ?? null,
      allowInbox: true,
    });
    if (!picked || !AUDIO) return;
    try {
      await api(`/entries/${AUDIO.entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: picked.id }) });
      AUDIO.folderId = picked.id;
      showToast(`已歸到「${folderChipLabel(picked.id)}」`);
    } catch (err) { showToast("分類失敗：" + err.message); }
  };
  $("audio-photo-btn").onclick = openAudioPhotoPopup;
  $("audio-note-btn").onclick = () => addTimedNote(AUDIO);
  $("audio-stop-btn").onclick = stopAudio;
  $("audio-photo-cancel").onclick = closeAudioPhotoPopup;
  $("audio-photo-snap").onclick = audioPhotoSnap;

  // 記事詳情裡有可編輯的內文／欄位，點暗色背景就關掉太容易在選字、拖曳
  // textarea 捲軸時手滑關掉整頁、白打的東西沒存到——只留右上角 ✕ 這條路。
  $("image-viewer-close").onclick = closeImageViewer;
  // 點圖片以外的暗色區域也關掉（手機上比瞄準右上角的 ✕ 好按）
  $("image-viewer-overlay").addEventListener("click", (e) => {
    if (e.target.id !== "image-viewer-img") closeImageViewer();
  });
  // ↗ 原圖是真的要另開分頁看原始檔，別被上面那個關閉行為吃掉
  $("image-viewer-open").addEventListener("click", (e) => e.stopPropagation());
  // 🔄 旋轉同理，別被暗色區域的關閉行為吃掉
  $("image-viewer-rotate").addEventListener("click", (e) => { e.stopPropagation(); rotateCurrentImage(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageViewer();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onPageHidden();     // 背景：錄影結束、錄音續錄
    else resumeAudioOnForeground();          // 回前台：錄音若被系統中斷則接續
  });
  // frozen/bfcache 回復不一定再送一次 visibilitychange，pageshow/resume 也要接。
  window.addEventListener("pageshow", resumeAudioOnForeground);
  document.addEventListener("resume", resumeAudioOnForeground);
  document.addEventListener("freeze", onPageHidden);
  window.addEventListener("beforeunload", guardRecordingNavigation);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("online", syncPendingFiles);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  showBootProgress("檢查登入狀態…");
  setBootProgress(8, "連線到 MyWiki…");
  const startBoot = () => {
    setBootProgress(12, "讀取資料夾…");
    return api("/folders").then((folders) => boot(folders))
      .catch(() => { hideBootProgress(); showLogin(); });
  };
  migrateLegacyPinToSession().finally(startBoot);
}

init();
