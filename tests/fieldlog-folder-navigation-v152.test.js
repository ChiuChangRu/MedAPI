import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("目前資料夾可直接重新命名並刷新路徑", () => {
  assert.match(html, /id="btn-rename-current"[^>]*>✏️ 重新命名/);
  assert.match(app, /btn-rename-current[\s\S]*renameFolder\(CURRENT_FOLDER\.id\)/);
  assert.match(app, /async function renameFolder[\s\S]*await loadFolders\(\)[\s\S]*await openFolder\(id\)/);
});

test("麵包屑各層可返回，MyWiki 固定回首頁", () => {
  assert.match(html, /id="desktop-home-link"[^>]*>[^<]*<span[^>]*>🩷<\/span> MyWiki/);
  assert.match(app, /function renderFolderBreadcrumb/);
  assert.match(app, /data-folder-id/);
  assert.match(app, /data-section/);
  assert.match(app, /desktop-home-link[\s\S]*backHome\(true\)/);
});

test("首頁不再顯示隨身記標題，側欄加號縮小", () => {
  assert.doesNotMatch(html, /<header class="home-app-head">\s*<h1>隨身記<\/h1>/);
  assert.match(css, /\.desktop-tree-section-add \{ width: 20px; height: 20px;/);
});
