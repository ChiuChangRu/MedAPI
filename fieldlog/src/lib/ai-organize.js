/**
 * v247 AI 整理：任何檔案、記事（資料包）、資料夾都能請 AI「建議名稱」與「建議搬到哪裡」。
 * 只產生建議，使用者在對話框確認後才用一般的改名／搬移 API 套用，AI 不會自己改任何東西。
 *
 * 固定命名法則（NAMING_RULES／FOLDER_LEVEL_RULES）同時是給 AI 的指令，也是顯示給使用者看的說明。
 */
import { aiText, NO_THINKING } from "../imageSkill.js";
import { DOC_TYPES, NAMING_MODEL } from "./ai-naming.js";
import { AUTOFILING_DECISION_MODEL, vectorFolderSuggestion } from "./autofile.js";

export const MAX_FOLDER_DEPTH = 4;

export const NAMING_RULES = [
  { key: "doc", label: "文件（PDF、Word、Excel、簡報、專利…）", rule: "公司_產品_文件類型", example: "BD_Mission Core Biopsy Instrument_使用說明書.pdf" },
  { key: "media", label: "照片、影片", rule: "日期_主題", example: "20261107_活檢針斷面觀察.jpg" },
  { key: "audio", label: "錄音", rule: "日期_主題", example: "20261107_廠商拜訪訪談.m4a" },
  { key: "entry", label: "記事／資料包", rule: "簡短主題（30 字內，不含日期）", example: "天虹科技參訪重點" },
  { key: "folder", label: "資料夾", rule: "依層級：①產品或專案 ②文件類型 ③主題／試驗／標準系列 ④年份或版本", example: "專利分析／2026" },
];
export const FOLDER_LEVEL_RULES = {
  1: "第 1 層＝產品或專案名稱（例如「專利分析」「Mission Core Biopsy」）",
  2: `第 2 層＝文件類型，優先用：${DOC_TYPES.join("、")}`,
  3: "第 3 層＝主題、試驗或標準系列（例如「ISO 11135」「滅菌確效」）",
  4: "第 4 層＝年份或版本（例如「2026」「V2」）",
};

const NAME_SCHEMA = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

/** 檔名／資料夾名清理：拿掉路徑與控制字元，保留中文標點（不做 NFKC，以免改掉全形括號）。 */
export function cleanName(value, max = 80) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "")
    .slice(0, max)
    .trim();
}

export function fileExtension(filename) {
  return String(filename || "").match(/(\.[a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || "";
}

/** 附件分成哪一種命名法則：doc／media／audio */
export function attachmentRuleKey(att) {
  const mime = String(att.mime || "").toLowerCase();
  const ext = fileExtension(att.filename).slice(1);
  if (att.kind === "audio" || mime.startsWith("audio/")) return "audio";
  if (att.kind === "photo" || att.kind === "video" || mime.startsWith("image/") || mime.startsWith("video/")
    || ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif", "bmp", "mp4", "mov", "webm", "m4v"].includes(ext)) return "media";
  return "doc";
}

export function dateLabel(isoLike) {
  const m = String(isoLike || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

function parseJsonLoose(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { data = JSON.parse(match[0]); } catch { return null; }
  }
  return data && typeof data === "object" ? data : null;
}

/** 非文件類：請 AI 只回「名稱」，由程式依法則組成最後的檔名／標題。 */
export async function suggestGenericName(ai, { kind, current, text, context, depth, siblings = [] }) {
  const rules = [];
  if (kind === "media") rules.push("這是照片或影片。只回傳「主題」：用 20 字以內描述畫面或事件（例如「活檢針斷面觀察」），不要含日期、副檔名、檔名原樣。依提供的資料判斷；資料不足就回傳空字串。");
  else if (kind === "audio") rules.push("這是錄音。只回傳「主題」：用 20 字以內說明這段錄音在談什麼（例如「廠商拜訪訪談」），不要含日期。資料不足就回傳空字串。");
  else if (kind === "entry") rules.push("這是一筆記事（資料包）。回傳簡短的主題標題：30 字以內、不含日期、不加「AI彙整」之類前綴。若目前標題已經清楚描述內容，就原樣回傳目前標題。");
  else if (kind === "folder") rules.push(
    "這是一個資料夾。依層級法則取名，並參考同層資料夾的命名風格；若目前名稱已經符合就原樣回傳。",
    FOLDER_LEVEL_RULES[depth] || FOLDER_LEVEL_RULES[MAX_FOLDER_DEPTH],
  );
  const result = await ai.run(NAMING_MODEL, {
    messages: [
      { role: "system", content: ["你替醫療器材研發人員整理資料、取名。只根據提供的內容判斷，不要編造內容裡沒有的資訊。用內容原本的語言（中文內容用繁體中文，英文專有名詞保持原文）。", ...rules, "只回傳 JSON：{\"name\":\"...\"}"].join("\n") },
      { role: "user", content: [
        `目前名稱：${current || "（無）"}`,
        context ? `背景：${context}` : "",
        siblings.length ? `同層其他資料夾：${siblings.slice(0, 20).join("、")}` : "",
        `內容節錄：${String(text || "").replace(/\s+/g, " ").trim().slice(0, 4000) || "（沒有可讀的文字）"}`,
      ].filter(Boolean).join("\n") },
    ],
    response_format: { type: "json_schema", json_schema: NAME_SCHEMA },
    max_tokens: 120,
    temperature: 0.1,
  });
  const data = parseJsonLoose(result?.response ?? result) || parseJsonLoose(aiText(result));
  return cleanName(data?.name, kind === "folder" ? 60 : kind === "entry" ? 60 : 40);
}

/** 依法則組出最後名稱。media／audio：日期_主題＋原副檔名；entry／folder：主題原樣。 */
export function composeOrganizedName(kind, subject, { filename = "", createdAt = "" } = {}) {
  const name = cleanName(subject, 60);
  if (!name) return "";
  if (kind === "media" || kind === "audio") {
    const date = dateLabel(createdAt);
    const stem = name.replace(/^\d{8}[_\- ]+/, "");
    return `${[date, stem].filter(Boolean).join("_")}${fileExtension(filename)}`;
  }
  return name;
}

/** 資料夾路徑與深度（根＝第 1 層） */
export function withPaths(folders) {
  const byId = new Map(folders.map((f) => [Number(f.id), f]));
  return folders.map((folder) => {
    const names = []; const seen = new Set(); let current = folder;
    while (current && !seen.has(Number(current.id))) {
      seen.add(Number(current.id)); names.unshift(current.name);
      current = current.parent_id ? byId.get(Number(current.parent_id)) : null;
    }
    return { ...folder, path: names.join(" ／ "), depth: names.length };
  });
}

/** 資料夾子樹（含自己）的 id 與子樹高度（只有自己＝1） */
export function folderSubtree(folders, rootId) {
  const children = new Map();
  for (const f of folders) {
    const key = Number(f.parent_id || 0);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(Number(f.id));
  }
  const ids = new Set(); let height = 0;
  const walk = (id, level) => { ids.add(id); height = Math.max(height, level); for (const c of children.get(id) || []) if (!ids.has(c)) walk(c, level + 1); };
  walk(Number(rootId), 1);
  return { ids, height };
}

/**
 * 建議搬到哪個既有資料夾（找不到合適的才可能提議新資料夾）。
 * candidates：已排除不能去的（自己的子樹、超過四層的、待分類容器）。
 * 回傳 { folder_id, path, reason, confidence } | { new_folder:{name,parent_id,parent_path}, reason } | { stay:true, reason } | null
 */
export async function suggestMove(env, ai, { kind, entryId, text, title, currentFolderId, candidates, level = null }) {
  if (!candidates.length) return null;
  const allowed = new Set(candidates.map((c) => Number(c.id)));
  let vector = null;
  if (entryId && env.VECTOR_INDEX) {
    try { vector = await vectorFolderSuggestion(env, (model, input) => ai.run(model, input), text, entryId, allowed); } catch { vector = null; }
  }
  const lines = [...candidates]
    .sort((a, b) => (Number(b.id) === Number(vector?.folderId)) - (Number(a.id) === Number(vector?.folderId)) || a.path.localeCompare(b.path, "zh-Hant"))
    .map((f) => `${f.id}\t${f.path}\t第${f.depth}層${Number(f.id) === Number(currentFolderId) ? "\t（目前位置）" : ""}`)
    .join("\n").slice(0, 8000);
  const result = await ai.run(AUTOFILING_DECISION_MODEL, {
    messages: [
      { role: "system", content: [
        "你是企業知識庫整理員。判斷這份內容最適合放在哪個既有資料夾。",
        "只能從清單的 ID 選一個；如果目前位置已經合適，回傳目前位置的 ID。",
        "只有清單裡完全沒有合適的資料夾時，才提議新資料夾 new_folder（name 與 parent_id；parent_id 必須是清單中的 ID，資料夾最多四層）。",
        level ? `搬動對象是資料夾，要選的是「新的上層資料夾」。` : "",
        "資訊不足就回傳 folder_id 為 null。不要臆造 ID。",
        "只回傳 JSON：{\"folder_id\":number|null,\"new_folder\":{\"name\":\"...\",\"parent_id\":number}|null,\"reason\":\"繁體中文一句話理由\"}",
      ].filter(Boolean).join("\n") },
      { role: "user", content: `內容（${kind}）：${title || ""}\n${String(text || "").slice(0, 4500)}\n\n可選資料夾（ID、路徑、層級）：\n${lines}` },
    ],
    temperature: 0, max_tokens: 220, ...NO_THINKING,
  });
  const data = parseJsonLoose(aiText(result));
  if (!data) return null;
  const reason = String(data.reason || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const folderId = data.folder_id === null || data.folder_id === undefined ? null : Number(data.folder_id) || null;
  if (folderId && allowed.has(folderId)) {
    if (Number(folderId) === Number(currentFolderId)) return { stay: true, reason: reason || "目前位置已經合適" };
    const target = candidates.find((c) => Number(c.id) === folderId);
    const agree = vector && Number(vector.folderId) === folderId;
    return { folder_id: folderId, path: target.path, reason, confidence: agree ? "高" : "中", vector_score: agree ? Math.round(vector.score * 100) / 100 : null };
  }
  const nf = data.new_folder;
  if (nf && cleanName(nf.name, 60) && allowed.has(Number(nf.parent_id))) {
    const parent = candidates.find((c) => Number(c.id) === Number(nf.parent_id));
    return { new_folder: { name: cleanName(nf.name, 60), parent_id: Number(nf.parent_id), parent_path: parent.path }, reason };
  }
  return null;
}
