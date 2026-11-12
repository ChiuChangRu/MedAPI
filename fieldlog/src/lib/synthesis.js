/**
 * v249 關聯圖 AI 綜整：把關聯圖上的多筆資料一起交給 AI，做「橫向」整理——
 * 共同主題、各筆重點、差異與矛盾、時間脈絡、缺口；也能針對使用者的問題跨筆回答。
 * 每個論點都要標 [#記事編號]，讓人能回原文查證。這支只放純函式（組提示、整理引用、轉 HTML）。
 */
export const SYNTHESIS_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const SYNTHESIS_MAX_DOCS = 20;
export const SYNTHESIS_TOTAL_CHARS = 60000;
export const SYNTHESIS_DOC_CHARS = 6000;

// 用量估算（Cloudflare 公告：Gemma 4 輸入 USD 0.10／百萬 token、輸出 0.30；1,000 Neurons＝USD 0.011）
export const NEURONS_PER_1K_INPUT = 9.1;
export const NEURONS_PER_1K_OUTPUT = 27.3;
export const EXPECTED_OUTPUT_TOKENS = 2200;
/** 中文約 1 字 1.3 token（推估），英文約 4 字元 1 token；取保守值 */
export function estimateUsage(chars) {
  const inputTokens = Math.round(chars * 1.3) + 800;
  const neurons = Math.round((inputTokens / 1000) * NEURONS_PER_1K_INPUT + (EXPECTED_OUTPUT_TOKENS / 1000) * NEURONS_PER_1K_OUTPUT);
  return { input_tokens: inputTokens, neurons, percent_of_daily_free: Math.round((neurons / 10000) * 1000) / 10 };
}

// 強標記（整句）任何位置都算；「請求項」「Claims」這類常見字只在行首（段落標題）才算，避免內文提到就誤判
const CLAIMS_MARKERS = /(權利要求書|权利要求书|What is claimed is|We claim|I claim|^[ \t]*(?:申請專利範圍|請求項|權利要求|权利要求|CLAIMS|Claims)(?=[\s:：]|$))/m;

/**
 * 長文件只能讀一部分：專利的請求項通常在後面，直接截前段會漏掉。
 * 有找到請求項段落時，前段（摘要、背景）佔 40%，請求項佔 60%。
 */
export function excerptForSynthesis(text, cap) {
  const source = String(text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (source.length <= cap) return { text: source, truncated: false, claims: false };
  const m = source.slice(Math.floor(source.length * 0.05)).match(CLAIMS_MARKERS);
  if (m) {
    const at = Math.floor(source.length * 0.05) + m.index;
    const head = source.slice(0, Math.floor(cap * 0.4));
    const claims = source.slice(at, at + Math.ceil(cap * 0.6));
    return { text: `${head}\n…（中略）…\n${claims}`, truncated: true, claims: true };
  }
  return { text: source.slice(0, cap), truncated: true, claims: false };
}

/** 每筆資料的文字依總量平均截斷；回傳 { docs, truncated } */
export function fitDocuments(docs, { total = SYNTHESIS_TOTAL_CHARS, perDoc = SYNTHESIS_DOC_CHARS } = {}) {
  const cap = Math.min(perDoc, Math.floor(total / Math.max(1, docs.length)));
  let truncated = false;
  const fitted = docs.map((d) => {
    const ex = excerptForSynthesis(d.text, cap);
    if (ex.truncated) truncated = true;
    return { ...d, text: ex.text, truncated: ex.truncated, claims: ex.claims };
  });
  return { docs: fitted, truncated, chars: fitted.reduce((n, d) => n + d.text.length + String(d.title || "").length + 40, 0) };
}

export function synthesisMessages({ docs, centerId, question = "" }) {
  const q = String(question || "").trim().slice(0, 300);
  const sections = [
    q ? `## 回答：${q}\n（直接回答問題，跨筆比較，每個論點標 [#編號]；資料不足就明說）` : "",
    "## 一句話總結",
    "## 共同主題與關聯（這些資料為什麼放在一起看）",
    "## 各筆重點（每筆一行：[#編號] 標題：重點）",
    "## 差異、矛盾或要注意的地方",
    "## 時間脈絡（有日期才寫）",
    "## 還缺什麼資料、建議下一步",
  ].filter(Boolean).join("\n");
  const body = docs.map((d) => [
    `=== [#${d.id}]${Number(d.id) === Number(centerId) ? "（中心）" : ""} ${d.title}`,
    `位置：${d.path || "待分類"}｜日期：${String(d.created_at || "").slice(0, 10)}`,
    d.text || "（沒有文字內容）",
  ].join("\n")).join("\n\n");
  return [
    {
      role: "system",
      content: [
        "你是醫療器材研發的資料分析助理。使用者給你一組彼此有關聯的資料，每筆用 [#編號] 標記。",
        "請用繁體中文做「橫向綜整」，依下列段落輸出 Markdown（段落標題照抄）：",
        sections,
        "規則：",
        "1. 只根據提供的資料，不要補充資料以外的知識；資料沒寫的就寫「資料中未提及」。",
        "2. 每個論點或數字後面都要標來源 [#編號]，可同時標多個，例如 [#12][#40]。只能用提供的編號。",
        "3. 數字、型號、專利號、標準號照原文，不要改寫或推算。",
        "4. 專有名詞與公司、產品名保留原文。",
        "5. 精簡，條列為主；全文不超過 1200 字。",
      ].join("\n"),
    },
    { role: "user", content: `中心資料是 [#${centerId}]。共 ${docs.length} 筆：\n\n${body}` },
  ];
}

/** 找出文中引用的編號；不在清單裡的引用改成 [#?]（避免 AI 編造的編號看起來像真的） */
export function normalizeCitations(markdown, allowedIds) {
  const allowed = new Set([...allowedIds].map(Number));
  const cited = new Set();
  let invalid = 0;
  const text = String(markdown || "").replace(/\[#(\d+)\]/g, (_, n) => {
    if (allowed.has(Number(n))) { cited.add(Number(n)); return `[#${n}]`; }
    invalid++;
    return "[#?]";
  });
  return { markdown: text, cited: [...cited], invalid };
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(text, { citeLinks }) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  if (citeLinks) html = html.replace(/\[#(\d+)\]/g, '<span class="graph-cite" data-cite="$1" role="button" tabindex="0">[#$1]</span>');
  return html;
}

/** 最小 Markdown → HTML（標題、條列、粗體、段落）。內容先全部跳脫，所以 AI 輸出的 HTML 不會被執行。 */
export function markdownToHtml(markdown, { citeLinks = false } = {}) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)、]\s+(.*)$/);
    if (heading) { closeList(); const level = Math.min(4, heading[1].length + 1); out.push(`<h${level}>${inline(heading[2], { citeLinks })}</h${level}>`); }
    else if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((bullet || numbered)[1], { citeLinks })}</li>`);
    } else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line, { citeLinks })}</p>`); }
  }
  closeList();
  return out.join("");
}
