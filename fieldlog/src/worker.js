/**
 * 隨身助理記事本（fieldlog）— Cloudflare Worker API
 *
 * 定位：現場採集參展/拜訪/實驗/上課/會議/查廠的原始資料（錄音、照片、速記），
 * AI 事後彙整成報告送 Notion。本 Worker 只管 raw data 的存取：
 *   - folders：一個活動/工作項目＝一個資料夾（自帶欄位模板 type）
 *   - entries：一筆紀錄（folder_id 為空＝收件匣，之後再歸檔）
 *   - attachments：照片/錄音段/檔案（存 R2），offset_secs 記錄「錄音第幾秒拍的」
 *   - history：append-only 歷程
 *   - /api/export/folder/:id：整個資料夾匯出成一份 Markdown 原料包，貼給 AI 彙整
 *
 * 驗證：所有 /api/* 需帶 x-pin header（或 ?pin=），與 FIELD_PIN（Secret）比對。
 * FIELD_PIN 未設定時一律拒絕（fail-closed）。raw data 只增不刪。
 */

import { detectNativeTextKind, extractImageText, extractNativeText, judgeRelation, stripPdfMetadata } from "./imageSkill.js";

const SCHEMA = [
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
  `CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entry_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entry_id)`,
];

// 舊表補欄位用（D1 沒有 ADD COLUMN IF NOT EXISTS，欄位已存在時失敗直接忽略即可）
const MIGRATIONS = [
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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_att_entry_hash ON attachments(entry_id, content_hash) WHERE content_hash IS NOT NULL AND content_hash <> ''`,
];

const AI_DAILY_FREE_NEURONS = 10000;
const AI_AUTO_SAFE_NEURONS = 7000;
const AI_MONTHLY_SOFT_USD = 4.5;
const AI_MONTHLY_HARD_USD = 5;
const AI_RATE_PER_1000_NEURONS = 0.011;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    await db.prepare(sql).run().catch(() => {});
  }
  schemaReady = true;
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
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
    const findUsage = (family, name) => rows
      .filter((r) => family.test(r.family) && name.test(r.name))
      .reduce((sum, r) => sum + r.quantity, 0);
    const aiRows = rows.filter((r) => /workers ai/i.test(r.family) && /neuron/i.test(r.name));
    const latestAiDate = aiRows.map((r) => r.periodStart.slice(0, 10)).filter(Boolean).sort().at(-1) || "";
    const aiUsage = aiRows
      .filter((r) => !latestAiDate || r.periodStart.startsWith(latestAiDate))
      .reduce((sum, r) => sum + r.quantity, 0);
    const aiMonthlyPaidCost = aiRows.reduce((sum, r) => sum + r.cost, 0);
    const limits = [
      {
        key: "ai", label: `Workers AI Neurons${latestAiDate ? `（${latestAiDate}）` : ""}`,
        used: aiUsage, limit: AI_DAILY_FREE_NEURONS, safeLimit: AI_AUTO_SAFE_NEURONS,
        monthlyPaidCost: aiMonthlyPaidCost, softBudget: AI_MONTHLY_SOFT_USD,
        hardBudget: AI_MONTHLY_HARD_USD, paidRatePerThousand: AI_RATE_PER_1000_NEURONS,
        gatewayConfigured: !!env.AI_GATEWAY_ID, unit: "／日",
      },
      { key: "d1-read", label: "D1 讀取列數", used: findUsage(/^D1$/i, /Rows Read/i), limit: 25e9, unit: "／月" },
      { key: "d1-write", label: "D1 寫入列數", used: findUsage(/^D1$/i, /Rows Written/i), limit: 50e6, unit: "／月" },
      { key: "r2-a", label: "R2 Class A 操作", used: findUsage(/^R2$/i, /Class A/i), limit: 1e6, unit: "／月" },
      { key: "r2-b", label: "R2 Class B 操作", used: findUsage(/^R2$/i, /Class B/i), limit: 10e6, unit: "／月" },
      { key: "worker-requests", label: "Workers 請求", used: findUsage(/^Workers$/i, /Standard Requests/i), limit: 10e6, unit: "／月" },
      { key: "worker-cpu", label: "Workers CPU", used: findUsage(/^Workers$/i, /CPU ms/i), limit: 30e6, unit: "ms／月" },
      { key: "worker-build", label: "Worker 建置", used: findUsage(/^Workers$/i, /Build Minutes/i), limit: 6000, unit: "分鐘／月" },
    ].filter((item) => item.key === "ai" || item.used > 0);
    const totalCost = products.reduce((sum, p) => sum + p.cost, 0);
    return {
      source: endpoint.includes("billable") ? "billable" : "paygo",
      products,
      limits,
      totalCost,
      currency: products[0]?.currency || "USD",
      updatedAt: new Date().toISOString(),
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

async function transcribeAttachment(env, db, old) {
  const obj = await env.FILES.get(old.key);
  if (!obj) throw new Error("找不到檔案內容");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const result = await budgetedAi(env).run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(binary), task: "transcribe" });
  const text = (result?.text || "").trim();
  await db.prepare("UPDATE attachments SET transcript = ?, transcribed_at = ? WHERE id = ?").bind(text, now(), old.id).run();
  await autoRenameAttachment(db, old, text);
  await logHistory(db, old.entry_id, null, "錄音轉文字", `${old.filename}：${text.slice(0, 60) || "（無語音內容）"}`);
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
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (path === "/config" && method === "GET") {
    return json({ uploads: !!env.FILES, transcribe: !!(env.FILES && env.AI) });
  }
  if (path === "/usage" && method === "GET") {
    return json(await cloudflareUsage(env));
  }

  // ---- folders ----
  if (path === "/folders" && method === "GET") {
    const { results } = await db.prepare(
      `SELECT f.*,
        (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id) AS entry_count,
        (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS child_count
       FROM folders f ORDER BY f.status = '進行中' DESC, f.id DESC`
    ).all();
    return json(results);
  }
  if (path === "/folders" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    if (!name) return bad("name 為必填");
    const type = (body.type || "其他").trim();
    const parentId = body.parent_id ? Number(body.parent_id) : null;
    if (parentId && !await db.prepare("SELECT id FROM folders WHERE id = ?").bind(parentId).first()) return bad("找不到上層資料夾", 404);
    const r = await db.prepare("INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, type, parentId, now()).run();
    await logHistory(db, null, r.meta.last_row_id, "建立資料夾", `${name}（${type}）`);
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const folderMatch = path.match(/^\/folders\/(\d+)$/);
  if (folderMatch && method === "PUT") {
    const id = Number(folderMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到資料夾", 404);
    const name = body.name !== undefined ? (body.name || "").trim() : old.name;
    const status = body.status !== undefined ? (body.status || "").trim() : old.status;
    if (!name) return bad("name 不可為空");
    await db.prepare("UPDATE folders SET name = ?, status = ? WHERE id = ?").bind(name, status, id).run();
    await logHistory(db, null, id, "更新資料夾", `${name}／${status}`);
    return json({ ok: true });
  }
  if (folderMatch && method === "DELETE") {
    const id = Number(folderMatch[1]);
    const folder = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first();
    if (!folder) return bad("找不到資料夾", 404);
    const countRow = await db.prepare("SELECT COUNT(*) AS count FROM entries WHERE folder_id = ?").bind(id).first();
    const moved = Number(countRow?.count || 0);
    // 安全刪除分類：記事移到上層（最上層才回收件匣），子資料夾也上移一層。
    await db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?").bind(folder.parent_id || null, now(), id).run();
    await db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").bind(folder.parent_id || null, id).run();
    await db.prepare("DELETE FROM folders WHERE id = ?").bind(id).run();
    await logHistory(db, null, folder.parent_id || null, "刪除資料夾", `${folder.name}；${moved} 筆記事移至${folder.parent_id ? "上層" : "收件匣"}`);
    return json({ ok: true, moved });
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
    const countRow = await db.prepare("SELECT COUNT(*) AS count FROM entries WHERE folder_id = ?").bind(sourceId).first();
    const moved = Number(countRow?.count || 0);
    await db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE folder_id = ?").bind(targetId, now(), sourceId).run();
    await db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").bind(source.parent_id || null, sourceId).run();
    await db.prepare("DELETE FROM folders WHERE id = ?").bind(sourceId).run();
    await logHistory(db, null, targetId, "合併資料夾", `${source.name} → ${target.name}；移動 ${moved} 筆記事`);
    return json({ ok: true, moved, target_id: targetId });
  }

  // ---- entries ----
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
       ORDER BY e.id DESC LIMIT 20`
    ).bind(like, like, excludeId).all();
    return json(results);
  }
  if (path === "/entries" && method === "GET") {
    const folderId = url.searchParams.get("folder_id");
    const inbox = url.searchParams.get("inbox");
    let q;
    if (inbox) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id IS NULL ORDER BY e.id DESC`
      );
    } else if (folderId) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id = ? ORDER BY e.id DESC`
      ).bind(Number(folderId));
    } else {
      return bad("需指定 folder_id 或 inbox=1");
    }
    const { results } = await q.all();
    return json(results);
  }
  if (path === "/entries" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const folderId = body.folder_id ? Number(body.folder_id) : null;
    const r = await db.prepare(
      "INSERT INTO entries (folder_id, title, fields_json, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(folderId, (body.title || "").trim(), JSON.stringify(body.fields || {}), (body.body || "").trim(), now()).run();
    await logHistory(db, r.meta.last_row_id, folderId, "新增紀錄", body.title || "");
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const entryMatch = path.match(/^\/entries\/(\d+)$/);
  if (entryMatch && method === "GET") {
    const id = Number(entryMatch[1]);
    const entry = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!entry) return bad("找不到紀錄", 404);
    const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(id).all();
    return json({ ...entry, attachments: atts });
  }
  if (entryMatch && method === "PUT") {
    const id = Number(entryMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const title = body.title !== undefined ? (body.title || "").trim() : old.title;
    const bodyText = body.body !== undefined ? (body.body || "").trim() : old.body;
    const fields = body.fields !== undefined ? JSON.stringify(body.fields) : old.fields_json;
    const folderId = body.folder_id !== undefined ? (body.folder_id ? Number(body.folder_id) : null) : old.folder_id;
    await db.prepare("UPDATE entries SET title = ?, body = ?, fields_json = ?, folder_id = ?, updated_at = ? WHERE id = ?")
      .bind(title, bodyText, fields, folderId, now(), id).run();
    if (body.folder_id !== undefined && folderId !== old.folder_id) {
      await logHistory(db, id, folderId, "歸檔", title);
    } else {
      await logHistory(db, id, folderId, "更新紀錄", title);
    }
    return json({ ok: true });
  }
  if (entryMatch && method === "DELETE") {
    const id = Number(entryMatch[1]);
    const old = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ?").bind(id).all();
    if (env.FILES) {
      for (const a of atts) await env.FILES.delete(a.key).catch(() => {});
    }
    await db.prepare("DELETE FROM attachments WHERE entry_id = ?").bind(id).run();
    await db.prepare("DELETE FROM relations WHERE from_entry_id = ? OR to_entry_id = ?").bind(id, id).run();
    await db.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
    await logHistory(db, null, old.folder_id, "刪除紀錄", old.title);
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
       WHERE r.from_entry_id = ? OR r.to_entry_id = ?
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
      db.prepare("SELECT id FROM entries WHERE id = ?").bind(fromId).first(),
      db.prepare("SELECT id FROM entries WHERE id = ?").bind(toId).first(),
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
    const entry = await db.prepare("SELECT folder_id FROM entries WHERE id = ?").bind(entryId).first();
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
      "INSERT INTO attachments (entry_id, kind, filename, original_filename, key, size, mime, offset_secs, source_pdf_id, page_no, duration_secs, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(entryId, kind, filename, filename, key, body.byteLength, mime, offsetSecs, sourcePdfId, pageNo, durationSecs, contentHash, now()).run();
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
    const obj = await env.FILES.get(decodeURIComponent(fileMatch[1]));
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
    return json({ ok: true, checked: (results || []).length, renamed, duplicates_removed: duplicatesRemoved });
  }
  const attMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attMatch && method === "PUT") {
    const id = Number(attMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (body.ocr_text !== undefined) {
      const ocrText = (body.ocr_text || "").trim();
      await db.prepare("UPDATE attachments SET ocr_text = ? WHERE id = ?").bind(ocrText, id).run();
      await logHistory(db, old.entry_id, null, "編輯擷取文字", `${old.filename}：「${ocrText.slice(0, 80)}」`);
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
    const category = (body.category !== undefined ? body.category : old.category) || "";
    await db.prepare("UPDATE attachments SET category = ? WHERE id = ?").bind(category.trim(), id).run();
    return json({ ok: true });
  }
  if (attMatch && method === "DELETE") {
    const id = Number(attMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (env.FILES) await env.FILES.delete(old.key);
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
    await logHistory(db, old.entry_id, null, "刪除附件", old.filename);
    return json({ ok: true });
  }

  // ---- 錄音轉文字（Workers AI Whisper）----
  const transcribeMatch = path.match(/^\/attachments\/(\d+)\/transcribe$/);
  if (transcribeMatch && method === "POST") {
    if (!env.AI) return bad("尚未啟用 Workers AI（見 fieldlog/README.md）", 501);
    const id = Number(transcribeMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (old.kind !== "audio") return bad("只有錄音檔可以轉文字");
    try { await enforceAiSoftBudget(env); }
    catch (err) { return bad(err.message, err.code === "AI_BUDGET_REACHED" ? 429 : 503); }
    const text = await transcribeAttachment(env, db, old);
    return json({ text });
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
    for (const audio of candidates) {
      const estimate = Math.ceil(Number(audio.duration_secs) / 60 * 46.63);
      if (cloudUsed + reserved + estimate > 7000) {
        return json({ processed, stopped: true, reason: "預估將超過 70% 安全門檻", cloudUsed, reserved, transcripts });
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
        await db.prepare("UPDATE attachments SET transcribed_at = 'auto_failed' WHERE id = ?").bind(audio.id).run();
        await db.prepare("UPDATE ai_usage_reservations SET status = 'failed' WHERE attachment_id = ?").bind(audio.id).run();
        return json({ processed, stopped: true, reason: `自動轉錄失敗，未自動重試：${err.message}`, transcripts });
      }
    }
    return json({ processed, stopped: false, cloudUsed, reserved, transcripts });
  }

  // ---- 照片擷取文字（影像 skill，與 Medtec 共用同一份模組）----
  // 同一筆紀錄（entry）就是一段採集經驗：照片的 offset_secs 落在哪一段錄音
  // 的範圍，就拿那段的逐字稿判斷「拍這張時在講什麼」，附上關聯句
  const ocrMatch = path.match(/^\/attachments\/(\d+)\/ocr$/);
  if (ocrMatch && method === "POST") {
    if (!env.FILES) return bad("尚未啟用附件儲存（需 R2）", 501);
    const id = Number(ocrMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
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
    return json({ ocr_text: text });
  }

  // ---- 匯出：整個資料夾 → Markdown 原料包（給 AI 彙整用）----
  const exportMatch = path.match(/^\/export\/folder\/(\d+)$/);
  if (exportMatch && method === "GET") {
    const id = Number(exportMatch[1]);
    const folder = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first();
    if (!folder) return bad("找不到資料夾", 404);
    const { results: entries } = await db.prepare("SELECT * FROM entries WHERE folder_id = ? ORDER BY id").bind(id).all();
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
      if (e.body) lines.push(``, e.body);
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
};
