/**
 * entry 266（功能需求：已歸檔資料搬運介面，拖拉／選擇）：
 * 資料夾內頁的三種已歸檔內容——單檔、多檔案記事、純文字筆記——原本只有
 * 單檔（folder-file-row）能拖到子資料夾搬移；多檔案記事完全沒有搬移入口
 * （只有刪除鍵），筆記的拖曳／選擇按鈕又被 CSS 刻意藏起來（見 style.css
 * 舊註解「已歸檔的筆記不再提供拖曳／移動」）。子資料夾是後來才在資料夾內頁
 * 建立時（entry 255 卡在 folder 19 就是這樣），使用者完全搬不動已歸檔內容。
 * 檢查原始碼裡的關鍵接線在不在，不用真的跑 DOM（跟其他 fieldlog UI 測試
 * 同一套做法）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("recordGroupCardHtml 補上拖曳把手與「移動」按鈕", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function recordGroupCardHtml\(e, atts\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /class="record-group-drag"[^>]*draggable="true"/);
  assert.match(fn, /class="record-group-move"/);
});

test("資料夾內的錄音不論單段或多段都維持同一筆紀錄，不攤平成單檔", async () => {
  const app = await read("../fieldlog/public/app.js");
  const openFolder = app.match(/async function openFolder\(id\)[\s\S]*?\n}\n\n\/\/ 多檔案記事/)[0];
  assert.match(openFolder, /const isRecordingEntry = \(e\) => visibleAtts\(e\)\.some\(\(a\) => a\.kind === "audio"\)/);
  assert.match(openFolder, /atts\.length === 1 && !isRecordingEntry\(e\)/,
    "只有非錄音的單一附件才能攤成檔案列");
  assert.match(openFolder, /isRecordingEntry\(e\) \|\| atts\.length > 1/,
    "單段錄音與多段錄音都要進紀錄卡");
  assert.match(openFolder, /html: recordGroupCardHtml\(e, atts\)/);
});

test("錄音紀錄卡使用錄音圖示，一般多附件紀錄仍使用資料夾圖示", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function recordGroupCardHtml\(e, atts\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /const icon = counts\.audio \? "🎙️" : "📁"/);
  assert.match(fn, /<span>\$\{icon\}<\/span>/);
});

test("bindRecordGroupCards：📂 按鈕呼叫 openMoveEntryDialog，拖曳把手掛 application/x-fieldlog-entry", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function bindRecordGroupCards\(\)[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /openMoveEntryDialog\(Number\(card\.dataset\.id\)/);
  assert.match(fn, /setData\("application\/x-fieldlog-entry", String\(card\.dataset\.id\)\)/);
});

test("bindFolderDropTargets：子資料夾卡片除了接檔案，也接 application/x-fieldlog-entry 並呼叫 moveInboxEntry", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function hasEntryDrag\(event\)/);
  const fn = app.match(/function bindFolderDropTargets\(\)[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /hasEntryDrag\(event\)/);
  assert.match(fn, /moveInboxEntry\(entryId, targetId, prevFolder/);
});

test("style.css：已歸檔筆記只藏合併／刪除，拖曳與移動按鈕不再被藏起來", async () => {
  const css = await read("../fieldlog/public/style.css");
  const block = css.match(/\.archive-note-list \.entry-merge,\s*\n\.archive-note-list \.entry-del \{ display: none; \}/);
  assert.ok(block, "應該只剩 entry-merge／entry-del 被隱藏");
  assert.doesNotMatch(css, /\.archive-note-list \.entry-drag,/);
  assert.doesNotMatch(css, /\.archive-note-list \.entry-move,/);
});
