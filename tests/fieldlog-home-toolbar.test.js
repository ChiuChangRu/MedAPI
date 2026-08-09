/**
 * 首頁四欄工具列（2026-08-09）：檢索／Wiki 檔案／開發工具／Cloudflare 用量
 * 各自獨立成欄。檢查接線在不在，不測實際版面渲染（跟其他 fieldlog UI 測試
 * 同一套做法——這裡是純 HTML／CSS 結構檢查）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("index.html：四欄工具列各自有搜尋、隨身記檔案、開發工具三個外部連結、用量區塊", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /<div class="home-toolbar-grid" id="home-toolbar-grid">/);

  // 欄一：搜尋（沿用既有 id，app.js 靠這些 id 接線，位置搬動不影響邏輯）
  assert.match(html, /id="home-search-input"/);
  assert.match(html, /id="home-search-results"/);

  // 欄二：「Wiki 檔案」＝隨身記自己的資料夾歸檔，不是外部的 wiki.html
  // （那是另一套獨立系統，2026-08-09 使用者澄清過，不該連過去）
  assert.doesNotMatch(html, /href="wiki\.html"/);
  assert.match(html, /class="home-section home-toolbar-col home-toolbar-files"/);
  assert.match(html, /id="folder-list"/);
  assert.match(html, /id="btn-new-folder"/);

  // 欄三：開發工具三個連結，medtec 與 DMAIC 是外部網址、開新分頁
  assert.match(html, /href="patrol\.html"/);
  assert.match(html, /href="https:\/\/medtec-2026\.gogoyankee\.workers\.dev\/" target="_blank" rel="noopener"/);
  assert.match(html, /href="https:\/\/chiuchangru\.github\.io\/DMAIC\/" target="_blank" rel="noopener"/);

  // 欄四：用量區塊搬進工具列、只留一份（不是複製一份，原本位置的那份要拿掉）
  const usageDetailsCount = (html.match(/id="usage-details"/g) || []).length;
  assert.equal(usageDetailsCount, 1, "usage-details 不該重複出現");
  assert.match(html, /<details class="home-section home-toolbar-col home-usage-section" id="usage-details">/);

  // 沒有重複 id（重複 id 會讓 getElementById 拿錯元素，是這次搬版面最容易犯的錯）
  const ids = [...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], "index.html 不該有重複 id");
});

test("index.html：巡廠整理連結只留工具列那一份，不在 header 重複", async () => {
  const html = await read("../fieldlog/public/index.html");
  const patrolLinkCount = (html.match(/href="patrol\.html"/g) || []).length;
  assert.equal(patrolLinkCount, 1);
});

test("home.css：四欄工具列有響應式斷點，窄螢幕疊成一欄", async () => {
  const css = await read("../fieldlog/public/home.css");
  assert.match(
    css,
    /\.home-toolbar-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.6fr\) minmax\(0, 1fr\) minmax\(0, 1fr\);/
  );
  assert.match(css, /@media \(max-width: 719px\)[\s\S]*?\.home-toolbar-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
});

// 2026-08-09：使用者提醒「顏色樹狀格式不要亂掉」——資料夾樹（縮排＋色系底）
// 塞進較窄的工具列欄位後，原本假設「夠寬才用 grid 排一列、719px 那個*視窗*
// 寬度斷點才切換成窄版排版」的規則會失效（斷點量的是視窗寬度，量不到這一欄
// 實際多窄），逼 date／count／type 這些 nowrap 欄位把名稱擠爛、色系底跟著
// 撐壞。三個測試各鎖一個環節，缺一個都不夠。
test("home.css：工具列欄位用 minmax(0, …) 而不是裸 fr，內容太寬時欄位會縮而不是撐開整排", async () => {
  const css = await read("../fieldlog/public/home.css");
  assert.doesNotMatch(
    css.match(/\.home-toolbar-grid\s*\{[\s\S]*?\}/)[0],
    /grid-template-columns:\s*[\d.]+fr/,
    "grid-template-columns 不該有裸的 fr 軌（要包在 minmax(0, …) 裡）"
  );
});

test("home.css：Wiki 檔案欄不管視窗多寬都套用窄版資料夾卡片排版（名稱獨占一行、日期與拖曳把手藏起來）", async () => {
  const css = await read("../fieldlog/public/home.css");
  assert.match(css, /\.home-toolbar-files \.folder-card-main\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(css, /\.home-toolbar-files \.folder-name\s*\{[\s\S]*?flex:\s*1 1 100%;/);
  assert.match(
    css,
    /\.home-toolbar-files \.folder-date,\s*\n\s*\.home-toolbar-files \.folder-drag\s*\{[\s\S]*?display:\s*none;/
  );
});

test("style.css：.folder-card 有 min-width: 0，flex column 容器裡才會真的縮小而不是撐破窄欄", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /\.folder-card\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
});

test("sw.js：CACHE 版本有跟著這次首頁改版一起換，avoid 舊快取卡住", async () => {
  const sw = await read("../fieldlog/public/sw.js");
  assert.match(sw, /const CACHE = "fieldlog-v104-home-toolbar-columns";/);
});
