/**
 * 搜尋比對層——所有 search_* 工具共用的查詢計畫與比對邏輯。
 *
 * 修的兩個問題（2026-07 實測發現）：
 *
 * 1. 多詞查詢完全失效（純 bug）。舊做法是把整個查詢字當「一整串」去 includes()，
 *    所以「7886 注射器」會去找帶空格的連續子字串 "7886 注射器"。檔名實際長相是
 *    ISO_7886-1_2017_無菌皮下注射器…，兩個詞都在裡面，卻永遠比不到。
 *    改法：以空白斷詞，每個詞元各自比對，預設全詞都要命中（AND）；
 *    AND 掛零時自動降級成 OR 並在回應裡標示，不會讓使用者以為真的沒資料。
 *
 * 2. 字面不重疊造成的偽陰性。文件寫正式標準名（體外血液處理用導管），
 *    人查的時候用慣用語（HD管、洗腎管），字面零重疊 → 靜默漏掉。
 *    改法：比對前先過一層 synonyms.json 展開，同一組講法互通。
 *
 * 三個不能破壞的前提：
 *   - 中文不含空白時維持整串比對（「無菌皮下注射器」原本就對，不能變）
 *   - 單詞查詢只會「多找到」不會「少找到」——原詞命中一律排在展開命中前面
 *   - 查無結果時要說出「試過哪些詞」，不能只回一句查無（靜默失敗最危險）
 */

import SYNONYMS from "./synonyms.json" with { type: "json" };
import { foldText, foldSnippetAny } from "./textFold.js";

// 部分比對的最短長度。單字詞（「針」「管」）只做完全相同比對——
// 否則一個字會把所有含這個字的同義詞組全部拉進來，展開到失去意義。
const MIN_PARTIAL_LEN = 2;

// 把同義詞組攤平成比對用索引：每組成員都預先算好摺疊形（省得每次查詢重算），
// 同時留著原始寫法，查無結果時要用原始寫法告訴使用者「我試過這些詞」。
function buildGroups(rawGroups) {
  return (rawGroups || []).map((group) => ({
    canonical: group.canonical,
    words: [group.canonical, ...(group.aliases || [])]
      .filter(Boolean)
      .map((raw) => ({ raw: String(raw), folded: foldText(raw) })),
    codes: (group.codes || [])
      .filter(Boolean)
      .map((raw) => ({ raw: String(raw), folded: foldText(raw) })),
  }));
}

// synonyms.json 是「出廠預設值」——正式環境的同義詞表在 fieldlog D1 的 synonyms
// 表裡（用 add_synonym 工具在對話中就能補，不用改程式碼重新部署），worker 啟動後
// 由 setSynonymGroups() 換上資料庫的版本；D1 讀不到時退回這份預設值，搜尋不會壞。
export const SYNONYM_SEED = SYNONYMS.synonyms || [];

let GROUPS = buildGroups(SYNONYM_SEED);

/**
 * 換上新的同義詞組（來自 D1）。rawGroups 格式與 synonyms.json 相同：
 * [{ canonical, aliases: [], codes: [] }, ...]。同一個 canonical 出現多列時
 * 由呼叫端先合併好再傳進來。傳 null＝退回出廠預設值。
 */
export function setSynonymGroups(rawGroups) {
  GROUPS = buildGroups(rawGroups || SYNONYM_SEED);
}

/** 以空白斷詞（半形空白、tab、換行、全形空白 U+3000，連續多個算一個） */
export function tokenizeQuery(raw) {
  return String(raw ?? "")
    .split(/[\s　]+/)
    .filter(Boolean);
}

// 這個詞元屬於這一組同義詞嗎？
function groupMatchesToken(group, folded) {
  // 標準編號一律要完全相同：「594」這種短數字做部分比對會誤命中「1594」
  if (group.codes.some((code) => code.folded === folded)) return true;
  return group.words.some((word) => {
    if (word.folded === folded) return true;
    if (folded.length < MIN_PARTIAL_LEN || word.folded.length < MIN_PARTIAL_LEN) return false;
    // 雙向部分比對：「體外血液處理」查得到「體外血液處理用導管」，
    // 「親水塗層技術」也查得到「親水塗層」
    return word.folded.includes(folded) || folded.includes(word.folded);
  });
}

// 一個詞元 → 它自己 ＋ 同義詞組裡的其他講法（去重，原詞永遠排第一）
function expandToken(rawToken) {
  const folded = foldText(rawToken);
  const terms = [{ raw: String(rawToken), folded, original: true }];
  const seen = new Set([folded]);
  const groups = [];
  for (const group of GROUPS) {
    if (!groupMatchesToken(group, folded)) continue;
    groups.push(group);
    for (const member of [...group.words, ...group.codes]) {
      if (seen.has(member.folded)) continue;
      seen.add(member.folded);
      terms.push({ raw: member.raw, folded: member.folded, original: false });
    }
  }
  return { raw: String(rawToken), folded, terms, groups };
}

/**
 * 把使用者輸入的查詢字轉成查詢計畫：斷詞 → 每個詞元展開同義詞。
 * 之後的比對、排序、查無回報全部只看這個計畫，五個搜尋工具共用同一份。
 */
export function buildPlan(rawQuery) {
  const raw = String(rawQuery ?? "").trim();
  const tokens = tokenizeQuery(raw).map(expandToken);
  return {
    raw,
    tokens,
    multiWord: tokens.length > 1,
    hasExpansion: tokens.some((token) => token.terms.length > 1),
  };
}

/** 計畫裡所有詞的摺疊形，原詞排前面——snippet 定位時優先切在原詞上 */
export function planTerms(plan) {
  const originals = [];
  const expanded = [];
  for (const token of plan.tokens) {
    for (const term of token.terms) (term.original ? originals : expanded).push(term.folded);
  }
  return [...originals, ...expanded];
}

/**
 * 這段文字命中了計畫裡的幾個詞元。
 * origHits 只算「原詞」命中，anyHits 含同義詞展開命中——排序時原詞優先靠這兩個數字。
 */
export function scoreText(text, plan) {
  const folded = foldText(text);
  let origHits = 0;
  let anyHits = 0;
  for (const token of plan.tokens) {
    let original = false;
    let any = false;
    for (const term of token.terms) {
      if (!folded.includes(term.folded)) continue;
      any = true;
      if (term.original) {
        original = true;
        break;
      }
    }
    if (original) origHits++;
    if (any) anyHits++;
  }
  return { origHits, anyHits };
}

/**
 * 跑一次搜尋：全詞命中（AND）優先，掛零才降級成任一詞命中（OR）。
 * 排序：原詞命中數多者優先 → 總命中詞數多者優先；同分維持傳入順序（各工具都是 id DESC）。
 *
 * rows   — 候選資料列
 * textOf — 從資料列取出「要被搜尋的整段文字」
 * limit  — 回傳上限（total 仍為符合的總筆數）
 */
export function runSearch(rows, plan, textOf, limit) {
  if (!plan.tokens.length) return { hits: [], total: 0, degraded: false };
  const scored = [];
  for (const row of rows) {
    const score = scoreText(textOf(row), plan);
    if (score.anyHits > 0) scored.push({ row, ...score });
  }
  const need = plan.tokens.length;
  const full = scored.filter((item) => item.anyHits === need);
  // AND 有結果就只回 AND；掛零才把「部分符合」全部放出來（並讓呼叫端標示降級）
  const kept = full.length ? full : scored;
  kept.sort((a, b) => b.origHits - a.origHits || b.anyHits - a.anyHits);
  return {
    hits: limit ? kept.slice(0, limit) : kept,
    total: kept.length,
    fullMatches: full.length,
  };
}

/**
 * 這批結果是不是「AND 掛零、只能給部分符合」——有結果、但沒有任何一筆命中全部詞元。
 * 傳入一到多組 runSearch 的結果（例如紀錄與附件分開查），只要有一組是全詞命中就不算降級。
 */
export function isDegraded(...results) {
  const total = results.reduce((sum, r) => sum + (r?.total || 0), 0);
  const full = results.reduce((sum, r) => sum + (r?.fullMatches || 0), 0);
  return total > 0 && full === 0;
}

/** 這段文字有命中計畫裡任何一個詞嗎（不需要分數時用） */
export function matchesPlan(text, plan) {
  return scoreText(text, plan).anyHits > 0;
}

/** 從多個欄位裡挑出「真的有命中」的那一個來做 snippet；都沒命中就回退第一個非空欄位 */
export function pickHitField(candidates, plan) {
  const list = candidates.filter((value) => value !== null && value !== undefined && value !== "");
  for (const value of list) {
    if (matchesPlan(String(value), plan)) return String(value);
  }
  return String(list[0] ?? "");
}

/** 依計畫切出前後文片段（定位優先切在原詞上，其次才是展開詞） */
export function planSnippet(rawText, plan, ctx = 80) {
  return foldSnippetAny(rawText, planTerms(plan), ctx);
}

/** AND 掛零、降級成 OR 時掛在結果最前面的提醒——不讓使用者誤讀成精確命中 */
export function degradedNote(plan) {
  return `⚠️ 沒有同時包含全部 ${plan.tokens.length} 個詞（${plan.tokens
    .map((token) => token.raw)
    .join("、")}）的結果，以下為「部分符合」——命中較多詞的排在前面。`;
}

/**
 * 有展開同義詞時，在結果末尾說明實際展開了哪些詞（展開透明化）。
 * 多個詞元落在同一組同義詞時只講一次——「7886 注射器」兩個詞都屬於同一組，
 * 逐詞列會把同一串詞印兩遍。
 */
export function expansionNote(plan) {
  const parts = [];
  const announced = new Set();
  for (const token of plan.tokens) {
    const extra = token.terms
      .filter((term) => !term.original && !announced.has(term.folded))
      .map((term) => {
        announced.add(term.folded);
        return term.raw;
      });
    if (extra.length) parts.push(`${token.raw} → ${extra.join("、")}`);
  }
  return parts.length ? `（同義詞已自動展開：${parts.join("；")}）` : "";
}

/**
 * 查無結果時的誠實回報——本案最危險的失效模式是「靜默失敗」：
 * 使用者分不出「資料庫真的沒有」還是「有、但用詞沒對上」。
 * 這裡把系統實際做過的事攤開講：斷了哪些詞、展開查了哪些詞、哪些詞查不到對照。
 */
export function noHitMessage(subject, plan, extraNote = "") {
  const lines = [`${subject}裡沒有「${plan.raw}」的相關內容（簡繁已互通）。`];

  if (plan.multiWord) {
    lines.push(`· 已斷詞為 ${plan.tokens.length} 個詞：${plan.tokens.map((token) => token.raw).join("、")}`);
  }

  const attempted = [];
  for (const token of plan.tokens) {
    for (const term of token.terms) if (!attempted.includes(term.raw)) attempted.push(term.raw);
  }
  if (plan.hasExpansion) {
    lines.push(`· 同義詞展開後實際查了 ${attempted.length} 個詞：${attempted.join("、")}`);
    lines.push("· 以上詞彙全部落空——資料庫中可能確實沒有這個主題的內容。");
  } else {
    lines.push("· 這些詞在同義詞表裡沒有對照組，只用原詞查過。");
  }

  const unmapped = plan.tokens.filter((token) => !token.groups.length).map((token) => token.raw);
  if (unmapped.length) {
    lines.push(
      `· 「${unmapped.join("、")}」不在同義詞表中。若這是慣用語或公司內部代號，` +
        "直接用 add_synonym 工具補一組對照（canonical＋aliases／codes），補完立刻生效，不用改程式碼。"
    );
  }

  if (extraNote) lines.push(`· ${extraNote}`);
  return lines.join("\n");
}
