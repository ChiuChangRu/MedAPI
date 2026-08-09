/**
 * 標準文件檔名整理——ISO／IEC／ASTM／JIS／FDA／MDR 的編號辨識與中文命名。
 *
 * 整併前這套邏輯有「兩份」：一份在批次整理（全庫掃描＋PDF 內容去重）裡，
 * 一份在單檔改名裡，各自帶一張標準中文標題對照表與一張預設年份表。兩張表內容
 * 不一致（例如同一個 ISO 7886-1 一邊有預設年份、一邊沒有），造成同一份檔案
 * 走批次跟走單檔會得到不同結果。這裡把對照表統一成一份，兩個入口共用。
 *
 * 兩個入口的「取值策略」刻意保留差異，因為情境不同：
 *   - parseStandard（單檔改名）：以檔名為主。使用者手動點某一份檔案要它改名，
 *     檔名裡的編號最可信；年份無法確認時寧可不改（回 incomplete_year）。
 *   - standardIdentity（批次整理）：以 OCR 內容為主。全庫掃描時很多檔名只有編號
 *     沒有年份，而 PDF 內文通常寫著完整年份。
 */

// 標準編號 → 中文標題。鍵可以是「組織_編號」（與年份無關，優先）
// 或「組織_編號_年份」（少數只在特定年份成立的文件，例如 FDA 指引）。
const STANDARD_TITLES = new Map([
  ["ISO_7886-1", "無菌皮下注射器－第1部：手動使用注射器"],
  ["ISO_7886-2", "無菌皮下注射器－第2部：動力驅動注射泵用注射器"],
  ["ISO_7886-3", "無菌皮下注射器－第3部：固定劑量免疫用自毀式注射器"],
  ["ISO_7886-4", "無菌皮下注射器－第4部：具防止重複使用功能的注射器"],
  ["ISO_8536-12", "醫療用輸液器具－第12部：單次使用止回閥"],
  ["ISO_8536-14", "醫療用輸液器具－第14部：非接液式輸血與輸液器具用夾具及流量調節器"],
  ["ISO_10555-1", "血管內導管－無菌及單次使用導管－第1部：一般要求"],
  ["ISO_10555-8", "血管內導管－無菌及單次使用導管－第8部：體外血液處理用導管"],
  ["ISO_10993-4", "醫療器材生物性評估－第4部：與血液交互作用試驗選擇"],
  ["ASTM_F640", "醫療用不透射線性測試"],
  ["MDR_2017-745", "歐盟醫療器材法規"],
  ["FDA_2024", "血管內導管510k指引"],
]);

// 內文與檔名都找不到年份時的保守預設值——只收錄「現行版本明確、不會誤導」的標準。
// 沒收錄的標準寧可不補年份（單檔改名會回報 incomplete_year，要求先擷取文字）。
const DEFAULT_YEARS = new Map([
  ["ISO_7886-1", "2017"],
  ["ISO_7886-2", "2020"],
  ["ISO_7886-3", "2020"],
  ["ISO_7886-4", "2018"],
  ["ISO_8536-14", "2016"],
]);

// 一份文件可能被寫成 ISO 7886-1、ISO_7886-1、EN ISO 7886-1、ISO/TS 11135…
// 這個 pattern 同時吃空白、底線、冒號、連字號當分隔。
const STANDARD_PATTERN =
  /\b(EN[\s_-]+ISO|ISO(?:[\s_-]*\/[\s_-]*(?:TS|TR))?|IEC|ASTM|JIS)[\s_:\-]*([A-Z]?\d{3,6}(?:-\d{1,3})?)(?:[\s_:\-]*((?:19|20)\d{2}))?/i;

/** 檔名安全化：去掉副檔名與檔案系統不允許的字元，空白統一成底線 */
export function cleanPart(value, max = 150) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|#]+/g, " ")
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function normalizeOrg(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[\s_-]+ISO$/, "_ISO")
    .replace(/[\s_-]*\/[\s_-]*/g, "_")
    .replace(/\s+/g, "_");
}

/** 標準編號 → 中文標題（先試與年份無關的鍵，再試含年份的鍵） */
export function standardTitle(org, number, year) {
  const withoutYear = [org, number].filter(Boolean).join("_");
  const withYear = [org, number, year].filter(Boolean).join("_");
  return STANDARD_TITLES.get(withoutYear) || STANDARD_TITLES.get(withYear) || "";
}

/** 既有檔名裡如果已經有中文標題，沿用它（使用者手打的名稱比對照表更貼近實際用途） */
export function existingChineseTitle(att) {
  const stem = cleanPart(att.filename || "");
  const parts = stem.split("_");
  const index = parts.findIndex((part) => /[㐀-鿿]/.test(part));
  return index >= 0 ? cleanPart(parts.slice(index).join("_"), 150) : "";
}

/**
 * 單檔改名用：以檔名為主來源判斷標準編號。
 * 檔名裡沒有年份時，才去 OCR 內文找「緊跟在這個編號後面」的年份（避免抓到文件裡
 * 隨便一個四位數年份），最後才退到保守預設值。
 */
export function parseStandard(att) {
  const filenameSource = `${att.original_filename || ""}\n${att.filename || ""}`;
  const fullSource = `${filenameSource}\n${att.ocr_text || ""}`;
  const match = filenameSource.match(STANDARD_PATTERN) || fullSource.match(STANDARD_PATTERN);
  if (!match) return null;
  const org = normalizeOrg(match[1]);
  const number = match[2].toUpperCase();
  let year = match[3] || "";
  if (!year && att.ocr_text) {
    const escapedOrg = org.replace(/_/g, "[\\s_-]+");
    const escapedNumber = number.replace(/-/g, "[\\s_-]*-[\\s_-]*");
    const exact = String(att.ocr_text).match(
      new RegExp(escapedOrg + "[\\s_:\\-]*" + escapedNumber + "[\\s_:\\-]*((?:19|20)\\d{2})", "i")
    );
    if (exact) year = exact[1];
  }
  if (!year) year = DEFAULT_YEARS.get(`${org}_${number}`) || "";
  return { org, number, year, key: `${org}_${number}` };
}

/**
 * 批次整理用：以 OCR 內文為主來源（內文通常有完整年份，檔名常常只有編號）。
 * 除了 ISO 系列，另外認 FDA 指引與歐盟 MDR 這兩種沒有標準編號格式的文件。
 */
export function standardIdentity(att) {
  const source = `${att.ocr_text || ""}\n${att.original_filename || ""}\n${att.filename || ""}`;
  const match = source.match(STANDARD_PATTERN);
  if (match) {
    const org = normalizeOrg(match[1]);
    const number = match[2].toUpperCase();
    const year = match[3] || DEFAULT_YEARS.get(`${org}_${number}`) || "";
    return { org, number, year };
  }
  const fda = source.match(/\bFDA\b[\s_-]*((?:19|20)\d{2})/i);
  if (fda) return { org: "FDA", number: "", year: fda[1] };
  const mdr = source.match(/\bMDR\b[\s_-]*(2017[-_/]745)/i);
  if (mdr) return { org: "MDR", number: "2017-745", year: "" };
  return null;
}

/** 「組織_編號_年份」——批次整理用它當「同一份標準」的分組鍵 */
export function canonicalBase(att) {
  const id = standardIdentity(att);
  return id ? [id.org, id.number, id.year].filter(Boolean).join("_") : "";
}

/** 批次整理的目標檔名：組織_編號_年份_中文標題.pdf */
export function canonicalFilename(att) {
  const id = standardIdentity(att);
  if (!id) return att.filename;
  const base = [id.org, id.number, id.year].filter(Boolean).join("_");
  if (!base) return att.filename;
  const title = standardTitle(id.org, id.number, id.year) || existingChineseTitle(att) || "標準文件";
  return `${base}_${cleanPart(title, 120)}.pdf`;
}
