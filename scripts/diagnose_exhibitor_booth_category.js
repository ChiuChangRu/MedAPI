/**
 * 診斷工具：看展商詳情頁上到底有沒有「攤位號」跟「展區分類」這兩項資料，
 * 以及它們實際長什麼樣子（在瀏覽器 F12 Console 貼上執行）。
 *
 * ── 為什麼要先跑這個，不直接動手抓 ──────────────────────────
 * 長儒問「每家參展廠商展區是否可抓得到，並依原本分類」。既有 585 家的
 * category 欄位（cat-01～cat-17）是當初從「1430 筆產品資料」反推來的，
 * 那份產品資料的原始格式我們沒有留著，不確定 category 跟 booth 是不是
 * 在「展商詳情頁」這一層就看得到，還是要另外去逛「產品分類瀏覽頁」才有。
 *
 * 上一輪抓縮圖/官網/型錄時吃過一次虧：型錄的判斷規則憑空寫，抓回來 380
 * 家只中 1 家，後來才發現是大部分公司真的沒放型錄，不是規則寫錯——但
 * 那一輪是抓完全部 380 家才發現的。這次先只抓 1 家看清楚結構，抓對了
 * 再套用到全部，不要重蹈覆轍。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開任一家展商詳情頁，例如：
 *      https://exhibitors.informamarkets-info.com/event/2026Medtec/en-US/exhibitor/467193/lonyi-medicath-co-ltd
 *   2. F12 → Console，貼上這整個檔案，按 Enter
 *   3. 它會自動印出診斷結果，把印出來的整段複製貼回給我
 */
(function () {
  "use strict";

  const BOOTH_RE = /\b[NWE]\d?[-\s]?[A-Z]\d{2,4}\b/g;

  const bodyText = document.body.innerText || "";
  const boothMatches = [...new Set((bodyText.match(BOOTH_RE) || []))];

  // 抓所有連結，找看起來像「分類瀏覽頁」或「麵包屑導覽」的
  const links = [...document.querySelectorAll("a[href]")].map((a) => ({
    href: a.getAttribute("href") || "",
    text: (a.textContent || "").trim(),
  }));
  const categoryLike = links.filter((l) =>
    /categor|product-type|browse|classif/i.test(l.href) ||
    (l.text && l.text.length < 40 && /nav|breadcrumb|categor/i.test(l.href + (document.querySelector(`a[href="${CSS.escape(l.href)}"]`)?.closest("[class]")?.className || "")))
  );

  // 常見的「分類 / 展區」標籤字樣附近的文字，直接抓包含這些關鍵字的整行
  const labelLines = bodyText.split("\n")
    .map((s) => s.trim())
    .filter((s) => s && /booth|stand|攤位|category|classif|product\s*type|分類|展區|hall|館/i.test(s))
    .slice(0, 20);

  const out = {
    目前網址: location.href,
    頁面標題: document.title,
    找到的攤位號候選: boothMatches.slice(0, 5),
    疑似分類連結: categoryLike.slice(0, 10),
    含booth或category等關鍵字的文字行: labelLines,
    麵包屑元素: [...document.querySelectorAll('[class*="breadcrumb" i], nav')].map((el) => (el.innerText || "").trim().slice(0, 200)).filter(Boolean).slice(0, 5),
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("[medtec] 請把上面這段 JSON 整段複製貼回給我");
})();
