/**
 * 巡廠頁面（Jeremy 功能規格書，2026-08-09）：假日巡廠回報截圖 → OCR → LLM
 * 整理成固定格式的巡廠紀錄文字檔。
 *
 * 格式整理這一步刻意不用既有的 Workers AI 小模型（imageSkill.js 的
 * RELATION_MODEL 等級）——規格明講這裡涉及表格數字辨識與邏輯判斷、要
 * Sonnet 等級，Haiku／小模型的逐字照抄與固定格式（縮排、換行數、『』符號
 * 位置）遵循能力不夠穩，跑出來的格式跟範本對不齊的機率高，等於沒省到
 * Jeremy 的謄寫工夫。改直接打 Anthropic Messages API（見 ANTHROPIC_API_KEY），
 * 這是 HANDOVER.md 提過、之前決議暫緩的「深度解析層」用的同一組前提
 * （fieldlog 自持金鑰、一律 Sonnet），這裡是第一個真正用到的地方。
 */

export const PATROL_MODEL = "claude-sonnet-5";

// 2026-08-08 實測範例，規格要求原封不動存成 few-shot——格式本身（標題符號、
// 段落順序、標點、換行、粗體記號、縮排）不可有任何更動，LLM 只能替換內容。
const PATROL_FORMAT_EXAMPLE = `*龍德廠巡廠紀錄2026年08月08日(星期六)*
*巡查人員：陳柏宏

*製A課*
『今日未安排加班』

*製B課*
『今日未安排加班』

*製C課*
技術員3員 / 作業員4員
射出機：22台 (M25停機)
當班人員：鄭燦輝
『今日生產狀況正常』

*製D課*
技術員2員 / 作業員46員
Tipping機：6台
立射機：3台

本月訂單數量：
AC 血攝：6,942 set
DJ 輸尿管：655 set
PD 豬尾巴：31,233 set
BC球囊：100 set
HD血液透析：971 set
SI導引鞘：1,595 set
CVC中央靜脈：1,125 set
數量合計：42,621 set
當班主管：陳帛辰、古滕美花
『今日生產狀況正常』

*製E課*
技術員3員 / 作業員0員
押管：1台
C機生產：6.75*3.9mm
押袋：4台
E機生產：120*0.32mm (南亞)
F機生產：120*0.32mm (南亞)
G機生產：120*0.32mm (南亞)
I機生產：120*0.32mm (SPC)
當班人員：王武雄
『今日生產狀況正常』


*製F課*
技術員6員 / 作業員20員
A機生產：濟生 1000ml (自動組立)
B機生產：FINLAY 100ml
C機生產：SOTHEMA 500ml
D機生產：BIOGALENIC 1,000ml
E機生產：FINLAY 500ml (自動組立)
加藥卯合機4台
加藥目檢機2台
蝶翼封口機2台
藥塞蝶翼組裝機2台
當班人員：林曾國
『今日生產狀況正常』

*製G課*
『今日未安排加班』

*滅菌課*
『今日未安排加班』

*龍德廠其他單位出勤狀況*
    生管課：賴嘉雯、俞美蘭
    倉管課：游蒼梧、林朝陽
    實驗室：鍾金緣
    品保部：吳慧君、陳麗華、陳秀霞
    研發部：游川倍、謝宏昌

*宜科廠巡廠紀錄2026年08月08日(星期六)*
*巡查人員：李少宗

*宜科廠二課B組*
『今日未安排加班』

*宜科廠二課D組*
技術員2員 / 作業員53員
Tipping機：7台
立射機：3台

本月訂單數量：
PD 豬尾巴：27,115 set
PCN 套組：3,471 set
AC 血攝：598 set
DIS膀胱鏡針：28,808 set
CVC中央靜脈：20 set
HD血液透析：1,050 set
DJ 輸尿管：763 set
數量合計：61,825 set

CT 連接管：4,001 set
GW 引導鋼線：1,754 set
DR 擴張管：40 set
當班主管：林昌毅、黃慧娟
『今日生產狀況正常』

*宜科廠滅菌課*
出鍋 & 收BI送實驗室培菌
出勤人員：李謝庭宗

*宜科廠其他單位出勤狀況*
    品保部：曾若雯、方韻婕
    實驗室：張宸瑜
    工程部：李明彥、黃順傳、塗政憲
    研發部：蔡逸誠、林詩庭、陳宥臻`;

export const PATROL_SYSTEM_PROMPT =
  "你是巡廠紀錄整理員。任務：把多張 LINE 群組截圖（訂單累計表格截圖、手寫巡廠紀錄照片、" +
  "文字訊息）依序 OCR 出來的文字，整理成固定格式的巡廠紀錄。\n\n" +
  "資料完整性規則（最重要，優先於其他一切）：\n" +
  "1. 禁止腦補：任何截圖中沒有明確出現、或被系統標示「已收回訊息」而缺漏的內容，" +
  "你不可以自行推測填入。缺漏處以「*」標記並簡短說明原因（例如「*此處訊息已收回，內容缺漏」）。\n" +
  "2. 多廠拆分：同一批截圖可能同時包含「龍德廠」與「宜科廠」兩廠的回報，要依訊息內容" +
  "（部門名稱、人名）正確分類，不可混雜。\n" +
  "3. 表格數字精確度：Excel截圖、手寫表格中的數字（人數、機台數、訂單累計）為關鍵資訊，" +
  "OCR辨識結果如有模糊或無法確定，需標記「*」提醒使用者核對，不可自行猜測數值。\n\n" +
  "輸出格式規則（下面附一份實測範例，格式本身——標題符號、段落順序、標點、換行、" +
  "粗體記號、縮排——不可有任何更動，你只能替換其中的內容：部門、人數、機台數、" +
  "品名數量、人名等）：\n" +
  "- 廠別標題與巡查人員固定用「*」包住（如「*龍德廠巡廠紀錄...*」），巡查人員那行" +
  "只有開頭一個「*」，結尾不加\n" +
  "- 各課別標題固定格式：「*[課別]*」\n" +
  "- 無加班固定文字：『今日未安排加班』，不可改寫成其他措辭\n" +
  "- 有出勤時，狀態結尾固定用：『今日生產狀況正常』，若有異常則替換為實際異常描述，" +
  "但仍維持『』包住\n" +
  "- 「其他單位出勤狀況」區塊，部門與人名前固定縮排4個全形空白\n" +
  "- 課別之間、廠別之間的空行數量需與範例一致\n" +
  "- 若該課別/廠別在截圖中查無資料（例如訊息被收回），該欄位以「*」註記缺漏原因，" +
  "格式仍需維持上述結構，不可整段省略\n\n" +
  "直接輸出整理好的巡廠紀錄文字，不要加任何前言、說明或標題（例如不要寫「以下是整理結果」）。\n\n" +
  "以下是一份格式完全正確的範例（2026-08-08 實測，內容僅供參考格式，這次請依照" +
  "使用者提供的截圖內容填入實際資料）：\n\n" +
  PATROL_FORMAT_EXAMPLE;

/**
 * 呼叫 Claude 把依序排列的 OCR 文字整理成巡廠紀錄。不用 SDK——這個 repo
 * 刻意不掛 npm 依賴（imageSkill.js 開頭有講原因：Cloudflare Git 自動部署
 * 不用煩惱 node_modules 裝得對不對），純 fetch 打 Messages API 就夠。
 *
 * items：[{ index, filename, text }]，依上傳（拖曳排序後的）順序排列——
 * 對話截圖有時間先後順序，順序本身就是 LLM 判斷上下文的依據之一。
 */
export async function formatPatrolReport(env, items) {
  const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("尚未設定 ANTHROPIC_API_KEY：請至 Worker Settings → Variables and Secrets 新增");
  }
  const body = items.map((item, i) =>
    `## 截圖 ${i + 1}（${item.filename || `第 ${i + 1} 張`}）\n${item.text || "（無文字）"}`
  ).join("\n\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: PATROL_MODEL,
      max_tokens: 4096,
      system: PATROL_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `以下是本次 ${items.length} 張截圖依上傳順序 OCR 出的文字，請整理成巡廠紀錄：\n\n${body}`,
      }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Anthropic API 錯誤：HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("模型拒絕處理這個請求，請確認截圖內容");
  }
  const text = (data.content || []).find((b) => b.type === "text")?.text?.trim();
  if (!text) throw new Error("模型沒有回傳文字，請再試一次");
  return text;
}

/**
 * 找到或建立「行政｜巡廠」資料夾（category=admin，type=巡廠）。第一次存檔
 * 時才建立，不是一進頁面就建——訪客只是看看、沒實際存檔的話不該留下空資料夾。
 * 命名跟既有「行政｜一般行政」「行政｜設備」同一套慣例（沒有真的巢狀，是
 * 團隊自己在資料夾名稱上加「行政｜」前綴分組），根層、type=巡廠。
 */
export async function ensurePatrolFolder(db, timestamp) {
  const name = "行政｜巡廠";
  const existing = await db.prepare(
    "SELECT id FROM folders WHERE parent_id IS NULL AND name = ?"
  ).bind(name).first();
  if (existing) return existing.id;
  const r = await db.prepare(
    "INSERT INTO folders (name, type, category, parent_id, created_at) VALUES (?, '巡廠', 'admin', NULL, ?)"
  ).bind(name, timestamp).run();
  return r.meta.last_row_id;
}
