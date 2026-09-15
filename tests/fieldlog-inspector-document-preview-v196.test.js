import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inspector = fs.readFileSync("fieldlog/public/inspector.js", "utf8");
const css = fs.readFileSync("fieldlog/public/style.css", "utf8");

test("一般記事預覽把內容與資訊表包進同一個直向容器", () => {
  assert.match(inspector, /class="inspector-document-preview"/);
  assert.match(inspector, /body\.querySelector\("\.inspector-document-preview"\)/);
  assert.match(css, /\.inspector-document-preview\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.inspector-document-preview\s*>\s*\.inspector-metadata/);
});

test("純文字預覽隱藏同步註解並轉成閱讀格式", () => {
  assert.match(inspector, /function entryTextPreviewHtml\(source\)/);
  assert.match(inspector, /replace\(\/<!--\[\\s\\S\]\*\?-->\/g,\s*""\)/);
  assert.match(inspector, /line\.match\(\/\^\(\#\{1,6\}\)/);
  assert.match(inspector, /entryTextPreviewHtml\(entry\.body\)/);
  assert.doesNotMatch(inspector, /entry\.body_format === "html" \? entry\.body : `<pre>\$\{esc\(entry\.body\)\}<\/pre>`/);
});
