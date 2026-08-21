import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");
const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");

test("清單標題是主要欄，路徑與時間移到第二行", () => {
  assert.match(app, /class="entry-main"/);
  assert.match(app, /class="entry-secondary"/);
  assert.match(css, /grid-template-areas:\s*"drag main move merge del"\s*"drag secondary secondary secondary secondary"/);
  assert.match(css, /grid-template-columns:\s*28px minmax\(220px, 1fr\)/);
});

test("記事、資料包與附件都有重新命名入口", () => {
  assert.match(app, /class="entry-rename"/);
  assert.match(app, /class="record-group-rename"/);
  assert.match(app, /id="file-rename-action"/);
  assert.match(app, /class="att-rename"/);
  assert.match(app, /async function renameEntry/);
  assert.match(app, /async function renameAttachment/);
});

test("附件改名由後端驗證，保留副檔名並拒絕路徑字元", () => {
  assert.match(worker, /if \(body\.filename !== undefined\)/);
  assert.match(worker, /副檔名必須保留為/);
  assert.match(worker, /檔名不可包含路徑符號或控制字元/);
  assert.match(worker, /重新命名附件/);
});
