/**
 * medapi-mcp — 跨系統問答層，預設唯讀（MCP Server，Streamable HTTP）
 *
 * 定位：讓 claude.ai／Claude Code 當「窗口」，用自然語言跨三個來源問答：
 *   - 策略地圖 Wiki（fieldlog Worker 的 /wiki/*，PIN 通道 runtime 抓取）
 *   - 隨身記 fieldlog（共綁同一個 D1，只下 SELECT）
 *   - Medtec 參展系統（共綁同一個 D1 ＋ runtime 抓公開的 exhibitors.json）
 *
 * 鐵律：預設唯讀——程式碼裡絕大多數是 SELECT 與 fetch。例外只有四支
 * 「只能新增」的工具：create_fieldlog_entry（INSERT 一筆記事）、
 * create_relation（INSERT 一筆關聯）、add_synonym（INSERT 一列同義詞對照）、
 * create_fieldlog_attachment（上傳一份新附件——這支不是直接 INSERT D1，是
 * 透過 FIELDLOG Service Binding 打 fieldlog 自己的 POST /api/upload，跟
 * App 上傳走同一條路徑，一樣只會新增一筆 attachments／一個 R2 物件）。
 * 程式碼裡沒有任何 UPDATE／DELETE 語句碰得到 entries／attachments／folders／
 * relations／synonyms。改內容、刪東西、wiki 收錄一律要回各自的前台／git
 * 人審，MCP 這邊永遠做不到。（外部來源的同步更新走 fieldlog worker 內部的
 * cron，不經過 MCP——MCP 對既有資料永遠沒有修改權。）
 *
 * 驗證：POST /mcp 需帶 ?pin=（或 x-pin header／Authorization: Bearer），
 * 與 MCP_PIN（Secret）比對，未設定時一律拒絕（fail-closed）。
 * claude.ai 自訂連接器不能自帶 header，所以實際上用 ?pin= 掛在 URL 上。
 *
 * 需要的 Secrets／Variables（Worker Settings → Variables and Secrets）：
 *   MCP_PIN      — 這個 MCP 端點自己的通行碼
 *   FIELDLOG_URL — 隨身記網址（如 https://fieldlog.xxx.workers.dev）
 *   FIELD_PIN    — 隨身記的 PIN（讀 wiki 內容用，與 fieldlog 的 Secret 同值）
 *   MEDTEC_URL   — 參展系統網址（如 https://medtec-2026.xxx.workers.dev）
 */

import { stripPdfMetadata } from "./textFold.js";
// 不指定 /workerd 子路徑：package.json 的 conditional exports 會依實際 runtime
// 自動選版本——node --test（跑測試用）拿到 node 版，wrangler 部署／dev 拿到
// workerd 版。之前指定死 /workerd 直接讓 node --test 連 import 都失敗
// （ERR_MODULE_NOT_FOUND，因為 workerd 版的 wasm 載入方式只有 wrangler 的
// bundler 認得），整份 mcp/ 測試套件全部炸掉。
import { PhotonImage, SamplingFilter, resize as photonResize } from "@cf-wasm/photon";
import {
  buildPlan,
  runSearch,
  isDegraded,
  matchesPlan,
  pickHitField,
  planSnippet,
  degradedNote,
  expansionNote,
  noHitMessage,
  setSynonymGroups,
  SYNONYM_SEED,
} from "./search.js";
// 通用 JSON→Markdown 渲染器與 fieldlog 共用同一份（單一真相來源）：
// analysis_json 在這裡怎麼呈現、在 fieldlog 端怎麼進 body，規則永遠一致
import { renderTree } from "../../fieldlog/src/lib/render.js";
import { htmlToPlainText } from "../../fieldlog/src/lib/richtext.js";

const PROTOCOL_DEFAULT = "2025-03-26";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

// 全 JS 端摺疊比對可掃描的資料列上限——現階段資料量遠低於此，設個天花板純粹
// 避免未來資料爆量時把 Worker 記憶體撐爆（超出時只掃最新這麼多列）
const SCAN_CAP = 5000;

// get_fieldlog_attachment 單次回傳的字元上限。超長文件（例如整份 ISO 標準的 OCR
// 全文）一次回傳可能塞爆呼叫端的 context；用 offset/length 分段讀，並在回應裡
// 明確標示「總長度 N、目前顯示第 X–Y 字」，不能讓截斷發生卻不講。
const ATTACHMENT_CHUNK_CAP = 20000;

// ---------- 小工具 ----------

// claude.ai 的自訂連接器是瀏覽器直接呼叫，跨網域一定會先送 CORS 預檢（OPTIONS），
// 沒有這組 header 瀏覽器會直接擋下真正的 POST，連 initialize 都打不到
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-pin, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

// 千萬不要在這裡加 WWW-Authenticate: Bearer ——2026-08-01 加過一次，直接把
// claude.ai 的連接器弄壞了。
//
// RFC 7235 是說 401 該帶 WWW-Authenticate 沒錯，但 MCP 的 Authorization 規範
// 把「看到 Bearer 這個字」當成訊號：客戶端看到就會認定「這台伺服器支援
// OAuth」，去戳 /.well-known/oauth-authorization-server、
// /.well-known/oauth-protected-resource 想做動態客戶端註冊。這台從頭到尾
// 只用 PIN，沒有那些端點（故意全部 404——見下面 fetch() 裡的註解），
// 註冊當然失敗，claude.ai 就跳「Couldn't register with sign-in service」，
// 而且不管網址上的 PIN 對不對都會卡在這一步，比原本沒有這個 header 還糟。
//
// 所以錯誤說明只放在 JSON body，不透過任何 auth challenge header 傳遞。
function unauthorized(description) {
  return json({ error: description }, 401);
}

// 工具 handler 一律回傳字串（會被包成 text content）；需要回傳圖片等非文字內容時，
// 直接回傳 { content: [...] } 形狀的物件，這裡原樣透傳——MCP ImageContent
// （get_fieldlog_image／image_probe）就是靠這條路出去的，不能被 String() 壓扁。
function wrapToolOutput(out) {
  if (out && typeof out === "object" && Array.isArray(out.content)) return out;
  return { content: [{ type: "text", text: String(out) }] };
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function clip(s, n = 200) {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function needQuery(args) {
  const q = (args.query || "").trim();
  if (!q) throw new Error("query 為必填");
  return q;
}

// 查詢計畫：斷詞 ＋ 同義詞展開（見 search.js）。五個 search_* 工具共用同一套，
// 所以「多詞查詢」與「慣用語查得到正式名稱」在全部工具上行為一致。
function needPlan(args) {
  return buildPlan(needQuery(args));
}

// 把結果、降級提醒、展開說明組成最終回應
function withSearchNotes(plan, result, body) {
  const out = [];
  if (result.degraded) out.push(degradedNote(plan), "");
  out.push(body);
  const note = expansionNote(plan);
  if (note) out.push("", note);
  return out.join("\n");
}

function capLimit(args, dflt = 10, max = 30) {
  const n = Number(args.limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
}

// ---------- D1 schema 落後時的自我修復 ----------

// fieldlog 與這支 MCP 是兩個獨立的 Worker，綁同一個 D1，但只有 fieldlog 帶
// migration（它的 ensureSchema 會補上新欄位）。而 ensureSchema 只在「帶正確 PIN 的
// /api/* 請求」進來時才執行——MCP 直接讀 D1、完全不經過那條路徑。
//
// 結果就是：fieldlog 部署了含新欄位的版本之後，只要沒有人真的打開過隨身記 App，
// 欄位就一直不會被建立，而 MCP 一直在讀同一個資料庫 → 一直看到 no such column。
// 2026-08-01 的 search_fieldlog（e.body_format）就是這樣壞的，而且從錯誤訊息
// 完全看不出「去打開一次 App 就好」。
//
// 排程（fieldlog 每天 UTC 18:00）也會跑 ensureSchema，但那代表最壞情況要等一天。
// 這裡改成：一遇到 no such column 就主動戳一下 fieldlog 的 API 觸發 ensureSchema，
// 然後重試一次。正常路徑完全不受影響（沒出錯就不會有任何額外請求）。
function isMissingColumnError(err) {
  return /no such column/i.test(err?.message || "");
}

// entries／attachments 的欄位是 fieldlog 那邊用 migration 加的，這支 MCP 只是讀
// 同一個 D1，所以隨時可能遇到「程式碼已經知道某個欄位、資料庫還沒有」。
//
// 原本的作法是在 SQL 裡寫死欄位、失敗了再退回一組較舊的欄位集，但那等於要事先
// 猜到「會缺的是哪一個」——2026-08-01 就是這樣壞的：退回機制只切換 analysis_json，
// 而真正缺的是 body_format（它兩個版本都在），於是兩次都失敗、錯誤照樣往外拋。
// 改成直接問資料庫實際有哪些欄位，就不必猜，之後加任何新欄位也不會再踩。
//
// 每個 isolate 查一次就夠：schema 在 Worker 存活期間不會變，真的變了也是下一個
// isolate 的事。PRAGMA 本身失敗時回 null，呼叫端會退回「全都帶上」的舊行為。
const COLUMN_CACHE = new Map();

async function tableColumns(env, table) {
  if (COLUMN_CACHE.has(table)) return COLUMN_CACHE.get(table);
  let cols = null;
  try {
    const { results } = await env.DB_FIELDLOG.prepare(`PRAGMA table_info(${table})`).all();
    if (results?.length) cols = new Set(results.map((r) => r.name));
  } catch {
    cols = null; // 查不到就當作不知道，交給呼叫端退回舊行為
  }
  COLUMN_CACHE.set(table, cols);
  return cols;
}

// 只留資料庫真的有的欄位；欄位清單查不到（null）時保守地全部保留，
// 讓既有的 try/catch 退回機制當最後一道防線
function keepExistingColumns(cols, wanted) {
  if (!cols) return wanted;
  return wanted.filter((c) => cols.has(c));
}

async function triggerFieldlogSchemaMigration(env) {
  if (!env.FIELDLOG) return false;
  const pin = (env.FIELD_PIN || "").trim();
  if (!pin) return false;
  const u = new URL("https://fieldlog.internal/api/config");
  u.searchParams.set("pin", pin);
  const res = await env.FIELDLOG.fetch(u.toString()).catch(() => null);
  // 200 才代表真的通過 PIN 閘門走進 handleApi、跑到 ensureSchema；
  // 401 是 PIN 對不上，補不了 schema，如實回 false
  return !!res && res.ok;
}

// ---------- Wiki（Service Binding 呼叫 fieldlog，走它的 PIN 通道）----------

function wikiFetch(env, file) {
  if (!env.FIELDLOG) throw new Error("尚未設定 FIELDLOG Service Binding（見 mcp/README.md）");
  const u = new URL(`https://fieldlog.internal/wiki/${encodeURIComponent(file)}`);
  u.searchParams.set("pin", (env.FIELD_PIN || "").trim());
  return env.FIELDLOG.fetch(u.toString());
}

async function wikiPages(env) {
  const res = await wikiFetch(env, "pages.json");
  if (!res.ok) throw new Error(`讀取 wiki 頁面清單失敗（HTTP ${res.status}）：${await fieldlogErrorDetail(res)}`);
  const data = await res.json();
  return data.pages || [];
}

// ---------- 向量語義搜尋（Service Binding 呼叫 fieldlog 的 /api/search）----------
// search_fieldlog 本身是關鍵字＋同義詞展開，抓不到「用詞不同但意思相關」的內容
// （例如查「低摩擦」找不到寫「親水披膜」的紀錄，兩邊沒有同義詞關係）。這支只
// 是補一層語義相關結果，失敗（fieldlog 掛掉、Vectorize 還沒建好等）就靜默略過
// ——search_fieldlog 原本的關鍵字搜尋不能因為這個附加功能掛掉而跟著壞。
async function fieldlogVectorSearch(env, query, { topK = 5, folderId = null } = {}) {
  if (!env.FIELDLOG) return null;
  try {
    const u = new URL("https://fieldlog.internal/api/search");
    u.searchParams.set("q", query);
    u.searchParams.set("topK", String(topK));
    if (folderId !== null) u.searchParams.set("folder_id", String(folderId));
    u.searchParams.set("pin", (env.FIELD_PIN || "").trim());
    const res = await env.FIELDLOG.fetch(u.toString());
    if (!res.ok) return null; // 501（Vectorize 未配置）、401 等一律當作「這次沒有語義結果」
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : null;
  } catch (err) {
    return null;
  }
}

// fieldlog 的 401 分兩種、原因完全不同，蓋成同一句「FIELD_PIN 是否一致」會
// 讓人兩邊都要猜：
//   「尚未設定 FIELD_PIN」→ fieldlog 自己的 Secret 不見了，要去 fieldlog
//   Worker 補
//   「PIN 錯誤或未提供」→ fieldlog 的 Secret 沒事，是 medapi-mcp 這邊存的
//   那份 FIELD_PIN 跟 fieldlog 對不上，要去 medapi-mcp Worker 改
// 2026-08-03 就吃過虧：MCP_PIN 被部署清掉那次，medapi-mcp 上的 FIELD_PIN
// 大概率也一起被清了，事後手動補救時只顧著補 MCP_PIN（因為那個當下看得到
// 症狀），FIELD_PIN 沒人發現一直缺著，直到有人用 get_fieldlog_image／
// list_wiki_pages 才炸出來——而看到的訊息只有「HTTP 401」，沒有這裡的細節，
// 沒辦法一眼分辨是哪一種。
async function fieldlogErrorDetail(res) {
  const text = await res.text().catch(() => "");
  let detail = text;
  try { detail = JSON.parse(text).error || text; } catch { /* 不是 JSON 就原樣用 */ }
  return `${detail.slice(0, 150)}${res.status === 401 ? "（去對應的 Worker Settings → Variables and Secrets 檢查 FIELD_PIN）" : ""}`;
}

// ---------- 展商主檔（Service Binding 呼叫 medtec，記憶體快取 5 分鐘）----------

let EX_CACHE = { at: 0, data: null };

async function exhibitorsData(env) {
  if (EX_CACHE.data && Date.now() - EX_CACHE.at < 5 * 60 * 1000) return EX_CACHE.data;
  if (!env.MEDTEC) throw new Error("尚未設定 MEDTEC Service Binding（見 mcp/README.md）");
  const res = await env.MEDTEC.fetch("https://medtec.internal/data/exhibitors.json");
  if (!res.ok) throw new Error(`讀取展商名單失敗（HTTP ${res.status}）`);
  const data = await res.json();
  EX_CACHE = { at: Date.now(), data };
  return data;
}

function categoryName(data, id) {
  const c = (data.categories || []).find((c) => c.id === id);
  return c ? c.name_zh : id || "";
}

// ---------- 同義詞表（fieldlog D1 的 synonyms 表，5 分鐘記憶體快取）----------
//
// 檢索品質高度依賴這張表（「HD管」查得到「體外血液處理用導管」全靠它），而它是
// 最需要天天長大的東西——原本卻寫死在 synonyms.json 裡，補一組就要改程式重新部署，
// noHitMessage 甚至叫使用者去改原始碼。搬進 D1 之後：查不到的當下用 add_synonym
// 在對話裡補一組，下一次查詢立刻生效。synonyms.json 降級為「出廠預設值」：
// 第一次使用時 seed 進資料表，之後 D1 讀不到（表還沒建、查詢失敗）就退回它，
// 搜尋永遠不會因為同義詞表壞掉而跟著壞。

let SYN_CACHE = { at: 0 };

function synonymRowsToGroups(rows) {
  // 同一個 canonical 允許多列（add_synonym 只 INSERT 不 UPDATE——見該工具的說明），
  // 載入時合併成一組
  const byCanonical = new Map();
  for (const row of rows) {
    let aliases = [];
    let codes = [];
    try { aliases = JSON.parse(row.aliases_json || "[]"); } catch { /* 壞 JSON 當空 */ }
    try { codes = JSON.parse(row.codes_json || "[]"); } catch { /* 壞 JSON 當空 */ }
    const group = byCanonical.get(row.canonical) || { canonical: row.canonical, aliases: [], codes: [] };
    for (const a of aliases) if (a && !group.aliases.includes(a)) group.aliases.push(a);
    for (const c of codes) if (c && !group.codes.includes(c)) group.codes.push(c);
    byCanonical.set(row.canonical, group);
  }
  return [...byCanonical.values()];
}

async function ensureSynonyms(env) {
  if (Date.now() - SYN_CACHE.at < 5 * 60 * 1000) return;
  try {
    let rows;
    try {
      ({ results: rows } = await env.DB_FIELDLOG.prepare("SELECT canonical, aliases_json, codes_json FROM synonyms ORDER BY id").all());
    } catch {
      // 表還沒建：建表＋把出廠預設值 seed 進去（只會發生一次）
      await env.DB_FIELDLOG.prepare(
        `CREATE TABLE IF NOT EXISTS synonyms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical TEXT NOT NULL,
          aliases_json TEXT DEFAULT '[]',
          codes_json TEXT DEFAULT '[]',
          created_at TEXT NOT NULL
        )`
      ).run();
      for (const g of SYNONYM_SEED) {
        await env.DB_FIELDLOG.prepare(
          "INSERT INTO synonyms (canonical, aliases_json, codes_json, created_at) VALUES (?, ?, ?, ?)"
        ).bind(g.canonical, JSON.stringify(g.aliases || []), JSON.stringify(g.codes || []), now()).run();
      }
      ({ results: rows } = await env.DB_FIELDLOG.prepare("SELECT canonical, aliases_json, codes_json FROM synonyms ORDER BY id").all());
    }
    setSynonymGroups(rows.length ? synonymRowsToGroups(rows) : null);
    SYN_CACHE = { at: Date.now() };
  } catch {
    // D1 整個讀不到：退回出廠預設值，五分鐘後再試——搜尋不能因為同義詞表掛掉而跟著掛
    setSynonymGroups(null);
    SYN_CACHE = { at: Date.now() };
  }
}

// 測試用：清掉快取，讓下一次 tools/call 重新讀 D1
export function resetSynonymCacheForTests() {
  SYN_CACHE = { at: 0 };
  setSynonymGroups(null);
}

// ---------- AI 深度解析段落的統一呈現 ----------
//
// MCP 回應裡凡是 AI 產出的內容一定要明講——否則下次對話會把 AI 的推論
// 當成現場證據引用，這是整個系統最危險的失效模式。
function analysisSection(row) {
  if (!row || !row.analysis_json) return "";
  let parsed;
  try { parsed = JSON.parse(row.analysis_json); } catch { return ""; }
  const meta = [
    row.analysis_profile ? `模板：${row.analysis_profile}` : "",
    row.analysis_model ? `模型：${row.analysis_model}` : "",
    row.analysis_at && !["skipped", "processing", "failed"].includes(row.analysis_at) ? `時間：${row.analysis_at}` : "",
  ].filter(Boolean).join("｜");
  return [
    `## AI 深度解析（${meta || "來源未標示"}）`,
    "> 以下為 AI 產出的整理／推論，不是現場原始紀錄——引用前回上面的原始內容或來源連結確認。",
    renderTree(parsed),
  ].join("\n");
}

// Tier 2 深度處理：PDF 逐頁轉成圖片各自 OCR，結果寫在「子頁面」附件
// （source_pdf_id 指到這份 PDF）自己的 ocr_text，不會回寫到這份 PDF 本身
// 的欄位——只看附件自己的 transcript／ocr_text 會誤判「還沒擷取」，即使
// 子頁面內容其實都在。任何要判斷「這份附件是否已擷取／內容是什麼」的工具
// 都要透過這支共用函式一併考慮子頁面，不要各自重寫一份、漏掉這個判斷。
async function loadDeepProcessingPages(env, attachmentId) {
  const { results: pages } = await env.DB_FIELDLOG.prepare(
    "SELECT * FROM attachments WHERE source_pdf_id = ? ORDER BY page_no"
  ).bind(attachmentId).all();
  return pages || [];
}

// 團隊共筆的 D1 表由 medtec Worker 首次啟動時建立；還沒建表時查詢會炸，
// 這裡吞掉錯誤當「尚無資料」——展商主檔照樣可查
async function medtecStates(env, ids) {
  if (!ids.length) return { states: new Map(), noteCounts: new Map() };
  const ph = ids.map(() => "?").join(",");
  try {
    const [{ results: states }, { results: counts }] = await Promise.all([
      env.DB_MEDTEC.prepare(`SELECT * FROM exhibitor_state WHERE exhibitor_id IN (${ph})`).bind(...ids).all(),
      env.DB_MEDTEC.prepare(`SELECT exhibitor_id, COUNT(*) AS c FROM notes WHERE deleted = 0 AND exhibitor_id IN (${ph}) GROUP BY exhibitor_id`).bind(...ids).all(),
    ]);
    return {
      states: new Map(states.map((s) => [s.exhibitor_id, s])),
      noteCounts: new Map(counts.map((c) => [c.exhibitor_id, c.c])),
    };
  } catch {
    return { states: new Map(), noteCounts: new Map() };
  }
}

function fmtExhibitor(data, ex, state, noteCount) {
  const lines = [
    `### ${ex.name_zh || ex.name_en}（${ex.name_en || "—"}）｜攤位 ${ex.booth_no || "—"}｜${ex.country || "—"}`,
    `- id：${ex.id}｜分類：${categoryName(data, ex.category)}`,
  ];
  if ((ex.products || []).length) lines.push(`- 產品：${ex.products.join("、")}`);
  if (ex.description) lines.push(`- 簡介：${clip(ex.description, 160)}`);
  if (ex.website) lines.push(`- 官網：${ex.website}`);
  if (state) {
    const dept = JSON.parse(state.dept_tags || "[]");
    lines.push(`- 團隊狀態：${state.status || "未排定"}${state.assignee ? `｜指派：${state.assignee}` : ""}${dept.length ? `｜部門：${dept.join("、")}` : ""}${noteCount ? `｜拜訪紀錄 ${noteCount} 則` : ""}`);
  } else if (noteCount) {
    lines.push(`- 拜訪紀錄 ${noteCount} 則`);
  }
  return lines.join("\n");
}

// ---------- 圖片縮放（get_fieldlog_image 用，控制 token 消耗）----------

// Claude 官方建議的圖片 token 效率上限：邊長超過這個值，token 消耗大致跟像素數
// 成正比（(寬×高)÷750），手機拍照常見的 3000-4000px 寬會吃到單張上萬 token。
// 縮到這個邊長內，一張圖穩定落在 ~3000 token 左右，不管原始解析度多高。
const MAX_IMAGE_DIMENSION = 1568;

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// bytes → base64，要分段餵給 String.fromCharCode：一次展開整個陣列當參數，
// 100KB 以上就會 Maximum call stack size exceeded（fieldlog 那邊也踩過同一個坑）。
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// 縮圖只在真的超過門檻時做——不需要就別動原圖，省 CPU 也不會無謂損失畫質
// （例如 PNG 的透明背景，縮圖時統一轉成 JPEG 會丟掉）。
// 用 try/finally 呼叫 photon 的 free()：這是 WASM 手動管理的記憶體，不會被 JS
// 的 GC 自動回收，忘記 free 會在同一個 isolate 裡持續累積直到觸頂。
function resizeImageIfNeeded(bytes, mime) {
  const input = PhotonImage.new_from_byteslice(bytes);
  try {
    const width = input.get_width();
    const height = input.get_height();
    if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
      return { bytes, mime, resized: false, width, height };
    }
    const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const output = photonResize(input, targetWidth, targetHeight, SamplingFilter.Lanczos3);
    try {
      return {
        bytes: output.get_bytes_jpeg(85),
        mime: "image/jpeg",
        resized: true,
        width: targetWidth,
        height: targetHeight,
        originalWidth: width,
        originalHeight: height,
      };
    } finally {
      output.free();
    }
  } finally {
    input.free();
  }
}

// ---------- 工具定義 ----------

const TOOLS = [
  {
    name: "list_wiki_pages",
    description: "列出策略地圖 Wiki 的所有條目（A 核心技術／B 支撐知識／C 資源網絡），含檔名與分組。回答技術知識類問題前先看這份地圖，再用 read_wiki_page 讀內容。",
    inputSchema: { type: "object", properties: {} },
    async handler(env) {
      const pages = await wikiPages(env);
      const groups = new Map();
      for (const p of pages) {
        const g = p.group || "（總覽）";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(`- ${p.title}｜檔名：${p.file}`);
      }
      return [...groups.entries()].map(([g, items]) => `## ${g}\n${items.join("\n")}`).join("\n\n");
    },
  },
  {
    name: "read_wiki_page",
    description: "讀取一個 Wiki 條目的完整 Markdown 內容。file 參數用 list_wiki_pages 回傳的檔名（例：A2-抗結痂披膜.md）。",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "條目檔名，取自 list_wiki_pages" } },
      required: ["file"],
    },
    async handler(env, args) {
      const file = (args.file || "").trim();
      const pages = await wikiPages(env);
      if (!pages.some((p) => p.file === file)) {
        throw new Error(`找不到條目「${file}」——請先用 list_wiki_pages 確認檔名`);
      }
      const res = await wikiFetch(env, file);
      if (!res.ok) throw new Error(`讀取條目失敗（HTTP ${res.status}）`);
      return await res.text();
    },
  },
  {
    name: "search_wiki",
    description: "以關鍵字全文搜尋所有 Wiki 條目，回傳每頁的命中行。簡繁通用（繁體查得到簡體、反之亦然）；多個關鍵字用空白隔開，慣用語自動對到正式名稱。適合「哪個條目講過 XX」這類跨頁定位。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "關鍵字" } },
      required: ["query"],
    },
    async handler(env, args) {
      const plan = needPlan(args);
      const pages = await wikiPages(env);
      // Wiki 是逐行命中：整頁先算分決定要不要列，再挑出頁內命中的行
      const pageResults = await Promise.all(
        pages.map(async (p) => {
          const res = await wikiFetch(env, p.file);
          if (!res.ok) return null;
          const text = await res.text();
          const lines = text.split("\n");
          const scored = runSearch([{ p, text, lines }], plan, (row) => row.text);
          if (!scored.hits.length) return null;
          const hits = [];
          for (let i = 0; i < lines.length && hits.length < 4; i++) {
            if (matchesPlan(lines[i], plan)) hits.push(`  - L${i + 1}：${clip(lines[i], 160)}`);
          }
          // 整頁有命中但沒有單一行同時命中（多詞散落在不同行）→ 退回列出各詞的所在行
          if (!hits.length) {
            for (const token of plan.tokens) {
              for (let i = 0; i < lines.length && hits.length < 4; i++) {
                if (matchesPlan(lines[i], { ...plan, tokens: [token] })) {
                  hits.push(`  - L${i + 1}：${clip(lines[i], 160)}`);
                  break;
                }
              }
            }
          }
          return {
            score: scored.hits[0],
            text: `## ${p.title}（${p.file}）\n${hits.join("\n")}`,
          };
        })
      );
      const matched = pageResults.filter(Boolean);
      if (!matched.length) return noHitMessage("所有 Wiki 條目", plan);
      // 有整頁全詞命中的條目時只列這些（AND）；全部都只部分命中才降級把它們列出來
      const full = matched.filter((item) => item.score.anyHits === plan.tokens.length);
      const found = full.length ? full : matched;
      found.sort((a, b) => b.score.origHits - a.score.origHits || b.score.anyHits - a.score.anyHits);
      return withSearchNotes(
        plan,
        { degraded: isDegraded({ total: found.length, fullMatches: full.length }) },
        found.map((item) => item.text).join("\n\n")
      );
    },
  },
  {
    name: "list_fieldlog_folders",
    description: "列出隨身記的所有資料夾（參展／拜訪／實驗／上課等活動，含巢狀子資料夾）與各自的紀錄數量。想把 search_fieldlog 縮小到某個資料夾（例如專門歸檔標準規範的資料夾）時，先用這個查 folder id。",
    inputSchema: { type: "object", properties: {} },
    async handler(env) {
      const { results } = await env.DB_FIELDLOG.prepare(
        `SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id) AS entry_count
         FROM folders f ORDER BY f.status = '進行中' DESC, f.id DESC`
      ).all();
      if (!results.length) return "隨身記目前沒有任何資料夾。";
      // 資料夾有 parent_id 巢狀結構（四層目錄）：先照樹狀排序（父在子之前）再縮排顯示，
      // 路徑才看得懂，不會出現子資料夾印在父資料夾前面的怪順序
      const byParent = new Map();
      for (const f of results) {
        const key = f.parent_id ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(f);
      }
      const lines = [];
      const visited = new Set();
      const walk = (parentKey, depth) => {
        for (const f of byParent.get(parentKey) || []) {
          if (visited.has(f.id)) continue; // 保險：資料異常成環時不要無限遞迴
          visited.add(f.id);
          lines.push(`${"  ".repeat(depth)}- [${f.id}] ${f.type}｜${f.name}｜${f.status}｜${f.entry_count} 筆紀錄｜建於 ${f.created_at}`);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      // 保險：parent_id 指向已刪除/查無的資料夾時不會被上面的樹狀遞迴印到，補在最後
      for (const f of results) if (!visited.has(f.id)) lines.push(`- [${f.id}] ${f.type}｜${f.name}｜${f.status}｜${f.entry_count} 筆紀錄｜建於 ${f.created_at}`);
      return lines.join("\n");
    },
  },
  {
    name: "list_fieldlog_entries",
    description: "列出隨身記的紀錄清單（含每筆紀錄底下的附件檔名）。用途：檔名本身通常就承載了大部分判斷資訊（例如 ISO_10555-8_2024_血管內導管-無菌及單次使用導管-第8部_體外血液處理用導管.pdf，光看檔名就知道要不要讀），與其對 search_fieldlog 反覆猜關鍵字、猜不中就誤判成「沒有這份資料」，不如先用這個看資料夾裡實際有什麼。folder_id 用 list_fieldlog_folders 查。回傳有分頁，total 是總筆數，has_more 是否還有更多。",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: { type: "number", description: "選填：只列這個資料夾（不含子資料夾）；不給就列全庫，建議先用 list_fieldlog_folders 查 id" },
        limit: { type: "number", description: "每頁最多幾筆（預設 30，上限 100）" },
        offset: { type: "number", description: "分頁位移，預設 0" },
      },
    },
    async handler(env, args) {
      const folderId = args.folder_id !== undefined && args.folder_id !== null && args.folder_id !== ""
        ? Number(args.folder_id) : null;
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);

      const where = folderId !== null ? "WHERE e.folder_id = ?" : "";
      const binds = folderId !== null ? [folderId] : [];
      const totalRow = await env.DB_FIELDLOG.prepare(
        `SELECT COUNT(*) AS c FROM entries e ${where}`
      ).bind(...binds).first();
      const total = Number(totalRow?.c || 0);
      if (!total) {
        return folderId !== null
          ? `資料夾 ${folderId} 裡沒有任何紀錄（folder_id 存在的話代表是空資料夾；不存在就是查無此資料夾，先用 list_fieldlog_folders 確認）。`
          : "隨身記目前沒有任何紀錄。";
      }

      const { results: entries } = await env.DB_FIELDLOG.prepare(
        `SELECT e.id, e.title, e.created_at, e.updated_at, e.folder_id, f.name AS folder_name, f.type AS folder_type
         FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
         ${where}
         ORDER BY e.id DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      const ids = entries.map((e) => e.id);
      const attMap = new Map(ids.map((id) => [id, []]));
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const { results: atts } = await env.DB_FIELDLOG.prepare(
          `SELECT entry_id, id, filename, kind FROM attachments WHERE entry_id IN (${placeholders}) AND source_pdf_id IS NULL ORDER BY id`
        ).bind(...ids).all();
        for (const a of atts) attMap.get(a.entry_id)?.push(a);
      }

      const lines = entries.map((e) => {
        const where2 = e.folder_name ? `${e.folder_type}｜${e.folder_name}` : "收件匣";
        const files = attMap.get(e.id) || [];
        // 檔名是主要判斷依據，不截斷；用逐行列出而不是逗號接成一串，長檔名才不會混在一起看不清
        const fileLines = files.length
          ? files.map((a) => `    - [attachment ${a.id}] ${a.kind}｜${a.filename}`).join("\n")
          : "    （沒有附件）";
        return `- [entry ${e.id}] ${e.title || "（未命名）"}｜${where2}｜建立 ${e.created_at}${e.updated_at ? `｜更新 ${e.updated_at}` : ""}\n${fileLines}`;
      });

      const shown = offset + entries.length;
      const hasMore = shown < total;
      const header = `共 ${total} 筆，目前顯示第 ${offset + 1}–${shown} 筆${hasMore ? `（還有更多，加 offset: ${shown} 繼續拉）` : "（已到底）"}`;
      return [header, ...lines].join("\n");
    },
  },
  {
    name: "list_attachments",
    description: "列出隨身記的附件清單（不用先猜關鍵字）。可用 entry_id 只看某一筆紀錄底下的附件，或 folder_id 看整個資料夾的附件；都不給就列全庫。每筆會附內容長度（逐字稿或擷取文字的字元數），用來判斷這份附件夠不夠短可以直接讀、還是要用 get_fieldlog_attachment 的 offset/length 分段拉。",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "number", description: "選填：只列這一筆紀錄的附件" },
        folder_id: { type: "number", description: "選填：只列這個資料夾（不含子資料夾）的附件" },
        limit: { type: "number", description: "每頁最多幾筆（預設 30，上限 100）" },
        offset: { type: "number", description: "分頁位移，預設 0" },
      },
    },
    async handler(env, args) {
      const entryId = args.entry_id !== undefined && args.entry_id !== null && args.entry_id !== ""
        ? Number(args.entry_id) : null;
      const folderId = args.folder_id !== undefined && args.folder_id !== null && args.folder_id !== ""
        ? Number(args.folder_id) : null;
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);

      const clauses = ["a.source_pdf_id IS NULL"]; // 深度處理逐頁圖片不算獨立附件，列出來只會洗版
      const binds = [];
      if (entryId !== null) { clauses.push("a.entry_id = ?"); binds.push(entryId); }
      if (folderId !== null) { clauses.push("e.folder_id = ?"); binds.push(folderId); }
      const where = `WHERE ${clauses.join(" AND ")}`;

      const totalRow = await env.DB_FIELDLOG.prepare(
        `SELECT COUNT(*) AS c FROM attachments a JOIN entries e ON e.id = a.entry_id ${where}`
      ).bind(...binds).first();
      const total = Number(totalRow?.c || 0);
      if (!total) return "沒有符合條件的附件（entry_id／folder_id 存在的話代表底下沒有附件；不存在就是查無）。";

      const { results: atts } = await env.DB_FIELDLOG.prepare(
        `SELECT a.id, a.filename, a.kind, a.entry_id, a.transcript, a.ocr_text, e.title AS entry_title
         FROM attachments a JOIN entries e ON e.id = a.entry_id
         ${where}
         ORDER BY a.id DESC LIMIT ? OFFSET ?`
      ).bind(...binds, limit, offset).all();

      // 父附件自己沒內容時才多查一次子頁面完成度（loadDeepProcessingPages
      // 的說明），不用抓子頁面全文，成本低。
      const lines = await Promise.all(atts.map(async (a) => {
        const text = a.transcript || stripPdfMetadata(a.ocr_text || "");
        let lenNote = text ? `內容長度 ${text.length} 字` : "尚未轉文字／擷取";
        if (!text) {
          const pages = await loadDeepProcessingPages(env, a.id);
          if (pages.length) {
            const done = pages.filter((p) => p.ocr_at).length;
            lenNote = done
              ? `深度處理中：${done}/${pages.length} 頁已擷取`
              : `深度處理已建立 ${pages.length} 頁，尚未擷取`;
          }
        }
        return `- [attachment ${a.id}] ${a.kind}｜${a.filename}｜所屬 [entry ${a.entry_id}] ${a.entry_title || "（未命名）"}｜${lenNote}`;
      }));

      const shown = offset + atts.length;
      const hasMore = shown < total;
      const header = `共 ${total} 筆，目前顯示第 ${offset + 1}–${shown} 筆${hasMore ? `（還有更多，加 offset: ${shown} 繼續拉）` : "（已到底）"}`;
      return [header, ...lines].join("\n");
    },
  },
  {
    name: "search_fieldlog",
    description: "以關鍵字搜尋隨身記：紀錄的標題／內文／欄位，以及附件的檔名／錄音逐字稿／照片與 PDF 擷取文字。簡繁通用（繁體查得到簡體、反之亦然）。多個關鍵字用空白隔開即可（例「7886 注射器」＝兩個詞都要出現）；慣用語會自動對到正式標準名（查「HD管」找得到「體外血液處理用導管」）。可選 folder_id／folder_type 縮小到特定資料夾（例如專門歸檔標準規範、型錄的資料夾——先用 list_fieldlog_folders 查 id）。回傳命中片段與 entry/attachment id；附件命中後用 get_fieldlog_attachment 拉該附件完整未截斷的全文（例如查一份 ISO 標準的完整條文，不是只看片段）。找到 entry 後想看它跟哪些標準／實驗／廠商／專利有交叉關聯，改用 get_related(id)。除了關鍵字命中，也會附帶呼叫 fieldlog 的向量搜尋補一段「語義相關」結果（用詞不同但意思相關、沒建同義詞關係的內容，例如查「低摩擦」能連到寫「親水披膜」的紀錄）；這段是盡力而為，Vectorize 沒建好或 fieldlog 連不上時會靜默省略，不影響關鍵字結果。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字，簡繁不拘。多個詞用空白隔開，預設全部都要命中；全部都要命中時查不到會自動放寬成任一詞命中並標示（例：ISO 7886-1、7886 注射器、抗結痂）" },
        limit: { type: "number", description: "每類最多回傳幾筆（預設 10，上限 30）" },
        folder_id: { type: "number", description: "選填：只搜這個資料夾與其子資料夾（先用 list_fieldlog_folders 查 id）" },
        folder_type: { type: "string", description: "選填：只搜這個類型的資料夾（例：參展、拜訪、實驗、上課、會議、查廠、其他）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const plan = needPlan(args);
      const limit = capLimit(args);
      const wantFolderType = (args.folder_type || "").trim();
      const wantFolderId = args.folder_id !== undefined && args.folder_id !== null && args.folder_id !== "" ? Number(args.folder_id) : null;
      // folder_id 篩選要含子資料夾（四層巢狀目錄，parent_id 串起來），先撈全部資料夾
      // 在 JS 端算出「這個 folder_id 底下的整棵子樹」，比對時看 entry 的 folder 在不在這個集合裡
      let allowedFolderIds = null;
      if (wantFolderId !== null) {
        const { results: allFolders } = await env.DB_FIELDLOG.prepare(`SELECT id, parent_id FROM folders`).all();
        const byParent = new Map();
        for (const f of allFolders) {
          const key = f.parent_id ?? null;
          if (!byParent.has(key)) byParent.set(key, []);
          byParent.get(key).push(f.id);
        }
        allowedFolderIds = new Set();
        const collect = (id) => {
          if (allowedFolderIds.has(id)) return; // 防環
          allowedFolderIds.add(id);
          for (const childId of byParent.get(id) || []) collect(childId);
        };
        collect(wantFolderId);
      }
      // 簡繁摺疊沒辦法交給 SQL LIKE（byte 硬比），改成撈候選列後在 JS 端摺疊比對。
      // 掃描上限 SCAN_CAP 純為記憶體保險；命中上限時會在結果裡明確警示（見下方），
      // 不做靜默截斷。analysis_json（AI 深度解析結果）也在掃描範圍——這是規格書 II
      // 項目 11 的硬要求：解析出來的配方、FTO 風險、待辦若搜不到，等於白做。
      // fieldlog 那邊還沒跑 migration、欄位不存在時只挑資料庫真的有的欄位查，
      // 查詢不能整個炸掉（見上方 tableColumns 的說明）。
      const [entryCols, attCols] = await Promise.all([
        tableColumns(env, "entries"),
        tableColumns(env, "attachments"),
      ]);
      // 這兩組是「新加的、舊資料庫可能還沒有」的欄位；其餘欄位從第一版就存在
      const entryOpt = keepExistingColumns(entryCols, ["body_format", "analysis_json"]);
      const attOpt = keepExistingColumns(attCols, ["analysis_json"]);
      const selectOpt = (alias, cols) => cols.map((c) => ` ${alias}.${c},`).join("");
      const queryBoth = async (optE, optA) => Promise.all([
        env.DB_FIELDLOG.prepare(
          `SELECT e.id, e.folder_id, e.title, e.body,${selectOpt("e", optE)} e.fields_json, e.created_at, f.name AS folder_name, f.type AS folder_type
           FROM entries e LEFT JOIN folders f ON e.folder_id = f.id
           ORDER BY e.id DESC LIMIT ${SCAN_CAP}`
        ).all(),
        env.DB_FIELDLOG.prepare(
          `SELECT a.id AS att_id, a.kind, a.filename, a.transcript, a.ocr_text, a.offset_secs,${selectOpt("a", optA)}
                  e.id AS entry_id, e.folder_id, e.title, f.name AS folder_name, f.type AS folder_type
           FROM attachments a JOIN entries e ON a.entry_id = e.id LEFT JOIN folders f ON e.folder_id = f.id
           ORDER BY a.id DESC LIMIT ${SCAN_CAP}`
        ).all(),
      ]);
      // PRAGMA 查不到欄位清單（回 null → 全部保留）時仍可能撞到缺欄位，
      // 保留一次「全部拿掉選用欄位」的退回，當最後一道防線
      const [{ results: allEntries }, { results: allAtts }] =
        await queryBoth(entryOpt, attOpt).catch(() => queryBoth([], []));
      const inScope = (row) =>
        (!wantFolderType || row.folder_type === wantFolderType) &&
        (allowedFolderIds === null || allowedFolderIds.has(row.folder_id));
      for (const a of allAtts) a._ocr = stripPdfMetadata(a.ocr_text || ""); // 即時剝 PDF metadata
      // 富文字記事（body_format='html'）先剝成純文字再進比對／顯示，避免標籤與
      // 屬性造成雜訊或誤判命中——這裡跟搜尋/顯示層假設「body 是純文字」一致
      for (const e of allEntries) e._body = e.body_format === "html" ? htmlToPlainText(e.body) : (e.body || "");
      const entryHits = runSearch(
        allEntries.filter(inScope),
        plan,
        (e) => `${e.title}\n${e._body}\n${e.fields_json}\n${e.analysis_json || ""}`,
        limit
      );
      const attHits = runSearch(
        allAtts.filter(inScope),
        plan,
        (a) => `${a.transcript}\n${a._ocr}\n${a.filename}\n${a.analysis_json || ""}`,
        limit
      );
      const out = [];
      if (entryHits.hits.length) {
        out.push("## 命中的紀錄");
        for (const { row: e } of entryHits.hits) {
          const where = e.folder_name ? `${e.folder_type}｜${e.folder_name}` : "收件匣";
          const hitText = pickHitField([e.title, e._body, e.fields_json, e.analysis_json], plan) || e._body;
          const aiMark = e.analysis_json && !matchesPlan(`${e.title}\n${e._body}\n${e.fields_json}`, plan) ? "｜⚠ 命中在 AI 解析段（非原始紀錄）" : "";
          out.push(`- [entry ${e.id}] ${e.title || "（未命名）"}｜${where}｜${e.created_at}${aiMark}\n  ${planSnippet(hitText, plan)}`);
        }
      }
      if (attHits.hits.length) {
        out.push("## 命中的附件（檔名／逐字稿／擷取文字，想看完整全文用 get_fieldlog_attachment(id)）");
        for (const { row: a } of attHits.hits) {
          const src = pickHitField([a.transcript, a._ocr, a.filename, a.analysis_json], plan);
          const off = a.offset_secs !== null && a.offset_secs !== undefined ? `｜錄音 ${fmtSecs(a.offset_secs)}` : "";
          out.push(`- [attachment ${a.att_id}／entry ${a.entry_id}] ${a.kind}｜${a.filename}${off}｜所屬紀錄：${a.title || "（未命名）"}\n  ${planSnippet(src, plan)}`);
        }
      }
      // 語義相關的補充結果：只補「關鍵字沒命中過」的附件（用 attachment id 去重），
      // 避免同一份附件因為關鍵字命中一次、語義又命中一次而出現兩遍
      const seenAttIds = new Set(attHits.hits.map(({ row }) => row.att_id));
      const vecResults = await fieldlogVectorSearch(env, args.query, {
        topK: limit,
        folderId: wantFolderId,
      });
      if (vecResults && vecResults.length) {
        const newOnes = vecResults.filter((r) => r.attachment && !seenAttIds.has(r.attachment.id));
        if (newOnes.length) {
          out.push("## 語義相關（向量搜尋，用詞不同但意思相關，關鍵字沒對上）");
          for (const r of newOnes) {
            const att = r.attachment;
            const entry = r.entry;
            const src = att.transcript || stripPdfMetadata(att.ocr_text || "") || att.filename;
            const off = att.offset_secs !== null && att.offset_secs !== undefined ? `｜錄音 ${fmtSecs(att.offset_secs)}` : "";
            out.push(`- [attachment ${att.id}／entry ${att.entry_id}] ${att.kind}｜${att.filename}${off}｜所屬紀錄：${entry?.title || "（未命名）"}｜相似度 ${r.score.toFixed(2)}\n  ${String(src).slice(0, 200)}`);
          }
        }
      }

      if (!out.length) {
        const scopeNote = (wantFolderType || wantFolderId !== null)
          ? "這次有限定資料夾範圍；範圍設定得太窄的話拿掉 folder_id／folder_type 再查一次全庫。"
          : "";
        return noHitMessage("隨身記", plan, scopeNote);
      }
      // 掃描達到上限＝有更舊的資料根本沒進比對——一定要講，不能讓「沒搜到」
      // 被誤讀成「資料庫裡沒有」（規格書 I 項目 7 的短期修法；中期換 FTS5）
      if (allEntries.length >= SCAN_CAP || allAtts.length >= SCAN_CAP) {
        out.push("", `⚠ 資料量已達單次掃描上限 ${SCAN_CAP} 筆，較舊的資料未納入本次比對——用 folder_id 縮小範圍再查，或提醒維護者該換 FTS5 全文索引了。`);
      }
      // 兩類結果只要有一類是全詞 AND 命中，就不算降級
      return withSearchNotes(plan, { degraded: isDegraded(entryHits, attHits) }, out.join("\n"));
    },
  },
  {
    name: "get_fieldlog_entry",
    description: "讀取隨身記單筆紀錄的完整內容：欄位、內文、所有附件的逐字稿與照片/PDF擷取文字（每個附件有長度上限，超過會截斷並提示；附件內容截斷時改用 get_fieldlog_attachment 拉那一個附件的完整全文，例如一份完整的 ISO 標準條文）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "entry id（search_fieldlog 回傳的編號）" } },
      required: ["id"],
    },
    async handler(env, args) {
      const id = Number(args.id);
      if (!id) throw new Error("id 為必填");
      const e = await env.DB_FIELDLOG.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
      if (!e) throw new Error(`找不到 entry ${id}`);
      const { results: atts } = await env.DB_FIELDLOG.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(id).all();
      const lines = [`# ${e.title || "（未命名紀錄）"}`, `建立：${e.created_at}${e.updated_at ? `｜更新：${e.updated_at}` : ""}`];
      const allFields = JSON.parse(e.fields_json || "{}");
      if (allFields._orphaned) lines.push("⚠ 此筆的來源資料已從外部知識庫移除——記事保留，但之後不會再更新。");
      // _ 開頭是同步機制的內部欄位（_sid／_content_hash…），對讀者是雜訊
      const fields = Object.entries(allFields).filter(([k, v]) => !k.startsWith("_") && v && String(v).trim());
      for (const [k, v] of fields) lines.push(`- **${k}**：${v}`);
      // 富文字記事（body_format='html'）先剝成純文字；純文字記事維持原本邏輯——
      // 來源同步區的 HTML 註解標記只給同步引擎認位置用，顯示時拿掉
      const bodyText = e.body_format === "html"
        ? htmlToPlainText(e.body)
        : (e.body || "").replace(/^<!-- sync:(start|end)[^\n]*-->$/gm, "").trim();
      if (bodyText) lines.push("", bodyText);
      const analysis = analysisSection(e);
      if (analysis) lines.push("", analysis);
      // 單筆紀錄常見多個附件，每個給預覽長度上限（避免一次撈爆整個回應）；
      // 完整全文（例如一份幾千字的 ISO 標準 PDF）用 get_fieldlog_attachment(id) 單獨拉
      const PREVIEW_CAP = 6000;
      for (const a of atts) {
        const off = a.offset_secs !== null && a.offset_secs !== undefined ? `（錄音 ${fmtSecs(a.offset_secs)}）` : "";
        lines.push("", `## 附件 [${a.id}]：${a.filename}｜${a.kind}${off}`);
        const ocrBody = stripPdfMetadata(a.ocr_text || ""); // 修正：先前這裡漏了剝 PDF metadata，會show出一堆 Creator=/PDFFormatVersion= 雜訊
        if (a.transcript) {
          lines.push(`逐字稿：${clip(a.transcript, PREVIEW_CAP)}`);
          if (a.transcript.length > PREVIEW_CAP) lines.push(`（逐字稿共 ${a.transcript.length} 字，above 已截斷，完整全文用 get_fieldlog_attachment(${a.id})）`);
        }
        if (ocrBody) {
          lines.push(`擷取文字：${clip(ocrBody, PREVIEW_CAP)}`);
          if (ocrBody.length > PREVIEW_CAP) lines.push(`（擷取文字共 ${ocrBody.length} 字，above 已截斷，完整全文用 get_fieldlog_attachment(${a.id})）`);
        }
        if (!a.transcript && !ocrBody) lines.push("（尚未轉文字／擷取，或該檔案本身沒有可擷取的文字內容）");
      }
      return lines.join("\n");
    },
  },
  {
    name: "get_fieldlog_attachment",
    description: "讀取隨身記單一附件的文字內容（逐字稿或擷取文字），PDF 已自動剝除檔案 metadata 雜訊。用途：search_fieldlog 或 get_fieldlog_entry 找到候選附件、內容被截斷時，用這個拉出完整全文——例如查一份 ISO/ASTM 標準 PDF 的完整條文、或一段完整的會議逐字稿，不是只看片段摘要。單次最多回傳 20000 字；超過這個長度時回應會明確標示總長度與目前顯示範圍，並可用 offset／length 分段接續讀完全文，段落間不會遺漏。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "attachment id（search_fieldlog 回傳的 attachment id，或 get_fieldlog_entry 附件標題旁的 [id]）" },
        offset: { type: "number", description: "選填：從全文第幾個字元開始讀（預設 0）。內容超過 20000 字時，用上一次回應告訴你的「下一段 offset」接續讀，讀到「已到全文末尾」為止" },
        length: { type: "number", description: "選填：這次最多讀幾個字元（預設 20000，上限 20000）" },
      },
      required: ["id"],
    },
    async handler(env, args) {
      const id = Number(args.id);
      if (!id) throw new Error("id 為必填");
      const a = await env.DB_FIELDLOG.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
      if (!a) throw new Error(`找不到附件 ${id}——請先用 search_fieldlog 或 get_fieldlog_entry 查編號`);
      const e = await env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(a.entry_id).first();
      const off = a.offset_secs !== null && a.offset_secs !== undefined ? `｜錄音 ${fmtSecs(a.offset_secs)}` : "";
      const lines = [
        `# ${a.filename}`,
        `類型：${a.kind}｜所屬紀錄：${e ? `[entry ${e.id}] ${e.title || "（未命名）"}` : `entry ${a.entry_id}`}${off}｜上傳：${a.created_at}`,
      ];
      const ocrBody = stripPdfMetadata(a.ocr_text || "");
      // 罕見情況下一份附件可能兩者都有值（例如手動編輯過擷取文字又補了逐字稿）；
      // 兩段都合進同一份全文再分頁，不能只挑一段，否則另一段會靜默消失。
      // AI 深度解析（若有）也是一段，跟著同一套 offset 分頁，並且明確標示是 AI 產出
      const sections = [];
      if (a.transcript) sections.push(`## 逐字稿\n${a.transcript}`);
      if (ocrBody) sections.push(`## 擷取文字\n${ocrBody}`);
      // get_fieldlog_entry 因為列出 entry 底下全部附件（含子頁面）才看得到
      // 深度處理的內容，這裡也要併進來，兩支工具才會讀到同一份最終狀態。
      if (!a.source_pdf_id) {
        const pages = await loadDeepProcessingPages(env, id);
        const doneTexts = pages
          .filter((p) => p.ocr_at)
          .map((p) => stripPdfMetadata(p.ocr_text || "").trim())
          .filter(Boolean);
        if (doneTexts.length) {
          const doneCount = pages.filter((p) => p.ocr_at).length;
          sections.push(`## 逐頁擷取文字（深度處理，共 ${pages.length} 頁，${doneCount} 頁已完成）\n${doneTexts.join("\n\n---\n\n")}`);
        }
      }
      const analysis = analysisSection(a);
      if (analysis) sections.push(analysis);
      const fullText = sections.join("\n\n");

      if (!fullText) {
        lines.push("", "（這個附件還沒轉文字/擷取，或該檔案本身沒有可擷取的文字內容——PDF 若是圖形排版、沒有文字層，一般擷取抓不到，需要 Tier 2 深度處理）");
        return lines.join("\n");
      }

      const start = Math.max(0, Number(args.offset) || 0);
      const chunkLength = Math.min(ATTACHMENT_CHUNK_CAP, Math.max(1, Number(args.length) || ATTACHMENT_CHUNK_CAP));
      const chunk = fullText.slice(start, start + chunkLength);
      const end = start + chunk.length;
      const truncated = end < fullText.length;

      lines.push("", start > 0 || truncated ? `（第 ${start + 1}–${end} 字，共 ${fullText.length} 字）` : "（完整全文）", chunk);
      if (truncated) {
        lines.push("", `（還有 ${fullText.length - end} 字未顯示——用 offset: ${end} 再呼叫一次這個工具接續讀，讀到「完整全文」或沒有這行提示為止）`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "get_related",
    description: "查詢隨身記裡『這筆記事跟哪些其他記事有關聯』（雙向），例如一份 ISO 標準被哪些實驗引用、一家廠商對照哪些專利、一次查廠關聯到哪次拜訪。這是交叉比對用的，不是關鍵字搜尋——關聯要明確建立過（在隨身記前端點「🔗 新增關聯」，或用 create_relation 工具）才查得到，系統不會自動猜。找不到關聯不代表沒關係，可能只是還沒建立過。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "entry id（search_fieldlog 或 get_fieldlog_entry 查到的編號）" } },
      required: ["id"],
    },
    async handler(env, args) {
      const id = Number(args.id);
      if (!id) throw new Error("id 為必填");
      const e = await env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(id).first();
      if (!e) throw new Error(`找不到 entry ${id}`);
      const { results } = await env.DB_FIELDLOG.prepare(
        `SELECT r.*, ent.title AS other_title, f.name AS other_folder_name, f.type AS other_folder_type
         FROM relations r
         JOIN entries ent ON ent.id = (CASE WHEN r.from_entry_id = ? THEN r.to_entry_id ELSE r.from_entry_id END)
         LEFT JOIN folders f ON f.id = ent.folder_id
         WHERE r.from_entry_id = ? OR r.to_entry_id = ?
         ORDER BY r.id DESC`
      ).bind(id, id, id).all();
      if (!results.length) return `[entry ${id}] ${e.title || "（未命名）"} 目前沒有任何關聯（關聯要在隨身記前端手動建立，用 search_fieldlog 找到候選記事後，去隨身記 App 點「🔗 新增關聯」）。`;
      const lines = [`# ${e.title || "（未命名）"} 的關聯`];
      for (const r of results) {
        const isFrom = r.from_entry_id === id;
        const otherId = isFrom ? r.to_entry_id : r.from_entry_id;
        const arrow = isFrom ? "→" : "←";
        const where = r.other_folder_name ? `${r.other_folder_type}｜${r.other_folder_name}` : "收件匣";
        lines.push(`- ${arrow} [entry ${otherId}] ${r.relation_type}：${r.other_title || "（未命名）"}｜${where}${r.note ? `（${r.note}）` : ""}`);
      }
      return lines.join("\n");
    },
  },
  {
    // 這是 MCP 兩個「可以寫入」的工具之一。範圍刻意鎖得很窄：只能 INSERT 一筆全新的
    // entries 列，不能 UPDATE、不能 DELETE，程式碼裡也確實沒有任何 UPDATE/DELETE 語句
    // 碰得到 entries／attachments／folders。改內容、刪東西一律要回隨身記前台自己動手。
    name: "create_fieldlog_entry",
    description: "在隨身記新增一筆記事（只能新增一筆全新的記事，不會修改或刪除任何既有內容）。適合在對話中臨時想記一件事、或幫忙把討論的重點存下來。可選填 folder_id 直接歸檔（先用 list_fieldlog_folders 查 id）；不填就留在收件匣，之後使用者自己在 App 裡歸檔。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "標題" },
        body: { type: "string", description: "內文／速記" },
        folder_id: { type: "number", description: "選填：直接歸檔到這個資料夾（先用 list_fieldlog_folders 查 id）" },
        fields: { type: "object", description: "選填：依資料夾類型的自訂欄位，例如標準類型可填 {\"標準編號\":\"ISO 10555-1\"}" },
      },
      required: ["title"],
    },
    async handler(env, args) {
      const title = (args.title || "").trim();
      if (!title) throw new Error("title 為必填");
      const body = (args.body || "").trim();
      const wantFolderId = args.folder_id !== undefined && args.folder_id !== null && args.folder_id !== "" ? Number(args.folder_id) : null;
      let folder = null;
      if (wantFolderId !== null) {
        folder = await env.DB_FIELDLOG.prepare("SELECT id, name, type FROM folders WHERE id = ?").bind(wantFolderId).first();
        if (!folder) throw new Error(`找不到資料夾 ${wantFolderId}——先用 list_fieldlog_folders 查正確的 id`);
      }
      const fields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? args.fields : {};
      const r = await env.DB_FIELDLOG.prepare(
        "INSERT INTO entries (folder_id, title, fields_json, body, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(wantFolderId, title, JSON.stringify(fields), body, now()).run();
      const entryId = r.meta.last_row_id;
      await env.DB_FIELDLOG.prepare(
        "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(entryId, wantFolderId, "新增紀錄", `${title}（透過 MCP／claude.ai 新增）`, now()).run();
      return `已新增 [entry ${entryId}] ${title}${folder ? `，歸檔到「${folder.name}」（${folder.type}）` : "，目前在收件匣，之後可在 App 裡歸檔"}。`;
    },
  },
  {
    // 第二個可寫入工具，但走的是 HTTP 而不是直接 INSERT D1：MCP 這個 Worker
    // 沒有綁 R2（見 wrangler.jsonc），檔案本體只能透過 FIELDLOG Service Binding
    // 打對方既有的 POST /api/upload——跟 App 上傳完全同一條路徑、同一套去重
    // 邏輯（content_hash 一樣的檔案會被擋掉），只是呼叫方從瀏覽器換成這裡。
    // base64 是塞進對話裡的，Claude 要自己把整份檔案內容打出來當參數，實務上
    // 只適合幾 MB 內的檔案——太大的請使用者改在 App 手動上傳。
    name: "create_fieldlog_attachment",
    description: "把檔案（Word／Excel／PDF／圖片等）上傳進隨身記，掛到一筆已存在的記事底下（只能新增附件，不會修改或刪除任何既有內容）。entry_id 用 search_fieldlog／list_fieldlog_entries 查到的編號，或先呼叫 create_fieldlog_entry 新建一筆再用它回傳的 id。檔案內容要轉成 base64 傳入——受限於對話環境，只適合幾 MB 內的檔案（伺服器端上限 8MB），太大的檔案請使用者改在隨身記 App 裡手動上傳。若跟該記事底下某份既有附件內容完全相同會直接略過，不會重複上傳。",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "number", description: "掛到哪一筆記事底下（search_fieldlog／list_fieldlog_entries 查到的編號，或剛用 create_fieldlog_entry 建立的 id）" },
        filename: { type: "string", description: "檔名，含副檔名，例如「測試報告.docx」" },
        mime_type: { type: "string", description: "選填，MIME type，例如 application/pdf、application/vnd.openxmlformats-officedocument.wordprocessingml.document（Word）、application/vnd.openxmlformats-officedocument.spreadsheetml.sheet（Excel）；不填會存成 application/octet-stream" },
        data_base64: { type: "string", description: "檔案內容的 base64 編碼字串" },
      },
      required: ["entry_id", "filename", "data_base64"],
    },
    async handler(env, args) {
      const entryId = Number(args.entry_id);
      if (!entryId) throw new Error("entry_id 為必填");
      const filename = (args.filename || "").trim();
      if (!filename) throw new Error("filename 為必填");
      const mimeType = (args.mime_type || "").trim() || "application/octet-stream";
      if (!args.data_base64) throw new Error("data_base64 為必填");
      let bytes;
      try {
        bytes = base64ToBytes(String(args.data_base64));
      } catch (err) {
        throw new Error(`data_base64 不是合法的 base64：${err.message}`);
      }
      if (!bytes.length) throw new Error("檔案內容為空");
      const UPLOAD_CAP = 8 * 1024 * 1024;
      if (bytes.length > UPLOAD_CAP) {
        throw new Error(`檔案 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超過透過對話上傳的上限（${UPLOAD_CAP / 1024 / 1024}MB）——請使用者改在隨身記 App 裡手動上傳`);
      }
      if (!env.FIELDLOG) throw new Error("尚未設定 FIELDLOG Service Binding（見 mcp/README.md）");
      const entry = await env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(entryId).first();
      if (!entry) throw new Error(`找不到記事 ${entryId}——先用 search_fieldlog／list_fieldlog_entries 查正確的 id，或用 create_fieldlog_entry 新建一筆`);
      const u = new URL("https://fieldlog.internal/api/upload");
      u.searchParams.set("pin", (env.FIELD_PIN || "").trim());
      const res = await env.FIELDLOG.fetch(u.toString(), {
        method: "POST",
        headers: {
          "content-type": mimeType,
          "x-entry-id": String(entryId),
          "x-filename": encodeURIComponent(filename),
        },
        body: bytes,
      });
      if (res.status === 409) {
        const dup = await res.json().catch(() => ({}));
        if (dup.duplicate) return `檔案「${filename}」跟附件 ${dup.id} 內容完全相同，已略過重複上傳。`;
      }
      if (!res.ok) {
        throw new Error(`上傳失敗（HTTP ${res.status}）：${await fieldlogErrorDetail(res)}`);
      }
      const payload = await res.json().catch(() => ({}));
      return `已上傳「${filename}」（${(bytes.length / 1024).toFixed(0)}KB）到 [entry ${entryId}] ${entry.title || "（未命名）"}，附件 id ${payload.id}。`;
    },
  },
  {
    // 第三個可寫入工具：一樣只 INSERT，不 UPDATE／DELETE。這支存在的理由是這次的核心
    // 訴求——聊天聊到「這次實驗其實引用了某份標準」時，不用中斷去開 App 手動連，
    // 直接在對話裡把兩筆已存在的記事連起來，之後 get_related 就查得到。
    name: "create_relation",
    description: "把隨身記裡兩筆已存在的記事建立關聯（只能新增關聯，不會修改或刪除任何既有記事或關聯）。例如聊到「這次實驗其實是引用某份 ISO 標準」，可以直接用這個工具把兩筆記事連起來，之後 get_related 就查得到。兩筆記事都必須已經存在——先用 search_fieldlog 或 list_fieldlog_folders 確認正確的 entry id，不要用猜的編號。",
    inputSchema: {
      type: "object",
      properties: {
        from_entry_id: { type: "number", description: "關聯的起點 entry id" },
        to_entry_id: { type: "number", description: "關聯的終點 entry id" },
        relation_type: { type: "string", description: "關係說明，例：引用標準、被引用於、測試對象、專利依據、供應商、比對對象" },
        note: { type: "string", description: "選填備註" },
      },
      required: ["from_entry_id", "to_entry_id", "relation_type"],
    },
    async handler(env, args) {
      const fromId = Number(args.from_entry_id);
      const toId = Number(args.to_entry_id);
      const relationType = (args.relation_type || "").trim();
      if (!fromId || !toId) throw new Error("from_entry_id 與 to_entry_id 為必填");
      if (fromId === toId) throw new Error("不能關聯到自己");
      if (!relationType) throw new Error("relation_type 為必填");
      const [from, to] = await Promise.all([
        env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(fromId).first(),
        env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(toId).first(),
      ]);
      if (!from || !to) throw new Error(`找不到其中一筆記事（from ${fromId}／to ${toId}）——先用 search_fieldlog 確認正確的 entry id`);
      const r = await env.DB_FIELDLOG.prepare(
        "INSERT INTO relations (from_entry_id, to_entry_id, relation_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(fromId, toId, relationType, (args.note || "").trim(), now()).run();
      await env.DB_FIELDLOG.prepare(
        "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(fromId, null, "新增關聯", `${relationType} → entry ${toId}（透過 MCP／claude.ai 新增）`, now()).run();
      return `已建立關聯（id ${r.meta.last_row_id}）：[entry ${fromId}] ${from.title || "（未命名）"} —${relationType}→ [entry ${toId}] ${to.title || "（未命名）"}`;
    },
  },
  {
    name: "search_exhibitors",
    description: "以關鍵字搜尋 Medtec China 2026 的 585 家展商（名稱／攤位／國家／產品／簡介／分類），並附上團隊共筆狀態（拜訪狀態、指派、部門標籤、紀錄數）。簡繁通用（繁體查得到簡體、反之亦然）；多個關鍵字用空白隔開，慣用語自動對到正式名稱。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字（例：親水塗層、TPU、擠出）。簡繁不拘，多個詞用空白隔開。" },
        limit: { type: "number", description: "最多回傳幾家（預設 10，上限 30）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const plan = needPlan(args);
      const limit = capLimit(args);
      const data = await exhibitorsData(env);
      const found = runSearch(
        data.exhibitors || [],
        plan,
        (ex) => [
          ex.name_zh, ex.name_en, ex.booth_no, ex.country, ex.description,
          categoryName(data, ex.category), ...(ex.products || []), ...(ex.tags || []),
        ].join("\n"),
        limit
      );
      if (!found.hits.length) return noHitMessage("展商名單", plan);
      const top = found.hits.map((item) => item.row);
      const { states, noteCounts } = await medtecStates(env, top.map((h) => h.id));
      const body = top.map((ex) => fmtExhibitor(data, ex, states.get(ex.id), noteCounts.get(ex.id))).join("\n\n");
      const more = found.total > top.length
        ? `\n\n（共 ${found.total} 家符合，只列前 ${top.length} 家——關鍵字再收斂一點可以更準）`
        : "";
      return withSearchNotes(plan, { degraded: isDegraded(found) }, body + more);
    },
  },
  {
    name: "get_exhibitor",
    description: "讀取單一展商的完整資料：主檔＋團隊共筆（拜訪狀態、部門標籤、資質勾選、最近的拜訪紀錄與附件清單）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "展商 id（例：ex-0001，search_exhibitors 回傳的編號）" } },
      required: ["id"],
    },
    async handler(env, args) {
      const id = (args.id || "").trim();
      if (!id) throw new Error("id 為必填");
      const data = await exhibitorsData(env);
      const ex = (data.exhibitors || []).find((x) => x.id === id);
      if (!ex) throw new Error(`找不到展商「${id}」——請先用 search_exhibitors 查編號`);
      let state = null, notes = [], atts = [], attTotal = 0;
      try {
        state = await env.DB_MEDTEC.prepare("SELECT * FROM exhibitor_state WHERE exhibitor_id = ?").bind(id).first();
        notes = (await env.DB_MEDTEC.prepare("SELECT * FROM notes WHERE exhibitor_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 20").bind(id).all()).results;
        atts = (await env.DB_MEDTEC.prepare("SELECT filename, caption, author, created_at, transcript, ocr_text FROM attachments WHERE exhibitor_id = ? ORDER BY id DESC LIMIT 20").bind(id).all()).results;
        attTotal = (await env.DB_MEDTEC.prepare("SELECT COUNT(*) AS c FROM attachments WHERE exhibitor_id = ?").bind(id).first())?.c || 0;
      } catch { /* 共筆表尚未建立時只回主檔 */ }
      const lines = [fmtExhibitor(data, ex, state, notes.length)];
      if (state) {
        const quals = JSON.parse(state.quals || "[]");
        const goals = JSON.parse(state.goal_tags || "[]");
        const collected = JSON.parse(state.collected || "[]");
        if (quals.length) lines.push(`- 資質：${quals.join("、")}`);
        if (goals.length) lines.push(`- 目標標籤：${goals.join("、")}`);
        if (collected.length) lines.push(`- 已索取資料：${collected.join("、")}`);
        if (state.post_class) lines.push(`- 會後分級：${state.post_class}`);
        const vr = JSON.parse(state.visit_record || "{}");
        const vrBits = [];
        if ((vr.obtained || []).length) vrBits.push(`取得：${vr.obtained.join("、")}`);
        if (vr.contact) vrBits.push(`聯絡人：${vr.contact}`);
        if (vr.solves || vr.note) vrBits.push(`能解決什麼：${vr.solves || vr.note}`);
        if (vr.diff) vrBits.push(`差異化：${vr.diff}`);
        if (vr.next_step) vrBits.push(`下一步：${vr.next_step}`);
        if (vrBits.length) lines.push(`- 拜訪成果：${vrBits.join("｜")}`);
      }
      if (notes.length) {
        lines.push("", "## 拜訪紀錄（最新 20 則）");
        for (const n of notes) lines.push(`- ${n.created_at}｜${n.author}｜${n.type}：${clip(n.content, 300)}`);
      }
      if (atts.length) {
        lines.push("", `## 附件（共 ${attTotal} 個，列最新 20 個，含 AI 擷取內容摘要；全文搜尋用 search_exhibitor_files）`);
        for (const a of atts) {
          const content = clip((a.transcript || stripPdfMetadata(a.ocr_text || "")).trim(), 200);
          lines.push(`- ${a.filename}${a.caption ? `｜${a.caption}` : ""}｜${a.author}｜${a.created_at}${content ? `\n  ${content}` : ""}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "search_visit_notes",
    description: "以關鍵字搜尋參展系統的團隊拜訪紀錄全文（誰記了什麼）。簡繁通用（繁體查得到簡體、反之亦然）。回傳紀錄內容與所屬展商。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字" },
        limit: { type: "number", description: "最多回傳幾則（預設 10，上限 30）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const plan = needPlan(args);
      const limit = capLimit(args);
      const { results: all } = await env.DB_MEDTEC.prepare(
        `SELECT * FROM notes WHERE deleted = 0 ORDER BY id DESC LIMIT ${SCAN_CAP}`
      ).all();
      const found = runSearch(all, plan, (n) => n.content || "", limit);
      if (!found.hits.length) return noHitMessage("拜訪紀錄", plan);
      let nameOf = (id) => id;
      try {
        const data = await exhibitorsData(env);
        const map = new Map((data.exhibitors || []).map((x) => [x.id, x.name_zh || x.name_en]));
        nameOf = (id) => map.get(id) || id;
      } catch { /* 展商主檔抓不到時退回顯示 id */ }
      const body = found.hits
        .map(({ row: n }) => `- ${n.created_at}｜${nameOf(n.exhibitor_id)}（${n.exhibitor_id}）｜${n.author}｜${n.type}\n  ${planSnippet(n.content, plan)}`)
        .join("\n");
      const capNote = all.length >= SCAN_CAP ? `\n\n⚠ 資料量已達單次掃描上限 ${SCAN_CAP} 筆，較舊的紀錄未納入本次比對。` : "";
      return withSearchNotes(plan, { degraded: isDegraded(found) }, body) + capNote;
    },
  },
  {
    name: "search_exhibitor_files",
    description: "以關鍵字搜尋參展系統『附件內容』全文：現場錄音逐字稿、照片/PDF 擷取文字、檔名、說明。簡繁通用（繁體查得到簡體、反之亦然——廠商型錄多為簡體）；多個關鍵字用空白隔開，慣用語自動對到正式名稱。展商的型錄內容、現場對話都在這裡——問「某家廠商的塗層方案細節」這類問題時用這個。回傳命中片段與所屬展商。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字（例：親水塗層、PTFE、肝素）。簡繁不拘，多個詞用空白隔開。" },
        limit: { type: "number", description: "最多回傳幾筆（預設 10，上限 30）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const plan = needPlan(args);
      const limit = capLimit(args);
      const { results: all } = await env.DB_MEDTEC.prepare(
        `SELECT id, exhibitor_id, filename, caption, author, created_at, transcript, ocr_text
         FROM attachments ORDER BY id DESC LIMIT ${SCAN_CAP}`
      ).all();
      // 即時剝掉 PDF metadata（現有髒資料不必重跑就乾淨）；檔名保留可搜
      for (const a of all) a._ocr = stripPdfMetadata(a.ocr_text || "");
      const found = runSearch(
        all,
        plan,
        (a) => `${a.transcript}\n${a._ocr}\n${a.filename}\n${a.caption}`,
        limit
      );
      if (!found.hits.length) {
        return noHitMessage("附件內容", plan, "附件要先在前台跑過「Cloudflare AI 整理」才有可搜尋的文字。");
      }
      let nameOf = (id) => id;
      try {
        const data = await exhibitorsData(env);
        const map = new Map((data.exhibitors || []).map((x) => [x.id, x.name_zh || x.name_en]));
        nameOf = (id) => map.get(id) || id;
      } catch { /* 展商主檔抓不到時退回顯示 id */ }
      const body = found.hits
        .map(({ row: a }) => {
          const src = pickHitField([a.transcript, a._ocr, a.caption, a.filename], plan);
          return `- ${nameOf(a.exhibitor_id)}（${a.exhibitor_id}）｜${a.filename}｜${a.author}｜${a.created_at}\n  ${planSnippet(src, plan)}`;
        })
        .join("\n");
      const capNote = all.length >= SCAN_CAP ? `\n\n⚠ 資料量已達單次掃描上限 ${SCAN_CAP} 筆，較舊的附件未納入本次比對。` : "";
      return withSearchNotes(plan, { degraded: isDegraded(found) }, body) + capNote;
    },
  },
  {
    name: "list_exhibitor_files",
    description: "列出某一家展商的全部附件（不用先猜關鍵字）——檔名與說明通常就足以判斷要不要細看，跟 search_exhibitor_files 要先猜對關鍵字比起來，這個直接看清單。每筆附內容長度，用來判斷夠不夠短可以直接讀。先用 search_exhibitors 或 get_exhibitor 查 exhibitor id。",
    inputSchema: {
      type: "object",
      properties: {
        exhibitor_id: { type: "string", description: "展商 id（例：ex-0001），先用 search_exhibitors 查" },
        limit: { type: "number", description: "每頁最多幾筆（預設 30，上限 100）" },
        offset: { type: "number", description: "分頁位移，預設 0" },
      },
      required: ["exhibitor_id"],
    },
    async handler(env, args) {
      const exhibitorId = (args.exhibitor_id || "").trim();
      if (!exhibitorId) throw new Error("exhibitor_id 為必填");
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);

      const totalRow = await env.DB_MEDTEC.prepare(
        "SELECT COUNT(*) AS c FROM attachments WHERE exhibitor_id = ?"
      ).bind(exhibitorId).first();
      const total = Number(totalRow?.c || 0);
      if (!total) return `展商 ${exhibitorId} 底下沒有任何附件（id 存在的話代表還沒上傳；不存在就是查無此展商，先用 search_exhibitors 確認）。`;

      const { results: atts } = await env.DB_MEDTEC.prepare(
        `SELECT id, filename, caption, author, created_at, transcript, ocr_text
         FROM attachments WHERE exhibitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(exhibitorId, limit, offset).all();

      const lines = atts.map((a) => {
        const text = a.transcript || stripPdfMetadata(a.ocr_text || "");
        const lenNote = text ? `內容長度 ${text.length} 字` : "尚未擷取文字";
        return `- [attachment ${a.id}] ${a.filename}${a.caption ? `｜${a.caption}` : ""}｜${a.author}｜${a.created_at}｜${lenNote}`;
      });

      const shown = offset + atts.length;
      const hasMore = shown < total;
      const header = `共 ${total} 筆，目前顯示第 ${offset + 1}–${shown} 筆${hasMore ? `（還有更多，加 offset: ${shown} 繼續拉）` : "（已到底）"}`;
      return [header, ...lines].join("\n");
    },
  },
  {
    name: "sync_status",
    description: "查外部知識庫（litdb 等 sources 表裡的來源）的同步狀態：每個來源最後同步時間、最近幾次同步的新增／更新／跳過筆數與錯誤。用途：懷疑「資料是不是過時」時直接查事實，不用靠記憶。同步本身由 fieldlog 每天凌晨的排程自動跑，這個工具只讀不寫。",
    inputSchema: { type: "object", properties: {} },
    async handler(env) {
      let sources = [];
      let logs = [];
      try {
        ({ results: sources } = await env.DB_FIELDLOG.prepare("SELECT key, label, url, enabled, last_synced_at FROM sources ORDER BY id").all());
        ({ results: logs } = await env.DB_FIELDLOG.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 10").all());
      } catch {
        return "還沒有任何同步紀錄（sources／sync_log 表要等 fieldlog 部署新版並跑過第一次同步才會出現）。";
      }
      if (!sources.length) return "sources 表是空的——目前沒有設定任何外部來源。";
      const lines = ["## 來源清單"];
      for (const s of sources) {
        lines.push(`- ${s.key}（${s.label}）｜${s.enabled ? "啟用" : "停用"}｜最後同步：${s.last_synced_at || "從未同步"}`);
      }
      if (logs.length) {
        lines.push("", "## 最近 10 次同步");
        for (const l of logs) {
          const stats = `新增 ${l.inserted}、更新 ${l.updated}、跳過 ${l.skipped}${l.orphaned ? `、來源已移除 ${l.orphaned}` : ""}`;
          lines.push(`- ${l.finished_at}｜${l.source_key}｜${stats}${l.errors ? `｜⚠ ${l.errors}` : ""}`);
        }
      } else {
        lines.push("", "（還沒有同步紀錄——每天台灣時間 02:00 自動跑，或在 fieldlog 手動 POST /api/admin/sync-sources）");
      }
      return lines.join("\n");
    },
  },
  {
    // 第四支可寫入工具，寫入範圍一樣鎖死在「只能新增」：只 INSERT 一列新的同義詞
    // 對照，沒有 UPDATE／DELETE。要「幫既有的組補一個講法」就再插一列同 canonical
    // 的資料，載入時會自動合併成一組——這樣既有資料永遠不會被改掉或刪掉。
    name: "add_synonym",
    description: "在同義詞表新增一組對照（只能新增，不會修改或刪除既有對照）。用途：search_* 查不到、但你知道那只是「用詞沒對上」時（例如公司內部代號、慣用語），當場補一組，下一次查詢立刻生效——不用改程式碼、不用重新部署。要幫既有的組補新講法：canonical 填同一個正式名稱再加新的 aliases 即可，載入時自動合併。",
    inputSchema: {
      type: "object",
      properties: {
        canonical: { type: "string", description: "正式名稱（例：體外血液處理用導管、抗結痂披膜）" },
        aliases: { type: "array", items: { type: "string" }, description: "慣用講法（例：[\"HD管\",\"洗腎管\"]、內部代號）" },
        codes: { type: "array", items: { type: "string" }, description: "選填：標準編號等「必須完全相同才算命中」的短代號（例：[\"10555-1\"]）" },
      },
      required: ["canonical", "aliases"],
    },
    async handler(env, args) {
      const canonical = (args.canonical || "").trim();
      const aliases = (Array.isArray(args.aliases) ? args.aliases : []).map((a) => String(a).trim()).filter(Boolean);
      const codes = (Array.isArray(args.codes) ? args.codes : []).map((c) => String(c).trim()).filter(Boolean);
      if (!canonical) throw new Error("canonical 為必填");
      if (!aliases.length && !codes.length) throw new Error("至少要給一個 alias 或 code，不然這組對照沒有作用");
      await ensureSynonyms(env); // 確保表已建好（第一次會順便 seed 出廠預設值）
      await env.DB_FIELDLOG.prepare(
        "INSERT INTO synonyms (canonical, aliases_json, codes_json, created_at) VALUES (?, ?, ?, ?)"
      ).bind(canonical, JSON.stringify(aliases), JSON.stringify(codes), now()).run();
      SYN_CACHE = { at: 0 }; // 讓下一次查詢立刻重新載入
      return `已新增同義詞組：「${canonical}」←→ ${[...aliases, ...codes].join("、")}。下一次 search_* 查詢立刻生效。`;
    },
  },
  {
    name: "get_fieldlog_image",
    description: "讀取隨身記照片附件的『圖片本身』（不是擷取文字），讓 Claude 直接看圖判讀——用在斷面形貌、外觀不良、塗層剝離、設備現場照這類必須以視覺判斷的場景。型錄、文件、白板照片要查『內容』請優先用 get_fieldlog_attachment 讀擷取文字（省 token 也更準）。id 用 search_fieldlog／list_attachments／get_fieldlog_entry 查到的 attachment id。僅支援 4MB 以內的 JPEG/PNG/GIF/WebP（HEIC 不支援）。邊長超過 1568px 的照片會自動等比縮圖再回傳（手機拍照常見的 3000-4000px 若不縮圖，單張可能吃掉上萬 token）。第一次使用前建議先呼叫 image_probe 確認目前 client 支援 MCP 圖片顯示。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "attachment id（search_fieldlog／list_attachments／get_fieldlog_entry 查到的編號）" },
      },
      required: ["id"],
    },
    async handler(env, args) {
      const id = Number(args.id);
      if (!id) throw new Error("id 為必填");
      const a = await env.DB_FIELDLOG.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
      if (!a) throw new Error(`找不到附件 ${id}——請先用 search_fieldlog 或 list_attachments 查編號`);
      const mime = String(a.mime || "").toLowerCase().split(";")[0].trim();
      if (!mime.startsWith("image/")) {
        throw new Error(`附件 ${id}（${a.filename}）不是圖片（${a.mime || "未知類型"}）——文件內容請改用 get_fieldlog_attachment(${id}) 讀擷取文字`);
      }
      // Claude API 的圖片內容只收這四種；HEIC（iPhone 相簿原檔常見）進不去，
      // Worker 端也沒有可靠的轉檔手段，據實回報請改走文字路線或以 JPEG 重傳
      const SUPPORTED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      if (!SUPPORTED_IMAGE_MIMES.includes(mime)) {
        throw new Error(`附件 ${id} 的格式 ${mime} 不在支援清單（JPEG/PNG/GIF/WebP）內——HEIC 等格式請在手機端以 JPEG 重傳，或用 get_fieldlog_attachment(${id}) 讀擷取文字`);
      }
      // 與 fieldlog 端 INLINE_RAW_MAX_BYTES 一致。超過就不硬塞：base64 膨脹約 4/3，
      // 對 client 的 context 也是災難，直接指路
      const INLINE_CAP = 4 * 1024 * 1024;
      const size = Number(a.size || 0);
      if (size > INLINE_CAP) {
        throw new Error(`附件 ${id}（${a.filename}）為 ${(size / 1024 / 1024).toFixed(1)}MB，超過 inline 上限 4MB——請在隨身記 App 壓縮後重傳，或改用 get_fieldlog_attachment(${id}) 讀擷取文字`);
      }
      if (!env.FIELDLOG) throw new Error("尚未設定 FIELDLOG Service Binding（見 mcp/README.md）");
      const u = new URL(`https://fieldlog.internal/api/attachments/${id}/raw`);
      u.searchParams.set("mode", "inline");
      u.searchParams.set("pin", (env.FIELD_PIN || "").trim());
      const res = await env.FIELDLOG.fetch(u.toString());
      if (!res.ok) {
        const hint = res.status === 404 ? "（也可能是 fieldlog 部署版本過舊，還沒有 /attachments/:id/raw 端點——commit 5c784dd 之後才有）" : "";
        throw new Error(`讀取原始檔失敗（HTTP ${res.status}）：${await fieldlogErrorDetail(res)}${hint}`);
      }
      const payload = await res.json();
      if (!payload || !payload.data) throw new Error("raw 端點回應缺少 base64 資料——fieldlog 部署版本可能過舊");
      // 邊長超過門檻才縮圖；縮圖失敗（例如損毀的圖檔）不能讓整支工具掛掉，
      // 退回原圖讓 Claude 至少看得到，只是可能比較貴
      let resized;
      try {
        resized = resizeImageIfNeeded(base64ToBytes(payload.data), payload.mime_type || mime);
      } catch (err) {
        resized = { bytes: null, mime: payload.mime_type || mime, resized: false, width: null, height: null, resizeError: err.message };
      }
      const outData = resized.resized ? bytesToBase64(resized.bytes) : payload.data;
      const e = await env.DB_FIELDLOG.prepare("SELECT id, title FROM entries WHERE id = ?").bind(a.entry_id).first();
      const dimensionNote = resized.resizeError
        ? `｜縮圖失敗（${resized.resizeError}），已回傳原圖`
        : resized.resized
          ? `｜已縮圖 ${resized.originalWidth}×${resized.originalHeight} → ${resized.width}×${resized.height}（省 token）`
          : resized.width ? `｜${resized.width}×${resized.height}` : "";
      const meta = [
        `檔名：${a.filename}｜${(Number(payload.size_bytes || size) / 1024).toFixed(0)}KB｜${mime}${dimensionNote}`,
        `所屬紀錄：${e ? `[entry ${e.id}] ${e.title || "（未命名）"}` : `entry ${a.entry_id}`}｜上傳：${a.created_at}`,
      ].join("\n");
      return {
        content: [
          { type: "image", data: outData, mimeType: resized.mime },
          { type: "text", text: meta },
        ],
      };
    },
  },
  {
    name: "image_probe",
    description: "診斷用：回傳一張內建的 96×96 測試圖（四象限色塊），驗證目前 client（claude.ai 等）是否支援顯示 MCP 圖片內容。Claude 若能正確說出四個色塊的顏色與位置，代表圖片通道可用，get_fieldlog_image 才值得使用；若只看到 base64 亂碼或 token 超限錯誤，代表 client 尚未支援，照片請改走 get_fieldlog_attachment 的擷取文字路線。此工具不讀任何使用者資料。",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      return {
        content: [
          { type: "image", data: IMAGE_PROBE_PNG_BASE64, mimeType: "image/png" },
          { type: "text", text: "測試圖已送出：96×96 PNG，四象限色塊。請 Claude 描述所見的顏色配置（哪個角落是什麼顏色）以驗證通道。" },
        ],
      };
    },
  },
];

// image_probe 的內建測試圖：96×96 PNG 四象限色塊（左上紅、右上綠、左下藍、右下黃）。
// 寫死在程式裡、不碰 R2 也不碰 D1——通道測試要把變因減到只剩「client 支不支援」一項。
const IMAGE_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAq0lEQVR42u3TQQ3AIBBFQUoqgTPn1cEZVdWEiIpATDVw2ybzFPxMdq8dUTI1n5ZqTy0CBAgQIECAAAESIECAAAECBAiQAAECBAgQIECAACEABAgQIECAAAESIECAAAECBAiQAAECBAjQL7pnrFSD3j5ckBcDBEiAAAECBAgQIECABAgQIECAAAECJECAAAECBAgQIAECBAgQIECAAAESIECAAAECBAiQAJ33AWJqBSAeWKJeAAAAAElFTkSuQmCC";

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------- MCP JSON-RPC（stateless streamable HTTP）----------

async function handleMcp(request, env) {
  if (request.method === "GET") {
    // 不提供 SSE 串流；stateless server 回 405 即符合規範
    return json({ error: "此端點只接受 MCP POST 請求" }, 405);
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "不支援 batch 請求");
  const { id, method, params } = msg || {};
  if (!method) return rpcError(id ?? null, -32600, "Invalid Request");

  if (method === "initialize") {
    const want = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(want) ? want : PROTOCOL_DEFAULT,
      capabilities: { tools: {} },
      serverInfo: { name: "medapi-mcp", version: "1.0.0" },
      instructions:
        "長儒的個人知識層窗口：策略地圖 Wiki（披膜技術條目）、隨身記（現場採集：逐字稿／照片文字，含一次性併入的 LitDB 文獻/專利）、Medtec 2026 展商與團隊拜訪紀錄。預設唯讀；只有 create_fieldlog_entry（新增記事）、create_fieldlog_attachment（上傳附件，如 Word／Excel／PDF）、create_relation（建立關聯）、add_synonym（新增同義詞對照）四支例外，且全部只能新增、不能修改或刪除既有內容。除此之外要改資料請走各系統前台，wiki 收錄走 git 人審。" +
        " 檢索建議：search_* 查不到不代表沒有這份資料，可能只是關鍵字沒猜對——先用 list_fieldlog_folders／list_fieldlog_entries／list_attachments／list_exhibitor_files 直接看資料夾或展商底下實際有什麼（檔名通常就足以判斷），再決定要不要細看，不要一開始就反覆猜詞；確定是慣用語沒對上時用 add_synonym 當場補一組。" +
        " 照片可以直接看，不是只能讀擷取出來的文字：用 get_fieldlog_image 把照片本身取回來（斷面、外觀不良、現場照這種「文字描述不出來」的東西一定要看圖再判斷，光讀 ocr_text 會漏掉重點）；不確定值不值得取就先用 image_probe 看尺寸與類型。" +
        " 引用紀律：回應裡標示「AI 深度解析」的段落是 AI 產出的整理／推論，不是現場原始紀錄，引用前要回原始內容或來源連結確認；懷疑外部知識庫資料過時就先用 sync_status 查最後同步時間。",
    });
  }
  if (method.startsWith("notifications/")) return new Response(null, { status: 202, headers: CORS_HEADERS });
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS_BY_NAME[params?.name];
    if (!tool) return rpcError(id, -32602, `未知工具：${params?.name}`);
    try {
      await ensureSynonyms(env); // 換上 D1 版同義詞表（5 分鐘快取；讀不到就退回出廠預設值）
      const out = await tool.handler(env, params?.arguments || {});
      return rpcResult(id, wrapToolOutput(out));
    } catch (err) {
      // 欄位不存在＝fieldlog 的 migration 還沒跑過（見 triggerFieldlogSchemaMigration
      // 上方說明）。戳一下讓它補 schema，然後重試一次；成功的話使用者根本不會
      // 察覺，不必自己去開 App，也不用有人來讀錯誤訊息才知道要做什麼。
      if (isMissingColumnError(err)) {
        const migrated = await triggerFieldlogSchemaMigration(env).catch(() => false);
        if (migrated) {
          try {
            const out = await tool.handler(env, params?.arguments || {});
            return rpcResult(id, wrapToolOutput(out));
          } catch (retryErr) {
            // 補過 schema 還是同一個錯：代表這個欄位 fieldlog 那邊也沒有
            // （查詢寫錯欄位名，或 MCP 部署得比 fieldlog 新）。講清楚，不要
            // 讓人以為又是同一個時序問題。
            if (isMissingColumnError(retryErr)) {
              return rpcResult(id, {
                content: [{ type: "text", text: `查詢失敗：${retryErr.message}\n\n已觸發 fieldlog 補 schema 但欄位仍不存在——這不是 migration 時序問題，是 fieldlog 目前部署的版本本來就沒有這個欄位（MCP 部署得比 fieldlog 新，或查詢的欄位名有誤）。` }],
                isError: true,
              });
            }
            return rpcResult(id, { content: [{ type: "text", text: `查詢失敗：${retryErr.message}` }], isError: true });
          }
        }
        return rpcResult(id, {
          content: [{ type: "text", text: `查詢失敗：${err.message}\n\n這是 fieldlog 的 schema migration 還沒跑過造成的。自動補救沒成功（FIELDLOG service binding 或 FIELD_PIN 沒設好），請用帶 PIN 的方式打開一次隨身記 App，讓 fieldlog 的 ensureSchema 執行。` }],
          isError: true,
        });
      }
      return rpcResult(id, { content: [{ type: "text", text: `查詢失敗：${err.message}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      // CORS 預檢不帶認證資訊，瀏覽器也不允許預檢回應是 401——一律放行，
      // 真正的認證在後面實際的 GET/POST 請求上做
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      // fail-closed：MCP_PIN 未設定時全部拒絕
      const pin = (env.MCP_PIN || "").trim();
      if (!pin) return unauthorized("尚未設定 MCP_PIN：請至 Worker Settings → Variables and Secrets 新增");
      const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || bearer).trim();
      // 「沒帶」跟「帶錯」分開講：連接器重連不上時，這一句就決定要去修 URL
      // 還是去對 PIN 值。合在一起寫成「PIN 錯誤或未提供」等於兩邊都要試。
      if (!given) {
        return unauthorized("沒有帶 PIN：claude.ai 自訂連接器不能自帶 header，網址要寫成 https://medapi-mcp.<帳號>.workers.dev/mcp?pin=<你的MCP_PIN>（重新連接時整條網址都要貼，只貼到 /mcp 會落在這裡）");
      }
      if (given !== pin) {
        return unauthorized("PIN 不正確：對一下 Worker Settings → Variables and Secrets 裡的 MCP_PIN（注意不是 FIELD_PIN，兩者刻意不同值）");
      }
      try {
        return await handleMcp(request, env);
      } catch (err) {
        return rpcError(null, -32603, `伺服器錯誤：${err.message}`);
      }
    }
    if (url.pathname === "/") {
      // 部署健康檢查用；不透露任何資料。
      // 附上工具數是為了能從外部一眼判斷「這台有沒有部署到新版」——2026-08-01
      // 新增兩支影像工具後，除了實際連上去之外沒有任何辦法確認部署是否生效，
      // 排查時分不清是「Worker 沒部署」還是「客戶端把工具清單快取住了」。
      // 工具數不是機密（README 本來就寫著），但工具名不列，不擴大暴露面。
      return new Response(
        `medapi-mcp OK — MCP 端點在 POST /mcp（需 ?pin=）\n`
        + `工具數：${TOOLS.length}\n`
        + `（連接器連不上時：先確認這裡的工具數是不是最新的，是的話就是客戶端要重新連接以更新工具清單）\n`,
        { headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS } },
      );
    }
    // 其餘路徑一律 404——尤其是 /.well-known/oauth-*：這個 MCP 只用 PIN，
    // 不做 OAuth，若這裡誤回 200 會讓 claude.ai 誤判成「這台支援 OAuth」
    // 進而嘗試動態註冊、失敗跳出「無法向登入服務註冊」的錯誤。
    //
    // body 一定要是 JSON，不能是純文字。2026-08-02 實測：Claude Code CLI 的
    // HTTP MCP client 對 .well-known/oauth-* 做 OAuth discovery 時，拿到 404
    // 會嘗試把 body 當 JSON 解析（OAuth 規範的錯誤回應本來就該是 JSON）。
    // 純文字 "Not found" 解析失敗直接拋例外，整個連線判定失敗——這不是
    // Claude Code 沒處理 no-OAuth 的情況，是它處理「格式不對的 404」失敗，
    // 而我們能在自己這端避開，不需要對方修：
    //   [ERROR] HTTP 404: Invalid OAuth error response: SyntaxError:
    //   JSON Parse error: Unexpected identifier "Not". Raw body: Not found
    return json({ error: "not found" }, 404);
  },
};
