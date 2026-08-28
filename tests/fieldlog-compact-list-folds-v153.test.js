import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("右欄可繼續往左拉，內容區與 CSS 下限一致為 280px", () => {
  assert.match(app, /const PREVIEW_MAIN_MIN = 280/);
  assert.match(css, /grid-template-columns: minmax\(280px, 1fr\) 6px var\(--preview-width\)/);
});

test("清單模式只保留名稱並使用緊湊列，詳細模式維持完整資訊", () => {
  assert.match(css, /\.folder-content-list\.list-view > \.explorer-item \{ min-height: 38px; \}/);
  assert.match(css, /\.folder-content-list\.details-view > \.explorer-item \{ min-height: 62px; \}/);
  assert.match(css, /list-view > \.child-folder-card > small[\s\S]*display: none/);
  assert.match(css, /list-view > \.folder-file-row \.folder-file-meta[\s\S]*display: none/);
  assert.doesNotMatch(css, /\.folder-content-list\.list-view > \.entry-row,\s*\.folder-content-list\.details-view/);
});

test("詳細模式的檔名獨佔第一行，日期與操作移到第二行", () => {
  assert.match(css, /\.folder-content-list\.details-view > \.folder-file-row \{[\s\S]*grid-template-areas:\s*"icon name name name"\s*"icon meta delete manage"/);
  assert.match(css, /details-view > \.folder-file-row \.folder-file-name \{[\s\S]*-webkit-line-clamp: 2/);
  assert.match(css, /details-view > \.folder-file-row \.folder-file-meta \{[\s\S]*text-overflow: ellipsis/);
});

test("錄音編輯的速記、錄音及逐字稿是預設收折的獨立區塊", () => {
  for (const title of ["✏️ 速記", "🎙️ 錄音", "📝 逐字稿"]) assert.ok(app.includes(`<summary>${title}`));
  assert.equal((app.match(/<details class="recording-edit-fold">/g) || []).length, 3);
  assert.doesNotMatch(app, /<details class="recording-edit-fold" open>/);
  assert.match(css, /\.recording-edit-fold > summary/);
});
