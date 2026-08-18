/**
 * 隨身助理記事本（fieldlog）— Cloudflare Worker API
 *
 * 定位：現場採集參展/拜訪/實驗/上課/會議/查廠的原始資料（錄音、照片、速記），
 * AI 事後彙整成報告送 Notion。本 Worker 只管 raw data 的存取：
 *   - folders：一個活動/工作項目＝一個資料夾（四層知識架構，type 來自 categories 表）
 *   - entries：一筆紀錄（folder_id 為空＝收件匣，之後再歸檔）
 *   - attachments：照片/錄音段/檔案（存 R2），offset_secs 記錄「錄音第幾秒拍的」
 *   - categories：分類字典（資料夾層級分類＋醫材分類），使用者自己就能增刪改
 *   - history：append-only 歷程
 *   - /api/export/folder/:id：整個資料夾匯出成一份 Markdown 原料包，貼給 AI 彙整
 *
 * 驗證：所有 /api/* 需帶 x-pin header（或 ?pin=），與 FIELD_PIN（Secret）比對。
 * FIELD_PIN 未設定時一律拒絕（fail-closed）。raw data 只增不刪。
 *
 * 這支檔案是唯一入口。在此之前有一條 worker-entry → v49 → v46 → v45 → v43 → v40
 * → v37 → worker.js 的包裝鏈：每加一個功能就包一層新 Worker，用 fetch 轉呼叫下一層，
 * 前端行為靠「把 JS 字串接在 app.js 後面、在執行期覆寫函式」實現。這種疊法讓
 * 同一個功能散在多層、兩份標準檔名對照表互相打架、字串比對式的 patch 會在
 * app.js 一改就靜默失效。整併後全部落回這裡與 public/ 的正常程式碼。
 */

// "cloudflare:workers" 是 Workers runtime 才有的虛擬模組，node:test 直接
// import 這支 worker.js 當一般 ES module 執行時（tests/fieldlog-*.test.js
// 一大票都這樣用）Node 的 ESM loader 解析不到會直接丟
// ERR_UNSUPPORTED_ESM_URL_SCHEME，整支測試檔案連帶掛掉。用動態 import +
// try/catch 才攔得住這個錯誤（靜態 import 是在模組連結階段就失敗，try/catch
// 完全包不住）；測試環境退回一個空殼基底類別，只是讓下面
// `class EmbeddingWorkflow extends WorkflowEntrypoint` 語法上站得住腳，
// 反正測試不會真的建立 Workflow 執行個體（那是 Workers runtime 收到
// binding.create() 呼叫才會做的事）。
let WorkflowEntrypoint;
try {
  ({ WorkflowEntrypoint } = await import("cloudflare:workers"));
} catch {
  WorkflowEntrypoint = class {};
}

import { detectNativeTextKind, extractImageText, extractNativeText, judgeRelation, stripPdfMetadata } from "./imageSkill.js";
import { FOLDER_CATEGORIES, FOLDER_CATEGORY_RANK_SQL, MAX_FOLDER_DEPTH, applyFolderReorg20260808, ensureSchema } from "./lib/schema.js";
import { syncSources } from "./lib/sync.js";
import { cleanupStandardAttachments } from "./lib/cleanup.js";
import { htmlToPlainText, sanitizeEntryHtml, textToHtml } from "./lib/richtext.js";
import {
  deleteAttachmentDeep,
  folderDepth,
  isDescendantOf,
  moveAttachment,
  normalizeAttachmentName,
  subtreeHeight,
} from "./lib/attachments.js";
import {
  createCategory,
  deleteCategory,
  deviceCategoryNames,
  listCategories,
  updateCategory,
} from "./lib/categories.js";
import { ensureStagingFolder } from "./lib/autofile.js";
import { ensurePatrolFolder, formatPatrolReport } from "./lib/patrol.js";
import {
  entrySubtreeIds,
  listTrash,
  moveEntryTreeToTrash,
  moveFolderTreeToTrash,
  permanentlyDeleteTrashItem,
  purgeExpiredTrash,
  restoreTrashItem,
} from "./lib/trash.js";
// 全文搜尋的比對邏輯（斷詞／同義詞展開／簡繁摺疊）跟 medapi-mcp 的
// search_fieldlog 共用同一份，不重寫第二套——mcp 是讀 D1 的「智慧查詢層」，
// fieldlog 是「raw data 存取層」，兩者一直是這個分工；但比對演算法本身是
// 沒有 Cloudflare/MCP 相依的純函式，兩邊 import 同一份完全安全（mcp 早就
// 反向 import fieldlog 的 render.js／richtext.js／schema.js，這裡只是同樣
// 手法用在另一個方向）。
import { buildPlan, isDegraded, pickHitField, planSnippet, runSearch, setSynonymGroups, SYNONYM_SEED } from "../../mcp/src/search.js";

const SEARCH_SCAN_CAP = 5000;
let SEARCH_SYN_CACHE_AT = 0;

function synonymRowsToGroups(rows) {
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

// 5 分鐘記憶體快取，跟 mcp/src/worker.js 的 ensureSynonyms 同一套做法；
// 兩支 Worker 各自快取一份是刻意的，比同步兩個 isolate 的快取簡單得多，
// 代價只是最壞情況下同義詞更新要等 5 分鐘才在兩邊都生效。
//
// 不假設 mcp 一定先跑過（雖然它自己第一次搜尋時也會做同一件事）：這裡的
// 資料表是 fieldlog 的 ensureSchema 建的，但「有表沒資料」時要自己 seed
// 出廠預設值，不能只靠 mcp 那邊剛好先被呼叫過。
async function ensureSearchSynonyms(db, timestamp) {
  if (Date.now() - SEARCH_SYN_CACHE_AT < 5 * 60 * 1000) return;
  try {
    let { results } = await db.prepare("SELECT canonical, aliases_json, codes_json FROM synonyms ORDER BY id").all();
    if (!results?.length) {
      for (const g of SYNONYM_SEED) {
        await db.prepare(
          "INSERT INTO synonyms (canonical, aliases_json, codes_json, created_at) VALUES (?, ?, ?, ?)"
        ).bind(g.canonical, JSON.stringify(g.aliases || []), JSON.stringify(g.codes || []), timestamp()).run();
      }
      ({ results } = await db.prepare("SELECT canonical, aliases_json, codes_json FROM synonyms ORDER BY id").all());
    }
    setSynonymGroups(results?.length ? synonymRowsToGroups(results) : null);
  } catch {
    setSynonymGroups(null); // 讀不到就退回出廠預設值，搜尋不能因為同義詞表壞掉而跟著壞
  }
  SEARCH_SYN_CACHE_AT = Date.now();
}

// 前端資源的版本號。index.html 的 ?v=、sw.js 的 CACHE 名稱、app.js 的 APP_VERSION
// 都要跟這個一致（有測試在把關）。/api/config 會把它回給前端，讓前端能自己判斷
// 「我這份 app.js 是不是舊的」——2026-07-25 花了很久才查出「部署是新的、
// 瀏覽器跑的是舊的」，就是因為當時沒有任何辦法從畫面上看出版本。
const UI_VERSION = "120";

const AI_DAILY_FREE_NEURONS = 10000;
// 2026-07-27 長儒確認：這一層跟錢完全無關（在免費額度內，USD 0），拉到跟
// 免費上限一樣沒有額外風險，改成不再留 30% 緩衝。真的會花錢的月付費上限
// （AI_MONTHLY_SOFT_USD／HARD_USD）維持原值，那層才需要另外評估要不要調。
const AI_AUTO_SAFE_NEURONS = 10000;
const AI_MONTHLY_SOFT_USD = 4.5;
const AI_MONTHLY_HARD_USD = 5;
const AI_RATE_PER_1000_NEURONS = 0.011;

// /attachments/:id/raw?mode=inline 直接回 base64 的大小上限。base64 會膨脹約 4/3，
// 再大就讓呼叫端改走簽名網址。手機照片多半落在 1～4MB，抓 4MB 才涵蓋得住常見情況。
const INLINE_RAW_MAX_BYTES = 4 * 1024 * 1024;

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

// ========== 語意搜尋（Vectorize）==========
// 2026-08 曾在別的分支做過一版，命中率太差沒上線：根因是完全沒把記事本文
// （entries.body）向量化——只有附件轉錄/OCR 內容會排入，速記類記事從頭到尾
// 不在索引裡；而且長文件整篇只取前 2000 字元就丟去 embedding，模型
// （bge-m3）明明吃得下 8192 token，長文件的核心內容反而沒被向量化到。這次
// 重做時把這兩點都堵起來：記事一律整篇 embed（通常不長，不用分段），附件
// 內容真的很長時才切成多段各自 embed（EMBED_CHUNK_SIZE／EMBED_CHUNK_OVERLAP）。

const EMBED_TEXT_CAP = 6000; // 單段最多丟給模型的字元數，留在 bge-m3 8192 token 上限內
const EMBED_CHUNK_SIZE = 1200; // 附件內容超過這個長度才分段
const EMBED_CHUNK_OVERLAP = 100; // 段落間重疊，避免語意剛好被切斷點打斷
const EMBED_MAX_CHUNKS = 20; // 極端長文件的分段數上限，防止失控

// 把長文字切成多段，短文字直接回傳單一元素陣列（不分段）。純函式，方便單元測試。
export function chunkText(text, {
  chunkSize = EMBED_CHUNK_SIZE,
  overlap = EMBED_CHUNK_OVERLAP,
  maxChunks = EMBED_MAX_CHUNKS,
  cap = EMBED_TEXT_CAP,
} = {}) {
  const t = String(text || "").trim();
  if (!t) return [];
  if (t.length <= chunkSize) return [t.slice(0, cap)];
  const chunks = [];
  let start = 0;
  while (start < t.length && chunks.length < maxChunks) {
    chunks.push(t.slice(start, start + chunkSize).slice(0, cap));
    if (start + chunkSize >= t.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

// 一份附件／記事在 Vectorize 裡固定佔用 att-{id}-0 ~ att-{id}-(EMBED_MAX_CHUNKS-1)
// 這個 id 範圍（記事不分段，只用 entry-{id}）。重新 embed 前先整批刪掉這個
// 範圍再 upsert 新的，不用另外存「上次切了幾段」——刪不存在的 id 是 no-op。
function vectorIdsForAttachment(attachmentId) {
  return Array.from({ length: EMBED_MAX_CHUNKS }, (_, i) => `att-${attachmentId}-${i}`);
}

export class EmbeddingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { kind, id, entryId, textContent, title } = event.payload; // kind: "entry" | "attachment"

    const combined = kind === "entry" ? `${title || ""}\n${textContent || ""}` : (textContent || "");
    if (!combined.trim()) {
      return { success: false, reason: "empty_content" };
    }
    const chunks = kind === "entry" ? [combined.slice(0, EMBED_TEXT_CAP)] : chunkText(combined);
    if (!chunks.length) return { success: false, reason: "empty_content" };

    try {
      const vectors = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vectorId = kind === "entry" ? `entry-${id}` : `att-${id}-${i}`;
        const embedded = await step.do(`embed-${vectorId}`, async () => {
          // 一定要走 budgetedAi()：專案的 AI 費用保護（AI Gateway + spend limit）
          // 全靠這層，直接呼叫 env.AI.run() 等於整批向量化都在保護範圍外跑，
          // 量一大就會擠掉錄音轉逐字稿等其他 AI 呼叫的額度。
          const result = await budgetedAi(this.env).run("@cf/baai/bge-m3", { text: chunk });
          return result.data[0];
        });
        vectors.push({
          id: vectorId,
          values: embedded,
          metadata: {
            kind,
            entryId: String(entryId),
            attachmentId: kind === "attachment" ? String(id) : "",
            chunkIndex: i,
            timestamp: new Date().toISOString(),
          },
        });
      }

      await step.do("upsert-vectorize", async () => {
        if (kind === "attachment") {
          // 先清掉這份附件全部可能的分段 id 範圍，避免這次分段數比上次少時
          // 留下幾支指向舊內容的孤兒向量還會被搜到。
          await this.env.VECTOR_INDEX.deleteByIds(vectorIdsForAttachment(id));
        }
        await this.env.VECTOR_INDEX.upsert(vectors);
      });

      await step.do("update-db-status", async () => {
        const table = kind === "entry" ? "entries" : "attachments";
        await this.env.DB.prepare(
          `UPDATE ${table} SET embedding_status = 'done', vector_id = ?, embedding_error = '' WHERE id = ?`
        ).bind(kind === "entry" ? `entry-${id}` : `att-${id}`, id).run();
      });

      return { success: true, id, chunks: chunks.length };
    } catch (error) {
      try {
        const table = kind === "entry" ? "entries" : "attachments";
        await this.env.DB.prepare(
          `UPDATE ${table} SET embedding_status = 'failed', embedding_error = ? WHERE id = ?`
        ).bind(String(error.message || error), id).run();
      } catch { /* 連狀態都寫不進去就放棄，下次 backfill 還會再試 */ }
      return { success: false, id, error: String(error.message || error) };
    }
  }
}

// 有文字內容且 workflow binding 存在時，非同步排入向量化；排隊失敗不擋主流程
// （呼叫端一律用 await 但吞掉例外，語意搜尋是加值功能，不能因為它掛掉就讓
// 使用者存不了記事、傳不了 OCR 結果）。
async function triggerEmbedding(env, { kind, id, entryId, textContent, title }) {
  if (!env.EMBEDDING_WORKFLOW) return;
  if (!textContent || !String(textContent).trim()) return;
  try {
    await env.EMBEDDING_WORKFLOW.create({ params: { kind, id, entryId, textContent, title } });
  } catch (err) {
    console.error(`[Embedding] 排隊失敗 ${kind} ${id}:`, err.message);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message, status = 400) {
  return json({ error: message }, status);
}

async function cloudflareUsage(env) {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const token = (env.CLOUDFLARE_USAGE_API_TOKEN || "").trim();
  if (!accountId || !token) throw new Error("尚未設定 Cloudflare 用量查詢資訊");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const endpoints = [`/accounts/${accountId}/billable/usage`, `/accounts/${accountId}/paygo-usage`];
  const failures = [];
  for (const endpoint of endpoints) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      failures.push((body.errors || []).map((e) => e.message).join("；") || `HTTP ${res.status}`);
      continue;
    }
    const records = Array.isArray(body.result) ? body.result : (Array.isArray(body) ? body : []);
    const rows = records.map((r) => ({
      family: r.x_ProductFamilyName || r.ServiceFamilyName || "Cloudflare",
      name: r.x_BillableMetricName || r.ServiceName || r.ChargeDescription || "用量",
      quantity: Number(r.ConsumedQuantity ?? r.PricingQuantity ?? 0),
      unit: r.ConsumedUnit || r.PricingUnit || "",
      cost: Number(r.EffectiveCost ?? r.BilledCost ?? r.CumulatedContractedCost ?? r.ContractedCost ?? 0),
      currency: r.BillingCurrency || "USD",
      periodStart: r.ChargePeriodStart || r.BillingPeriodStart || "",
    })).filter((r) => /workers|ai|d1|r2/i.test(`${r.family} ${r.name}`));
    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.family}\u0000${row.name}\u0000${row.unit}\u0000${row.currency}`;
      const item = grouped.get(key) || { ...row, quantity: 0, cost: 0 };
      item.quantity += row.quantity;
      item.cost += row.cost;
      grouped.set(key, item);
    }
    const products = [...grouped.values()].sort((a, b) =>
      a.family.localeCompare(b.family) || a.name.localeCompare(b.name)
    );
    const today = now().slice(0, 10);
    const lagDaysFrom = (dateStr) => (dateStr ? Math.round((new Date(today) - new Date(dateStr)) / 86400000) : null);
    // 每個項目除了加總數量，也記下「這批資料最新是哪一天的」——Cloudflare 帳單 API
    // 本身有回報延遲（實測落後 1-3 天），不是這支 Worker 沒去抓最新資料。
    // 原本只有 AI 那一項算了落後天數，D1／R2／Workers 那幾項完全沒算，導致「查詢時間」
    // 跟「帳單資料實際是哪天的」被混在一起講，使用者分不出兩者。這裡全部項目統一算。
    const findUsage = (family, name) => {
      const matched = rows.filter((r) => family.test(r.family) && name.test(r.name));
      const latestDate = matched.map((r) => r.periodStart.slice(0, 10)).filter(Boolean).sort().at(-1) || "";
      return {
        quantity: matched.reduce((sum, r) => sum + r.quantity, 0),
        latestDate,
        dataLagDays: lagDaysFrom(latestDate),
      };
    };
    const aiRows = rows.filter((r) => /workers ai/i.test(r.family) && /neuron/i.test(r.name));
    const latestAiDate = aiRows.map((r) => r.periodStart.slice(0, 10)).filter(Boolean).sort().at(-1) || "";
    // AI 額度是「每日」上限，只算最新那一天的用量；其他項目是「每月」上限，加總整期
    const aiUsage = aiRows
      .filter((r) => !latestAiDate || r.periodStart.startsWith(latestAiDate))
      .reduce((sum, r) => sum + r.quantity, 0);
    const aiMonthlyPaidCost = aiRows.reduce((sum, r) => sum + r.cost, 0);
    const aiDataLagDays = lagDaysFrom(latestAiDate);
    const d1Read = findUsage(/^D1$/i, /Rows Read/i);
    const d1Write = findUsage(/^D1$/i, /Rows Written/i);
    const r2A = findUsage(/^R2$/i, /Class A/i);
    const r2B = findUsage(/^R2$/i, /Class B/i);
    const wRequests = findUsage(/^Workers$/i, /Standard Requests/i);
    const wCpu = findUsage(/^Workers$/i, /CPU ms/i);
    const wBuild = findUsage(/^Workers$/i, /Build Minutes/i);
    const limits = [
      {
        key: "ai", label: `Workers AI Neurons${latestAiDate ? `（${latestAiDate}）` : ""}`,
        used: aiUsage, limit: AI_DAILY_FREE_NEURONS, safeLimit: AI_AUTO_SAFE_NEURONS,
        monthlyPaidCost: aiMonthlyPaidCost, softBudget: AI_MONTHLY_SOFT_USD,
        hardBudget: AI_MONTHLY_HARD_USD, paidRatePerThousand: AI_RATE_PER_1000_NEURONS,
        gatewayConfigured: !!env.AI_GATEWAY_ID, unit: "／日", dataLagDays: aiDataLagDays,
      },
      { key: "d1-read", label: "D1 讀取列數", used: d1Read.quantity, limit: 25e9, unit: "／月", dataLagDays: d1Read.dataLagDays },
      { key: "d1-write", label: "D1 寫入列數", used: d1Write.quantity, limit: 50e6, unit: "／月", dataLagDays: d1Write.dataLagDays },
      { key: "r2-a", label: "R2 Class A 操作", used: r2A.quantity, limit: 1e6, unit: "／月", dataLagDays: r2A.dataLagDays },
      { key: "r2-b", label: "R2 Class B 操作", used: r2B.quantity, limit: 10e6, unit: "／月", dataLagDays: r2B.dataLagDays },
      { key: "worker-requests", label: "Workers 請求", used: wRequests.quantity, limit: 10e6, unit: "／月", dataLagDays: wRequests.dataLagDays },
      { key: "worker-cpu", label: "Workers CPU", used: wCpu.quantity, limit: 30e6, unit: "ms／月", dataLagDays: wCpu.dataLagDays },
      { key: "worker-build", label: "Worker 建置", used: wBuild.quantity, limit: 6000, unit: "分鐘／月", dataLagDays: wBuild.dataLagDays },
    ].filter((item) => item.key === "ai" || item.used > 0);
    const totalCost = products.reduce((sum, p) => sum + p.cost, 0);
    // 整批帳單資料裡最新的一天，不限任何一個項目——這是「查這次帳單，最新查得到
    // 哪一天的資料」的單一總覽數字，跟下面「查詢時間」（Worker 剛剛去問的時間點）
    // 是兩件不同的事，前端要分開講，不要合成一行讓人誤會成同一件事。
    const allDates = rows.map((r) => r.periodStart.slice(0, 10)).filter(Boolean).sort();
    const billingDataDate = allDates.at(-1) || "";
    return {
      source: endpoint.includes("billable") ? "billable" : "paygo",
      products,
      limits,
      totalCost,
      currency: products[0]?.currency || "USD",
      updatedAt: new Date().toISOString(),
      billingDataDate,
      billingDataLagDays: lagDaysFrom(billingDataDate),
    };
  }
  throw new Error(`Cloudflare 用量 API 無法讀取：${failures.join("；")}`);
}

// 帳單 API 不是即時資料，所以這是提前於 Gateway 硬上限的第二道（軟）保護。
// 查不到帳單時採 fail-closed：寧可暫停 AI，也不要在無法判斷費用時繼續扣款。
async function enforceAiSoftBudget(env) {
  const usage = await cloudflareUsage(env);
  const ai = usage.limits?.find((item) => item.key === "ai");
  if (Number(ai?.monthlyPaidCost || 0) >= AI_MONTHLY_SOFT_USD) {
    const err = new Error(`本月 Workers AI 付費已達 USD ${AI_MONTHLY_SOFT_USD} 軟上限，已停止新的 AI 處理`);
    err.code = "AI_BUDGET_REACHED";
    throw err;
  }
  return usage;
}

// 設定 AI_GATEWAY_ID 後，所有 env.AI.run() 都走同一 Gateway，讓 Dashboard 的
// USD 5 spend limit 成為最後防線。尚未設定時維持原呼叫，避免現有功能突然失效。
function budgetedAi(env) {
  if (!env.AI_GATEWAY_ID) return env.AI;
  return {
    run(model, input, options = {}) {
      return env.AI.run(model, input, {
        ...options,
        gateway: { ...(options.gateway || {}), id: env.AI_GATEWAY_ID },
      });
    },
  };
}

// Cloudflare 回的原始錯誤常是英文技術代碼，使用者看了不知道要做什麼、也
// 容易誤以為是額度問題。目前唯一遇過、而且會讓「所有」AI 呼叫都失敗（不是
// 只有某一段、也跟額度無關）的已知案例：AI_GATEWAY_ID 指到一個 Cloudflare
// Dashboard 裡其實不存在的 Gateway（2026-07-27 使用者截圖：「2001: Please
// configure AI Gateway in the Cloudflare dashboard」）。遇到就直接把修法
// 講清楚，不要留一句英文代碼讓人不知所措。
function friendlyAiError(err) {
  const msg = err?.message || String(err);
  if (/2001/.test(msg) && /AI Gateway/i.test(msg)) {
    return `AI Gateway 設定有誤：Worker 的 AI_GATEWAY_ID 指到一個 Cloudflare Dashboard 裡不存在的 Gateway，導致「所有」AI 呼叫都會失敗，這不是額度用完。修法二選一：(1) 到 Cloudflare Dashboard → AI → AI Gateway 建立同名 Gateway（見 fieldlog/README.md「AI 費用雙層保護」）；(2) 先移除 Worker 的 AI_GATEWAY_ID 變數讓功能立刻恢復，之後再補設定。原始錯誤：${msg}`;
  }
  return msg;
}

// bytes → base64。一定要分段餵給 String.fromCharCode：一次把整個陣列展開成參數，
// 100KB 上下就會 Maximum call stack size exceeded（照片幾乎都超過這個大小）。
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// 帶時效的檔案簽名。origin 要帶進來組完整網址——呼叫端（MCP server）拿到是直接
// 當連結用的，只給相對路徑會是死連結。key 逐段編碼，中文檔名才不會壞。
// 注意：這不是「免驗證的對外分享連結」——/api/* 的 FIELD_PIN 閘門在簽名檢查
// 之前，沒有 PIN 的人拿到簽名網址一樣是 401。簽名的作用是把持有 PIN 的呼叫端
// 再限縮到「這一個 key、這 10 分鐘」。
async function createSignedFileUrl(fileKey, fieldPin, origin = "", expiryMinutes = 10) {
  const expiry = Math.floor(Date.now() / 1000) + expiryMinutes * 60;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(fieldPin || "default-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${fileKey}:${expiry}`));
  const sig = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const path = `/api/file/${fileKey.split("/").map(encodeURIComponent).join("/")}?expires=${expiry}&sig=${sig}`;
  return { url: `${origin}${path}`, expires_at: new Date(expiry * 1000).toISOString() };
}

async function verifyFileSignature(fileKey, fieldPin, expires, sig) {
  const expiry = Number(expires);
  if (!Number.isFinite(expiry)) return "簽名無效";
  if (expiry * 1000 < Date.now()) return "簽名已過期";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(fieldPin || "default-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${fileKey}:${expiry}`));
  const expected = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === expected ? null : "簽名無效";
}

// Whisper 拿到靜音或極低音量時，不會老實回空字串，而是反覆吐出訓練資料裡的
// 常見結尾語（英文最常見的是 "Thank you."／"Thank you for watching."，中文是
// 「字幕由…提供」這類）。2026-08-16 使用者實測：麥克風喚醒失敗、實際錄到靜音時，
// 即時逐字稿整段都是 "Thank you. Thank you. Thank you…"。
//
// 這種內容若照單全收，會同時污染三個地方：永久存成逐字稿、被拿去自動命名附件、
// 還餵進語意搜尋的向量庫。判斷主要靠「重複」這個結構特徵而不是單純比對字串：
// 真人講話不會整段只有一兩種句子重複十幾次；已知句型只當輔助訊號。
const SILENCE_HALLUCINATION_PHRASES = [
  "thank you", "thank you.", "thanks for watching", "thank you for watching",
  "please subscribe", "you", "字幕由amara.org社群提供", "字幕志愿者", "谢谢观看", "謝謝觀看",
];

function looksLikeSilenceHallucination(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  const norm = (s) => s.toLowerCase().replace(/[\s。．.,，!！?？~-]+/g, " ").trim();
  // 整段就是一句已知的靜音幻覺句
  if (SILENCE_HALLUCINATION_PHRASES.includes(norm(trimmed))) return true;
  const parts = trimmed.split(/(?<=[.。!！?？])\s*/).map(norm).filter(Boolean);
  if (parts.length < 5) return false;
  const unique = new Set(parts);
  // 五句以上卻只有一兩種內容不斷重複＝不是人在講話
  if (unique.size > 2) return false;
  return [...unique].every((p) => SILENCE_HALLUCINATION_PHRASES.includes(p) || p.split(" ").length <= 4);
}

async function transcribeAttachment(env, db, old) {
  const obj = await env.FILES.get(old.key);
  if (!obj) throw new Error("找不到檔案內容");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const result = await budgetedAi(env).run("@cf/openai/whisper-large-v3-turbo", { audio: bytesToBase64(bytes), task: "transcribe" });
  const raw = (result?.text || "").trim();
  const hallucinated = looksLikeSilenceHallucination(raw);
  // 判定成幻覺就存成空的：留著只會讓之後的搜尋、命名、向量庫都以為這段有內容。
  const text = hallucinated ? "" : raw;
  await db.prepare("UPDATE attachments SET transcript = ?, transcribed_at = ? WHERE id = ?").bind(text, now(), old.id).run();
  await autoRenameAttachment(db, old, text);
  await logHistory(db, old.entry_id, null, "錄音轉文字",
    hallucinated
      // 講清楚是麥克風沒收到聲音，不要只寫「無語音內容」讓人以為是自己沒講話
      ? `${old.filename}：這段沒有收到聲音（辨識結果為靜音時的重複雜訊，已捨棄），請確認麥克風是否被其他程式佔用或靜音`
      : `${old.filename}：${text.slice(0, 60) || "（無語音內容）"}`);
  await triggerEmbedding(env, { kind: "attachment", id: old.id, entryId: old.entry_id, textContent: text });
  return text;
}

async function logHistory(db, entryId, folderId, action, detail) {
  await db
    .prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(entryId, folderId, action, (detail || "").slice(0, 200), now())
    .run();
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function cleanFilenamePart(value, max = 42) {
  return String(value || "").replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[\\/:*?"<>|#]+/g, " ").replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, max);
}

function isGenericFilename(name) {
  const stem = String(name || "").replace(/\.[^.]+$/, "");
  return /^(img|dsc|pxl|scan|document|download|file|audio|recording|video|image|未命名|螢幕擷取|已貼上)[-_ (]?\d*/i.test(stem)
    || /^(附件|照片|錄音|影片)[-_ ]?\d*$/i.test(stem);
}

// 只用可驗證的編號與既有記事脈絡命名，不讓 AI 自由猜測。
async function autoRenameAttachment(db, att, extractedText) {
  if (!att?.id || att.source_pdf_id) return false;
  const original = att.original_filename || att.filename || "file";
  const ext = original.match(/(\.[a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || "";
  const text = `${original}\n${String(extractedText || "").slice(0, 12000)}`;
  let next = "";
  const standard = text.match(/\b(ISO(?:\s*\/\s*(?:TS|TR))?|IEC|ASTM|EN\s+ISO|JIS)\s*[-:]?\s*([A-Z]?\d{3,6}(?:-\d{1,3})?)(?:\s*[:\-]?\s*((?:19|20)\d{2}))?/i);
  if (standard) {
    const org = standard[1].toUpperCase().replace(/\s*\/\s*/g, "_").replace(/\s+/g, "_");
    next = [org, standard[2].toUpperCase(), standard[3] || ""].filter(Boolean).join("_") + ext;
  } else {
    // 部分 ISO PDF 的原始檔名只有正式英文標題，完全沒有標準編號。
    // 只處理能由標題唯一對應的系列；年份無法確認時不自行猜測。
    const syringePart = text.match(/\bSterile\s+hypodermic\s+syringes\s+for\s+single\s+use\s+Part\s+([1-4])\b/i);
    if (syringePart) {
      const currentYear = { "1": "2017", "2": "2020", "3": "2020", "4": "2018" }[syringePart[1]];
      next = `ISO_7886-${syringePart[1]}_${currentYear}${ext}`;
    }
  }
  if (!next) {
    const patent = text.match(/\b(US|EP|WO|CN|JP|TW)\s*[-/]?\s*(\d{6,14})(?:\s*([A-Z]\d?))?\b/i);
    if (patent) {
      next = `${patent[1].toUpperCase()}_${patent[2]}${patent[3] ? `_${patent[3].toUpperCase()}` : ""}${ext}`;
    } else if (isGenericFilename(original)) {
      const context = await db.prepare(
        `SELECT e.title, e.created_at, f.type AS folder_type, f.name AS folder_name
         FROM entries e LEFT JOIN folders f ON f.id = e.folder_id WHERE e.id = ?`
      ).bind(att.entry_id).first();
      const date = String(context?.created_at || att.created_at || now()).slice(0, 10);
      const type = cleanFilenamePart(context?.folder_type || (att.kind === "audio" ? "錄音" : att.kind === "photo" ? "照片" : "文件"), 12);
      const topic = cleanFilenamePart(context?.title || context?.folder_name || "", 32);
      next = [date, type, topic, att.id].filter(Boolean).join("_") + ext;
    }
  }
  if (!next || next === att.filename) return false;
  await db.prepare(
    "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
  ).bind(next, att.id).run();
  await logHistory(db, att.entry_id, null, "自動重新命名", `${original} → ${next}`);
  return true;
}

async function activeAttachment(db, id) {
  return db.prepare(
    `SELECT a.* FROM attachments a JOIN entries e ON e.id = a.entry_id LEFT JOIN folders f ON f.id = e.folder_id
     WHERE a.id = ? AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')`
  ).bind(id).first();
}

// 貼上的 Notion 頁面網址 → 32 碼 page ID（補回標準 UUID 格式的連字號）
function parseNotionPageId(input) {
  const raw = (input || "").trim();
  if (!raw) return "";
  const hex = raw.replace(/[^a-f0-9]/gi, "");
  const id32 = hex.slice(-32);
  if (id32.length !== 32) return "";
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}

async function handleApi(request, env, url) {
  const db = env.DB;
  await ensureSchema(db, now());
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (path === "/config" && method === "GET") {
    // ui_version：伺服器上「應該」是哪一版前端。前端拿它跟自己的 APP_VERSION 比，
    // 不一致就代表瀏覽器跑的是快取住的舊 app.js，畫面會直接提示並提供一鍵清除。
    return json({ uploads: !!env.FILES, transcribe: !!(env.FILES && env.AI), ui_version: UI_VERSION });
  }
  if (path === "/usage" && method === "GET") {
    return json(await cloudflareUsage(env));
  }

  // ---- 垃圾桶：一般刪除只進這裡，手動永久刪除與 60 天排程共用同一套清理 ----
  if (path === "/trash" && method === "GET") {
    return json({ retention_days: 60, items: await listTrash(db) });
  }
  const trashRestoreMatch = path.match(/^\/trash\/(\d+)\/restore$/);
  if (trashRestoreMatch && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const result = await restoreTrashItem(db, Number(trashRestoreMatch[1]), body, now());
    if (!result) return bad("找不到垃圾桶項目，或正在永久刪除", 404);
    if (result.conflict) return json({ error: result.reason, target_required: true }, 409);
    await logHistory(db, null, null, "從垃圾桶還原", result.item.title || `${result.item.item_type} ${result.item.item_id}`);
    return json({ ok: true, ...result });
  }
  const trashItemMatch = path.match(/^\/trash\/(\d+)$/);
  if (trashItemMatch && method === "DELETE") {
    const result = await permanentlyDeleteTrashItem(db, env.FILES, Number(trashItemMatch[1]), env.VECTOR_INDEX);
    if (!result) return bad("找不到垃圾桶項目，或正在永久刪除", 404);
    return json({ ok: true, ...result });
  }
  if (path === "/trash" && method === "DELETE") {
    const items = await listTrash(db);
    const results = [];
    for (const item of items) results.push(await permanentlyDeleteTrashItem(db, env.FILES, Number(item.id), env.VECTOR_INDEX));
    return json({ ok: true, deleted: results.filter(Boolean).length });
  }

  // ---- 暫存區 ----
  // 「來不及分類就先丟這裡」要有一個真的、看得見的資料夾（不是空了就消失的
  // 收件匣面板）。純手動：使用者自己找時間搬去該去的資料夾，不再有
  // AI／天數排程自動歸類（2026-08-09 移除，見該功能被拿掉的說明）。
  if (path === "/staging" && (method === "GET" || method === "POST")) {
    const folder = await ensureStagingFolder(db, now());
    return json({ ok: true, id: Number(folder.id), name: folder.name });
  }
  // 使用者確認「分類正確」或自己改過位置之後，把 🤖 標記清掉
  // （舊資料可能還留著歷史上 AI 自動歸類時打的標記，這個入口保留給它們用）
  const confirmFiledMatch = path.match(/^\/entries\/(\d+)\/confirm-filing$/);
  if (confirmFiledMatch && method === "POST") {
    const id = Number(confirmFiledMatch[1]);
    const entry = await db.prepare("SELECT id, title FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!entry) return bad("找不到紀錄", 404);
    await db.prepare("UPDATE entries SET auto_filed_at = '', auto_filed_reason = '' WHERE id = ?").bind(id).run();
    await logHistory(db, id, null, "確認分類", `${entry.title || "（未命名）"}：使用者確認分類正確`);
    return json({ ok: true });
  }

  // ---- folders ----
  if (path === "/folders" && method === "GET") {
    const { results } = await db.prepare(
      `SELECT f.*,
        (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id AND e.parent_entry_id IS NULL AND COALESCE(e.deleted_at, '') = '') AS entry_count,
        (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id AND COALESCE(c.deleted_at, '') = '') AS child_count
       FROM folders f WHERE COALESCE(f.deleted_at, '') = ''
       ORDER BY ${FOLDER_CATEGORY_RANK_SQL}, f.status = '進行中' DESC, f.sort_order, f.id DESC`
    ).all();
    return json(results);
  }
  if (path === "/folders" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    if (!name) return bad("name 為必填");
    const type = (body.type || "其他").trim() || "其他";
    const parentId = body.parent_id ? Number(body.parent_id) : null;
    // 四層知識架構：第 1 層產品／專案 → 2 文件類型 → 3 主題／試驗／標準系列 → 4 年份／版本。
    // 再深下去分類就失去意義（也會讓匯出與麵包屑難讀），所以擋在第 4 層。
    let depth = 1;
    if (parentId) {
      const parent = await db.prepare("SELECT id FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(parentId).first();
      if (!parent) return bad("找不到上層資料夾", 404);
      const parentDepth = await folderDepth(db, parentId);
      if (!parentDepth) return bad("找不到上層資料夾", 404);
      if (parentDepth >= MAX_FOLDER_DEPTH) {
        return bad(`資料夾最多 ${MAX_FOLDER_DEPTH} 層，不能再新增子資料夾`);
      }
      depth = parentDepth + 1;
    }
    const r = await db.prepare("INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(name.slice(0, 80), type.slice(0, 60), parentId, now()).run();
    await logHistory(db, null, r.meta.last_row_id, "建立資料夾", `${name}（${type}，第 ${depth} 層）`);
    return json({ id: r.meta.last_row_id, ok: true, depth, max_depth: MAX_FOLDER_DEPTH });
  }

  // ---- 分類字典（資料夾層級分類＋醫材分類，使用者自己增刪改）----
  if (path === "/categories" && method === "GET") {
    return json({
      categories: await listCategories(db, {
        kind: url.searchParams.get("kind") || undefined,
        level: url.searchParams.get("level") ?? undefined,
      }),
      max_folder_depth: MAX_FOLDER_DEPTH,
    });
  }
  if (path === "/categories" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const result = await createCategory(db, body, { logHistory, timestamp: now });
    return json(result, result.status || 200);
  }
  const categoryMatch = path.match(/^\/categories\/(\d+)$/);
  if (categoryMatch && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const result = await updateCategory(db, Number(categoryMatch[1]), body, { logHistory });
    return json(result, result.status || 200);
  }
  if (categoryMatch && method === "DELETE") {
    const result = await deleteCategory(db, Number(categoryMatch[1]), { logHistory });
    return json(result, result.status || 200);
  }
  const folderMatch = path.match(/^\/folders\/(\d+)$/);
  if (folderMatch && method === "PUT") {
    const id = Number(folderMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!old) return bad("找不到資料夾", 404);
    const name = body.name !== undefined ? (body.name || "").trim() : old.name;
    const status = body.status !== undefined ? (body.status || "").trim() : old.status;
    // type 也可以改：建立時分類選錯很常見（例如誤選、或舊資料/匯入時類型跟預期不一樣），
    // 之前只能改 name/status，改 type 沒地方修，只能刪掉重建
    const type = body.type !== undefined ? (body.type || "").trim() : old.type;
    if (!name) return bad("name 不可為空");
    if (!type) return bad("type 不可為空");
    // category＝色系分組，跟上面的 type（活動性質）是兩個不同的軸，見
    // lib/schema.js MIGRATIONS 裡 FOLDER_CATEGORIES 上方的說明。空字串代表
    // 清除分類（回到未分類，排序時當 misc 處理）。
    let category = old.category;
    if (body.category !== undefined) {
      const wantCategory = String(body.category || "").trim();
      if (wantCategory && !FOLDER_CATEGORIES.includes(wantCategory)) {
        return bad(`category 只能是 ${FOLDER_CATEGORIES.join("／")} 其中之一，或留空清除分類`);
      }
      category = wantCategory || null;
    }
    const sortOrder = body.sort_order !== undefined
      ? (body.sort_order === null || body.sort_order === "" ? null : Number(body.sort_order))
      : old.sort_order;
    // parent_id 也能改＝資料夾本身可以搬到別的分支（或搬回最上層）。
    // 沒有這個，四層架構一旦建錯就只能刪掉重來，裡面的記事與附件跟著陪葬。
    if (body.parent_id !== undefined) {
      const nextParent = body.parent_id ? Number(body.parent_id) : null;
      if (nextParent === id) return bad("不能把資料夾搬到自己底下");
      if (nextParent) {
        const parent = await db.prepare("SELECT id FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(nextParent).first();
        if (!parent) return bad("找不到目標上層資料夾", 404);
        if (await isDescendantOf(db, nextParent, id)) return bad("不能把資料夾搬到自己的子資料夾底下");
        const [parentDepth, height] = await Promise.all([folderDepth(db, nextParent), subtreeHeight(db, id)]);
        if (parentDepth + height > MAX_FOLDER_DEPTH) {
          return bad(`搬過去會變成第 ${parentDepth + height} 層，超過 ${MAX_FOLDER_DEPTH} 層上限（這個資料夾底下還有 ${height - 1} 層）`);
        }
      }
      await db.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(nextParent, id).run();
      await logHistory(db, null, id, "移動資料夾", `${name} → ${nextParent ? `folder ${nextParent}` : "最上層"}`);
    }
    await db.prepare("UPDATE folders SET name = ?, status = ?, type = ?, category = ?, sort_order = ? WHERE id = ?")
      .bind(name, status, type, category, sortOrder, id).run();
    await logHistory(db, null, id, "更新資料夾", `${name}／${status}／${type}${category !== old.category ? `／分類：${category || "（未分類）"}` : ""}`);
    return json({ ok: true });
  }
  if (folderMatch && method === "DELETE") {
    const id = Number(folderMatch[1]);
    const folder = await db.prepare("SELECT * FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!folder) return bad("找不到資料夾", 404);
    const result = await moveFolderTreeToTrash(db, folder, now());
    await logHistory(db, null, folder.id, "移到垃圾桶", `${folder.name}；${result.folder_count} 個資料夾、${result.entry_count} 筆紀錄`);
    return json({ ok: true, trashed: true, ...result });
  }
  const mergeFolderMatch = path.match(/^\/folders\/(\d+)\/merge$/);
  if (mergeFolderMatch && method === "POST") {
    const sourceId = Number(mergeFolderMatch[1]);
    const body = await request.json().catch(() => ({}));
    const targetId = Number(body.target_id || 0);
    if (!targetId || targetId === sourceId) return bad("合併目標不正確");
    const [source, target] = await Promise.all([
      db.prepare("SELECT * FROM folders WHERE id = ?").bind(sourceId).first(),
      db.prepare("SELECT * FROM folders WHERE id = ?").bind(targetId).first(),
    ]);
    if (!source || !target) return bad("找不到來源或目標資料夾", 404);
    if (await isDescendantOf(db, targetId, sourceId)) return bad("不能合併到自己的子資料夾");
    const countRow = await db.prepare("SELECT COUNT(*) AS count FROM entries WHERE folder_id = ?").bind(sourceId).first();
    const moved = Number(countRow?.count || 0);
    const childRow = await db.prepare("SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?").bind(sourceId).first();
    const childCount = Number(childRow?.count || 0);
    // 子資料夾要跟著進目標資料夾，不能丟回來源的上層。
    // 舊行為（丟上層）會把「記事在 A/B 底下」拆成「記事進了目標、B 卻跑到別的
    // 分支」——同一批資料被劈成兩半，而且畫面上完全看不出發生過這件事。
    if (childCount) {
      const [targetDepth, height] = await Promise.all([folderDepth(db, targetId), subtreeHeight(db, sourceId)]);
      // height 含來源自己那一層，來源會被刪掉，所以子樹實際只往下長 height - 1
      if (targetDepth + height - 1 > MAX_FOLDER_DEPTH) {
        return bad(`合併後子資料夾會落到第 ${targetDepth + height - 1} 層，超過 ${MAX_FOLDER_DEPTH} 層上限。請先把「${source.name}」底下的子資料夾搬走再合併。`);
      }
    }
    await db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?").bind(targetId, now(), sourceId).run();
    await db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").bind(targetId, sourceId).run();
    await db.prepare("DELETE FROM folders WHERE id = ?").bind(sourceId).run();
    await logHistory(db, null, targetId, "合併資料夾", `${source.name} → ${target.name}；移動 ${moved} 筆記事、${childCount} 個子資料夾`);
    return json({ ok: true, moved, moved_children: childCount, target_id: targetId });
  }

  // ---- entries ----
  // 首頁的全文搜尋（依「MyWiki 首頁改版規格」§1.1）：傳統關鍵字比對，不是
  // 語意搜尋——多詞空白分隔＝AND，查無自動降級成 OR 並標示，簡繁互通，套用
  // 使用者自己在 D1 補的同義詞表。比對邏輯跟 medapi-mcp 的 search_fieldlog
  // 共用同一份（見上方 import 處的說明），不重寫第二套規則以免兩邊之後跑歪。
  //
  // 跟下面 /entries/search（給「新增關聯」選取器用的簡單 LIKE）是兩個不同
  // 端點：那支只比對標題／內文，這支還涵蓋欄位、附件檔名、逐字稿、OCR／PDF
  // 擷取文字，且經過同義詞展開與簡繁摺疊——語意不同，不能合併成一支。
  if (path === "/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ query: "", entries: [], attachments: [], degraded: false, truncated: false });
    await ensureSearchSynonyms(db, now);
    const plan = buildPlan(q);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20) || 20, 50);

    const [{ results: allEntries }, { results: allAtts }] = await Promise.all([
      db.prepare(
        `SELECT e.id, e.folder_id, e.title, e.body, e.body_format, e.fields_json, e.created_at, e.updated_at,
                COALESCE(e.auto_filed_at, '') AS auto_filed_at, COALESCE(e.auto_filed_reason, '') AS auto_filed_reason,
                f.name AS folder_name, f.type AS folder_type, COALESCE(f.role, '') AS folder_role,
                (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
         WHERE COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')
         ORDER BY e.id DESC LIMIT ${SEARCH_SCAN_CAP}`
      ).all(),
      db.prepare(
        `SELECT a.id AS att_id, a.entry_id, a.kind, a.filename, a.transcript, COALESCE(a.ocr_text, '') AS ocr_text, a.offset_secs,
                e.title AS entry_title, e.folder_id, f.name AS folder_name, f.type AS folder_type
         FROM attachments a JOIN entries e ON a.entry_id = e.id LEFT JOIN folders f ON f.id = e.folder_id
         WHERE COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')
         ORDER BY a.id DESC LIMIT ${SEARCH_SCAN_CAP}`
      ).all(),
    ]);
    for (const e of allEntries) e._body = e.body_format === "html" ? htmlToPlainText(e.body) : (e.body || "");
    for (const a of allAtts) a._ocr = stripPdfMetadata(a.ocr_text || "");

    const entryHits = runSearch(allEntries, plan, (e) => `${e.title}\n${e._body}\n${e.fields_json}\n${e.folder_name || ""}\n${e.folder_type || ""}`, limit);
    const attHits = runSearch(allAtts, plan, (a) => `${a.transcript}\n${a._ocr}\n${a.filename}\n${a.folder_name || ""}\n${a.folder_type || ""}`, limit);

    const entries = entryHits.hits.map(({ row: e }) => ({
      id: e.id, folder_id: e.folder_id, title: e.title, created_at: e.created_at, updated_at: e.updated_at,
      auto_filed_at: e.auto_filed_at, auto_filed_reason: e.auto_filed_reason,
      folder_name: e.folder_name, folder_type: e.folder_type, folder_role: e.folder_role, att_count: e.att_count,
      snippet: planSnippet(pickHitField([e.title, e._body, e.fields_json], plan) || e._body, plan),
    }));
    const attachments = attHits.hits.map(({ row: a }) => ({
      att_id: a.att_id, entry_id: a.entry_id, kind: a.kind, filename: a.filename, offset_secs: a.offset_secs,
      entry_title: a.entry_title, folder_id: a.folder_id, folder_name: a.folder_name, folder_type: a.folder_type,
      snippet: planSnippet(pickHitField([a.transcript, a._ocr, a.filename], plan) || a.filename, plan),
    }));
    return json({
      query: q,
      entries,
      attachments,
      degraded: isDegraded(entryHits, attHits),
      // 掃描到上限＝可能還有更舊的資料沒進比對，不能讓「沒搜到」被誤讀成
      // 「資料庫裡沒有」——跟 mcp 的 search_fieldlog 同一個誠實回報原則。
      truncated: allEntries.length >= SEARCH_SCAN_CAP || allAtts.length >= SEARCH_SCAN_CAP,
    });
  }
  // 語意搜尋：跟上面 /search（傳統關鍵字）是分開的端點，補「講得出概念但講不出
  // 關鍵字」這種情境——例如「跟滅菌相關的品質問題」不會直接命中「滅菌」兩個字
  // 剛好都出現的記事。查詢文字先轉向量，去 Vectorize 找最相似的內容，再回 D1
  // 撈實際資料。VECTOR_MIN_SCORE 是先抓的起始門檻，之後如果覆蓋率夠了還是常
  // 漏掉相關結果，再回頭調。
  const VECTOR_MIN_SCORE = 0.55;
  if (path === "/search/semantic" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return bad("查詢詞不可為空");
    if (!env.AI) return bad("AI 未配置", 501);
    if (!env.VECTOR_INDEX) return bad("Vectorize 未配置", 501);
    const topK = Math.min(30, Math.max(1, Number(url.searchParams.get("topK") || "10") || 10));
    const folderId = url.searchParams.get("folder_id") ? Number(url.searchParams.get("folder_id")) : null;

    let queryVector;
    try {
      const embedded = await budgetedAi(env).run("@cf/baai/bge-m3", { text: q.slice(0, 2000) });
      queryVector = embedded.data[0];
    } catch (err) {
      return bad(`查詢向量化失敗：${err.message}`, 502);
    }
    // 多要一些候選（同一份附件的多段命中要去重），實際回傳數量還是看 topK
    const matches = await env.VECTOR_INDEX.query(queryVector, { topK: topK * 3, returnMetadata: true });

    const entryResults = [];
    const attBestByEntryId = new Map(); // attachmentId -> 目前分數最高的一筆
    for (const m of matches.matches || []) {
      if (m.score < VECTOR_MIN_SCORE) continue;
      const meta = m.metadata || {};
      if (meta.kind === "entry") {
        const entry = await db.prepare(
          `SELECT e.*, f.name AS folder_name, f.type AS folder_type FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
           WHERE e.id = ? AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')`
        ).bind(Number(meta.entryId)).first();
        if (entry && (!folderId || entry.folder_id === folderId)) entryResults.push({ score: m.score, entry });
      } else if (meta.kind === "attachment") {
        const attId = Number(meta.attachmentId);
        const prev = attBestByEntryId.get(attId);
        if (prev && prev.score >= m.score) continue;
        const att = await db.prepare(
          `SELECT a.*, e.title AS entry_title, e.folder_id, f.name AS folder_name, f.type AS folder_type
           FROM attachments a JOIN entries e ON e.id = a.entry_id LEFT JOIN folders f ON f.id = e.folder_id
           WHERE a.id = ? AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')`
        ).bind(attId).first();
        if (att && (!folderId || att.folder_id === folderId)) attBestByEntryId.set(attId, { score: m.score, attachment: att });
      }
    }
    entryResults.sort((a, b) => b.score - a.score);
    const attachmentResults = [...attBestByEntryId.values()].sort((a, b) => b.score - a.score);

    return json({
      query: q,
      entries: entryResults.slice(0, topK),
      attachments: attachmentResults.slice(0, topK),
    });
  }
  // 跨資料夾找記事（給「新增關聯」的選取器用：關聯常常是跨資料夾的，
  // 例如把一筆實驗記事關聯到另一棵資料夾樹下的廠商記事）
  if (path === "/entries/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const excludeId = Number(url.searchParams.get("exclude_id") || 0);
    if (!q) return json([]);
    const like = `%${q}%`;
    const { results } = await db.prepare(
      `SELECT e.id, e.title, e.folder_id, f.name AS folder_name, f.type AS folder_type, e.created_at
       FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
       WHERE (e.title LIKE ? OR e.body LIKE ?) AND e.id != ?
         AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')
       ORDER BY e.id DESC LIMIT 20`
    ).bind(like, like, excludeId).all();
    return json(results);
  }
  // 首頁的「待處理」：只列還沒真正歸檔的東西——收件匣（folder_id 空）、
  // 暫存區（role='staging'），以及 AI 剛自動歸類、使用者還沒確認過的（
  // auto_filed_at 有值且不是 'failed'；'failed' 代表 AI 判斷不出來，那筆
  // 還留在暫存區，已經被上面那條件涵蓋，不用重複判斷）。
  //
  // 2026-08-07 曾經改成「不分資料夾、列最後動過的 25 筆」（不管有沒有歸檔），
  // 想解決「收件匣空了整個面板就消失」的問題；但這樣一來，只要使用者剛剛
  // 手動搬移／編輯過某筆已經歸檔好的記事，它就會佔著清單最上面的位置，
  // 早就處理完的東西反而擠掉真正還沒處理的（2026-08-09 實際回報）。改回
  // 只列「還需要你看一眼」的東西，AI 自動歸類但還沒確認的一樣列進來——
  // 那正是設計 🤖 標記／confirm-filing 的目的，不能讓這批東西完全沒有
  // 入口，只能靠使用者剛好逛進那個資料夾才會發現。
  if (path === "/entries/recent" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 25) || 25, 100);
    const { results } = await db.prepare(
      `SELECT e.id, e.folder_id, e.title, e.created_at, e.updated_at,
              COALESCE(e.auto_filed_at, '') AS auto_filed_at,
              COALESCE(e.auto_filed_reason, '') AS auto_filed_reason,
              f.name AS folder_name, f.type AS folder_type, COALESCE(f.role, '') AS folder_role,
              (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
       FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
       WHERE COALESCE(e.deleted_at, '') = '' AND e.parent_entry_id IS NULL
         AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')
         AND (e.folder_id IS NULL
          OR f.role = 'staging'
          OR (COALESCE(e.auto_filed_at, '') <> '' AND e.auto_filed_at <> 'failed'))
       ORDER BY COALESCE(NULLIF(e.updated_at, ''), e.created_at) DESC, e.id DESC
       LIMIT ?`
    ).bind(limit).all();
    return json(results);
  }
  if (path === "/entries" && method === "GET") {
    const folderId = url.searchParams.get("folder_id");
    const inbox = url.searchParams.get("inbox");
    let q;
    if (inbox) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id IS NULL AND e.parent_entry_id IS NULL
           AND COALESCE(e.deleted_at, '') = '' ORDER BY e.id DESC`
      );
    } else if (folderId) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id = ? AND e.parent_entry_id IS NULL
           AND COALESCE(e.deleted_at, '') = '' ORDER BY e.id DESC`
      ).bind(Number(folderId));
    } else {
      return bad("需指定 folder_id 或 inbox=1");
    }
    const { results } = await q.all();
    // include=attachments：資料夾內頁本來是先拿這份摘要，再對每一筆有附件的
    // 記事各發一支 /entries/:id（N+1，資料夾裡記事越多、附件越多就越慢）。
    // 這裡一次用 IN 查完全部附件塞回去，資料夾內頁改成一支 API 打完收工。
    if (url.searchParams.get("include") === "attachments" && results.length) {
      const ids = results.map((e) => e.id);
      const { results: atts } = await db.prepare(
        `SELECT * FROM attachments WHERE entry_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`
      ).bind(...ids).all();
      const byEntry = new Map();
      for (const a of atts || []) {
        if (!byEntry.has(a.entry_id)) byEntry.set(a.entry_id, []);
        byEntry.get(a.entry_id).push(a);
      }
      return json(results.map((e) => ({ ...e, attachments: byEntry.get(e.id) || [] })));
    }
    return json(results);
  }
  if (path === "/entries" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    let folderId = body.folder_id ? Number(body.folder_id) : null;
    const parentEntryId = body.parent_entry_id ? Number(body.parent_entry_id) : null;
    if (parentEntryId) {
      const parent = await db.prepare("SELECT id, folder_id FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''")
        .bind(parentEntryId).first();
      if (!parent) return bad("找不到外層紀錄", 404);
      folderId = parent.folder_id;
    }
    if (folderId) {
      const folder = await db.prepare("SELECT id FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(folderId).first();
      if (!folder) return bad("找不到資料夾", 404);
    }
    // 新記事一律是富文字，不再有「先建成純文字、之後手動升級」這一段。呼叫端
    // （前端各個採集入口）送來的 body 是純文字，這裡轉成 HTML 段落再存；要直接
    // 送 HTML 就明確帶 body_format: "html"。
    // 來源同步建立的記事不走這條路——sync.js 自己 INSERT、不帶 body_format，
    // 維持欄位預設的 'text'，它的 <!-- sync:start/end --> 標記才不會被清掉。
    const rawBody = (body.body || "").trim();
    const asText = String(body.body_format || "html") === "text";
    const storedBody = asText
      ? rawBody
      : sanitizeEntryHtml(body.body_format === "html" ? rawBody : textToHtml(rawBody));
    const title = (body.title || "").trim();
    const r = await db.prepare(
      "INSERT INTO entries (folder_id, parent_entry_id, title, fields_json, body, body_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(folderId, parentEntryId, title, JSON.stringify(body.fields || {}), storedBody, asText ? "text" : "html", now()).run();
    await logHistory(db, r.meta.last_row_id, folderId, "新增紀錄", body.title || "");
    await triggerEmbedding(env, {
      kind: "entry", id: r.meta.last_row_id, entryId: r.meta.last_row_id,
      textContent: asText ? storedBody : htmlToPlainText(storedBody), title,
    });
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const entryMatch = path.match(/^\/entries\/(\d+)$/);
  if (entryMatch && method === "GET") {
    const id = Number(entryMatch[1]);
    const entry = await db.prepare("SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!entry) return bad("找不到紀錄", 404);
    const [{ results: atts }, { results: children }] = await Promise.all([
      db.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(id).all(),
      db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count,
                  (SELECT COUNT(*) FROM entries c WHERE c.parent_entry_id = e.id AND COALESCE(c.deleted_at, '') = '') AS child_count
                  FROM entries e WHERE e.parent_entry_id = ? AND COALESCE(e.deleted_at, '') = '' ORDER BY e.id DESC`).bind(id).all(),
    ]);
    return json({ ...entry, attachments: atts, children });
  }
  // 一筆記事的操作履歷（history 表是 append-only 的稽核軌跡）。
  // 這張表從第一版就在寫，但一直沒有任何地方讀得到——等於白記。前台的
  // 「這筆資料的來歷」面板用它回答「誰在何時對這筆做了什麼」，對專利／
  // 法規場景要的證據鏈來說，這是最基本的一環。
  const entryHistoryMatch = path.match(/^\/entries\/(\d+)\/history$/);
  if (entryHistoryMatch && method === "GET") {
    const id = Number(entryHistoryMatch[1]);
    const entry = await db.prepare("SELECT id FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!entry) return bad("找不到紀錄", 404);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50) || 50, 200);
    const { results } = await db.prepare(
      "SELECT id, action, detail, folder_id, created_at FROM history WHERE entry_id = ? ORDER BY id DESC LIMIT ?"
    ).bind(id, limit).all();
    return json({ history: results });
  }
  if (entryMatch && method === "PUT") {
    const id = Number(entryMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const title = body.title !== undefined ? (body.title || "").trim() : old.title;
    // fields 用合併不用取代：前端只送「模板欄位」，取代會把沒顯示在表單上的鍵
    // 全部抹掉——包括同步機制的 _sid／_content_hash／litdb_id。那些鍵一被抹掉，
    // 每天的來源同步就認不得這筆記事，整批重複匯入。要清空某個欄位送空字串即可。
    let fields = old.fields_json;
    if (body.fields !== undefined && body.fields && typeof body.fields === "object") {
      let oldFields = {};
      try { oldFields = JSON.parse(old.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
      fields = JSON.stringify({ ...oldFields, ...body.fields });
    }
    let folderId = body.folder_id !== undefined ? (body.folder_id ? Number(body.folder_id) : null) : old.folder_id;
    let parentEntryId = body.parent_entry_id !== undefined
      ? (body.parent_entry_id ? Number(body.parent_entry_id) : null)
      : old.parent_entry_id;
    // 明確指定 folder_id＝把整個資料包移到該資料夾頂層；不能偷偷沿用舊的外層紀錄。
    if (body.folder_id !== undefined && body.parent_entry_id === undefined) parentEntryId = null;
    const changingContainer = body.folder_id !== undefined || body.parent_entry_id !== undefined;
    if (changingContainer && parentEntryId) {
      if (parentEntryId === id) return bad("不能把紀錄移到自己裡面");
      const parent = await db.prepare("SELECT id, folder_id FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''")
        .bind(parentEntryId).first();
      if (!parent) return bad("找不到目標紀錄", 404);
      const subtree = await entrySubtreeIds(db, id, false);
      if (subtree.includes(parentEntryId)) return bad("不能把紀錄移到自己的子紀錄裡面");
      folderId = parent.folder_id;
    } else if (changingContainer) {
      parentEntryId = null;
      if (folderId) {
        const folder = await db.prepare("SELECT id FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(folderId).first();
        if (!folder) return bad("找不到目標資料夾", 404);
      }
    }
    let bodyFormat = old.body_format || "text";
    if (body.body_format !== undefined) {
      const requested = String(body.body_format || "text");
      if (requested === "html") {
        // 來源同步管理的記事（sync.js 用 fields_json._sid／litdb_id 認記事）永遠
        // 鎖在純文字：同步引擎靠 <!-- sync:start/end --> 這組純文字標記圈出管理區，
        // 换成富文字編輯器很容易在瀏覽器序列化時弄丟標記，下次同步會整段覆蓋掉
        // 使用者手動加的備註。前端本來就不會給這類記事顯示升級按鈕，這裡是後端
        // 的第二道防線，擋掉繞過前端直接打 API 的情況。
        let checkFields = {};
        try { checkFields = JSON.parse(fields || "{}"); } catch { /* 壞 JSON 當空 */ }
        if (checkFields._sid || checkFields.litdb_id) {
          return bad("這筆記事由外部來源同步管理，無法升級為富文字");
        }
      }
      bodyFormat = requested === "html" ? "html" : "text";
    }
    const bodyRaw = body.body !== undefined ? (body.body || "").trim() : old.body;
    // 存進資料庫前統一過一次白名單式清理：Quill 正常操作不會產生危險標籤，
    // 但前端可以被繞過，資料庫裡不能留 <script> 之類的東西
    const bodyText = bodyFormat === "html" ? sanitizeEntryHtml(bodyRaw) : bodyRaw;
    const folderChanged = changingContainer && (folderId !== old.folder_id || parentEntryId !== old.parent_entry_id);
    // 這筆是（歷史上）AI 自動歸類的，使用者卻手動搬去別的資料夾——清掉 🤖
    // 標記，不然畫面上會留著指向舊資料夾的過時理由。
    const wasAutoFiled = folderChanged && old.auto_filed_at && old.auto_filed_at !== "failed";
    const autoFiledAt = wasAutoFiled ? "" : (old.auto_filed_at || "");
    const autoFiledReason = wasAutoFiled ? "" : (old.auto_filed_reason || "");
    await db.prepare(
      "UPDATE entries SET title = ?, body = ?, fields_json = ?, folder_id = ?, parent_entry_id = ?, body_format = ?, auto_filed_at = ?, auto_filed_reason = ?, updated_at = ? WHERE id = ?"
    ).bind(title, bodyText, fields, folderId, parentEntryId, bodyFormat, autoFiledAt, autoFiledReason, now(), id).run();
    if (body.title !== undefined || body.body !== undefined || body.body_format !== undefined) {
      await triggerEmbedding(env, {
        kind: "entry", id, entryId: id,
        textContent: bodyFormat === "html" ? htmlToPlainText(bodyText) : bodyText, title,
      });
    }
    if (changingContainer) {
      const subtree = (await entrySubtreeIds(db, id, false)).filter((entryId) => entryId !== id);
      for (let i = 0; i < subtree.length; i += 80) {
        const part = subtree.slice(i, i + 80);
        if (!part.length) continue;
        await db.prepare(`UPDATE entries SET folder_id = ?, updated_at = ? WHERE id IN (${part.map(() => "?").join(",")})`)
          .bind(folderId, now(), ...part).run();
      }
    }
    if (folderChanged) {
      await logHistory(db, id, folderId, "分類", title);
    } else {
      await logHistory(db, id, folderId, "更新紀錄", title);
    }
    return json({ ok: true });
  }
  if (entryMatch && method === "DELETE") {
    const id = Number(entryMatch[1]);
    const old = await db.prepare("SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const result = await moveEntryTreeToTrash(db, old, now());
    await logHistory(db, id, old.folder_id, "移到垃圾桶", `${old.title || "（未命名）"}；${result.entry_count} 筆紀錄資料包`);
    return json({ ok: true, trashed: true, ...result });
  }

  // ---- 合併：把來源記事併入目標記事（附件搬過去，來源記事之後刪除）----
  // 給拖放在觸控裝置上用不了的情況用（手機是這個 App 的主要使用場景）：
  // 例如錄音中誤按了獨立的「📷 拍照」而不是浮動列裡的相機鈕，拆成兩筆
  // 記事，事後用這支端點手動合併回去。
  const entryMergeMatch = path.match(/^\/entries\/(\d+)\/merge$/);
  if (entryMergeMatch && method === "POST") {
    const sourceId = Number(entryMergeMatch[1]);
    const body = await request.json().catch(() => ({}));
    const targetId = Number(body.target_id || 0);
    if (!targetId || targetId === sourceId) return bad("合併目標不正確");
    const [source, target] = await Promise.all([
      db.prepare("SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(sourceId).first(),
      db.prepare("SELECT * FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(targetId).first(),
    ]);
    if (!source || !target) return bad("找不到來源或目標紀錄", 404);
    const sourceChildren = await db.prepare("SELECT COUNT(*) AS count FROM entries WHERE parent_entry_id = ? AND COALESCE(deleted_at, '') = ''")
      .bind(sourceId).first();
    if (Number(sourceChildren?.count || 0)) return bad("這筆紀錄包含子紀錄，不能使用破壞式合併；請改用移動");

    let sourceFields = {};
    let targetFields = {};
    try { sourceFields = JSON.parse(source.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
    try { targetFields = JSON.parse(target.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
    // 外部來源同步（sync.js）用 fields_json._sid／litdb_id 認記事；兩邊都有的話
    // 合併只會留一組鍵，下次同步就把「消失」的那筆當新資料重複匯入一份。
    if ((sourceFields._sid || sourceFields.litdb_id) && (targetFields._sid || targetFields.litdb_id)) {
      return bad("兩筆都是外部來源同步管理的記事，合併會弄亂同步追蹤，請改用刪除或調整來源設定");
    }

    // 附件逐筆搬（不是整批一次 UPDATE）：attachments 有 (entry_id, content_hash)
    // 的唯一索引，來源目標剛好有位元組完全相同的檔案時整批搬會直接撞索引失敗。
    // 撞到就當成重複檔，比照既有「移除重複附件」邏輯處理掉。
    const { results: sourceAtts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ?").bind(sourceId).all();
    let moved = 0;
    let duplicatesRemoved = 0;
    for (const att of sourceAtts || []) {
      try {
        await db.prepare("UPDATE attachments SET entry_id = ? WHERE id = ?").bind(targetId, att.id).run();
        moved++;
      } catch {
        const { results: pages } = await db.prepare("SELECT id, key FROM attachments WHERE source_pdf_id = ?").bind(att.id).all();
        if (env.FILES) {
          for (const page of pages || []) await env.FILES.delete(page.key).catch(() => {});
          await env.FILES.delete(att.key).catch(() => {});
        }
        await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(att.id).run();
        await db.prepare("DELETE FROM attachments WHERE id = ?").bind(att.id).run();
        duplicatesRemoved++;
      }
    }

    // relations 雙向重新指向目標，再清掉合併後產生的自我關聯
    await db.prepare("UPDATE relations SET from_entry_id = ? WHERE from_entry_id = ?").bind(targetId, sourceId).run();
    await db.prepare("UPDATE relations SET to_entry_id = ? WHERE to_entry_id = ?").bind(targetId, sourceId).run();
    await db.prepare("DELETE FROM relations WHERE from_entry_id = to_entry_id").run();

    // body 接起來，留下來源標題當分隔線；fields 合併不取代（目標優先），
    // 跟上面 PUT 紀錄的既有規則一致。合併後維持「目標」既有的 body_format——
    // 若目標是富文字、來源是純文字（或反過來），先把來源那段轉成跟目標
    // 一致的格式再接，不然會把沒轉義的純文字塞進 HTML、或把 HTML 標籤原樣
    // 當純文字疊進 textarea。
    const targetIsHtml = target.body_format === "html";
    const sourceBodyText = targetIsHtml
      ? (source.body_format === "html" ? (source.body || "").trim() : textToHtml((source.body || "").trim()))
      : (source.body_format === "html" ? htmlToPlainText(source.body) : (source.body || "").trim());
    const targetBodyText = (target.body || "").trim();
    const sourceTitleMark = source.title
      ? (targetIsHtml ? textToHtml(`【併入：${source.title}】`) : `【併入：${source.title}】`)
      : "";
    const sourcePart = [sourceTitleMark, sourceBodyText].filter(Boolean).join(targetIsHtml ? "" : "\n");
    const mergedBody = [targetBodyText, sourcePart].filter(Boolean).join(targetIsHtml ? "" : "\n\n");
    const mergedFields = JSON.stringify({ ...sourceFields, ...targetFields });
    await db.prepare("UPDATE entries SET body = ?, fields_json = ?, updated_at = ? WHERE id = ?")
      .bind(mergedBody, mergedFields, now(), targetId).run();
    await db.prepare("DELETE FROM entries WHERE id = ?").bind(sourceId).run();
    await logHistory(db, targetId, target.folder_id, "合併紀錄",
      `${source.title || "（未命名）"} → ${target.title || "（未命名）"}；移動 ${moved} 個附件${duplicatesRemoved ? `，略過 ${duplicatesRemoved} 個重複檔` : ""}`);
    return json({ ok: true, moved, duplicates_removed: duplicatesRemoved, target_id: targetId });
  }

  // 錄音／錄影中「記一句」：在資料庫端直接把一行接到 body 後面。
  // 刻意不做「讀出 body → 前端串接 → 整段寫回」——採集中連續記好幾句時，
  // 那種做法只要有一次請求交錯就會把前一句蓋掉。這裡用一句 SQL 完成附加，
  // 不管幾句同時進來都不會互相蓋掉。
  const noteMatch = path.match(/^\/entries\/(\d+)\/notes$/);
  if (noteMatch && method === "POST") {
    const entryId = Number(noteMatch[1]);
    const body = await request.json().catch(() => ({}));
    const line = String(body.line || "").trim();
    if (!line) return bad("line 為必填");
    const old = await db.prepare("SELECT id, folder_id, body_format FROM entries WHERE id = ?").bind(entryId).first();
    if (!old) return bad("找不到紀錄", 404);
    // 富文字記事（body_format='html'）不能把純文字原樣串進 body——那樣會在
    // HTML 片段外插入沒有標籤包住的裸文字。先包成 <p> 轉義過的段落，再走跟
    // 純文字一樣的原子附加 SQL，不影響「連續多句不互相蓋掉」這個既有保證。
    const appended = old.body_format === "html"
      ? sanitizeEntryHtml(`<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
      : line;
    const updatedAt = now();
    const result = await db.prepare(
      "UPDATE entries SET body = CASE WHEN body IS NULL OR body = '' THEN ? ELSE body || char(10) || ? END, updated_at = ? WHERE id = ?"
    ).bind(appended, appended, updatedAt, entryId).run();
    if (!result.meta.changes) return bad("找不到紀錄", 404);
    await logHistory(db, entryId, old.folder_id ?? null, "記一句", line);
    return json({ ok: true });
  }

  // ---- relations（記事與記事的關聯：實驗引用標準、專利對照廠商產品……不限類型）----
  if (path === "/relations" && method === "GET") {
    const entryId = Number(url.searchParams.get("entry_id") || 0);
    if (!entryId) return bad("需指定 entry_id");
    // 雙向都要查：這筆記事可能是關聯的起點，也可能是別人關聯過來的終點
    const { results } = await db.prepare(
      `SELECT r.*, e.title AS other_title, e.folder_id AS other_folder_id,
              f.name AS other_folder_name, f.type AS other_folder_type,
              (r.from_entry_id = ?) AS is_from
       FROM relations r
       JOIN entries e ON e.id = (CASE WHEN r.from_entry_id = ? THEN r.to_entry_id ELSE r.from_entry_id END)
       LEFT JOIN folders f ON f.id = e.folder_id
       WHERE (r.from_entry_id = ? OR r.to_entry_id = ?)
         AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')
       ORDER BY r.id DESC`
    ).bind(entryId, entryId, entryId, entryId).all();
    return json(results);
  }
  if (path === "/relations" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const fromId = Number(body.from_entry_id || 0);
    const toId = Number(body.to_entry_id || 0);
    const relationType = (body.relation_type || "").trim();
    if (!fromId || !toId) return bad("需指定 from_entry_id 與 to_entry_id");
    if (fromId === toId) return bad("不能關聯到自己");
    if (!relationType) return bad("relation_type 為必填");
    const [from, to] = await Promise.all([
      db.prepare("SELECT id FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(fromId).first(),
      db.prepare("SELECT id FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(toId).first(),
    ]);
    if (!from || !to) return bad("找不到其中一筆記事", 404);
    const r = await db.prepare(
      "INSERT INTO relations (from_entry_id, to_entry_id, relation_type, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(fromId, toId, relationType, (body.note || "").trim(), now()).run();
    await logHistory(db, fromId, null, "新增關聯", `${relationType} → entry ${toId}`);
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const relationMatch = path.match(/^\/relations\/(\d+)$/);
  if (relationMatch && method === "DELETE") {
    const id = Number(relationMatch[1]);
    const old = await db.prepare("SELECT * FROM relations WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到關聯", 404);
    await db.prepare("DELETE FROM relations WHERE id = ?").bind(id).run();
    await logHistory(db, old.from_entry_id, null, "刪除關聯", `${old.relation_type} → entry ${old.to_entry_id}`);
    return json({ ok: true });
  }

  // ---- 一次性匯入：把 Medtec 展商主檔＋團隊拜訪紀錄搬進來，變成「廠商」類型的記事 ----
  // 展商主檔（exhibitors.json）走 MEDTEC Service Binding；團隊狀態／拜訪紀錄／附件擷取文字
  // 直接讀 DB_MEDTEC（唯讀共綁，同一顆 D1，做法跟 mcp/src/worker.js 一樣）。
  // 冪等：用 fields_json 裡的 medtec_exhibitor_id 判斷這家展商是否已經匯入過，
  // 重複呼叫不會產生重複記事（但也不會覆寫匯入後使用者自己編輯過的內容）。
  // 支援 limit/offset 分頁——585 家一次處理容易跑太久，分批呼叫、看回傳的 next_offset 繼續。
  if (path === "/admin/import-exhibitors" && method === "POST") {
    if (!env.MEDTEC) return bad("尚未設定 MEDTEC Service Binding（見 fieldlog/wrangler.jsonc）", 501);
    if (!env.DB_MEDTEC) return bad("尚未設定 DB_MEDTEC D1 binding（見 fieldlog/wrangler.jsonc）", 501);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0) || 0, 0);

    const exRes = await env.MEDTEC.fetch("https://medtec.internal/data/exhibitors.json");
    if (!exRes.ok) return bad(`讀取 Medtec 展商資料失敗（HTTP ${exRes.status}）`, 502);
    const exData = await exRes.json();
    const allExhibitors = exData.exhibitors || [];
    const categoryNames = new Map((exData.categories || []).map((c) => [c.id, c.name_zh || c.name_en || c.id]));
    const batch = allExhibitors.slice(offset, offset + limit);
    if (!batch.length) {
      return json({ ok: true, processed: 0, imported: 0, skipped: 0, total: allExhibitors.length, next_offset: null });
    }

    let rootFolder = await db.prepare(
      "SELECT id FROM folders WHERE type = '廠商' AND parent_id IS NULL AND name = ?"
    ).bind("廠商（Medtec 2026）").first();
    const rootFolderId = rootFolder
      ? rootFolder.id
      : (await db.prepare("INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)")
          .bind("廠商（Medtec 2026）", "廠商", null, now()).run()).meta.last_row_id;
    const categoryFolderIds = new Map(); // 分類名稱 -> 資料夾 id（懶建立，用到才建）
    async function categoryFolderId(catId) {
      const name = categoryNames.get(catId) || "未分類";
      if (categoryFolderIds.has(name)) return categoryFolderIds.get(name);
      const existing = await db.prepare(
        "SELECT id FROM folders WHERE type = '廠商' AND parent_id = ? AND name = ?"
      ).bind(rootFolderId, name).first();
      if (existing) { categoryFolderIds.set(name, existing.id); return existing.id; }
      const r = await db.prepare("INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(name, "廠商", rootFolderId, now()).run();
      categoryFolderIds.set(name, r.meta.last_row_id);
      return r.meta.last_row_id;
    }

    let imported = 0, skipped = 0;
    for (const ex of batch) {
      const already = await db.prepare(
        "SELECT id FROM entries WHERE json_extract(fields_json, '$.medtec_exhibitor_id') = ?"
      ).bind(ex.id).first();
      if (already) { skipped++; continue; }
      const folderId = await categoryFolderId(ex.category);
      const [state, notesRes, attsRes] = await Promise.all([
        env.DB_MEDTEC.prepare("SELECT * FROM exhibitor_state WHERE exhibitor_id = ?").bind(ex.id).first(),
        env.DB_MEDTEC.prepare("SELECT * FROM notes WHERE exhibitor_id = ? AND deleted = 0 ORDER BY created_at").bind(ex.id).all(),
        env.DB_MEDTEC.prepare("SELECT * FROM attachments WHERE exhibitor_id = ? ORDER BY id").bind(ex.id).all(),
      ]);
      const bodyParts = [];
      if (ex.description) bodyParts.push(String(ex.description).trim());
      if (state) {
        const deptTags = JSON.parse(state.dept_tags || "[]").join("、");
        const goalTags = JSON.parse(state.goal_tags || "[]").join("、");
        const stateLine = [
          state.status ? `拜訪狀態：${state.status}` : "",
          state.assignee ? `負責人：${state.assignee}` : "",
          deptTags ? `部門標籤：${deptTags}` : "",
          goalTags ? `目標標籤：${goalTags}` : "",
          state.post_class ? `分類後評估：${state.post_class}` : "",
        ].filter(Boolean).join("｜");
        if (stateLine) bodyParts.push(`## 匯入時的團隊狀態\n${stateLine}`);
      }
      const notes = notesRes.results || [];
      if (notes.length) {
        bodyParts.push(`## 拜訪紀錄（匯入自 Medtec 系統，共 ${notes.length} 則）`);
        for (const n of notes) bodyParts.push(`- ${n.created_at}｜${n.author}｜${n.type}：${n.content}`);
      }
      const atts = attsRes.results || [];
      if (atts.length) {
        bodyParts.push(`## 附件擷取內容（匯入自 Medtec 系統，原始檔案仍留在 Medtec；共 ${atts.length} 個）`);
        for (const a of atts) {
          const text = stripPdfMetadata(a.ocr_text || "") || (a.transcript || "");
          bodyParts.push(`- ${a.filename}${text ? `：${text.slice(0, 3000)}${text.length > 3000 ? "…（已截斷，原始檔案在 Medtec 系統）" : ""}` : "（尚無擷取內容）"}`);
        }
      }
      const fields = {
        "攤位／位置": ex.booth_no || "",
        "國家": ex.country || "",
        "產品": (ex.products || []).join("、"),
        "聯絡窗口": "",
        "評估結果": "",
        medtec_exhibitor_id: ex.id,
      };
      const r = await db.prepare(
        "INSERT INTO entries (folder_id, title, fields_json, body, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(folderId, ex.name_zh || ex.name_en || ex.id, JSON.stringify(fields), bodyParts.join("\n\n"), now()).run();
      await logHistory(db, r.meta.last_row_id, folderId, "匯入廠商", `來自 Medtec：${ex.name_zh || ex.id}`);
      imported++;
    }
    const nextOffset = offset + batch.length < allExhibitors.length ? offset + batch.length : null;
    return json({ ok: true, processed: batch.length, imported, skipped, total: allExhibitors.length, next_offset: nextOffset });
  }

  // ---- 外部來源同步（sources 表驅動；手動觸發端點，cron 每天也會自動跑）----
  // 前身是一次性的 /admin/import-litdb（來源寫死三個 litdb 收藏、欄位白名單、
  // 只 INSERT 不 UPDATE）。現在來源清單在 sources 表、body 用通用渲染器展開
  // 任何欄位都可搜尋、content hash 判斷該不該更新，引擎在 lib/sync.js。
  // 舊路徑留作別名，之前教過的 curl 指令照樣能用。
  if ((path === "/admin/sync-sources" || path === "/admin/import-litdb") && method === "POST") {
    const only = (url.searchParams.get("source") || "").trim() || null;
    const outcome = await syncSources(db, { only });
    return json(outcome, outcome.ok ? 200 : 502);
  }

  // 一次性的資料夾分類重整（2026-08-08）手動觸發端點，跟 /admin/sync-sources
  // 同一個道理：本來掛在 scheduled()，每天台灣時間 02:00 才會自動套用一次，
  // 不想等的話用這支立刻跑。函式自己有標記機制，跑第二次也是安全的無事發生。
  if (path === "/admin/reorg-folders-20260808" && method === "POST") {
    await applyFolderReorg20260808(db, now());
    return json({ ok: true });
  }

  // 一次性補跑：語意搜尋上線前就已經存在、但從沒排入向量化的舊記事／附件
  // 一起補上（embedding_status 還是預設的 'pending'）。上線後跑一次即可，
  // 之後新資料靠寫入點各自的 triggerEmbedding() 呼叫，不需要重跑這支。
  //
  // 分批是必要的，不是保守起見：2026-08-16 第一次補跑一口氣排了 298 筆
  // （附件每份最多再切 20 段），把當天的免費 Neurons 額度吃掉，害正在進行的
  // 錄音即時轉錄被安全門檻擋下來停掉。向量化是背景的加值功能，不該跟現場
  // 錄音搶額度——預設一次只跑 limit 筆，剩下的下次再打這支繼續。
  if (path === "/admin/backfill-embeddings" && method === "POST") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 200);
    let queued = 0;
    const { results: entries } = await db.prepare(
      `SELECT id, title, body, body_format FROM entries
       WHERE COALESCE(deleted_at, '') = '' AND COALESCE(embedding_status, 'pending') = 'pending'
       ORDER BY id LIMIT ?`
    ).bind(limit).all();
    for (const e of entries) {
      const text = e.body_format === "html" ? htmlToPlainText(e.body || "") : (e.body || "");
      if (!text.trim() && !(e.title || "").trim()) continue;
      await triggerEmbedding(env, { kind: "entry", id: e.id, entryId: e.id, textContent: text, title: e.title });
      queued++;
    }
    const attBudget = Math.max(0, limit - entries.length);
    const { results: atts } = attBudget ? await db.prepare(
      `SELECT a.id, a.entry_id, a.transcript, a.ocr_text FROM attachments a
       JOIN entries e ON e.id = a.entry_id
       WHERE COALESCE(e.deleted_at, '') = '' AND COALESCE(a.embedding_status, 'pending') = 'pending'
         AND (COALESCE(a.transcript, '') != '' OR COALESCE(a.ocr_text, '') != '')
       ORDER BY a.id LIMIT ?`
    ).bind(attBudget).all() : { results: [] };
    for (const a of atts) {
      const text = a.transcript || stripPdfMetadata(a.ocr_text || "");
      await triggerEmbedding(env, { kind: "attachment", id: a.id, entryId: a.entry_id, textContent: text });
      queued++;
    }
    // 還有沒有剩的一併回報，呼叫端才知道要不要再打一次——不然「跑完了」跟
    // 「這批跑完但還有 200 筆沒動」在回應上看起來一模一樣。
    const { total: remaining } = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM entries
                WHERE COALESCE(deleted_at, '') = '' AND COALESCE(embedding_status, 'pending') = 'pending')
             + (SELECT COUNT(*) FROM attachments a JOIN entries e ON e.id = a.entry_id
                WHERE COALESCE(e.deleted_at, '') = '' AND COALESCE(a.embedding_status, 'pending') = 'pending'
                  AND (COALESCE(a.transcript, '') != '' OR COALESCE(a.ocr_text, '') != '')) AS total`
    ).first();
    return json({ ok: true, queued, entries: entries.length, attachments: atts.length, remaining: Number(remaining || 0) - queued });
  }

  // ---- 外部來源管理（新增一個知識庫＝往 sources 表加一列，不用改程式碼）----
  // key 建立後不可改：它是同步進來的每筆記事的內部識別碼前綴（_sid = key:id），
  // 改了會讓既有記事全部變成孤兒、下次同步整批重複匯入。
  if (path === "/sources" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM sources ORDER BY id").all();
    return json({ sources: results });
  }
  if (path === "/sources" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const key = (body.key || "").trim();
    const label = (body.label || "").trim();
    const sourceUrl = (body.url || "").trim();
    if (!key || !label || !sourceUrl) return bad("key、label、url 為必填");
    if (!/^[a-z0-9_-]+$/i.test(key)) return bad("key 只能用英數、底線、連字號（會當作資料的內部識別碼前綴）");
    const clash = await db.prepare("SELECT id FROM sources WHERE key = ?").bind(key).first();
    if (clash) return bad(`來源「${key}」已經存在`, 409);
    const r = await db.prepare(
      `INSERT INTO sources (key, label, url, items_path, id_field, title_field, folder_parent, folder_type, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      key, label, sourceUrl,
      String(body.items_path || "papers").trim(), String(body.id_field || "id").trim(), String(body.title_field || "title").trim(),
      String(body.folder_parent || "").trim(), String(body.folder_type || "文獻庫").trim(),
      body.enabled === false || body.enabled === 0 ? 0 : 1, now()
    ).run();
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const sourceMatch = path.match(/^\/sources\/(\d+)$/);
  if (sourceMatch && method === "PUT") {
    const id = Number(sourceMatch[1]);
    const old = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到來源", 404);
    const body = await request.json().catch(() => ({}));
    const next = {
      label: body.label !== undefined ? String(body.label).trim() : old.label,
      url: body.url !== undefined ? String(body.url).trim() : old.url,
      items_path: body.items_path !== undefined ? String(body.items_path).trim() : old.items_path,
      id_field: body.id_field !== undefined ? String(body.id_field).trim() : old.id_field,
      title_field: body.title_field !== undefined ? String(body.title_field).trim() : old.title_field,
      folder_parent: body.folder_parent !== undefined ? String(body.folder_parent).trim() : old.folder_parent,
      folder_type: body.folder_type !== undefined ? String(body.folder_type).trim() : old.folder_type,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : old.enabled,
    };
    if (!next.label || !next.url) return bad("label 與 url 不可空白");
    await db.prepare(
      "UPDATE sources SET label = ?, url = ?, items_path = ?, id_field = ?, title_field = ?, folder_parent = ?, folder_type = ?, enabled = ? WHERE id = ?"
    ).bind(next.label, next.url, next.items_path, next.id_field, next.title_field, next.folder_parent, next.folder_type, next.enabled, id).run();
    return json({ ok: true });
  }
  if (sourceMatch && method === "DELETE") {
    const old = await db.prepare("SELECT id, key FROM sources WHERE id = ?").bind(Number(sourceMatch[1])).first();
    if (!old) return bad("找不到來源", 404);
    await db.prepare("DELETE FROM sources WHERE id = ?").bind(old.id).run();
    return json({ ok: true, note: `來源「${old.key}」已移除；已同步進來的記事保留不動` });
  }

  // ---- 附件上傳（R2）----
  if (path === "/upload" && method === "POST") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存（見 fieldlog/README.md）", 501);
    const entryId = Number(request.headers.get("x-entry-id") || 0);
    if (!entryId) return bad("缺 x-entry-id");
    const filename = decodeURIComponent(request.headers.get("x-filename") || "file").trim();
    const mime = request.headers.get("content-type") || "application/octet-stream";
    const offsetRaw = request.headers.get("x-offset-secs");
    const offsetSecs = offsetRaw !== null && offsetRaw !== "" ? Number(offsetRaw) : null;
    const kind = mime.startsWith("image/") ? "photo" : mime.startsWith("audio/") ? "audio" : "file";
    const body = await request.arrayBuffer();
    if (!body.byteLength) return bad("空檔案");
    if (body.byteLength > 50 * 1024 * 1024) return bad("檔案過大（上限 50MB）");
    const digest = await crypto.subtle.digest("SHA-256", body);
    const contentHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const sourcePdfRaw = request.headers.get("x-source-pdf-id");
    const sourcePdfId = sourcePdfRaw !== null && sourcePdfRaw !== "" ? Number(sourcePdfRaw) : null;
    // 節錄版偵測用：只在頂層檔案（不是深度處理拆出來的頁面圖）記來源網址
    const sourceUrlRaw = request.headers.get("x-source-url");
    const sourceUrl = !sourcePdfId && sourceUrlRaw ? decodeURIComponent(sourceUrlRaw).trim().slice(0, 500) : "";
    const entry = await db.prepare(
      `SELECT e.folder_id FROM entries e LEFT JOIN folders f ON f.id = e.folder_id
       WHERE e.id = ? AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')`
    ).bind(entryId).first();
    if (!entry) return bad("找不到附件所屬記事", 404);
    // 新檔直接比 SHA-256；舊檔尚無 hash 時，只針對同檔名同大小者讀 R2 補算一次，
    // 避免誤判不同內容。一般附件在同一資料夾內去重；PDF 拆頁仍只在同一記事內比對。
    const candidateQuery = sourcePdfId
      ? db.prepare(
        `SELECT id, key, filename, size, content_hash FROM attachments
         WHERE entry_id = ? AND (content_hash = ? OR (COALESCE(content_hash, '') = '' AND filename = ? AND size = ?))`
      ).bind(entryId, contentHash, filename, body.byteLength)
      : db.prepare(
        `SELECT a.id, a.key, a.filename, a.size, a.content_hash
         FROM attachments a JOIN entries e ON e.id = a.entry_id
         WHERE a.source_pdf_id IS NULL AND e.folder_id IS ?
           AND (a.content_hash = ? OR (COALESCE(a.content_hash, '') = '' AND a.filename = ? AND a.size = ?))`
      ).bind(entry.folder_id ?? null, contentHash, filename, body.byteLength);
    const { results: candidates } = await candidateQuery.all();
    for (const old of candidates || []) {
      let oldHash = old.content_hash || "";
      if (!oldHash) {
        const oldObj = await env.FILES.get(old.key);
        if (oldObj) {
          const oldDigest = await crypto.subtle.digest("SHA-256", await oldObj.arrayBuffer());
          oldHash = [...new Uint8Array(oldDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          await db.prepare("UPDATE attachments SET content_hash = ? WHERE id = ?").bind(oldHash, old.id).run().catch(() => {});
        }
      }
      if (oldHash === contentHash) {
        return json({ ok: true, duplicate: true, id: old.id, error: "相同檔案已存在，已略過上傳" }, 409);
      }
    }
    const key = `${entryId}/${Date.now()}-${filename.replace(/[^\w.\-一-鿿]+/g, "_")}`;
    await env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
    // Tier 2 深度處理：PDF 逐頁 render 成圖片上傳時，帶回來源 PDF 的 id 與頁碼
    const pageNoRaw = request.headers.get("x-page-no");
    const pageNo = pageNoRaw !== null && pageNoRaw !== "" ? Number(pageNoRaw) : null;
    const durationRaw = request.headers.get("x-duration-secs");
    const durationSecs = durationRaw !== null && durationRaw !== "" ? Math.max(0, Math.round(Number(durationRaw))) : null;
    const r = await db.prepare(
      "INSERT INTO attachments (entry_id, kind, filename, original_filename, key, size, mime, offset_secs, source_pdf_id, page_no, duration_secs, content_hash, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(entryId, kind, filename, filename, key, body.byteLength, mime, offsetSecs, sourcePdfId, pageNo, durationSecs, contentHash, sourceUrl, now()).run();
    const attachmentId = r.meta.last_row_id;
    if (!sourcePdfId) {
      await autoRenameAttachment(db, {
        id: attachmentId, entry_id: entryId, filename, original_filename: filename,
        kind, mime, created_at: now(),
      }, "");
    }
    await logHistory(db, entryId, null, "上傳附件", `${filename}（${(body.byteLength / 1024 / 1024).toFixed(1)}MB）`);
    return json({ id: attachmentId, key, ok: true });
  }
  const fileMatch = path.match(/^\/file\/(.+)$/);
  if (fileMatch && method === "GET") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存", 501);
    const key = decodeURIComponent(fileMatch[1]);
    const activeFile = await db.prepare(
      `SELECT a.id FROM attachments a JOIN entries e ON e.id = a.entry_id LEFT JOIN folders f ON f.id = e.folder_id
       WHERE a.key = ? AND COALESCE(e.deleted_at, '') = '' AND (f.id IS NULL OR COALESCE(f.deleted_at, '') = '')`
    ).bind(key).first();
    if (!activeFile) return bad("找不到檔案", 404);
    // 帶 expires+sig 就一定要通過驗證（篡改或過期都 403）；不帶的照舊，
    // 因為前端 <img src>／下載連結本來就是靠 ?pin= 走同一個閘門
    const expires = url.searchParams.get("expires");
    const sig = url.searchParams.get("sig");
    if (expires || sig) {
      const err = await verifyFileSignature(key, env.FIELD_PIN, expires, sig);
      if (err) return bad(err, 403);
    }
    const obj = await env.FILES.get(key);
    if (!obj) return bad("找不到檔案", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  }
  // 手動整理既有附件名稱：只用已入庫的 OCR／逐字稿與記事脈絡，不重新呼叫 AI。
  if (path === "/attachments/rename-existing" && method === "POST") {
    await db.prepare(
      "UPDATE attachments SET original_filename = filename WHERE COALESCE(original_filename, '') = ''"
    ).run();
    const { results } = await db.prepare(
      `SELECT * FROM attachments
       WHERE source_pdf_id IS NULL
       ORDER BY id`
    ).all();
    let renamed = 0;
    for (const att of results || []) {
      const text = att.ocr_text || att.transcript || "";
      if (await autoRenameAttachment(db, att, text)) renamed++;
    }
    // 同一資料夾內僅刪除 SHA-256 完全相同的附件，保留最早上傳的一份。
    // 舊附件若尚無 hash，只為「同檔名且同大小」的疑似重複組補算，避免大量讀取 R2。
    const { results: current } = await db.prepare(
      `SELECT a.*, e.folder_id FROM attachments a
       JOIN entries e ON e.id = a.entry_id
       WHERE a.source_pdf_id IS NULL ORDER BY a.id`
    ).all();
    const suspectCounts = new Map();
    for (const att of current || []) {
      const key = `${att.folder_id ?? "inbox"}\n${att.filename}\n${att.size}`;
      suspectCounts.set(key, (suspectCounts.get(key) || 0) + 1);
    }
    for (const att of current || []) {
      if (att.content_hash || !env.FILES) continue;
      const suspectKey = `${att.folder_id ?? "inbox"}\n${att.filename}\n${att.size}`;
      if ((suspectCounts.get(suspectKey) || 0) < 2) continue;
      const obj = await env.FILES.get(att.key);
      if (!obj) continue;
      const digest = await crypto.subtle.digest("SHA-256", await obj.arrayBuffer());
      att.content_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await db.prepare("UPDATE attachments SET content_hash = ? WHERE id = ?").bind(att.content_hash, att.id).run();
    }
    let duplicatesRemoved = 0;
    const kept = new Map();
    for (const att of current || []) {
      if (!att.content_hash) continue;
      const duplicateKey = `${att.folder_id ?? "inbox"}\n${att.content_hash}`;
      if (!kept.has(duplicateKey)) {
        kept.set(duplicateKey, att.id);
        continue;
      }
      const { results: pages } = await db.prepare(
        "SELECT id, key FROM attachments WHERE source_pdf_id = ?"
      ).bind(att.id).all();
      if (env.FILES) {
        for (const page of pages || []) await env.FILES.delete(page.key).catch(() => {});
        await env.FILES.delete(att.key).catch(() => {});
      }
      await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(att.id).run();
      await db.prepare("DELETE FROM attachments WHERE id = ?").bind(att.id).run();
      await logHistory(db, att.entry_id, null, "移除重複附件", `${att.filename}（保留相同內容的較早版本）`);
      duplicatesRemoved++;
    }
    // 第二階段：標準文件專屬的整理——統一成「組織_編號_年份_中文標題.pdf」，
    // 並清掉同一個資料夾裡同一份標準的重複檔（僅二進位完全相同才刪，見
    // cleanup.js 開頭的說明：原本還有一層「內文幾乎相同」的模糊比對，
    // 因為會誤刪 ISO 這類本來就大量共用樣板文字的文件，已經拿掉）。
    //
    // 這一段會刪列，而 attachments 有一個 (entry_id, content_hash) 的唯一索引；
    // 整理過程中會出現「暫時兩列同 hash」的中間狀態而撞索引，所以先卸索引、
    // 做完再建回去。建不回來的話一定要讓呼叫端知道（資料庫少了防重索引），
    // 不能默默成功。
    await db.prepare("DROP INDEX IF EXISTS idx_att_entry_hash").run();
    let standardCleanup = null;
    let cleanupError = null;
    try {
      standardCleanup = await cleanupStandardAttachments(env, db, { logHistory });
    } catch (err) {
      cleanupError = err.message;
    }
    try {
      await db.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_att_entry_hash ON attachments(entry_id, content_hash) WHERE content_hash IS NOT NULL AND content_hash <> ''"
      ).run();
    } catch (err) {
      return bad(`重複檔整理後無法恢復資料庫索引：${err.message}`, 500);
    }
    if (cleanupError) return bad(`標準檔名整理失敗：${cleanupError}`, 500);

    return json({
      ok: true,
      checked: (results || []).length,
      renamed: renamed + standardCleanup.renamed,
      duplicates_removed: duplicatesRemoved + standardCleanup.duplicates_removed,
    });
  }
  const attMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attMatch && method === "PUT") {
    const id = Number(attMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await activeAttachment(db, id);
    if (!old) return bad("找不到附件", 404);
    if (body.ocr_text !== undefined) {
      const ocrText = (body.ocr_text || "").trim();
      await db.prepare("UPDATE attachments SET ocr_text = ? WHERE id = ?").bind(ocrText, id).run();
      await logHistory(db, old.entry_id, null, "編輯擷取文字", `${old.filename}：「${ocrText.slice(0, 80)}」`);
      await triggerEmbedding(env, { kind: "attachment", id, entryId: old.entry_id, textContent: ocrText });
      return json({ ok: true });
    }
    // 標記「不整理」：把 *_at 設成 'skipped'（不呼叫 AI、不花額度），
    // 待整理數字與批次整理都會跳過；之後按「還是要整理」跑 AI 會覆寫回真正時間戳
    if (body.skip_transcribe) {
      await db.prepare("UPDATE attachments SET transcribed_at = 'skipped' WHERE id = ?").bind(id).run();
      await logHistory(db, old.entry_id, null, "設為不整理", `${old.filename}（錄音不轉文字）`);
      return json({ ok: true });
    }
    if (body.skip_ocr) {
      await db.prepare("UPDATE attachments SET ocr_at = 'skipped' WHERE id = ?").bind(id).run();
      await logHistory(db, old.entry_id, null, "設為不整理", `${old.filename}（不擷取文字）`);
      return json({ ok: true });
    }
    // Tier 2 深度處理時前端用 pdf.js 讀到這份 PDF「實際」有幾頁，存起來跟目錄
    // 推算的頁數比對，抓節錄版（見 schema.js total_pages 欄位註解）
    if (body.total_pages !== undefined) {
      const totalPages = Number(body.total_pages) || null;
      await db.prepare("UPDATE attachments SET total_pages = ? WHERE id = ?").bind(totalPages, id).run();
      return json({ ok: true });
    }
    const category = (body.category !== undefined ? body.category : old.category) || "";
    await db.prepare("UPDATE attachments SET category = ? WHERE id = ?").bind(category.trim(), id).run();
    return json({ ok: true });
  }
  if (attMatch && method === "DELETE") {
    // 連同深度處理產生的逐頁圖片與 AI 用量預約一起清掉；若記事因此變成完全空的
    // （沒檔案也沒文字），記事本身也收掉，不留下使用者看不懂的空殼
    const id = Number(attMatch[1]);
    if (!await activeAttachment(db, id)) return bad("找不到附件", 404);
    const result = await deleteAttachmentDeep(db, env.FILES, id, { logHistory, vectorIndex: env.VECTOR_INDEX });
    return json(result, result.status || 200);
  }

  // ---- 單一檔案的操作（搬移／附屬記事／檔名整理／醫材分類）----
  const attMoveMatch = path.match(/^\/attachments\/(\d+)\/move$/);
  if (attMoveMatch && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const folderId = Number(body.folder_id || 0);
    if (!folderId) return bad("請指定目標資料夾");
    const id = Number(attMoveMatch[1]);
    if (!await activeAttachment(db, id)) return bad("找不到附件", 404);
    const result = await moveAttachment(db, id, folderId, { logHistory, timestamp: now });
    return json(result, result.status || 200);
  }
  const attNoteMatch = path.match(/^\/attachments\/(\d+)\/note$/);
  if (attNoteMatch && method === "PUT") {
    const id = Number(attNoteMatch[1]);
    const body = await request.json().catch(() => ({}));
    const note = String(body.note || "").trim().slice(0, 50000);
    const attachment = await activeAttachment(db, id);
    if (!attachment) return bad("找不到附件", 404);
    await db.prepare("UPDATE attachments SET note = ? WHERE id = ?").bind(note, id).run();
    await logHistory(db, attachment.entry_id, null, "更新附件記事", `${attachment.filename}：${note.slice(0, 120)}`);
    return json({ ok: true });
  }
  // 純顯示層的旋轉——只改 attachments.rotation 這個中繼資料欄位，R2 裡的原始
  // 檔案完全不動（raw data 只增不刪）。每次點擊 +90° mod 360，跟前端「每點一下
  // 轉一格」的按鈕行為對應，角度算在伺服器端，不靠前端自己算再回傳絕對值，
  // 避免兩個分頁同時點時互相蓋掉對方的旋轉。
  const attRotateMatch = path.match(/^\/attachments\/(\d+)\/rotate$/);
  if (attRotateMatch && method === "POST") {
    const id = Number(attRotateMatch[1]);
    const attachment = await activeAttachment(db, id);
    if (!attachment) return bad("找不到附件", 404);
    const rotation = (Number(attachment.rotation) + 90) % 360;
    await db.prepare("UPDATE attachments SET rotation = ? WHERE id = ?").bind(rotation, id).run();
    return json({ ok: true, rotation });
  }
  const attNormalizeMatch = path.match(/^\/attachments\/(\d+)\/normalize-name$/);
  if (attNormalizeMatch && method === "POST") {
    const id = Number(attNormalizeMatch[1]);
    if (!await activeAttachment(db, id)) return bad("找不到附件", 404);
    const result = await normalizeAttachmentName(db, id, { logHistory });
    return json(result, result.status || 200);
  }
  const attCategoryMatch = path.match(/^\/attachments\/(\d+)\/category$/);
  if (attCategoryMatch && (method === "GET" || method === "PUT")) {
    const id = Number(attCategoryMatch[1]);
    const attachment = await activeAttachment(db, id);
    if (!attachment) return bad("找不到附件", 404);
    if (method === "GET") {
      return json({
        ok: true,
        id: attachment.id,
        filename: attachment.filename,
        category: attachment.device_category || "",
        categories: await deviceCategoryNames(db),
      });
    }
    const body = await request.json().catch(() => ({}));
    const category = String(body.category || "").trim();
    // 空字串＝清掉分類，一律允許；非空的話要在分類字典裡（避免打錯字產生幽靈分類）
    if (category) {
      const names = await deviceCategoryNames(db);
      if (!names.includes(category)) {
        return bad(`「${category}」不在醫材分類清單裡——先到「管理分類」新增，或改選現有分類`);
      }
    }
    await db.prepare("UPDATE attachments SET device_category = ? WHERE id = ?").bind(category, id).run();
    await logHistory(db, attachment.entry_id, null, "更新醫材分類", `${attachment.filename}：${category || "未分類"}`);
    return json({ ok: true, category });
  }

  // ---- 錄音轉文字（Workers AI Whisper）----
  // ---- 附件原始檔存取（給 MCP／外部工具用）----
  // 既有的 /attachments/:id 回的是「擷取後的文字」，但把照片嵌進 Word 報告這種
  // 用途要的是原始 bytes。小圖直接 base64 回去（省一趟 round-trip、拿到就能用），
  // 大檔改回帶簽名的下載網址，避免一次把幾十 MB 塞進 JSON。
  const rawMatch = path.match(/^\/attachments\/(\d+)\/raw$/);
  if (rawMatch && method === "GET") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存", 501);
    const id = Number(rawMatch[1]);
    const att = await activeAttachment(db, id);
    if (!att) return bad("找不到附件", 404);
    const obj = await env.FILES.get(att.key);
    if (!obj) return bad("找不到檔案內容", 404);
    const size = Number(att.size || 0) || obj.size || 0;
    const mode = url.searchParams.get("mode") || (size <= INLINE_RAW_MAX_BYTES ? "inline" : "url");
    if (mode !== "inline" && mode !== "url") return bad("mode 只能是 inline 或 url");
    if (mode === "inline") {
      // 超過門檻不要硬塞：base64 會再膨脹約 4/3，Worker 回應與呼叫端的 JSON
      // 解析都扛不住，直接告訴呼叫端改用 url
      if (size > INLINE_RAW_MAX_BYTES) {
        return bad(`檔案 ${(size / 1024 / 1024).toFixed(1)}MB 超過 inline 上限 ${INLINE_RAW_MAX_BYTES / 1024 / 1024}MB，請改用 mode=url`, 413);
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return json({
        id, filename: att.filename, mime_type: att.mime,
        encoding: "base64", data: bytesToBase64(bytes), size_bytes: bytes.byteLength,
      });
    }
    const signed = await createSignedFileUrl(att.key, env.FIELD_PIN, url.origin);
    return json({
      id, filename: att.filename, mime_type: att.mime,
      url: signed.url, expires_at: signed.expires_at, size_bytes: size,
    });
  }

  // ---- 批次擷取文字：把一個資料夾／一筆紀錄裡還沒整理的照片一次跑完 ----
  // 只做照片 OCR，不碰錄音：錄音已經有 /entries/:id/auto-transcribe，那支帶了
  // Neurons 預估、ai_usage_reservations 佔位與 transcribed_at 鎖，能防重複扣額度
  // 也能在逼近門檻時提早收手。在這裡另寫一套等於繞過那層保護，所以改成把「還有
  // 錄音待處理」的 entry id 一併回報，讓呼叫端去打那支正規端點。
  if (path === "/batch/ocr" && method === "POST") {
    if (!env.AI || !env.FILES) return bad("尚未啟用 Workers AI 與 R2", 501);
    const body = await request.json().catch(() => ({}));
    const folderId = body.folder_id ? Number(body.folder_id) : null;
    const entryId = body.entry_id ? Number(body.entry_id) : null;
    if (!folderId && !entryId) return bad("需指定 folder_id 或 entry_id");
    if (folderId && entryId) return bad("folder_id 與 entry_id 只能擇一");
    // 上限擋住的是 Worker 的 30 秒 CPU 時間：一張照片 OCR 要好幾秒，
    // 一次收太多必定逾時，逾時的話已經扣掉的額度也拿不回來
    const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 20);
    const scope = folderId
      ? db.prepare(
          `SELECT a.* FROM attachments a JOIN entries e ON e.id = a.entry_id
           WHERE e.folder_id = ? AND a.kind = 'photo' AND COALESCE(a.ocr_at, '') = ''
           ORDER BY a.id LIMIT ?`
        ).bind(folderId, limit)
      : db.prepare(
          `SELECT a.* FROM attachments a
           WHERE a.entry_id = ? AND a.kind = 'photo' AND COALESCE(a.ocr_at, '') = ''
           ORDER BY a.id LIMIT ?`
        ).bind(entryId, limit);
    const { results: pending } = await scope.all();

    // 還有多少錄音沒轉——回報給呼叫端，讓它自己去打 auto-transcribe
    const audioSql = folderId
      ? `SELECT DISTINCT a.entry_id AS id FROM attachments a JOIN entries e ON e.id = a.entry_id
         WHERE e.folder_id = ? AND a.kind = 'audio' AND COALESCE(a.transcript, '') = '' AND COALESCE(a.transcribed_at, '') = ''`
      : `SELECT DISTINCT a.entry_id AS id FROM attachments a
         WHERE a.entry_id = ? AND a.kind = 'audio' AND COALESCE(a.transcript, '') = '' AND COALESCE(a.transcribed_at, '') = ''`;
    const { results: audioEntries } = await db.prepare(audioSql).bind(folderId || entryId).all();
    const pendingAudioEntryIds = (audioEntries || []).map((r) => r.id);

    if (!pending.length) {
      return json({ processed: 0, results: [], remaining: 0, pending_audio_entry_ids: pendingAudioEntryIds });
    }
    // 預算檢查放在真的要呼叫 AI 之前做一次就好；逐張再檢查會讓已經跑一半的批次
    // 中途噴錯，不如在入口擋掉
    try { await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }

    const ai = budgetedAi(env);
    const results = [];
    for (const att of pending) {
      // 搶鎖：ocr_at 從空字串換成 'processing'，同一張不會被兩個請求重複跑
      const lock = await db.prepare(
        "UPDATE attachments SET ocr_at = 'processing' WHERE id = ? AND COALESCE(ocr_at, '') = ''"
      ).bind(att.id).run();
      if (!lock.meta.changes) continue;
      try {
        const obj = await env.FILES.get(att.key);
        if (!obj) throw new Error("找不到檔案內容（R2 無此物件）");
        const r = await extractImageText(ai, new Uint8Array(await obj.arrayBuffer()));
        if (!r.ok) throw new Error(r.error);
        let text = r.text;
        // 跟單張 /ocr 同一套關聯判斷：照片落在哪一段錄音的區間，就拿那段逐字稿
        // 判斷「拍這張時在講什麼」
        if (att.offset_secs !== null && att.offset_secs !== undefined) {
          const { results: siblings } = await db.prepare(
            "SELECT * FROM attachments WHERE entry_id = ? AND kind = 'audio' AND offset_secs IS NOT NULL ORDER BY offset_secs ASC"
          ).bind(att.entry_id).all();
          let seg = null;
          for (const s of siblings) if (s.offset_secs <= att.offset_secs) seg = s;
          const transcript = seg ? (seg.transcript || "").trim() : "";
          if (transcript) {
            const relation = await judgeRelation(ai, transcript, text);
            if (relation && !relation.includes("看不出明顯關聯")) {
              text += `\n\n【對話關聯】${relation}（錄音 ${fmtSecs(att.offset_secs)} 時拍攝）`;
            }
          }
        }
        await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(text, now(), att.id).run();
        await autoRenameAttachment(db, att, text);
        await logHistory(db, att.entry_id, null, "批次照片擷取文字", `${att.filename}：${text.slice(0, 60) || "（照片上沒有文字）"}`);
        await triggerEmbedding(env, { kind: "attachment", id: att.id, entryId: att.entry_id, textContent: text });
        results.push({ attachment_id: att.id, filename: att.filename, success: true, message: `擷取文字成功，${text.length} 字` });
      } catch (err) {
        // 單張失敗不中斷整批。ocr_at 標成 failed 而不是還原成空字串：還原的話
        // 下次批次又會重跑同一張、再失敗一次，白白耗額度
        const message = friendlyAiError(err);
        await db.prepare("UPDATE attachments SET ocr_at = 'failed' WHERE id = ?").bind(att.id).run();
        await logHistory(db, att.entry_id, null, "批次照片擷取文字失敗", `${att.filename}：${message}`);
        results.push({ attachment_id: att.id, filename: att.filename, success: false, message });
      }
    }
    const remainingRow = folderId
      ? await db.prepare(
          `SELECT COUNT(*) AS n FROM attachments a JOIN entries e ON e.id = a.entry_id
           WHERE e.folder_id = ? AND a.kind = 'photo' AND COALESCE(a.ocr_at, '') = ''`
        ).bind(folderId).first()
      : await db.prepare(
          `SELECT COUNT(*) AS n FROM attachments WHERE entry_id = ? AND kind = 'photo' AND COALESCE(ocr_at, '') = ''`
        ).bind(entryId).first();
    return json({
      processed: results.length,
      results,
      remaining: Number(remainingRow?.n || 0),
      pending_audio_entry_ids: pendingAudioEntryIds,
    });
  }

  // ---------- 巡廠頁面（Jeremy 功能規格書）：截圖 OCR → LLM 整理 → 存檔 ----------
  // 存檔本身沿用既有的 POST /entries（body_format:"text"，保留巡廠紀錄的固定
  // 縮排／換行/『』符號不被富文字轉換動到）＋ POST /upload（把原始截圖當附件
  // 保留，方便日後追溯核對），不另外開端點；這裡只加「整理」流程真正新增的
  // 兩支：單張截圖 OCR（不需要先有 entry，存檔前只是預覽，可能整批放棄）、
  // 和把已 OCR 好的文字送給 Claude 整理成固定格式。
  const patrolOcrMatch = path === "/patrol/ocr" && method === "POST";
  if (patrolOcrMatch) {
    if (!env.AI) return bad("尚未啟用 Workers AI（見 fieldlog/README.md）", 501);
    const mime = request.headers.get("content-type") || "application/octet-stream";
    if (!mime.startsWith("image/")) return bad("只接受圖片");
    const body = await request.arrayBuffer();
    if (!body.byteLength) return bad("空檔案");
    if (body.byteLength > 50 * 1024 * 1024) return bad("檔案過大（上限 50MB）");
    try { await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }
    const ai = budgetedAi(env);
    const r = await extractImageText(ai, new Uint8Array(body));
    if (!r.ok) return bad(friendlyAiError(new Error(r.error)), 502);
    return json({ text: r.text });
  }

  if (path === "/patrol/format" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return bad("需要至少一張截圖的 OCR 文字");
    try {
      const formatted = await formatPatrolReport(env, items);
      return json({ formatted_text: formatted });
    } catch (err) {
      return bad(err.message, 502);
    }
  }

  if (path === "/patrol/folder" && method === "GET") {
    const folderId = await ensurePatrolFolder(db, now());
    return json({ folder_id: folderId });
  }

  const transcribeMatch = path.match(/^\/attachments\/(\d+)\/transcribe$/);
  if (transcribeMatch && method === "POST") {
    if (!env.AI) return bad("尚未啟用 Workers AI（見 fieldlog/README.md）", 501);
    const id = Number(transcribeMatch[1]);
    const old = await activeAttachment(db, id);
    if (!old) return bad("找不到附件", 404);
    if (old.kind !== "audio") return bad("只有錄音檔可以轉文字");
    try { await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }
    try {
      const text = await transcribeAttachment(env, db, old);
      return json({ text });
    } catch (err) {
      // 附件上的「手動重試」／「重抄」連結呼叫的就是這支端點，原本沒有接住
      // transcribeAttachment 的錯誤，會直接洩漏到最外層變成一句不知所云的
      // 「伺服器錯誤：500」，既不會標記這筆附件、也不會留下任何紀錄可查，
      // 使用者只會看到同一顆按鈕一直失敗、猜不出原因。
      const message = friendlyAiError(err);
      await db.prepare("UPDATE attachments SET transcribed_at = 'auto_failed' WHERE id = ?").bind(id).run();
      await logHistory(db, old.entry_id, null, "手動轉錄失敗", `${old.filename}：${message}`);
      return bad(message, 502);
    }
  }

  const autoTranscribeMatch = path.match(/^\/entries\/(\d+)\/auto-transcribe$/);
  if (autoTranscribeMatch && method === "POST") {
    if (!env.AI || !env.FILES) return bad("尚未啟用自動轉錄", 501);
    const entryId = Number(autoTranscribeMatch[1]);
    const { results: candidates } = await db.prepare(
      "SELECT * FROM attachments WHERE entry_id = ? AND kind = 'audio' AND COALESCE(transcript, '') = '' AND COALESCE(transcribed_at, '') = '' AND duration_secs > 0 ORDER BY offset_secs, id"
    ).bind(entryId).all();
    if (!candidates.length) return json({ processed: 0, reason: "沒有可安全自動轉錄的新錄音" });
    let usage;
    try { usage = await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }
    const today = new Date().toISOString().slice(0, 10);
    const aiLimit = usage.limits?.find((x) => x.key === "ai");
    const cloudUsed = aiLimit?.label.includes(today) ? aiLimit.used : 0;
    const reservedRow = await db.prepare("SELECT COALESCE(SUM(estimated_neurons), 0) AS total FROM ai_usage_reservations WHERE usage_date = ?").bind(today).first();
    let reserved = Number(reservedRow?.total || 0);
    let processed = 0;
    const transcripts = [];
    const failed = [];
    for (const audio of candidates) {
      const estimate = Math.ceil(Number(audio.duration_secs) / 60 * 46.63);
      // 門檻一律讀 AI_AUTO_SAFE_NEURONS，不要再寫死數字：上次把常數從 7000 調到
      // 10000 時只改了下面的訊息，這行的比較值卻留在 7000，變成畫面說「超過
      // 10,000」、實際上 7,000 就停——白白少用 30% 的免費額度，而且從訊息完全
      // 看不出來。訊息與實際門檻必須同一個來源。
      if (cloudUsed + reserved + estimate > AI_AUTO_SAFE_NEURONS) {
        return json({ processed, stopped: true, reason: `預估將超過安全門檻（${AI_AUTO_SAFE_NEURONS.toLocaleString()} Neurons）`, cloudUsed, reserved, transcripts });
      }
      const claim = await db.prepare(
        "INSERT OR IGNORE INTO ai_usage_reservations (attachment_id, usage_date, estimated_neurons, status, created_at) VALUES (?, ?, ?, 'reserved', ?)"
      ).bind(audio.id, today, estimate, now()).run();
      if (!claim.meta.changes) continue;
      const lock = await db.prepare("UPDATE attachments SET transcribed_at = 'processing' WHERE id = ? AND COALESCE(transcribed_at, '') = ''").bind(audio.id).run();
      if (!lock.meta.changes) continue;
      reserved += estimate;
      try {
        const text = await transcribeAttachment(env, db, audio);
        await db.prepare("UPDATE ai_usage_reservations SET status = 'completed' WHERE attachment_id = ?").bind(audio.id).run();
        transcripts.push({ attachmentId: audio.id, offsetSecs: Number(audio.offset_secs || 0), text });
        processed++;
      } catch (err) {
        // 只讓「這一段」失敗，不中斷整批：舊寫法一遇到單一段落轉錄出錯就整批
        // return，還把 stopped:true 一起回給前端。前端看到 stopped 會把
        // AUDIO.liveTranscriptionStopped 設成 true，永久關掉這次錄音剩下所有
        // 段落的即時轉錄——結果是一次偶發的轉錄錯誤（例如 Whisper 短暫故障），
        // 讓使用者往後每一段都卡在「⏳ 未整理」，看起來像「錄音完全壞掉」，
        // 其實只是這支端點把「單段失敗」跟「額度保護，該停下來」混為一談。
        // 兩者分開：額度保護還是提早 return＋stopped:true（上面那個 if），
        // 這裡單純繼續跑下一個候選段落。
        const message = friendlyAiError(err);
        await db.prepare("UPDATE attachments SET transcribed_at = 'auto_failed' WHERE id = ?").bind(audio.id).run();
        await db.prepare("UPDATE ai_usage_reservations SET status = 'failed' WHERE attachment_id = ?").bind(audio.id).run();
        await logHistory(db, entryId, null, "自動轉錄失敗", `${audio.filename}：${message}（不會自動重試，可在附件上手動重試）`);
        failed.push({ attachmentId: audio.id, reason: message });
      }
    }
    return json({ processed, stopped: false, cloudUsed, reserved, transcripts, failed });
  }

  // ---- 照片擷取文字（影像 skill，與 Medtec 共用同一份模組）----
  // 同一筆紀錄（entry）就是一段採集經驗：照片的 offset_secs 落在哪一段錄音
  // 的範圍，就拿那段的逐字稿判斷「拍這張時在講什麼」，附上關聯句
  const ocrMatch = path.match(/^\/attachments\/(\d+)\/ocr$/);
  if (ocrMatch && method === "POST") {
    if (!env.FILES) return bad("尚未啟用附件儲存（需 R2）", 501);
    const id = Number(ocrMatch[1]);
    const old = await activeAttachment(db, id);
    if (!old) return bad("找不到附件", 404);
    const isPdf = (old.mime || "") === "application/pdf" || old.filename.toLowerCase().endsWith(".pdf");
    // docx／xlsx／pptx／純文字：直接從檔案結構解出文字，不經過 AI——免費、瞬間、
    // 沒有 OCR 辨識誤差，也不用管 Neurons 額度或軟預算
    const nativeKind = !isPdf ? detectNativeTextKind(old.filename, old.mime) : null;
    if (old.kind !== "photo" && !isPdf && !nativeKind) return bad("只有照片、PDF、Word/Excel/PowerPoint（docx/xlsx/pptx）與純文字檔可以擷取文字");
    const obj = await env.FILES.get(old.key);
    if (!obj) return bad("找不到檔案內容", 404);
    if (nativeKind) {
      let text;
      try {
        text = await extractNativeText(nativeKind, new Uint8Array(await obj.arrayBuffer()));
      } catch (err) {
        // legacy-office（.doc/.xls/.ppt 舊格式）給的是操作指引，不是系統錯誤，用 400
        return bad(err.message, nativeKind === "legacy-office" ? 400 : 502);
      }
      await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(text, now(), id).run();
      await autoRenameAttachment(db, old, text);
      await logHistory(db, old.entry_id, null, "文件擷取文字", `${old.filename}：${text.slice(0, 60) || "（沒有擷取到文字）"}`);
      await triggerEmbedding(env, { kind: "attachment", id, entryId: old.entry_id, textContent: text });
      return json({ ocr_text: text });
    }
    if (!env.AI) return bad("尚未啟用圖片擷取文字（需 Workers AI）", 501);
    try { await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }
    if (isPdf) {
      // PDF（文獻、型錄、講義）走 Workers AI 的 toMarkdown 轉文字，內容才進得了搜尋跟 MCP
      const converted = await env.AI.toMarkdown([
        { name: old.filename, blob: new Blob([await obj.arrayBuffer()], { type: "application/pdf" }) },
      ]).catch((err) => { throw new Error(`PDF 轉文字失敗：${err.message}`); });
      // 剝掉 toMarkdown 開頭的檔案 metadata，只留本文；剝完可能是空（圖形型 PDF、
      // 無文字層）→ ocr_at 有時間戳但 ocr_text 空 → 顯示「已整理（沒有文字內容）」
      const pdfText = stripPdfMetadata(converted?.[0]?.data || "").slice(0, 60000);
      await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(pdfText, now(), id).run();
      await autoRenameAttachment(db, old, pdfText);
      await logHistory(db, old.entry_id, null, "PDF 擷取文字", `${old.filename}：${pdfText.slice(0, 60) || "（沒有擷取到文字，可能是圖形型 PDF）"}`);
      await triggerEmbedding(env, { kind: "attachment", id, entryId: old.entry_id, textContent: pdfText });
      return json({ ocr_text: pdfText });
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const ai = budgetedAi(env);
    const r = await extractImageText(ai, bytes);
    if (!r.ok) return bad(r.error, 502);
    let text = r.text;
    if (old.offset_secs !== null && old.offset_secs !== undefined) {
      // 找同一筆紀錄裡「起始秒數 ≤ 照片秒數」最近的那段錄音（分段錄音的起點都記在 offset_secs）
      const { results: siblings } = await db
        .prepare("SELECT * FROM attachments WHERE entry_id = ? AND kind = 'audio' AND offset_secs IS NOT NULL ORDER BY offset_secs ASC")
        .bind(old.entry_id)
        .all();
      let seg = null;
      for (const a of siblings) {
        if (a.offset_secs <= old.offset_secs) seg = a;
      }
      const transcript = seg ? (seg.transcript || "").trim() : "";
      if (transcript) {
        const relation = await judgeRelation(ai, transcript, text);
        if (relation && !relation.includes("看不出明顯關聯")) {
          text += `\n\n【對話關聯】${relation}（錄音 ${fmtSecs(old.offset_secs)} 時拍攝）`;
        }
      }
    }
    await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(text, now(), id).run();
    await autoRenameAttachment(db, old, text);
    await logHistory(db, old.entry_id, null, "照片擷取文字", `${old.filename}：${text.slice(0, 60) || "（照片上沒有文字）"}`);
    await triggerEmbedding(env, { kind: "attachment", id, entryId: old.entry_id, textContent: text });
    return json({ ocr_text: text });
  }

  // ---- 匯出：整個資料夾 → Markdown 原料包（給 AI 彙整用）----
  const exportMatch = path.match(/^\/export\/folder\/(\d+)$/);
  if (exportMatch && method === "GET") {
    const id = Number(exportMatch[1]);
    const folder = await db.prepare("SELECT * FROM folders WHERE id = ? AND COALESCE(deleted_at, '') = ''").bind(id).first();
    if (!folder) return bad("找不到資料夾", 404);
    const { results: entries } = await db.prepare(
      "SELECT * FROM entries WHERE folder_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY id"
    ).bind(id).all();
    const lines = [
      `# ${folder.name}（${folder.type}）`,
      ``,
      `> 隨身記事本原始資料匯出｜共 ${entries.length} 筆紀錄｜匯出於 ${now()}`,
      `> 這是現場採集的 raw data（速記、錄音轉文字、照片時間點），`,
      `> 請依內容彙整成一份結構清楚的報告。照片無法直接檢視，`,
      `> 但每張都標注了「錄音第幾分幾秒拍攝」，可對照轉錄文字判斷拍攝當下的語境。`,
      ``,
    ];
    for (const e of entries) {
      const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(e.id).all();
      lines.push(`---`, ``, `## ${e.title || "（未命名紀錄）"}`, ``, `建立：${e.created_at}${e.updated_at ? `｜更新：${e.updated_at}` : ""}`);
      const fields = JSON.parse(e.fields_json || "{}");
      const filled = Object.entries(fields).filter(([, v]) => v && String(v).trim());
      if (filled.length) {
        lines.push(``);
        for (const [k, v] of filled) lines.push(`- **${k}**：${v}`);
      }
      const bodyOut = e.body_format === "html" ? htmlToPlainText(e.body) : e.body;
      if (bodyOut) lines.push(``, bodyOut);
      const audios = atts.filter((a) => a.kind === "audio");
      const photos = atts.filter((a) => a.kind === "photo");
      const files = atts.filter((a) => a.kind === "file");
      if (audios.length) {
        lines.push(``, `### 錄音轉文字`);
        for (const a of audios) {
          const label = a.offset_secs !== null ? `（起於 ${fmtSecs(a.offset_secs)}）` : "";
          lines.push(``, `**${a.filename}**${label}`, a.transcript ? a.transcript : "（尚未轉文字）");
        }
      }
      if (photos.length) {
        lines.push(``, `### 照片（共 ${photos.length} 張）`);
        for (const a of photos) {
          const when = a.offset_secs !== null ? `錄音 ${fmtSecs(a.offset_secs)} 時拍攝` : a.created_at;
          lines.push(`- ${a.filename}｜${when}${a.category ? `｜分類：${a.category}` : ""}`);
          if (a.ocr_text) lines.push(`  - 照片內文字（AI 擷取）：${a.ocr_text.replace(/\n+/g, " ／ ")}`);
        }
      }
      if (files.length) {
        lines.push(``, `### 其他檔案`);
        for (const a of files) {
          lines.push(`- ${a.filename}（${(a.size / 1024 / 1024).toFixed(1)}MB）`);
          const fileText = stripPdfMetadata(a.ocr_text || ""); // 剝掉 PDF metadata 雜訊再匯出
          if (fileText) lines.push(`  - 檔案內容（AI 擷取）：${fileText.slice(0, 8000).replace(/\n+/g, " ／ ")}`);
        }
      }
      lines.push(``);
    }
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="fieldlog-folder-${id}.md"`,
      },
    });
  }

  return bad("不存在的 API 路徑", 404);
}

// App 殼：這幾個檔案幾乎每次部署都會變。Cloudflare Assets 預設的快取表頭
// 是為了長年不變的靜態檔案設計的，套在這幾個檔案上就會讓瀏覽器／CDN 快取住
// 舊版本——部署明明是最新的，使用者卻看到舊介面，而且沒有任何錯誤訊息。
// 要進到這裡強制蓋掉表頭，前提是 wrangler.jsonc 的 run_worker_first 要包含這些路徑
// （不然 Cloudflare Assets 會直接回應，Worker 根本不會執行）。
const NO_CACHE_SHELL_PATHS = new Set([
  "/", "/index.html", "/app.js", "/style.css",
  "/pdf-editor.js", "/home.css", "/sw.js", "/manifest.json",
  "/help.html",
]);

async function noStoreAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /wiki/* 是個人知識庫內容（wrangler run_worker_first 導進來的），
    // 與 API 同一套 PIN 驗證，通過才放行到靜態資產
    if (url.pathname.startsWith("/wiki/")) {
      const pin = (env.FIELD_PIN || "").trim();
      if (!pin) return bad("尚未設定 FIELD_PIN：請至 Worker Settings → Variables and Secrets 新增", 401);
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
      if (given !== pin) return bad("PIN 錯誤或未提供", 401);
      return env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin), request));
    }
    if (NO_CACHE_SHELL_PATHS.has(url.pathname)) {
      return noStoreAsset(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      // fail-closed：FIELD_PIN 未設定時全部拒絕
      const pin = (env.FIELD_PIN || "").trim();
      if (!pin) return bad("尚未設定 FIELD_PIN：請至 Worker Settings → Variables and Secrets 新增", 401);
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
      if (given !== pin) return bad("PIN 錯誤或未提供", 401);
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad(`伺服器錯誤：${err.message}`, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  // 每天自動同步 sources 表裡的外部來源（cron 排程見 wrangler.jsonc 的 triggers；
  // 0 18 * * * UTC＝台灣時間 02:00）。「記得手動跑同步」不是機制——沒人記得跑，
  // 資料就永遠停在最後一次手動的那天。錯誤處理在 syncSources 裡：單一來源失敗
  // 不中斷其他來源，結果一律記進 sync_log，事後用 MCP 的 sync_status 就查得到。
  async scheduled(_event, env) {
    await ensureSchema(env.DB, now());
    try {
      await syncSources(env.DB, {});
    } catch (err) {
      // 外部來源同步失敗不能阻止垃圾桶到期清理；兩件維護工作互不依賴。
      console.error(JSON.stringify({ event: "source_sync_failed", error: err.message }));
    }
    // 一次性的資料夾分類重整（2026-08-08）。自帶標記、只會真的套用一次，
    // 之後每天的排程呼叫都是立即返回的無事發生，跟上面的同步分開 try，
    // 不讓一次性遷移失敗連帶擋到當天的同步。
    try {
      await applyFolderReorg20260808(env.DB, now());
    } catch (err) {
      console.error("資料夾分類重整失敗", err);
    }
    try {
      const trash = await purgeExpiredTrash(env.DB, env.FILES, now(), env.VECTOR_INDEX);
      console.log(JSON.stringify({ event: "trash_purge_complete", ...trash }));
    } catch (err) {
      console.error(JSON.stringify({ event: "trash_purge_schedule_failed", error: err.message }));
    }
  },
};
