import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("桌機點多張照片資料包時，右欄先顯示照片而不是空白 Word 紙張", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  const editor = app.match(/async function renderEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function showRecordingPreview/)?.[0] || "";

  assert.ok(editor, "應能定位桌機右欄記事編輯器");
  assert.match(editor, /const photos = .*isImageAtt\(item\)/,
    "右欄要辨識資料包中的照片附件");
  assert.match(editor, /photos\.length && !hasWrittenContent \? photoGallery/,
    "純照片資料包要把照片放在空白文件前面");
  assert.match(editor, /photos\.length && hasWrittenContent \? photoGallery/,
    "有文字的圖文資料包要在文字後顯示照片");
  assert.match(editor, /bindImageLinks\(body\)/,
    "右欄照片必須能開啟站內放大與旋轉檢視器");
  assert.match(app, /class="entry-editor-photo-grid"/);
  assert.match(css, /\.entry-editor-photo-grid/);
  assert.match(css, /\.entry-editor-photo-link/);
});
