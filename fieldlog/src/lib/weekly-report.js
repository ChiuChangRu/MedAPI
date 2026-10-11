/**
 * 工作週報的唯一邏輯來源：fieldlog 前台（本週周報、資料夾裡的新紀錄）與
 * medapi-mcp 的週報工具都 import 這一份，週次計算、檔名格式、一週一檔的
 * 判斷與版本備份只寫一次，手動建與自動建出來的週報不會長得不一樣。
 *
 * 週報的權威資料是 entries.fields_json（_kind = 'weekly_report'），body 只是
 * 給搜尋／分享／匯出用的衍生文字，每次寫入都由欄位重建。
 */

export const WEEKLY_REPORT_KIND = "weekly_report";
export const WEEKLY_REPORT_FOLDER_ROLE = "weekly_reports";
export const WEEKLY_REPORT_FOLDER_NAME = "工作週報";
export const WEEKLY_REPORT_FIXED_PLAN = [
  "- 宜科廠高壓攝影導管用注射筒套組－功能性驗證",
  "- 醫用塗層與親水性導管開發",
  "- 檢體針開發",
  "- Laborie 29種壓管代工，與 Laborie 關注物質（毒物）資料更新",
].join("\n");
export const DAILY_LOG_FIELD = "每日紀錄";
// 人與 Claude 都可以寫的欄位；週次、期間、中長期規劃由系統固定。
export const WEEKLY_REPORT_EDITABLE_FIELDS = ["本週工作報告", "下週重要工作計畫", DAILY_LOG_FIELD];

export const ENTRY_VERSIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entry_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    title TEXT,
    fields_json TEXT,
    body TEXT,
    body_format TEXT,
    reason TEXT DEFAULT '',
    source TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entry_versions_entry ON entry_versions(entry_id, id)`,
];

const DAY_MS = 86400000;
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

/** 台北時間所在的 ISO 週（週一到週五為報告期間）。 */
export function taipeiIsoWeek(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const local = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = local.getUTCDay() || 7;
  const thursday = new Date(local);
  thursday.setUTCDate(local.getUTCDate() + 4 - weekday);
  const year = thursday.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((thursday - first) / DAY_MS) + 1) / 7);
  const monday = new Date(local);
  monday.setUTCDate(local.getUTCDate() - weekday + 1);
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  return { year, week, key: `${year}-W${String(week).padStart(2, "0")}`, start: isoDate(monday), end: isoDate(friday), date: isoDate(local) };
}

// 台北中午（UTC 04:00）不會因時區換算跨到前後一天。
function taipeiNoon(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day, 4));
}

export function isoWeekFromKey(value) {
  const match = String(value || "").trim().toUpperCase().match(/^(\d{4})-?W(\d{1,2})$/);
  if (!match) throw new Error(`週次格式錯誤：「${value}」，請用 2026-W41 這種格式`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOfWeek1 = 4 - ((jan4.getUTCDay() || 7) - 1);
  const info = taipeiIsoWeek(taipeiNoon(year, 0, mondayOfWeek1 + (week - 1) * 7));
  if (week < 1 || info.year !== year || info.week !== week) throw new Error(`${year} 年沒有第 ${week} 週`);
  return info;
}

export function isoWeekFromDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`日期格式錯誤：「${value}」，請用 2026-10-06 這種格式`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const noon = taipeiNoon(year, month - 1, day);
  if (noon.getUTCMonth() !== month - 1 || noon.getUTCDate() !== day) throw new Error(`沒有 ${value} 這一天`);
  return taipeiIsoWeek(noon);
}

/** week（2026-W41）優先，其次 date（2026-10-06），都沒給就是今天（台北）。 */
export function resolveReportWeek({ week, date } = {}, now = new Date()) {
  const byWeek = week ? isoWeekFromKey(week) : null;
  const byDate = date ? isoWeekFromDate(date) : null;
  if (byWeek && byDate && byWeek.key !== byDate.key) {
    throw new Error(`week（${byWeek.key}）與 date（${date} 屬於 ${byDate.key}）不一致，請只給其中一個`);
  }
  return byWeek || byDate || taipeiIsoWeek(now);
}

export function previousReportWeek(info) {
  return taipeiIsoWeek(new Date(Date.parse(`${info.start}T04:00:00Z`) - 7 * DAY_MS));
}

export function weeklyReportTitle(info) {
  const monthDay = (iso) => iso.slice(5).replace("-", "/");
  return `${info.key} 工作週報（${monthDay(info.start)}–${monthDay(info.end)}）`;
}

export function weeklyReportPeriod(info) {
  return `${info.start}–${info.end}`;
}

export function weeklyReportText(fields) {
  const lines = [
    `週次：${fields["週次"] || ""}`,
    `期間：${fields["期間"] || ""}`,
    "",
    "一、本部門中長期（六個月以上）規劃（課長級及以上主管－含副總）",
    fields["中長期規劃"] || WEEKLY_REPORT_FIXED_PLAN,
    "",
    "二、本週工作報告",
    fields["本週工作報告"] || "",
    "",
    "三、下週重要工作計畫",
    fields["下週重要工作計畫"] || "",
  ];
  // 每日紀錄是週五整合正式週報用的素材，不屬於公司格式的三段；有內容才附在最後。
  const daily = String(fields[DAILY_LOG_FIELD] || "").trim();
  if (daily) lines.push("", "（附）每日紀錄", daily);
  return lines.join("\n").trim();
}

export function parseWeeklyReportFields(entry) {
  let fields;
  try { fields = JSON.parse(entry?.fields_json || "{}"); } catch { return null; }
  return fields && fields._kind === WEEKLY_REPORT_KIND ? fields : null;
}

function hasWrittenContent(fields) {
  return WEEKLY_REPORT_EDITABLE_FIELDS.some((key) => String(fields?.[key] || "").trim());
}

async function insertHistory(db, entryId, folderId, action, detail, timestamp) {
  await db.prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(entryId, folderId, action, String(detail || "").slice(0, 200), timestamp).run();
}

export async function ensureWeeklyReportFolder(db, timestamp) {
  const folder = await db.prepare(
    "SELECT id, name FROM folders WHERE role = ? AND COALESCE(deleted_at, '') = '' LIMIT 1"
  ).bind(WEEKLY_REPORT_FOLDER_ROLE).first();
  if (folder) return folder;
  const existing = await db.prepare(
    "SELECT id, name FROM folders WHERE parent_id IS NULL AND name = ? AND COALESCE(deleted_at, '') = '' LIMIT 1"
  ).bind(WEEKLY_REPORT_FOLDER_NAME).first();
  if (existing) {
    await db.prepare("UPDATE folders SET role = ?, type = ?, category = ? WHERE id = ?")
      .bind(WEEKLY_REPORT_FOLDER_ROLE, "週報", "routine_report", existing.id).run();
    return existing;
  }
  const created = await db.prepare(
    "INSERT INTO folders (name, type, category, parent_id, role, created_at) VALUES (?, ?, ?, NULL, ?, ?)"
  ).bind(WEEKLY_REPORT_FOLDER_NAME, "週報", "routine_report", WEEKLY_REPORT_FOLDER_ROLE, timestamp).run();
  const id = Number(created.meta.last_row_id);
  await insertHistory(db, null, id, "建立資料夾", "工作週報（每週獨立檔案）", timestamp);
  return { id, name: WEEKLY_REPORT_FOLDER_NAME };
}

const REPORT_COLUMNS = "id, title, folder_id, fields_json, body, created_at, updated_at";

/** 不限資料夾：週報被人搬到別處也還是同一週的那一份，不會因此再建一份。 */
export async function findWeeklyReport(db, weekKey) {
  return db.prepare(
    `SELECT ${REPORT_COLUMNS} FROM entries
      WHERE json_extract(fields_json, '$._kind') = 'weekly_report'
        AND json_extract(fields_json, '$.週次') = ?
        AND COALESCE(deleted_at, '') = ''
      ORDER BY id LIMIT 1`
  ).bind(weekKey).first();
}

/** 標題提到這一週、但不是週報模板的舊手寫記事（例如「2026-W40工作周報」）。 */
export async function findLegacyWeekNotes(db, weekKey) {
  const { results } = await db.prepare(
    `SELECT id, title, created_at, updated_at FROM entries
      WHERE title LIKE ? AND COALESCE(json_extract(fields_json, '$._kind'), '') <> 'weekly_report'
        AND COALESCE(deleted_at, '') = ''
      ORDER BY id`
  ).bind(`%${weekKey}%`).all();
  return results || [];
}

export async function getOrCreateWeeklyReport(db, { week, date, timestamp, source = "前台", now = new Date() } = {}) {
  const info = resolveReportWeek({ week, date }, now);
  const existing = await findWeeklyReport(db, info.key);
  if (existing) return { info, entry: existing, created: false };
  const folder = await ensureWeeklyReportFolder(db, timestamp);
  const fields = {
    _kind: WEEKLY_REPORT_KIND,
    "週次": info.key,
    "期間": weeklyReportPeriod(info),
    "中長期規劃": WEEKLY_REPORT_FIXED_PLAN,
    "本週工作報告": "",
    "下週重要工作計畫": "",
  };
  const title = weeklyReportTitle(info);
  const created = await db.prepare(
    "INSERT INTO entries (folder_id, title, fields_json, body, body_format, created_at) VALUES (?, ?, ?, ?, 'text', ?)"
  ).bind(folder.id, title, JSON.stringify(fields), weeklyReportText(fields), timestamp).run();
  const id = Number(created.meta.last_row_id);
  // 前台按鈕與排程同時建立同一週時，保留最早那一份，把自己這份收掉。
  const winner = await findWeeklyReport(db, info.key);
  if (winner && Number(winner.id) !== id) {
    await db.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").bind(timestamp, id).run();
    return { info, entry: winner, created: false };
  }
  await insertHistory(db, id, folder.id, "建立週報模板", `${info.key}（${source}）`, timestamp);
  return { info, entry: await findWeeklyReport(db, info.key), created: true };
}

/** 寫入前把整筆記事目前的樣子原封不動複製一份（在資料庫內一次完成）。 */
export async function saveEntryVersion(db, entryId, { reason = "", source = "", timestamp }) {
  // medapi-mcp 可能比 fieldlog 的 ensureSchema 先跑到，表不存在時自己補建。
  await db.batch(ENTRY_VERSIONS_SCHEMA.map((sql) => db.prepare(sql)));
  const result = await db.prepare(
    `INSERT INTO entry_versions (entry_id, title, fields_json, body, body_format, reason, source, created_at)
     SELECT id, title, fields_json, body, body_format, ?, ?, ? FROM entries WHERE id = ?`
  ).bind(reason, source, timestamp, entryId).run();
  return Number(result.meta.last_row_id);
}

export async function listEntryVersions(db, entryId, limit = 5) {
  try {
    const { results } = await db.prepare(
      "SELECT id, reason, source, created_at FROM entry_versions WHERE entry_id = ? ORDER BY id DESC LIMIT ?"
    ).bind(entryId, limit).all();
    return results || [];
  } catch {
    return [];
  }
}

async function loadWeeklyReport(db, { entryId, week }) {
  let entry = null;
  if (entryId) {
    entry = await db.prepare(`SELECT ${REPORT_COLUMNS} FROM entries WHERE id = ? AND COALESCE(deleted_at, '') = ''`)
      .bind(Number(entryId)).first();
    if (!entry) throw new Error(`找不到記事 ${entryId}`);
  }
  const info = week ? isoWeekFromKey(week) : null;
  if (!entry && info) {
    entry = await findWeeklyReport(db, info.key);
    if (!entry) throw new Error(`${info.key} 還沒有週報，請先呼叫 create_weekly_report 建立`);
  }
  if (!entry) throw new Error("請提供 week（例如 2026-W41）或 entry_id");
  const fields = parseWeeklyReportFields(entry);
  if (!fields) throw new Error("安全限制：這筆不是 MyWiki 週報模板，不能透過此工具修改");
  if (info && fields["週次"] !== info.key) {
    throw new Error(`entry ${entry.id} 是 ${fields["週次"]} 的週報，不是 ${info.key}`);
  }
  return { entry, fields };
}

/**
 * 只改白名單欄位。內容真的有變才寫入；寫入前若原本已有內容，先存一份版本，
 * 避免排程或對話把上一版整段覆寫掉後找不回來。
 */
export async function updateWeeklyReport(db, { entryId, week, patch, timestamp, source }) {
  const { entry, fields } = await loadWeeklyReport(db, { entryId, week });
  const next = { ...fields };
  for (const key of WEEKLY_REPORT_EDITABLE_FIELDS) {
    if (patch[key] !== undefined) next[key] = String(patch[key] ?? "").trim();
  }
  const changed = WEEKLY_REPORT_EDITABLE_FIELDS.filter((key) => String(next[key] ?? "") !== String(fields[key] ?? ""));
  if (!changed.length) return { entry, fields, changed, versionId: null };
  const versionId = hasWrittenContent(fields)
    ? await saveEntryVersion(db, entry.id, { reason: `更新前備份：${changed.join("、")}`, source, timestamp })
    : null;
  await db.prepare("UPDATE entries SET fields_json = ?, body = ?, body_format = 'text', updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(next), weeklyReportText(next), timestamp, entry.id).run();
  await insertHistory(db, entry.id, entry.folder_id, "更新週報",
    `${next["週次"] || entry.title}：${changed.join("、")}（${source}${versionId ? `，已備份版本 ${versionId}` : ""}）`, timestamp);
  return { entry, fields: next, changed, versionId };
}

export function dailyLogHeading(info) {
  const [year, month, day] = info.date.split("-").map(Number);
  const weekday = WEEKDAY_ZH[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `【${info.date.slice(5).replace("-", "/")}（${weekday}）】`;
}

const DAILY_HEADING = /^【\d{2}\/\d{2}（.）】$/;

/** 把一段文字接到「每日紀錄」裡當天的段落；同一段文字重複送不會重複附加。 */
export function appendToDailyLog(existing, heading, text) {
  const addition = String(text || "").trim();
  if (!addition) throw new Error("text 為必填");
  const lines = String(existing || "").trim() ? String(existing).trim().split("\n") : [];
  const start = lines.indexOf(heading);
  if (start === -1) {
    return { value: [...lines, ...(lines.length ? [""] : []), heading, addition].join("\n"), appended: true };
  }
  let end = start + 1;
  while (end < lines.length && !DAILY_HEADING.test(lines[end])) end++;
  const section = lines.slice(start + 1, end).join("\n");
  if (section.includes(addition)) return { value: lines.join("\n"), appended: false };
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, addition);
  return { value: lines.join("\n"), appended: true };
}
