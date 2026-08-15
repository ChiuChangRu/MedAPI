/**
 * scripts/scrape_exhibitor_list.js 的卡片解析邏輯。
 *
 * 2026-08-10：長儒問「每家廠商被分配到的區域（攤位）能不能抓得到，並依
 * 原本分類」。前面連續猜錯三輪（猜 API JSON、猜資料內嵌在原始碼、猜回應
 * 是 HTML 片段），最後直接把卡片原始 HTML 印出來才看到真實結構：
 *
 *   <div class="col-xs-12 col-sm-6 col-md-4 col-lg-3 odd">
 *     <a class="card-image"><span class="logourl" data="縮圖網址"></span></a>
 *     <div class="name"><h4 class="card-title"><a>A2MediteX Corporation</a></h4>
 *       <div class="ExhList_Desc">簡介…</div></div>
 *     <div class="info">
 *       COUNTRY/REGION: JAPAN
 *       PRODUCT CATEGORIES: 2. Metallic Raw Materials and Components
 *       BOOTH NUMBER : 2F310
 *     </div>
 *   </div>
 *
 * 這裡鎖住兩個先前踩到的坑：
 * 1. 卡片容器不能用 closest('[class*="card"]')——會命中 <h4 class="card-title">
 *    （class 剛好含 card），只拿到公司名那一小塊，其他欄位全部看不到。
 * 2. 攤位號實際格式是 2F310，不是舊資料的 N2-F310。先前的比對規則要求開頭
 *    是 N/W/E，導致 881 家一個攤位號都沒抓到，而且沒有任何錯誤訊息。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadFns() {
  const src = await readFile(new URL("../scripts/scrape_exhibitor_list.js", import.meta.url), "utf8");
  const block = (marker) => {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `找不到 ${marker}`);
    if (marker.startsWith("const")) {
      // const 物件：抓到對應的結尾大括號＋分號
      let depth = 0, i = src.indexOf("{", start);
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") { depth--; if (depth === 0) break; }
      }
      return src.slice(start, src.indexOf(";", i) + 1);
    }
    let depth = 0, i = src.indexOf("{", start);
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  };
  const code = [
    block("const LABEL_PATTERNS"),
    block("function normalizeBooth"),
    block("function parseCategories"),
    "globalThis.__fns = { LABEL_PATTERNS, normalizeBooth, parseCategories };",
  ].join("\n");
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx);
  return ctx.__fns;
}

test("攤位號：官方新格式 2F310 正規化成既有資料的 N2-F310 寫法", async () => {
  const { normalizeBooth } = await loadFns();
  assert.equal(normalizeBooth("2F310"), "N2-F310");
  assert.equal(normalizeBooth("2D001"), "N2-D001");
  assert.equal(normalizeBooth("3A202"), "N3-A202");
});

test("攤位號：已經是 N#-X### 舊寫法的原樣保留（大小寫統一）", async () => {
  const { normalizeBooth } = await loadFns();
  assert.equal(normalizeBooth("N2-A207"), "N2-A207");
  assert.equal(normalizeBooth("n3-d102"), "N3-D102");
});

test("攤位號：認不出來的格式原樣留著，不默默丟掉資料", async () => {
  const { normalizeBooth } = await loadFns();
  assert.equal(normalizeBooth("GP"), "GP", "既有資料裡真的有一筆是 GP，不能被清成空字串");
  assert.equal(normalizeBooth(""), "");
  assert.equal(normalizeBooth(null), "");
});

test("分類：主分類編號對應到既有的 cat-XX", async () => {
  const { parseCategories } = await loadFns();
  assert.deepEqual(Array.from(parseCategories("2. Metallic Raw Materials and Components")), ["cat-02"]);
  assert.deepEqual(Array.from(parseCategories("15. OEM/ODM Full-Service Contract Manufacturing")), ["cat-15"]);
});

test("分類：8.x 子分類對應到 cat-08-x（既有資料就是這樣分的）", async () => {
  const { parseCategories } = await loadFns();
  const got = parseCategories("8.3 Energy and Signal Transmission");
  assert.ok(got.includes("cat-08-3"), `應該要有 cat-08-3，實際拿到 ${JSON.stringify(got)}`);
});

test("分類：一家掛多個分類時全部取出，不會只留第一個", async () => {
  const { parseCategories } = await loadFns();
  const got = parseCategories("2. Metallic Raw Materials and Components, 15. OEM/ODM Full-Service Contract Manufacturing");
  assert.ok(got.includes("cat-02"));
  assert.ok(got.includes("cat-15"));
});

test("分類：官方 8.x 子分類的真實寫法「8.2Sensing…」（數字後直接接字母）要對到 cat-08-2", async () => {
  // 2026-08-10 實測 881 家：官方主分類寫成 "2. Metallic…"（有點有空格），
  // 但 8.x 子分類寫成 "8.2Sensing and Actuation：…"——數字後面沒有空格、
  // 也沒有第二個點，直接接英文字母。先前的規則用 \b 當結尾，而 "2" 跟 "S"
  // 都是文字字元、中間沒有邊界，整條配不到，導致 77 家全部退化成
  // 「cat-08」這個我們系統裡根本不存在的分類。
  const { parseCategories } = await loadFns();
  const cases = {
    "8.1Intelligent Control and Computing：Main control chips": "cat-08-1",
    "8.2Sensing and Actuation：Biosensors，Physical sensors": "cat-08-2",
    "8.3Energy and Signal Transmission：Power supplies": "cat-08-3",
    "8.6Microfluidic systems，Precision structural components": "cat-08-6",
  };
  for (const [raw, expect] of Object.entries(cases)) {
    const got = Array.from(parseCategories(raw));
    assert.deepEqual(got, [expect], `「${raw.slice(0, 20)}…」應該只對到 ${expect}`);
    assert.ok(!got.includes("cat-08"), "不能產生 cat-08——我們的分類系統只有 cat-08-1～6，沒有純 cat-08");
  }
});

test("攤位號：同一攤位再細分的「4G102-8」也要正規化（先前這 4 筆整個匹配失敗）", async () => {
  const { normalizeBooth } = await loadFns();
  assert.equal(normalizeBooth("4G102-8"), "N4-G102-8");
  assert.equal(normalizeBooth("4G102-1"), "N4-G102-1");
});

test("分類：沒有分類資訊時回空陣列，不會硬湊一個假分類", async () => {
  const { parseCategories } = await loadFns();
  assert.deepEqual(Array.from(parseCategories("")), []);
  assert.deepEqual(Array.from(parseCategories("Uncategorized")), []);
});

test("標籤比對：英文版頁面的三個欄位都抓得到", async () => {
  const { LABEL_PATTERNS } = await loadFns();
  const text = [
    "A2MEDITEX CORPORATION",
    "COUNTRY/REGION: JAPAN",
    "PRODUCT CATEGORIES: 2. Metallic Raw Materials and Components",
    "BOOTH NUMBER : 2F310",
  ].join("\n");
  assert.equal(text.match(LABEL_PATTERNS.country)[1].trim(), "JAPAN");
  assert.equal(text.match(LABEL_PATTERNS.categories)[1].trim(), "2. Metallic Raw Materials and Components");
  assert.equal(text.match(LABEL_PATTERNS.booth)[1].trim(), "2F310");
});

test("標籤比對：中文版頁面的標籤字樣也要認得（中文名要靠中文版才抓得到）", async () => {
  const { LABEL_PATTERNS } = await loadFns();
  const text = [
    "上海某某醫療科技有限公司",
    "国家/地区：中国",
    "产品类别：2. 金属材料及其部件",
    "展位号：2F310",
  ].join("\n");
  assert.equal(text.match(LABEL_PATTERNS.country)[1].trim(), "中国");
  assert.equal(text.match(LABEL_PATTERNS.booth)[1].trim(), "2F310");
  assert.ok(text.match(LABEL_PATTERNS.categories), "產品類別標籤要抓得到");
});

test("腳本不再用只認 N/W/E 開頭的舊攤位號規則——擋住改回會漏抓的寫法", async () => {
  const src = await readFile(new URL("../scripts/scrape_exhibitor_list.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\\b\[NWE\]\\d\?\[-\\s\]\?\[A-Z\]/,
    "這條規則配不到官方實際用的 2F310 格式，881 家會一個攤位號都抓不到");
});

test("卡片容器不再用 closest('[class*=\"card\"]')——那會命中 h4.card-title", async () => {
  const src = await readFile(new URL("../scripts/scrape_exhibitor_list.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /closest\('\[class\*="card" i\]/,
    "會命中 <h4 class=\"card-title\">，只拿到公司名，其他欄位全部看不到");
  assert.match(src, /closest\('\[class\*="col-"\]'\)/, "要用 Bootstrap col-* 格線欄位找整張卡片");
});
