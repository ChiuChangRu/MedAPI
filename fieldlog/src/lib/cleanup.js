/**
 * 既有附件的批次整理：統一標準檔名 ＋ 移除重複檔。
 *
 * 兩層去重，由便宜到貴：
 *   1. SHA-256 二進位完全相同 → 一定是同一份檔案，直接刪。
 *   2. 內文幾乎相同 → 同一份標準的不同來源（不同下載管道、重新掃描），
 *      二進位不同但內容一樣，用文字比對抓出來。
 *
 * 關於 AI：這支端點的承諾是「只用已經入庫的 OCR／逐字稿，不重新呼叫 AI」——
 * 因為它會在使用者登入時自動跑一次，如果每份沒有文字層的 PDF 都去呼叫一次 AI，
 * 等於每次登入都靜默扣額度。想連沒擷取過的 PDF 也一起做文字去重時，
 * 呼叫端帶 use_ai: true 明確要求（前台不會自動帶）。
 */

import { canonicalBase, canonicalFilename } from "./standards.js";
import { stripPdfMetadata } from "../imageSkill.js";

/**
 * 內文正規化：剝掉 PDF metadata、頁碼、版權宣告，只留可比對的字元。
 * 太短的內容（<500 字）不足以判斷「是同一份文件」，回空字串代表不參與文字去重。
 */
export function normalizePdfText(text) {
  const stripped = stripPdfMetadata(String(text || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*(page|頁)\s*\d+\s*(of|\/)?\s*\d*\s*$/gim, "")
    .replace(/(?:©|copyright).*$/gim, "")
    .replace(/[^a-z0-9㐀-鿿]+/g, "");
  return stripped.length >= 500 ? stripped : "";
}

/**
 * 兩份內文是不是同一份文件。不用完全相等——同一份標準經過不同 OCR／不同下載來源，
 * 會有零星字元差異。做法：長度比例先過篩，再抽樣比對片段。
 */
export function equivalentPdfText(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const ratio = shorter.length / longer.length;
  if (ratio < 0.9) return false;
  if (ratio >= 0.97 && longer.includes(shorter)) return true;
  const sampleLength = 64;
  const samples = Math.min(60, Math.max(12, Math.floor(shorter.length / 1200)));
  let matched = 0;
  for (let i = 0; i < samples; i++) {
    const start = Math.floor((shorter.length - sampleLength) * i / Math.max(1, samples - 1));
    if (longer.includes(shorter.slice(start, start + sampleLength))) matched++;
  }
  return matched / samples >= 0.92;
}

async function sha256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 取這份附件可用來比對的文字。預設只讀已入庫的 ocr_text；
// useAi 才會呼叫 AI 把 PDF 轉成 markdown（會花額度），並把結果存回資料庫。
async function loadPdfText(env, db, att, useAi) {
  const stored = String(att.ocr_text || "");
  if (normalizePdfText(stored)) return stored;
  if (!useAi || !env.FILES || !env.AI) return stored;
  const obj = await env.FILES.get(att.key);
  if (!obj) return stored;
  const converted = await env.AI.toMarkdown([
    { name: att.filename, blob: new Blob([await obj.arrayBuffer()], { type: "application/pdf" }) },
  ]).catch(() => null);
  const text = stripPdfMetadata(converted?.[0]?.data || "").slice(0, 60000);
  if (text) {
    await db.prepare(
      "UPDATE attachments SET ocr_text = ?, ocr_at = COALESCE(NULLIF(ocr_at, ''), ?) WHERE id = ?"
    ).bind(text, new Date().toISOString(), att.id).run();
  }
  return text;
}

async function removeDuplicate(env, db, att, logHistory) {
  const { results: pages } = await db.prepare(
    "SELECT id, key FROM attachments WHERE source_pdf_id = ?"
  ).bind(att.id).all();
  if (env.FILES) {
    for (const page of pages || []) await env.FILES.delete(page.key).catch(() => {});
    await env.FILES.delete(att.key).catch(() => {});
  }
  await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(att.id).run();
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(att.id).run();
  await logHistory(db, att.entry_id, null, "移除重複附件", `${att.filename}（保留相同文件的較早版本）`);
}

/**
 * 標準檔名統一 ＋ 同一份標準的重複檔清除。
 * 分組鍵是「資料夾 ＋ 標準編號」——只有同一個資料夾裡的同一份標準才互相比對，
 * 不會把不同資料夾裡刻意各留一份的檔案誤刪。
 */
export async function cleanupStandardAttachments(env, db, { logHistory, useAi = false } = {}) {
  const { results } = await db.prepare(
    `SELECT a.*, e.folder_id FROM attachments a
     JOIN entries e ON e.id = a.entry_id
     WHERE a.source_pdf_id IS NULL
     ORDER BY a.id`
  ).all();

  let renamed = 0;
  for (const att of results || []) {
    const next = canonicalFilename(att);
    if (next && next !== att.filename && /\.pdf$/i.test(next)) {
      await db.prepare(
        "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
      ).bind(next, att.id).run();
      att.filename = next;
      renamed++;
    }
  }

  const groups = new Map();
  for (const att of results || []) {
    if (!/\.pdf$/i.test(att.filename || "") && att.mime !== "application/pdf") continue;
    const base = canonicalBase(att);
    if (!base) continue;
    const key = `${att.folder_id ?? "inbox"}\n${base.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(att);
  }

  let pdfCompared = 0;
  let duplicatesRemoved = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keptHashes = new Map();
    const keptTexts = [];
    for (const att of group.sort((a, b) => a.id - b.id)) {
      let binaryHash = String(att.content_hash || "");
      if (!binaryHash && env.FILES) {
        const obj = await env.FILES.get(att.key);
        if (obj) {
          binaryHash = await sha256(await obj.arrayBuffer());
          await db.prepare("UPDATE attachments SET content_hash = ? WHERE id = ?").bind(binaryHash, att.id).run();
        }
      }
      if (binaryHash && keptHashes.has(binaryHash)) {
        await removeDuplicate(env, db, att, logHistory);
        duplicatesRemoved++;
        continue;
      }
      if (binaryHash) keptHashes.set(binaryHash, att.id);

      const text = normalizePdfText(await loadPdfText(env, db, att, useAi));
      if (!text) continue;
      pdfCompared++;
      if (keptTexts.some((kept) => equivalentPdfText(kept, text))) {
        await removeDuplicate(env, db, att, logHistory);
        duplicatesRemoved++;
        continue;
      }
      keptTexts.push(text);
    }
  }

  return { renamed, pdf_compared: pdfCompared, duplicates_removed: duplicatesRemoved };
}
