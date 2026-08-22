/**
 * 巡廠頁面（Jeremy 功能規格書，2026-08-09）：截圖 OCR → LLM 整理成固定格式的
 * 巡廠紀錄。檢查原始碼裡的關鍵接線在不在，不用真的打 Anthropic API
 * （跟其他 fieldlog UI／後端測試同一套做法）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("patrol.js：固定格式範本原封不動存成 few-shot，system prompt 涵蓋三條資料完整性規則", async () => {
  const lib = await read("../fieldlog/src/lib/patrol.js");
  assert.match(lib, /export const PATROL_MODEL = "claude-sonnet-5";/);
  // 範本裡幾個格式上容易被「順手修正」掉的細節，逐條檢查沒被改動
  assert.match(lib, /\*龍德廠巡廠紀錄2026年08月08日\(星期六\)\*/);
  assert.match(lib, /『今日未安排加班』/);
  assert.match(lib, /『今日生產狀況正常』/);
  assert.match(lib, /    生管課：賴嘉雯、俞美蘭/); // 4 個全形空白縮排
  assert.match(lib, /數量合計：42,621 set/);
  assert.match(lib, /禁止腦補/);
  assert.match(lib, /多廠拆分/);
  assert.match(lib, /表格數字精確度/);
});

test("patrol.js：formatPatrolReport 沒設 ANTHROPIC_API_KEY 時明確報錯，不是靜默失敗", async () => {
  const { formatPatrolReport } = await import("../fieldlog/src/lib/patrol.js");
  await assert.rejects(
    () => formatPatrolReport({}, [{ index: 0, filename: "a.jpg", text: "test" }]),
    /ANTHROPIC_API_KEY/
  );
});

test("patrol.js：ensurePatrolFolder 找不到就用 category=admin、type=巡廠建立", async () => {
  const lib = await read("../fieldlog/src/lib/patrol.js");
  const fn = lib.match(/export async function ensurePatrolFolder\(db, timestamp\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /行政｜巡廠/);
  assert.match(fn, /VALUES \(\?, '巡廠', 'admin', NULL, \?\)/);
});

test("worker.js：/patrol/ocr、/patrol/format、/patrol/folder 三支端點都接上了", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  assert.match(worker, /import \{ ensurePatrolFolder, formatPatrolReport \} from "\.\/lib\/patrol\.js";/);
  assert.match(worker, /path === "\/patrol\/ocr" && method === "POST"/);
  assert.match(worker, /path === "\/patrol\/format" && method === "POST"/);
  assert.match(worker, /path === "\/patrol\/folder" && method === "GET"/);
  // 存檔沿用既有端點，不是另開一支
  assert.doesNotMatch(worker, /\/patrol\/save/);
});

test("schema.js：ensurePatrolCategory 一次性補上「巡廠」folder_type 分類，且掛進 ensureSchema()", async () => {
  const schema = await read("../fieldlog/src/lib/schema.js");
  assert.match(schema, /export async function ensurePatrolCategory\(db, timestamp\)/);
  assert.match(schema, /_patrol_category_2026_08_09/);
  assert.match(schema, /'folder_type', 0, '巡廠'/);
  const ensureSchemaFn = schema.match(/export async function ensureSchema\(db, timestamp\)[\s\S]*?\n\}/)[0];
  assert.match(ensureSchemaFn, /ensurePatrolCategory\(db, timestamp\)/);
});

test("patrol.html：存在且接線到 /api/patrol/ocr、/api/patrol/format、/api/patrol/folder、/api/entries、/api/upload", async () => {
  const html = await read("../fieldlog/public/patrol.html");
  assert.match(html, /uploadRaw\("\/patrol\/ocr", img\.file\)/);
  assert.match(html, /api\("\/patrol\/format"/);
  assert.match(html, /api\("\/patrol\/folder"\)/);
  assert.match(html, /api\("\/entries", \{/);
  assert.match(html, /uploadRaw\("\/upload", img\.file/);
  // 拖曳排序、可刪除單張、複製、存檔都要有
  assert.match(html, /draggable="true"/);
  assert.match(html, /class="del"/);
  assert.match(html, /navigator\.clipboard\.writeText/);
});

test("index.html／sw.js：首頁有連到巡廠頁面，service worker 有預快取這個新頁面", async () => {
  const index = await read("../fieldlog/public/index.html");
  assert.match(index, /href="patrol\.html"/);
  const sw = await read("../fieldlog/public/sw.js");
  assert.match(sw, /"patrol\.html"/);
});
