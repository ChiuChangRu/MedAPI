/**
 * 通用 JSON 樹 → Markdown 渲染器（規格書 I 項目 2 的核心）。
 *
 * 為什麼是黑名單不是白名單：舊的匯入器列舉「要哪幾個欄位」（purpose、
 * abstract_note…），結果 patentResults.full.examples 裡的完整配方
 * （PTGL1000 4.25 wt%、UV 劑量…）、red_flags 的 FTO 風險、next_actions
 * 全部沒進 body——花 Opus 算出來的深度分析九成搜不到，而且每加一種新格式
 * 就要回來補一次列舉。改成「除了明確無檢索價值的鍵，全部展開」之後，
 * 任何新欄位、新格式自動可搜尋，這是「永續」的技術定義。
 *
 * 鍵名本身也進輸出（red_flags、next_actions 這些英文鍵名可以直接當關鍵字搜）。
 *
 * mcp worker 也 import 這支來呈現 analysis_json——渲染規則只有一份，
 * 兩邊顯示與搜尋的行為永遠一致。
 */

// 明確無檢索價值的鍵（識別碼、內部標記、可信度中繼欄位——可信度是「掛在
// 某個結論上的屬性」，單獨渲染出來只會產生一堆無上下文的「高／中／低」雜訊）
export const RENDER_SKIP_KEYS = new Set([
  "id",
  "_collection",
  "_source_key",
  "_sid",
  "_content_hash",
  "_orphaned",
  "evidence_level",
  "source_quality",
  "is_real",
]);

// body 長度上限，與 ocr_text 的實務上限一致；超過就截斷並明講
export const RENDER_MAX_CHARS = 60000;

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function isScalar(value) {
  return value === null || typeof value !== "object";
}

function headingFor(key, depth) {
  // depth 0/1 用標題級距，更深的層級用粗體條列——Markdown 標題最多六級，
  // 而且太深的標題在前台顯示反而難讀
  if (depth <= 0) return `## ${key}`;
  if (depth === 1) return `### ${key}`;
  return `${"  ".repeat(depth - 2)}- **${key}**`;
}

function renderNode(key, value, depth, out, skipKeys) {
  if (skipKeys.has(key) || isEmptyValue(value)) return;
  const pad = "  ".repeat(Math.max(0, depth - 1));

  if (isScalar(value)) {
    out.push(`${pad}- ${key}：${value}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      const items = value.filter((v) => !isEmptyValue(v));
      if (items.length) out.push(`${pad}- ${key}：${items.join("、")}`);
      return;
    }
    out.push(headingFor(key, depth));
    value.forEach((item, index) => {
      if (isEmptyValue(item)) return;
      if (isScalar(item)) {
        out.push(`${pad}${index + 1}. ${item}`);
        return;
      }
      out.push(`${pad}${index + 1}.`);
      for (const [k, v] of Object.entries(item)) renderNode(k, v, depth + 2, out, skipKeys);
    });
    return;
  }
  out.push(headingFor(key, depth));
  for (const [k, v] of Object.entries(value)) renderNode(k, v, depth + 1, out, skipKeys);
}

/**
 * 把任意 JSON 物件渲染成可搜尋的 Markdown。
 * extraSkipKeys — 呼叫端要額外排除的鍵（例：title 已是記事標題、
 * patentResults 另外進 analysis_json，body 裡不重複放）。
 */
export function renderTree(obj, extraSkipKeys = []) {
  if (!obj || typeof obj !== "object") return "";
  const skipKeys = extraSkipKeys.length
    ? new Set([...RENDER_SKIP_KEYS, ...extraSkipKeys])
    : RENDER_SKIP_KEYS;
  const out = [];
  for (const [key, value] of Object.entries(obj)) renderNode(key, value, 0, out, skipKeys);
  const text = out.join("\n");
  if (text.length <= RENDER_MAX_CHARS) return text;
  return text.slice(0, RENDER_MAX_CHARS) + "\n\n（已截斷，完整內容見來源連結）";
}
