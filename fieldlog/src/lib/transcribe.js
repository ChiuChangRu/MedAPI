/**
 * v229 錄音轉文字品質：Whisper 參數、專業詞彙提示、簡轉繁。只影響之後的新轉錄，
 * 既有逐字稿不重轉（使用者 2026-11-03：舊資料不用管）。
 *
 * - initial_prompt：用繁體中文寫一段情境＋專業詞彙。Whisper 會跟著提示的用字與
 *   字形走，專業詞（逆止閥、滅菌確效…）比較不會被聽成同音字，也比較會輸出繁體。
 *   提示太長會被截斷且容易讓模型在靜音處吐出提示內容，所以限制在約 200 字。
 * - 簡轉繁：只換字形（OpenCC cn→tw），不做詞彙替換。詞彙替換模式（twp）會把
 *   「连接管」改成「連線管」、「软件」改成「軟體」，對醫材文件是改錯意思，不能用。
 *   OpenCC 會把「台」寫成「臺」，台灣慣用「台」，所以原文是「台」的位置保留原字。
 */
import * as OpenCC from "opencc-js/cn2t";

export const GLOSSARY_SETTING_KEY = "transcribe.glossary";

// 預設詞彙：使用者還沒自訂時用。取自實際會議逐字稿裡被聽錯或常出現的詞。
export const DEFAULT_GLOSSARY = [
  "逆止閥", "滅菌確效", "滅菌袋", "加速老化", "實時老化", "DEHP", "DEHP-free", "PVC",
  "規格書", "材料表", "零件圖", "高壓注射筒", "連接管", "抽藥管", "檢體針", "親水塗層",
  "抗結痂", "拉拔試驗", "生物相容性", "確效", "品保", "法規", "送件", "ISO 80369",
  "ISO 10993", "510(k)", "MDR", "CAPA", "PLM",
];

const PROMPT_LEAD = "以下是台灣醫療器材研發與品保會議的繁體中文逐字稿，可能提到：";
const PROMPT_MAX = 200;

/** 一行一個或以逗號、頓號分隔；去空白、去重複，每個最多 30 字、最多 80 個 */
export function cleanGlossary(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\n,，、;；]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const term = String(item || "").trim().slice(0, 30);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= 80) break;
  }
  return out;
}

export function buildInitialPrompt(terms) {
  let prompt = PROMPT_LEAD;
  let added = 0;
  for (const term of cleanGlossary(terms)) {
    const next = `${prompt}${added ? "、" : ""}${term}`;
    if (next.length + 1 > PROMPT_MAX) break;
    prompt = next;
    added++;
  }
  return `${prompt}。`;
}

/** 模型在靜音處有時會把提示詞原樣吐回來；整段就是提示（或其開頭）時視為幻覺 */
export function looksLikePromptEcho(text) {
  const t = String(text || "").replace(/\s+/g, "");
  if (!t) return false;
  const lead = PROMPT_LEAD.replace(/\s+/g, "");
  return t.startsWith(lead.slice(0, 12));
}

let converter = null;
export function toTraditional(text) {
  const src = String(text || "");
  if (!src) return src;
  converter ||= OpenCC.Converter({ from: "cn", to: "tw" });
  const out = converter(src);
  // 逐字對應時把原文的「台」放回去（OpenCC 會改成「臺」）
  if (out.length !== src.length || !src.includes("台")) return out;
  let fixed = "";
  for (let i = 0; i < out.length; i++) fixed += src[i] === "台" ? "台" : out[i];
  return fixed;
}

export async function loadGlossary(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(GLOSSARY_SETTING_KEY).first().catch(() => null);
  if (!row) return { terms: DEFAULT_GLOSSARY, custom: false };
  try { return { terms: cleanGlossary(JSON.parse(row.value)), custom: true }; } catch { return { terms: DEFAULT_GLOSSARY, custom: false }; }
}

/** Whisper 呼叫參數（參數名與預設值依 Cloudflare whisper-large-v3-turbo 文件） */
export function whisperInput(audioBase64, terms) {
  return {
    audio: audioBase64,
    task: "transcribe",
    language: "zh",
    vad_filter: true,
    condition_on_previous_text: false,
    initial_prompt: buildInitialPrompt(terms),
  };
}
