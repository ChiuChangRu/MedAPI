/**
 * 搜尋回歸測試——對應《MyWiki 搜尋功能改善規格書 v2》第四節的全部案例。
 *
 * 案例編號沿用規格書：
 *   R1–R5  不得退化（修復前就正常的查詢，修復後結果不能變少）
 *   M1–M6  多詞查詢（空白斷詞，修復前全部失效）
 *   S1–S6  同義詞展開（慣用語查得到正式標準名）
 *   N1–N4  靜默失敗防護（查無結果時要說出試過哪些詞）
 *   X1–X2  負向測試（不得因展開過度而誤命中）
 *
 * 測的是 search.js 這一層——五個 search_* 工具全部共用它，所以這裡通過
 * 就等於五個工具的比對行為都通過。工具層另有一個結構性測試（見最後一段）
 * 確保沒有人把舊的「整串 includes」比對法加回去。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { foldText } from "../mcp/src/textFold.js";
import {
  buildPlan,
  tokenizeQuery,
  runSearch,
  isDegraded,
  scoreText,
  planSnippet,
  noHitMessage,
  expansionNote,
} from "../mcp/src/search.js";

// ---------- 測試用語料：照實際資料庫的長相做（檔名是主要可搜文字）----------

const CORPUS = [
  // ISO 7886 系列——規格書實測 `7886`／`注射器` 命中的那一批
  { id: 101, kind: "pdf", text: "ISO_7886-1_2017_無菌皮下注射器-第1部_手動使用注射器.pdf" },
  { id: 102, kind: "pdf", text: "ISO_7886-2_2020_無菌皮下注射器-第2部_動力驅動注射泵用注射器.pdf" },
  { id: 103, kind: "pdf", text: "ISO_7886-3_2020_無菌皮下注射器-第3部_固定劑量免疫用自毀式注射器.pdf" },
  { id: 104, kind: "pdf", text: "ISO_7886-4_2018_無菌皮下注射器-第4部_具防止重複使用功能的注射器.pdf" },
  // ISO 10555 系列
  { id: 110, kind: "pdf", text: "ISO_10555-1_2013_血管內導管-無菌及單次使用導管-第1部_一般要求.pdf" },
  {
    id: 111,
    kind: "pdf",
    text:
      "ISO_10555-8_2024_血管內導管-無菌及單次使用導管-第8部_體外血液處理用導管.pdf\n" +
      "本部分規定體外血液處理用導管的試驗方法與標示要求。",
  },
  // 生物相容性
  { id: 120, kind: "pdf", text: "ISO_10993-4_2017_醫療器材生物性評估-第4部_與血液交互作用試驗選擇.pdf" },
  // 現場錄音（規格書 R5 提到的 entry 23）
  { id: 23, kind: "audio", text: "現場錄音逐字稿：客戶想確認注射針筒的內塞材質與滑動阻力。" },
  // 一筆含「針頭」與「測試」的產線紀錄
  { id: 130, kind: "note", text: "生產線針頭測試紀錄：抽樣 30 支，量測針尖銳利度。" },
  // 簡體型錄（測簡繁互通沒被破壞）
  { id: 140, kind: "pdf", text: "供应商型录：亲水涂层导管，润滑性能测试报告。" },
];

const textOf = (row) => row.text;
const idsOf = (result) => result.hits.map((h) => h.row.id);

function search(query, rows = CORPUS) {
  const plan = buildPlan(query);
  return { plan, ...runSearch(rows, plan, textOf) };
}

// 修復前的比對法：把整個查詢字當一整串做摺疊子字串比對。
// 用它算出「修復前會命中什麼」，據此斷言修復後一筆都沒少（R1–R5 的真正含意）。
function legacyMatchedIds(query, rows = CORPUS) {
  const fq = foldText(query);
  return rows.filter((row) => foldText(textOf(row)).includes(fq)).map((row) => row.id);
}

function assertNoRegression(query) {
  const before = legacyMatchedIds(query);
  const after = idsOf(search(query));
  for (const id of before) {
    assert.ok(after.includes(id), `${query}：修復前命中的 ${id} 在修復後消失了`);
  }
  return { before, after };
}

// ---------- 斷詞本身 ----------

test("斷詞：半形空白、連續空白、tab、全形空白都算分隔", () => {
  assert.deepEqual(tokenizeQuery("7886 注射器"), ["7886", "注射器"]);
  assert.deepEqual(tokenizeQuery("7886    注射器"), ["7886", "注射器"]);
  assert.deepEqual(tokenizeQuery("7886\t注射器"), ["7886", "注射器"]);
  assert.deepEqual(tokenizeQuery("7886　注射器"), ["7886", "注射器"]); // U+3000 全形空白
  assert.deepEqual(tokenizeQuery("  無菌  針筒  驗證 "), ["無菌", "針筒", "驗證"]);
});

test("斷詞：中文不含空白時維持整串，不做字元切分", () => {
  assert.deepEqual(tokenizeQuery("無菌皮下注射器"), ["無菌皮下注射器"]);
  assert.equal(buildPlan("無菌皮下注射器").tokens.length, 1);
});

// ---------- R1–R5：不得退化 ----------

test("R1 `7886` 單詞查詢結果不退化", () => {
  const { before, after } = assertNoRegression("7886");
  assert.ok(before.length >= 4, "測試語料本身要有 7886 系列");
  // 原詞命中的排在展開命中前面
  const origFirst = search("7886").hits.findIndex((h) => h.origHits === 0);
  const lastOrig = search("7886").hits.reduce((acc, h, i) => (h.origHits > 0 ? i : acc), -1);
  if (origFirst >= 0) assert.ok(origFirst > lastOrig, "展開命中不該插到原詞命中前面");
  assert.ok(after.length >= before.length);
});

test("R2 `10555` 單詞查詢結果不退化", () => {
  const { before, after } = assertNoRegression("10555");
  assert.ok(before.includes(110) && before.includes(111));
  assert.ok(after.includes(110) && after.includes(111));
});

test("R3 `注射器` 單詞查詢結果不退化", () => {
  assertNoRegression("注射器");
});

test("R4 `無菌皮下注射器` 連續字串查詢結果不退化", () => {
  const { before, after } = assertNoRegression("無菌皮下注射器");
  assert.ok(before.length >= 4);
  assert.ok(after.length >= before.length);
});

test("R5 `注射針筒` 至少維持，且原本命中的錄音排在最前", () => {
  assertNoRegression("注射針筒");
  const ids = idsOf(search("注射針筒"));
  assert.equal(ids[0], 23, "原詞命中的錄音要排第一");
  assert.ok(ids.includes(101), "展開後應追加 ISO 7886 系列");
});

test("不在同義詞表裡的詞，行為與修復前完全一致", () => {
  const plan = buildPlan("聚氨酯");
  assert.equal(plan.hasExpansion, false);
  assert.deepEqual(idsOf(search("聚氨酯")), legacyMatchedIds("聚氨酯"));
});

test("簡繁互通沒被破壞", () => {
  assert.ok(idsOf(search("親水塗層")).includes(140), "繁體查得到簡體庫");
  assert.ok(idsOf(search("亲水涂层")).includes(140));
});

// ---------- M1–M6：多詞查詢（修復前全部失效）----------

test("M1 `7886 注射器` 必須命中 ISO 7886 系列", () => {
  assert.deepEqual(legacyMatchedIds("7886 注射器"), [], "修復前應為查無（bug 重現）");
  const ids = idsOf(search("7886 注射器"));
  assert.ok(ids.includes(101) && ids.includes(102), `實得 ${ids}`);
});

test("M2 `7886 無菌皮下注射器` 必須命中 ISO 7886 系列", () => {
  assert.deepEqual(legacyMatchedIds("7886 無菌皮下注射器"), []);
  const ids = idsOf(search("7886 無菌皮下注射器"));
  assert.ok(ids.includes(101));
});

test("M3 `針頭 驗證` 有結果（針頭＋測試 同時命中）", () => {
  assert.deepEqual(legacyMatchedIds("針頭 驗證"), []);
  const result = search("針頭 驗證");
  assert.ok(idsOf(result).includes(130), `實得 ${idsOf(result)}`);
  assert.equal(isDegraded(result), false, "130 同時含針頭與測試，屬全詞命中不該降級");
});

test("M4 `無菌 針筒 驗證` 三詞查詢有結果", () => {
  assert.deepEqual(legacyMatchedIds("無菌 針筒 驗證"), []);
  const result = search("無菌 針筒 驗證");
  assert.ok(result.hits.length > 0, "至少要有部分符合的結果");
});

test("M5 `HD管 驗證` 必須命中 ISO 10555-8（靠同義詞展開）", () => {
  assert.deepEqual(legacyMatchedIds("HD管 驗證"), []);
  const ids = idsOf(search("HD管 驗證"));
  assert.ok(ids.includes(111), `實得 ${ids}`);
});

test("M6 `10555 導管` 必須命中 ISO 10555 系列", () => {
  const ids = idsOf(search("10555 導管"));
  assert.ok(ids.includes(110) && ids.includes(111), `實得 ${ids}`);
});

test("AND 掛零時降級為 OR，並標示為部分符合", () => {
  // 「聚氨酯」語料裡完全沒有，與「注射器」湊成必然 AND 掛零的兩詞查詢
  const result = search("注射器 聚氨酯");
  assert.ok(result.hits.length > 0, "降級後要給出部分符合的結果");
  assert.equal(isDegraded(result), true);
  assert.equal(result.fullMatches, 0);
});

test("AND 有結果時不降級，也不混入只符合部分詞的結果", () => {
  const result = search("10555 導管");
  assert.equal(isDegraded(result), false);
  for (const hit of result.hits) assert.equal(hit.anyHits, 2, "只該留全詞命中");
});

test("命中詞元數多的排在前面", () => {
  const result = search("注射器 聚氨酯 針筒");
  const scores = result.hits.map((h) => h.origHits * 1000 + h.anyHits);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted);
});

// ---------- S1–S6：同義詞展開 ----------

test("S1 `針筒` 必須命中 ISO 7886 系列", () => {
  const ids = idsOf(search("針筒"));
  assert.ok(ids.includes(101), `實得 ${ids}`);
});

test("S2 `血液透析導管` 必須命中 ISO 10555-8", () => {
  assert.deepEqual(legacyMatchedIds("血液透析導管"), [], "修復前應為查無");
  assert.ok(idsOf(search("血液透析導管")).includes(111));
});

test("S3 `HD管` 必須命中 ISO 10555-8", () => {
  assert.deepEqual(legacyMatchedIds("HD管"), []);
  assert.ok(idsOf(search("HD管")).includes(111));
});

test("S4 `syringe` 跨語言命中 ISO 7886 系列", () => {
  assert.deepEqual(legacyMatchedIds("syringe"), []);
  assert.ok(idsOf(search("syringe")).includes(101));
});

test("S5 `洗腎管` 必須命中 ISO 10555-8", () => {
  assert.deepEqual(legacyMatchedIds("洗腎管"), []);
  assert.ok(idsOf(search("洗腎管")).includes(111));
});

test("S6 `體外血液處理` 必須命中 ISO 10555-8", () => {
  assert.ok(idsOf(search("體外血液處理")).includes(111));
});

test("展開透明化：回應會說出實際展開了哪些詞", () => {
  const note = expansionNote(buildPlan("HD管"));
  assert.match(note, /同義詞已自動展開/);
  assert.match(note, /體外血液處理用導管/);
  assert.equal(expansionNote(buildPlan("聚氨酯")), "", "沒展開就不要多話");
});

test("同義詞組內互通，沒有方向性", () => {
  for (const q of ["HD管", "洗腎管", "透析導管", "hemodialysis catheter", "體外血液處理用導管"]) {
    assert.ok(idsOf(search(q)).includes(111), `${q} 應命中 111`);
  }
});

// ---------- N1–N4：靜默失敗防護 ----------

// 這一組要驗的是「查無結果時的回應品質」，所以用一份刻意不含相關內容的語料，
// 確保真的查無（規格書註明 ISO 9626 與生檢針資料尚未歸檔）
const BARE_CORPUS = [{ id: 900, kind: "pdf", text: "ISO_11607_2019_無菌屏障系統包裝.pdf" }];

function noHitFor(query) {
  const plan = buildPlan(query);
  const result = runSearch(BARE_CORPUS, plan, textOf);
  assert.equal(result.hits.length, 0, `${query} 在這份語料裡應為查無`);
  return noHitMessage("隨身記", plan);
}

test("N1 `不鏽鋼` 查無時要列出展開詞並建議針管／9626", () => {
  const msg = noHitFor("不鏽鋼");
  assert.match(msg, /同義詞展開後實際查了/);
  assert.match(msg, /不鏽鋼針管/);
  assert.match(msg, /針管/);
  assert.match(msg, /9626/);
  assert.match(msg, /資料庫中可能確實沒有/);
});

test("N2 `不鏽鋼針頭` 查無時同樣說明已嘗試的詞", () => {
  const msg = noHitFor("不鏽鋼針頭");
  assert.match(msg, /同義詞展開後實際查了/);
  assert.match(msg, /9626/);
});

test("N3 `生檢針` 查無時要說明已嘗試 biopsy needle／BT-SBNS／切片針", () => {
  const msg = noHitFor("生檢針");
  assert.match(msg, /軟組織切片針/);
  assert.match(msg, /biopsy needle/);
  assert.match(msg, /BT-SBNS/);
});

test("N4 `SBNS` 查無時同樣展開軟組織切片針那一組", () => {
  const msg = noHitFor("SBNS");
  assert.match(msg, /軟組織切片針/);
  assert.match(msg, /切片針/);
});

test("查無結果會明確區分「沒資料」與「沒查到」", () => {
  // 詞不在同義詞表：要提示可以自行補一組對照，而不是只回一句查無
  const msg = noHitFor("聚氨酯");
  assert.match(msg, /不在同義詞表中/);
  assert.match(msg, /synonyms\.json/);
  assert.doesNotMatch(msg, /同義詞展開後實際查了/);
});

test("多詞查無時會說出斷成哪幾個詞", () => {
  const msg = noHitFor("聚氨酯 甲基丙烯酸");
  assert.match(msg, /已斷詞為 2 個詞/);
  assert.match(msg, /聚氨酯、甲基丙烯酸/);
});

test("查無訊息可以附帶各工具自己的提醒", () => {
  const plan = buildPlan("聚氨酯");
  const msg = noHitMessage("附件內容", plan, "附件要先在前台跑過「Cloudflare AI 整理」才有可搜尋的文字。");
  assert.match(msg, /^附件內容裡沒有「聚氨酯」/);
  assert.match(msg, /Cloudflare AI 整理/);
});

// ---------- X1–X2：負向測試 ----------

test("X1 `香蕉` 正確回查無，不得因展開過度而誤命中", () => {
  const result = search("香蕉");
  assert.equal(result.hits.length, 0);
  assert.equal(buildPlan("香蕉").hasExpansion, false);
});

test("X2 範圍篩到空集合時回空、不報錯", () => {
  const plan = buildPlan("7886");
  const result = runSearch([], plan, textOf); // 模擬 folder_id=99 篩掉全部
  assert.equal(result.hits.length, 0);
  assert.equal(result.total, 0);
  assert.doesNotThrow(() => noHitMessage("隨身記", plan, "這次有限定資料夾範圍。"));
});

test("單字詞不做部分比對，避免展開到失去意義", () => {
  // 「針」是很多同義詞組成員的子字串，但單字只做完全相同比對 → 不展開
  assert.equal(buildPlan("針").hasExpansion, false);
  assert.equal(buildPlan("管").hasExpansion, false);
});

test("短數字編號只做完全相同比對，不誤命中較長的數字", () => {
  // Luer 那組 codes 有 "594"；"1594" 不該把它拉進來
  assert.equal(buildPlan("1594").hasExpansion, false);
  assert.ok(buildPlan("594").hasExpansion, "594 本身應命中 Luer 那組");
});

test("空查詢與純空白查詢不會炸，也不會命中全部", () => {
  for (const q of ["", "   ", "　"]) {
    const plan = buildPlan(q);
    assert.equal(plan.tokens.length, 0);
    assert.equal(runSearch(CORPUS, plan, textOf).hits.length, 0, `「${q}」不該命中任何東西`);
  }
});

// ---------- 片段（snippet）----------

test("片段優先切在使用者真正打的詞上，不切在展開出來的同義詞上", () => {
  const plan = buildPlan("注射針筒");
  const snippet = planSnippet(CORPUS.find((r) => r.id === 23).text, plan);
  assert.match(snippet, /注射針筒/);
});

test("片段在只有展開詞命中時仍切在展開詞上", () => {
  const plan = buildPlan("洗腎管");
  const snippet = planSnippet(CORPUS.find((r) => r.id === 111).text, plan);
  assert.match(snippet, /體外血液處理用導管/);
});

test("片段回切原文的繁體寫法（簡繁摺疊不影響顯示）", () => {
  const plan = buildPlan("親水塗層");
  const snippet = planSnippet("供应商型录：亲水涂层导管", plan);
  assert.match(snippet, /亲水涂层/, "原文是簡體就顯示簡體");
});

// ---------- 計分 ----------

test("scoreText 分別回報原詞命中與含展開命中的詞元數", () => {
  const plan = buildPlan("注射器 洗腎管");
  const onSeven = scoreText("ISO_7886-1_2017_無菌皮下注射器.pdf", plan);
  assert.equal(onSeven.origHits, 1, "注射器 是原詞命中");
  assert.equal(onSeven.anyHits, 1, "洗腎管 那組在這筆沒命中");
  const onTenTriple = scoreText("第8部_體外血液處理用導管_注射器相容性.pdf", plan);
  assert.equal(onTenTriple.origHits, 1);
  assert.equal(onTenTriple.anyHits, 2, "洗腎管 靠展開命中");
});

// ---------- 結構性防護：確保五個工具都走同一套比對 ----------

test("五個 search_* 工具全部走查詢計畫，沒有殘留舊的整串比對", async () => {
  const source = await readFile(new URL("../mcp/src/worker.js", import.meta.url), "utf8");

  // 舊的整串比對 helper 必須已經完全移除
  assert.doesNotMatch(source, /function foldIncludes/, "foldIncludes 應已移除");
  assert.doesNotMatch(source, /foldIncludes\(/, "不該再有 foldIncludes 呼叫");
  assert.doesNotMatch(source, /foldText\(\s*needQuery/, "不該再把整串查詢字直接摺疊比對");

  // 五個搜尋工具都要有 needPlan（＝走斷詞＋同義詞展開）
  const searchTools = [
    "search_wiki",
    "search_fieldlog",
    "search_exhibitors",
    "search_visit_notes",
    "search_exhibitor_files",
  ];
  for (const name of searchTools) {
    const start = source.indexOf(`name: "${name}"`);
    assert.ok(start > 0, `找不到工具 ${name}`);
    // 抓這個工具定義到下一個工具定義之間的區塊
    const nextTool = source.indexOf('\n    name: "', start + 1);
    const block = source.slice(start, nextTool > 0 ? nextTool : source.length);
    assert.match(block, /needPlan\(args\)/, `${name} 沒有改用查詢計畫`);
    assert.match(block, /noHitMessage\(/, `${name} 查無結果沒有走誠實回報`);
  }
});

test("同義詞表是獨立 JSON、格式正確，使用者可自行增修", async () => {
  const raw = await readFile(new URL("../mcp/src/synonyms.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.synonyms) && data.synonyms.length >= 16);
  for (const group of data.synonyms) {
    assert.equal(typeof group.canonical, "string");
    assert.ok(group.canonical.length > 0);
    assert.ok(Array.isArray(group.aliases), `${group.canonical} 的 aliases 要是陣列`);
    assert.ok(Array.isArray(group.codes), `${group.canonical} 的 codes 要是陣列`);
  }
});
