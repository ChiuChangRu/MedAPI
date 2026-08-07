/**
 * 單一檔案的操作——搬移、刪除、整理檔名。
 *
 * 這裡的「檔案」是使用者眼中的一份文件（attachments 一列），跟「記事」（entries 一列）
 * 是兩件事：一筆記事可以掛多份檔案。使用者在資料夾裡看到的是檔案清單，
 * 所以搬移／刪除都要能作用在單一檔案上，不能只做整筆記事。
 */

import { cleanPart, existingChineseTitle, parseStandard, standardTitle } from "./standards.js";
import { htmlToPlainText } from "./richtext.js";

/** 把單一檔案搬到另一個資料夾。 */
export async function moveAttachment(db, attachmentId, folderId, { logHistory, timestamp }) {
  const target = await db.prepare("SELECT id, name FROM folders WHERE id = ?").bind(folderId).first();
  if (!target) return { error: "找不到目標資料夾", status: 404 };

  const attachment = await db.prepare(
    `SELECT a.*, e.folder_id AS source_folder_id, e.title AS entry_title
     FROM attachments a JOIN entries e ON e.id = a.entry_id
     WHERE a.id = ?`
  ).bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };
  // 深度處理產生的逐頁圖片附屬於來源 PDF，單獨搬走會讓來源 PDF 的頁面對不上
  if (attachment.source_pdf_id) return { error: "處理用頁面不能單獨移動", status: 400 };
  if (Number(attachment.source_folder_id || 0) === Number(folderId)) {
    return { ok: true, moved: false, entry_id: attachment.entry_id, folder_id: folderId };
  }

  const countRow = await db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ? AND source_pdf_id IS NULL"
  ).bind(attachment.entry_id).first();
  const primaryCount = Number(countRow?.count || 0);

  // 這筆記事只有這一份檔案 → 整筆記事跟著搬（不必拆），歷程比較好讀
  if (primaryCount <= 1) {
    await db.prepare("UPDATE entries SET folder_id = ?, updated_at = ? WHERE id = ?")
      .bind(folderId, timestamp(), attachment.entry_id).run();
    await logHistory(db, attachment.entry_id, folderId, "移動檔案", `${attachment.filename} → ${target.name}`);
    return { ok: true, moved: true, split: false, entry_id: attachment.entry_id, folder_id: folderId };
  }

  // 記事裡還有其他檔案 → 只把這一份拆出去成為新記事，其他檔案留在原地
  const title = String(attachment.filename || "檔案").replace(/\.[^.]+$/, "").slice(0, 120);
  const created = timestamp();
  const inserted = await db.prepare(
    "INSERT INTO entries (folder_id, title, fields_json, body, created_at, updated_at) VALUES (?, ?, '{}', '', ?, ?)"
  ).bind(folderId, title, created, created).run();
  const newEntryId = Number(inserted.meta.last_row_id);

  try {
    // 連同它的深度處理頁面一起搬
    await db.prepare("UPDATE attachments SET entry_id = ? WHERE id = ? OR source_pdf_id = ?")
      .bind(newEntryId, attachmentId, attachmentId).run();
  } catch (error) {
    // 搬移失敗就把剛建的空記事收掉，不要留下半套結果
    await db.prepare("DELETE FROM entries WHERE id = ?").bind(newEntryId).run().catch(() => {});
    throw error;
  }

  await logHistory(db, attachment.entry_id, attachment.source_folder_id, "移出附件", attachment.filename);
  await logHistory(db, newEntryId, folderId, "移入檔案", `${attachment.filename} → ${target.name}`);
  return { ok: true, moved: true, split: true, entry_id: newEntryId, folder_id: folderId };
}

/**
 * 刪除單一檔案，連同它的深度處理頁面與 AI 用量預約一起清掉。
 * 如果這是記事裡最後一份檔案、而記事本身沒有任何文字內容，記事也一併收掉
 * ——留著一筆空記事只會變成使用者看不懂的殘留。
 */
export async function deleteAttachmentDeep(db, files, attachmentId, { logHistory }) {
  const attachment = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };

  const { results: pages } = await db.prepare(
    "SELECT id, key FROM attachments WHERE source_pdf_id = ?"
  ).bind(attachmentId).all();

  if (files) {
    for (const page of pages || []) await files.delete(page.key).catch(() => {});
    await files.delete(attachment.key).catch(() => {});
  }

  for (const page of pages || []) {
    await db.prepare("DELETE FROM ai_usage_reservations WHERE attachment_id = ?").bind(page.id).run().catch(() => {});
  }
  await db.prepare("DELETE FROM ai_usage_reservations WHERE attachment_id = ?").bind(attachmentId).run().catch(() => {});
  await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(attachmentId).run();
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(attachmentId).run();
  await logHistory(db, attachment.entry_id, null, "刪除附件", attachment.filename);

  const remaining = await db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE entry_id = ?"
  ).bind(attachment.entry_id).first();

  let entryRemoved = false;
  if (Number(remaining?.count || 0) === 0) {
    const entry = await db.prepare("SELECT body, body_format, fields_json FROM entries WHERE id = ?")
      .bind(attachment.entry_id).first();
    let hasFields = false;
    try {
      hasFields = Object.values(JSON.parse(entry?.fields_json || "{}")).some((value) => String(value || "").trim());
    } catch {
      hasFields = true; // 欄位壞掉時保守處理：當成「有內容」，不要順手刪掉記事
    }
    // 富文字記事清空時 Quill 會留下 <p><br></p> 這類非空字串，剝成純文字才能
    // 正確判斷「是不是真的沒內容」
    const bodyText = entry?.body_format === "html" ? htmlToPlainText(entry.body) : String(entry?.body || "");
    if (!bodyText.trim() && !hasFields) {
      await db.prepare("DELETE FROM entries WHERE id = ?").bind(attachment.entry_id).run();
      entryRemoved = true;
    }
  }

  return { ok: true, entry_removed: entryRemoved, pages_removed: (pages || []).length };
}

/**
 * 把單一 PDF 的檔名整理成「組織_編號_年份_中文標題.pdf」。
 * 年份無法確認時不硬猜——回 incomplete_year，讓前端提示先擷取文字或深度處理。
 */
export async function normalizeAttachmentName(db, attachmentId, { logHistory }) {
  const att = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first();
  if (!att) return { error: "找不到附件", status: 404 };

  const isPdf = (att.mime || "") === "application/pdf"
    || String(att.filename || "").toLowerCase().endsWith(".pdf");
  if (!isPdf) return { ok: true, renamed: false, filename: att.filename };

  const standard = parseStandard(att);
  if (!standard) return { ok: true, renamed: false, filename: att.filename };
  if (!standard.year) return { ok: true, renamed: false, incomplete_year: true, filename: att.filename };

  const title = standardTitle(standard.org, standard.number, standard.year)
    || existingChineseTitle(att)
    || "標準文件";
  const next = `${standard.org}_${standard.number}_${standard.year}_${cleanPart(title, 150)}.pdf`;
  if (next === att.filename) return { ok: true, renamed: false, filename: next };

  await db.prepare(
    "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
  ).bind(next, attachmentId).run();
  await logHistory(db, att.entry_id, null, "自動重新命名", `${att.filename} → ${next}`);
  return { ok: true, renamed: true, filename: next };
}

/**
 * 這棵子樹有幾層（只有自己＝1）。搬移／合併資料夾時要用：把一棵三層的子樹
 * 掛到第 3 層底下就會變成第 5 層，超過四層架構的上限。只檢查「新家的深度」
 * 不夠——被搬的那一整棵樹有多高也要算進去。
 */
export async function subtreeHeight(db, folderId) {
  let height = 0;
  let level = [Number(folderId || 0)].filter(Boolean);
  const visited = new Set();
  while (level.length) {
    height++;
    if (height > 20) throw new Error("資料夾層級異常");
    const next = [];
    for (const id of level) {
      if (visited.has(id)) continue;
      visited.add(id);
      const { results } = await db.prepare("SELECT id FROM folders WHERE parent_id = ?").bind(id).all();
      for (const child of results || []) next.push(Number(child.id));
    }
    level = next;
  }
  return height;
}

/** target 是不是 source 的子孫（含自己）——搬移資料夾時用來擋掉「搬進自己底下」 */
export async function isDescendantOf(db, targetId, sourceId) {
  let currentId = Number(targetId || 0);
  const visited = new Set();
  while (currentId) {
    if (currentId === Number(sourceId)) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const folder = await db.prepare("SELECT parent_id FROM folders WHERE id = ?").bind(currentId).first();
    if (!folder) return false;
    currentId = Number(folder.parent_id || 0);
  }
  return false;
}

/** 資料夾在四層架構裡的深度（1＝最上層）；找不到回 0，有環時擋掉 */
export async function folderDepth(db, folderId) {
  let depth = 0;
  let currentId = Number(folderId || 0);
  const visited = new Set();
  while (currentId) {
    if (visited.has(currentId)) throw new Error("資料夾層級異常（出現循環參照）");
    visited.add(currentId);
    const folder = await db.prepare("SELECT id, parent_id FROM folders WHERE id = ?").bind(currentId).first();
    if (!folder) return 0;
    depth++;
    currentId = Number(folder.parent_id || 0);
    if (depth > 20) throw new Error("資料夾層級異常");
  }
  return depth;
}
