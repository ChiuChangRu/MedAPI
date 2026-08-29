/**
 * 後端 now() 存的是 UTC（"YYYY-MM-DD HH:MM:SSZ"），畫面顯示日期／時間前
 * 一定要轉台北時間，不能直接切字串——否則半夜 0~8 點建立的記事會顯示成
 * 前一天。這裡直接測 app.js 匯出的（其實是模組內部函式，用字串比對確認
 * 都改用 helper）加上獨立重新實作一份相同邏輯來驗證日期數學本身正確，
 * 兩邊一起確認：程式碼有接對、換算邏輯也沒錯。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("app.js：定義了 taipeiParts/localDate/localDateTimeShort/localDateTime 這組轉換函式", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function taipeiParts\(iso\)/);
  assert.match(app, /timeZone:\s*"Asia\/Taipei"/);
  assert.match(app, /function localDate\(iso\)/);
  assert.match(app, /function localDateTimeShort\(iso\)/);
  assert.match(app, /function localDateTime\(iso\)/);
});

test("app.js：不再對 created_at/updated_at 直接 slice 或原樣輸出 UTC 字串", async () => {
  const app = await read("../fieldlog/public/app.js");
  // 排序用的字串比較不算「顯示」，允許；真正顯示用的欄位不該再看到 .slice(
  assert.doesNotMatch(app, /esc\(\(f\.created_at \|\| ""\)\.slice/);
  assert.doesNotMatch(app, /esc\(String\(e\.updated_at \|\| e\.created_at \|\| ""\)\.slice/);
  assert.doesNotMatch(app, /esc\(\(a\.created_at \|\| ""\)\.slice/);
  assert.doesNotMatch(app, /esc\(a\.created_at\.slice/);
  assert.doesNotMatch(app, /esc\(e\.created_at\)｜/);
});

test("app.js：所有 9 個原始顯示點都已改呼叫轉換函式", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /esc\(localDate\(f\.created_at\)\)/);
  assert.match(app, /esc\(localDateTimeShort\(e\.updated_at \|\| e\.created_at\)\)/);
  assert.match(app, /esc\(localDateTimeShort\(e\.created_at\)\)/);
  assert.match(app, /esc\(localDateTimeShort\(a\.created_at\)\)/);
  assert.match(app, /esc\(localDateTime\(e\.created_at\)\)/);
  assert.match(app, /esc\(entry\.created_at \? localDateTime\(entry\.created_at\) : "—"\)/);
  assert.match(app, /esc\(entry\.updated_at \? localDateTime\(entry\.updated_at\) : "未曾更新"\)/);
  assert.match(app, /esc\(localDateTime\(h\.created_at\)\)/);
  assert.match(app, /esc\(localDateTime\(attachment\.created_at \|\| entry\.created_at\)\)/);
});

// 獨立重新實作一份同樣的換算邏輯（不 import app.js，因為它是瀏覽器腳本、
// 沒有模組匯出），驗證 UTC→台北轉換數學本身正確，包含跨日邊界。
function taipeiParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}
function localDateTime(iso) {
  const p = taipeiParts(iso);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : "";
}

test("換算數學：一般情況 UTC 轉台北是 +8 小時，同一天", () => {
  assert.equal(localDateTime("2026-08-13 14:19:05Z"), "2026-08-13 22:19:05");
});

test("換算數學：跨日邊界——UTC 晚上會變成台北隔天凌晨", () => {
  // 這正是原本 raw-slice 顯示錯誤日期的案例：UTC 08-13 20:05 是台北 08-14 04:05，
  // 若直接切 UTC 字串會顯示成 08-13，比實際的台北日期少了一天。
  assert.equal(localDateTime("2026-08-13 20:05:00Z"), "2026-08-14 04:05:00");
});

test("換算數學：null/空字串安全回傳空字串，不會被誤判成 1970 epoch", () => {
  assert.equal(localDateTime(null), "");
  assert.equal(localDateTime(""), "");
  assert.equal(localDateTime(undefined), "");
});

test("版本號：worker.js/app.js/index.html/sw.js 的版本字串一致", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const app = await read("../fieldlog/public/app.js");
  const html = await read("../fieldlog/public/index.html");
  const sw = await read("../fieldlog/public/sw.js");
  const uiVersion = worker.match(/const UI_VERSION = "(\d+)";/)?.[1];
  const appVersion = app.match(/const APP_VERSION = "(\d+)";/)?.[1];
  assert.ok(uiVersion, "worker.js 要有 UI_VERSION");
  assert.equal(appVersion, uiVersion);
  assert.ok(html.includes(`app.js?v=${uiVersion}`));
  assert.ok(html.includes(`style.css?v=${uiVersion}`));
  assert.ok(sw.includes(`app.js?v=${uiVersion}`));
  assert.ok(sw.includes(`v${uiVersion}`), "sw.js 的 CACHE 名稱要帶版本號");
});
