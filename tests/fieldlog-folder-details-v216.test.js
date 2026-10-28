/**
 * v216 資料夾「詳細」模式：檔案列、錄音／資料包卡、筆記列、子資料夾四種結構
 * 共用同一組欄位，預覽欄開著（清單變窄）時改兩行，名稱不再被擠成一個字。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("詳細模式四種列共用同一組欄位", async () => {
  const css = await read("../fieldlog/public/style.css");
  const block = css.slice(css.indexOf("/* v216 資料夾「詳細」模式"));
  assert.ok(block.length > 100, "v216 規則存在");
  assert.match(block, /grid-template-areas: "drag icon name date status a1 a2 a3"/);
  for (const row of ["child-folder-card", "folder-file-row", "record-group-card", "entry-row"]) {
    assert.match(block, new RegExp(`#folder-entries\\.details-view > \\.${row}`), `${row} 納入統一欄位`);
  }
  assert.match(block, /@container folder-details \(max-width: 719px\)/, "清單變窄時改兩行");
  assert.match(block, /"drag icon name name   name name name"/, "窄版名稱獨佔第一行");
});

test("錄音卡日期與附件摘要分開，詳細模式只顯示日期", async () => {
  const [app, css] = await Promise.all([read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css")]);
  assert.match(app, /<span class="record-group-date">/);
  assert.match(app, /<span class="record-group-summary">/);
  assert.match(css, /#folder-entries\.details-view \.record-group-summary \{ display: none; \}/);
});

test("v223 窄版：圖示與拖曳把手只佔第一行，跟檔名對齊", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /"\.    \.    date status a1   a2   a3"/, "第二行左側兩格留空");
});
