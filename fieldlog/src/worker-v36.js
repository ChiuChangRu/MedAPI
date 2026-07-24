import legacyWorker from "./worker.js";
import { stripPdfMetadata } from "./imageSkill.js";

const STANDARD_TITLES = new Map([
  ["ISO_7886-1_2017", "手動使用注射器"],
  ["ISO_7886-2_2020", "動力驅動注射泵用注射器"],
  ["ISO_7886-3_2020", "自毀式固定劑量免疫注射器"],
  ["ISO_7886-4_2018", "防止重複使用功能注射器"],
  ["ISO_10555-1_2023", "血管內導管一般要求"],
  ["ISO_10993-4_2017", "血液相容性測試"],
  ["ASTM_F640", "導管顯影性測試"],
  ["FDA_2024", "血管內導管510k指引"],
  ["MDR_2017-745", "醫療器材法規"],
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cleanPart(value, max = 72) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|#]+/g, " ")
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function standardIdentity(att) {
  const source = `${att.original_filename || ""}\n${att.filename || ""}\n${att.ocr_text || ""}`;
  let match = source.match(/\b(EN\s+ISO|ISO(?:\s*\/\s*(?:TS|TR))?|IEC|ASTM|JIS)\s*[-:]?\s*([A-Z]?\d{3,6}(?:-\d{1,3})?)(?:\s*[:_\-]?\s*((?:19|20)\d{2}))?/i);
  if (match) {
    const org = match[1].toUpperCase().replace(/\s*\/\s*/g, "_").replace(/\s+/g, "_");
    let year = match[3] || "";
    const number = match[2].toUpperCase();
    if (!year && org === "ISO" && number === "7886-2") year = "2020";
    if (!year && org === "ISO" && number === "7886-4") year = "2018";
    return { org, number, year };
  }
  match = source.match(/\bFDA\b[\s_-]*((?:19|20)\d{2})/i);
  if (match) return { org: "FDA", number: "", year: match[1] };
  match = source.match(/\bMDR\b[\s_-]*(2017[-_/]745)/i);
  if (match) return { org: "MDR", number: "2017-745", year: "" };
  return null;
}

function existingChineseTitle(att) {
  const stem = cleanPart(att.filename || "");
  const parts = stem.split("_");
  const index = parts.findIndex((part) => /[\u3400-\u9fff]/.test(part));
  return index >= 0 ? cleanPart(parts.slice(index).join("_"), 80) : "";
}

function canonicalFilename(att) {
  const id = standardIdentity(att);
  if (!id) return att.filename;
  const base = [id.org, id.number, id.year].filter(Boolean).join("_");
  const title = STANDARD_TITLES.get(base) || existingChineseTitle(att) || "標準文件";
  return `${base}_${cleanPart(title, 80)}.pdf`;
}

function normalizePdfText(text) {
  const stripped = stripPdfMetadata(String(text || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*(page|頁)\s*\d+\s*(of|\/)?\s*\d*\s*$/gim, "")
    .replace(/(?:©|copyright).*$/gim, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
  return stripped.length >= 500 ? stripped : "";
}

async function sha256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadPdfText(env, db, att) {
  let text = String(att.ocr_text || "");
  if (normalizePdfText(text)) return text;
  if (!env.FILES || !env.AI) return text;
  const obj = await env.FILES.get(att.key);
  if (!obj) return text;
  const converted = await env.AI.toMarkdown([
    { name: att.filename, blob: new Blob([await obj.arrayBuffer()], { type: "application/pdf" }) },
  ]).catch(() => null);
  text = stripPdfMetadata(converted?.[0]?.data || "").slice(0, 60000);
  if (text) {
    await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = COALESCE(NULLIF(ocr_at, ''), ?) WHERE id = ?")
      .bind(text, new Date().toISOString(), att.id).run();
  }
  return text;
}

async function deleteAttachment(env, db, att) {
  const { results: pages } = await db.prepare("SELECT id, key FROM attachments WHERE source_pdf_id = ?").bind(att.id).all();
  if (env.FILES) {
    for (const page of pages || []) await env.FILES.delete(page.key).catch(() => {});
    await env.FILES.delete(att.key).catch(() => {});
  }
  await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(att.id).run();
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(att.id).run();
  await db.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, NULL, '移除重複附件', ?, ?)"
  ).bind(att.entry_id, `${att.filename}（保留相同文件的較早版本）`, new Date().toISOString()).run();
}

async function enhancedCleanup(env) {
  const db = env.DB;
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
    const key = `${att.folder_id ?? "inbox"}\n${canonicalFilename(att).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(att);
  }

  let pdfCompared = 0;
  let duplicatesRemoved = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keptHashes = new Map();
    const keptTexts = new Map();
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
        await deleteAttachment(env, db, att);
        duplicatesRemoved++;
        continue;
      }
      if (binaryHash) keptHashes.set(binaryHash, att.id);

      const text = normalizePdfText(await loadPdfText(env, db, att));
      if (!text) continue;
      pdfCompared++;
      const textHash = await sha256(text);
      if (keptTexts.has(textHash)) {
        await deleteAttachment(env, db, att);
        duplicatesRemoved++;
        continue;
      }
      keptTexts.set(textHash, att.id);
    }
  }

  return { renamed, pdf_compared: pdfCompared, duplicates_removed: duplicatesRemoved };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/attachments/rename-existing" || request.method !== "POST") {
      return legacyWorker.fetch(request, env, ctx);
    }

    const legacyResponse = await legacyWorker.fetch(request.clone(), env, ctx);
    if (!legacyResponse.ok) return legacyResponse;
    const legacy = await legacyResponse.json().catch(() => ({}));
    try {
      const enhanced = await enhancedCleanup(env);
      return json({
        ok: true,
        version: "fieldlog-v36",
        cleanup_executed: true,
        checked: legacy.checked || 0,
        renamed: Number(legacy.renamed || 0) + enhanced.renamed,
        pdf_compared: enhanced.pdf_compared,
        duplicates_removed: Number(legacy.duplicates_removed || 0) + enhanced.duplicates_removed,
      });
    } catch (err) {
      return json({ error: `既有附件增強清理失敗：${err.message}` }, 500);
    }
  },
};
