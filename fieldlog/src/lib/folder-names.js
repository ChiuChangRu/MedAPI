/**
 * 資料夾的 name 只存「本層名稱」。完整路徑由 parent_id 組成，不重複塞進每一層。
 *
 * 舊資料曾把「專案｜檢體針｜拉拔試驗」整串存在第二層。這裡刻意只辨識
 * 明確的路徑分隔符，不碰破折號、括號等可能原本就是標題內容的符號。
 */
export function canonicalFolderLocalName(value) {
  const parts = String(value || "")
    .split(/[|｜/／\\]+/)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return (parts.at(-1) || "").slice(0, 80);
}

function nameKey(value) {
  return canonicalFolderLocalName(value).toLocaleLowerCase("zh-Hant-TW");
}

function rootNameKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-Hant-TW");
}

/** 建立／改名時擋住同一上層底下正規化後會同名的資料夾。 */
export async function findSiblingFolderNameConflict(db, { parentId = null, name, excludeId = null } = {}) {
  const condition = parentId
    ? "parent_id = ?"
    : "parent_id IS NULL";
  const values = parentId ? [Number(parentId)] : [];
  const { results = [] } = await db.prepare(
    `SELECT id, name FROM folders
     WHERE ${condition} AND COALESCE(deleted_at, '') = ''`
  ).bind(...values).all();
  const keyOf = parentId ? nameKey : rootNameKey;
  const wanted = keyOf(name);
  return results.find((folder) => Number(folder.id) !== Number(excludeId) && keyOf(folder.name) === wanted) || null;
}

/**
 * 一次性整理既有第二層以下名稱。只改 label，不搬動、不合併、不刪除。
 * 若同層兩個名稱會收斂成同一名稱，兩個都保留原狀並列入 conflicts。
 */
export async function normalizeExistingChildFolderNames(db, { timestamp, logHistory } = {}) {
  const { results = [] } = await db.prepare(
    `SELECT id, parent_id, name FROM folders
     WHERE parent_id IS NOT NULL AND COALESCE(deleted_at, '') = ''
     ORDER BY parent_id, id`
  ).all();
  const byParent = new Map();
  for (const folder of results) {
    const key = Number(folder.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  }

  const renamed = [];
  const conflicts = [];
  const invalid = [];
  for (const siblings of byParent.values()) {
    const proposedCounts = new Map();
    for (const folder of siblings) {
      const proposed = canonicalFolderLocalName(folder.name);
      if (!proposed) continue;
      const key = nameKey(proposed);
      proposedCounts.set(key, (proposedCounts.get(key) || 0) + 1);
    }
    for (const folder of siblings) {
      const proposed = canonicalFolderLocalName(folder.name);
      if (!proposed) {
        invalid.push({ id: Number(folder.id), name: folder.name });
        continue;
      }
      if ((proposedCounts.get(nameKey(proposed)) || 0) > 1) {
        conflicts.push({ id: Number(folder.id), parent_id: Number(folder.parent_id), name: folder.name, proposed });
        continue;
      }
      if (folder.name === proposed) continue;
      await db.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(proposed, folder.id).run();
      if (logHistory) {
        await logHistory(db, null, Number(folder.id), "統一資料夾名稱", `${folder.name} → ${proposed}`);
      }
      renamed.push({ id: Number(folder.id), parent_id: Number(folder.parent_id), from: folder.name, to: proposed });
    }
  }
  return {
    checked: results.length,
    renamed_count: renamed.length,
    conflict_count: conflicts.length,
    invalid_count: invalid.length,
    renamed,
    conflicts,
    invalid,
    finished_at: typeof timestamp === "function" ? timestamp() : timestamp,
  };
}
