import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("v242 資料夾頁 Ctrl+V：圖片直接存進目前資料夾，輸入文字時不攔截", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/function setupFolderPaste\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(fn, /addEventListener\("paste"/);
  assert.match(fn, /if \(!CURRENT_FOLDER/, "沒有開資料夾就不處理");
  assert.match(fn, /input, textarea, select, \[contenteditable=''\], \[contenteditable='true'\], \.ql-editor/, "編輯中不攔截");
  assert.match(fn, /\.overlay\.open/, "對話框開著不攔截");
  assert.match(fn, /貼上圖片-\$\{stamp\}/, "瀏覽器的 image.png 改成有時間的名稱");
  assert.match(fn, /uploadStandaloneFiles\(files, Number\(CURRENT_FOLDER\.id\)/);
  assert.match(app, /setupFolderPaste\(\);/, "啟動時有掛上");
  assert.match(await read("../fieldlog/public/help.html"), /複製圖片.*Ctrl＋V/);
});
