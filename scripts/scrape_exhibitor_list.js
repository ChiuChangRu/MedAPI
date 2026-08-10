/**
 * Medtec 2026「完整展商名單」擷取工具（在瀏覽器 F12 Console 貼上執行）
 *
 * ── 為什麼要有這支 ──────────────────────────────────────────
 * 現有 exhibitors.json 只有 585 家，官方宣傳 1100+ 家。對照 2026-06-22 官方
 * 報導點名的 75 家（用專案內 foldText 做簡繁摺疊比對），只命中 22 家，缺
 * 3M、SGS、TÜV 萊茵、威高、微創醫療、大族雷射、發那科等大廠。
 *
 * 成因寫在 exhibitors.json 自己的註記裡：「585 家取自 1430 筆產品資料去重後
 * 的廠商數」——當初從「產品清單」反推廠商，沒登產品資料的展商整家漏掉。
 * 來源本身就是有損的，得改抓「展商列表」。
 *
 * ── 為什麼是瀏覽器腳本 ─────────────────────────────────────
 * AI 執行環境的網路白名單擋掉 exhibitors.informamarkets-info.com
 * （EGRESS_BLOCKED），但你的瀏覽器連得上。跟當初 scrape_exhibitor_photos.js
 * 抓大頭照同一招，不用花錢——網路上在賣的是第三方名錄，官方目錄本身公開。
 *
 * ── v2 改了什麼（2026-08-10）────────────────────────────────
 * v1 只做「攔截頁面發出的 API 請求」，結果實測收到 0 家：使用者貼上腳本時
 * 名單早就載入完畢，沒有新請求可攔。改成 DOM 優先——直接從已經算圖完成的
 * 畫面撈展商連結，不依賴「之後還會不會再發請求」。
 *
 * 靠的是官方目錄固定的網址格式（從舊的大頭照腳本存的 585 個網址確認過）：
 *   /event/2026Medtec/en-US/exhibitor/<數字id>/<公司名-slug>
 * slug 本身就帶公司名，所以就算只撈到連結也已經夠用。
 * 網路攔截保留著當輔助，兩邊的結果會合併去重。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開 https://exhibitors.informamarkets-info.com/event/2026Medtec
 *      並確定畫面上看得到展商清單
 *   2. F12 → Console，貼上這整個檔案，按 Enter
 *   3. 它會自動捲到底、按「載入更多」，把所有展商連結撈出來
 *      進度：__medtecList.status()
 *   4. 停下來後：__medtecList.download()  → exhibitor_list.csv
 *   5. 把 CSV 傳回來
 *
 *   ⚠ 若仍是 0 家 → 打 __medtecList.diagnose()，把印出來的整段貼回給我。
 *      那會列出這一頁實際有哪些連結格式，我照實際結構改，不用瞎猜。
 */
(function () {
  "use strict";

  const RECORDS = new Map();   // key = 展商 id 或網址
  const CAPTURED = [];         // 攔到的 JSON（輔助用）
  let idleRounds = 0;

  // ── A. DOM 擷取（主要手段）─────────────────────────────────
  // 官方目錄的展商連結格式固定，用它認人最穩，不受前端框架改版影響。
  const EX_HREF = /\/exhibitor\/(\d+)\/([^/?#]+)/i;

  function slugToName(slug) {
    // yi-plus-one-medical-technology-co-ltd → Yi Plus One Medical Technology Co Ltd
    return (slug || "").split("-").filter(Boolean)
      .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
  }

  function harvestDom() {
    let added = 0;
    document.querySelectorAll('a[href*="/exhibitor/"]').forEach((a) => {
      const href = a.href || a.getAttribute("href") || "";
      const m = href.match(EX_HREF);
      if (!m) return;
      const [, id, slug] = m;
      if (RECORDS.has(id)) return;

      // 卡片上通常還印著中文名與攤位號，能撈就撈，撈不到就用 slug 還原的英文名
      const card = a.closest('[class*="card" i], li, article, tr, div');
      const text = (card?.innerText || a.innerText || "").trim();
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const zh = lines.find((s) => /[一-鿿]/.test(s)) || "";
      const booth = (text.match(/\b[NWE]?\d[\w-]*[A-Z]\d{2,4}\b/) || [])[0] || "";

      RECORDS.set(id, {
        ex_id: id,
        name_zh: zh,
        name_en: (lines.find((s) => /^[A-Za-z0-9][\w\s.,&()'-]{3,}$/.test(s)) || slugToName(slug)),
        booth_no: booth,
        directory_url: href.split(/[?#]/)[0],
      });
      added++;
    });
    if (added) idleRounds = 0;
    return added;
  }

  // ── B. 網路攔截（輔助）──────────────────────────────────────
  // 頁面之後若還有翻頁請求，順便收；但整支不依賴它（v1 就是栽在這裡）。
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      if (res.headers.get("content-type")?.includes("json")) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        res.clone().json().then((d) => { CAPTURED.push({ url, d }); if (CAPTURED.length > 40) CAPTURED.shift(); }).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // ── C. 自動捲動 / 翻頁 ─────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clickMore() {
    const sels = ['[class*="load-more" i]', '[class*="loadmore" i]', 'button[aria-label*="next" i]',
      'a[aria-label*="next" i]', '[class*="pagination" i] [class*="next" i]', '[class*="show-more" i]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && !el.disabled && el.offsetParent !== null) { el.click(); return true; }
    }
    return false;
  }

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    harvestDom();
    console.log(`[medtec] 起始畫面撈到 ${RECORDS.size} 家，開始自動翻頁…`);
    if (!RECORDS.size) {
      console.warn("[medtec] 目前畫面找不到任何展商連結。");
      console.warn("[medtec] 請確認網址是展商清單頁，然後打 __medtecList.diagnose() 貼回給我");
    }
    while (idleRounds < 10) {
      const before = RECORDS.size;
      window.scrollTo(0, document.body.scrollHeight);
      clickMore();
      await sleep(1100);
      harvestDom();
      if (RECORDS.size === before) idleRounds++; else idleRounds = 0;
      if (RECORDS.size && RECORDS.size % 100 < 4) console.log(`[medtec] 已收集 ${RECORDS.size} 家…`);
    }
    running = false;
    console.log(`[medtec] 停止，共 ${RECORDS.size} 家。接著打 __medtecList.download()`);
  }

  // ── D. 匯出 ────────────────────────────────────────────
  const COLS = ["name_zh", "name_en", "booth_no", "directory_url", "ex_id"];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  window.__medtecList = {
    run,
    harvest: harvestDom,
    status: () => { console.log(`已收集 ${RECORDS.size} 家（連續 ${idleRounds} 輪無新增）`); return RECORDS.size; },
    download: () => {
      const rows = [...RECORDS.values()];
      if (!rows.length) return console.warn("沒有資料，請先打 __medtecList.diagnose()");
      const csv = [COLS.join(","), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
      a.download = "exhibitor_list.csv";
      a.click();
      console.log(`已下載 ${rows.length} 家 → exhibitor_list.csv`);
    },
    // 撈不到時的據實回報：列出這一頁真正有的連結長相，讓我照實際結構改。
    diagnose: () => {
      const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.href);
      const groups = {};
      hrefs.forEach((h) => {
        const p = h.replace(location.origin, "").split(/[?#]/)[0]
          .replace(/\/\d+/g, "/<數字>").split("/").slice(0, 5).join("/");
        groups[p] = (groups[p] || 0) + 1;
      });
      const top = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 25);
      const out = {
        目前網址: location.href,
        頁面連結總數: hrefs.length,
        連結格式分布: top,
        含exhibitor字樣的連結範例: hrefs.filter((h) => /exhibitor/i.test(h)).slice(0, 5),
        攔到的API網址: CAPTURED.map((c) => c.url).slice(-10),
        iframe數量: document.querySelectorAll("iframe").length,
      };
      console.log(JSON.stringify(out, null, 2));
      return out;
    },
  };

  run();
})();
