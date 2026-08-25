import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("出發前準備清單：後端有共用資料表、種子資料與勾選/新增/刪除 API", async () => {
  const worker = await read("cloudflare/src/worker.js");

  assert.match(worker, /CREATE TABLE IF NOT EXISTS pretrip_checklist/);
  assert.match(worker, /const PRETRIP_CHECKLIST_SEED = \[/);
  assert.match(worker, /"電子機票（7\/24 之涵已寄）"/);
  assert.match(worker, /"台胞證＋護照"/);
  assert.match(worker, /"名片"/);
  assert.match(worker, /"辦理 e-SIM"/);
  assert.match(worker, /"會場入場免費登記"/);
  assert.match(worker, /PRETRIP_CHECKLIST_SEED\.map\(\(\[id, label, checked\], i\)/, "種子要寫入 pretrip_checklist，且不能覆蓋團隊之後自己勾選/新增的內容");
  assert.match(worker, /INSERT OR IGNORE INTO pretrip_checklist/);

  assert.match(worker, /path === "\/pretrip-checklist" && method === "GET"/);
  assert.match(worker, /path === "\/pretrip-checklist" && method === "POST"/);
  assert.match(worker, /pretripMatch && method === "PUT"/);
  assert.match(worker, /pretripMatch && method === "DELETE"/);
  assert.match(worker, /UPDATE pretrip_checklist SET checked = \?, checked_by = \?, checked_at = \? WHERE id = \?/);
});

test("出發前準備清單：畫在行程總覽最上方，離線先用快取、連線後以伺服器版本覆蓋", async () => {
  const [app, html, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/index.html"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(html, /<div class="pretrip-checklist" id="pretrip-checklist"><\/div>\s*<div class="itin-list" id="itinerary-list">/,
    "清單要放在六天行程列表之前");

  assert.match(app, /let PRETRIP_CHECKLIST = \[\]/);
  assert.match(app, /function renderPretripChecklist\(\)/);
  assert.match(app, /async function loadPretripChecklist\(\)/);
  assert.match(app, /localStorage\.getItem\("medtec_pretrip_checklist"\)/);
  assert.match(app, /api\("\/pretrip-checklist"\)/);
  assert.match(app, /async function togglePretripItem\(id, checked\)/);
  assert.match(app, /api\(`\/pretrip-checklist\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(app, /async function addPretripItem\(\)/);
  assert.match(app, /async function removePretripItem\(id\)/);
  assert.match(app, /renderItinerary\(\);\s*\n\s*loadPretripChecklist\(\);/, "切到行程總覽頁籤時要一起載入出發前準備清單");

  assert.match(style, /\.pretrip-checklist \{/);
  assert.match(style, /\.pretrip-item\.is-checked \.pretrip-label \{ color: var\(--text-muted\); text-decoration: line-through; \}/);
});
