import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("一般記事不再依資料夾類型產生上海參展式專用欄位", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function showEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function attachmentWithText/)?.[0] || "";
  assert.ok(editor, "應能定位桌機右欄編輯流程");
  assert.doesNotMatch(editor, /template\.map/);
  assert.match(editor, /const fields = visibleEntryFields\(entry\)/);
  assert.match(editor, /body\.querySelectorAll\("textarea\[data-field\]"\)/);
  assert.match(editor, /await api\(`\/entries\/\$\{entryId\}`/);
});

test("桌機記事與附件只能在右側欄預覽及編輯", async () => {
  const app = await read("../fieldlog/public/app.js");
  const index = await read("../fieldlog/public/index.html");

  assert.match(index, /id="folder-preview"/);
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /async function showEntryEditor\(entryId\)/);
  assert.match(app, /async function showFilePreview\(/);
  assert.match(app, /async function showFileEditor\(entryId, attachmentId\)/);
  assert.match(app, /if \(!PREVIEW_ENABLED \|\| !matchMedia\("\(min-width: 1000px\)"\)\.matches\) return openEntry\(entryId\)/);
  assert.match(app, /if \(usesDesktopRightPane\(\)\) return showEntryEditor\(entryId\)/);
  assert.match(app, /if \(usesDesktopRightPane\(\)\) return showFileEditor\(entryId, attachmentId\)/);
  assert.match(app, /return withViewLoading\("正在載入編輯欄…"/);
  assert.match(app, /return withViewLoading\("正在載入檔案編輯欄…"/);
});
