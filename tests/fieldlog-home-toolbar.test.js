/**
 * 首頁五列版面（2026-08-09 二次修正）：改回直向堆疊的整行區塊，取代第一版
 * 的四欄工具列——欄位太窄會把資料夾樹（縮排＋色系底）擠爛。
 *
 * 五列：①輸入與草稿 ②檢索 ③待處理／Wiki 檔案（左右兩欄）④開發工具
 * ⑤Cloudflare 用量（摺疊）。檢查接線在不在，不測實際版面渲染（跟其他
 * fieldlog UI 測試同一套做法——這裡是純 HTML／CSS 結構檢查）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("index.html：五列都在，且按第一～五列的順序出現", async () => {
  const html = await read("../fieldlog/public/index.html");
  const order = [
    'class="home-section home-input-section"',   // 第一列：輸入與草稿
    'class="home-section home-search-section"',  // 第二列：檢索
    'class="home-row-split"',                     // 第三列：待處理｜Wiki 檔案
    'class="home-section home-tools-section"',    // 第四列：開發工具
    'id="usage-details"',                         // 第五列：Cloudflare 用量
  ];
  let cursor = -1;
  for (const marker of order) {
    const idx = html.indexOf(marker);
    assert.ok(idx !== -1, `找不到 ${marker}`);
    assert.ok(idx > cursor, `${marker} 出現的順序不對`);
    cursor = idx;
  }
});

test("index.html：第一列輸入與草稿只有採集按鈕，待處理搬到第三列去了", async () => {
  const html = await read("../fieldlog/public/index.html");
  const inputSection = html.match(/<section class="home-section home-input-section"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(inputSection, /id="inbox-panel"/, "待處理不該還留在第一列裡");
  assert.match(inputSection, /id="btn-video"/);
  assert.match(inputSection, /id="btn-quick-note"/);
});

test("index.html：第二列檢索沿用既有 id，app.js 靠這些 id 接線，位置搬動不影響邏輯", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="home-search-input"/);
  assert.match(html, /id="home-search-results"/);
});

test("index.html：第三列左右兩欄——待處理與 Wiki 檔案（隨身記自己的資料夾，不是外部 wiki.html）", async () => {
  const html = await read("../fieldlog/public/index.html");
  const split = html.match(/<div class="home-row-split">[\s\S]*?\n {6}<\/div>/)[0];
  assert.match(split, /id="inbox-panel"/);
  assert.match(split, /id="inbox-list"/);
  assert.match(split, /class="home-section home-toolbar-files"/);
  assert.match(split, /id="folder-list"/);
  assert.match(split, /id="btn-new-folder"/);
  assert.doesNotMatch(html, /href="wiki\.html"/, "Wiki 檔案是隨身記自己的資料夾，不該連到外部 wiki.html");
});

test("index.html：第四列開發工具三個連結，medtec 與 DMAIC 開新分頁", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /href="patrol\.html"/);
  assert.match(html, /href="https:\/\/medtec-2026\.gogoyankee\.workers\.dev\/" target="_blank" rel="noopener"/);
  assert.match(html, /href="https:\/\/chiuchangru\.github\.io\/DMAIC\/" target="_blank" rel="noopener"/);
});

test("index.html：巡廠整理連結只留開發工具那一份，不在 header 重複", async () => {
  const html = await read("../fieldlog/public/index.html");
  const patrolLinkCount = (html.match(/href="patrol\.html"/g) || []).length;
  assert.equal(patrolLinkCount, 1);
});

test("index.html：沒有重複 id（重複 id 會讓 getElementById 拿錯元素，是搬版面最容易犯的錯）", async () => {
  const html = await read("../fieldlog/public/index.html");
  const ids = [...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(dupes, []);
});

// 2026-08-09：使用者提醒「顏色樹狀格式不要亂掉」——資料夾樹（縮排＋色系底）
// 塞進第三列右半邊後，原本假設「夠寬才用 grid 排一列、719px 那個*視窗*
// 寬度斷點才切換成窄版排版」的規則會失效（斷點量的是視窗寬度，量不到這一欄
// 實際多窄）。三個測試各鎖一個環節，缺一個都不夠。
test("home.css：第三列用 minmax(0, …) 而不是裸 fr，內容太寬時欄位會縮而不是撐開整排", async () => {
  const css = await read("../fieldlog/public/home.css");
  const rowSplitRule = css.match(/\.home-row-split\s*\{[\s\S]*?\}/)[0];
  assert.match(rowSplitRule, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);/);
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

test("home.css：五列版面沒有殘留上一版四欄工具列的 class（home-toolbar-grid／home-toolbar-col／home-files-panel／home-file-stack／home-inbox-panel）", async () => {
  const css = await read("../fieldlog/public/home.css");
  for (const dead of ["home-toolbar-grid", "home-toolbar-col", "home-files-panel", "home-file-stack", "home-inbox-panel", "home-files-section"]) {
    assert.doesNotMatch(css, new RegExp(`\\.${dead}\\b`), `home.css 不該再有 .${dead}`);
  }
});

test("sw.js：CACHE 版本有跟著這次首頁改版一起換，避免舊快取卡住", async () => {
  const sw = await read("../fieldlog/public/sw.js");
  assert.match(sw, /const CACHE = "fieldlog-v104-home-toolbar-columns";/);
});
