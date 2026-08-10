/**
 * Medtec 2026「完整展商名單」擷取工具（在瀏覽器 F12 Console 貼上執行）
 *
 * ── 為什麼要有這支 ──────────────────────────────────────────
 * 現有的 exhibitors.json 只有 585 家，但官方宣傳寫 1100+ 家。對照 2026-06-22
 * 官方報導點名的 75 家廠商，我們的名冊只命中 22 家，缺的包含 3M、SGS、
 * TÜV 萊茵、威高、微創醫療、大族雷射、發那科這種不可能沒參展的大廠。
 *
 * 原因在 exhibitors.json 自己的註記裡：「585 家取自 1430 筆產品資料去重後的
 * 廠商數」——當初是從「產品清單」反推廠商，所以沒有登產品資料的展商整家漏掉。
 * 這不只是資料舊了，是匯入來源本身就是有損的，得換成直接抓「展商列表」。
 *
 * ── 為什麼是瀏覽器腳本，而不是我直接抓 ──────────────────────
 * AI 這邊的執行環境有網路白名單，exhibitors.informamarkets-info.com 被擋住
 * （EGRESS_BLOCKED），連不上。但你的瀏覽器連得上，而且已經帶著登入狀態。
 * 這跟 scrape_exhibitor_photos.js 當初抓大頭照是同一招，也同樣不用花任何錢
 * ——網路上那些「展商名錄」是第三方在賣的，官方目錄本身是公開的。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 瀏覽器打開官方展商目錄：
 *      https://exhibitors.informamarkets-info.com/event/2026Medtec
 *   2. F12 → Console，貼上這整個檔案，按 Enter
 *   3. 它會自己捲動頁面、翻頁，把載入的展商資料收集起來
 *      進度隨時可打：__medtecList.status()
 *   4. 看到「已收集 XXXX 家、連續 N 輪沒有新資料」就可以：
 *         __medtecList.download()      → 下載 exhibitor_list.csv（給匯入用）
 *         __medtecList.downloadJson()  → 下載原始 JSON（保底，欄位沒對到時我自己轉）
 *   5. 把下載到的檔案傳回來
 *
 *   ⚠ 如果跑完 status() 顯示 0 家，代表這個網站改版了、自動偵測沒認出來。
 *      這時候請改打 __medtecList.report()，把它印出來的內容整段複製給我，
 *      我看了實際的 API 長相就能改成對應的寫法。不要自己硬猜。
 */
(function () {
  "use strict";

  const CAPTURED = [];        // 攔到的原始 JSON 回應（給 report() 診斷用）
  const RECORDS = new Map();  // 去重後的展商，key = 目錄網址或名稱
  let idleRounds = 0;

  // ── 1. 攔截頁面自己發出的請求 ──────────────────────────────
  // 這個目錄是前端動態載入的，HTML 原始碼裡沒有展商資料，必須攔它的 API 回應。
  // 不猜端點網址（猜錯就整支失效），改成頁面呼叫什麼就收什麼，再從回應內容
  // 認出哪些是展商——網站改版時比較不會整支報廢。
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (res.headers.get("content-type")?.includes("json")) {
        res.clone().json().then((data) => absorb(url, data)).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const ct = this.getResponseHeader("content-type") || "";
        if (ct.includes("json")) absorb(this.__url, JSON.parse(this.responseText));
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  // ── 2. 從任意 JSON 裡認出展商紀錄 ──────────────────────────
  // 判斷依據刻意寬鬆：只要物件有「像名稱的欄位」，而且整包裡有一批同構的物件，
  // 就當成候選。寧可多收一點雜訊（下載前會過濾掉沒有名稱的），也不要因為欄位
  // 名跟預期差一個字就整批漏掉。
  const NAME_KEYS = ["name", "companyName", "exhibitorName", "title", "displayName", "company"];
  const BOOTH_KEYS = ["booth", "boothNo", "boothNumber", "stand", "standNumber", "standNo", "location"];

  function pick(obj, keys) {
    for (const k of Object.keys(obj || {})) {
      if (keys.some((c) => k.toLowerCase() === c.toLowerCase())) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
    }
    return "";
  }

  function looksLikeExhibitor(o) {
    return o && typeof o === "object" && !Array.isArray(o) && !!pick(o, NAME_KEYS);
  }

  function absorb(url, data) {
    CAPTURED.push({ url, sample: data });
    if (CAPTURED.length > 60) CAPTURED.shift();
    walk(data);
  }

  function walk(node, depth = 0) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      const hits = node.filter(looksLikeExhibitor);
      // 至少 3 筆同構物件才當成「一批展商」，避免把設定檔之類的東西誤收
      if (hits.length >= 3) hits.forEach(store);
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (typeof node === "object") Object.values(node).forEach((v) => walk(v, depth + 1));
  }

  function store(o) {
    const name = pick(o, NAME_KEYS);
    if (!name) return;
    // 目錄網址是最穩的識別依據；沒有就退回用名稱，至少不會同一家收兩次
    const href = findUrl(o);
    const key = href || name;
    if (RECORDS.has(key)) return;
    RECORDS.set(key, {
      name,
      booth_no: pick(o, BOOTH_KEYS),
      country: pick(o, ["country", "countryName", "nation"]),
      hall: pick(o, ["hall", "hallName", "pavilion"]),
      website: pick(o, ["website", "url", "webSite", "homepage"]),
      description: pick(o, ["description", "profile", "about", "summary", "shortDescription"]),
      directory_url: href,
      __raw: o,
    });
    idleRounds = 0;
  }

  function findUrl(o) {
    for (const [k, v] of Object.entries(o || {})) {
      if (typeof v !== "string") continue;
      if (/exhibitor|detail|profile|slug|link|href/i.test(k) && v.length > 3) {
        if (/^https?:/.test(v)) return v;
        if (v.startsWith("/")) return location.origin + v;
      }
    }
    return "";
  }

  // ── 3. 自動捲動 + 翻頁，把整份名單逼出來 ────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clickNext() {
    const sels = [
      '[class*="load-more" i]', '[class*="loadmore" i]',
      'button[aria-label*="next" i]', 'a[aria-label*="next" i]',
      '[class*="pagination" i] [class*="next" i]',
    ];
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
    console.log("[medtec] 開始收集…可隨時打 __medtecList.status() 看進度");
    while (idleRounds < 8) {
      const before = RECORDS.size;
      window.scrollTo(0, document.body.scrollHeight);
      clickNext();
      await sleep(1200);
      if (RECORDS.size === before) idleRounds++; else idleRounds = 0;
      if (RECORDS.size && RECORDS.size % 100 < 5) console.log(`[medtec] 已收集 ${RECORDS.size} 家…`);
    }
    running = false;
    console.log(`[medtec] 停止：連續 ${idleRounds} 輪沒有新資料。目前 ${RECORDS.size} 家。`);
    console.log("[medtec] 接著打 __medtecList.download() 下載 CSV");
    if (!RECORDS.size) console.warn("[medtec] 一家都沒收到 → 請打 __medtecList.report() 把結果貼回給我");
  }

  // ── 4. 匯出 ────────────────────────────────────────────
  const COLS = ["name_zh", "name_en", "booth_no", "hall", "country", "description", "website", "directory_url"];

  function toRows() {
    return [...RECORDS.values()].filter((r) => r.name).map((r) => ({
      // 中英文名這裡分不出來，一律先放 name_zh，匯入時我再依字元判斷分欄
      name_zh: r.name, name_en: "",
      booth_no: r.booth_no, hall: r.hall, country: r.country,
      description: r.description, website: r.website, directory_url: r.directory_url,
    }));
  }

  function csvCell(v) {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function save(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  }

  window.__medtecList = {
    run,
    status: () => {
      console.log(`已收集 ${RECORDS.size} 家；攔到 ${CAPTURED.length} 個 JSON 回應；連續 ${idleRounds} 輪無新增`);
      return RECORDS.size;
    },
    download: () => {
      const rows = toRows();
      if (!rows.length) return console.warn("沒有資料可下載，請先打 __medtecList.report()");
      const csv = [COLS.join(","), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(","))].join("\n");
      save("exhibitor_list.csv", "﻿" + csv, "text/csv;charset=utf-8");
      console.log(`已下載 ${rows.length} 家 → exhibitor_list.csv`);
    },
    downloadJson: () => {
      save("exhibitor_list_raw.json",
        JSON.stringify([...RECORDS.values()].map((r) => r.__raw), null, 2), "application/json");
    },
    // 自動偵測失敗時的診斷：印出攔到哪些網址、每個回應最外層長什麼樣子。
    // 把這段整個複製給我，我就能照實際格式改，不用瞎猜。
    report: () => {
      const out = CAPTURED.map((c) => ({
        url: c.url,
        topKeys: c.sample && typeof c.sample === "object" ? Object.keys(c.sample).slice(0, 15) : typeof c.sample,
        firstItem: (() => {
          const arr = JSON.stringify(c.sample || "").slice(0, 400);
          return arr;
        })(),
      }));
      console.log(JSON.stringify(out, null, 2));
      return out;
    },
  };

  run();
})();
