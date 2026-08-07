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
 */

export const STAGING_FOLDER_NAME = "⏳ 暫存區（待歸類）";
export const STAGING_FOLDER_ROLE = "staging";
export const STAGING_FOLDER_TYPE = "其他";

// 幾天沒人分類就交給 AI。使用者說「三五天」，取中間值當預設，可用
// Worker 變數 AUTO_FILE_DAYS 調整（夾在 1–30，避免打錯字變成 0 天＝當天就搶著分）。
export const DEFAULT_AUTO_FILE_DAYS = 4;
export const AUTO_FILE_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// 一次排程最多處理幾筆：AI 呼叫要錢也要時間，寧可分幾天跑完也不要單次爆量
export const AUTO_FILE_BATCH = 10;

export function autoFileDays(env = {}) {
  const raw = Number(env.AUTO_FILE_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTO_FILE_DAYS;
  return Math.min(30, Math.max(1, Math.round(raw)));
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
    await db.prepare(
      "UPDATE entries SET folder_id = ?, auto_filed_at = ?, auto_filed_reason = ?, updated_at = ? WHERE id = ?"
    ).bind(choice.folderId, at, choice.reason || "AI 依內容判斷", at, entry.id).run();
    if (typeof logHistory === "function") {
      await logHistory(db, entry.id, choice.folderId, "AI 自動歸類",
        `${entry.title || "（未命名）"} → ${path}；理由：${choice.reason || "未說明"}（放置滿 ${days} 天未分類）`);
    }
    summary.filed++;
  }

  return summary;
}
