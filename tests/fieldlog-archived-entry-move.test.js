/**
 * v136：資料夾內容只保留「資料夾」與「記事」兩種前台物件。
 * PDF、圖片、錄音及多附件都是記事的附件；搬移時一律搬整筆記事。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("資料夾內容不再分裂成單檔列、資料包卡與一般筆記", async () => {
  const app = await read("../fieldlog/public/app.js");
  const openFolder = app.match(/async function openFolder\(id\)[\s\S]*?\n}\n\n\/\*\*\n \* 既有附件的一次性整理/)[0];
  assert.match(openFolder, /kind: "folder"/);
  assert.match(openFolder, /kind: "entry"/);
  assert.match(openFolder, /entryRowHtml\(e, \{ explorer: true, attachments: atts \}\)/);
  assert.doesNotMatch(app, /function folderFileHtml/);
  assert.doesNotMatch(app, /function recordGroupCardHtml/);
  assert.doesNotMatch(app, /function bindRecordGroupCards/);
});

test("記事圖示依附件摘要顯示，但物件仍是同一種記事", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function entryAttachmentSummary\(attachments = \[\]\)[\s\S]*?\n}/)[0];
  assert.match(fn, /if \(counts\.audio\) \{ icon = "🎙️"; label = "錄音記事"; \}/);
  assert.match(fn, /else if \(visible\.length > 1\) \{ icon = "📝"; label = "多媒體記事"; \}/);
  assert.match(fn, /label = "文件記事"/);
});

test("統一記事有拖曳把手與選單內的移動入口", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function entryRowHtml\(e,[\s\S]*?\n}/)[0];
  assert.match(fn, /class="entry-drag" draggable="true"/);
  assert.match(fn, /class="entry-actions-menu"/);
  assert.match(fn, /class="entry-move"/);
  assert.match(app, /setData\("application\/x-fieldlog-entry", drag\.closest\("\.entry-row"\)\.dataset\.id\)/);
});

test("次要操作集中在更多選單，標題旁不再排列多顆按鈕", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function entryRowHtml\(e,[\s\S]*?\n}/)[0];
  assert.match(fn, /<details class="entry-actions-menu">/);
  assert.match(fn, /編輯記事[\s\S]*重新命名[\s\S]*移動[\s\S]*合併[\s\S]*移到垃圾桶/);
  assert.match(fn, /<span class="entry-main"><span class="entry-title">[\s\S]*?<\/span><\/span>/);
});

test("子資料夾接受整筆記事並呼叫 moveInboxEntry", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function hasEntryDrag\(event\)/);
  const fn = app.match(/function bindFolderDropTargets\(\)[\s\S]*?\n}\n/)[0];
  assert.match(fn, /hasEntryDrag\(event\)/);
  assert.match(fn, /moveInboxEntry\(entryId, targetId, prevFolder/);
});

test("舊資料的內含子記事仍可閱讀，但不再套用資料包卡樣式", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(app, /class="entry-child-card"/);
  assert.doesNotMatch(app, /class="record-group-card entry-child-card"/);
  assert.doesNotMatch(css, /\.record-group-card/);
});
