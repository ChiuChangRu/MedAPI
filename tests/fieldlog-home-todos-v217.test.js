/**
 * v217 首頁待辦清單：存在 settings 的 widgets.todos，可勾選、可新增、可清除已完成。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cleanTodos } from "../fieldlog/src/lib/widgets.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("cleanTodos：只留已知欄位、空白丟掉、重複 id 重新編號、未完成不留完成時間", () => {
  const out = cleanTodos([
    { id: "a", text: " 零件圖轉 PDF ", done: true, done_at: "2026-10-27T01:00:00Z", group: "高壓注射筒", entry_id: 634, extra: "x" },
    { id: "a", text: "材料表修正", done: false, done_at: "2026-10-27T01:00:00Z", entry_id: "abc" },
    { id: "b", text: "   " },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(Object.keys(out[0]).sort(), ["created_at", "done", "done_at", "entry_id", "group", "id", "text"]);
  assert.equal(out[0].text, "零件圖轉 PDF");
  assert.equal(out[0].entry_id, 634);
  assert.notEqual(out[1].id, "a");
  assert.equal(out[1].entry_id, null);
  assert.equal(out[1].done_at, "");
});

test("待辦清單在首頁、可參與桌機排版、舊排版補在檢索下面", async () => {
  const [html, app, worker] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js"), read("../fieldlog/src/worker.js")]);
  assert.match(html, /id="todo-panel"/);
  assert.match(app, /"todo-panel"/);
  assert.match(worker, /"todo-panel"/);
  assert.match(worker, /path === "\/widgets\/todos"/);
  assert.match(app, /layout\.left\.splice\(at >= 0 \? at \+ 1 : 0, 0, "todo-panel"\)/);
});
