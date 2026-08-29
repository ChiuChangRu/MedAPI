/**
 * 既有附件的批次整理：統一標準檔名 ＋ 移除重複檔。
 *
 * 去重只認 SHA-256 二進位完全相同——這是唯一不會誤判的判斷方式，直接刪掉
 * 較新的那一份。
 *
 * 2026-07-28：拿掉了原本「內文幾乎相同也當重複檔刪除」的模糊比對（長度比例
 * ＋抽樣比對片段，門檻約 90–92%）。ISO 標準文件之間本來就大量共用前言、
 * 版權聲明、條文樣板等內容，這組門檻會把內容其實不同的兩份文件（例如同一
 * 標準的不同部分、引用該標準的稽核文件）誤判成重複檔，自動刪掉較新的一份、
 * 而且完全不會跳出任何確認或提示。與其把
 * 門檻調更嚴謹地去猜「多相似才算同一份」，不如整層拿掉：只保留絕對安全的
 * 二進位比對，模糊判斷交還給人工用「🔗 新增關聯」或手動刪除處理。
 */

import { canonicalBase, canonicalFilename } from "./standards.js";

async function sha256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  await logHistory(db, att.entry_id, null, "移除重複附件", `${att.filename}（保留相同內容的較早版本）`);
}

/**
 * 標準檔名統一 ＋ 同一份標準的重複檔清除（僅二進位完全相同）。
 * 分組鍵是「資料夾 ＋ 標準編號」——只有同一個資料夾裡的同一份標準才互相比對，
 * 不會把不同資料夾裡刻意各留一份的檔案誤刪。
 */
export async function cleanupStandardAttachments(env, db, { logHistory } = {}) {
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

  let duplicatesRemoved = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keptHashes = new Map();
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
    }
  }

  return { renamed, duplicates_removed: duplicatesRemoved };
}
