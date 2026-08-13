/**
 * 首頁五列版面（2026-08-09 三次修正）：全部改回直向堆疊的整行區塊，包含
 * 第三列——原本排成左右兩欄（待處理｜Wiki 檔案），使用者要求改回上下順序
 * （待處理在上、已分類的 Wiki 檔案在下）。
 *
 * 五列：①輸入與草稿 ②檢索 ③待處理 → Wiki 檔案 ④開發工具
 * ⑤Cloudflare 用量（摺疊）。檢查接線在不在，不測實際版面渲染（跟其他
 * fieldlog UI 測試同一套做法——這裡是純 HTML／CSS 結構檢查）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("index.html：五列全部整行堆疊，按順序出現——待處理在上、Wiki 檔案在下", async () => {
  const html = await read("../fieldlog/public/index.html");
  const order = [
    'class="home-section home-input-section"',  // 第一列：輸入與草稿
    'class="home-section home-search-section"', // 第二列：檢索
    'id="inbox-panel"',                          // 第三列上半：待處理
    'class="home-section home-toolbar-files"',   // 第三列下半：Wiki 檔案
    'class="home-section home-tools-section"',   // 第四列：開發工具
    'id="usage-details"',                        // 第五列：Cloudflare 用量
  ];
  let cursor = -1;
  for (const marker of order) {
    const idx = html.indexOf(marker);
    assert.ok(idx !== -1, `找不到 ${marker}`);
    assert.ok(idx > cursor, `${marker} 出現的順序不對`);
    cursor = idx;
  }
});

test("index.html：第三列不再是左右兩欄（.home-row-split 已拿掉），待處理與 Wiki 檔案各自整行", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.doesNotMatch(html, /home-row-split/, "第三列改回上下堆疊，不該還有並排用的 wrapper");
});

test("index.html：第一列輸入與草稿只有採集按鈕，待處理獨立成自己的一列", async () => {
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

test("index.html：待處理與 Wiki 檔案（隨身記自己的資料夾，不是外部 wiki.html）接線都在", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="inbox-panel"/);
  assert.match(html, /id="inbox-list"/);
  assert.match(html, /class="home-section home-toolbar-files"/);
  assert.match(html, /id="folder-list"/);
  assert.match(html, /id="btn-new-folder"/);
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

test("style.css：.folder-card 有 min-width: 0，避免 flex column 容器裡的子項目撐破容器", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /\.folder-card\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
});

// 2026-08-09：Wiki 檔案這欄已經回到跟其他四列一樣的整行寬度，不再是被
// 硬塞進去的窄欄，所以不再需要「不管視窗多寬都強制窄版排版」那組 CSS——
// 靠 style.css 既有的 719px 視窗寬度斷點就夠了（量得到的就是真的視窗寬度，
// 不是被人為切窄的欄位）。這裡反過來鎖：那組上一版留下的強制窄版規則
// 不該再出現，免得之後又有人加回來。
test("home.css：沒有殘留上一版「並排兩欄」時代的死 class（home-row-split／home-toolbar-grid／home-toolbar-col／home-files-panel／home-file-stack／home-inbox-panel）", async () => {
  const css = await read("../fieldlog/public/home.css");
  for (const dead of [
    "home-row-split", "home-toolbar-grid", "home-toolbar-col",
    "home-files-panel", "home-file-stack", "home-inbox-panel", "home-files-section",
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\.${dead}\\b`), `home.css 不該再有 .${dead}`);
  }
  assert.doesNotMatch(
    css,
    /\.home-toolbar-files \.folder-card-main/,
    "Wiki 檔案已經是整行寬度，不該再強制套用窄版資料夾卡片排版"
  );
});

test("sw.js：CACHE 版本有跟著錄音資料流探測升到 v106，避免舊快取卡住", async () => {
  const sw = await read("../fieldlog/public/sw.js");
  assert.match(sw, /const CACHE = "fieldlog-v106-audio-flow-probe";/);
});
