import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("一般記事不再依資料夾類型產生上海參展式專用欄位", async () => {
  const app = await read("../fieldlog/public/app.js");
  const openEntry = app.match(/async function openEntry\(id\)[\s\S]*?\n}\n\n\/\*\*/)?.[0] || "";
  assert.ok(openEntry, "應能定位 openEntry 編輯流程");
  assert.doesNotMatch(openEntry, /template\.map/);
  assert.match(openEntry, /舊有屬性（保留、不再依資料夾套用專用表單）/);
  assert.match(openEntry, /const patch = \{ title: \$\("e-title"\)\.value\.trim\(\), body: bodyValue \}/);
  assert.match(openEntry, /if \(isWeeklyReport\) \{[\s\S]*?patch\.fields = newFields/);
});
