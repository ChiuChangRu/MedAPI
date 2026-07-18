/**
 * 影像 skill（共用模組）：照片 → 抄出文字（OCR），並可另判斷與對話逐字稿的關聯。
 *
 * 這份是唯一正本。隨身記（fieldlog）接入時由同步腳本複製到 fieldlog/src/，
 * 要修 prompt、換模型、調防護規則一律改這裡，不要在別處另寫一份。
 *
 * 三條經過實測換來的設計原則（2026-07 用真實展商照片驗證）：
 * 1. 抄字時模型「只看圖片」——逐字稿絕不能餵進 vision prompt，
 *    模型會把逐字稿內容當成照片裡的字抄出來（實測踩過）。
 * 2. 關聯判斷交給另一顆純文字模型另跑一步，兩個任務分開、互不污染。
 * 3. 輸出卡進重複迴圈（同一詞狂刷上百行，實測踩過）就判失敗，
 *    爛結果寧可不要，絕不入庫。
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

// 偵測模型輸出是否卡進重複迴圈（同一行反覆出現），這種結果直接判定失敗、不採信
export function detectRepetitionLoop(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 10) return false;
  const counts = {};
  for (const l of lines) counts[l] = (counts[l] || 0) + 1;
  const maxCount = Math.max(...Object.values(counts));
  return maxCount >= 8 && maxCount / lines.length > 0.4;
}

// 抄出照片裡的文字。回傳 { ok:true, text } 或 { ok:false, error, raw? }
export async function extractImageText(ai, bytes) {
  const result = await ai.run(OCR_MODEL, {
    image: Array.from(bytes),
    prompt: OCR_PROMPT,
    max_tokens: 1024,
    temperature: 0,
  });
  const text = (result?.response ?? "").trim();
  if (!text) return { ok: false, error: "模型沒有回傳文字，請再試一次" };
  if (detectRepetitionLoop(text)) {
    return { ok: false, error: "模型輸出卡進重複迴圈，這次結果不採信，請再試一次", raw: text };
  }
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
