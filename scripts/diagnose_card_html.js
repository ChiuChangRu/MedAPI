/**
 * 診斷工具 v2：印出展商卡片「整張」的原始 HTML 與祖先鏈
 * （在瀏覽器 F12 Console 貼上執行）。
 *
 * ── v1 為什麼只看到碎片 ────────────────────────────────────
 * v1 用 a.closest('[class*="card" i], li, article, tr, div') 找卡片容器，
 * 結果命中的是 <h4 class="card-title">——這個標題元素的 class 剛好含有
 * "card" 這個字，closest() 從最近的祖先往上找，第一個就中了它。所以印出來
 * 只有公司名那一小塊，攤位號／分類就算存在也不在這個範圍內，等於什麼都
 * 沒驗證到。
 *
 * v2 改成不猜哪一層是卡片：直接把連結往上 6 層祖先全部列出來（標籤、
 * class、文字長度），再挑其中「文字內容明顯變多」的那一層印出完整 HTML。
 * 這樣不管卡片容器叫什麼 class 都跑不掉。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開展商清單頁：https://exhibitors.informamarkets-info.com/event/2026Medtec
 *   2. 等畫面上看得到展商清單
 *   3. F12 → Console，貼上這整個檔案，按 Enter
 *   4. 把印出來的結果截圖或複製貼回給我
 */
(function () {
  "use strict";

  function accessibleDocs() {
    const docs = [{ doc: document, label: "top" }];
    document.querySelectorAll("iframe").forEach((f, i) => {
      try {
        const doc = f.contentDocument;
        if (doc) docs.push({ doc, label: `iframe#${i}` });
      } catch (e) { /* 跨網域摸不到，略過 */ }
    });
    return docs;
  }

  let link = null;
  let frameLabel = "";
  for (const { doc, label } of accessibleDocs()) {
    const a = doc.querySelector('a[href*="/exhibitor/"]');
    if (a) { link = a; frameLabel = label; break; }
  }
  if (!link) {
    console.log("找不到任何展商連結，請確認畫面上看得到展商清單");
    return;
  }

  // 往上爬 6 層，記錄每一層的標籤/class/文字長度——文字長度突然變大的那層
  // 通常就是整張卡片（含攤位號、分類等其他欄位）
  const chain = [];
  let el = link;
  for (let i = 0; i < 6 && el; i++) {
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    chain.push({
      第幾層: i,
      標籤: el.tagName.toLowerCase(),
      class: el.className || "(無)",
      文字長度: text.length,
      文字內容: text.slice(0, 300),
    });
    el = el.parentElement;
  }

  // 挑文字量最多的那一層（最可能是完整卡片）印出 HTML
  const richest = chain.reduce((a, b) => (b.文字長度 > a.文字長度 ? b : a), chain[0]);
  let target = link;
  for (let i = 0; i < richest.第幾層 && target.parentElement; i++) target = target.parentElement;

  console.log(JSON.stringify({
    來源frame: frameLabel,
    祖先鏈: chain,
    文字量最多的那層: richest.第幾層,
    那層的完整HTML: target.outerHTML.slice(0, 4000),
  }, null, 2));
  console.log("[medtec] 請把上面這段整段複製或截圖貼回給我");
})();
