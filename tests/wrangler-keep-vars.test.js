/**
 * 每個 Worker 的 wrangler 設定都必須有 keep_vars: true。
 *
 * 2026-08-01：MCP 連接器突然連不上，回
 *   {"error":"尚未設定 MCP_PIN：請至 Worker Settings → Variables and Secrets 新增"}
 * 原因是 mcp/wrangler.jsonc 沒有 keep_vars——wrangler deploy 預設會把
 * Dashboard 上設定的變數與 Secret 一併清掉。合併幾個 PR 觸發自動部署之後，
 * MCP_PIN 就這樣消失，端點 fail-closed 變成全部 401。
 *
 * 這個失敗特別難查：從連接器那端只看得到「需要重新授權／token 過期」，
 * 完全看不出是伺服器端的 Secret 不見了；而且 Secret 的值只有本人知道，
 * 不會有任何自動化能把它補回來。fieldlog 早就有這一行（註解也寫明原因），
 * 另外兩個沒跟上——這條測試就是不讓它們再漏掉。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// 這三個都是實際部署中的 Worker，各自綁著只有 Dashboard 上才有的 Secret：
//   fieldlog   FIELD_PIN
//   medapi-mcp MCP_PIN、FIELD_PIN
//   medtec2026 TEAM_PIN、LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET
const CONFIGS = ["fieldlog", "mcp", "cloudflare"];

// jsonc → json：註解在這份設定裡很多，不能直接 JSON.parse
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, "");
}

for (const dir of CONFIGS) {
  test(`${dir}/wrangler.jsonc 有 keep_vars: true（否則部署會清掉 Dashboard 的 Secret）`, async () => {
    const raw = await readFile(new URL(`../${dir}/wrangler.jsonc`, import.meta.url), "utf8");
    const config = JSON.parse(stripJsonComments(raw));
    assert.equal(config.keep_vars, true,
      `${dir} 少了 keep_vars，下次部署會把 Dashboard 上的 Secret 清掉，而那些值只有本人知道、補不回來`);
  });
}
