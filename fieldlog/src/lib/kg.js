/**
 * v254 實體關聯圖（知識圖譜試做）。
 *
 * 使用者要的不是「哪些檔案彼此相似」，而是資料之間因為哪個廠商、材料、設備、人員、技術……而串在一起。
 * 類型不寫死：AI 讀每份資料，自己決定有哪些值得連結的實體、自己取類型名稱；系統再用統計判斷關聯強弱：
 * - 越多份資料都出現的實體（例如「測試」）越不具代表性，權重自動降低（IDF）。
 * - 兩個實體在多份資料反覆一起出現，關聯才變強（共現）；原文明確寫出的關係（供應、用於…）另外加權並標示。
 * - 在資料裡是主角的實體，權重高於順帶一提。
 * 名稱相近的實體只產生「合併建議」，使用者確認後才合併；使用者標為雜訊的名稱會回饋給下一次擷取。
 *
 * 這支只放純函式（組提示、清理 AI 輸出、正規化、合併候選、算分與建圖）。資料庫與 API 在 worker.js。
 */
export const KG_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const KG_TEXT_CHARS = 6000;
export const KG_MAX_ENTITIES = 25;
export const KG_MAX_RELATIONS = 15;

/** 太一般、無法用來串連資料的詞：AI 偶爾還是會抽出來，這裡再擋一次 */
const GENERIC_WORDS = new Set([
  "測試", "試驗", "報告", "公司", "資料", "會議", "問題", "產品", "專案", "計畫", "計劃", "文件", "討論", "結果", "說明",
  "附件", "照片", "錄音", "記事", "內容", "客戶", "廠商", "供應商", "人員", "主管", "同仁", "我們", "今天", "本週", "下週",
  "test", "report", "company", "meeting", "product", "project", "document", "result", "data", "file",
]);

const CORPORATE_SUFFIX = /(股份有限公司|有限公司|公司|corporation|incorporated|company|corp|inc|co|ltd|limited|llc|gmbh|ag|sa|plc|kk)$/i;

/** 實體名稱的比對鍵：全半形統一、小寫、去空白標點、去公司字尾。「NOF Corporation」與「NOF」同鍵。 */
export function normalizeEntityKey(name) {
  let key = String(name || "").normalize("NFKC").toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/[\s\-_.,，、。:：;；'"’“”()（）［］\[\]{}【】《》〈〉/\\|!?！？·・&＋+*#@]+/g, "");
  for (let i = 0; i < 2; i++) {
    const stripped = key.replace(CORPORATE_SUFFIX, "");
    if (stripped.length >= 2) key = stripped;
  }
  return key;
}

export function cleanEntityName(name) {
  return String(name || "").normalize("NFKC").replace(/\s+/g, " ").trim().replace(/^[\-–—•*·:：,，]+|[\-–—•*·:：,，。]+$/g, "").slice(0, 60).trim();
}

export function cleanTypeLabel(label) {
  return String(label || "").normalize("NFKC").replace(/[\s「」『』"']/g, "").slice(0, 12) || "其他";
}

/** 名稱能不能當實體：太短、純數字或日期、一般詞，都不要 */
export function isUsefulEntityName(name) {
  const n = cleanEntityName(name);
  if (n.length < 2) return false;
  if (/^[\d\s.,/:\-年月日號%]+$/.test(n)) return false;
  if (GENERIC_WORDS.has(n.toLowerCase())) return false;
  return normalizeEntityKey(n).length >= 2;
}

/** 擷取提示：不給類型清單，只給「已出現過的類型」當參考，避免同義類型越長越多 */
export function kgMessages({ title = "", text = "", knownTypes = [], hiddenNames = [] }) {
  return [
    {
      role: "system",
      content: [
        "你替醫療器材研發人員建立知識圖譜。讀一份資料，找出「值得用來串連不同資料」的具體實體：",
        "例如特定的廠商／供應商、人員、材料、設備、製程或技術、產品或型號、標準或法規、專利號、測試方法、專案……但不限於這些——由你判斷這份資料裡什麼是重要的具體東西。",
        "規則：",
        "1. 類型（type）由你自己決定，用 2～6 個字的繁體中文名詞；如果下面的「已用過的類型」有意思相同的，就沿用那個寫法。",
        "2. 只要具體、有名字的東西。不要一般詞（測試、報告、公司、會議、問題、產品…）、不要日期、不要純數字。",
        "3. name 用原文寫法（英文名稱、型號、標準號保持原樣），不要翻譯、不要自己補全名。",
        "4. salience：3＝這份資料的主角，2＝重要，1＝只是提到。",
        "5. evidence：從原文逐字摘出提到它的一小段（60 字內），不要改寫。",
        "6. relations：只有原文明確寫出兩個實體之間的關係才列（例如 A 供應 B、C 用於 D、E 符合 F），relation 用 2～4 個字的動詞；沒有就給空陣列，不要推測。",
        `7. 實體最多 ${KG_MAX_ENTITIES} 個，關係最多 ${KG_MAX_RELATIONS} 個。`,
        knownTypes.length ? `已用過的類型：${knownTypes.slice(0, 60).join("、")}` : "",
        hiddenNames.length ? `使用者標為雜訊、不要再抽的名稱：${hiddenNames.slice(0, 40).join("、")}` : "",
        "只回傳 JSON：{\"entities\":[{\"name\":\"\",\"type\":\"\",\"salience\":1,\"evidence\":\"\"}],\"relations\":[{\"subject\":\"\",\"relation\":\"\",\"object\":\"\",\"evidence\":\"\"}]}",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `標題：${title}\n\n${String(text || "").slice(0, KG_TEXT_CHARS)}` },
  ];
}

function parseJsonLoose(raw) {
  if (raw && typeof raw === "object") return raw;
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

const squash = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 清理 AI 輸出：去一般詞、去重（同鍵取較高 salience）、evidence 必須真的在原文裡，否則清空（不留 AI 改寫的句子） */
export function parseKgResult(raw, sourceText = "") {
  const data = parseJsonLoose(raw) || {};
  const source = squash(sourceText);
  const byKey = new Map();
  for (const item of Array.isArray(data.entities) ? data.entities : []) {
    const name = cleanEntityName(item?.name);
    if (!isUsefulEntityName(name)) continue;
    const key = normalizeEntityKey(name);
    const salience = Math.min(3, Math.max(1, Math.round(Number(item?.salience) || 1)));
    let evidence = String(item?.evidence || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (evidence && source && !source.includes(squash(evidence))) evidence = "";
    const prev = byKey.get(key);
    if (!prev || salience > prev.salience) byKey.set(key, { name, key, type: cleanTypeLabel(item?.type), salience, evidence: evidence || prev?.evidence || "" });
    if (byKey.size >= KG_MAX_ENTITIES) break;
  }
  const entities = [...byKey.values()];
  const relations = [];
  const seen = new Set();
  for (const r of Array.isArray(data.relations) ? data.relations : []) {
    const s = normalizeEntityKey(cleanEntityName(r?.subject));
    const o = normalizeEntityKey(cleanEntityName(r?.object));
    const relation = String(r?.relation || "").replace(/\s+/g, "").slice(0, 8);
    if (!byKey.has(s) || !byKey.has(o) || s === o || !relation) continue;
    const id = `${s}|${relation}|${o}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let evidence = String(r?.evidence || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (evidence && source && !source.includes(squash(evidence))) evidence = "";
    relations.push({ subjectKey: s, objectKey: o, relation, evidence });
    if (relations.length >= KG_MAX_RELATIONS) break;
  }
  return { entities, relations };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function acronym(name) {
  const words = String(name || "").normalize("NFKC").split(/[\s\-_/&]+/).filter((w) => /^[A-Za-z]/.test(w));
  return words.length >= 2 ? words.map((w) => w[0]).join("").toLowerCase() : "";
}

/**
 * 名稱相近、可能是同一個東西的候選（只產生建議，使用者確認才合併）。
 * 依據：縮寫對得上（BD ↔ Becton Dickinson）、一方包含另一方（≥3 字）、拼寫極接近。
 */
export function mergeCandidates(entity, others) {
  const out = [];
  const key = entity.norm_key || normalizeEntityKey(entity.name);
  const acr = acronym(entity.name);
  for (const other of others) {
    if (Number(other.id) === Number(entity.id)) continue;
    const okey = other.norm_key || normalizeEntityKey(other.name);
    if (!okey || okey === key) continue;
    const oacr = acronym(other.name);
    let reason = "";
    if ((acr && acr === okey && acr.length >= 2) || (oacr && oacr === key && oacr.length >= 2)) reason = "縮寫對得上";
    else if (Math.min(key.length, okey.length) >= 3 && (key.includes(okey) || okey.includes(key))) reason = "名稱互相包含";
    else if (Math.min(key.length, okey.length) >= 5 && levenshtein(key, okey) / Math.max(key.length, okey.length) <= 0.15) reason = "拼寫極接近";
    if (reason) out.push({ id: Number(other.id), reason });
  }
  return out.slice(0, 5);
}

/** 類型歸群提示：把意思相同的類型名稱歸到同一群（群名沿用最常見的寫法） */
export function typeGroupMessages(labels, existingGroups = []) {
  return [
    {
      role: "system",
      content: [
        "下面是知識圖譜裡由 AI 自動取的實體類型名稱，很多是同義或幾乎同義（例如 廠商／供應商／代工廠）。",
        "請把它們歸成群：每個類型對應到一個群名（2～6 字繁體中文，沿用清單裡最常見、最清楚的寫法）。意思不同的不要硬併。",
        existingGroups.length ? `已有的群名（能沿用就沿用）：${existingGroups.join("、")}` : "",
        "只回傳 JSON：{\"mapping\":{\"類型\":\"群名\"}}",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: labels.join("\n") },
  ];
}

export function parseTypeGroups(raw, labels) {
  const data = parseJsonLoose(raw) || {};
  const mapping = data.mapping && typeof data.mapping === "object" ? data.mapping : {};
  const out = {};
  for (const label of labels) {
    const group = cleanTypeLabel(mapping[label]);
    out[label] = group && group !== "其他" ? group : label;
  }
  return out;
}

/** 實體的代表性：出現在越多份資料越低（平滑 IDF，最小 0.15，避免完全歸零） */
export function specificity(docFreq, totalDocs) {
  const n = Math.max(1, Number(totalDocs) || 1);
  const df = Math.max(1, Number(docFreq) || 1);
  return Math.max(0.15, Math.log((n + 1) / df) / Math.log(n + 1));
}

/**
 * 建圖。mentions：[{entity_id, entry_id, salience, evidence}]（範圍內全部，已排除隱藏與合併掉的實體）；
 * entities：Map(id → {id,name,type_label,type_group,aliases}); entries：Map(id → {id,title,path,kind,created_at});
 * relations：[{subject_id, object_id, relation, entry_id, evidence}]。
 * center：{ type: "entity"|"entry", id }。回傳 { nodes, edges, center }，節點 id 用 "e:12"（實體）／"d:34"（資料）。
 */
export function buildEntityGraph({ center, mentions, entities, entries, relations = [], maxEntities = 18, maxDocs = 24 }) {
  const docsOf = new Map();
  const entsOf = new Map();
  for (const m of mentions) {
    if (!entities.has(Number(m.entity_id)) || !entries.has(Number(m.entry_id))) continue;
    (docsOf.get(Number(m.entity_id)) || docsOf.set(Number(m.entity_id), []).get(Number(m.entity_id))).push(m);
    (entsOf.get(Number(m.entry_id)) || entsOf.set(Number(m.entry_id), []).get(Number(m.entry_id))).push(m);
  }
  const totalDocs = entsOf.size;
  const spec = (entityId) => specificity((docsOf.get(entityId) || []).length, totalDocs);
  const relKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const explicit = new Map();
  for (const r of relations) {
    const k = relKey(Number(r.subject_id), Number(r.object_id));
    const list = explicit.get(k) || [];
    list.push(r);
    explicit.set(k, list);
  }

  const nodes = new Map();
  const edges = [];
  const addEntity = (id, score = 0) => {
    const e = entities.get(id);
    if (!e || nodes.has(`e:${id}`)) return;
    nodes.set(`e:${id}`, { id: `e:${id}`, kind: "entity", entity_id: id, title: e.name, type: e.type_group || e.type_label || "其他", type_label: e.type_label || "", aliases: e.aliases || [], docs: (docsOf.get(id) || []).length, score: Math.round(score * 100) / 100 });
  };
  const addDoc = (id, score = 0) => {
    const d = entries.get(id);
    if (!d || nodes.has(`d:${id}`)) return;
    nodes.set(`d:${id}`, { id: `d:${id}`, kind: "doc", entry_id: id, title: d.title, path: d.path || "", doc_kind: d.kind || "note", created_at: d.created_at || "", score: Math.round(score * 100) / 100 });
  };
  const mentionEdge = (m) => edges.push({ source: `e:${m.entity_id}`, target: `d:${m.entry_id}`, kind: "mention", weight: m.salience, evidence: m.evidence || "" });

  let centerId;
  if (center.type === "entity") {
    const cid = Number(center.id);
    if (!entities.has(cid)) return { nodes: [], edges: [], center: null };
    centerId = `e:${cid}`;
    addEntity(cid, 1);
    const docs = [...(docsOf.get(cid) || [])].sort((a, b) => b.salience - a.salience || String(entries.get(Number(b.entry_id)).created_at).localeCompare(String(entries.get(Number(a.entry_id)).created_at))).slice(0, maxDocs);
    const docSet = new Set(docs.map((m) => Number(m.entry_id)));
    for (const m of docs) { addDoc(Number(m.entry_id), m.salience); mentionEdge(m); }
    // 共現：跟中心出現在同一批資料裡的其他實體，依「共同出現的份數 × 代表性 × 重要度」排序
    const co = new Map();
    for (const docId of docSet) {
      for (const m of entsOf.get(docId) || []) {
        const eid = Number(m.entity_id);
        if (eid === cid) continue;
        const prev = co.get(eid) || { score: 0, docs: [] };
        prev.score += m.salience * spec(eid);
        prev.docs.push(m);
        co.set(eid, prev);
      }
    }
    for (const [eid, info] of co) if (explicit.has(relKey(cid, eid))) info.score += 3;
    // 只在一份資料裡被順帶提到、又很常見的實體不畫（雜訊）；明確寫出關係的一律保留
    const ranked = [...co.entries()]
      .filter(([eid, info]) => info.docs.length >= 2 || info.score >= 1 || explicit.has(relKey(cid, eid)))
      .sort((a, b) => b[1].score - a[1].score).slice(0, maxEntities);
    for (const [eid, info] of ranked) {
      addEntity(eid, info.score);
      for (const m of info.docs) mentionEdge(m);
    }
  } else {
    const did = Number(center.id);
    if (!entries.has(did)) return { nodes: [], edges: [], center: null };
    centerId = `d:${did}`;
    addDoc(did, 1);
    const own = [...(entsOf.get(did) || [])].map((m) => ({ m, score: m.salience * spec(Number(m.entity_id)) })).sort((a, b) => b.score - a.score).slice(0, maxEntities);
    const otherDocs = new Map();
    for (const { m, score } of own) {
      addEntity(Number(m.entity_id), score);
      mentionEdge(m);
      for (const other of docsOf.get(Number(m.entity_id)) || []) {
        if (Number(other.entry_id) === did) continue;
        const prev = otherDocs.get(Number(other.entry_id)) || { score: 0, mentions: [] };
        prev.score += Math.min(m.salience, other.salience) * spec(Number(m.entity_id));
        prev.mentions.push(other);
        otherDocs.set(Number(other.entry_id), prev);
      }
    }
    const rankedDocs = [...otherDocs.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, maxDocs);
    for (const [docId, info] of rankedDocs) {
      addDoc(docId, info.score);
      for (const m of info.mentions) mentionEdge(m);
    }
  }

  // 圖上兩個實體之間若有原文明確寫出的關係，畫成標示關係的線
  const shownEntities = [...nodes.values()].filter((n) => n.kind === "entity").map((n) => n.entity_id);
  for (let i = 0; i < shownEntities.length; i++) {
    for (let j = i + 1; j < shownEntities.length; j++) {
      const list = explicit.get(relKey(shownEntities[i], shownEntities[j]));
      if (!list) continue;
      const first = list[0];
      edges.push({ source: `e:${first.subject_id}`, target: `e:${first.object_id}`, kind: "relation", label: [...new Set(list.map((r) => r.relation))].join("、"), evidence: first.evidence || "", entry_id: Number(first.entry_id), weight: list.length });
    }
  }
  const types = [...new Set([...nodes.values()].filter((n) => n.kind === "entity").map((n) => n.type))];
  return { nodes: [...nodes.values()], edges, center: centerId, types, total_docs: totalDocs };
}
