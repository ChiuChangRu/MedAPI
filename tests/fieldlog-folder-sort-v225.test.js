/**
 * v225 資料夾內容排序：名稱／日期／類型，可反向；詳細模式有排序列；
 * 子資料夾一律在前；名稱排序數字英文在中文前面。直接在 Node 執行排序函式。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function sorter() {
  const app = await read("../fieldlog/public/app.js");
  const pick = (name) => app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0];
  const code = `let FILE_SORT = "new";\n${pick("explorerTypeKey")}\n${pick("sortExplorerItems")}\nreturn (sort, items) => { FILE_SORT = sort; return sortExplorerItems(items).map((i) => i.name); };`;
  return new Function(code)();
}

const items = () => [
  { kind: "file", id: 1, name: "附件一_規格.xlsx", createdAt: "2026-10-03" },
  { kind: "file", id: 2, name: "CP-13.pdf", createdAt: "2026-10-01" },
  { kind: "folder", id: 9, name: "子資料夾", createdAt: "2026-09-01" },
  { kind: "note", id: 3, name: "會議筆記", createdAt: "2026-10-02" },
  { kind: "package", id: 4, name: "錄音一", recording: true, createdAt: "2026-10-04" },
  { kind: "file", id: 5, name: "07_草稿.docx", createdAt: "2026-10-05" },
];

test("六種排序；子資料夾永遠在前", async () => {
  const sort = await sorter();
  assert.deepEqual(sort("new", items()), ["子資料夾", "07_草稿.docx", "錄音一", "附件一_規格.xlsx", "會議筆記", "CP-13.pdf"]);
  assert.deepEqual(sort("old", items()), ["子資料夾", "CP-13.pdf", "會議筆記", "附件一_規格.xlsx", "錄音一", "07_草稿.docx"]);
  const byName = sort("name", items());
  assert.equal(byName[0], "子資料夾");
  assert.deepEqual(byName.slice(1, 3), ["07_草稿.docx", "CP-13.pdf"], "數字、英文開頭在中文前面");
  assert.deepEqual(sort("name-desc", items()).slice(-2), ["CP-13.pdf", "07_草稿.docx"]);
  assert.deepEqual(sort("type", items()), ["子資料夾", "會議筆記", "錄音一", "07_草稿.docx", "CP-13.pdf", "附件一_規格.xlsx"]);
  assert.equal(sort("type-desc", items())[1], "附件一_規格.xlsx");
});

test("詳細模式有名稱／日期／類型排序列，工具列按鈕顯示目前排序", async () => {
  const [html, app] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js")]);
  for (const key of ["name", "date", "type"]) assert.match(html, new RegExp(`data-sort-key="${key}"`));
  assert.match(app, /\$\("folder-sort-bar"\)\.hidden = activeView !== "details"/);
  assert.match(app, /\$\("btn-file-sort"\)\.onclick = cycleFileSort/);
});
