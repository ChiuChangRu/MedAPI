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
const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "em", "u", "s", "b", "i",
  "ul", "ol", "li", "blockquote", "a", "img", "span",
]);
const ALLOWED_ATTRS = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "data-att-id"]),
};

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
  text = text.replace(/<\/(p|div|li|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  // Quill 空白內容常是 "\n"（來自 <p><br></p>），統一收斂多餘空白行
  return text.replace(/\n{3,}/g, "\n\n").trim();
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
      kept.push(`${key}="${value.replace(/"/g, "&quot;")}"`);
    }
    return kept.length ? `<${tag} ${kept.join(" ")}>` : `<${tag}>`;
  });
  return text.trim();
}

/**
 * 「升級為富文字」：把既有純文字 body 轉成安全轉義過的 HTML，換行變段落。
 * 只在使用者主動點按鈕時呼叫一次，不做批次／自動轉換。
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
