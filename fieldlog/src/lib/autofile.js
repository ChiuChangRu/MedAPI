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
// 天數的合理範圍。0 是刻意允許的合法值——代表「不等待，全部立即歸檔」，
// 之前把 0 當成打錯字擋掉，等於沒有「馬上全部歸類」這個選項；負數／非數字
// 才是真的打錯字，退回預設值。上限抓 30 純粹是防呆，不是業務規則。
export const AUTO_FILE_DAYS_MIN = 0;
export const AUTO_FILE_DAYS_MAX = 30;
export const AUTO_FILE_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// 一次排程最多處理幾筆：AI 呼叫要錢也要時間，寧可分幾天跑完也不要單次爆量
export const AUTO_FILE_BATCH = 10;

function clampDays(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
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

/** hints：{ folder_id, keyword, path } 陣列，已知的「關鍵字→資料夾」判斷規則 */
export function buildPrompt(summary, choices, hints = []) {
  const list = choices.map((c) => `${c.id}. ${c.path}（分類：${c.type}）`).join("\n");
  const hintBlock = hints.length
    ? [
        "",
        "【已知的關鍵字對照，內容包含這些詞時優先參考，但明顯不符合就不用採用】",
        ...hints.map((h) => `- 「${h.keyword}」→ ${h.path || h.folder_id}`),
      ]
    : [];
  return [
    "你是一個檔案歸檔助理。下面是一筆還沒分類的記事，以及使用者現有的資料夾清單。",
    "請從清單中挑出最適合的一個資料夾。只能挑清單裡有的編號，不可以自己發明分類。",
    "如果內容不足以判斷、或沒有明顯合適的資料夾，folder_id 請回 0。",
    "只輸出 JSON，格式：{\"folder_id\": 數字, \"reason\": \"20 字以內的中文理由\"}",
    "",
    "【資料夾清單】",
    list,
    ...hintBlock,
    "",
    "【記事內容】",
    summary,
  ].join("\n");
}

// ---------- 分類規則（keyword → folder_id）：判斷準則會自己長，但一定要人核准 ----------
//
// 設計取捨：不做「AI 自動幫你猜關鍵字」——猜錯的關鍵字比沒有關鍵字更糟（會
// 誤判本來判斷得出來的案例）。規則永遠是「使用者自己看過候選、自己填詞」，
// 系統只負責偵測「這個資料夾最近被手動修正了好幾次，可能值得設一條規則」
// 這個訊號，跟 MyWiki 的 add_synonym（同義詞永遠是人補的，AI 只負責發現
// 查不到）是同一種分工。

/** 目前生效中、實際會拿去比對與塞進 prompt 的規則 */
export async function getActiveHints(db) {
  const { results } = await db.prepare(
    "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'active' ORDER BY id"
  ).all();
  return results || [];
}

/** 還在等使用者決定要不要採用的候選規則（首頁通知用） */
export async function getPendingHints(db) {
  const { results } = await db.prepare(
    "SELECT id, folder_id, keyword, note, created_at FROM autofile_hints WHERE status = 'suggested' ORDER BY id"
  ).all();
  return results || [];
}

/**
 * 新增一條規則：使用者自己在畫面上補的，或候選規則被採用時直接帶關鍵字寫入。
 * 只有 status='suggested' 允許先不填關鍵字——候選規則本來就是「留給使用者
 * 補關鍵字」用的（見 reviewAutoFileCorrections／approveHint），active 規則
 * 沒有關鍵字等於永遠不會命中，沒有意義，一律擋掉。
 */
export async function addHint(db, { folderId, keyword, status = "active", note = "" }, timestamp) {
  const kw = String(keyword || "").trim();
  if (!folderId) return null;
  if (!kw && status !== "suggested") return null;
  const r = await db.prepare(
    "INSERT INTO autofile_hints (folder_id, keyword, status, note, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(Number(folderId), kw, status, note, timestamp).run();
  return Number(r.meta.last_row_id);
}

/** 採用候選規則：候選規則建立時通常還沒有關鍵字（見 reviewAutoFileCorrections），
 * 使用者在畫面上補上關鍵字、按「採用」時才真正變成 active。 */
export async function approveHint(db, id, keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return false;
  const r = await db.prepare("UPDATE autofile_hints SET keyword = ?, status = 'active' WHERE id = ? AND status = 'suggested'")
    .bind(kw, Number(id)).run();
  return !!r.meta.changes;
}

/** 不管是候選規則還是已生效的規則，都能直接刪掉——判斷準則要能隨時修正 */
export async function deleteHint(db, id) {
  const r = await db.prepare("DELETE FROM autofile_hints WHERE id = ?").bind(Number(id)).run();
  return !!r.meta.changes;
}

/**
 * 拿記事摘要文字去跟現有規則比對。只有「唯一命中一個資料夾」才當高信心結果
 * 直接採用——同時命中不同資料夾的規則，代表規則彼此打架，這種情況寧可退回
 * 給 AI（或留在暫存區），不猜哪一條該優先，避免把使用者還沒發現的規則衝突
 * 悄悄用掉。
 */
export function matchHints(hints, summary, allowedFolderIds) {
  const text = String(summary || "").toLowerCase();
  const hit = new Map(); // folderId -> 命中的規則
  for (const h of hints) {
    const folderId = Number(h.folder_id);
    if (!allowedFolderIds.has(folderId)) continue; // 規則指到的資料夾被刪了或已是暫存區，跳過
    const kw = String(h.keyword || "").trim().toLowerCase();
    if (kw && text.includes(kw)) hit.set(folderId, h);
  }
  if (hit.size !== 1) return null;
  const [[folderId, hint]] = [...hit.entries()];
  return { folderId, keyword: hint.keyword };
}

// 同一個資料夾要累積這麼多次手動修正，才值得跳出來問「要不要設關鍵字」——
// 只發生一次太可能是個案，不該一有動靜就跳通知打擾使用者。
export const AUTOFILE_HINT_MIN_OCCURRENCES = 2;

/** 記一筆「AI（或規則）分錯，使用者手動搬去別的資料夾」，排程靠這個彙整候選規則 */
export async function recordAutoFileCorrection(db, { entryId, fromFolderId, toFolderId, entryTitle, timestamp }) {
  await db.prepare(
    "INSERT INTO autofile_corrections (entry_id, from_folder_id, to_folder_id, keyword_guess, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(Number(entryId), fromFolderId ? Number(fromFolderId) : null, Number(toFolderId),
    String(entryTitle || "").trim().slice(0, 60), timestamp).run();
}

/**
 * 每天排程跑一次：把還沒處理過的修正紀錄，依「搬去了哪個資料夾」分組，同一個
 * 資料夾累積到 AUTOFILE_HINT_MIN_OCCURRENCES 次以上、而且還沒有候選規則在等
 * 的話，建一條 status='suggested' 的候選規則（關鍵字先留空，見 approveHint）。
 * 候選規則不會自己生效，一定要通知使用者、讓人在畫面上補關鍵字採用。
 */
export async function reviewAutoFileCorrections(db, { timestamp } = {}) {
  const stamp = typeof timestamp === "function" ? timestamp : () => new Date().toISOString();
  const { results: pending } = await db.prepare(
    "SELECT id FROM autofile_corrections WHERE COALESCE(reviewed_at, '') = ''"
  ).all();
  const result = { reviewed: 0, suggested: 0 };
  if (!pending?.length) return result;

  const { results: existingHints } = await db.prepare(
    "SELECT DISTINCT folder_id FROM autofile_hints WHERE status IN ('active', 'suggested') AND (keyword = '' OR keyword IS NULL)"
  ).all();
  const alreadySuggested = new Set((existingHints || []).map((h) => Number(h.folder_id)));

  // 門檻要看「這個資料夾這輩子總共累積了幾次修正」，不能只看這次排程剛好還
  // 沒處理過的那幾筆——不然某一天沒湊滿門檻、那幾筆就被標記「已看過」，隔天
  // 新增的修正單獨來看又不夠門檻，永遠湊不滿，規則就永遠長不出來。
  const { results: allForFolders } = await db.prepare(
    "SELECT to_folder_id, keyword_guess FROM autofile_corrections"
  ).all();
  const byFolder = new Map(); // folderId -> [entryTitle, ...]
  for (const c of allForFolders || []) {
    const folderId = Number(c.to_folder_id);
    if (!byFolder.has(folderId)) byFolder.set(folderId, []);
    if (c.keyword_guess) byFolder.get(folderId).push(c.keyword_guess);
  }

  const at = stamp();
  for (const c of pending) {
    result.reviewed++;
    await db.prepare("UPDATE autofile_corrections SET reviewed_at = ? WHERE id = ?").bind(at, c.id).run();
  }
  for (const [folderId, titles] of byFolder) {
    if (titles.length < AUTOFILE_HINT_MIN_OCCURRENCES || alreadySuggested.has(folderId)) continue;
    const examples = titles.slice(0, 3).map((t) => `「${t}」`).join("、");
    await addHint(db, {
      folderId,
      keyword: "", // 故意留空——關鍵字要人自己填，見 approveHint
      status: "suggested",
      note: `最近有 ${titles.length} 筆記事被手動搬進這個資料夾，例如 ${examples}；要不要幫它設一個關鍵字，之後類似內容自動歸檔？`,
    }, at);
    result.suggested++;
  }
  return result;
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

  // 沒開 Workers AI 時，只有在「已經有生效中的規則」才值得繼續往下跑——規則
  // 比對完全不需要 AI。沒有規則、也沒有 AI，跟以前一樣直接跳過，不掃資料庫。
  const activeHints = ai ? null : await getActiveHints(db);
  if (!ai && !activeHints.length) return { ...summary, skipped: "尚未啟用 Workers AI，自動歸類跳過" };

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
  const hints = (activeHints ?? await getActiveHints(db))
    .filter((h) => allowed.has(Number(h.folder_id)))
    .map((h) => ({ ...h, path: paths.get(Number(h.folder_id)) || "" }));

  for (const entry of candidates) {
    summary.checked++;
    // 外部來源同步管理的記事有自己的歸屬（sync.js 會放進來源資料夾），不插手
    let fields = {};
    try { fields = JSON.parse(entry.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
    if (fields._sid || fields.litdb_id) continue;

    const { results: atts } = await db.prepare(
      "SELECT filename, COALESCE(ocr_text, '') AS ocr_text, COALESCE(transcript, '') AS transcript FROM attachments WHERE entry_id = ? ORDER BY id LIMIT 5"
    ).bind(entry.id).all();

    const summaryText = summariseEntry(entry, atts || [], { plainBody });
    // 先用已知規則比對：唯一命中才直接採用，不用每筆都呼叫 AI——更快、更省
    // 額度，而且判斷理由是講得出道理的規則，不是模型的黑箱猜測。
    const ruleHit = matchHints(hints, summaryText, allowed);
    let choice = ruleHit ? { folderId: ruleHit.folderId, reason: `符合已知規則「${ruleHit.keyword}」` } : null;

    if (!choice && ai) {
      try {
        const result = await ai.run(AUTO_FILE_MODEL, {
          messages: [{ role: "user", content: buildPrompt(summaryText, choices, hints) }],
          max_tokens: 200,
        });
        choice = parseChoice(result?.response ?? result?.result?.response ?? result);
      } catch {
        choice = null; // AI 掛掉不能讓整批停下來，這一筆留在暫存區下次再試
      }
    }

    if (!choice || !allowed.has(choice.folderId)) {
      summary.unresolved++;
      await db.prepare("UPDATE entries SET auto_filed_at = 'failed', auto_filed_reason = ? WHERE id = ?")
        .bind(ai ? "AI 判斷不出合適的資料夾，留在暫存區" : "沒有符合的已知規則，留在暫存區", entry.id).run();
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
