import { FOLDER_CATEGORIES } from "./schema.js";

/**
 * v144 的「工作分類」是虛擬顯示層，不是 folders.parent_id 的實體層級。
 * 因此既有四層知識架構不會被推成第五層，正規化也不會搬動任何記事或附件。
 */
export const WORK_SECTION_ORDER = [
  "project",
  "training",
  "admin",
  "literature",
  "routine_report",
  "ai_adoption",
  "qa_reg",
  "misc",
];

export const WORK_SECTION_LABELS = {
  project: "專案",
  training: "教育訓練",
  admin: "行政",
  literature: "文獻",
  routine_report: "例行報告",
  ai_adoption: "AI導用",
  qa_reg: "法規",
  misc: "其他",
};

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function stripFirstPrefix(name, pattern) {
  return cleanName(name.replace(pattern, ""));
}

function normalizedKey(value) {
  return cleanName(value).toLocaleLowerCase("zh-Hant-TW");
}

/** 只用明確前綴、既有分類或系統角色判定；不以 AI 猜測既有資料夾。 */
export function workSectionProposal(folder) {
  const originalName = cleanName(folder?.name);
  const role = cleanName(folder?.role);
  const oldCategory = FOLDER_CATEGORIES.includes(folder?.category) ? folder.category : "misc";
  let category = oldCategory;
  let name = originalName;

  if (role === "weekly_reports" || /^(工作週報|週報月報KPI)$/.test(originalName)) {
    category = "routine_report";
  } else if (/^(?:品保法規|品保與法規|法規)$/.test(originalName)) {
    // 「法規」已是畫面上的工作分類，避免再顯示「法規／品保法規」的重複層級。
    category = "qa_reg";
    name = "一般法規";
  } else if (/^(?:品保法規|品保與法規|法規)\s*[｜|／/]/.test(originalName)) {
    category = "qa_reg";
    name = stripFirstPrefix(originalName, /^(?:品保法規|品保與法規|法規)\s*[｜|／/]\s*/);
  } else if (/^年度風險評估(?:\s|$|[｜|／/])/.test(originalName)) {
    // 使用者明確指定年度風險評估屬於法規，不需要交給 AI 猜測。
    category = "qa_reg";
  } else if (/^專案\s*[｜|／/]/.test(originalName)) {
    category = "project";
    name = stripFirstPrefix(originalName, /^專案\s*[｜|／/]\s*/);
  } else if (/^行政\s*[｜|／/]/.test(originalName)) {
    name = stripFirstPrefix(originalName, /^行政\s*[｜|／/]\s*/);
    category = /^(工作週報|週報月報KPI)$/.test(name) ? "routine_report" : "admin";
  } else if (/^教育訓練\s*[｜|／/]/.test(originalName)) {
    category = "training";
    name = stripFirstPrefix(originalName, /^教育訓練\s*[｜|／/]\s*/);
  } else if (/^(?:文獻|文獻庫)\s*[｜|／/]/.test(originalName)) {
    category = "literature";
    name = stripFirstPrefix(originalName, /^(?:文獻|文獻庫)\s*[｜|／/]\s*/);
  } else if (/^AI\s*導用\s*[｜|／/]/i.test(originalName)) {
    category = "ai_adoption";
    name = stripFirstPrefix(originalName, /^AI\s*導用\s*[｜|／/]\s*/i);
  }

  if (originalName === "教育訓練（根）" || originalName === "教育訓練") {
    category = "training";
    name = "一般訓練";
  }
  if (category === "qa_reg" && /^(?:ISO標準|ISO 標準)$/i.test(name)) name = "ISO";
  if (category === "qa_reg" && /^IFU$/i.test(name)) name = "IFU";
  if (!name) name = originalName;

  return { name: cleanName(name), category };
}

/**
 * 一次性正規化既有根資料夾：只改 name/category，不碰 parent_id、entries、attachments。
 * 同一工作分類內若會收斂成同名，全部跳過並留下明細；不同分類可以同名。
 */
export async function normalizeExistingWorkSections(db, { timestamp, logHistory } = {}) {
  const { results = [] } = await db.prepare(
    `SELECT id, parent_id, name, category, COALESCE(role, '') AS role
     FROM folders
     WHERE parent_id IS NULL AND COALESCE(deleted_at, '') = '' AND COALESCE(role, '') <> 'staging'
     ORDER BY id`
  ).all();

  const proposed = results.map((folder) => ({ folder, ...workSectionProposal(folder) }));
  const counts = new Map();
  for (const item of proposed) {
    const key = `${item.category}\u0000${normalizedKey(item.name)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const renamed = [];
  const recategorized = [];
  const conflicts = [];
  const invalid = [];
  for (const item of proposed) {
    const { folder, name, category } = item;
    if (!name || !FOLDER_CATEGORIES.includes(category)) {
      invalid.push({ id: Number(folder.id), name: folder.name, category: folder.category });
      continue;
    }
    const key = `${category}\u0000${normalizedKey(name)}`;
    if ((counts.get(key) || 0) > 1) {
      conflicts.push({ id: Number(folder.id), name: folder.name, proposed: name, category });
      continue;
    }
    const nameChanged = folder.name !== name;
    const categoryChanged = folder.category !== category;
    if (!nameChanged && !categoryChanged) continue;
    await db.prepare("UPDATE folders SET name = ?, category = ? WHERE id = ?")
      .bind(name, category, folder.id).run();
    if (logHistory) {
      await logHistory(
        db,
        null,
        Number(folder.id),
        "統一工作分類",
        `${folder.name} → ${WORK_SECTION_LABELS[category]}／${name}`,
      );
    }
    if (nameChanged) renamed.push({ id: Number(folder.id), from: folder.name, to: name });
    if (categoryChanged) recategorized.push({ id: Number(folder.id), from: folder.category || "misc", to: category });
  }

  return {
    checked: results.length,
    renamed_count: renamed.length,
    recategorized_count: recategorized.length,
    conflict_count: conflicts.length,
    invalid_count: invalid.length,
    renamed,
    recategorized,
    conflicts,
    invalid,
    finished_at: typeof timestamp === "function" ? timestamp() : timestamp,
  };
}
