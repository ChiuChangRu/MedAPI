/**
 * LitDB → MCP 整合測試。
 *
 * LitDB（chiuchangru/litdb）是長儒另一個獨立 repo，純靜態網站＋GitHub Pages
 * 公開 JSON，沒有自己的後端。這裡不搬資料、不建 D1 表：查詢當下直接 fetch
 * 那幾個公開網址，litdb 那邊之後照樣更新，MCP 這邊永遠讀得到最新版。
 * 用假的 global.fetch 模擬 GitHub Pages 回應，驗證三支工具的實際行為。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";
import { resetLitdbCacheForTests } from "../mcp/src/litdb.js";

function fakePaper(overrides = {}) {
  return {
    id: "P01", title: "示範論文", authors: "作者", year: "2024", venue: "期刊",
    doi: null, pmid: null, doc_type: "期刊論文", access: "開放摘要",
    tags: ["TPU", "親水塗層"], purpose: "測試用", abstract_note: "這是摘要全文",
    value_to_project: "對專案的價值", links: { doi: "https://doi.org/x" },
    ...overrides,
  };
}

function stubFetch(byUrl) {
  resetLitdbCacheForTests(); // 每個測試案例各自控制回應，不被上一個測試的快取影響
  globalThis.fetch = async (url) => {
    const match = Object.entries(byUrl).find(([key]) => String(url).includes(key));
    if (!match) return { ok: false, status: 404 };
    const [, respond] = match;
    if (respond instanceof Error) throw respond;
    if (respond.status && respond.status !== 200) return { ok: false, status: respond.status };
    return { ok: true, json: async () => respond };
  };
}

async function callTool(name, args) {
  const req = new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin" });
  const body = await res.json();
  return body.result;
}

test("list_litdb_collections 列出三個收藏的範圍與筆數", async () => {
  stubFetch({
    "coating/papers.json": { meta: { scope: "塗層範圍", stats: { total: 2, patents: 1 }, last_updated: "2026-06-14" }, papers: [fakePaper(), fakePaper({ id: "P02" })] },
    "biopsy_patents.json": { meta: { scope: "活檢針範圍", stats: { total: 1 }, last_updated: "2026-06-23" }, papers: [fakePaper({ id: "B01" })] },
    "packaging/papers.json": { meta: { scope: "包裝範圍", stats: { total: 0 } }, papers: [] },
  });
  const result = await callTool("list_litdb_collections", {});
  const text = result.content[0].text;
  assert.match(text, /共 2 筆/);
  assert.match(text, /塗層範圍/);
  assert.match(text, /共 1 筆/);
  assert.match(text, /活檢針範圍/);
});

test("list_litdb_collections 單一收藏讀取失敗時，其他收藏仍正常顯示", async () => {
  stubFetch({
    "coating/papers.json": { meta: { scope: "塗層範圍" }, papers: [fakePaper()] },
    "biopsy_patents.json": { status: 500 },
    "packaging/papers.json": { meta: { scope: "包裝範圍" }, papers: [] },
  });
  const result = await callTool("list_litdb_collections", {});
  const text = result.content[0].text;
  assert.match(text, /塗層範圍/, "coating 沒受影響");
  assert.match(text, /讀取失敗/, "biopsy 要標示失敗");
  assert.match(text, /包裝範圍/, "packaging 沒受影響");
});

test("search_litdb 跨收藏搜尋，命中會標示 [collection/id]", async () => {
  stubFetch({
    "coating/papers.json": { meta: {}, papers: [fakePaper({ id: "P01", title: "親水塗層配方" })] },
    "biopsy_patents.json": { meta: {}, papers: [fakePaper({ id: "B01", title: "活檢針擊發機構", tags: ["彈簧"] })] },
    "packaging/papers.json": { meta: {}, papers: [] },
  });
  const result = await callTool("search_litdb", { query: "親水塗層" });
  const text = result.content[0].text;
  assert.match(text, /\[coating\/P01\]/);
  assert.doesNotMatch(text, /\[biopsy\/B01\]/, "不相關的不該命中");
});

test("search_litdb 可用 collection 縮小範圍", async () => {
  stubFetch({
    "coating/papers.json": { meta: {}, papers: [fakePaper({ id: "P01", title: "導管相關配方" })] },
    "biopsy_patents.json": { meta: {}, papers: [fakePaper({ id: "B01", title: "導管型活檢針" })] },
    "packaging/papers.json": { meta: {}, papers: [] },
  });
  const result = await callTool("search_litdb", { query: "導管", collection: "coating" });
  const text = result.content[0].text;
  assert.match(text, /\[coating\/P01\]/);
  assert.doesNotMatch(text, /\[biopsy\/B01\]/, "限定 collection 後不該跨收藏命中");
});

test("search_litdb 查無結果時誠實回報（沿用共用比對層的訊息格式）", async () => {
  stubFetch({
    "coating/papers.json": { meta: {}, papers: [fakePaper({ title: "無關內容" })] },
    "biopsy_patents.json": { meta: {}, papers: [] },
    "packaging/papers.json": { meta: {}, papers: [] },
  });
  const result = await callTool("search_litdb", { query: "香蕉" });
  assert.match(result.content[0].text, /LitDB裡沒有|LitDB 裡沒有/);
});

test("get_litdb_paper 讀取完整內容：摘要、價值評估、連結都要在", async () => {
  stubFetch({
    "coating/papers.json": {
      meta: {},
      papers: [fakePaper({
        id: "P01", title: "完整測試論文", abstract_note: "完整摘要內容",
        value_to_project: "很有價值", patentResults: { full: { summary: "專利分析摘要內容" } },
        links: { patents: "https://patents.example/x" },
      })],
    },
  });
  const result = await callTool("get_litdb_paper", { collection: "coating", id: "P01" });
  const text = result.content[0].text;
  assert.match(text, /完整測試論文/);
  assert.match(text, /完整摘要內容/);
  assert.match(text, /很有價值/);
  assert.match(text, /專利分析摘要內容/);
  assert.match(text, /https:\/\/patents\.example\/x/);
});

test("get_litdb_paper 找不到 id 時報錯，不是回空白內容", async () => {
  stubFetch({ "coating/papers.json": { meta: {}, papers: [fakePaper({ id: "P01" })] } });
  const result = await callTool("get_litdb_paper", { collection: "coating", id: "P99" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /找不到 P99/);
});

test("get_litdb_paper 缺參數時報錯", async () => {
  const result = await callTool("get_litdb_paper", { collection: "coating" });
  assert.equal(result.isError, true);
});

test("litdb 資料是即時 fetch 的，不是搬進 D1／寫死在程式碼裡", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../mcp/src/litdb.js", import.meta.url), "utf8"
  );
  assert.match(source, /await fetch\(/, "要有實際的外部 fetch");
  assert.doesNotMatch(source, /CREATE TABLE/i, "不該建 D1 表");
  assert.match(source, /chiuchangru\.github\.io\/litdb/, "來源要是 litdb 的公開網址");
});
