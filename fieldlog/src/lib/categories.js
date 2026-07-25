/**
 * 分類字典的讀寫——資料夾層級分類（folder_type）與醫材分類（device）。
 *
 * 為什麼要有這一層：這兩套分類原本是寫死在程式碼陣列裡的，要新增或刪除一個分類
 * 都得改程式碼、重新部署，使用者自己在畫面上動不了。分類是會一直長的東西
 * （新產品線、新文件類型、公司內部新的歸檔習慣），寫死等於每次都要工程介入。
 *
 * 刪除分類的原則：只刪「選項」，不動已經套用在資料上的文字。
 * folders.type 與 attachments.device_category 存的是分類名稱字串，
 * 刪掉選項之後既有資料的分類文字仍然留著，不會靜默消失；使用者要改就自己改。
 * 改名則會一併更新既有資料——那是「同一個分類換個叫法」，不更新才是錯的。
 */

const KINDS = new Set(["folder_type", "device"]);
const MAX_LEVEL = 4;

function parseFields(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rowToCategory(row) {
  return {
    id: row.id,
    kind: row.kind,
    level: Number(row.level || 0),
    name: row.name,
    icon: row.icon || "🗂️",
    note: row.note || "",
    fields: parseFields(row.fields_json),
    sort_order: Number(row.sort_order || 0),
  };
}

/** 讀分類清單。kind／level 可選；'_seeded' 那筆內部標記列永遠不會回傳。 */
export async function listCategories(db, { kind, level } = {}) {
  const where = ["kind != '_seeded'"];
  const binds = [];
  if (kind) {
    where.push("kind = ?");
    binds.push(kind);
  }
  if (level !== undefined && level !== null && level !== "") {
    // level 0＝通用分類，每一層都要出現，所以指定層級時連 0 一起撈
    where.push("(level = ? OR level = 0)");
    binds.push(Number(level));
  }
  const statement = db.prepare(
    `SELECT * FROM categories WHERE ${where.join(" AND ")}
     ORDER BY kind, level, sort_order, id`
  );
  const { results } = await (binds.length ? statement.bind(...binds) : statement).all();
  return (results || []).map(rowToCategory);
}

/**
 * 分類的使用統計——刪除前要讓使用者知道「這個分類還有幾個東西在用」，
 * 不能讓他在不知情的狀況下刪掉正在用的分類。
 */
export async function categoryUsage(db, category) {
  if (category.kind === "folder_type") {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM folders WHERE type = ?")
      .bind(category.name).first();
    return { label: "個資料夾", count: Number(row?.count || 0) };
  }
  const row = await db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE device_category = ?")
    .bind(category.name).first();
  return { label: "份檔案", count: Number(row?.count || 0) };
}

export async function createCategory(db, body, { logHistory, timestamp }) {
  const kind = String(body.kind || "folder_type").trim();
  if (!KINDS.has(kind)) return { error: "kind 只能是 folder_type 或 device", status: 400 };
  const name = String(body.name || "").trim().slice(0, 60);
  if (!name) return { error: "分類名稱為必填", status: 400 };
  const level = kind === "device" ? 0 : Math.max(0, Math.min(MAX_LEVEL, Number(body.level ?? 0)));
  const icon = String(body.icon || "🗂️").trim().slice(0, 8) || "🗂️";
  const note = String(body.note || "").trim().slice(0, 120);
  const fields = Array.isArray(body.fields)
    ? body.fields.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
    : [];

  const existing = await db.prepare(
    "SELECT id FROM categories WHERE kind = ? AND level = ? AND name = ?"
  ).bind(kind, level, name).first();
  if (existing) return { error: `「${name}」這個分類已經存在`, status: 409 };

  // 新分類排在同層最後面
  const maxRow = await db.prepare(
    "SELECT MAX(sort_order) AS max_order FROM categories WHERE kind = ? AND level = ?"
  ).bind(kind, level).first();
  const sortOrder = Number(maxRow?.max_order || 0) + 1;

  const result = await db.prepare(
    `INSERT INTO categories (kind, level, name, icon, note, fields_json, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(kind, level, name, icon, note, JSON.stringify(fields), sortOrder, timestamp()).run();

  const where = kind === "device" ? "醫材分類" : level ? `資料夾第 ${level} 層` : "資料夾通用";
  await logHistory(db, null, null, "新增分類", `${where}：${name}`);
  return { ok: true, id: Number(result.meta.last_row_id) };
}

/** 改分類：改名時一併更新既有資料上的分類文字（同一個分類換叫法，不更新才是錯的） */
export async function updateCategory(db, id, body, { logHistory }) {
  const old = await db.prepare("SELECT * FROM categories WHERE id = ? AND kind != '_seeded'")
    .bind(id).first();
  if (!old) return { error: "找不到這個分類", status: 404 };

  // 先把「改之前的樣子」抓成區域變數再開始動資料。後面同步既有資料時要拿舊名稱去比對，
  // 如果那時候才讀 old.name，就得假設 old 這個物件沒被前面的 UPDATE 影響——
  // 這種對讀取順序的隱性依賴很容易在之後被改壞。
  const previousName = String(old.name);
  const previousLevel = Number(old.level || 0);
  const kind = old.kind;

  const name = body.name !== undefined ? String(body.name || "").trim().slice(0, 60) : previousName;
  if (!name) return { error: "分類名稱不可為空", status: 400 };
  const level = body.level !== undefined && kind !== "device"
    ? Math.max(0, Math.min(MAX_LEVEL, Number(body.level)))
    : previousLevel;
  const icon = body.icon !== undefined ? String(body.icon || "🗂️").trim().slice(0, 8) || "🗂️" : old.icon;
  const note = body.note !== undefined ? String(body.note || "").trim().slice(0, 120) : old.note;
  const fieldsJson = body.fields !== undefined
    ? JSON.stringify(
        Array.isArray(body.fields)
          ? body.fields.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
          : []
      )
    : old.fields_json;

  if (name !== previousName || level !== previousLevel) {
    const clash = await db.prepare(
      "SELECT id FROM categories WHERE kind = ? AND level = ? AND name = ? AND id != ?"
    ).bind(kind, level, name, id).first();
    if (clash) return { error: `「${name}」這個分類已經存在`, status: 409 };
  }

  await db.prepare(
    "UPDATE categories SET name = ?, level = ?, icon = ?, note = ?, fields_json = ? WHERE id = ?"
  ).bind(name, level, icon, note, fieldsJson, id).run();

  let renamed = 0;
  if (name !== previousName) {
    // 改名＝同一個分類換個叫法，既有資料上的分類文字要跟著改，否則那些資料會突然
    // 指向一個不存在的分類名稱
    const result = kind === "folder_type"
      ? await db.prepare("UPDATE folders SET type = ? WHERE type = ?").bind(name, previousName).run()
      : await db.prepare("UPDATE attachments SET device_category = ? WHERE device_category = ?")
        .bind(name, previousName).run();
    renamed = Number(result.meta.changes || 0);
    await logHistory(db, null, null, "分類改名", `${previousName} → ${name}（同步更新 ${renamed} 筆）`);
  }
  return { ok: true, renamed };
}

/**
 * 刪分類：只刪選項本身。既有資料上的分類文字保留，並在回應裡回報還有幾筆在用，
 * 讓使用者知道刪完之後那些資料會變成「用著一個已經不在清單上的分類」。
 */
export async function deleteCategory(db, id, { logHistory }) {
  const category = await db.prepare("SELECT * FROM categories WHERE id = ? AND kind != '_seeded'")
    .bind(id).first();
  if (!category) return { error: "找不到這個分類", status: 404 };

  const usage = await categoryUsage(db, category);
  await db.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
  await logHistory(
    db, null, null, "刪除分類",
    `${category.name}${usage.count ? `（仍有 ${usage.count} ${usage.label}沿用這個分類名稱）` : ""}`
  );
  return { ok: true, still_used: usage.count, still_used_label: usage.label };
}

/** 醫材分類的選項名稱集合——存檔前驗證用 */
export async function deviceCategoryNames(db) {
  const { results } = await db.prepare(
    "SELECT name FROM categories WHERE kind = 'device' ORDER BY sort_order, id"
  ).all();
  return (results || []).map((row) => row.name);
}
