/**
 * v202：預覽欄排版緊湊化。
 *
 * body 沒設字級，預覽欄裡沒指定字級的元素都繼承 16px，跟 App 其他地方
 * （12–14px）比起來忽大忽小；AI 整理筆記沒內容時「尚未整理」還出現兩次。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function previewRenderer() {
  const app = await read("../fieldlog/public/app.js");
  const src = ["aiNoteStatusLabel", "aiNotePreviewHtml"].map((n) => {
    const m = app.match(new RegExp(`function ${n}\\([^)]*\\)[\\s\\S]*?\\n\\}\\n`))?.[0];
    assert.ok(m, `找不到函式 ${n}`);
    return m;
  }).join("\n");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Function("esc", "localDateTime", "window", `${src}\nreturn aiNotePreviewHtml;`)(esc, (s) => s, { fieldlogRichEditor: null });
}

test("AI 整理筆記預覽：沒內容時「尚未整理」只出現一次（標題下的小字），不再另放內文段落", async () => {
  const aiNotePreviewHtml = await previewRenderer();
  for (const html of [aiNotePreviewHtml(null), aiNotePreviewHtml(null, { collapsible: true })]) {
    assert.equal(html.match(/尚未整理/g)?.length, 1);
    assert.doesNotMatch(html, /ai-summary-markdown/);
  }
  const withNote = aiNotePreviewHtml({ markdown: "## 重點", status: "completed" });
  assert.match(withNote, /<div class="ai-summary-markdown"><pre>## 重點<\/pre><\/div>/);
});

test("預覽欄明確指定字級：內文 14px，不再繼承 body 的 16px", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /\.inspector-recording-preview \{[^}]*font-size: 14px;/);
  assert.match(css, /\.ai-summary-note\.ai-summary-note-preview \{[^}]*font-size: 14px;/);
  assert.match(css, /\.ai-summary-note-preview \.ai-summary-note-head strong \{ font-size: 14px; \}/);
  assert.match(css, /\.recording-interleaved-head > strong \{ font-size: 14px; \}/);
  assert.match(css, /\.ai-summary-markdown :is\(h1, h2, h3\) \{[^}]*font-size: 15px;/);
});

test("手機記事編輯畫面的 AI 整理筆記不跟著縮小（周圍都是 16px，縮了反而不一致）", async () => {
  const css = await read("../fieldlog/public/style.css");
  const base = css.match(/\n\.ai-summary-note \{[^}]*\}/)?.[0];
  assert.ok(base, "找不到 .ai-summary-note 基本規則");
  assert.doesNotMatch(base, /font-size/);
  assert.doesNotMatch(css, /\n\.ai-summary-note-head strong \{/, "標題縮字只能套在 .ai-summary-note-preview 底下");
  assert.match(css, /\.ai-summary-note-head > \.btn \{ flex: none; white-space: nowrap; \}/);
});
