/**
 * v239 網址完整下載：從網頁 HTML 找出文字、圖片、影片。
 *
 * Workers 沒有 DOM，這裡用正規表示式做「夠用」的解析：<img>（含懶載入屬性與 srcset）、
 * <picture><source>、<video>／<source>、og:image／og:video、指向影片檔的 <a>。
 * 純函式、不連網，網路下載與大小／數量限制在 worker.js。
 *
 * 做不到的（誠實列出，不假裝能下載）：YouTube／Vimeo／Facebook 這類內嵌播放器沒有
 * 公開的檔案網址，只會記成「內嵌影片」連結；需要登入或靠 JavaScript 才出現的內容抓不到。
 */
import { htmlToPlainText } from "./richtext.js";

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#])/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/i;
const SKIP_IMAGE_EXT = /\.(?:svg|ico)(?:$|[?#])/i;
const EMBED_HOSTS = /(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|facebook\.com|fb\.watch|dailymotion\.com|bilibili\.com|twitch\.tv|tiktok\.com|instagram\.com)/i;

function decodeAttr(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/gi, "/").trim();
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function absolute(value, base) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:data|blob|javascript|about|mailto|tel):/i.test(raw) || raw.startsWith("#")) return "";
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    return u.toString();
  } catch { return ""; }
}

/** srcset 取最大的一張：有 w 描述就比寬度，有 x 就比倍率，都沒有就取最後一個。 */
export function bestSrcsetUrl(srcset) {
  const parts = String(srcset || "").split(/,(?=\s*\S+\s+\d|\s*\S+\s*$)/).map((p) => p.trim()).filter(Boolean);
  let best = ""; let bestScore = -1;
  for (const part of parts) {
    const [url, descriptor = ""] = part.split(/\s+/);
    const score = /(\d+(?:\.\d+)?)w/.test(descriptor) ? Number(RegExp.$1)
      : /(\d+(?:\.\d+)?)x/.test(descriptor) ? Number(RegExp.$1) * 1000 : 1;
    if (url && score >= bestScore) { best = url; bestScore = score; }
  }
  return best;
}

function metaContent(html, names) {
  const out = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    const key = (a.property || a.name || "").toLowerCase();
    if (names.includes(key) && a.content) out.push(a.content);
  }
  return out;
}

export function extractPageResources(html, baseUrl, { maxImages = 50, maxVideos = 3 } = {}) {
  const source = String(html || "");
  const images = []; const videos = []; const embeds = []; const pdfs = [];
  const thumbs = new Set();   // 已有高清版的縮圖網址，不再下載
  const seenImages = new Set(); const seenVideos = new Set(); const seenEmbeds = new Set();
  const addImage = (value, hint = {}) => {
    const url = absolute(value, baseUrl);
    if (!url || seenImages.has(url) || SKIP_IMAGE_EXT.test(url)) return;
    // 1x1 追蹤像素與常見 icon／sprite 先不抓；下載後還會再用檔案大小過濾一次
    if ((Number(hint.width) > 0 && Number(hint.width) <= 2) || (Number(hint.height) > 0 && Number(hint.height) <= 2)) return;
    if (/(?:pixel|spacer|blank|tracking|1x1|sprite|favicon|logo-?small)\b/i.test(url)) return;
    seenImages.add(url); images.push({ url, alt: String(hint.alt || "").trim().slice(0, 120) });
  };
  const addVideo = (value, poster = "") => {
    const url = absolute(value, baseUrl);
    if (!url || seenVideos.has(url)) return;
    seenVideos.add(url); videos.push({ url });
    if (poster) addImage(poster);
  };
  const addEmbed = (value) => {
    const url = absolute(value, baseUrl);
    if (!url || seenEmbeds.has(url) || !EMBED_HOSTS.test(url)) return;
    seenEmbeds.add(url); embeds.push({ url });
  };

  // v240 專利／圖庫類網頁：縮圖旁邊通常有高清版。Google Patents 的每張圖是
  //   <li itemprop="images"><img itemprop="thumbnail" src="縮圖"><meta itemprop="full" content="高清圖">
  // 先收高清版（排最前面），並把對應縮圖標記為不下載。（*這段依 Google Patents 的已知結構寫，
  // 其他專利網站若結構不同會落到下面的一般規則。）
  const fullTags = source.match(/<meta\b[^>]*\bitemprop\s*=\s*["']?(?:full|contentUrl)["']?[^>]*>/gi) || [];
  for (const tag of fullTags) {
    const a = parseAttrs(tag);
    if (a.content && !VIDEO_EXT.test(a.content)) addImage(a.content);
  }
  for (const tag of source.match(/<img\b[^>]*\bitemprop\s*=\s*["']?thumbnail["']?[^>]*>/gi) || []) {
    const thumb = absolute(parseAttrs(tag).src, baseUrl);
    if (thumb && fullTags.length) thumbs.add(thumb);
  }
  // 論文／專利常見的 PDF 原檔宣告（Google Scholar、Google Patents、許多期刊網站都有）
  for (const value of metaContent(source, ["citation_pdf_url"])) {
    const url = absolute(value, baseUrl);
    if (url && !pdfs.some((p) => p.url === url)) pdfs.push({ url });
  }
  // og:image 通常是最具代表性的一張，排最前面
  for (const value of metaContent(source, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"])) addImage(value);
  for (const value of metaContent(source, ["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"])) {
    const url = absolute(value, baseUrl);
    if (url && (VIDEO_EXT.test(url))) addVideo(url); else if (url) addEmbed(url);
  }

  const body = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // <a href="大圖"><img src="縮圖"></a>（燈箱／放大鏡）：連結指向的就是高清原圖
  const linkedFull = new Set();
  for (const m of body.matchAll(/<a\b[^>]*>\s*(?:<(?!img\b|\/a\b)[^>]+>\s*)*(<img\b[^>]*>)/gi)) {
    const href = parseAttrs(m[0].match(/^<a\b[^>]*>/i)[0]).href;
    const full = absolute(href, baseUrl);
    if (full && IMAGE_EXT.test(full)) {
      const img = parseAttrs(m[1]);
      linkedFull.add(absolute(img.src || img["data-src"] || "", baseUrl));
      addImage(full, { alt: img.alt });
    }
  }
  // 懶載入常把真正的 <img> 放在 <noscript>，所以不能先把 noscript 整段拿掉
  for (const tag of body.match(/<img\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    // 常見的「高清圖」專用屬性優先於 src／srcset
    const hires = a["data-full"] || a["data-large"] || a["data-zoom-image"] || a["data-zoom"] || a["data-hires"] || a["data-original-src"] || a["data-full-url"] || "";
    const srcset = a.srcset || a["data-srcset"] || "";
    const pick = hires || (srcset && bestSrcsetUrl(srcset)) || a["data-original"] || a["data-lazy-src"] || a["data-src"] || a.src;
    const abs = absolute(pick, baseUrl);
    if (thumbs.has(abs) || linkedFull.has(abs)) continue;
    addImage(pick, { alt: a.alt, width: a.width, height: a.height });
  }
  for (const tag of body.match(/<source\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if (/^video\//i.test(a.type || "") || (a.src && VIDEO_EXT.test(a.src))) addVideo(a.src);
    else if (a.srcset) addImage(bestSrcsetUrl(a.srcset));
  }
  for (const tag of body.match(/<video\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if (a.src) addVideo(a.src, a.poster); else if (a.poster) addImage(a.poster);
  }
  for (const tag of body.match(/<a\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if (a.href && VIDEO_EXT.test(a.href)) addVideo(a.href);
  }
  for (const tag of body.match(/<(?:iframe|embed)\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    addEmbed(a.src || a["data-src"]);
  }

  const title = decodeAttr(metaContent(source, ["og:title"])[0] || "")
    || decodeAttr(htmlToPlainText((source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")).replace(/\s+/g, " ");
  return {
    title: title.trim().slice(0, 160),
    images: images.slice(0, maxImages),
    videos: videos.slice(0, maxVideos),
    embeds: embeds.slice(0, 10),
    pdfs: pdfs.slice(0, 2),
    skipped: {
      images: Math.max(0, images.length - maxImages),
      videos: Math.max(0, videos.length - maxVideos),
    },
  };
}

/** 網頁正文純文字：優先取 <article>／<main>，沒有就取 <body>；導覽列、頁尾、表單拿掉。 */
export function extractPageText(html, maxChars = 300000) {
  let source = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const region = source.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    || source.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    || source.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
    || source;
  const cleaned = region
    .replace(/<(script|style|noscript|nav|footer|form|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, "");
  return htmlToPlainText(cleaned).slice(0, maxChars);
}

const MIME_EXT = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "image/bmp": "bmp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-m4v": "m4v", "video/ogg": "ogv",
};

/** 依實際回傳的 mime（其次網址副檔名）決定副檔名；不是圖片／影片就回 ""。 */
export function mediaExtension(mime, url) {
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  if (MIME_EXT[type]) return MIME_EXT[type];
  if (type && !/^(?:application\/octet-stream|binary\/octet-stream)$/.test(type)) return "";
  const ext = (String(url || "").split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] || "").toLowerCase();
  return ext === "jpeg" ? "jpg" : (IMAGE_EXT.test(`.${ext}`) || VIDEO_EXT.test(`.${ext}`)) ? ext : "";
}

export function mediaKind(ext) {
  return ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext) ? "video" : "photo";
}

/** 檔案名稱：圖片「圖片-001.jpg」、影片「影片-1.mp4」；影片若網址有像樣的檔名就沿用。 */
export function mediaFilename(kind, index, ext, url) {
  if (kind === "video") {
    let last = "";
    try { last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || ""); } catch { last = ""; }
    const base = last.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\w一-鿿\- ]+/g, "_").slice(0, 60);
    return `${base && base.length >= 3 ? base : `影片-${index}`}.${ext}`;
  }
  return `圖片-${String(index).padStart(3, "0")}.${ext}`;
}
