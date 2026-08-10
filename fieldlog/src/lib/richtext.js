/**
 * 富文字記事內文（entries.body_format = 'html'）的共用處理。
 *
 * 只有這個模組知道「HTML 格式的 body 長什麼樣子」——搜尋、匯出、MyWiki
 * 顯示這些消費端全部假設 body 是純文字，改用 htmlToPlainText() 剝成
 * 純文字再用，不用各自重新發明一次 HTML 處理邏輯。sync.js（外部文獻/專利
 * 同步引擎）完全不 import 這個模組：同步管理的記事永遠鎖在 body_format
 * = 'text'，不會遇到這裡的任何函式。
 */

// 記事富文字內容允許的標籤／每個標籤允許的屬性。Quill 正常操作不會產生
// 清單外的東西，這裡防的是「使用者貼上外部網頁內容」或「有人繞過前端直接
// 打 API」夾帶進奇怪標籤／行內事件屬性（onclick 之類）。
//
// 標題（h1–h6）、程式碼區塊（pre/code）、分隔線（hr）在 2026-08-07 補進來：
// 少了它們，「貼一份 Markdown 進來 → 存檔 → 標題全部變成普通句子」是必然結果
// ——存檔那一刻標籤就被這支函式吃掉了，畫面上看起來像「排版自己跑掉」。
const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "em", "u", "s", "b", "i",
  "ul", "ol", "li", "blockquote", "a", "img", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "hr",
]);

// Quill 用 class 表達縮排／對齊／蠟筆重點（ql-indent-1、ql-align-center、
// ql-bg-yellow…），用 data-list 區分項目符號與編號清單。這兩個屬性被剝掉的
// 後果不是「少一點樣式」而是內容變形：Quill 2 的項目符號清單也是 <ol>，
// 靠 <li data-list="bullet"> 區分，data-list 一掉，重新開啟就整串變成編號清單。
const ALLOWED_ATTRS = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "data-att-id"]),
  li: new Set(["class", "data-list"]),
  p: new Set(["class"]),
  h1: new Set(["class"]),
  h2: new Set(["class"]),
  h3: new Set(["class"]),
  h4: new Set(["class"]),
  h5: new Set(["class"]),
  h6: new Set(["class"]),
  pre: new Set(["class"]),
  blockquote: new Set(["class"]),
  span: new Set(["class"]),
  ol: new Set(["class"]),
  ul: new Set(["class"]),
};

// class 只收 Quill 自己產生的 ql-* 樣式名，data-list 只收 Quill 定義的四種值。
// 白名單到「值」這一層，是因為單純允許 class 屬性等於允許任何字串進來（雖然
// class 不像 style 那樣能直接畫東西，仍然沒有理由讓外部貼上的樣式名進資料庫）。
const ALLOWED_LIST_VALUES = new Set(["ordered", "bullet", "checked", "unchecked"]);
function sanitizeAttrValue(name, value) {
  if (name === "class") {
    const kept = String(value).split(/\s+/).filter((token) => /^ql-[a-z0-9-]+$/i.test(token));
    return kept.length ? kept.join(" ") : null;
  }
  if (name === "data-list") return ALLOWED_LIST_VALUES.has(value) ? value : null;
  return value;
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 把富文字 HTML 剝成純文字，給搜尋／匯出／MyWiki 這些假設 body 是純文字
 * 的消費端用。<img> 轉成「[圖片：檔名]」（alt 屬性存的是上傳時的檔名），
 * 區塊標籤轉換行，其餘標籤整個拿掉。
 */
export function htmlToPlainText(html) {
  if (!html) return "";
  let text = String(html);
  // <script>/<style> 連內容一起拿掉，不能只拆標籤留下裡面的程式碼字串
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt) => `[圖片：${decodeEntities(alt) || "未命名"}]`);
  text = text.replace(/<img\b[^>]*>/gi, "[圖片]");
  text = text.replace(/<\/(p|div|li|blockquote|h[1-6]|pre)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  // Quill 空白內容常是 "\n"（來自 <p><br></p>），統一收斂多餘空白行
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 2026-08-10 回報：貼上一份含 Word/Excel 表格的會議紀錄，畫面上表格好好的，
 * 存檔重開後整個表格擠成一行看不出欄位分界。原因是 ALLOWED_TAGS 沒有
 * table/tr/td 這些標籤——Quill 沒有表格編輯格式（見 richtext-editor.js 的
 * mdToHtml 說明），使用者貼上真正的 <table> HTML 時前端沒攔，直接讓它進了
 * 編輯框；存檔這一步下面的標籤白名單迴圈會把 table/tr/td 整個拿掉，儲存格
 * 文字沒有任何分隔就黏在一起。這裡在標籤白名單生效之前，先把每個 <table>
 * 轉成 <pre>（列用換行、儲存格用 " | " 分隔）：跟 mdToHtml 對貼上的 Markdown
 * 表格做的事一樣，維持「至少讀得出原始資料」而不是整段吃掉。
 */
function convertTablesToPre(html) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(inner))) {
      const cells = [];
      const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[1]))) {
        cells.push(decodeEntities(cellMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells.join(" | "));
    }
    return rows.length ? `<pre>${escapeHtml(rows.join("\n"))}</pre>` : "";
  });
}

/**
 * 白名單式清理：只留 ALLOWED_TAGS 裡的標籤，每個標籤只留 ALLOWED_ATTRS
 * 允許的屬性，其餘標籤與屬性整個拿掉（不是跳過，是連同標籤語法一起移除，
 * 內容文字保留）。存進資料庫前一定要跑這支，不能只靠前端 Quill 自我節制——
 * 前端可以被繞過，資料庫裡不能留危險標記。
 */
export function sanitizeEntryHtml(html) {
  if (!html) return "";
  let text = String(html);
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, ""); // body_format='html' 不承載同步標記，註解一律清掉
  text = convertTablesToPre(text);
  text = text.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (full, closing, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (closing) return `</${tag}>`;
    const allowed = ALLOWED_ATTRS[tag];
    if (!allowed) return `<${tag}>`;
    const kept = [];
    const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(rawAttrs))) {
      const [, name, value] = m;
      const key = name.toLowerCase();
      if (!allowed.has(key)) continue;
      if (/^\s*javascript:/i.test(value)) continue; // href="javascript:..." 擋掉
      const safeValue = sanitizeAttrValue(key, value);
      if (safeValue === null) continue;
      kept.push(`${key}="${safeValue.replace(/"/g, "&quot;")}"`);
    }
    return kept.length ? `<${tag} ${kept.join(" ")}>` : `<${tag}>`;
  });
  return text.trim();
}

/**
 * 純文字轉成安全轉義過的 HTML，換行變段落。用在兩種情境：POST /entries
 * 新記事預設直接建成 body_format='html'，呼叫端送來的純文字先經過這裡；
 * 以及既有純文字記事被打開、以富文字編輯器編輯並存檔時，把舊內容轉一次
 * 再繼續編輯——不是使用者按按鈕觸發的一次性「升級」動作，是格式轉換
 * 本身固定會做的事。
 */
export function textToHtml(text) {
  const escaped = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  return paragraphs.map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
}
