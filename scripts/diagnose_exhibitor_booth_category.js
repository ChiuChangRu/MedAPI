/**
 * 診斷工具 v2：看展商詳情頁上到底有沒有「攤位號」跟「展區分類」這兩項資料
 * （在瀏覽器 F12 Console 貼上執行）。
 *
 * ── v1 為什麼全部落空 ──────────────────────────────────────
 * v1 直接讀「目前畫面上的 DOM」（document.body.innerText），結果四項全部
 * 是空的，連麵包屑都沒有。頁面標題印出來是「2026 Medtec Digital
 * Showroom」——這是殼層頁，真正的展商資料另外用非同步方式載入（跟先前
 * 展商清單頁的狀況一樣：外層文件本身沒有資料）。
 *
 * v2 改成跟 scrape_exhibitor_details.js 同一招：用 fetch() 另外抓一份
 * 頁面原始碼來看，不是讀當下畫面的 DOM——這正是縮圖/官網那支能成功抓到
 * 東西的原因。抓不到才退回隱藏 iframe 重試一次（給非同步內容多一點時間
 * 跑完）。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開任一家展商詳情頁（跟 v1 同一頁就可以，不用換）
 *   2. F12 → Console，貼上這整個檔案，按 Enter
 *   3. 它會印出診斷結果，把印出來的整段複製貼回給我
 */
(function () {
  "use strict";

  const BOOTH_RE = /\b[NWE]\d?[-\s]?[A-Z]\d{2,4}\b/g;
  const IFRAME_WAIT_MS = 2000;

  function diagnoseDoc(doc, sourceLabel) {
    const bodyText = doc.body?.innerText || "";
    const boothMatches = [...new Set((bodyText.match(BOOTH_RE) || []))];
    const links = [...doc.querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim(),
    }));
    const categoryLike = links.filter((l) => /categor|product-type|browse|classif/i.test(l.href));
    const labelLines = bodyText.split("\n")
      .map((s) => s.trim())
      .filter((s) => s && /booth|stand|攤位|category|classif|product\s*type|分類|展區|hall|館/i.test(s))
      .slice(0, 20);
    const breadcrumbEls = [...doc.querySelectorAll('[class*="breadcrumb" i], nav')]
      .map((el) => (el.innerText || "").trim().slice(0, 200)).filter(Boolean).slice(0, 5);

    return {
      來源: sourceLabel,
      文件title: doc.title,
      body字數: bodyText.length,
      找到的攤位號候選: boothMatches.slice(0, 5),
      疑似分類連結: categoryLike.slice(0, 10),
      含booth或category等關鍵字的文字行: labelLines,
      麵包屑元素: breadcrumbEls,
    };
  }

  function tryIframe(url) {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;";
      let done = false;
      const finish = (result) => { if (done) return; done = true; iframe.remove(); resolve(result); };
      iframe.onload = () => {
        setTimeout(() => {
          try {
            const doc = iframe.contentDocument;
            if (!doc) return finish({ ok: false, error: "no-contentDocument（可能被同源政策擋掉）" });
            finish({ ok: true, result: diagnoseDoc(doc, "iframe（等非同步內容跑完後讀取）") });
          } catch (e) { finish({ ok: false, error: String(e) }); }
        }, IFRAME_WAIT_MS);
      };
      iframe.onerror = () => finish({ ok: false, error: "iframe load error" });
      document.body.appendChild(iframe);
      iframe.src = url;
      setTimeout(() => finish({ ok: false, error: "iframe timeout" }), IFRAME_WAIT_MS + 5000);
    });
  }

  (async () => {
    const url = location.href;
    let out;
    try {
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      out = diagnoseDoc(doc, "fetch()（跟縮圖/官網那支同一招）");
    } catch (e) {
      out = { 來源: "fetch() 失敗", error: String(e) };
    }
    // fetch 到的原始 HTML 如果也是空殼（非同步內容連原始碼裡都沒有，要靠
    // JS 執行後才生成），才退回用 iframe 實際跑一次 JS 再讀
    if (!out.找到的攤位號候選?.length && !out.疑似分類連結?.length && !out.麵包屑元素?.length) {
      console.log("[medtec] fetch() 版本看起來也是空的，改用 iframe 試一次（會等 2 秒讓內容跑完）…");
      const iframeResult = await tryIframe(url);
      if (iframeResult.ok) out = { fetch版本: out, iframe版本: iframeResult.result };
      else out = { fetch版本: out, iframe失敗原因: iframeResult.error };
    }
    console.log(JSON.stringify(out, null, 2));
    console.log("[medtec] 請把上面這段 JSON 整段複製貼回給我");
  })();
})();
