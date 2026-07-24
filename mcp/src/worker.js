/**
 * medapi-mcp — 跨系統唯讀問答層（MCP Server，Streamable HTTP）
 *
 * 定位：讓 claude.ai／Claude Code 當「窗口」，用自然語言跨三個來源問答：
 *   - 策略地圖 Wiki（fieldlog Worker 的 /wiki/*，PIN 通道 runtime 抓取）
 *   - 隨身記 fieldlog（共綁同一個 D1，只下 SELECT）
 *   - Medtec 參展系統（共綁同一個 D1 ＋ runtime 抓公開的 exhibitors.json）
 *
 * 鐵律：這個 Worker 對三個來源一律唯讀——程式碼裡只有 SELECT 與 fetch，
 * 不寫入、不刪除。要改資料請回各自的前台，wiki 收錄一律走 git 人審。
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

import { foldText, foldSnippet, stripPdfMetadata } from "./textFold.js";

const PROTOCOL_DEFAULT = "2025-03-26";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

// 全 JS 端摺疊比對可掃描的資料列上限——現階段資料量遠低於此，設個天花板純粹
// 避免未來資料爆量時把 Worker 記憶體撐爆（超出時只掃最新這麼多列）
const SCAN_CAP = 5000;

// ---------- 小工具 ----------

// claude.ai 的自訂連接器是瀏覽器直接呼叫，跨網域一定會先送 CORS 預檢（OPTIONS），
// 沒有這組 header 瀏覽器會直接擋下真正的 POST，連 initialize 都打不到
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-pin, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
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

// 摺疊後比對：庫內文字與查詢字都轉成同一種簡繁/全半形形式再判斷是否包含。
// 這是簡繁互通的核心——繁體查得到簡體庫、反之亦然。
function foldIncludes(text, foldedQuery) {
  return foldText(text).includes(foldedQuery);
}

function needQuery(args) {
  const q = (args.query || "").trim();
  if (!q) throw new Error("query 為必填");
  return q;
}

function capLimit(args, dflt = 10, max = 30) {
  const n = Number(args.limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
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
  if (!res.ok) throw new Error(`讀取 wiki 頁面清單失敗（HTTP ${res.status}）——檢查 FIELD_PIN 是否與 fieldlog 一致`);
  const data = await res.json();
  return data.pages || [];
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
    description: "以關鍵字全文搜尋所有 Wiki 條目，回傳每頁的命中行。簡繁通用（繁體查得到簡體、反之亦然）。適合「哪個條目講過 XX」這類跨頁定位。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "關鍵字" } },
      required: ["query"],
    },
    async handler(env, args) {
      const q = needQuery(args);
      const fq = foldText(q);
      const pages = await wikiPages(env);
      const results = await Promise.all(
        pages.map(async (p) => {
          const res = await wikiFetch(env, p.file);
          if (!res.ok) return null;
          const text = await res.text();
          const hits = [];
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < 4; i++) {
            if (foldIncludes(lines[i], fq)) {
              hits.push(`  - L${i + 1}：${clip(lines[i], 160)}`);
            }
          }
          return hits.length ? `## ${p.title}（${p.file}）\n${hits.join("\n")}` : null;
        })
      );
      const found = results.filter(Boolean);
      return found.length ? found.join("\n\n") : `所有 Wiki 條目都沒有「${q}」。`;
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
    name: "search_fieldlog",
    description: "以關鍵字搜尋隨身記：紀錄的標題／內文／欄位，以及附件的檔名／錄音逐字稿／照片與 PDF 擷取文字。簡繁通用（繁體查得到簡體、反之亦然）。可選 folder_id／folder_type 縮小到特定資料夾（例如專門歸檔標準規範、型錄的資料夾——先用 list_fieldlog_folders 查 id）。回傳命中片段與 entry/attachment id；附件命中後用 get_fieldlog_attachment 拉該附件完整未截斷的全文（例如查一份 ISO 標準的完整條文，不是只看片段）。找到 entry 後想看它跟哪些標準／實驗／廠商／專利有交叉關聯，改用 get_related(id)。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字，簡繁不拘（例：ISO 7886-1、抗結痂）" },
        limit: { type: "number", description: "每類最多回傳幾筆（預設 10，上限 30）" },
        folder_id: { type: "number", description: "選填：只搜這個資料夾與其子資料夾（先用 list_fieldlog_folders 查 id）" },
        folder_type: { type: "string", description: "選填：只搜這個類型的資料夾（例：參展、拜訪、實驗、上課、會議、查廠、其他）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const q = needQuery(args);
      const fq = foldText(q);
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
      // 掃描上限 SCAN_CAP 純為記憶體保險；現階段資料量遠低於此。
      const [{ results: allEntries }, { results: allAtts }] = await Promise.all([
        env.DB_FIELDLOG.prepare(
          `SELECT e.id, e.folder_id, e.title, e.body, e.fields_json, e.created_at, f.name AS folder_name, f.type AS folder_type
           FROM entries e LEFT JOIN folders f ON e.folder_id = f.id
           ORDER BY e.id DESC LIMIT ${SCAN_CAP}`
        ).all(),
        env.DB_FIELDLOG.prepare(
          `SELECT a.id AS att_id, a.kind, a.filename, a.transcript, a.ocr_text, a.offset_secs,
                  e.id AS entry_id, e.folder_id, e.title, f.name AS folder_name, f.type AS folder_type
           FROM attachments a JOIN entries e ON a.entry_id = e.id LEFT JOIN folders f ON e.folder_id = f.id
           ORDER BY a.id DESC LIMIT ${SCAN_CAP}`
        ).all(),
      ]);
      const inScope = (row) =>
        (!wantFolderType || row.folder_type === wantFolderType) &&
        (allowedFolderIds === null || allowedFolderIds.has(row.folder_id));
      const entries = allEntries
        .filter(inScope)
        .filter((e) => foldIncludes(`${e.title}\n${e.body}\n${e.fields_json}`, fq))
        .slice(0, limit);
      for (const a of allAtts) a._ocr = stripPdfMetadata(a.ocr_text || ""); // 即時剝 PDF metadata
      const atts = allAtts
        .filter(inScope)
        .filter((a) => foldIncludes(`${a.transcript}\n${a._ocr}\n${a.filename}`, fq))
        .slice(0, limit);
      const out = [];
      if (entries.length) {
        out.push("## 命中的紀錄");
        for (const e of entries) {
          const where = e.folder_name ? `${e.folder_type}｜${e.folder_name}` : "收件匣";
          const hitText = [e.title, e.body, e.fields_json].find((t) => foldIncludes(t || "", fq)) || e.body;
          out.push(`- [entry ${e.id}] ${e.title || "（未命名）"}｜${where}｜${e.created_at}\n  ${foldSnippet(hitText, fq)}`);
        }
      }
      if (atts.length) {
        out.push("## 命中的附件（檔名／逐字稿／擷取文字，想看完整全文用 get_fieldlog_attachment(id)）");
        for (const a of atts) {
          const src = a.transcript && foldIncludes(a.transcript, fq) ? a.transcript : a._ocr || a.filename;
          const off = a.offset_secs !== null && a.offset_secs !== undefined ? `｜錄音 ${fmtSecs(a.offset_secs)}` : "";
          out.push(`- [attachment ${a.att_id}／entry ${a.entry_id}] ${a.kind}｜${a.filename}${off}｜所屬紀錄：${a.title || "（未命名）"}\n  ${foldSnippet(src, fq)}`);
        }
      }
      if (!out.length) {
        const scopeNote = (wantFolderType || wantFolderId !== null) ? "（在指定的資料夾範圍內；範圍設定得太窄的話試試拿掉 folder_id/folder_type 全庫查）" : "";
        return `隨身記裡沒有「${q}」的相關內容${scopeNote}（簡繁已互通）。`;
      }
      return out.join("\n");
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
      const fields = Object.entries(JSON.parse(e.fields_json || "{}")).filter(([, v]) => v && String(v).trim());
      for (const [k, v] of fields) lines.push(`- **${k}**：${v}`);
      if (e.body) lines.push("", e.body);
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
    description: "讀取隨身記單一附件的『完整、未截斷』文字內容（逐字稿或擷取文字），PDF 已自動剝除檔案 metadata 雜訊。用途：search_fieldlog 或 get_fieldlog_entry 找到候選附件、內容被截斷時，用這個拉出完整全文——例如查一份 ISO/ASTM 標準 PDF 的完整條文、或一段完整的會議逐字稿，不是只看片段摘要。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "attachment id（search_fieldlog 回傳的 attachment id，或 get_fieldlog_entry 附件標題旁的 [id]）" } },
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
      if (a.transcript) lines.push("", "## 逐字稿（完整）", a.transcript);
      if (ocrBody) lines.push("", "## 擷取文字（完整）", ocrBody);
      if (!a.transcript && !ocrBody) lines.push("", "（這個附件還沒轉文字/擷取，或該檔案本身沒有可擷取的文字內容——PDF 若是圖形排版、沒有文字層，一般擷取抓不到，需要 Tier 2 深度處理）");
      return lines.join("\n");
    },
  },
  {
    name: "get_related",
    description: "查詢隨身記裡『這筆記事跟哪些其他記事有關聯』（雙向），例如一份 ISO 標準被哪些實驗引用、一家廠商對照哪些專利、一次查廠關聯到哪次拜訪。這是交叉比對用的，不是關鍵字搜尋——關聯要先在隨身記前端手動建立（🔗 新增關聯）才查得到，不是系統自動猜出來的。找不到關聯不代表沒關係，可能只是還沒手動連過。",
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
    name: "search_exhibitors",
    description: "以關鍵字搜尋 Medtec China 2026 的 585 家展商（名稱／攤位／國家／產品／簡介／分類），並附上團隊共筆狀態（拜訪狀態、指派、部門標籤、紀錄數）。簡繁通用（繁體查得到簡體、反之亦然）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字（例：親水塗層、TPU、擠出）。簡繁不拘。" },
        limit: { type: "number", description: "最多回傳幾家（預設 10，上限 30）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const fq = foldText(needQuery(args));
      const limit = capLimit(args);
      const data = await exhibitorsData(env);
      const hits = (data.exhibitors || []).filter((ex) => {
        const hay = [
          ex.name_zh, ex.name_en, ex.booth_no, ex.country, ex.description,
          categoryName(data, ex.category), ...(ex.products || []), ...(ex.tags || []),
        ].join("\n");
        return foldIncludes(hay, fq);
      });
      if (!hits.length) return `展商名單裡沒有符合「${args.query}」的廠商。`;
      const top = hits.slice(0, limit);
      const { states, noteCounts } = await medtecStates(env, top.map((h) => h.id));
      const body = top.map((ex) => fmtExhibitor(data, ex, states.get(ex.id), noteCounts.get(ex.id))).join("\n\n");
      const more = hits.length > top.length ? `\n\n（共 ${hits.length} 家符合，只列前 ${top.length} 家——關鍵字再收斂一點可以更準）` : "";
      return body + more;
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
      const q = needQuery(args);
      const fq = foldText(q);
      const limit = capLimit(args);
      const { results: all } = await env.DB_MEDTEC.prepare(
        `SELECT * FROM notes WHERE deleted = 0 ORDER BY id DESC LIMIT ${SCAN_CAP}`
      ).all();
      const results = all.filter((n) => foldIncludes(n.content || "", fq)).slice(0, limit);
      if (!results.length) return `拜訪紀錄裡沒有「${q}」（簡繁已互通）。`;
      let nameOf = (id) => id;
      try {
        const data = await exhibitorsData(env);
        const map = new Map((data.exhibitors || []).map((x) => [x.id, x.name_zh || x.name_en]));
        nameOf = (id) => map.get(id) || id;
      } catch { /* 展商主檔抓不到時退回顯示 id */ }
      return results
        .map((n) => `- ${n.created_at}｜${nameOf(n.exhibitor_id)}（${n.exhibitor_id}）｜${n.author}｜${n.type}\n  ${foldSnippet(n.content, fq)}`)
        .join("\n");
    },
  },
  {
    name: "search_exhibitor_files",
    description: "以關鍵字搜尋參展系統『附件內容』全文：現場錄音逐字稿、照片/PDF 擷取文字、檔名、說明。簡繁通用（繁體查得到簡體、反之亦然——廠商型錄多為簡體）。展商的型錄內容、現場對話都在這裡——問「某家廠商的塗層方案細節」這類問題時用這個。回傳命中片段與所屬展商。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵字（例：親水塗層、PTFE、肝素）。簡繁不拘。" },
        limit: { type: "number", description: "最多回傳幾筆（預設 10，上限 30）" },
      },
      required: ["query"],
    },
    async handler(env, args) {
      const q = needQuery(args);
      const fq = foldText(q);
      const limit = capLimit(args);
      const { results: all } = await env.DB_MEDTEC.prepare(
        `SELECT id, exhibitor_id, filename, caption, author, created_at, transcript, ocr_text
         FROM attachments ORDER BY id DESC LIMIT ${SCAN_CAP}`
      ).all();
      // 即時剝掉 PDF metadata（現有髒資料不必重跑就乾淨）；檔名保留可搜
      for (const a of all) a._ocr = stripPdfMetadata(a.ocr_text || "");
      const results = all
        .filter((a) => foldIncludes(`${a.transcript}\n${a._ocr}\n${a.filename}\n${a.caption}`, fq))
        .slice(0, limit);
      if (!results.length) return `附件內容裡沒有「${q}」（簡繁已互通；提醒：附件要先在前台跑過「Cloudflare AI 整理」才有可搜尋的文字）。`;
      let nameOf = (id) => id;
      try {
        const data = await exhibitorsData(env);
        const map = new Map((data.exhibitors || []).map((x) => [x.id, x.name_zh || x.name_en]));
        nameOf = (id) => map.get(id) || id;
      } catch { /* 展商主檔抓不到時退回顯示 id */ }
      return results
        .map((a) => {
          const src = foldIncludes(a.transcript || "", fq) ? a.transcript
            : foldIncludes(a._ocr, fq) ? a._ocr
            : a._ocr || a.transcript || a.caption || a.filename;
          return `- ${nameOf(a.exhibitor_id)}（${a.exhibitor_id}）｜${a.filename}｜${a.author}｜${a.created_at}\n  ${foldSnippet(src, fq)}`;
        })
        .join("\n");
    },
  },
];

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
        "長儒的個人知識層唯讀窗口：策略地圖 Wiki（披膜技術條目）、隨身記（現場採集：逐字稿／照片文字）、Medtec 2026 展商與團隊拜訪紀錄。全部唯讀；要改資料請走各系統前台，wiki 收錄走 git 人審。",
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
      const text = await tool.handler(env, params?.arguments || {});
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (err) {
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
      if (!pin) return json({ error: "尚未設定 MCP_PIN：請至 Worker Settings → Variables and Secrets 新增" }, 401);
      const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || bearer).trim();
      if (given !== pin) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        return await handleMcp(request, env);
      } catch (err) {
        return rpcError(null, -32603, `伺服器錯誤：${err.message}`);
      }
    }
    if (url.pathname === "/") {
      // 部署健康檢查用；不透露任何資料
      return new Response("medapi-mcp OK — MCP 端點在 POST /mcp（需 ?pin=）\n", {
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
      });
    }
    // 其餘路徑一律 404——尤其是 /.well-known/oauth-*：這個 MCP 只用 PIN，
    // 不做 OAuth，若這裡誤回 200 會讓 claude.ai 誤判成「這台支援 OAuth」
    // 進而嘗試動態註冊、失敗跳出「無法向登入服務註冊」的錯誤
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
