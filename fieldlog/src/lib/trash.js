export const TRASH_RETENTION_DAYS = 60;

const active = (alias = "") => `COALESCE(${alias ? `${alias}.` : ""}deleted_at, '') = ''`;
const deleted = (alias = "") => `COALESCE(${alias ? `${alias}.` : ""}deleted_at, '') <> ''`;

export function trashPurgeAfter(timestamp) {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + TRASH_RETENTION_DAYS);
  return date.toISOString();
}

async function descendants(db, table, parentColumn, roots, wantDeleted) {
  const ids = [];
  const seen = new Set();
  const suppliedRoots = (Array.isArray(roots) ? roots : [roots]).map(Number).filter(Boolean);
  const queue = [];
  for (const part of chunks(suppliedRoots)) {
    const marks = part.map(() => "?").join(",");
    const { results } = await db.prepare(
      `SELECT id FROM ${table} WHERE id IN (${marks}) AND ${wantDeleted ? deleted() : active()}`
    ).bind(...part).all();
    queue.push(...(results || []).map((row) => Number(row.id)));
  }
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    const { results } = await db.prepare(
      `SELECT id FROM ${table} WHERE ${parentColumn} = ? AND ${wantDeleted ? deleted() : active()}`
    ).bind(id).all();
    queue.push(...(results || []).map((row) => Number(row.id)));
  }
  return ids;
}

export const folderSubtreeIds = (db, rootId, wantDeleted = false) =>
  descendants(db, "folders", "parent_id", rootId, wantDeleted);

export const entrySubtreeIds = (db, roots, wantDeleted = false) =>
  descendants(db, "entries", "parent_entry_id", roots, wantDeleted);

async function entriesInFolders(db, folderIds, wantDeleted) {
  if (!folderIds.length) return [];
  const ids = [];
  for (const part of chunks(folderIds)) {
    const marks = part.map(() => "?").join(",");
    const { results } = await db.prepare(
      `SELECT id FROM entries WHERE folder_id IN (${marks}) AND ${wantDeleted ? deleted() : active()}`
    ).bind(...part).all();
    ids.push(...(results || []).map((row) => Number(row.id)));
  }
  return ids;
}

async function updateIds(db, table, ids, assignment, values = []) {
  if (!ids.length) return;
  await runStatements(db, updateIdStatements(db, table, ids, assignment, values));
}

function chunks(items, size = 80) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function updateIdStatements(db, table, ids, assignment, values = []) {
  return chunks(ids).map((part) => {
    const marks = part.map(() => "?").join(",");
    return db.prepare(`UPDATE ${table} SET ${assignment} WHERE id IN (${marks})`).bind(...values, ...part);
  });
}

export async function moveFolderTreeToTrash(db, folder, timestamp) {
  const folderIds = await folderSubtreeIds(db, folder.id);
  const entryIds = await entrySubtreeIds(db, await entriesInFolders(db, folderIds, false));
  const statements = [db.prepare(
    "INSERT INTO trash_items (item_type, item_id, title, deleted_at, purge_after, state) VALUES ('folder', ?, ?, ?, ?, 'trashed') ON CONFLICT(item_type, item_id) DO NOTHING"
  ).bind(folder.id, folder.name || "", timestamp, trashPurgeAfter(timestamp))];
  statements.push(...updateIdStatements(db, "folders", folderIds, "deleted_at = ?", [timestamp]));
  statements.push(...updateIdStatements(db, "entries", entryIds, "deleted_at = ?, updated_at = ?", [timestamp, timestamp]));
  await runStatements(db, statements);
  return { folder_count: folderIds.length, entry_count: entryIds.length };
}

export async function moveEntryTreeToTrash(db, entry, timestamp) {
  const entryIds = await entrySubtreeIds(db, entry.id);
  const statements = [db.prepare(
    "INSERT INTO trash_items (item_type, item_id, title, deleted_at, purge_after, state) VALUES ('entry', ?, ?, ?, ?, 'trashed') ON CONFLICT(item_type, item_id) DO NOTHING"
  ).bind(entry.id, entry.title || "", timestamp, trashPurgeAfter(timestamp))];
  statements.push(...updateIdStatements(db, "entries", entryIds, "deleted_at = ?, updated_at = ?", [timestamp, timestamp]));
  await runStatements(db, statements);
  return { entry_count: entryIds.length };
}

async function resolveTree(db, item) {
  if (item.item_type === "folder") {
    const folderIds = await folderSubtreeIds(db, item.item_id, true);
    const entryIds = await entrySubtreeIds(db, await entriesInFolders(db, folderIds, true), true);
    return { folderIds, entryIds };
  }
  return { folderIds: [], entryIds: await entrySubtreeIds(db, item.item_id, true) };
}

function conditionalUpdateIdStatements(db, table, ids, assignment, values, trashId) {
  return chunks(ids).map((part) => {
    const marks = part.map(() => "?").join(",");
    return db.prepare(
      `UPDATE ${table} SET ${assignment} WHERE id IN (${marks}) AND EXISTS (SELECT 1 FROM trash_items WHERE id = ? AND state = 'trashed')`
    ).bind(...values, ...part, trashId);
  });
}

export async function listTrash(db) {
  const { results } = await db.prepare("SELECT * FROM trash_items WHERE state <> 'purging' ORDER BY deleted_at DESC, id DESC").all();
  const items = [];
  for (const item of results || []) {
    const { folderIds, entryIds } = await resolveTree(db, item);
    let attachmentCount = 0;
    for (const part of chunks(entryIds)) {
      const marks = part.map(() => "?").join(",");
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE entry_id IN (${marks})`)
        .bind(...part).first();
      attachmentCount += Number(row?.count || 0);
    }
    items.push({ ...item, folder_count: folderIds.length, entry_count: entryIds.length, attachment_count: attachmentCount });
  }
  return items;
}

export async function restoreTrashItem(db, trashId, destination = {}, timestamp) {
  const item = await db.prepare("SELECT * FROM trash_items WHERE id = ? AND state = 'trashed'").bind(trashId).first();
  if (!item) return null;
  const { folderIds, entryIds } = await resolveTree(db, item);
  if ((item.item_type === "folder" && !folderIds.length) || (item.item_type === "entry" && !entryIds.length)) {
    return { conflict: true, reason: "垃圾桶項目的原始資料不完整，暫時無法還原" };
  }
  const statements = [];
  if (item.item_type === "folder") {
    const root = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(item.item_id).first();
    let parentId = destination.parent_folder_id !== undefined ? destination.parent_folder_id : root?.parent_id;
    if (parentId) {
      if (folderIds.includes(Number(parentId))) return { conflict: true, reason: "不能還原到自己的子資料夾" };
      const parent = await db.prepare(`SELECT id FROM folders WHERE id = ? AND ${active()}`).bind(parentId).first();
      if (!parent) return { conflict: true, reason: "原始上層資料夾已不存在，請選擇新的還原位置" };
    }
    statements.push(db.prepare(
      "UPDATE folders SET parent_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM trash_items WHERE id = ? AND state = 'trashed')"
    ).bind(parentId || null, item.item_id, trashId));
    statements.push(...conditionalUpdateIdStatements(db, "folders", folderIds, "deleted_at = ''", [], trashId));
    statements.push(...conditionalUpdateIdStatements(db, "entries", entryIds, "deleted_at = '', updated_at = ?", [timestamp], trashId));
  } else {
    const root = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(item.item_id).first();
    let parentEntryId = destination.parent_entry_id !== undefined ? destination.parent_entry_id : root?.parent_entry_id;
    let folderId = destination.folder_id !== undefined ? destination.folder_id : root?.folder_id;
    // 使用者明確指定資料夾＝還原成該資料夾的頂層資料包，不再沿用已失效的原始 parent_entry_id。
    if (destination.folder_id !== undefined && destination.parent_entry_id === undefined) parentEntryId = null;
    if (parentEntryId) {
      if (entryIds.includes(Number(parentEntryId))) return { conflict: true, reason: "不能還原到自己的子資料包" };
      const parent = await db.prepare(`SELECT id, folder_id FROM entries WHERE id = ? AND ${active()}`).bind(parentEntryId).first();
      if (!parent) return { conflict: true, reason: "原始外層紀錄已不存在，請選擇新的還原位置" };
      folderId = parent.folder_id;
    }
    if (folderId) {
      const folder = await db.prepare(`SELECT id FROM folders WHERE id = ? AND ${active()}`).bind(folderId).first();
      if (!folder) return { conflict: true, reason: "原始資料夾已不存在，請選擇新的還原位置" };
    }
    statements.push(db.prepare(
      "UPDATE entries SET parent_entry_id = ?, folder_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM trash_items WHERE id = ? AND state = 'trashed')"
    ).bind(parentEntryId || null, folderId || null, item.item_id, trashId));
    statements.push(...conditionalUpdateIdStatements(
      db, "entries", entryIds, "deleted_at = '', folder_id = ?, updated_at = ?", [folderId || null, timestamp], trashId
    ));
  }
  statements.push(db.prepare("DELETE FROM trash_items WHERE id = ? AND state = 'trashed'").bind(trashId));
  await runStatements(db, statements);
  return { item, folder_count: folderIds.length, entry_count: entryIds.length };
}

async function runStatements(db, statements) {
  if (typeof db.batch === "function") return db.batch(statements);
  for (const statement of statements) await statement.run();
}

// 語意搜尋（Vectorize）的向量 id 範圍——一份附件固定佔 att-{id}-0 ~
// att-{id}-19（EMBED_MAX_CHUNKS，跟 worker.js 的 EmbeddingWorkflow 用同一個
// 上限；兩邊 import 會循環，所以各自定義同一個常數，改動時要一起改）。
const EMBED_MAX_CHUNKS = 20;

export async function permanentlyDeleteTrashItem(db, files, trashId, vectorIndex) {
  const claimTime = new Date().toISOString();
  const claim = await db.prepare(
    "UPDATE trash_items SET state = 'purging', purge_started_at = ?, last_error = '' WHERE id = ? AND state = 'trashed'"
  ).bind(claimTime, trashId).run();
  if (claim?.meta && Number(claim.meta.changes || 0) === 0) return null;
  const item = await db.prepare("SELECT * FROM trash_items WHERE id = ? AND state = 'purging'").bind(trashId).first();
  if (!item) return null;
  try {
    const { folderIds, entryIds } = await resolveTree(db, item);
    const statements = [];
    const attachments = [];
    for (const part of chunks(entryIds)) {
      const marks = part.map(() => "?").join(",");
      const { results } = await db.prepare(`SELECT id, key FROM attachments WHERE entry_id IN (${marks})`).bind(...part).all();
      attachments.push(...(results || []));
    }
    if (attachments.length && !files) throw new Error("缺少 R2 FILES binding，拒絕永久刪除以免留下孤兒檔案");
    const settled = await Promise.allSettled(attachments.map((attachment) => files.delete(attachment.key)));
    const failed = settled.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`R2 有 ${failed.length} 個檔案刪除失敗，保留資料庫紀錄後重試`);
    for (const part of chunks(entryIds)) {
      const marks = part.map(() => "?").join(",");
      statements.push(
        db.prepare(`DELETE FROM ai_usage_reservations WHERE attachment_id IN (SELECT id FROM attachments WHERE entry_id IN (${marks}))`).bind(...part),
        db.prepare(`DELETE FROM attachments WHERE entry_id IN (${marks})`).bind(...part),
        db.prepare(`DELETE FROM relations WHERE from_entry_id IN (${marks}) OR to_entry_id IN (${marks})`).bind(...part, ...part),
        db.prepare(`DELETE FROM history WHERE entry_id IN (${marks})`).bind(...part),
        db.prepare(`DELETE FROM entries WHERE id IN (${marks})`).bind(...part),
      );
    }
    for (const part of chunks(folderIds)) {
      const marks = part.map(() => "?").join(",");
      statements.push(
        db.prepare(`DELETE FROM history WHERE folder_id IN (${marks})`).bind(...part),
        db.prepare(`DELETE FROM folders WHERE id IN (${marks})`).bind(...part),
      );
    }
    statements.push(db.prepare("DELETE FROM trash_items WHERE id = ? AND state = 'purging'").bind(trashId));
    await runStatements(db, statements);
    // 向量索引清理是加值層、不是正確性紅線——失敗不擋永久刪除（真正的資料已經
    // 刪掉了，這裡頂多留下之後搜尋得到但點進去 404 的幽靈結果，比因為
    // Vectorize 暫時打不通就整批刪除失敗好）。
    if (vectorIndex) {
      const vectorIds = [
        ...entryIds.map((id) => `entry-${id}`),
        ...attachments.flatMap((a) => Array.from({ length: EMBED_MAX_CHUNKS }, (_, i) => `att-${a.id}-${i}`)),
      ];
      if (vectorIds.length) {
        try { await vectorIndex.deleteByIds(vectorIds); }
        catch (error) { console.error(JSON.stringify({ event: "trash_purge_vector_cleanup_failed", trash_id: trashId, error: error.message })); }
      }
    }
    return { item, folder_count: folderIds.length, entry_count: entryIds.length, attachment_count: attachments.length };
  } catch (error) {
    await db.prepare(
      "UPDATE trash_items SET state = 'trashed', attempts = attempts + 1, last_error = ?, purge_started_at = '' WHERE id = ?"
    ).bind(String(error.message || error).slice(0, 500), trashId).run();
    throw error;
  }
}

export async function purgeExpiredTrash(db, files, timestamp, vectorIndex) {
  const { results } = await db.prepare("SELECT id FROM trash_items WHERE state = 'trashed' AND purge_after <= ? ORDER BY id").bind(timestamp).all();
  const summary = { purged: 0, failed: 0 };
  for (const row of results || []) {
    try {
      if (await permanentlyDeleteTrashItem(db, files, Number(row.id), vectorIndex)) summary.purged++;
    } catch (error) {
      summary.failed++;
      console.error(JSON.stringify({ event: "trash_purge_failed", trash_id: row.id, error: error.message }));
    }
  }
  return summary;
}
