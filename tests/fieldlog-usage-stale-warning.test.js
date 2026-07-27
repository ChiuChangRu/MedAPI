/**
 * 首頁「Cloudflare 用量」面板：AI 額度那三條的「已停止自動轉錄」等斷言，
 * 只能在資料真的是「今天」的時候講。
 *
 * 2026-07-27 使用者回報：面板連續四天顯示「今日自動安全額度 7,000/7,000
 * 已停止自動轉錄」，一路追下去發現這是「當天」帳單資料本身超標（跟前面修的
 * 「單段轉錄失敗拖垮整批」是兩個獨立問題），但同時也發現一個標示上的誤導：
 * Cloudflare 帳單本來就有 1 天以上的回報延遲，畫面卻寫「① 今日」，而後端
 * 判斷是否要暫停時，只認「日期正好等於今天」的數字，差一天就當作 0
 * （worker.js 的 cloudUsed = aiLimit?.label.includes(today) ? aiLimit.used
 * : 0）。也就是說面板講「已停止自動轉錄」的當下，很可能根本不是今天的事，
 * 前端跟後端對「今天」的認定不一致，容易誤導使用者。
 *
 * renderAiUsage() 是純函式（只依賴 esc／fmtUsageNumber，不碰 DOM），
 * 抽出來直接執行驗證真正的渲染結果，而不是只比對原始碼字串。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRenderAiUsage() {
  const src = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const extract = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 function ${name}`);
    // 用大括號配對抓出完整函式本體，比抓到下一個 "function " 字串更穩，
    // 不會被函式內文出現的 "function" 字樣（例如 renderAiUsage 內的 bar
    // 是箭頭函式，不受影響，但保守起見還是用配對而不是找下一個關鍵字）
    let depth = 0;
    let i = src.indexOf("{", start);
    const bodyStart = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  };
  const code = `${extract("esc")}\n${extract("fmtUsageNumber")}\n${extract("renderAiUsage")}\nglobalThis.__renderAiUsage = renderAiUsage;`;
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return context.__renderAiUsage;
}

function baseItem(overrides = {}) {
  return {
    label: "Workers AI Neurons（2026-07-26）",
    used: 7109, limit: 10000, safeLimit: 7000,
    monthlyPaidCost: 0.02, softBudget: 4.5, hardBudget: 5,
    gatewayConfigured: true, dataLagDays: 1,
    ...overrides,
  };
}

test("資料落後（dataLagDays > 0）時，不斷言『已停止自動轉錄』／『已進入按量計費』——只給誠實的落後提示", async () => {
  const renderAiUsage = await loadRenderAiUsage();
  // 對應使用者實際回報的數字：7,109 / 7,000，已經超過安全門檻，但資料是
  // 昨天的（dataLagDays: 1），後端不會拿這個數字擋今天，前端也不該講得像今天已經被擋
  const html = renderAiUsage(baseItem(), 1);
  assert.doesNotMatch(html, /已停止自動轉錄/, "資料不是今天的，不能斷言今天已經被擋");
  assert.doesNotMatch(html, /今日已進入按量計費/);
  assert.match(html, /這是 1 天前的數字/, "要誠實講這是幾天前的舊數字");
  assert.match(html, /不代表今天已經被擋/);
});

test("資料是今天的（dataLagDays === 0）時，超過門檻才照常斷言『已停止自動轉錄』", async () => {
  const renderAiUsage = await loadRenderAiUsage();
  // used 同時超過安全門檻（7,000）與免費額度（10,000），兩句斷言才都會出現
  const html = renderAiUsage(baseItem({ dataLagDays: 0, used: 10500 }), 0);
  assert.match(html, /今日已停止自動轉錄/, "資料確定是今天、且真的超標，這時候講『已停止』才正確");
  assert.match(html, /今日已進入按量計費/);
  assert.doesNotMatch(html, /這是 \d+ 天前的數字/);
});

test("資料是今天的、但還沒超過門檻時，維持原本的正常提示（不會被這次修改誤觸發）", async () => {
  const renderAiUsage = await loadRenderAiUsage();
  // used 要選在會顯示個別列的範圍（rows 只顯示佔比 >= 10% 的項目，
  // 見 renderAiUsage 的 visible 過濾），太低會直接被收成「三項額度都低於 10%」
  const html = renderAiUsage(baseItem({ dataLagDays: 0, used: 1500 }), 0);
  assert.match(html, /70% 安全門檻/);
  assert.match(html, /每日 00:00 UTC 重置/);
  assert.doesNotMatch(html, /已停止自動轉錄/);
  assert.doesNotMatch(html, /不代表今天已經被擋/);
});

test("完全沒有帳單資料（dataLagDays 是 null）時，講『尚無資料』，不會顯示成『0 天前』", async () => {
  const renderAiUsage = await loadRenderAiUsage();
  const html = renderAiUsage(baseItem({ dataLagDays: null, used: 1500 }), null);
  assert.match(html, /尚無帳單資料可判斷/);
  assert.doesNotMatch(html, /0 天前的數字/, "null 不該被當成『剛好 0 天前』顯示");
});

test("isLive 用嚴格比較（=== 0），不會把 null 誤判成今天（Number(null) 會是 0，這是容易踩到的坑）", async () => {
  const src = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const fn = src.match(/function renderAiUsage\(item, overallLagDays\)[\s\S]*?\n}/)[0];
  assert.match(fn, /item\.dataLagDays === 0/, "要用嚴格比較，Number(item.dataLagDays) === 0 會把 null 也算進去");
});
