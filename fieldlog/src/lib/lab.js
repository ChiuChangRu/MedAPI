/**
 * v250 MyLab ／ 藥品櫃：實驗室試劑清冊。
 * 欄位沿用使用者的「我的藥品櫃清冊」Excel（23 欄，「日期狀態」由程式計算不另存）。
 * 這支只放純函式：欄位定義、輸入清理、到期狀態計算。資料庫與 API 在 worker.js。
 */

export const LAB_FIELDS = [
  { key: "code", label: "編號", type: "text" },
  { key: "name_zh", label: "中文名稱", type: "text" },
  { key: "name_en", label: "英文名稱", type: "text" },
  { key: "formula", label: "化學式", type: "text" },
  { key: "cas", label: "CAS No.", type: "text" },
  { key: "brand", label: "品牌", type: "text" },
  { key: "catalog_no", label: "貨號", type: "text" },
  { key: "grade", label: "等級", type: "text" },
  { key: "purity_spec", label: "純度規格", type: "text" },
  { key: "coa_result", label: "COA實測", type: "text" },
  { key: "lot_no", label: "批號", type: "text" },
  { key: "purchased_qty", label: "已知購買量", type: "number" },
  { key: "remaining_qty", label: "實際餘量", type: "number" },
  { key: "unit", label: "單位", type: "unit" },
  { key: "location", label: "存放位置", type: "text" },
  { key: "opened_date", label: "開封日期", type: "date" },
  { key: "manufactured_date", label: "製造日期", type: "date" },
  { key: "released_date", label: "放行／檢驗日期", type: "date" },
  { key: "expiry_date", label: "有效期限", type: "date" },
  { key: "retest_date", label: "複驗日期", type: "date" },
  { key: "retest_month", label: "複驗月份（僅年月）", type: "month" },
  { key: "source", label: "資料來源", type: "text" },
  { key: "note", label: "備註", type: "text" },
];
export const LAB_FIELD_KEYS = LAB_FIELDS.map((f) => f.key);
export const LAB_UNITS = ["g", "kg", "mg", "mL", "L", "瓶", "個"];
export const DEFAULT_WARN_DAYS = 90;

/** Excel 裡用來表示「還不知道」的字，一律存成空值，畫面再顯示「待補」 */
const UNKNOWN_TEXT = /^(待確認|待補|未知|未標示|n\/?a|-|—)$/i;

function cleanDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return undefined; // 格式錯誤
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

function cleanMonth(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).match(/^(\d{4})[-/.](\d{1,2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  return `${m[1]}-${m[2].padStart(2, "0")}`;
}

/** 清理單一欄位；回傳 { value } 或 { error } */
export function cleanLabField(key, raw) {
  const field = LAB_FIELDS.find((f) => f.key === key);
  if (!field) return { error: `未知欄位 ${key}` };
  if (field.type === "number") {
    if (raw === null || raw === undefined || String(raw).trim() === "") return { value: null };
    const n = Number(String(raw).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return { error: `${field.label}要是 0 以上的數字` };
    return { value: n };
  }
  if (field.type === "unit") {
    const u = String(raw || "").trim() || "g";
    return LAB_UNITS.includes(u) ? { value: u } : { error: `單位只能是 ${LAB_UNITS.join("／")}` };
  }
  if (field.type === "date") {
    const d = cleanDate(raw);
    return d === undefined ? { error: `${field.label}日期格式錯誤（YYYY-MM-DD）` } : { value: d };
  }
  if (field.type === "month") {
    const m = cleanMonth(raw);
    return m === undefined ? { error: `${field.label}格式錯誤（YYYY-MM）` } : { value: m };
  }
  const text = String(raw ?? "").trim().slice(0, key === "note" ? 2000 : 300);
  return { value: !text || UNKNOWN_TEXT.test(text) ? null : text };
}

/** 清理整筆輸入，只處理有帶的欄位；回傳 { values, errors } */
export function cleanLabInput(body) {
  const values = {};
  const errors = [];
  for (const key of LAB_FIELD_KEYS) {
    if (!(key in (body || {}))) continue;
    const r = cleanLabField(key, body[key]);
    if (r.error) errors.push(r.error); else values[key] = r.value;
  }
  return { values, errors };
}

/** 台北時間的今天（YYYY-MM-DD） */
export function taipeiToday(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

/**
 * 到期狀態：有效期限、複驗日期、複驗月份取最早的一個當期限。
 * 只有年月的不推定日期：以「該月 1 日」保守判斷是否進入提醒期，畫面顯示年月。
 */
export function reagentStatus(row, { today = taipeiToday(), warnDays = DEFAULT_WARN_DAYS } = {}) {
  const candidates = [];
  if (row.expiry_date) candidates.push({ kind: "expiry", date: row.expiry_date, label: "有效期限", display: row.expiry_date });
  if (row.retest_date) candidates.push({ kind: "retest", date: row.retest_date, label: "複驗日期", display: row.retest_date });
  if (row.retest_month) candidates.push({ kind: "retest_month", date: `${row.retest_month}-01`, label: "複驗月份", display: row.retest_month });
  const flags = [];
  if (row.remaining_qty === null || row.remaining_qty === undefined) flags.push("待盤點");
  if (!row.location) flags.push("位置待補");
  if (!candidates.length) return { state: "unknown", text: "期限待確認", deadline: null, days: null, flags };
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  const deadline = candidates[0];
  // 只有年月時：該月還沒過完就不算過期（以月底判斷過期、以月初判斷提醒）
  const expiredAt = deadline.kind === "retest_month"
    ? new Date(Date.UTC(Number(deadline.date.slice(0, 4)), Number(deadline.date.slice(5, 7)), 0)).toISOString().slice(0, 10)
    : deadline.date;
  const days = daysBetween(today, deadline.date);
  if (daysBetween(today, expiredAt) < 0) {
    return { state: "expired", text: deadline.kind === "expiry" ? "已過期" : "已過複驗日", deadline, days, flags };
  }
  if (days <= warnDays) {
    return { state: "soon", text: deadline.kind === "expiry" ? `${Math.max(days, 0)} 天後到期` : `${Math.max(days, 0)} 天後須複驗`, deadline, days, flags };
  }
  return { state: "ok", text: deadline.kind === "retest_month" ? "期限內（僅載年月）" : "期限內", deadline, days, flags };
}

export function labSummary(rows, options) {
  const summary = { total: rows.length, expired: 0, soon: 0, ok: 0, unknown: 0, need_inventory: 0, need_location: 0 };
  for (const r of rows) {
    const s = reagentStatus(r, options);
    summary[s.state]++;
    if (s.flags.includes("待盤點")) summary.need_inventory++;
    if (s.flags.includes("位置待補")) summary.need_location++;
  }
  return summary;
}

/** 下一個可用編號：CH-001、CH-002…（沿用最大值＋1） */
export function nextReagentCode(codes) {
  let max = 0;
  for (const c of codes) {
    const m = String(c || "").match(/^CH-(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CH-${String(max + 1).padStart(3, "0")}`;
}

/** 兩筆資料的差異（給修改紀錄用） */
export function diffReagent(before, after) {
  const changes = {};
  for (const key of LAB_FIELD_KEYS) {
    if (!(key in after)) continue;
    const a = before?.[key] ?? null;
    const b = after[key] ?? null;
    if (a !== b) changes[key] = [a, b];
  }
  return changes;
}
