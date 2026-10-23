/**
 * v215 首頁小工具：畫板、Google 日曆（iCal 私人網址）、訂閱（RSS／Atom）、常用網頁。
 * 用 node:sqlite 當 D1 實跑 settings 讀寫，外部抓取以假的 fetch 取代。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";
import { eventsInRange, parseFeed, taipeiWindow, validCalendarUrl, validFeedUrl, cleanLinks } from "../fieldlog/src/lib/widgets.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { sqlite, prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
}

async function call(env, path, method = "GET", body) {
  const res = await fieldlogWorker.fetch(new Request(`https://x.test/api${path}`, {
    method, headers: { "x-pin": "1234", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }), { ...env, FIELD_PIN: "1234" });
  return { status: res.status, body: await res.json() };
}

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:w1
DTSTART;TZID=Asia/Taipei:20261020T090000
DTEND;TZID=Asia/Taipei:20261020T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,TH
SUMMARY:週會
EXDATE;TZID=Asia/Taipei:20261026T090000
END:VEVENT
BEGIN:VEVENT
UID:w1
RECURRENCE-ID;TZID=Asia/Taipei:20261029T090000
DTSTART;TZID=Asia/Taipei:20261029T140000
DTEND;TZID=Asia/Taipei:20261029T150000
SUMMARY:週會（改到下午）
END:VEVENT
BEGIN:VEVENT
UID:d1
DTSTART;VALUE=DATE:20261025
DTEND;VALUE=DATE:20261026
SUMMARY:查廠
END:VEVENT
END:VCALENDAR`;

test("iCal 解析：每週重複＋例外日期＋單次改時間＋全天", () => {
  const { from, to } = taipeiWindow(Date.parse("2026-10-23T10:00:00Z"), 14);
  const r = eventsInRange(ICS, from, to);
  const taipei = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16);
  assert.deepEqual(r.events.map((e) => `${taipei(e.start)} ${e.title}`), [
    "2026-10-25T00:00 查廠",
    "2026-10-29T14:00 週會（改到下午）",
    "2026-11-02T09:00 週會",
    "2026-11-05T09:00 週會",
  ]);
  assert.equal(r.events[0].allDay, true);
});

test("RSS／Atom 解析：標題、連結、日期；非 http 連結丟掉", () => {
  const rss = parseFeed(`<rss><channel><title>T &amp; N</title><item><title><![CDATA[A]]></title><link>https://e.com/a?x=1&amp;y=2</link><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate></item><item><title>B</title><link>javascript:alert(1)</link></item></channel></rss>`);
  assert.equal(rss.title, "T & N");
  assert.equal(rss.items[0].link, "https://e.com/a?x=1&y=2");
  assert.equal(rss.items[1].link, "");
  const atom = parseFeed(`<feed><title>A</title><entry><title>E</title><link rel="alternate" href="https://x.org/e"/><updated>2026-10-21T00:00:00Z</updated></entry></feed>`);
  assert.equal(atom.items[0].link, "https://x.org/e");
});

test("輸入驗證：日曆只收 Google iCal、訂閱只收 https 公開網址、書籤只收 http/https", () => {
  assert.ok(validCalendarUrl("https://calendar.google.com/calendar/ical/a%40gmail.com/private-x/basic.ics"));
  assert.equal(validCalendarUrl("https://evil.example/calendar/ical/x/basic.ics"), null);
  assert.equal(validFeedUrl("http://e.com/rss"), null);
  assert.equal(validFeedUrl("https://127.0.0.1/rss"), null);
  assert.deepEqual(cleanLinks([{ name: "A", url: "https://a.com" }, { name: "B", url: "javascript:1" }, { name: "", url: "https://c.com" }]),
    [{ name: "A", url: "https://a.com/" }]);
});

test("Worker：日曆設定不回傳私人網址、抓取失敗給中文訊息；書籤與訂閱存讀", async (t) => {
  resetSchemaCacheForTests();
  const db = d1();
  const env = { DB: db };
  const original = globalThis.fetch;
  globalThis.__widgetCache?.clear?.();
  globalThis.fetch = async (url) => {
    if (String(url).includes("calendar.google.com")) return new Response(ICS);
    if (String(url).includes("feed.example")) return new Response(`<rss><channel><title>範例</title><item><title>新聞</title><link>https://feed.example/n1</link></item></channel></rss>`);
    return new Response("nope", { status: 500 });
  };
  t.after(() => { globalThis.fetch = original; });

  assert.equal((await call(env, "/widgets/calendar")).body.configured, false);
  assert.equal((await call(env, "/widgets/calendar", "PUT", { url: "https://evil.example/x.ics" })).status, 400);
  const saved = await call(env, "/widgets/calendar", "PUT", { url: "https://calendar.google.com/calendar/ical/a%40gmail.com/private-x/basic.ics" });
  assert.equal(saved.body.configured, true);
  const cal = await call(env, "/widgets/calendar");
  assert.equal(cal.body.configured, true);
  assert.ok(Array.isArray(cal.body.events));
  assert.doesNotMatch(JSON.stringify(cal.body), /private-x/, "私人網址不可回傳前端");

  const feeds = await call(env, "/widgets/feeds", "PUT", { feeds: ["https://feed.example/rss", "http://bad.example/rss", "https://down.example/rss"] });
  assert.equal(feeds.body.rejected, 1);
  const got = await call(env, "/widgets/feeds");
  assert.equal(got.body.feeds[0].items[0].title, "新聞");
  assert.match(got.body.feeds[1].error, /讀取失敗/);

  const links = await call(env, "/widgets/links", "PUT", { links: [{ name: "Leapspace", url: "https://www.sciencedirect.com/leapspace" }, { name: "x", url: "javascript:1" }] });
  assert.equal(links.body.links.length, 1);
  assert.equal((await call(env, "/widgets/links")).body.links[0].name, "Leapspace");
});

test("四個小工具在首頁、可參與桌機排版", async () => {
  const [html, app, worker] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js"), read("../fieldlog/src/worker.js")]);
  for (const id of ["sketch-panel", "calendar-panel", "feeds-panel", "links-panel"]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(app, new RegExp(`"${id}"`));
    assert.match(worker, new RegExp(`"${id}"`));
  }
  assert.match(app, /canvas\.setPointerCapture/, "畫板用 pointer events，滑鼠／觸控筆／手指都能寫");
  assert.match(app, /await putFile\(created\.id, blob, filename/, "存成記事＋PNG 附件");
});
