/**
 * 暫存區與 AI 自動歸類。
 *
 * 要解決的問題：現場採集當下最缺的就是時間，「先分類再記錄」在展場、實驗室
 * 根本做不到，所以東西一律先落在某個「之後再說」的地方。舊做法是收件匣
 * （folder_id IS NULL），但收件匣空的時候整個面板會從首頁消失，等於沒分類的
 * 東西直接看不見——看不見就不會被處理，堆到最後只能整批放棄。
 *
 * 改成：
 *   1. 來不及分類的一律進「暫存區」（role='staging' 的真資料夾），它跟其他
 *      資料夾一樣出現在首頁，永遠看得到。
 *   2. 放了三～五天還是沒人動的，排程用 AI 依內容挑一個現有資料夾歸進去，
 *      並在記事上標記「這是 AI 分的」（auto_filed_at／auto_filed_reason）。
 *
 * 三個原則：
 *   - AI 只能在**使用者已經建立的資料夾**裡挑，不會自己發明新分類。
 *   - 挑不出來就留在暫存區（標記 'failed'），不亂塞一個「其他」了事。
 *   - 一定留下痕跡：history 一列 ＋ 記事上的 🤖 標記，使用者一眼看得出來
 *     哪些位置是機器決定的，要改隨時能改。
 *
 * 天數不是寫死的規則：一開始用 Worker 環境變數 AUTO_FILE_DAYS 當初始值
 * （2026-08-07 的做法），但那要進 Cloudflare Dashboard 改、重新部署才生效，
 * 一般使用者碰不到，等於「工程說幾天就是幾天」。改成使用者自己在首頁就能
 * 調整（存 settings 表，見 resolveAutoFileDays／saveAutoFileDays），環境變數
 * 只在使用者從未設定過時當退路，不會互相打架。
 */

import { getSetting, setSetting } from "./settings.js";

export const STAGING_FOLDER_NAME = "⏳ 暫存區（待歸類）";
export const STAGING_FOLDER_ROLE = "staging";
export const STAGING_FOLDER_TYPE = "其他";

// settings 表裡存放天數設定的 key
export const AUTO_FILE_DAYS_SETTING_KEY = "auto_file_days";
// 使用者從沒設定過、也沒有環境變數時的起始值
export const DEFAULT_AUTO_FILE_DAYS = 4;
// 天數的合理範圍：太小（0 或負數）會變成「當天就搶著分」，太大則失去「暫存」
// 的意義；上限抓 30 純粹是防呆，不是業務規則
export const AUTO_FILE_DAYS_MIN = 1;
export const AUTO_FILE_DAYS_MAX = 30;
export const AUTO_FILE_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// 一次排程最多處理幾筆：AI 呼叫要錢也要時間，寧可分幾天跑完也不要單次爆量
export const AUTO_FILE_BATCH = 10;

function clampDays(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(AUTO_FILE_DAYS_MAX, Math.max(AUTO_FILE_DAYS_MIN, Math.round(n)));
}

/** 純環境變數版本（不碰資料庫）：部署當下的起始值，或使用者從沒改過設定時的退路 */
export function autoFileDays(env = {}) {
  return clampDays(env.AUTO_FILE_DAYS, DEFAULT_AUTO_FILE_DAYS);
}

/**
 * 真正該用的版本：使用者自己在畫面上調過就用那個值，沒調過才退回
 * 環境變數／預設值。所有讀天數的地方（/staging、/auto-file/status、
 * /auto-file/run、cron）都呼叫這支，不要直接呼叫 autoFileDays()。
 */
export async function resolveAutoFileDays(db, env = {}) {
  const stored = await getSetting(db, AUTO_FILE_DAYS_SETTING_KEY).catch(() => null);
  if (stored !== null && stored !== undefined && stored !== "") {
    return clampDays(stored, autoFileDays(env));
  }
  return autoFileDays(env);
}

/** 使用者在畫面上調整天數：夾在合理範圍內存起來，回傳實際存進去的值 */
export async function saveAutoFileDays(db, days, timestamp) {
  const clamped = clampDays(days, DEFAULT_AUTO_FILE_DAYS);
  await setSetting(db, AUTO_FILE_DAYS_SETTING_KEY, clamped, timestamp);
  return clamped;
}

/** 與 worker.js 的 now() 同格式（"YYYY-MM-DD HH:MM:SSZ"），字串比大小就等於比時間 */
export function cutoffTimestamp(days, nowMs = Date.now()) {
  return new Date(nowMs - days * 86400000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/** 取得（必要時建立）暫存區資料夾。永遠是第 1 層，不掛在任何人底下。 */
export async function ensureStagingFolder(db, timestamp) {
  const existing = await db
    .prepare("SELECT * FROM folders WHERE role = ? LIMIT 1")
    .bind(STAGING_FOLDER_ROLE)
    .first()
    .catch(() => null);
  if (existing) return existing;
  const created = await db
    .prepare("INSERT INTO folders (name, type, parent_id, role, created_at) VALUES (?, ?, NULL, ?, ?)")
    .bind(STAGING_FOLDER_NAME, STAGING_FOLDER_TYPE, STAGING_FOLDER_ROLE, timestamp)
    .run();
  return {
    id: Number(created.meta.last_row_id),
    name: STAGING_FOLDER_NAME,
    type: STAGING_FOLDER_TYPE,
    parent_id: null,
    role: STAGING_FOLDER_ROLE,
    created_at: timestamp,
  };
}

/** 資料夾 id → 完整路徑字串（給 AI 看的選項，也是歷程上寫的目的地） */
export function folderPaths(folders) {
  const byId = new Map(folders.map((f) => [Number(f.id), f]));
  const paths = new Map();
  for (const folder of folders) {
    const parts = [];
    let current = folder;
    const seen = new Set();
    while (current && !seen.has(Number(current.id))) {
      seen.add(Number(current.id));
      parts.unshift(current.name);
      current = current.parent_id ? byId.get(Number(current.parent_id)) : null;
    }
    paths.set(Number(folder.id), parts.join(" / "));
  }
  return paths;
}

/** 這筆記事拿什麼餵給 AI：標題＋內文＋附件檔名與已擷取文字的開頭 */
export function summariseEntry(entry, attachments = [], { plainBody } = {}) {
  const body = typeof plainBody === "function" ? plainBody(entry) : String(entry.body || "");
  const parts = [`標題：${entry.title || "（未命名）"}`];
  if (body.trim()) parts.push(`內文：${body.trim().slice(0, 800)}`);
  for (const a of attachments.slice(0, 5)) {
    const text = String(a.ocr_text || a.transcript || "").trim();
    parts.push(`附件：${a.filename}${text ? `｜內容開頭：${text.slice(0, 300)}` : ""}`);
  }
  return parts.join("\n");
}

/** 從 AI 回覆裡抓出 JSON（模型常會在前後加一句廢話，不能直接 JSON.parse 整串） */
export function parseChoice(text) {
  const raw = String(text || "");
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const folderId = Number(parsed.folder_id ?? parsed.folderId ?? 0);
    if (!Number.isFinite(folderId) || folderId <= 0) return null;
    return { folderId, reason: String(parsed.reason || "").trim().slice(0, 200) };
  } catch {
    return null;
  }
}

export function buildPrompt(summary, choices) {
  const list = choices.map((c) => `${c.id}. ${c.path}（分類：${c.type}）`).join("\n");
  return [
    "你是一個檔案歸檔助理。下面是一筆還沒分類的記事，以及使用者現有的資料夾清單。",
    "請從清單中挑出最適合的一個資料夾。只能挑清單裡有的編號，不可以自己發明分類。",
    "如果內容不足以判斷、或沒有明顯合適的資料夾，folder_id 請回 0。",
    "只輸出 JSON，格式：{\"folder_id\": 數字, \"reason\": \"20 字以內的中文理由\"}",
    "",
    "【資料夾清單】",
    list,
    "",
    "【記事內容】",
    summary,
  ].join("\n");
}

/**
 * 跑一次自動歸類。
 *
 * deps：
 *   ai         — env.AI 之類、有 run(model, input) 的物件；沒有就整個跳過
 *   timestamp  — 產生 "YYYY-MM-DD HH:MM:SSZ" 的函式（用 worker 的 now()）
 *   logHistory — 寫歷程的函式（跟 worker 共用同一支）
 *   plainBody  — 把富文字 body 剝成純文字（worker 傳 htmlToPlainText 包裝）
 */
export async function autoFileStagedEntries(db, {
  ai,
  days = DEFAULT_AUTO_FILE_DAYS,
  limit = AUTO_FILE_BATCH,
  nowMs = Date.now(),
  timestamp,
  logHistory,
  plainBody,
} = {}) {
  const stamp = typeof timestamp === "function" ? timestamp : () => new Date().toISOString();
  const staging = await ensureStagingFolder(db, stamp());
  const summary = { filed: 0, unresolved: 0, checked: 0, staging_folder_id: Number(staging.id), days };

  if (!ai) return { ...summary, skipped: "尚未啟用 Workers AI，自動歸類跳過" };

  const cutoff = cutoffTimestamp(days, nowMs);
  const { results: candidates } = await db.prepare(
    `SELECT id, folder_id, title, body, body_format, fields_json, created_at
     FROM entries
     WHERE (folder_id IS NULL OR folder_id = ?)
       AND COALESCE(auto_filed_at, '') = ''
       AND created_at <= ?
     ORDER BY id LIMIT ?`
  ).bind(Number(staging.id), cutoff, limit).all();

  if (!candidates?.length) return summary;

  const { results: folders } = await db.prepare(
    "SELECT id, name, type, parent_id, COALESCE(role, '') AS role FROM folders"
  ).all();
  // 暫存區本身不能當目的地（把東西從暫存區歸到暫存區＝什麼也沒做）
  const targets = (folders || []).filter((f) => String(f.role || "") !== STAGING_FOLDER_ROLE);
  if (!targets.length) return { ...summary, skipped: "還沒有任何可歸檔的資料夾" };
  const paths = folderPaths(folders || []);
  const choices = targets.map((f) => ({ id: Number(f.id), path: paths.get(Number(f.id)) || f.name, type: f.type }));
  const allowed = new Set(choices.map((c) => c.id));

  for (const entry of candidates) {
    summary.checked++;
    // 外部來源同步管理的記事有自己的歸屬（sync.js 會放進來源資料夾），不插手
    let fields = {};
    try { fields = JSON.parse(entry.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
    if (fields._sid || fields.litdb_id) continue;

    const { results: atts } = await db.prepare(
      "SELECT filename, COALESCE(ocr_text, '') AS ocr_text, COALESCE(transcript, '') AS transcript FROM attachments WHERE entry_id = ? ORDER BY id LIMIT 5"
    ).bind(entry.id).all();

    let choice = null;
    try {
      const result = await ai.run(AUTO_FILE_MODEL, {
        messages: [{ role: "user", content: buildPrompt(summariseEntry(entry, atts || [], { plainBody }), choices) }],
        max_tokens: 200,
      });
      choice = parseChoice(result?.response ?? result?.result?.response ?? result);
    } catch {
      choice = null; // AI 掛掉不能讓整批停下來，這一筆留在暫存區下次再試
    }

    if (!choice || !allowed.has(choice.folderId)) {
      summary.unresolved++;
      await db.prepare("UPDATE entries SET auto_filed_at = 'failed', auto_filed_reason = ? WHERE id = ?")
        .bind("AI 判斷不出合適的資料夾，留在暫存區", entry.id).run();
      continue;
    }

    const at = stamp();
    const path = paths.get(choice.folderId) || "";
    // 刻意不寫 updated_at：那是「首頁最近作業」排序用的欄位，意義是「使用者
    // 最後動過這筆的時間」。AI 自動歸類是背景排程，不是使用者這一刻在做的事——
    // 如果連帶把 updated_at 蓋成現在，會讓一批好幾天前建立、使用者早就沒再碰
    // 的舊記事，只因為被排程掃到，就集體跳回「最近作業」最上面，看起來像是
    // 一堆「舊資料還是排在前面」，而且完全看不出原因（2026-08-09 實際回報）。
    // 有沒有被 AI 動過，看 auto_filed_at 就夠了，不需要也去動 updated_at。
    await db.prepare(
      "UPDATE entries SET folder_id = ?, auto_filed_at = ?, auto_filed_reason = ? WHERE id = ?"
    ).bind(choice.folderId, at, choice.reason || "AI 依內容判斷", entry.id).run();
    if (typeof logHistory === "function") {
      await logHistory(db, entry.id, choice.folderId, "AI 自動歸類",
        `${entry.title || "（未命名）"} → ${path}；理由：${choice.reason || "未說明"}（放置滿 ${days} 天未分類）`);
    }
    summary.filed++;
  }

  return summary;
}
