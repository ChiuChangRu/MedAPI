/**
 * v248 關聯圖：以一筆記事為中心，找出跟它有關的記事，以及關聯的「原因」。
 * 三種線：
 *   relation   — 人或 AI 建立的正式關聯（relations 表），最可信
 *   similar    — 語意向量相似（bge-m3／Vectorize），意思相近但不一定真的有關
 *   identifier — 共同出現同一個專利號、標準號（例如 US10463350、ISO 11135）
 * 這支只放純函式（抽編號、合併邊），資料庫與向量查詢在 worker.js。
 */

const PATTERNS = [
  // 專利號：US10463350B2、CN107666864B、EP 1234567 A1、WO2019/123456
  { kind: "patent", re: /\b(US|CN|EP|WO|JP|KR|TW|DE)\s?(\d{4}\/?\d{3,8})\s?([A-Z]\d?)?\b/g },
  // 標準號：ISO 11135、ISO 10993-5、IEC 60601-1、ASTM F1980、YY/T 0316、GB/T 16886.1、AAMI TIR28
  { kind: "standard", re: /\b(ISO|IEC|ASTM|AAMI|ANSI|USP|EN|BS|JIS|GB\/T|GB|YY\/T|YY)\s?(TIR|TS|TR)?\s?([A-Z]?\d{2,5})(?:([-.])(\d{1,3}))?\b/g },
];

/** 從文字抽出編號，回傳正規化後的字串（去空白、大寫），依出現次數排序 */
export function extractIdentifiers(text, limit = 8) {
  const counts = new Map();
  const source = String(text || "");
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      let id;
      if (kind === "patent") {
        const number = m[2].replace("/", "");
        if (number.length < 6) continue;
        id = `${m[1]}${number}`;              // 不含 A1／B2 版本碼：同一案不同公告版本要能連起來
      } else {
        const prefix = m[1].toUpperCase();
        const loose = ["EN", "BS", "USP", "GB", "YY", "JIS"].includes(prefix);
        if (loose && !/\d{3,}/.test(m[3])) continue;                        // 太短容易誤判
        if (loose && /^(19|20)\d{2}$/.test(m[3])) continue;                 // 「EN 2026 年版」這類年份不是標準號
        id = `${prefix}${m[2] ? ` ${m[2]}` : ""} ${m[3]}${m[5] ? `${m[4]}${m[5]}` : ""}`.toUpperCase();
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

/** SQL LIKE 用的寫法：標準號同時找有空白與沒空白的寫法（ISO 11135／ISO11135） */
export function identifierLikeForms(id) {
  const compact = id.replace(/\s+/g, "");
  return [...new Set([id, compact])];
}

/** 同一對節點的多條線合併成一條，保留全部原因 */
export function mergeEdges(edges) {
  const map = new Map();
  for (const e of edges) {
    const [a, b] = Number(e.source) < Number(e.target) ? [e.source, e.target] : [e.target, e.source];
    const key = `${a}-${b}`;
    if (!map.has(key)) map.set(key, { source: Number(e.source), target: Number(e.target), kinds: [], labels: [], reasons: [], score: null, relation_ids: [] });
    const merged = map.get(key);
    if (!merged.kinds.includes(e.kind)) merged.kinds.push(e.kind);
    if (e.label && !merged.labels.includes(e.label)) merged.labels.push(e.label);
    if (e.label && !merged.reasons.some((r) => r.kind === e.kind && r.label === e.label)) merged.reasons.push({ kind: e.kind, label: e.label });
    if (e.score != null) merged.score = Math.max(merged.score ?? 0, e.score);
    if (e.relation_id) merged.relation_ids.push(e.relation_id);
  }
  return [...map.values()];
}
