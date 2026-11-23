/**
 * v257 MyLab ／ 儀器設備：實驗室儀器清冊，重點是「校正期限」。
 * 結構與藥品櫃（lab.js）一致：只放純函式（欄位定義、輸入清理、校正狀態計算）；資料庫與 API 在 worker.js。
 *
 * 校正期限＝「下次校正日期」；沒填時由「上次校正日期＋校正週期（月）」推算。
 * 停用、報廢的儀器不提醒；不需校正的（例如工作台）顯示「不需校正」。
 */
import { taipeiToday } from "./lab.js";

export const INSTRUMENT_CATEGORIES = ["量測", "加工", "滅菌", "環境", "試驗", "其他"];
export const INSTRUMENT_USE_STATUS = ["使用中", "維修中", "停用", "報廢"];
export const DEFAULT_CAL_WARN_DAYS = 30;

export const INSTRUMENT_FIELDS = [
  { key: "code", label: "編號", type: "text" },
  { key: "name_zh", label: "中文名稱", type: "text" },
  { key: "name_en", label: "英文名稱", type: "text" },
  { key: "category", label: "類別", type: "category" },
  { key: "brand", label: "品牌", type: "text" },
  { key: "model", label: "型號", type: "text" },
  { key: "serial_no", label: "序號", type: "text" },
  { key: "asset_no", label: "財產編號", type: "text" },
  { key: "supplier", label: "供應商", type: "text" },
  { key: "location", label: "存放位置", type: "text" },
  { key: "use_status", label: "使用狀態", type: "use_status" },
  { key: "purchased_date", label: "購入日期", type: "date" },
  { key: "calibration_required", label: "需要校正", type: "bool" },
  { key: "calibration_cycle_months", label: "校正週期（月）", type: "int" },
  { key: "last_calibrated_date", label: "上次校正日期", type: "date" },
  { key: "next_calibration_date", label: "下次校正日期", type: "date" },
  { key: "calibration_vendor", label: "校正單位", type: "text" },
  { key: "source", label: "資料來源", type: "text" },
  { key: "note", label: "備註", type: "text" },
];
export const INSTRUMENT_FIELD_KEYS = INSTRUMENT_FIELDS.map((f) => f.key);

/** 「還不知道」的字一律存成空值，畫面再顯示「待補」 */
const UNKNOWN_TEXT = /^(待確認|待補|未知|未標示|n\/?a|-|—)$/i;

function cleanDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

/** 清理單一欄位；回傳 { value } 或 { error } */
export function cleanInstrumentField(key, raw) {
  const field = INSTRUMENT_FIELDS.find((f) => f.key === key);
  if (!field) return { error: `未知欄位 ${key}` };
  if (field.type === "date") {
    const d = cleanDate(raw);
    return d === undefined ? { error: `${field.label}日期格式錯誤（YYYY-MM-DD）` } : { value: d };
  }
  if (field.type === "bool") {
    if (raw === null || raw === undefined || raw === "") return { value: 1 };
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "是", "yes", "y", "需要"].includes(s)) return { value: 1 };
    if (["0", "false", "否", "no", "n", "不需要"].includes(s)) return { value: 0 };
    return { error: `${field.label}只能是「是」或「否」` };
  }
  if (field.type === "int") {
    if (raw === null || raw === undefined || String(raw).trim() === "") return { value: null };
    const n = Number(String(raw).replace(/,/g, ""));
    if (!Number.isInteger(n) || n < 1 || n > 240) return { error: `${field.label}要是 1～240 的整數` };
    return { value: n };
  }
  if (field.type === "category") {
    const t = String(raw ?? "").trim();
    if (!t) return { value: null };
    return INSTRUMENT_CATEGORIES.includes(t) ? { value: t } : { error: `類別只能是 ${INSTRUMENT_CATEGORIES.join("／")}` };
  }
  if (field.type === "use_status") {
    const t = String(raw ?? "").trim() || "使用中";
    return INSTRUMENT_USE_STATUS.includes(t) ? { value: t } : { error: `使用狀態只能是 ${INSTRUMENT_USE_STATUS.join("／")}` };
  }
  const text = String(raw ?? "").trim().slice(0, key === "note" ? 2000 : 300);
  return { value: !text || UNKNOWN_TEXT.test(text) ? null : text };
}

/** 清理整筆輸入，只處理有帶的欄位；回傳 { values, errors } */
export function cleanInstrumentInput(body) {
  const values = {};
  const errors = [];
  for (const key of INSTRUMENT_FIELD_KEYS) {
    if (!(key in (body || {}))) continue;
    const r = cleanInstrumentField(key, body[key]);
    if (r.error) errors.push(r.error); else values[key] = r.value;
  }
  return { values, errors };
}

/** 日期加 n 個月（月底自動往前收，例如 1/31 ＋ 1 個月 ＝ 2/28） */
export function addMonths(iso, months) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const total = y * 12 + mo + Number(months);
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

/** 校正期限：優先用「下次校正日期」，否則由「上次校正日期＋週期」推算；兩者都沒有就是 null */
export function calibrationDue(row) {
  if (row.next_calibration_date) return { date: row.next_calibration_date, derived: false };
  if (row.last_calibrated_date && Number(row.calibration_cycle_months) > 0) {
    return { date: addMonths(row.last_calibrated_date, Number(row.calibration_cycle_months)), derived: true };
  }
  return null;
}

/**
 * 校正狀態：inactive（停用／報廢）、repair（維修中）、na（不需校正）、unknown（日期待確認）、
 * expired（逾期）、soon（即將到期）、ok（校正有效）。
 */
export function instrumentStatus(row, { today = taipeiToday(), warnDays = DEFAULT_CAL_WARN_DAYS } = {}) {
  const flags = [];
  if (!row.location) flags.push("位置待補");
  const use = row.use_status || "使用中";
  if (use === "停用" || use === "報廢") return { state: "inactive", text: use === "報廢" ? "已報廢" : "停用中", due: null, days: null, flags };
  if (use === "維修中") return { state: "repair", text: "維修中", due: null, days: null, flags };
  if (row.calibration_required === 0 || row.calibration_required === "0") return { state: "na", text: "不需校正", due: null, days: null, flags };
  const due = calibrationDue(row);
  if (!due) return { state: "unknown", text: "校正日期待確認", due: null, days: null, flags };
  const days = daysBetween(today, due.date);
  if (days < 0) return { state: "expired", text: `已逾校正日 ${-days} 天`, due, days, flags };
  if (days <= warnDays) return { state: "soon", text: days === 0 ? "今天須校正" : `${days} 天後須校正`, due, days, flags };
  return { state: "ok", text: "校正有效", due, days, flags };
}

export function instrumentSummary(rows, options) {
  const summary = { total: rows.length, expired: 0, soon: 0, ok: 0, unknown: 0, na: 0, repair: 0, inactive: 0, need_location: 0 };
  for (const r of rows) {
    const s = instrumentStatus(r, options);
    summary[s.state]++;
    if (s.flags.includes("位置待補")) summary.need_location++;
  }
  return summary;
}

/** 下一個可用編號：EQ-001、EQ-002…（沿用最大值＋1） */
export function nextInstrumentCode(codes) {
  let max = 0;
  for (const c of codes) {
    const m = String(c || "").match(/^EQ-(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `EQ-${String(max + 1).padStart(3, "0")}`;
}

/** 兩筆資料的差異（給修改紀錄用） */
export function diffInstrument(before, after) {
  const changes = {};
  for (const key of INSTRUMENT_FIELD_KEYS) {
    if (!(key in after)) continue;
    const a = before?.[key] ?? null;
    const b = after[key] ?? null;
    if (a !== b) changes[key] = [a, b];
  }
  return changes;
}
