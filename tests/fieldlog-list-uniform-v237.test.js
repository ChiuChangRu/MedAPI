import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

async function loadHelpers() {
  const app = await read("../fieldlog/public/app.js");
  const pick = (name) => app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`))[0];
  const ctx = { esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;") };
  vm.runInNewContext(`${pick("explorerNameHtml")}\n${pick("entryIconFor")}\nthis.explorerNameHtml = explorerNameHtml; this.entryIconFor = entryIconFor;`, ctx);
  return ctx;
}

test("v237 顯示名稱：括號標籤、日期尾巴、副檔名包成 .title-affix，完整原名仍在 textContent", async () => {
  const { explorerNameHtml } = await loadHelpers();
  assert.equal(explorerNameHtml("【AI彙整】天虹簡報（2026-09-30）"),
    '<span class="title-affix">【AI彙整】</span>天虹簡報<span class="title-affix">（2026-09-30）</span>');
  assert.equal(explorerNameHtml("抗結痂塗層技術.pptx", { ext: true }), '抗結痂塗層技術<span class="title-affix">.pptx</span>');
  assert.equal(explorerNameHtml("車上問答分享"), "車上問答分享");
  // 整個名稱只有標籤時不拆，避免顯示成空白
  assert.equal(explorerNameHtml("【AI彙整】"), "【AI彙整】");
  // 名稱中間的括號不動
  assert.equal(explorerNameHtml("模擬人工尿液配方（已核對原文）｜Han"), "模擬人工尿液配方（已核對原文）｜Han");
});

test("v237 記事一律有圖示：連結 🔗、AI 彙整 🤖、其他 📝", async () => {
  const { entryIconFor } = await loadHelpers();
  assert.equal(entryIconFor({ title: "x", link_url: "https://a.b" }), "🔗");
  assert.equal(entryIconFor({ title: "【AI彙整】前言" }), "🤖");
  assert.equal(entryIconFor({ title: "一般筆記" }), "📝");
});

test("v237 清單模式：卡片按鈕移除、統一版面、隱藏括號／日期／轉錄徽章", async () => {
  const [html, app, css] = await Promise.all([
    read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js"), read("../fieldlog/public/style.css"),
  ]);
  assert.doesNotMatch(html, /btn-inner-grid/);
  assert.match(app, /INNER_FOLDER_VIEW = localStorage\.getItem\("fieldlog_inner_folder_view"\) === "details" \? "details" : "list"/);
  assert.match(css, /#folder-entries \.title-affix \{ display: none; \}/);
  assert.match(css, /#folder-entries\.list-view > \.explorer-item \{\s*display: grid !important; grid-template-columns: 24px minmax\(0, 1fr\) auto;/);
  assert.match(css, /#folder-entries\.list-view > \.record-group-card > \.recording-card-status/);
  assert.match(app, /\? "🎬" : "📄"/);
});
