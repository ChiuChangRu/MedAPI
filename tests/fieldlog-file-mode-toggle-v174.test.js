import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("點 PDF、圖片或其他檔案整列時，桌機右欄預設開啟預覽", async () => {
  const app = await read("../fieldlog/public/app.js");
  const rows = app.match(/function bindFileRows\(\)[\s\S]*?\n}\n\nfunction filePreviewArgsFromRow/)?.[0] || "";
  const rowClick = rows.match(/row\.onclick = \(event\) => \{[\s\S]*?\n    };/)?.[0] || "";
  const images = app.match(/function bindImageLinks\(root = document\)[\s\S]*?\n}/)?.[0] || "";

  assert.ok(rows, "應能定位檔案列點擊流程");
  assert.match(rowClick, /showFilePreview\(filePreviewArgsFromRow\(row\)\)/);
  assert.doesNotMatch(rowClick, /showFileEditor/,
    "點整列不可再跳過預覽直接進管理表單");
  assert.match(images, /showFilePreview\(filePreviewArgsFromRow\(row\)\)/,
    "圖片檔名也要走同一個右欄預覽入口");
});

test("右欄有預覽／文字內容／檔案資訊三個頁籤", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
    read("../fieldlog/public/style.css"),
  ]);

  assert.match(html, /id="file-preview-mode-preview"[^>]*>預覽<\/button>/);
  assert.match(html, /id="file-preview-mode-content"[^>]*>文字內容<\/button>/);
  assert.match(html, /id="file-preview-mode-info"[^>]*>檔案資訊<\/button>/);
  assert.match(app, /function setFilePreviewMode\(active, \{ onPreview, onContent \}\)/);
  assert.match(app, /setFilePreviewMode\("preview"/);
  assert.match(app, /setFilePreviewMode\("content"/);
  assert.match(css, /\.file-preview-mode-toggle/);
  assert.match(css, /\.file-preview-mode-toggle \.btn\[aria-pressed="true"\]/);
});
