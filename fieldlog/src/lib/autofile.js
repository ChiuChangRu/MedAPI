/**
 * 待分類區。
 *
 * 要解決的問題：現場採集當下最缺的就是時間，「先分類再記錄」在展場、實驗室
 * 根本做不到，所以東西一律先落在某個「之後再說」的地方。舊做法是收件匣
 * （folder_id IS NULL），但收件匣空的時候整個面板會從首頁消失，等於沒分類的
 * 東西直接看不見——看不見就不會被處理，堆到最後只能整批放棄。
 *
 * 改成：來不及分類的一律進「待分類」（role='staging' 的系統容器）。它不顯示
 * 在四層資料夾樹裡，但內容固定出現在首頁待分類清單，使用者之後再移動。
 *
 * 2026-08-24 起恢復成 B 模式：固定規則先判斷，Vectorize 找相似的既有記事，
 * 規則無法判定時才由 Cloudflare Workers AI 從「既有資料夾 ID」中選擇。
 * 高信心且向量／AI 一致才自動搬；其他只留建議，不刪除、不建資料夾、
 * 不修改第一層架構。人工確認與修正都會留下可追溯紀錄。
 */

import { htmlToPlainText } from "./richtext.js";

export const STAGING_FOLDER_NAME = "⏳ 待分類";
export const STAGING_FOLDER_ROLE = "staging";
export const STAGING_FOLDER_TYPE = "其他";
export const AUTOFILING_EMBED_MODEL = "@cf/baai/bge-m3";
export const AUTOFILING_DECISION_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const AUTOFILING_DAILY_LIMIT = 25;

const AUTO_VECTOR_MIN = 0.72;
const AUTO_VECTOR_MARGIN = 0.06;
const SUGGESTION_MIN = 0.55;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return compactText(value).toLowerCase().replace(/[\s｜|／/_-]+/g, "");
}

function parseAiDecision(result) {
  const raw = compactText(result?.response || result?.result?.response || "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { folderId: null, reason: "AI 未回傳可驗證的 JSON" };
  try {
    const parsed = JSON.parse(match[0]);
    const folderId = parsed.folder_id === null ? null : Number(parsed.folder_id || 0) || null;
    return { folderId, reason: compactText(parsed.reason || "") };
  } catch {
    return { folderId: null, reason: "AI 回傳格式無法解析" };
  }
}

function buildFolderPaths(folders) {
  const byId = new Map(folders.map((folder) => [Number(folder.id), folder]));
  const pathOf = (folder) => {
    const names = [];
    const seen = new Set();
    let current = folder;
    while (current && !seen.has(Number(current.id))) {
      seen.add(Number(current.id));
      names.unshift(current.name);
      current = current.parent_id ? byId.get(Number(current.parent_id)) : null;
    }
    return names.join(" ／ ");
  };
  return folders.map((folder) => ({ ...folder, path: pathOf(folder) }));
}

function exactRuleMatch(text, folders, hints) {
  const normalizedText = normalizeMatchText(text);
  if (!normalizedText) return null;
  const scores = new Map();
  const reasons = new Map();
  for (const hint of hints || []) {
    const keyword = normalizeMatchText(hint.keyword);
    if (keyword.length < 2 || !normalizedText.includes(keyword)) continue;
    const id = Number(hint.folder_id);
    scores.set(id, (scores.get(id) || 0) + 4);
    reasons.set(id, `命中已確認規則「${hint.keyword}」`);
  }
  for (const folder of folders) {
    const name = normalizeMatchText(folder.name);
    if (name.length < 2 || !normalizedText.includes(name)) continue;
    const id = Number(folder.id);
    scores.set(id, (scores.get(id) || 0) + 2);
    if (!reasons.has(id)) reasons.set(id, `內容直接出現資料夾名稱「${folder.name}」`);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[0][1] === ranked[1][1])) return null;
  return { folderId: ranked[0][0], score: ranked[0][1], reason: reasons.get(ranked[0][0]) || "固定規則唯一命中" };
}

/**
 * B 模式的決策器是純函式，方便用測試鎖住安全邊界：
 * - 明確人工規則／唯一名稱命中可以直接搬。
 * - 向量與 AI 必須選到同一資料夾，且分數、差距都過門檻才自動搬。
 * - AI 單獨判斷永遠只能成為待確認建議。
 */
export function decideHybridFiling({ rule, vector, aiFolderId }) {
  if (rule?.folderId) {
    return { action: "auto", folderId: Number(rule.folderId), confidence: 0.99, basis: "rule", reason: rule.reason };
  }
  const vectorFolderId = Number(vector?.folderId || 0) || null;
  const vectorScore = clamp01(vector?.score);
  const vectorMargin = Math.max(0, Number(vector?.margin || 0));
  const aiId = Number(aiFolderId || 0) || null;
  if (vectorFolderId && aiId === vectorFolderId) {
    const confidence = clamp01(vectorScore + Math.min(0.12, vectorMargin / 2) + 0.08);
    const action = vectorScore >= AUTO_VECTOR_MIN && vectorMargin >= AUTO_VECTOR_MARGIN ? "auto" : "suggest";
    return { action, folderId: vectorFolderId, confidence, basis: "vector+ai", reason: "語意相似結果與 AI 判斷一致" };
  }
  if (aiId) {
    return { action: "suggest", folderId: aiId, confidence: 0.6, basis: "ai", reason: "AI 有建議，但缺少向量結果交叉確認" };
  }
  if (vectorFolderId && vectorScore >= SUGGESTION_MIN) {
    return { action: "suggest", folderId: vectorFolderId, confidence: Math.min(0.69, vectorScore), basis: "vector", reason: "只有語意相似結果，等待人工確認" };
  }
  return { action: "unresolved", folderId: null, confidence: 0, basis: "none", reason: "規則、向量與 AI 都無法可靠判定" };
}

/** 取得（必要時建立）待分類系統容器；它不計入四層資料夾架構。 */
export async function ensureStagingFolder(db, timestamp) {
  const existing = await db
    .prepare("SELECT * FROM folders WHERE role = ? LIMIT 1")
    .bind(STAGING_FOLDER_ROLE)
    .first()
    .catch(() => null);
  if (existing) {
    if (existing.name !== STAGING_FOLDER_NAME || existing.type !== STAGING_FOLDER_TYPE || existing.parent_id) {
      await db.prepare("UPDATE folders SET name = ?, type = ?, parent_id = NULL WHERE id = ?")
        .bind(STAGING_FOLDER_NAME, STAGING_FOLDER_TYPE, existing.id)
        .run();
      return { ...existing, name: STAGING_FOLDER_NAME, type: STAGING_FOLDER_TYPE, parent_id: null };
    }
    return existing;
  }
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

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function embeddingVector(result) {
  return result?.data?.[0] || result?.result?.data?.[0] || null;
}

function entryContent(entry, attachments) {
  let fields = "";
  try {
    const parsed = JSON.parse(entry.fields_json || "{}");
    fields = Object.entries(parsed)
      .filter(([key, value]) => !key.startsWith("_") && value !== null && value !== "")
      .map(([key, value]) => `${key}：${Array.isArray(value) ? value.join("、") : String(value)}`)
      .join("\n");
  } catch {
    fields = entry.fields_json || "";
  }
  const body = entry.body_format === "html" ? htmlToPlainText(entry.body || "") : (entry.body || "");
  const attachmentText = (attachments || []).map((attachment) => [
    attachment.original_filename || attachment.filename,
    attachment.note,
    attachment.ocr_text,
    attachment.transcript,
  ].filter(Boolean).join("\n")).join("\n");
  return [entry.title, fields, body, attachmentText].map(compactText).filter(Boolean).join("\n").slice(0, 8000);
}

async function vectorFolderSuggestion(env, runAi, content, entryId, allowedFolderIds) {
  if (!env.VECTOR_INDEX || !runAi || !content) return null;
  const embedded = await runAi(AUTOFILING_EMBED_MODEL, { text: content.slice(0, 3000) });
  const vector = embeddingVector(embedded);
  if (!Array.isArray(vector) || !vector.length) return null;
  const query = await env.VECTOR_INDEX.query(vector, { topK: 24, returnMetadata: true });
  const bestEntryScores = new Map();
  for (const match of query?.matches || []) {
    const matchedEntryId = Number(match?.metadata?.entryId || 0);
    if (!matchedEntryId || matchedEntryId === Number(entryId)) continue;
    const score = clamp01(match.score);
    if (score > (bestEntryScores.get(matchedEntryId) || 0)) bestEntryScores.set(matchedEntryId, score);
  }
  const entryIds = [...bestEntryScores.keys()].slice(0, 24);
  if (!entryIds.length) return null;
  const placeholders = entryIds.map(() => "?").join(",");
  const rows = resultRows(await env.DB.prepare(
    `SELECT id, folder_id FROM entries
     WHERE id IN (${placeholders}) AND parent_entry_id IS NULL
       AND COALESCE(deleted_at, '') = '' AND folder_id IS NOT NULL`
  ).bind(...entryIds).all());
  const bestByFolder = new Map();
  for (const row of rows) {
    const folderId = Number(row.folder_id || 0);
    if (!allowedFolderIds.has(folderId)) continue;
    const score = bestEntryScores.get(Number(row.id)) || 0;
    if (score > (bestByFolder.get(folderId) || 0)) bestByFolder.set(folderId, score);
  }
  const ranked = [...bestByFolder.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return {
    folderId: ranked[0][0],
    score: ranked[0][1],
    margin: ranked[0][1] - (ranked[1]?.[1] || 0),
  };
}

async function aiFolderSuggestion(runAi, content, folders, vector) {
  if (!runAi || !content || !folders.length) return { folderId: null, reason: "Workers AI 未配置" };
  const ranked = [...folders].sort((a, b) => {
    if (Number(a.id) === Number(vector?.folderId)) return -1;
    if (Number(b.id) === Number(vector?.folderId)) return 1;
    return a.path.localeCompare(b.path, "zh-Hant");
  });
  const candidateLines = ranked
    .map((folder) => `${folder.id}\t${folder.path}\t${folder.type || "其他"}`)
    .join("\n")
    .slice(0, 7000);
  const result = await runAi(AUTOFILING_DECISION_MODEL, {
    messages: [
      {
        role: "system",
        content: "你是企業知識庫分類器。只能從提供的既有資料夾 ID 選一個；資訊不足就回傳 null。禁止建立、刪除、改名或臆造資料夾。只回傳 JSON：{\"folder_id\":number|null,\"reason\":\"繁體中文短理由\"}",
      },
      {
        role: "user",
        content: `待分類內容：\n${content.slice(0, 4500)}\n\n可選資料夾（ID、路徑、類型）：\n${candidateLines}`,
      },
    ],
    temperature: 0,
    max_tokens: 160,
  });
  return parseAiDecision(result);
}

async function saveSuggestion(db, data) {
  await db.prepare(
    `INSERT INTO filing_suggestions
       (entry_id, suggested_folder_id, previous_folder_id, ai_folder_id, vector_folder_id,
        confidence, vector_score, status, basis, reason, source_updated_at, created_at, updated_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       suggested_folder_id = excluded.suggested_folder_id,
       previous_folder_id = excluded.previous_folder_id,
       ai_folder_id = excluded.ai_folder_id,
       vector_folder_id = excluded.vector_folder_id,
       confidence = excluded.confidence,
       vector_score = excluded.vector_score,
       status = excluded.status,
       basis = excluded.basis,
       reason = excluded.reason,
       source_updated_at = excluded.source_updated_at,
       updated_at = excluded.updated_at,
       reviewed_at = excluded.reviewed_at`
  ).bind(
    data.entryId, data.folderId, data.previousFolderId, data.aiFolderId, data.vectorFolderId,
    data.confidence, data.vectorScore, data.status, data.basis, data.reason,
    data.sourceUpdatedAt, data.timestamp, data.timestamp, data.reviewedAt || ""
  ).run();
}

async function evaluateFiling(env, runAi, content, entryId, folders, hints, allowedFolderIds) {
  const rule = exactRuleMatch(content, folders, hints);
  let vector = null;
  let ai = { folderId: null, reason: "" };
  if (!rule) {
    try {
      vector = await vectorFolderSuggestion(env, runAi, content, entryId, allowedFolderIds);
    } catch (error) {
      ai.reason = `向量判定失敗：${compactText(error?.message || error)}`;
    }
    try {
      const aiResult = await aiFolderSuggestion(runAi, content, folders, vector);
      ai = { ...aiResult, reason: [ai.reason, aiResult.reason].filter(Boolean).join("；") };
    } catch (error) {
      ai = { folderId: null, reason: [ai.reason, `AI 判定失敗：${compactText(error?.message || error)}`].filter(Boolean).join("；") };
    }
    if (ai.folderId && !allowedFolderIds.has(Number(ai.folderId))) {
      ai = { folderId: null, reason: "AI 回傳的資料夾 ID 不在白名單" };
    }
  }
  const decision = decideHybridFiling({ rule, vector, aiFolderId: ai.folderId });
  const reason = compactText([decision.reason, ai.reason].filter(Boolean).join("；")).slice(0, 500);
  return { decision, vector, ai, reason };
}

/**
 * 每日 B 模式分類。只讀取待分類容器中，內容版本戳記改變過的根記事。
 * 每筆獨立失敗、獨立記錄，單一檔案壞掉不會讓整批中止。
 */
export async function runHybridAutofile(env, {
  timestamp,
  runAi,
  logHistory,
  dailyLimit = AUTOFILING_DAILY_LIMIT,
} = {}) {
  if (!env?.DB) throw new Error("缺少 D1 DB binding");
  const stamp = typeof timestamp === "function" ? timestamp : () => String(timestamp || new Date().toISOString());
  const startedAt = stamp();
  const staging = await ensureStagingFolder(env.DB, startedAt);
  const folders = buildFolderPaths(resultRows(await env.DB.prepare(
    `SELECT id, name, type, parent_id FROM folders
     WHERE COALESCE(deleted_at, '') = '' AND COALESCE(role, '') = ''
     ORDER BY parent_id IS NOT NULL, parent_id, id`
  ).all()));
  const allowedFolderIds = new Set(folders.map((folder) => Number(folder.id)));
  const hints = resultRows(await env.DB.prepare(
    "SELECT folder_id, keyword FROM autofile_hints WHERE status = 'active'"
  ).all()).filter((hint) => allowedFolderIds.has(Number(hint.folder_id)));
  const sourceStamp = `COALESCE(NULLIF(e.updated_at, ''), e.created_at) || ':' || COALESCE((
    SELECT MAX(COALESCE(NULLIF(a.ocr_at, ''), NULLIF(a.transcribed_at, ''), a.created_at))
    FROM attachments a WHERE a.entry_id = e.id
  ), '')`;
  const candidates = resultRows(await env.DB.prepare(
    `SELECT * FROM (
       SELECT e.id, e.folder_id, e.title, e.fields_json, e.body, e.body_format,
              ${sourceStamp} AS source_stamp,
              COALESCE(s.source_updated_at, '') AS previous_source_stamp
       FROM entries e
       LEFT JOIN filing_suggestions s ON s.entry_id = e.id
       WHERE e.folder_id = ? AND e.parent_entry_id IS NULL AND COALESCE(e.deleted_at, '') = ''
     ) pending
     WHERE previous_source_stamp <> source_stamp OR previous_source_stamp = ''
     ORDER BY id ASC LIMIT ?`
  ).bind(Number(staging.id), Math.min(100, Math.max(1, Number(dailyLimit) || AUTOFILING_DAILY_LIMIT))).all());
  const attachmentsByEntry = new Map();
  if (candidates.length) {
    const ids = candidates.map((entry) => Number(entry.id));
    const placeholders = ids.map(() => "?").join(",");
    const attachments = resultRows(await env.DB.prepare(
      `SELECT entry_id, filename, original_filename, note, ocr_text, transcript
       FROM attachments WHERE entry_id IN (${placeholders}) ORDER BY id`
    ).bind(...ids).all());
    for (const attachment of attachments) {
      const list = attachmentsByEntry.get(Number(attachment.entry_id)) || [];
      list.push(attachment);
      attachmentsByEntry.set(Number(attachment.entry_id), list);
    }
  }
  const outcome = { checked: 0, auto_moved: 0, suggested: 0, unresolved: 0, errors: 0 };
  for (const entry of candidates) {
    outcome.checked++;
    const entryId = Number(entry.id);
    const content = entryContent(entry, attachmentsByEntry.get(entryId));
    try {
      const { decision, vector, ai, reason } = await evaluateFiling(
        env, runAi, content, entryId, folders, hints, allowedFolderIds
      );
      const decidedAt = stamp();
      if (decision.action === "auto") {
        const moved = await env.DB.prepare(
          `UPDATE entries SET folder_id = ?, parent_entry_id = NULL, auto_filed_at = ?,
             auto_filed_reason = ?, updated_at = ?
           WHERE id = ? AND folder_id = ? AND COALESCE(deleted_at, '') = ''`
        ).bind(decision.folderId, decidedAt, reason, decidedAt, entryId, Number(staging.id)).run();
        if (!moved?.meta?.changes) continue;
        await saveSuggestion(env.DB, {
          entryId, folderId: decision.folderId, previousFolderId: Number(staging.id),
          aiFolderId: ai.folderId, vectorFolderId: vector?.folderId || null,
          confidence: decision.confidence, vectorScore: vector?.score || 0,
          status: "auto_applied", basis: decision.basis, reason,
          sourceUpdatedAt: entry.source_stamp, timestamp: decidedAt,
        });
        if (logHistory) await logHistory(env.DB, entryId, decision.folderId, "AI 自動分類", `${reason}（信心 ${Math.round(decision.confidence * 100)}%）`);
        outcome.auto_moved++;
      } else {
        const status = decision.action === "suggest" ? "pending" : "unresolved";
        // 舊版可能留著 auto_filed_at='failed'。B 模式已用 filing_suggestions.status
        // 表達未解／待確認，先清掉舊標記，避免前臺同時顯示「失敗」與新建議。
        await env.DB.prepare(
          "UPDATE entries SET auto_filed_at = '', auto_filed_reason = '' WHERE id = ? AND folder_id = ?"
        ).bind(entryId, Number(staging.id)).run();
        await saveSuggestion(env.DB, {
          entryId, folderId: decision.folderId, previousFolderId: Number(staging.id),
          aiFolderId: ai.folderId, vectorFolderId: vector?.folderId || null,
          confidence: decision.confidence, vectorScore: vector?.score || 0,
          status, basis: decision.basis, reason,
          sourceUpdatedAt: entry.source_stamp, timestamp: decidedAt,
        });
        if (status === "pending") outcome.suggested++;
        else outcome.unresolved++;
      }
    } catch (error) {
      outcome.errors++;
      console.error(JSON.stringify({ event: "hybrid_autofile_item_failed", entry_id: entryId, error: error?.message || String(error) }));
    }
  }
  return outcome;
}

/**
 * 使用者明確下令時才執行的「既有母體一次性整理」。它不掛 cron、不處理
 * 已有 filing_suggestions 紀錄或歷史 AI 標記的記事；每筆正式記事最多評估一次。
 * 只有跟日常 B 模式相同的高信心 auto 決策，而且目的地不同，才會真的搬動。
 */
export async function runBaselineFilingReview(env, {
  timestamp,
  runAi,
  logHistory,
  limit = AUTOFILING_DAILY_LIMIT,
} = {}) {
  if (!env?.DB) throw new Error("缺少 D1 DB binding");
  const stamp = typeof timestamp === "function" ? timestamp : () => String(timestamp || new Date().toISOString());
  const folders = buildFolderPaths(resultRows(await env.DB.prepare(
    `SELECT id, name, type, parent_id FROM folders
     WHERE COALESCE(deleted_at, '') = '' AND COALESCE(role, '') = ''
     ORDER BY parent_id IS NOT NULL, parent_id, id`
  ).all()));
  const allowedFolderIds = new Set(folders.map((folder) => Number(folder.id)));
  const hints = resultRows(await env.DB.prepare(
    "SELECT folder_id, keyword FROM autofile_hints WHERE status = 'active'"
  ).all()).filter((hint) => allowedFolderIds.has(Number(hint.folder_id)));
  const candidates = resultRows(await env.DB.prepare(
    `SELECT e.id, e.folder_id, e.title, e.fields_json, e.body, e.body_format,
            COALESCE(NULLIF(e.updated_at, ''), e.created_at) || ':' || COALESCE((
              SELECT MAX(COALESCE(NULLIF(a.ocr_at, ''), NULLIF(a.transcribed_at, ''), a.created_at))
              FROM attachments a WHERE a.entry_id = e.id
            ), '') AS source_stamp
     FROM entries e
     JOIN folders f ON f.id = e.folder_id
     LEFT JOIN filing_suggestions s ON s.entry_id = e.id
     WHERE e.parent_entry_id IS NULL AND COALESCE(e.deleted_at, '') = ''
       AND COALESCE(f.deleted_at, '') = '' AND COALESCE(f.role, '') = ''
       AND COALESCE(e.auto_filed_at, '') = '' AND s.entry_id IS NULL
     ORDER BY e.id ASC LIMIT ?`
  ).bind(Math.min(100, Math.max(1, Number(limit) || AUTOFILING_DAILY_LIMIT))).all());
  const attachmentsByEntry = new Map();
  if (candidates.length) {
    const ids = candidates.map((entry) => Number(entry.id));
    const placeholders = ids.map(() => "?").join(",");
    const attachments = resultRows(await env.DB.prepare(
      `SELECT entry_id, filename, original_filename, note, ocr_text, transcript
       FROM attachments WHERE entry_id IN (${placeholders}) ORDER BY id`
    ).bind(...ids).all());
    for (const attachment of attachments) {
      const list = attachmentsByEntry.get(Number(attachment.entry_id)) || [];
      list.push(attachment);
      attachmentsByEntry.set(Number(attachment.entry_id), list);
    }
  }
  const outcome = { checked: 0, moved: 0, kept: 0, suggested: 0, unresolved: 0, errors: 0, remaining: 0 };
  for (const entry of candidates) {
    outcome.checked++;
    const entryId = Number(entry.id);
    const previousFolderId = Number(entry.folder_id);
    try {
      const content = entryContent(entry, attachmentsByEntry.get(entryId));
      const { decision, vector, ai, reason } = await evaluateFiling(
        env, runAi, content, entryId, folders, hints, allowedFolderIds
      );
      const reviewedAt = stamp();
      const targetDiffers = decision.folderId && Number(decision.folderId) !== previousFolderId;
      let status = "baseline_unresolved";
      if (decision.action === "auto" && targetDiffers) {
        const moved = await env.DB.prepare(
          `UPDATE entries SET folder_id = ?, parent_entry_id = NULL, auto_filed_at = ?,
             auto_filed_reason = ?, updated_at = ?
           WHERE id = ? AND folder_id = ? AND COALESCE(deleted_at, '') = ''`
        ).bind(decision.folderId, reviewedAt, `母體一次性整理：${reason}`, reviewedAt, entryId, previousFolderId).run();
        if (!moved?.meta?.changes) continue;
        status = "baseline_auto_applied";
        outcome.moved++;
        if (logHistory) await logHistory(env.DB, entryId, decision.folderId, "母體一次性整理", `${reason}（原資料夾 ${previousFolderId}；信心 ${Math.round(decision.confidence * 100)}%）`);
      } else if (decision.action === "auto") {
        status = "baseline_kept";
        outcome.kept++;
      } else if (decision.action === "suggest") {
        status = "baseline_suggested";
        outcome.suggested++;
      } else {
        outcome.unresolved++;
      }
      await saveSuggestion(env.DB, {
        entryId, folderId: decision.folderId, previousFolderId,
        aiFolderId: ai.folderId, vectorFolderId: vector?.folderId || null,
        confidence: decision.confidence, vectorScore: vector?.score || 0,
        status, basis: `baseline:${decision.basis}`, reason,
        sourceUpdatedAt: entry.source_stamp, timestamp: reviewedAt,
      });
    } catch (error) {
      outcome.errors++;
      console.error(JSON.stringify({ event: "baseline_filing_item_failed", entry_id: entryId, error: error?.message || String(error) }));
    }
  }
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM entries e
     JOIN folders f ON f.id = e.folder_id
     LEFT JOIN filing_suggestions s ON s.entry_id = e.id
     WHERE e.parent_entry_id IS NULL AND COALESCE(e.deleted_at, '') = ''
       AND COALESCE(f.deleted_at, '') = '' AND COALESCE(f.role, '') = ''
       AND COALESCE(e.auto_filed_at, '') = '' AND s.entry_id IS NULL`
  ).first();
  outcome.remaining = Number(remaining?.count || 0);
  return outcome;
}
