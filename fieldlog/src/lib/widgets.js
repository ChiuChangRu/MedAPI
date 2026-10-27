/**
 * 首頁小工具（v215）：Google 日曆（iCal 私人網址）、RSS／Atom 訂閱、常用網頁。
 * 外部抓取只在 Worker 端做；這裡放可以單獨測試的驗證與解析函式。
 * Workers 沒有 DOMParser，XML／ICS 都用字串解析，只取首頁需要的欄位。
 */

export const TAIPEI_TZ = "Asia/Taipei";
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

// ---------- 輸入驗證 ----------

/** Google 日曆私人 iCal 網址：只收 https://calendar.google.com/calendar/ical/…/basic.ics */
export function validCalendarUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "calendar.google.com") return null;
  if (!/^\/calendar\/ical\/.+\.ics$/.test(url.pathname)) return null;
  return url.toString();
}

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith(".local") || host.endsWith(".internal");
}

/** 訂閱網址：只收 https、不收內網位址 */
export function validFeedUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) return null;
  return url.toString();
}

/** 常用網頁：名稱 1–60 字、網址 http/https、最多 30 筆，重複網址去掉 */
/**
 * 首頁待辦清單：整份清單一次存讀。只保留已知欄位並限制長度與筆數，
 * 避免任意內容寫進 settings。entry_id 指向來源記事（例如會議錄音的 AI 彙整）。
 */
export function cleanTodos(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item?.text || "").trim().slice(0, 300);
    if (!text) continue;
    let id = String(item?.id || "").trim().slice(0, 40);
    if (!id || seen.has(id)) id = `t${Date.now().toString(36)}${out.length}`;
    seen.add(id);
    const entryId = Number(item?.entry_id);
    out.push({
      id,
      text,
      done: item?.done === true,
      group: String(item?.group || "").trim().slice(0, 60),
      entry_id: Number.isInteger(entryId) && entryId > 0 ? entryId : null,
      created_at: String(item?.created_at || "").slice(0, 30),
      done_at: item?.done === true ? String(item?.done_at || "").slice(0, 30) : "",
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function cleanLinks(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name || "").trim().slice(0, 60);
    let url;
    try { url = new URL(String(item?.url || "").trim()); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || !name) continue;
    const href = url.toString().slice(0, 500);
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ name, url: href });
    if (out.length >= 30) break;
  }
  return out;
}

export function cleanFeedList(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const url = validFeedUrl(raw);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= 12) break;
  }
  return out;
}

// ---------- 抓取 ----------

export async function fetchText(url, fetchImpl = fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { "user-agent": "MyWiki-Fieldlog/1.0 (+widgets)", accept: "*/*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`對方網站回應 HTTP ${res.status}`);
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("對方網站回應太慢（超過 8 秒）");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- RSS／Atom ----------

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

/** 回傳 { title, items: [{ title, link, date }] }，date 為 ISO 字串或空字串 */
export function parseFeed(xml, limit = 5) {
  const text = String(xml || "");
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const channel = isAtom ? text : (tag(text, "channel") || text);
  const feedTitle = decodeEntities(tag(channel.replace(/<(item|entry)[\s\S]*$/i, ""), "title"));
  const blocks = text.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const block of blocks) {
    const title = decodeEntities(tag(block, "title")) || "（無標題）";
    let link = "";
    if (isAtom) {
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        || block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : "";
    } else {
      link = decodeEntities(tag(block, "link")) || decodeEntities(tag(block, "guid"));
    }
    const rawDate = decodeEntities(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date"));
    const d = rawDate ? new Date(rawDate) : null;
    items.push({ title, link: safeHttpUrl(link.replace(/&amp;/g, "&")), date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : "" });
    if (items.length >= limit) break;
  }
  return { title: feedTitle, items };
}

// ---------- iCal（Google 日曆） ----------

function unfold(ics) {
  return String(ics || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function tzOffsetMs(utcMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - utcMs;
  } catch {
    return 8 * 3600 * 1000; // 不認得的時區退回台北時間
  }
}

/** ICS 日期值 → { ms, allDay }。支援 YYYYMMDD、YYYYMMDDTHHMMSS(Z)、TZID */
export function parseIcsDate(value, params = "") {
  const v = String(value || "").trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/.test(params)) {
    // 全天：以台北當天 00:00 表示
    return { ms: Date.UTC(+y, +mo - 1, +d) - 8 * 3600 * 1000, allDay: true };
  }
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return { ms: naive, allDay: false };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1] || TAIPEI_TZ;
  let utc = naive - tzOffsetMs(naive, tz);
  utc = naive - tzOffsetMs(utc, tz);
  return { ms: utc, allDay: false };
}

function parseRrule(raw) {
  const rule = {};
  for (const part of String(raw || "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) rule[k.toUpperCase()] = v;
  }
  return rule;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY = 24 * 3600 * 1000;

function taipeiParts(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
}

/**
 * 展開 VEVENT 成 [fromMs, toMs) 內的發生時間。支援 DAILY／WEEKLY（含 BYDAY）／
 * MONTHLY（同一天）／YEARLY，INTERVAL、COUNT、UNTIL、EXDATE。其他規則只回傳
 * 第一次並標記 complex，讓畫面註明。
 */
function expandEvent(ev, fromMs, toMs) {
  const out = [];
  const duration = Math.max(0, (ev.end?.ms ?? ev.start.ms) - ev.start.ms);
  const push = (startMs) => {
    if (ev.exdates.has(startMs)) return;
    if (startMs + Math.max(duration, 1) <= fromMs || startMs >= toMs) return;
    out.push({ ...ev, startMs, endMs: startMs + duration });
  };
  if (!ev.rrule) { push(ev.start.ms); return { occ: out, complex: false }; }
  const rule = parseRrule(ev.rrule);
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || Infinity;
  const until = rule.UNTIL ? (parseIcsDate(rule.UNTIL)?.ms ?? Infinity) : Infinity;
  const freq = rule.FREQ;
  const supported = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)
    && !rule.BYSETPOS && !rule.BYMONTHDAY && !rule.BYYEARDAY && !rule.BYWEEKNO
    && !(freq !== "WEEKLY" && rule.BYDAY);
  if (!supported) { push(ev.start.ms); return { occ: out, complex: true }; }
  let n = 0;
  const startParts = taipeiParts(ev.start.ms);
  const timeOfDay = ev.start.ms - (Date.UTC(startParts.y, startParts.m, startParts.d) - 8 * 3600 * 1000);
  const byDays = freq === "WEEKLY" && rule.BYDAY
    ? rule.BYDAY.split(",").map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0)
    : null;
  for (let i = 0; i < 3000 && n < count; i++) {
    let candidates = [];
    if (freq === "DAILY") candidates = [ev.start.ms + i * interval * DAY];
    else if (freq === "WEEKLY") {
      const weekStart = Date.UTC(startParts.y, startParts.m, startParts.d - startParts.wd) - 8 * 3600 * 1000 + i * interval * 7 * DAY;
      candidates = (byDays || [startParts.wd]).sort((a, b) => a - b).map((wd) => weekStart + wd * DAY + timeOfDay);
    } else if (freq === "MONTHLY") {
      const t = Date.UTC(startParts.y, startParts.m + i * interval, startParts.d) - 8 * 3600 * 1000 + timeOfDay;
      if (taipeiParts(t).d === startParts.d) candidates = [t];
    } else if (freq === "YEARLY") {
      const t = Date.UTC(startParts.y + i * interval, startParts.m, startParts.d) - 8 * 3600 * 1000 + timeOfDay;
      if (taipeiParts(t).d === startParts.d) candidates = [t];
    }
    let done = false;
    for (const t of candidates) {
      if (t < ev.start.ms) continue;
      if (t > until || n >= count || t >= toMs) { done = true; break; }
      n++;
      push(t);
    }
    if (done) break;
  }
  return { occ: out, complex: false };
}

/** 解析整份 ICS，回傳 [fromMs, toMs) 內依時間排序的行程與是否有略過的複雜規則 */
export function eventsInRange(ics, fromMs, toMs) {
  const lines = unfold(ics);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set() }; continue; }
    if (line === "END:VEVENT") { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params = paramParts.join(";");
    switch (name.toUpperCase()) {
      case "SUMMARY": cur.title = value.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim(); break;
      case "LOCATION": cur.location = value.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim(); break;
      case "DTSTART": cur.start = parseIcsDate(value, params); break;
      case "DTEND": cur.end = parseIcsDate(value, params); break;
      case "RRULE": cur.rrule = value; break;
      case "EXDATE": for (const v of value.split(",")) { const d = parseIcsDate(v, params); if (d) cur.exdates.add(d.ms); } break;
      case "STATUS": cur.cancelled = value.trim().toUpperCase() === "CANCELLED"; break;
      case "UID": cur.uid = value.trim(); break;
      case "RECURRENCE-ID": cur.recurrenceId = parseIcsDate(value, params)?.ms ?? null; break;
      default: break;
    }
  }
  // 單次修改過的重複行程（RECURRENCE-ID）：原本那一次從主規則排除
  for (const ev of events) {
    if (ev.recurrenceId == null || !ev.uid) continue;
    const master = events.find((m) => m.uid === ev.uid && m.rrule && m.recurrenceId == null);
    if (master) master.exdates.add(ev.recurrenceId);
  }
  let complex = false;
  const out = [];
  for (const ev of events) {
    if (ev.cancelled) continue;
    const r = expandEvent(ev, fromMs, toMs);
    complex = complex || r.complex;
    for (const o of r.occ) {
      out.push({ title: o.title || "（無標題）", location: o.location || "", allDay: !!o.start.allDay, start: new Date(o.startMs).toISOString(), end: new Date(o.endMs).toISOString() });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return { events: out.slice(0, 200), complex };
}

/** 台北時間今天 00:00 起算 days 天 */
export function taipeiWindow(nowMs, days = 14) {
  const p = taipeiParts(nowMs);
  const from = Date.UTC(p.y, p.m, p.d) - 8 * 3600 * 1000;
  return { from, to: from + days * DAY };
}
