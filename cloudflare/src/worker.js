/**
 * Medtec China 2026 展商導覽（邦特團隊版）— Cloudflare Worker API
 *
 * 靜態前端由 assets（public/）供應，本 Worker 只處理 /api/*：
 *   - 團隊成員（members）
 *   - 展商共筆狀態（exhibitor_state：拜訪狀態、負責人、部門標籤、索取資料、口袋名單）
 *   - 留言/紀錄（notes，保留修改歷程）
 *   - 修改歷程（history，追加不刪）
 *   - CSV 匯出
 *
 * 驗證：所有 /api/* 需帶 x-team-pin header，與 TEAM_PIN（secret）比對。
 * TEAM_PIN 未設定時一律拒絕（fail-closed）。
 */

import { detectNativeTextKind, extractImageText, extractNativeText, judgeRelation, stripPdfMetadata } from "./imageSkill.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    dept TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exhibitor_state (
    exhibitor_id TEXT PRIMARY KEY,
    status TEXT DEFAULT '未排定',
    assignee TEXT DEFAULT '',
    dept_tags TEXT DEFAULT '[]',
    collected TEXT DEFAULT '[]',
    goal_tags TEXT DEFAULT '[]',
    quals TEXT DEFAULT '[]',
    post_class TEXT DEFAULT '',
    pocket INTEGER DEFAULT 0,
    updated_by TEXT DEFAULT '',
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT NOT NULL,
    author TEXT NOT NULL,
    type TEXT DEFAULT '現場紀錄',
    content TEXT NOT NULL,
    deleted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT,
    author TEXT,
    action TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT NOT NULL,
    author TEXT NOT NULL,
    filename TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS line_recipients (
    user_id TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
  )`,
  // 官方展商目錄以外、團隊自己想追蹤的廠商（例如評估中的 CDMO 候選，根本
  // 沒有參展）。2026-08-10 長儒指出：官方名冊要靠重新爬網站才能更新，
  // 團隊不可能為了追蹤幾家沒參展的廠商就一直要求重新匯入整份名冊。這張表
  // 讓任何人直接在 App 裡新增，id 前綴跟官方的 ex-XXXX 分開避免撞號，
  // 其餘欄位刻意跟 exhibitors.json 的形狀一致，才能原封不動併進同一個
  // EXHIBITORS 陣列，指派／筆記／PDF 報告全部沿用既有邏輯不用另外處理。
  `CREATE TABLE IF NOT EXISTS custom_exhibitors (
    id TEXT PRIMARY KEY,
    name_zh TEXT DEFAULT '',
    name_en TEXT DEFAULT '',
    booth_no TEXT DEFAULT '',
    country TEXT DEFAULT '',
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    website TEXT DEFAULT '',
    added_by TEXT DEFAULT '',
    deleted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  // 論壇議程（官網研討會場次，跟展商無關的獨立實體，見 REPORT.md 分析）：
  // 場次基本資料＋團隊共筆（負責人／狀態／必問／技術鏈），欄位命名比照 exhibitor_state
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    date TEXT DEFAULT '',
    time_slot TEXT DEFAULT '',
    hall TEXT DEFAULT '',
    room TEXT DEFAULT '',
    title TEXT NOT NULL,
    track TEXT DEFAULT '',
    priority INTEGER,
    reason TEXT DEFAULT '',
    outline TEXT DEFAULT '',
    must_ask TEXT DEFAULT '[]',
    speaker TEXT DEFAULT '',
    institution TEXT DEFAULT '',
    need_precontact INTEGER DEFAULT 0,
    related_exhibitor_ids TEXT DEFAULT '[]',
    owner TEXT DEFAULT '',
    status TEXT DEFAULT '未排定',
    source_url TEXT DEFAULT '',
    updated_by TEXT DEFAULT '',
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    author TEXT NOT NULL,
    type TEXT DEFAULT '現場紀錄',
    content TEXT NOT NULL,
    deleted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  // 參訪前報告：每位同事一欄自由文字（出發前補充自己的關注重點）。
  // 一人一列、以名字為主鍵，覆寫式更新；改動走 history 留痕，跟展商共筆一致。
  `CREATE TABLE IF NOT EXISTS prep_notes (
    member TEXT PRIMARY KEY,
    content TEXT DEFAULT '',
    updated_by TEXT DEFAULT '',
    updated_at TEXT
  )`,
  // 四階段圖卡的人工覆寫：只保存與自動分析不同的欄位，保留來源資料即時重算能力。
  // content 是 JSON（map／demands／landing 陣列與 vendors 對應文字），一人一列。
  `CREATE TABLE IF NOT EXISTS prep_overrides (
    member TEXT PRIMARY KEY,
    content TEXT DEFAULT '{}',
    updated_by TEXT DEFAULT '',
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_att_ex ON attachments(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_ex ON notes(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hist_ex ON history(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sess_notes_sess ON session_notes(session_id)`,
];

// 種子資料：Medtec China 2026 官網「優先論壇與場次」表（見 REPORT.md 二、三節）。
// outline（內容大綱）取自 REPORT.md「二、七條可與邦特連結的機會」對應優先專案的
// 邦特連結／官網訊號／專案目標，只看場次標題看不出內容，補進這段脈絡。
// 用 INSERT OR IGNORE，已存在（id 相同）就跳過，不會覆蓋團隊之後編輯的內容；
// outline 另外用 UPDATE 補到既有資料列（見下方 ensureSchema），因為這欄是後補的。
const SESSION_SEED = [
  ["f1", "9/1", "N2", "會議室 A", "材料創新／創新醫療材料／零件", "材料", 1,
    "抗菌、抗發炎、改質塑膠與植入材料",
    "對應優先機會①長期植入 TPU／矽膠導管＋功能塗層。邦特連結：TPU 體內導管、血管通路、透析、泌尿與經皮引流，官方亦提到長期植入矽膠與 TPU 導管開發。官網訊號：抗菌／抗發炎材料、改質塑膠、ePTFE、ISO 10993、電漿功能塗層。專案目標：建立「材料 × 滅菌 × 塗層」相容性矩陣，選出 1–2 組可進樣品測試的組合。",
    "https://en.medtecchina.com/forum/material/material-1/"],
  ["f2", "9/2", "N2", "會議室 A", "高分子材料創新應用", "材料", 2,
    "ePTFE、醫材材料安全與全球法規",
    "延續材料主題，聚焦 ePTFE 與醫材材料安全、全球法規，跟優先機會①（材料×滅菌×塗層矩陣）同一批人適合一起聽；材料安全數據能否直接沿用到優先機會⑤（美歐中多市場證據包）也在這場一併確認。",
    "https://en.medtecchina.com/forum/material/material-2/"],
  ["f3", "9/2", "N3", "會議室 B", "醫療接合與焊接先進技術", "製程與製造", 3,
    "導管接合、UV 膠、疲勞與品質控制",
    "對應優先機會②導管接合、焊接與精密點膠平台。邦特連結：血液迴路管、IV 延長管、球囊、導管組裝與醫療零件。官網訊號：聚合物焊接疲勞、低毒 UV 膠、難黏材料、精密焊接品質控制與精密點膠。專案目標：完成接合製程比較與一個小型 DOE，鎖定可降低漏氣、脫離風險的方案。",
    "https://en.medtecchina.com/forum/process-manufacturing/process-manufacturing-3/"],
  ["f4", "9/1", "N4", "會議室 D", "Pack & Ster Hub", "製程與製造", 4,
    "滅菌製程、屏障包裝、PPWR、低溫電漿",
    "對應優先機會④包裝與滅菌相容性工程。邦特連結：血液迴路、呼吸、透析、引流與泌尿等無菌耗材。官網訊號：滅菌製程控制、無菌屏障、PPWR、低溫過氧化氫電漿。專案目標：完成材料、接合、塗層、包材對滅菌方式的變更評估清單，避免新品最後階段才發現不相容。",
    "https://en.medtecchina.com/forum/process-manufacturing/process-manufacturing-2/"],
  ["f5", "9/2", "N4", "會議室 E", "產品合規與上市實務", "品質與法規", 5,
    "FDA、MDR、ISO 10993、UDI、微粒與多市場註冊",
    "對應優先機會⑤多市場法規共用證據包。邦特連結：官方指出產品具 CE、製造體系符合 ISO 13485、FDA GMP／QSR，也發展 CDMO。官網訊號：FDA 更新、EU MDR 2026、ISO 10993、UDI、微粒、CRDMO／CTDMO 風險管理與多市場註冊。專案目標：建立美歐中三市場共用證據索引，先套用到 1 個 2026–2028 優先產品。",
    "https://en.medtecchina.com/forum/quality-regulatory/quality-regulatory-1/"],
  ["f6", "9/1", "N4", "會議室 D", "高階醫材數位製造", "製程與製造", 6,
    "自動化、數位生產與智慧工廠",
    "對應優先機會③自動化組裝＋CCD／3D 視覺＋全程追溯。邦特連結：高量醫療耗材、宜蘭新廠與 CDMO，官方提到導入智慧化與自動化系統。官網訊號：精實數位生產、醫材自動化、智慧工廠、UDI 與完整追溯。專案目標：選 1 個高人工、高檢驗成本站做自動化 PoC，讓量測結果可回寫批次履歷。",
    "https://en.medtecchina.com/forum/process-manufacturing/process-manufacturing-1/"],
  ["f7", "9/2", "N2", "會議室 A", "植入與介入醫材前沿設計與轉化", "R&D", 7,
    "介入產品的新材料與精密製造",
    "對應優先機會⑥介入與球囊導管平台化。邦特連結：血管通路、A.V. shunt 擴張球囊、經皮引流、胃腸與泌尿導管。官網訊號：腫瘤介入裝置的新材料與精密製造、定位影像、植入與介入產品轉化。專案目標：選定 1 個導管平台概念，完成材料、押出、編織、Tip、雷射、組裝、檢測的供應鏈可行性圖。",
    "https://en.medtecchina.com/forum/rd/rd-2/"],
  ["f8", "9/3", "N4", "會議室 C", "醫材企業海外拓展服務", "全球市場", 8,
    "全球品牌與出海方法",
    "對應優先機會⑦海外市場與供應鏈韌性。邦特連結：台灣與菲律賓製造、全球客戶與 CDMO 合作。官網訊號：全球品牌、醫材出海 0→1→1→N、投融資趨勢與全球資本市場。專案目標：在自有品牌、ODM、CDMO 三種模式中選 1 個優先模式與 1 個目標市場，避免展後名單無法轉成商機。",
    "https://en.medtecchina.com/forum/opportunities/opportunities-2/"],
];

// 後續新增的欄位（既有資料表用 ALTER 補上，新表已含在下方 MIGRATIONS 對既有表無害）
const MIGRATIONS = [
  `ALTER TABLE exhibitor_state ADD COLUMN goal_tags TEXT DEFAULT '[]'`,
  `ALTER TABLE exhibitor_state ADD COLUMN quals TEXT DEFAULT '[]'`,
  `ALTER TABLE exhibitor_state ADD COLUMN post_class TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN caption TEXT DEFAULT ''`,
  `ALTER TABLE exhibitor_state ADD COLUMN visit_record TEXT DEFAULT '{}'`,
  `ALTER TABLE attachments ADD COLUMN transcript TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN category TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_text TEXT DEFAULT ''`,
  // 採集 session：一次採集＝一段經驗（照片與錄音段掛同一個 session_id，
  // offset_secs＝釘在錄音時間軸的秒數，duration_secs＝錄音段長度）。
  // 舊資料這些欄位是空的，比對邏輯會退回解析 caption 文字（相容不遷移）。
  `ALTER TABLE attachments ADD COLUMN session_id TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN offset_secs INTEGER`,
  `ALTER TABLE attachments ADD COLUMN duration_secs INTEGER`,
  // 「處理過但結果是空的」（照片沒文字、錄音無語音）要跟「還沒處理」分開，
  // 否則空結果的附件永遠被當成待整理，每按一次整理就重跑重扣一次費用
  `ALTER TABLE attachments ADD COLUMN transcribed_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_at TEXT DEFAULT ''`,
  // Tier 2 深度處理（手動指定，見 DATA-MODEL.md）：把來源 PDF 逐頁 render 成圖片，
  // 存成一般照片附件、走既有 OCR 流程。source_pdf_id 指回來源 PDF 的 attachments.id，
  // page_no 是第幾頁，兩者都空＝不是深度處理產生的附件。
  `ALTER TABLE attachments ADD COLUMN source_pdf_id INTEGER`,
  `ALTER TABLE attachments ADD COLUMN page_no INTEGER`,
  // sessions 表在議程功能第一版就建立了，outline（內容大綱）是後補欄位，既有的
  // sessions 資料列要用 ALTER 補上，CREATE TABLE IF NOT EXISTS 對已存在的表無效
  `ALTER TABLE sessions ADD COLUMN outline TEXT DEFAULT ''`,
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!String(err.message || err).includes("duplicate column")) throw err;
    }
  }
  await db.batch(
    SESSION_SEED.map(([id, date, hall, room, title, track, priority, reason, outline, source_url]) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO sessions (id, date, hall, room, title, track, priority, reason, outline, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(id, date, hall, room, title, track, priority, reason, outline, source_url, now())
    )
  );
  // outline 是議程功能上線後才補的欄位，第一版已經跑過 seed 的環境不會再進 INSERT OR
  // IGNORE，用 UPDATE 補齊既有資料列的內容大綱（outline 目前不開放前端編輯，安全覆寫）
  await db.batch(
    SESSION_SEED.map(([id, , , , , , , , outline]) =>
      db.prepare("UPDATE sessions SET outline = ? WHERE id = ?").bind(outline, id)
    )
  );
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

// ---------- LINE 每日摘要 ----------
// Webhook 收「加好友／傳訊息」事件記下 userId；排程每天推播當日指派＋拜訪成果摘要。
async function verifyLineSignature(bodyText, signature, channelSecret) {
  if (!channelSecret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  const computed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return computed === signature;
}

async function lineApiCall(env, path, body) {
  const token = (env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN 未設定");
  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LINE API ${path} 失敗：${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function handleLineWebhook(request, env) {
  const bodyText = await request.text();
  const signature = request.headers.get("x-line-signature") || "";
  const ok = await verifyLineSignature(bodyText, signature, (env.LINE_CHANNEL_SECRET || "").trim());
  if (!ok) return new Response("bad signature", { status: 401 });

  const db = env.DB;
  await ensureSchema(db);
  const body = JSON.parse(bodyText || "{}");
  for (const ev of body.events || []) {
    const userId = ev.source && ev.source.userId;
    if (!userId) continue;
    await db.prepare("INSERT INTO line_recipients (user_id, added_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING").bind(userId, now()).run();
    if (ev.replyToken) {
      await lineApiCall(env, "reply", {
        replyToken: ev.replyToken,
        messages: [{ type: "text", text: "已加入通知名單！之後每天晚上 8 點（台北/上海時間）會收到當日指派與拜訪成果摘要。" }],
      }).catch(() => {});
    }
  }
  return new Response("ok");
}

// 摘要時間窗：過去 24 小時（滾動窗）。
// 不用「當地今天 00:00 起算」——那樣晚上 8 點發送後到午夜之間的操作，
// 會永遠掉在兩天摘要的縫隙裡，哪一天都不會報。label 仍顯示當地日期（UTC+8）。
function digestWindow(refDate) {
  const start = new Date(refDate.getTime() - 24 * 3600 * 1000);
  const shanghai = new Date(refDate.getTime() + 8 * 3600 * 1000);
  const fmt = (dt) => dt.toISOString().replace("T", " ").slice(0, 19) + "Z";
  const label = `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, "0")}-${String(shanghai.getUTCDate()).padStart(2, "0")}`;
  return { startStr: fmt(start), endStr: fmt(refDate), label };
}

async function buildDailyDigest(env) {
  const db = env.DB;
  await ensureSchema(db);
  const { startStr, endStr, label } = digestWindow(new Date());
  const { results } = await db
    .prepare(
      `SELECT * FROM history WHERE created_at >= ? AND created_at < ?
       AND action = '更新狀態' AND (detail LIKE '%負責人 → %' OR detail LIKE '%儲存拜訪成果記錄%')
       ORDER BY exhibitor_id, id`
    )
    .bind(startStr, endStr)
    .all();

  if (!results.length) return `📋 ${label} 每日摘要\n今天沒有新的指派或拜訪成果紀錄。`;

  let exMap = {};
  try {
    const assetRes = await env.ASSETS.fetch(new Request("https://assets.internal/data/exhibitors.json"));
    const data = await assetRes.json();
    for (const e of data.exhibitors) exMap[e.id] = e.name_zh;
    const { results: customEx } = await db.prepare("SELECT id, name_zh, name_en FROM custom_exhibitors WHERE deleted = 0").all();
    for (const row of customEx) exMap[row.id] = row.name_zh || row.name_en;
  } catch { /* 展商目錄抓不到時退回顯示 ID，不影響摘要送出 */ }

  // 同一家被反覆儲存會產生多筆相同紀錄，摘要只列一次
  const assignLines = new Set();
  const visitLines = new Set();
  for (const h of results) {
    const name = exMap[h.exhibitor_id] || h.exhibitor_id;
    const m = /負責人 → ([^；]+)/.exec(h.detail);
    if (m) assignLines.add(`・${name}　${h.author} → ${m[1]}`);
    if (h.detail.includes("儲存拜訪成果記錄")) visitLines.add(`・${name}（${h.author}）`);
  }

  const parts = [`📋 ${label} 每日摘要`];
  if (assignLines.size) parts.push(``, `【指派異動】共 ${assignLines.size} 筆`, ...assignLines);
  if (visitLines.size) parts.push(``, `【拜訪成果】共 ${visitLines.size} 筆`, ...visitLines);
  return parts.join("\n");
}

// 即時通知：存檔當下（指派異動／拜訪成果）立刻推播，不等排程
async function notifyRealtimeSave(env, exhibitorId, author, detail) {
  const m = /負責人 → ([^；]+)/.exec(detail);
  const isVisit = detail.includes("儲存拜訪成果記錄");
  if (!m && !isVisit) return;
  try {
    const db = env.DB;
    const { results: recipients } = await db.prepare("SELECT user_id FROM line_recipients").all();
    if (!recipients.length) return;

    let name = exhibitorId;
    try {
      const assetRes = await env.ASSETS.fetch(new Request("https://assets.internal/data/exhibitors.json"));
      const data = await assetRes.json();
      const ex = data.exhibitors.find((e) => e.id === exhibitorId);
      if (ex) name = ex.name_zh;
      else {
        const custom = await db.prepare("SELECT name_zh, name_en FROM custom_exhibitors WHERE id = ? AND deleted = 0").bind(exhibitorId).first();
        if (custom) name = custom.name_zh || custom.name_en;
      }
    } catch { /* 展商目錄抓不到時退回顯示 ID，不影響通知送出 */ }

    const parts = [];
    if (m) parts.push(`📌 指派異動\n${name}　${author} → ${m[1]}`);
    if (isVisit) parts.push(`✅ 拜訪成果\n${name}（${author}）`);
    const text = parts.join("\n\n");

    for (const r of recipients) {
      await lineApiCall(env, "push", { to: r.user_id, messages: [{ type: "text", text }] })
        .catch((err) => console.error("即時通知失敗", r.user_id, err.message));
    }
  } catch (err) {
    console.error("即時通知處理失敗", err.message);
  }
}

async function sendDailyDigest(env) {
  const db = env.DB;
  await ensureSchema(db);
  const { results: recipients } = await db.prepare("SELECT user_id FROM line_recipients").all();
  const text = await buildDailyDigest(env);
  const sent = [];
  const failed = [];
  for (const r of recipients) {
    try {
      await lineApiCall(env, "push", { to: r.user_id, messages: [{ type: "text", text }] });
      sent.push(r.user_id);
    } catch (err) {
      failed.push({ user_id: r.user_id, error: err.message });
      console.error("LINE push 失敗", r.user_id, err.message);
    }
  }
  return { text, recipients: recipients.length, sent, failed };
}

function bad(message, status = 400) {
  return json({ error: message }, status);
}

// 把 custom_exhibitors 的資料列整形成跟 exhibitors.json 裡的展商物件同一種
// 形狀（tags/products/pdfs 補空陣列），前端才能原封不動塞進 EXHIBITORS
// 陣列，指派/篩選/搜尋/PDF 報告全部沿用既有邏輯，不用另外判斷來源。
// custom:true 讓前端知道要標「自訂」徽章，不會被誤以為是官方展商目錄資料。
function toCustomExhibitor(row) {
  return {
    id: row.id, name_zh: row.name_zh || "", name_en: row.name_en || "",
    booth_no: row.booth_no || "", hall: "", country: row.country || "",
    category: row.category || "", tags: [], description: row.description || "",
    products: [], website: row.website || "", directory_url: "", pdfs: [],
    added_by: row.added_by || "", custom: true, in_directory: true,
  };
}

function fmtSecsRange(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// 圖片 OCR／關聯判斷的實作都在 imageSkill.js（共用模組，隨身記之後也用同一份）

// 找出「這張照片拍攝當下，對話講到哪一段」的逐字稿。
// 新資料：照片與錄音段掛同一個 session_id、offset_secs/duration_secs 是結構化欄位，直接比對。
// 舊資料：時間資訊只寫在 caption 文字裡（「📸 錄音 mm:ss 時拍攝」），退回正規表達式解析。
const CAPTURE_PHOTO_RE = /📸\s*錄音\s*(\d{2}):(\d{2})\s*時拍攝/;
const CAPTURE_SEG_RE = /🎙\s*採集第\s*\d+\s*段（(\d{2}):(\d{2})[–-](\d{2}):(\d{2})）/;

function findCaptureContext(allAttachments, photo) {
  const toSecs = (mm, ss) => Number(mm) * 60 + Number(ss);
  const isAudio = (a) => (a.mime || "").startsWith("audio/");

  // 結構化路徑（新資料）
  if (photo.session_id && photo.offset_secs !== null && photo.offset_secs !== undefined) {
    const off = photo.offset_secs;
    let best = null;
    for (const a of allAttachments) {
      if (!isAudio(a) || a.session_id !== photo.session_id) continue;
      if (a.offset_secs === null || a.offset_secs === undefined || a.offset_secs > off) continue;
      const end = a.duration_secs != null ? a.offset_secs + a.duration_secs : null;
      if (end !== null && off > end) continue;
      if (!best || a.offset_secs > best.offset_secs) best = a;
    }
    if (best) {
      return {
        offset: fmtSecsRange(off),
        start: best.offset_secs,
        end: best.duration_secs != null ? best.offset_secs + best.duration_secs : null,
        segment: best,
        transcript: (best.transcript || "").trim(),
      };
    }
    return { offset: fmtSecsRange(off), start: null, end: null, segment: null, transcript: "" };
  }

  // caption 解析路徑（舊資料相容）
  const m = (photo.caption || "").match(CAPTURE_PHOTO_RE);
  if (!m) return null;
  const offsetSec = toSecs(m[1], m[2]);
  for (const a of allAttachments) {
    if (!isAudio(a)) continue;
    const sm = (a.caption || "").match(CAPTURE_SEG_RE);
    if (!sm) continue;
    const start = toSecs(sm[1], sm[2]);
    const end = toSecs(sm[3], sm[4]);
    if (offsetSec >= start && offsetSec <= end) {
      return { offset: `${m[1]}:${m[2]}`, start, end, segment: a, transcript: (a.transcript || "").trim() };
    }
  }
  return { offset: `${m[1]}:${m[2]}`, start: null, end: null, segment: null, transcript: "" };
}

async function logHistory(db, exhibitorId, author, action, detail) {
  await db
    .prepare("INSERT INTO history (exhibitor_id, author, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(exhibitorId, author, action, detail, now())
    .run();
}

const STATE_FIELDS = ["status", "assignee", "dept_tags", "collected", "pocket", "goal_tags", "quals", "post_class"];
const JSON_FIELDS = ["dept_tags", "collected", "goal_tags", "quals"];
const STATE_LABELS = {
  status: "拜訪狀態", assignee: "負責人", dept_tags: "部門標籤", collected: "索取資料",
  pocket: "口袋名單", goal_tags: "觀展目標", quals: "資質確認", post_class: "展後分類",
  visit_record: "拜訪成果",
};

// ---- 論壇議程（sessions）----
const SESSION_FIELDS = ["owner", "status", "priority", "track", "reason", "time_slot", "must_ask", "related_exhibitor_ids", "speaker", "institution", "need_precontact"];
const SESSION_JSON_FIELDS = ["must_ask", "related_exhibitor_ids"];
const SESSION_LABELS = {
  owner: "負責人", status: "狀態", priority: "優先序", track: "技術鏈", reason: "關注原因",
  time_slot: "時段", must_ask: "三個必問", related_exhibitor_ids: "關聯展商", speaker: "講者", institution: "任職機構",
  need_precontact: "需會前聯繫",
};

function sessionOut(row) {
  return {
    ...row,
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
    must_ask: JSON.parse(row.must_ask || "[]"),
    related_exhibitor_ids: JSON.parse(row.related_exhibitor_ids || "[]"),
    need_precontact: !!row.need_precontact,
  };
}

async function handleApi(request, env, url, ctx) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // ---- 前端功能開關 ----
  if (path === "/config" && method === "GET") {
    return json({ uploads: !!env.FILES, transcribe: !!(env.FILES && env.AI) });
  }

  // ---- 自訂廠商（官方展商目錄以外，團隊自己追蹤的）----
  if (path === "/custom-exhibitors" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM custom_exhibitors WHERE deleted = 0 ORDER BY id")
      .all();
    return json(results.map(toCustomExhibitor));
  }
  if (path === "/custom-exhibitors" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name_zh = (body.name_zh || "").trim();
    const name_en = (body.name_en || "").trim();
    if (!name_zh && !name_en) return bad("公司名稱（中文或英文）至少要填一個");
    const author = (body.author || "").trim() || "匿名";
    // custom- 前綴跟官方展商目錄的 ex-XXXX 分開，避免同一個 id 意外對到
    // 兩種來源不同的資料——那會讓指派/筆記/附件全部混在一起分不出來
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id, name_zh, name_en,
      booth_no: (body.booth_no || "").trim(),
      country: (body.country || "").trim(),
      category: (body.category || "").trim(),
      description: (body.description || "").trim(),
      website: (body.website || "").trim(),
    };
    await db
      .prepare("INSERT INTO custom_exhibitors (id, name_zh, name_en, booth_no, country, category, description, website, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, row.name_zh, row.name_en, row.booth_no, row.country, row.category, row.description, row.website, author, now())
      .run();
    await logHistory(db, id, author, "新增自訂廠商", `${name_zh || name_en}${row.booth_no ? `（${row.booth_no}）` : ""}`);
    return json(toCustomExhibitor({ ...row, added_by: author }));
  }
  const customExMatch = path.match(/^\/custom-exhibitors\/([\w-]+)$/);
  if (customExMatch && method === "DELETE") {
    const id = customExMatch[1];
    const old = await db.prepare("SELECT * FROM custom_exhibitors WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆自訂廠商", 404);
    const author = (new URL(request.url).searchParams.get("author") || "匿名").trim();
    // 軟刪除：這家廠商底下可能已經有指派狀態／現場紀錄／照片，直接刪掉
    // 這筆會讓那些紀錄變成查不到名字的孤兒 id，跟官方展商目錄下架時
    // 標記 in_directory=false（保留不刪）是同一個顧慮
    await db.prepare("UPDATE custom_exhibitors SET deleted = 1 WHERE id = ?").bind(id).run();
    await logHistory(db, id, author, "刪除自訂廠商", old.name_zh || old.name_en);
    return json({ ok: true });
  }

  // ---- 附件（照片/錄音/影片，存 R2）----
  if (path === "/upload" && method === "POST") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存（見 cloudflare/README.md）", 501);
    const exhibitorId = (request.headers.get("x-exhibitor-id") || "").trim();
    const author = decodeURIComponent(request.headers.get("x-author") || "").trim() || "匿名";
    const filename = decodeURIComponent(request.headers.get("x-filename") || "file").trim();
    const mime = request.headers.get("content-type") || "application/octet-stream";
    if (!exhibitorId) return bad("缺 x-exhibitor-id");
    const body = await request.arrayBuffer();
    if (!body.byteLength) return bad("空檔案");
    if (body.byteLength > 50 * 1024 * 1024) return bad("檔案過大（上限 50MB），長影片請縮短或改用相簿分享");
    const key = `${exhibitorId}/${Date.now()}-${filename.replace(/[^\w.\-一-鿿]+/g, "_")}`;
    await env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
    const sessionId = (request.headers.get("x-session-id") || "").trim();
    const offsetRaw = request.headers.get("x-offset-secs");
    const durationRaw = request.headers.get("x-duration-secs");
    const offsetSecs = offsetRaw !== null && offsetRaw !== "" ? Number(offsetRaw) : null;
    const durationSecs = durationRaw !== null && durationRaw !== "" ? Number(durationRaw) : null;
    // Tier 2 深度處理：PDF 逐頁 render 成圖片上傳時，帶回來源 PDF 的 id 與頁碼
    const sourcePdfRaw = request.headers.get("x-source-pdf-id");
    const pageNoRaw = request.headers.get("x-page-no");
    const sourcePdfId = sourcePdfRaw !== null && sourcePdfRaw !== "" ? Number(sourcePdfRaw) : null;
    const pageNo = pageNoRaw !== null && pageNoRaw !== "" ? Number(pageNoRaw) : null;
    const result = await db
      .prepare("INSERT INTO attachments (exhibitor_id, author, filename, key, size, mime, session_id, offset_secs, duration_secs, source_pdf_id, page_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(exhibitorId, author, filename, key, body.byteLength, mime, sessionId, offsetSecs, durationSecs, sourcePdfId, pageNo, now())
      .run();
    await logHistory(db, exhibitorId, author, "上傳附件", `${filename}（${(body.byteLength / 1024 / 1024).toFixed(1)}MB）`);
    return json({ id: result.meta.last_row_id, key, ok: true });
  }
  if (path === "/attachments" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) return bad("缺 exhibitor_id");
    const { results } = await db
      .prepare("SELECT * FROM attachments WHERE exhibitor_id = ? ORDER BY id DESC")
      .bind(exhibitorId)
      .all();
    return json(results);
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
  const attCapMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attCapMatch && method === "PUT") {
    const id = Number(attCapMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (body.category !== undefined) {
      const category = (body.category || "").trim();
      await db.prepare("UPDATE attachments SET category = ? WHERE id = ?").bind(category, id).run();
      await logHistory(db, old.exhibitor_id, author, "附件分類", `${old.filename}：${category || "未分類"}`);
      return json({ ok: true });
    }
    // 標記「不整理」：把 *_at 設成 'skipped'（不呼叫 AI、不花額度），
    // 待整理數字與批次整理都會跳過；之後按「還是要整理」跑 AI 會覆寫回真正時間戳
    if (body.skip_transcribe) {
      await db.prepare("UPDATE attachments SET transcribed_at = 'skipped' WHERE id = ?").bind(id).run();
      await logHistory(db, old.exhibitor_id, author, "設為不整理", `${old.filename}（錄音不轉文字）`);
      return json({ ok: true });
    }
    if (body.skip_ocr) {
      await db.prepare("UPDATE attachments SET ocr_at = 'skipped' WHERE id = ?").bind(id).run();
      await logHistory(db, old.exhibitor_id, author, "設為不整理", `${old.filename}（不擷取文字）`);
      return json({ ok: true });
    }
    if (body.transcript !== undefined) {
      const transcript = (body.transcript || "").trim();
      await db.prepare("UPDATE attachments SET transcript = ? WHERE id = ?").bind(transcript, id).run();
      await logHistory(db, old.exhibitor_id, author, "編輯轉文字稿", `${old.filename}：「${transcript.slice(0, 80)}」`);
      return json({ ok: true });
    }
    if (body.ocr_text !== undefined) {
      const ocrText = (body.ocr_text || "").trim();
      await db.prepare("UPDATE attachments SET ocr_text = ? WHERE id = ?").bind(ocrText, id).run();
      await logHistory(db, old.exhibitor_id, author, "編輯擷取文字", `${old.filename}：「${ocrText.slice(0, 80)}」`);
      return json({ ok: true });
    }
    const caption = (body.caption || "").trim();
    await db.prepare("UPDATE attachments SET caption = ? WHERE id = ?").bind(caption, id).run();
    await logHistory(db, old.exhibitor_id, author, "附件說明", `${old.filename}：「${caption.slice(0, 80)}」`);
    return json({ ok: true });
  }

  const attDelMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attDelMatch && method === "DELETE") {
    const id = Number(attDelMatch[1]);
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (env.FILES) await env.FILES.delete(old.key);
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
    await logHistory(db, old.exhibitor_id, author, "刪除附件", old.filename);
    return json({ ok: true });
  }

  const attTranscribeMatch = path.match(/^\/attachments\/(\d+)\/transcribe$/);
  if (attTranscribeMatch && method === "POST") {
    if (!env.AI) return bad("尚未啟用語音轉文字（需先在 Cloudflare 開啟 Workers AI，見 cloudflare/README.md）", 501);
    const id = Number(attTranscribeMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (!(old.mime || "").startsWith("audio/")) return bad("只有錄音檔可以轉文字");
    const obj = await env.FILES.get(old.key);
    if (!obj) return bad("找不到檔案內容", 404);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(binary), task: "transcribe" });
    const text = (result?.text || "").trim();
    await db.prepare("UPDATE attachments SET transcript = ?, transcribed_at = ? WHERE id = ?").bind(text, now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "錄音轉文字", `${old.filename}：${text.slice(0, 80) || "（無語音內容）"}`);
    return json({ text });
  }

  // ---- 照片／PDF 擷取文字：抄出內容存進 ocr_text，可再人工編輯；
  // 照片走影像 skill（採集模式照片另外比對「拍攝當下」的錄音逐字稿附關聯），
  // PDF 走 Workers AI 的 toMarkdown 轉換——型錄/DM 的內容也要進得了搜尋跟 MCP ----
  const attOcrMatch = path.match(/^\/attachments\/(\d+)\/ocr$/);
  if (attOcrMatch && method === "POST") {
    if (!env.FILES) return bad("尚未啟用附件儲存（需 R2）", 501);
    const id = Number(attOcrMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    const isPdf = (old.mime || "") === "application/pdf" || old.filename.toLowerCase().endsWith(".pdf");
    // docx／xlsx／pptx／純文字：直接從檔案結構解出文字，不經過 AI——免費、瞬間、
    // 沒有 OCR 辨識誤差，也不用管 Neurons 額度
    const nativeKind = !isPdf ? detectNativeTextKind(old.filename, old.mime) : null;
    if (!(old.mime || "").startsWith("image/") && !isPdf && !nativeKind) return bad("只有照片、PDF、Word/Excel/PowerPoint（docx/xlsx/pptx）與純文字檔可以擷取文字");
    const obj = await env.FILES.get(old.key);
    if (!obj) return bad("找不到檔案內容", 404);
    if (nativeKind) {
      let text;
      try {
        text = await extractNativeText(nativeKind, new Uint8Array(await obj.arrayBuffer()));
      } catch (err) {
        return bad(err.message, nativeKind === "legacy-office" ? 400 : 502);
      }
      await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(text, now(), id).run();
      await logHistory(db, old.exhibitor_id, author, "文件擷取文字", `${old.filename}：${text.slice(0, 80) || "（沒有擷取到文字）"}`);
      return json({ ocr_text: text });
    }
    if (!env.AI) return bad("尚未啟用圖片擷取文字（需 Workers AI）", 501);
    if (isPdf) {
      const converted = await env.AI.toMarkdown([
        { name: old.filename, blob: new Blob([await obj.arrayBuffer()], { type: "application/pdf" }) },
      ]).catch((err) => { throw new Error(`PDF 轉文字失敗：${err.message}`); });
      // 剝掉 toMarkdown 開頭的檔案 metadata，只留本文；設計型 PDF（文字排成圖形、
      // 無文字層）剝完可能是空的 → ocr_at 有時間戳但 ocr_text 空 → 前台顯示
      // 「已整理（沒有文字內容）」，比留著一堆 metadata 假裝有內容誠實
      const pdfText = stripPdfMetadata(converted?.[0]?.data || "").slice(0, 60000);
      await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(pdfText, now(), id).run();
      await logHistory(db, old.exhibitor_id, author, "PDF 擷取文字", `${old.filename}：${pdfText.slice(0, 80) || "（沒有擷取到文字，可能是圖形型 PDF）"}`);
      return json({ ocr_text: pdfText });
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const r = await extractImageText(env.AI, bytes);
    if (!r.ok) return bad(r.error, 502);
    let text = r.text;
    // 採集模式照片：找出拍攝當下的錄音逐字稿，讓照片跟現場對話主題掛勾
    const ctxInfo = findCaptureContext(
      (await db.prepare("SELECT * FROM attachments WHERE exhibitor_id = ? ORDER BY id ASC").bind(old.exhibitor_id).all()).results,
      old
    );
    if (ctxInfo && ctxInfo.transcript) {
      const relation = await judgeRelation(env.AI, ctxInfo.transcript, text);
      if (relation && !relation.includes("看不出明顯關聯")) {
        text += `\n\n【對話關聯】${relation}（錄音 ${ctxInfo.offset} 時拍攝）`;
      }
    }
    await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = ? WHERE id = ?").bind(text, now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "照片擷取文字", `${old.filename}：${text.slice(0, 80) || "（照片上沒有文字）"}`);
    return json({ ocr_text: text });
  }

  // ---- 附件文字彙整（給前端搜尋用）：把每家展商的照片擷取文字＋錄音逐字稿
  // 合併成一包，搜尋框打關鍵字時照片裡的字也搜得到 ----
  if (path === "/search-texts" && method === "GET") {
    const { results } = await db
      .prepare("SELECT exhibitor_id, ocr_text, transcript FROM attachments WHERE ocr_text != '' OR transcript != ''")
      .all();
    const map = {};
    for (const r of results) {
      const chunk = `${r.ocr_text || ""} ${r.transcript || ""}`.trim();
      if (!chunk) continue;
      map[r.exhibitor_id] = ((map[r.exhibitor_id] || "") + " " + chunk).slice(0, 20000);
    }
    return json(map);
  }

  // ---- members ----
  if (path === "/members" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM members ORDER BY id").all();
    return json(results);
  }
  if (path === "/members" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    if (!name) return bad("name 為必填");
    if (name.length > 30) return bad("名字太長");
    await db
      .prepare("INSERT INTO members (name, dept, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET dept = excluded.dept")
      .bind(name, (body.dept || "").trim(), now())
      .run();
    const { results } = await db.prepare("SELECT * FROM members ORDER BY id").all();
    return json(results);
  }

  // ---- state（一次抓全部，前端載入時用）----
  if (path === "/state" && method === "GET") {
    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: counts } = await db
      .prepare("SELECT exhibitor_id, COUNT(*) AS note_count FROM notes WHERE deleted = 0 GROUP BY exhibitor_id")
      .all();
    const countMap = {};
    for (const row of counts) countMap[row.exhibitor_id] = row.note_count;
    const out = {};
    for (const s of states) {
      out[s.exhibitor_id] = {
        status: s.status,
        assignee: s.assignee,
        dept_tags: JSON.parse(s.dept_tags || "[]"),
        collected: JSON.parse(s.collected || "[]"),
        goal_tags: JSON.parse(s.goal_tags || "[]"),
        quals: JSON.parse(s.quals || "[]"),
        post_class: s.post_class || "",
        pocket: !!s.pocket,
        updated_by: s.updated_by,
        updated_at: s.updated_at,
        note_count: countMap[s.exhibitor_id] || 0,
        visit_record: JSON.parse(s.visit_record || "{}"),
      };
    }
    for (const id of Object.keys(countMap)) {
      if (!out[id]) out[id] = { status: "未排定", assignee: "", dept_tags: [], collected: [], goal_tags: [], quals: [], post_class: "", pocket: false, note_count: countMap[id], visit_record: {} };
    }
    return json(out);
  }

  // ---- state 更新 ----
  const stateMatch = path.match(/^\/state\/([\w-]+)$/);
  if (stateMatch && method === "PUT") {
    const exhibitorId = stateMatch[1];
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";

    const updates = {};
    for (const f of STATE_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (JSON_FIELDS.includes(f)) v = JSON.stringify(Array.isArray(v) ? v : []);
      if (f === "pocket") v = v ? 1 : 0;
      updates[f] = v;
    }
    if ("visit_record" in body) {
      const vr = (typeof body.visit_record === "object" && body.visit_record !== null) ? body.visit_record : {};
      updates.visit_record = JSON.stringify(vr);
    }
    if (!Object.keys(updates).length) return bad("沒有可更新的欄位");

    await db
      .prepare("INSERT INTO exhibitor_state (exhibitor_id, updated_by, updated_at) VALUES (?, ?, ?) ON CONFLICT(exhibitor_id) DO NOTHING")
      .bind(exhibitorId, author, now())
      .run();
    const sets = Object.keys(updates).map((f) => `${f} = ?`).join(", ");
    await db
      .prepare(`UPDATE exhibitor_state SET ${sets}, updated_by = ?, updated_at = ? WHERE exhibitor_id = ?`)
      .bind(...Object.values(updates), author, now(), exhibitorId)
      .run();

    const detail = Object.entries(updates)
      .map(([f, v]) => {
        if (f === "visit_record") return "儲存拜訪成果記錄";
        return `${STATE_LABELS[f] || f} → ${f === "pocket" ? (v ? "加入" : "移除") : v}`;
      })
      .join("；");
    await logHistory(db, exhibitorId, author, "更新狀態", detail);
    ctx.waitUntil(notifyRealtimeSave(env, exhibitorId, author, detail)); // 背景推播，不拖慢存檔回應

    const row = await db.prepare("SELECT * FROM exhibitor_state WHERE exhibitor_id = ?").bind(exhibitorId).first();
    return json({
      status: row.status,
      assignee: row.assignee,
      dept_tags: JSON.parse(row.dept_tags || "[]"),
      collected: JSON.parse(row.collected || "[]"),
      goal_tags: JSON.parse(row.goal_tags || "[]"),
      quals: JSON.parse(row.quals || "[]"),
      post_class: row.post_class || "",
      pocket: !!row.pocket,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      visit_record: JSON.parse(row.visit_record || "{}"),
    });
  }

  // ---- notes ----
  if (path === "/notes" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) {
      // 不帶 exhibitor_id：回傳全部筆記（登入時整批快照到手機，離線也看得到代問事項）
      const { results } = await db
        .prepare("SELECT * FROM notes WHERE deleted = 0 ORDER BY exhibitor_id, id DESC")
        .all();
      return json(results);
    }
    const { results } = await db
      .prepare("SELECT * FROM notes WHERE exhibitor_id = ? AND deleted = 0 ORDER BY id DESC")
      .bind(exhibitorId)
      .all();
    return json(results);
  }
  if (path === "/notes" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const exhibitorId = (body.exhibitor_id || "").trim();
    const author = (body.author || "").trim();
    const content = (body.content || "").trim();
    if (!exhibitorId || !author || !content) return bad("exhibitor_id、author、content 為必填");
    const type = (body.type || "現場紀錄").trim();
    const result = await db
      .prepare("INSERT INTO notes (exhibitor_id, author, type, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(exhibitorId, author, type, content, now())
      .run();
    await logHistory(db, exhibitorId, author, "新增紀錄", `[${type}] ${content.slice(0, 80)}`);
    return json({ id: result.meta.last_row_id, ok: true });
  }
  const noteMatch = path.match(/^\/notes\/(\d+)$/);
  if (noteMatch && method === "PUT") {
    const id = Number(noteMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const content = (body.content || "").trim();
    if (!content) return bad("content 為必填");
    const old = await db.prepare("SELECT * FROM notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?").bind(content, now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "修改紀錄", `原：「${String(old.content).slice(0, 60)}」→ 新：「${content.slice(0, 60)}」`);
    return json({ ok: true });
  }
  if (noteMatch && method === "DELETE") {
    const id = Number(noteMatch[1]);
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?").bind(now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "刪除紀錄", `[${old.type}] ${String(old.content).slice(0, 80)}`);
    return json({ ok: true });
  }

  // ---- history ----
  if (path === "/history" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    let stmt;
    if (exhibitorId) {
      stmt = db.prepare("SELECT * FROM history WHERE exhibitor_id = ? ORDER BY id DESC LIMIT 100").bind(exhibitorId);
    } else {
      stmt = db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT 200");
    }
    const { results } = await stmt.all();
    return json(results);
  }

  // ---- 今日 AI 用量（供首頁提醒，避免浪費 Workers AI 免費額度）----
  // fieldlog 與本系統共用同一個 Cloudflare 帳號的 Workers AI 每日額度，
  // 所以這裡把兩邊「轉文字／擷取文字」的呼叫次數加總，只是次數不是真正的
  // Neurons 用量（不同模型耗用不同，這裡只求一個粗略、免額外設定的參考值）
  if (path === "/ai-usage" && method === "GET") {
    const todayPrefix = now().slice(0, 10); // YYYY-MM-DD（UTC）
    const AI_ACTIONS = "('錄音轉文字','照片擷取文字')";
    const { results: mine } = await db
      .prepare(`SELECT COUNT(*) AS c FROM history WHERE action IN ${AI_ACTIONS} AND created_at LIKE ?`)
      .bind(`${todayPrefix}%`)
      .all();
    let fieldlogCount = 0;
    if (env.DB_FIELDLOG) {
      try {
        const { results: theirs } = await env.DB_FIELDLOG
          .prepare(`SELECT COUNT(*) AS c FROM history WHERE action IN ${AI_ACTIONS} AND created_at LIKE ?`)
          .bind(`${todayPrefix}%`)
          .all();
        fieldlogCount = theirs[0]?.c || 0;
      } catch { /* fieldlog 那邊 history 表還沒建立時忽略，不影響本系統自己的數字 */ }
    }
    return json({ today: todayPrefix, medtec: mine[0]?.c || 0, fieldlog: fieldlogCount, total: (mine[0]?.c || 0) + fieldlogCount });
  }

  // ---- 個人參訪報告（HTML，可直接列印存 PDF）----
  if (path === "/report" && method === "GET") {
    const author = (url.searchParams.get("author") || "").trim();
    if (!author) return bad("缺 author");

    const assetRes = await env.ASSETS.fetch(new Request(new URL("/data/exhibitors.json", url).toString()));
    const data = await assetRes.json();
    const exMap = {};
    for (const e of data.exhibitors) exMap[e.id] = e;
    // 自訂廠商（官方展商目錄以外，見 custom_exhibitors 表）也要併進來，
    // 不然被指派、被寫過紀錄的自訂廠商會在下面的 .filter((x) => x.ex) 被
    // 悄悄濾掉，個人報告裡完全看不到這家——這正是這張表加進來之後容易漏改
    // 的地方，任何地方組 exMap 都要記得兩邊一起讀
    const { results: customEx } = await db
      .prepare("SELECT * FROM custom_exhibitors WHERE deleted = 0")
      .all();
    for (const row of customEx) exMap[row.id] = toCustomExhibitor(row);
    const catMap = {};
    for (const c of data.categories) catMap[c.id] = c.name_zh;

    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: myNotes } = await db
      .prepare("SELECT * FROM notes WHERE deleted = 0 AND author = ? ORDER BY id")
      .bind(author)
      .all();
    const { results: myAtts } = await db
      .prepare("SELECT * FROM attachments WHERE author = ? ORDER BY id")
      .bind(author)
      .all();

    const stateMap = {};
    for (const s of states) stateMap[s.exhibitor_id] = s;
    const notesByEx = {};
    for (const n of myNotes) (notesByEx[n.exhibitor_id] = notesByEx[n.exhibitor_id] || []).push(n);
    const attsByEx = {};
    for (const a of myAtts) (attsByEx[a.exhibitor_id] = attsByEx[a.exhibitor_id] || []).push(a);

    // 我的廠商 = 指派給我的 ∪ 我寫過紀錄的 ∪ 我傳過附件的
    const ids = new Set([
      ...states.filter((s) => s.assignee === author).map((s) => s.exhibitor_id),
      ...Object.keys(notesByEx),
      ...Object.keys(attsByEx),
    ]);
    const list = [...ids]
      .map((id) => ({ id, ex: exMap[id], st: stateMap[id] || {} }))
      .filter((x) => x.ex)
      .sort((a, b) => (a.ex.booth_no || "").localeCompare(b.ex.booth_no || ""));

    const QUAL_LABELS = { iso13485: "ISO 13485", fda: "FDA", ce_mdr: "CE/MDR" };
    const COLLECTED_LABELS = { catalog: "型錄", card: "名片", sample: "樣品", quote: "報價" };
    const h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const j = (raw, labels) => JSON.parse(raw || "[]").map((x) => (labels ? labels[x] || x : x)).join("、");

    const visited = list.filter((x) => x.st.status === "已拜訪").length;
    const today = new Date().toISOString().slice(0, 10);

    const sections = list.map(({ id, ex, st }) => {
      const notes = (notesByEx[id] || [])
        .map((n) => `<div class="note"><span class="meta">[${h(n.type)}｜${h(n.created_at)}]</span> ${h(n.content)}</div>`)
        .join("");
      const atts = (attsByEx[id] || [])
        .map((a) => `<li>${h(a.filename)}（${(a.size / 1024 / 1024).toFixed(1)}MB）${a.caption ? `──${h(a.caption)}` : ""}</li>`)
        .join("");
      const facts = [
        st.status && st.status !== "未排定" ? `狀態：${h(st.status)}` : "",
        st.post_class ? `展後分類：${h(st.post_class)}` : "",
        j(st.goal_tags) ? `目標：${h(j(st.goal_tags))}` : "",
        j(st.quals, QUAL_LABELS) ? `資質：${h(j(st.quals, QUAL_LABELS))}` : "",
        j(st.collected, COLLECTED_LABELS) ? `已索取：${h(j(st.collected, COLLECTED_LABELS))}` : "",
      ].filter(Boolean).join("｜");
      const vr = JSON.parse(st.visit_record || "{}");
      const vrFacts = [
        (vr.obtained || []).length ? `取得：${h(vr.obtained.join("、"))}` : "",
        vr.contact ? `聯絡人：${h(vr.contact)}` : "",
        vr.next_step ? `下一步：${h(vr.next_step)}` : "",
      ].filter(Boolean).join("｜");
      const vrText = [
        (vr.solves || vr.note) ? `<div class="note"><span class="meta">[能為邦特解決什麼問題]</span> ${h(vr.solves || vr.note)}</div>` : "",
        vr.diff ? `<div class="note"><span class="meta">[相較現有方案的差異]</span> ${h(vr.diff)}</div>` : "",
      ].join("");
      return `<section>
        <h2>${h(ex.name_zh)} <span class="booth">${h(ex.booth_no)}</span></h2>
        <p class="sub">${h(ex.name_en || "")}｜${h(catMap[ex.category] || "")}｜${h(ex.country)}</p>
        ${facts ? `<p class="facts">${facts}</p>` : ""}
        ${vrFacts ? `<p class="facts">拜訪成果：${vrFacts}</p>` : ""}
        ${vrText}
        ${notes || '<p class="none">（無個人紀錄）</p>'}
        ${atts ? `<p class="facts">附件：</p><ul>${atts}</ul>` : ""}
      </section>`;
    }).join("");

    const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${h(author)} 參訪報告 ${today}</title>
<style>
body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#1c1c1a;max-width:800px;margin:24px auto;padding:0 16px;line-height:1.7;}
h1{font-size:22px;border-bottom:3px solid #c8102e;padding-bottom:8px;}
h1 small{display:block;font-size:12px;color:#6f6f68;font-weight:normal;margin-top:4px;}
h2{font-size:16px;margin:0 0 2px;}
.booth{font-family:ui-monospace,monospace;font-size:13px;border:1px solid #1c1c1a;padding:1px 6px;border-radius:4px;margin-left:6px;}
.sub{color:#6f6f68;font-size:12px;margin:0 0 6px;}
.facts{font-size:13px;color:#a00d24;margin:4px 0;}
.note{font-size:13px;background:#f7f7f5;border:1px solid #e4e4e0;border-radius:6px;padding:8px 10px;margin:6px 0;white-space:pre-line;}
.meta{color:#6f6f68;font-size:11px;}
.none{color:#9a9a92;font-size:12px;}
section{border-bottom:1px dashed #e4e4e0;padding:14px 0;page-break-inside:avoid;}
ul{margin:4px 0;font-size:13px;}
.print-btn{position:fixed;top:16px;right:16px;padding:10px 18px;background:#c8102e;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;}
@media print{.print-btn{display:none;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">列印 / 存 PDF</button>
<h1>2026 上海 Medtec 參訪報告──${h(author)}<small>產出日期 ${today}｜涉及廠商 ${list.length} 家｜已拜訪 ${visited} 家</small></h1>
${sections || "<p>尚無任何紀錄或指派。</p>"}
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ---- CSV 匯出 ----
  if (path === "/export.csv" && method === "GET") {
    const assetRes = await env.ASSETS.fetch(new Request(new URL("/data/exhibitors.json", url).toString()));
    const data = await assetRes.json();
    const exMap = {};
    for (const e of data.exhibitors) exMap[e.id] = e;
    // 自訂廠商也要併進來，不然這裡的 exMap[id] || {} 會讓自訂廠商那幾列
    // 匯出成「廠商」欄空白的紀錄，看起來像資料壞掉，其實只是查表沒查到
    const { results: customExForCsv } = await db
      .prepare("SELECT * FROM custom_exhibitors WHERE deleted = 0")
      .all();
    for (const row of customExForCsv) exMap[row.id] = toCustomExhibitor(row);

    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: notes } = await db
      .prepare("SELECT * FROM notes WHERE deleted = 0 ORDER BY exhibitor_id, id")
      .all();
    const notesByEx = {};
    for (const n of notes) {
      (notesByEx[n.exhibitor_id] = notesByEx[n.exhibitor_id] || []).push(n);
    }

    const COLLECTED_LABELS = { catalog: "型錄", card: "名片", sample: "樣品", quote: "報價" };
    const QUAL_LABELS = { iso13485: "ISO 13485", fda: "FDA", ce_mdr: "CE/MDR" };
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["﻿廠商,攤位,館別,拜訪狀態,展後分類,觀展目標,資質確認,負責人,索取資料,口袋名單,取得資料,聯絡人,能解決什麼問題,與現有方案差異,下一步,紀錄數,所有紀錄"];

    const allIds = new Set([...states.map((s) => s.exhibitor_id), ...Object.keys(notesByEx)]);
    for (const id of allIds) {
      const ex = exMap[id] || {};
      const s = states.find((x) => x.exhibitor_id === id) || {};
      const exNotes = notesByEx[id] || [];
      const noteText = exNotes.map((n) => `[${n.created_at} ${n.author}/${n.type}] ${n.content}`).join("\n");
      const collected = JSON.parse(s.collected || "[]").map((c) => COLLECTED_LABELS[c] || c).join("、");
      const quals = JSON.parse(s.quals || "[]").map((q) => QUAL_LABELS[q] || q).join("、");
      const vr = JSON.parse(s.visit_record || "{}");
      lines.push(
        [
          esc(ex.name_zh || id),
          esc(ex.booth_no || ""),
          esc(ex.hall || ""),
          esc(s.status || "未排定"),
          esc(s.post_class || ""),
          esc(JSON.parse(s.goal_tags || "[]").join("、")),
          esc(quals),
          esc(s.assignee || ""),
          esc(collected),
          esc(s.pocket ? "是" : ""),
          esc((vr.obtained || []).join("、")),
          esc(vr.contact || ""),
          esc(vr.solves || vr.note || ""),
          esc(vr.diff || ""),
          esc(vr.next_step || ""),
          esc(exNotes.length),
          esc(noteText),
        ].join(",")
      );
    }
    return new Response(lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=medtec_team_records.csv",
      },
    });
  }

  // ---- 論壇議程（sessions）：官網研討會場次，跟展商無關的獨立實體 ----
  if (path === "/sessions" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM sessions ORDER BY date, priority IS NULL, priority").all();
    return json(results.map(sessionOut));
  }
  const sessionMatch = path.match(/^\/sessions\/([\w-]+)$/);
  if (sessionMatch && method === "PUT") {
    const sessionId = sessionMatch[1];
    const existing = await db.prepare("SELECT id FROM sessions WHERE id = ?").bind(sessionId).first();
    if (!existing) return bad("找不到這個場次", 404);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";

    const updates = {};
    for (const f of SESSION_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (SESSION_JSON_FIELDS.includes(f)) v = JSON.stringify(Array.isArray(v) ? v : []);
      if (f === "need_precontact") v = v ? 1 : 0;
      if (f === "priority") v = v === "" || v === null || v === undefined ? null : Number(v);
      updates[f] = v;
    }
    if (!Object.keys(updates).length) return bad("沒有可更新的欄位");

    const sets = Object.keys(updates).map((f) => `${f} = ?`).join(", ");
    await db
      .prepare(`UPDATE sessions SET ${sets}, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(...Object.values(updates), author, now(), sessionId)
      .run();

    const detail = Object.entries(updates)
      .map(([f, v]) => {
        if (f === "must_ask" || f === "related_exhibitor_ids") return `${SESSION_LABELS[f]} → ${JSON.parse(v).join("、") || "（清空）"}`;
        if (f === "need_precontact") return `${SESSION_LABELS[f]} → ${v ? "是" : "否"}`;
        return `${SESSION_LABELS[f] || f} → ${v || "（清空）"}`;
      })
      .join("；");
    await logHistory(db, null, author, "更新議程場次", `${sessionId}：${detail}`);

    const row = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
    return json(sessionOut(row));
  }

  // ---- 議程場次的現場紀錄（session_notes，結構比照展商 notes）----
  if (path === "/session-notes" && method === "GET") {
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) {
      const { results } = await db.prepare("SELECT * FROM session_notes WHERE deleted = 0 ORDER BY session_id, id DESC").all();
      return json(results);
    }
    const { results } = await db
      .prepare("SELECT * FROM session_notes WHERE session_id = ? AND deleted = 0 ORDER BY id DESC")
      .bind(sessionId)
      .all();
    return json(results);
  }
  if (path === "/session-notes" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const sessionId = (body.session_id || "").trim();
    const author = (body.author || "").trim();
    const content = (body.content || "").trim();
    if (!sessionId || !author || !content) return bad("session_id、author、content 為必填");
    const type = (body.type || "現場紀錄").trim();
    const result = await db
      .prepare("INSERT INTO session_notes (session_id, author, type, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sessionId, author, type, content, now())
      .run();
    await logHistory(db, null, author, "議程新增紀錄", `${sessionId}：[${type}] ${content.slice(0, 80)}`);
    return json({ id: result.meta.last_row_id, ok: true });
  }
  const sessionNoteMatch = path.match(/^\/session-notes\/(\d+)$/);
  if (sessionNoteMatch && method === "PUT") {
    const id = Number(sessionNoteMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const content = (body.content || "").trim();
    if (!content) return bad("content 為必填");
    const old = await db.prepare("SELECT * FROM session_notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE session_notes SET content = ?, updated_at = ? WHERE id = ?").bind(content, now(), id).run();
    await logHistory(db, null, author, "議程修改紀錄", `${old.session_id}：原：「${String(old.content).slice(0, 60)}」→ 新：「${content.slice(0, 60)}」`);
    return json({ ok: true });
  }
  if (sessionNoteMatch && method === "DELETE") {
    const id = Number(sessionNoteMatch[1]);
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM session_notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE session_notes SET deleted = 1, updated_at = ? WHERE id = ?").bind(now(), id).run();
    await logHistory(db, null, author, "議程刪除紀錄", `${old.session_id}：[${old.type}] ${String(old.content).slice(0, 80)}`);
    return json({ ok: true });
  }

  // ---- 參訪前報告：每位同事的自由文字欄（見 config.js 的 PREP_REPORT）----
  if (path === "/prep-notes" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM prep_notes").all();
    const out = {};
    for (const r of results) out[r.member] = { content: r.content || "", updated_by: r.updated_by || "", updated_at: r.updated_at || "" };
    return json(out);
  }
  const prepMatch = path.match(/^\/prep-notes\/(.+)$/);
  if (prepMatch && method === "PUT") {
    const member = decodeURIComponent(prepMatch[1]).trim();
    if (!member) return bad("缺少成員名稱");
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const content = (body.content || "").trim();
    const old = await db.prepare("SELECT content FROM prep_notes WHERE member = ?").bind(member).first();
    await db
      .prepare(
        "INSERT INTO prep_notes (member, content, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(member) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
      )
      .bind(member, content, author, now())
      .run();
    // exhibitor_id 留空：這不是掛在某家展商底下的紀錄，前端會標示成「參訪前報告」
    await logHistory(db, null, author, "編輯參訪前報告", `${member}：「${(old?.content ? "原：" + String(old.content).slice(0, 40) + "　→　" : "")}${content.slice(0, 60)}」`);
    return json({ member, content, updated_by: author, updated_at: now() });
  }

  // ---- 參訪前報告：四階段圖卡人工覆寫 ----
  if (path === "/prep-overrides" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM prep_overrides").all();
    const out = {};
    for (const r of results) {
      let content = {};
      try { content = JSON.parse(r.content || "{}"); } catch { content = {}; }
      out[r.member] = { content, updated_by: r.updated_by || "", updated_at: r.updated_at || "" };
    }
    return json(out);
  }
  const prepOverrideMatch = path.match(/^\/prep-overrides\/(.+)$/);
  if (prepOverrideMatch && method === "PUT") {
    const member = decodeURIComponent(prepOverrideMatch[1]).trim();
    if (!member) return bad("缺少成員名稱");
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const raw = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? body.content : {};
    const cleanLines = (value) => Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 30).map((item) => item.slice(0, 600))
      : undefined;
    const content = {};
    for (const key of ["map", "demands", "landing"]) {
      const lines = cleanLines(raw[key]);
      if (lines) content[key] = lines;
    }
    if (raw.vendors && typeof raw.vendors === "object" && !Array.isArray(raw.vendors)) {
      const vendors = {};
      for (const [id, value] of Object.entries(raw.vendors).slice(0, 150)) {
        const cleanId = String(id || "").trim().slice(0, 160);
        const cleanValue = String(value || "").trim().slice(0, 600);
        if (cleanId && cleanValue) vendors[cleanId] = cleanValue;
      }
      if (Object.keys(vendors).length) content.vendors = vendors;
    }
    const serialized = JSON.stringify(content);
    if (serialized.length > 40000) return bad("人工修正內容過長");
    await db
      .prepare(
        "INSERT INTO prep_overrides (member, content, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(member) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
      )
      .bind(member, serialized, author, now())
      .run();
    await logHistory(db, null, author, "人工修正四階段圖卡", `${member}：${Object.keys(content).join("、") || "還原自動分析"}`);
    return json({ member, content, updated_by: author, updated_at: now() });
  }
  if (prepOverrideMatch && method === "DELETE") {
    const member = decodeURIComponent(prepOverrideMatch[1]).trim();
    if (!member) return bad("缺少成員名稱");
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    await db.prepare("DELETE FROM prep_overrides WHERE member = ?").bind(member).run();
    await logHistory(db, null, author, "還原四階段圖卡", `${member}：改回系統自動分析`);
    return json({ ok: true });
  }

  // ---- LINE 每日摘要：手動立即測試觸發（不用等排程的晚上 8 點）----
  if (path === "/line/test-digest" && method === "GET") {
    const result = await sendDailyDigest(env);
    return json(result);
  }

  // ---- 一次性：接受 llama-3.2-11b-vision-instruct 的 Meta License（測完可刪）----
  if (path === "/agree-license" && method === "GET") {
    if (!env.AI) return bad("尚未啟用 Workers AI", 501);
    try {
      const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" });
      return json({ ok: true, result });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ---- OCR 測試用（暫時端點，測完準確度再決定要不要做成正式功能）----
  if (path === "/test-ocr" && method === "GET") {
    if (!env.AI || !env.FILES) return bad("尚未啟用 Workers AI 或 R2", 501);
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) return bad("缺 exhibitor_id 參數");
    const limit = Number(url.searchParams.get("limit") || 2);
    const { results } = await db
      .prepare("SELECT * FROM attachments WHERE exhibitor_id = ? AND mime LIKE 'image/%' ORDER BY id ASC LIMIT ?")
      .bind(exhibitorId, limit)
      .all();
    if (!results.length) return bad("這家展商沒有照片附件", 404);
    const out = [];
    for (const a of results) {
      const obj = await env.FILES.get(a.key);
      if (!obj) { out.push({ id: a.id, filename: a.filename, error: "找不到檔案本體" }); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      try {
        const r = await extractImageText(env.AI, bytes);
        out.push(r.ok
          ? { id: a.id, filename: a.filename, text: r.text }
          : { id: a.id, filename: a.filename, text: null, error: r.error });
      } catch (err) {
        out.push({ id: a.id, filename: a.filename, error: err.message });
      }
    }
    return json({ exhibitor_id: exhibitorId, results: out });
  }

  // ---- OCR＋對話上下文測試用（暫時端點）：照片時間點比對採集模式錄音逐字稿，
  // 驗證「照片要跟當下對話掛勾」這個設計，不是只測圖片本身。
  // 拆成兩步：先純看圖抄字（不給逐字稿，避免模型把逐字稿當成照片內容抄），
  // 抄完才另外用文字模型比對逐字稿判斷關聯——兩個任務分開，互不污染 ----
  if (path === "/test-ocr-context" && method === "GET") {
    if (!env.AI || !env.FILES) return bad("尚未啟用 Workers AI 或 R2", 501);
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) return bad("缺 exhibitor_id 參數");
    const { results: all } = await db
      .prepare("SELECT * FROM attachments WHERE exhibitor_id = ? ORDER BY id ASC")
      .bind(exhibitorId)
      .all();
    const photos = all.filter((a) => (a.mime || "").startsWith("image/") &&
      ((a.session_id && a.offset_secs !== null && a.offset_secs !== undefined) || CAPTURE_PHOTO_RE.test(a.caption || "")));
    if (!photos.length) return bad("這家展商沒有帶時間點的採集模式照片（要用「📸 採集模式」拍的才有時間戳）", 404);
    const limit = Number(url.searchParams.get("limit") || 3);
    const out = [];
    for (const p of photos.slice(0, limit)) {
      const ctxInfo = findCaptureContext(all, p);
      const obj = await env.FILES.get(p.key);
      if (!obj) { out.push({ id: p.id, filename: p.filename, error: "找不到檔案本體" }); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      try {
        const r = await extractImageText(env.AI, bytes);
        if (!r.ok) {
          out.push({ id: p.id, filename: p.filename, offset: ctxInfo.offset, text: null, error: r.error, raw_preview: r.raw ? r.raw.slice(0, 200) + "…" : undefined });
          continue;
        }
        const relation = await judgeRelation(env.AI, ctxInfo.transcript, r.text);
        out.push({
          id: p.id,
          filename: p.filename,
          offset: ctxInfo.offset,
          matched_segment: ctxInfo.segment ? `${ctxInfo.segment.filename}（${fmtSecsRange(ctxInfo.start)}–${fmtSecsRange(ctxInfo.end)}）` : null,
          transcript_used: ctxInfo.transcript ? ctxInfo.transcript.slice(0, 200) + (ctxInfo.transcript.length > 200 ? "…" : "") : null,
          text: r.text,
          relation: relation || null,
        });
      } catch (err) {
        out.push({ id: p.id, filename: p.filename, offset: ctxInfo.offset, error: err.message });
      }
    }
    return json({ exhibitor_id: exhibitorId, photo_count: photos.length, results: out });
  }

  return bad("不存在的 API 路徑", 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return handleRequest(request, env, ctx, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyDigest(env).catch((err) => console.error("每日摘要發送失敗", err.message)));
  },
};

async function handleRequest(request, env, ctx, url) {
  if (url.pathname === "/line/webhook" && request.method === "POST") {
    try {
      return await handleLineWebhook(request, env);
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  }

  if (url.pathname.startsWith("/api/")) {
    // PIN 驗證：一律要求正確 PIN；TEAM_PIN 未設定時全部拒絕（fail-closed）
    // trim() 兩邊都做，避免 Secret 貼上時尾端夾帶看不見的換行/空白造成誤判
    const teamPin = (env.TEAM_PIN || "").trim();
    if (!teamPin) {
      return bad("系統尚未設定團隊 PIN：請至 Worker 的 Settings → Variables and Secrets 新增 Secret「TEAM_PIN」", 401);
    }
    const pin = (request.headers.get("x-team-pin") || url.searchParams.get("pin") || "").trim();
    if (pin !== teamPin) return bad("PIN 錯誤或未提供", 401);
    try {
      return await handleApi(request, env, url, ctx);
    } catch (err) {
      return bad(`伺服器錯誤：${err.message}`, 500);
    }
  }

  return env.ASSETS.fetch(request);
}
