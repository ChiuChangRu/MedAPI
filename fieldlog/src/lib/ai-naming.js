/**
 * v233 AI 命名：讀檔案內容（＋下載來源網址、所在資料夾），請 AI 判斷公司、產品、文件類型，
 * 組成「公司_產品_文件類型.副檔名」。只產生建議，使用者確認後才走一般改名 API 套用。
 */
export const NAMING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const DOC_TYPES = ["型錄", "使用說明書", "規格書", "技術資料", "臨床文獻", "專利", "簡報", "報價單", "證書", "其他"];

const SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    product: { type: "string" },
    doc_type: { type: "string", enum: DOC_TYPES },
  },
  required: ["company", "product", "doc_type"],
};

export function namingMessages({ filename, sourceUrl, folderPath, text }) {
  const excerpt = String(text || "").replace(/\s+/g, " ").trim().slice(0, 6000);
  return [
    {
      role: "system",
      content: [
        "你替醫療器材研發人員的檔案取名。根據檔案內容判斷：",
        "company：製造商或品牌（例如 BD、Merit Medical、Argon Medical）。用原文的公司名，不要翻譯；判斷不出來就填空字串。",
        "product：產品名稱或產品線（例如 Mission Core Biopsy Instrument），用原文，越精確越好，不超過 40 字；判斷不出來就填空字串。",
        `doc_type：從 ${DOC_TYPES.join("、")} 擇一。IFU／Instructions for Use 屬於「使用說明書」，Catalog／Brochure 屬於「型錄」。`,
        "只根據提供的內容判斷，不要猜測或編造內容裡沒有的資訊。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `目前檔名：${filename || "（無）"}`,
        `下載來源網址：${sourceUrl || "（無）"}`,
        `所在資料夾：${folderPath || "（無）"}`,
        `內容節錄：${excerpt || "（沒有擷取到文字）"}`,
      ].join("\n"),
    },
  ];
}

function cleanPart(value, max) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "")
    .slice(0, max);
}

/** AI 回傳（字串或物件）→ { company, product, doc_type }；格式不對回 null */
export function parseNamingResult(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { data = JSON.parse(match[0]); } catch { return null; }
  }
  if (!data || typeof data !== "object") return null;
  const docType = DOC_TYPES.includes(data.doc_type) ? data.doc_type : "其他";
  return { company: cleanPart(data.company, 40), product: cleanPart(data.product, 60), doc_type: docType };
}

/** 組檔名：公司_產品_文件類型；公司與產品都判斷不出來時回空字串（不給建議） */
export function composeFilename({ company, product, doc_type: docType }, originalFilename) {
  if (!company && !product) return "";
  const ext = String(originalFilename || "").match(/(\.[a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() || "";
  const parts = [company, product, docType].filter(Boolean);
  // 產品名稱已經含公司名時不重複
  if (company && product && product.toLowerCase().startsWith(company.toLowerCase())) parts.shift();
  return `${parts.join("_")}${ext}`;
}

export async function suggestFilename(ai, context) {
  const result = await ai.run(NAMING_MODEL, {
    messages: namingMessages(context),
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 200,
    temperature: 0.1,
  });
  const parsed = parseNamingResult(result?.response ?? result);
  if (!parsed) throw new Error("AI 沒有回傳可用的命名結果");
  return { ...parsed, filename: composeFilename(parsed, context.filename) };
}
