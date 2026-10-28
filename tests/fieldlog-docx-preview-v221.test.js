/**
 * v221 Word（.docx）排版預覽：自架 docx-preview＋JSZip，畫在 shadow root，
 * 不渲染 altChunk（內嵌 HTML），超連結只留安全協定。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("docx 走排版預覽，不再只顯示抽出的純文字", async () => {
  const app = await read("../fieldlog/public/app.js");
  const docxAt = app.indexOf('ext === "docx" || /wordprocessingml');
  assert.ok(docxAt > 0, "app.js 有 docx 預覽分支");
  assert.ok(docxAt < app.indexOf("} else if (modernOffice) {"), "docx 分支在舊的純文字分支之前");
  assert.match(app, /import\("\.\/docx-preview\.js\?v=224"\)/);
});

test("docx 預覽元件：自架函式庫、shadow root、安全選項", async () => {
  const [mod, build, pkg] = await Promise.all([
    read("../fieldlog/public/docx-preview.js"),
    read("../fieldlog/scripts/build-preview-assets.mjs"),
    read("../package.json"),
  ]);
  assert.match(mod, /\.\/vendor\/jszip\.min\.js/);
  assert.match(mod, /\.\/vendor\/docx-preview-0\.4\.1\.min\.js/);
  assert.doesNotMatch(mod, /https?:\/\/(cdn|unpkg|jsdelivr)/i, "不從外部 CDN 載入");
  assert.match(mod, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(mod, /renderAltChunks: false/);
  assert.match(mod, /\["http:", "https:", "mailto:"\]/);
  assert.match(build, /docx-preview-0\.4\.1\.min\.js/);
  assert.equal(JSON.parse(pkg).dependencies["docx-preview"], "0.4.1", "版本鎖定");
});
