/**
 * 診斷工具：檢查展商「清單頁」的原始碼裡，有沒有把全部展商資料直接內嵌
 * 在某個 <script> 裡（而不是額外發一次 API 請求才拿到）。
 *
 * ── 為什麼要查這個 ──────────────────────────────────────────
 * downloadCaptured() 已經確認攔截器本身有正常運作（fetch／XHR 都補了），
 * 但完全沒攔到任何東西，即使 run() 已經成功收集到全部 881 家。合理解釋：
 * 這個清單工具很可能在「頁面剛載入時」就用一次請求把全部資料拿到手，
 * 存進 JS 變數裡，之後「顯示全部」只是用瀏覽器裡已經有的資料重新排版，
 * 不會再發新請求——不管攔截器多完整都攔不到，因為根本沒有第二次請求。
 *
 * 如果是這樣，資料應該就直接寫在頁面原始碼的某個 <script> 標籤裡（常見
 * 寫法：var tableData = [...900 筆...];）。用 fetch() 抓一次原始碼，
 * 搜尋 "StandNoStr" 這個關鍵字（診斷詳情頁時洩漏的欄位名稱），看看是不是
 * 真的有一大包資料跟著頁面一起送過來。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   1. 打開展商清單頁：https://exhibitors.informamarkets-info.com/event/2026Medtec
 *   2. F12 → Console，貼上這整個檔案，按 Enter
 *   3. 把印出來的結果整段複製貼回給我
 */
(function () {
  "use strict";

  (async () => {
    const url = location.href;
    let html;
    try {
      const res = await fetch(url, { credentials: "include" });
      html = await res.text();
    } catch (e) {
      console.log(JSON.stringify({ 錯誤: String(e) }, null, 2));
      return;
    }

    const hit = html.indexOf("StandNoStr");
    const out = {
      目前網址: url,
      頁面原始碼總長度: html.length,
      找到StandNoStr字樣: hit >= 0,
    };

    if (hit >= 0) {
      // 找到的話，往前後各抓一段，看看是「資料」（一堆逗號分隔的欄位值）
      // 還是只是「函式邏輯」（跟展商詳情頁那次一樣，只是程式碼提到這個名字）
      out.第一次出現位置附近的原始碼 = html.slice(Math.max(0, hit - 200), hit + 800);
      // 統計出現次數：出現次數接近展商家數（例如 800~900 次）代表真的是
      // 逐筆資料；只出現個位數次數代表只是程式碼裡提到，不是資料本身
      let count = 0, idx = 0;
      while ((idx = html.indexOf("StandNoStr", idx)) !== -1) { count++; idx += 1; }
      out.StandNoStr出現總次數 = count;
    }

    // 找看看有沒有明顯的「巨大陣列/物件」內嵌在 <script> 裡（超過 5 萬字元
    // 的單一 script 內容很可能就是資料本體，不是一般的邏輯程式碼）
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1])
      .filter((s) => s.length > 20000);
    out.超過5萬字元的內嵌script數量 = scripts.length;
    out.這些script的長度 = scripts.map((s) => s.length);

    console.log(JSON.stringify(out, null, 2));
    console.log("[medtec] 請把上面這段 JSON 整段複製貼回給我（如果「第一次出現位置附近的原始碼」很長，全部複製沒關係）");
  })();
})();
