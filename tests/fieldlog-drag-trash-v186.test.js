import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");
const html = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");

test("垃圾桶平常隱藏，只在拖曳檔案、紀錄或資料夾時顯示", () => {
  assert.match(css, /#desktop-trash\.fixed-trash\s*\{[\s\S]*?display:\s*none/);
  assert.match(css, /body\.folder-dragging #desktop-trash\.fixed-trash/);
  assert.match(css, /body\.entry-dragging #desktop-trash\.fixed-trash/);
  assert.match(css, /body:has\(\.file-batch-dragging\) #desktop-trash\.fixed-trash/);
  assert.match(css, /body:has\(\.desktop-tree-row\.dragging\) #desktop-trash\.fixed-trash/);
  assert.doesNotMatch(css, /body:has\(#file-selection-bar:not\(\[hidden\]\)\) #desktop-trash/);
});

test("垃圾桶改為右下角的緊湊投放區，已選取工具列不再預留大型垃圾桶高度", () => {
  const rule = css.match(/#desktop-trash\.fixed-trash\s*\{[\s\S]*?\}/)?.[0] || "";
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /right:\s*18px/);
  assert.match(rule, /width:\s*88px/);
  assert.match(css, /body:has\(#file-selection-bar:not\(\[hidden\]\)\) \.container \{ padding-bottom: 90px; \}/);
  assert.match(html, /id="btn-deleted-items"/);
  assert.match(html, /id="desktop-trash"[^>]*title="拖到這裡移到垃圾桶"/);
});
