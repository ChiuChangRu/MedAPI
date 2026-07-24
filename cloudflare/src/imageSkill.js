/**
 * 文件擷取 skill（共用模組）：把各種附件變成可搜尋的文字。
 * 照片 → AI 抄字（OCR），可另判斷與對話逐字稿的關聯；docx/xlsx/pptx/純文字 →
 * 直接從檔案結構解出文字，不經過 AI（免費、瞬間、100% 準確，沒有 OCR 辨識誤差）。
 *
 * 這份是唯一正本。隨身記（fieldlog）接入時複製到 fieldlog/src/（逐位元一致，
 * 由 tests/core.test.js 檢查），要修 prompt、換模型、調防護規則、加格式支援
 * 一律改這裡，不要在別處另寫一份。
 *
 * 三條經過實測換來的 OCR 設計原則（2026-07 用真實展商照片驗證）：
 * 1. 抄字時模型「只看圖片」——逐字稿絕不能餵進 vision prompt，
 *    模型會把逐字稿內容當成照片裡的字抄出來（實測踩過）。
 * 2. 關聯判斷交給另一顆純文字模型另跑一步，兩個任務分開、互不污染。
 * 3. 輸出卡進重複迴圈（同一詞狂刷上百行，實測踩過）的處理：先換參數
 *    重試一次；仍鬼打牆就截掉重複段、保留有用前段入庫（標註已截斷）。
 *    ——原本是整筆拒收，實測發現 temperature 0 下同一張圖每次都掉進
 *    同一個迴圈，等於永遠卡在待整理清單，重跑幾次都白燒額度。
 *
 * docx/xlsx/pptx 都是 zip 包裡塞 XML——不加 npm 套件解壓縮，直接用 Workers
 * 原生的 DecompressionStream("deflate-raw") 解壓內容，自己讀 zip 的 Central
 * Directory 找檔案位置。少一個第三方依賴，Cloudflare Git 自動部署不用煩惱
 * node_modules 有沒有正確安裝進去。
 */

export const OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const RELATION_MODEL = "@cf/meta/llama-3.2-3b-instruct";

export const OCR_PROMPT =
  "你是機械式的文字抄錄員，不是圖片說明員。任務只有一件事：把這張圖片裡「所有看得到的文字」逐字抄出來，依照原本的排版順序（由上到下、由左到右）條列輸出。\n\n" +
  "嚴格規則：\n" +
  "- 絕對不要用「圖片顯示了」「這是一張...的照片」「書名為」這類描述句，禁止描述畫面內容\n" +
  "- 絕對不要摘要、不要翻譯、不要加你自己的分析或總結\n" +
  "- 不要加「文字抄錄結果」之類的標題或前言，直接輸出抄到的文字本身\n" +
  "- 如果畫面裡有表格，把每一列的每一欄數值都完整列出來（例如型號、數字、單位），不要用「每欄都有數個項目」這種話帶過，要照抄實際數字\n" +
  "- 繁體、簡體、英文、數字都原樣照抄\n" +
  "- 如果看不清楚、不確定的文字，不要用猜的內容代替，用「[看不清]」標示，絕對不可以編造沒看到的內容\n" +
  "- 如果同一個詞已經抄過，不要無限重複抄同一個詞，抄到重複出現就停下來換下一個內容\n" +
  "- 如果圖片裡完全沒有任何文字，只回答「（無文字）」，不要多做任何說明\n\n" +
  "現在開始抄錄：";

// 把「同一小段文字連續重複」壓縮掉——鬼打牆有兩種型態都要對付：
// A. 跨行型（同一行反覆出現幾十行）  B. 單行型（「加入X管柱中，」在同一行連刷幾十次）
// 另外「[看不清]」連刷幾十個沒有任何資訊量，一律壓成一個
export function collapseRepeats(text) {
  let t = String(text || "");
  t = t.replace(/(\[看不清\][\s，,、;；.。]*){2,}/g, "[看不清] ");
  // 一般性重複：4–60 字為一個單位、緊接著自己重複 2 次以上 → 壓成 2 次。
  // 跑兩輪處理巢狀重複（壓完一層又露出下一層的情況）
  for (let i = 0; i < 2; i++) {
    const before = t;
    t = t.replace(/(.{4,60}?)\1{2,}/gs, "$1$1");
    if (t === before) break;
  }
  return t;
}

// Cloudflare AI 的 toMarkdown 轉 PDF 時，開頭一定塞一段檔案 metadata
// （# 檔名 → ## Metadata → 一堆 "- Key=Value"：PDFFormatVersion、Creator、
// Producer、UUID、日期…）。這些對搜尋是雜訊，還會讓「檔名裡的關鍵字」永遠
// 命中在最上面、snippet 永遠回傳 metadata。存進庫前剝掉，只留真正的文件本文。
// 只剝「- key=value」型的 metadata 條列與檔名 H1，不會誤傷本文的項目符號
// （例：「- 产品介绍」沒有 = 號，保留）。找不到 metadata 區塊就原樣回傳。
export function stripPdfMetadata(md) {
  const lines = String(md || "").split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("# "))) i++;
  if (i < lines.length && /^##\s*Metadata/i.test(lines[i].trim())) {
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === "" || /^-\s+[\w.:@-]+=/.test(t)) { i++; continue; }
      break;
    }
  }
  const body = lines.slice(i).join("\n").trim();
  // 圖形型 PDF（無文字層，例：Affinity Designer 做的宣傳冊）：toMarkdown 只吐得出
  // 頁面骨架（## Contents / ### Page N），每頁底下沒有真正的文字段落。這種「只有
  // 標題、沒有內文」的結果對搜尋無意義（還會被「Page 3」誤命中），視為無內容回傳
  // 空字串——前台會誠實顯示「已整理（沒有文字內容）」，使用者就知道要靠照片或重拍。
  const hasProse = body.split("\n").some((l) => l.trim() && !l.trimStart().startsWith("#"));
  return hasProse ? body : "";
}

// 偵測模型輸出是否卡進重複迴圈：行級（同一行反覆出現）＋
// 片段級（壓縮重複後文字長度掉一半以上，代表大半內容都是同一段在刷）
export function detectRepetitionLoop(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 10) {
    const counts = {};
    for (const l of lines) counts[l] = (counts[l] || 0) + 1;
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount >= 8 && maxCount / lines.length > 0.4) return true;
  }
  const t = String(text || "");
  return t.length > 200 && collapseRepeats(t).length < t.length * 0.5;
}

// 鬼打牆輸出的搶救：先壓掉片段級重複（單行型），再做行級去重（跨行型），
// 結尾標註已截斷。實測鬼打牆的輸出前段通常是正常有用的，整筆丟掉太浪費
export function dedupeRepetition(text) {
  const seen = {};
  const kept = [];
  for (const line of collapseRepeats(text).split("\n")) {
    const key = line.trim();
    if (!key) continue;
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] <= 2) kept.push(line);
  }
  return kept.join("\n") + "\n（模型輸出陷入重複，已自動截斷）";
}

// 抄出照片裡的文字。回傳 { ok:true, text } 或 { ok:false, error }
export async function extractImageText(ai, bytes) {
  const run = (temperature) => ai.run(OCR_MODEL, {
    image: Array.from(bytes),
    prompt: OCR_PROMPT,
    max_tokens: 1024,
    temperature,
  });
  let text = ((await run(0))?.response ?? "").trim();
  if (text && detectRepetitionLoop(text)) {
    // temperature 0 是確定性輸出：同一張圖重跑必掉同一個迴圈，
    // 重試要拉高隨機性才有機會走出來
    const retry = ((await run(0.5))?.response ?? "").trim();
    if (retry && !detectRepetitionLoop(retry)) text = retry;
    else text = dedupeRepetition(retry || text);
  }
  if (!text) return { ok: false, error: "模型沒有回傳文字，請再試一次" };
  // 正常輸出也做輕量清理：連續的 [看不清] 壓成一個（幾十個 [看不清] 沒有資訊量）
  text = text.replace(/(\[看不清\][\s，,、;；.。]*){2,}/g, "[看不清] ").trim();
  return { ok: true, text };
}

// 判斷「照片抄出的文字」跟「同時段對話逐字稿」的關聯（純文字比對，不看圖）。
// 回傳一句話；判斷失敗回傳空字串（關聯是加分項，失敗不該擋住 OCR 主流程）。
export async function judgeRelation(ai, transcript, ocrText) {
  if (!transcript || !ocrText) return "";
  try {
    const result = await ai.run(RELATION_MODEL, {
      messages: [{
        role: "user",
        content:
          `以下是現場一段對話的逐字稿，以及同一時間拍的照片經過文字辨識後抄出來的內容。` +
          `請用一句話判斷這張照片可能跟對話中提到的什麼東西有關；` +
          `如果看不出關聯，就直接回答「看不出明顯關聯」，不要編造或過度推測。\n\n` +
          `【對話逐字稿】\n${transcript.slice(0, 1200)}\n\n` +
          `【照片辨識出的文字】\n${ocrText.slice(0, 800)}\n\n` +
          `請只回答那一句判斷，不要加其他說明：`,
      }],
      max_tokens: 200,
      temperature: 0,
    });
    return (result?.response || "").trim();
  } catch {
    return "";
  }
}

// ---------- 原生文件文字擷取（docx／xlsx／pptx／純文字）：不經過 AI ----------

// 依副檔名／mime 判斷這個檔案能不能直接解出文字（不用 AI 讀）。
// 回傳 null 代表交給既有的照片 OCR／PDF toMarkdown 邏輯判斷。
export function detectNativeTextKind(filename, mime) {
  const ext = (String(filename || "").match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (ext === "docx" || m.includes("wordprocessingml.document")) return "docx";
  if (ext === "xlsx" || m.includes("spreadsheetml.sheet")) return "xlsx";
  if (ext === "pptx" || m.includes("presentationml.presentation")) return "pptx";
  if (["txt", "md", "csv", "json", "log"].includes(ext) || m.startsWith("text/") || m === "application/json") return "text";
  // 舊版二進位格式（OLE Compound File），解析成本高、報酬低，明確不支援、給清楚指引
  if (["doc", "xls", "ppt"].includes(ext)) return "legacy-office";
  return null;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

// 從檔尾往前找 End Of Central Directory（EOCD 之後可能還有一段 zip comment，
// 最長 65535 bytes，所以不能假設它一定在最後 22 bytes）
function findEocd(view) {
  const searchStart = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= searchStart; i--) {
    if (i >= 0 && view.getUint32(i, true) === ZIP_EOCD_SIG) return i;
  }
  throw new Error("不是有效的 zip 檔（找不到 End of Central Directory）");
}

// 讀出 zip 裡每個檔案的位置索引（走 Central Directory，不掃 Local Header，
// 避免資料流式壓縮時 Local Header 大小欄位為 0 的邊界情況）
function indexZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const totalEntries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIG) break;
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { bytes, view, entries };
}

async function readZipEntry(zip, name) {
  const meta = zip.entries.get(name);
  if (!meta) return null;
  const lh = meta.localHeaderOffset;
  if (zip.view.getUint32(lh, true) !== ZIP_LOCAL_SIG) throw new Error("zip 本機檔頭損毀");
  const nameLen = zip.view.getUint16(lh + 26, true);
  const extraLen = zip.view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compressed = zip.bytes.subarray(dataStart, dataStart + meta.compressedSize);
  if (meta.compressionMethod === 0) return compressed; // stored（未壓縮）
  if (meta.compressionMethod !== 8) throw new Error(`不支援的 zip 壓縮方式（method ${meta.compressionMethod}）`);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntryText(zip, name) {
  const raw = await readZipEntry(zip, name);
  return raw ? new TextDecoder("utf-8").decode(raw) : "";
}

// word/document.xml：文字都在 <w:t> 裡，段落用 </w:p> 分行
function extractDocxText(xml) {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = paragraphs
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1])).join(""))
    .filter((l) => l.trim());
  return lines.join("\n");
}

// ppt/slides/slideN.xml：文字在 <a:t> 裡，段落用 </a:p> 分行
function extractPptxSlideText(xml) {
  const paragraphs = xml.split(/<\/a:p>/);
  const lines = paragraphs
    .map((p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1])).join(""))
    .filter((l) => l.trim());
  return lines.join("\n");
}

// xl/sharedStrings.xml：每個 <si> 是一個共用字串（可能有多個 <t> rich text run 要串起來）
function extractSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEntities(t[1])).join("")
  );
}

// xl/worksheets/sheetN.xml：逐列逐格取值，共用字串型別（t="s"）查表、其餘直接讀 <v>。
// 用 tab 分隔還原成表格文字，方便搜尋比對數字／型號。不處理合併儲存格、數字格式化
// （日期會是序號原樣），目標是「搜得到」不是「render 出漂亮表格」。
function extractSheetText(xml, sharedStrings) {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  const lines = [];
  for (const rowMatch of rows) {
    const cellChunks = rowMatch[1].split(/<c\b/).slice(1);
    const values = cellChunks.map((chunk) => {
      const closeIdx = chunk.indexOf(">");
      const attrs = chunk.slice(0, closeIdx);
      const inner = chunk.slice(closeIdx + 1);
      const type = attrs.match(/\bt="([^"]*)"/)?.[1] || "";
      if (type === "s") {
        const idx = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        return idx !== undefined ? (sharedStrings[Number(idx)] || "") : "";
      }
      if (type === "inlineStr") {
        return decodeXmlEntities(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "");
      }
      return decodeXmlEntities(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
    });
    if (values.some((v) => v !== "")) lines.push(values.join("\t"));
  }
  return lines.join("\n");
}

function sortByTrailingNumber(names) {
  return names.sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

// 統一入口：kind 由 detectNativeTextKind 判斷，回傳擷取出的純文字。
// 讀不到內容時丟錯（呼叫端跟既有 OCR 錯誤處理走同一套：不寫入、維持「尚未處理」）。
export async function extractNativeText(kind, bytes) {
  if (kind === "text") return new TextDecoder("utf-8").decode(bytes).trim();
  if (kind === "legacy-office") {
    throw new Error("不支援舊版 .doc/.xls/.ppt（二進位格式），請用 Word/Excel/PowerPoint 另存成新格式（.docx/.xlsx/.pptx）再上傳");
  }
  const zip = indexZip(bytes);
  if (kind === "docx") {
    const xml = await readZipEntryText(zip, "word/document.xml");
    if (!xml) throw new Error("讀不到 word/document.xml，檔案可能已損毀或不是 .docx");
    return extractDocxText(xml).trim();
  }
  if (kind === "pptx") {
    const slideNames = sortByTrailingNumber([...zip.entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)));
    if (!slideNames.length) throw new Error("讀不到投影片內容，檔案可能已損毀或不是 .pptx");
    const parts = [];
    for (const name of slideNames) {
      const text = extractPptxSlideText(await readZipEntryText(zip, name));
      if (text) parts.push(`== 投影片 ${name.match(/(\d+)/)[1]} ==\n${text}`);
    }
    return parts.join("\n\n").trim();
  }
  if (kind === "xlsx") {
    const sharedStrings = extractSharedStrings(await readZipEntryText(zip, "xl/sharedStrings.xml"));
    const sheetNames = sortByTrailingNumber([...zip.entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)));
    if (!sheetNames.length) throw new Error("讀不到工作表內容，檔案可能已損毀或不是 .xlsx");
    const parts = [];
    for (const name of sheetNames) {
      const text = extractSheetText(await readZipEntryText(zip, name), sharedStrings);
      if (text) parts.push(`== 工作表 ${name.match(/(\d+)/)[1]} ==\n${text}`);
    }
    return parts.join("\n\n").trim();
  }
  throw new Error(`未知的文件類型：${kind}`);
}
