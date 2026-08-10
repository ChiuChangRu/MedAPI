/**
 * 診斷工具：直接印出展商清單頁裡，一張真實的展商卡片的原始 HTML 長相
 * （在瀏覽器 F12 Console 貼上執行）。
 *
 * ── 為什麼要看這個 ──────────────────────────────────────────
 * 前面兩輪診斷都用「猜規則」的方式找攤位號／分類：先猜是攔截 API JSON
 * 回應，攔不到；再猜是資料內嵌在頁面原始碼裡，查出來也不是（StandNoStr
 * 只出現 7 次，是程式邏輯提到的名字，不是逐筆資料）。合理推測：資料是
 * 額外請求來的，但回應可能是「HTML 網頁片段」而不是 JSON，攔截器只認
 * JSON 格式所以完全沒抓到。
 *
 * 與其再猜第三種可能，這次直接把瀏覽器裡已經渲染出來的展商卡片原始 HTML
 * 印出來，直接用眼睛看攤位號／分類到底有沒有在裡面、藏在哪個 class 或
 * 屬性裡——不用再繼續憑空寫規則。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開展商清單頁：https://exhibitors.informamarkets-info.com/event/2026Medtec
 *   2. 等畫面上看得到展商清單（不用等全部載入，看到幾筆就可以）
 *   3. F12 → Console，貼上這整個檔案，按 Enter
 *   4. 把印出來的結果整段複製貼回給我（可能會有點長，全部複製沒關係）
 */
(function () {
  "use strict";

  function accessibleDocs() {
    const docs = [{ doc: document, label: "top" }];
    document.querySelectorAll("iframe").forEach((f, i) => {
      try {
        const doc = f.contentDocument;
        if (doc) docs.push({ doc, label: `iframe#${i}(${f.src || "同源"})` });
      } catch (e) { /* 跨網域摸不到，略過 */ }
    });
    return docs;
  }

  const samples = [];
  for (const { doc, label } of accessibleDocs()) {
    const links = doc.querySelectorAll('a[href*="/exhibitor/"]');
    for (const a of links) {
      if (samples.length >= 3) break;
      const card = a.closest('[class*="card" i], li, article, tr, div') || a.parentElement;
      samples.push({
        frame: label,
        連結文字: (a.textContent || "").trim().slice(0, 100),
        連結href: a.getAttribute("href") || "",
        卡片標籤與class: card ? `<${card.tagName.toLowerCase()} class="${card.className}">` : "(找不到外層容器)",
        卡片完整HTML: card ? card.outerHTML.slice(0, 3000) : "",
      });
    }
    if (samples.length >= 3) break;
  }

  console.log(JSON.stringify({ 找到的展商卡片數量: samples.length, 樣本: samples }, null, 2));
  console.log("[medtec] 請把上面這段 JSON 整段複製貼回給我");
})();
