import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("參訪前報告以七人實際 assignee 為主，不再用職掌關鍵字家數冒充已選廠商", async () => {
  const [app, html, config] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/index.html"),
    read("cloudflare/public/config.js"),
  ]);

  assert.match(app, /function prepAssignedExhibitors\(name\)/);
  assert.match(app, /isSameName\(getState\(e\.id\)\.assignee, name\)/);
  assert.match(app, /data-exhibitor=/, "每一家已選廠商都應可直接開啟詳情");
  assert.match(app, /prepQuestionsFor\(e\.id\)/, "廠商列應帶出現有代問問題");
  assert.match(app, /classList\.contains\("prep-view"\)\) renderPrepReport\(\)/, "共筆狀態更新後報告要立即重算");
  assert.match(app, /const drafts = \{\}/, "重算報告時要保留尚未儲存的個人補充草稿");
  assert.match(html, /id="prep-overview"/);
  assert.match(html, /依目前共筆中的負責同事即時整理/);
  assert.doesNotMatch(html, /家數即時取自 881 家官方名冊/);
  assert.match(config, /const PREP_ORDER = \["長儒", "宗銘", "政哲", "昌毅", "帛辰", "柏宏", "灝翰"\]/);
});

test("參訪前報告保留個人補充與離線可讀資料，不新增寫入路徑", async () => {
  const app = await read("cloudflare/public/app.js");

  assert.match(app, /let PREP_NOTES = \{\}/);
  assert.match(app, /localStorage\.getItem\("medtec_prep_notes"\)/);
  assert.match(app, /api\(`\/prep-notes\/\$\{encodeURIComponent\(name\)\}`/);
  assert.match(app, /STATE 在連線時來自 D1，離線時來自手機快照/);
});

test("參訪前報告顯示現有拜訪 Note 精華，代問不重複混入", async () => {
  const [app, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(app, /function prepNoteExcerpt\(content, limit = 120\)/, "長 Note 應先壓成卡片可讀的精華");
  assert.match(app, /function prepNoteHighlightsFor\(exhibitorId\)/);
  assert.match(app, /n\.type !== "想詢問的問題"/, "代問已有獨立區塊，不應重複當 Note 精華");
  assert.match(app, /notesCache\(\)\[exhibitorId\]/, "已同步 Note 應從離線快照讀取");
  assert.match(app, /getPending\(\).*exhibitor_id === exhibitorId/, "手機待同步 Note 也應顯示");
  assert.match(app, /noteHighlights\.slice\(0, 2\)/, "卡片只顯示最近兩則，避免重新變得難讀");
  assert.match(app, /Note 精華/);
  assert.match(style, /\.prep-vendor-highlights/);
});

async function prepDemandRuntime({ notes = {}, pending = [], state = {}, categories = {}, prepNotes = {} } = {}) {
  const app = await read("cloudflare/public/app.js");
  const start = app.indexOf("const PREP_DEMAND_CATALOG");
  const end = app.indexOf("function prepVendorHtml", start);
  assert.ok(start >= 0 && end > start, "應能擷取需求歸納的純判斷邏輯");
  const sandbox = {
    CAT_MAP: categories,
    getState: (id) => state[id] || {},
    notesCache: () => notes,
    getPending: () => pending,
    isSameName: (a, b) => !!a && !!b && (a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)))),
    prepNoteExcerpt: (content, limit = 120) => String(content || "").replace(/\s+/g, " ").trim().slice(0, limit),
    PREP_NOTES: prepNotes,
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.__analyze = prepMemberDemandAnalysis;\nglobalThis.__evidence = prepDemandEvidenceFor;`, sandbox);
  return { analyze: sandbox.__analyze, evidence: sandbox.__evidence };
}

test("灝翰的本人留言可分出針具第二來源與 Luer 檢測設備", async () => {
  const { analyze } = await prepDemandRuntime({
    notes: {
      needle: [{ author: "灝翰", type: "想詢問的問題", content: "活檢針內/外針價格、規格、法規？" }],
      luer: [{ author: "灝翰", type: "想詢問的問題", content: "ISO 9626、ISO 7864、ISO 80369 相關檢測設備" }],
    },
  });
  const vendors = [
    { id: "needle", name_zh: "針具廠", products: ["活檢針"] },
    { id: "luer", name_zh: "測試儀廠", products: ["Luer 綜合測試儀"] },
  ];
  const result = analyze("灝翰", vendors);
  assert.deepEqual(Array.from(result.demands, (d) => d.topic.code), ["needle-source", "luer-inspection"]);
  assert.ok(result.demands.every((d) => d.source === "direct"));
  assert.ok(result.demands.every((d) => d.sourceLabel === "本人留言"));
  assert.equal(result.rankedVendors.length, 2, "所有已選廠商都要保留");
});

test("長儒的披膜液留言與 Parylene／管內鍍層選商要分別呈現", async () => {
  const { analyze } = await prepDemandRuntime({
    notes: {
      liquid: [{ author: "邱長儒", type: "索取資料備註", content: "索取披膜液" }],
    },
  });
  const result = analyze("長儒", [
    { id: "liquid", name_zh: "披膜材料廠", products: ["親水披膜液"] },
    { id: "parylene", name_zh: "派拉綸新材料", products: ["Parylene 管內鍍層"] },
  ]);
  const demands = Object.fromEntries(Array.from(result.demands, (d) => [d.topic.code, d]));
  assert.equal(demands["coating-liquid"].source, "direct");
  assert.equal(demands["coating-service"].source, "inferred");
  assert.equal(demands["coating-service"].sourceLabel, "依選商推定");
});

test("他人留言不得被算成負責人的本人訴求", async () => {
  const { analyze } = await prepDemandRuntime({
    notes: {
      shared: [{ author: "長儒", type: "想詢問的問題", content: "Luer ISO 80369 檢測設備" }],
    },
  });
  const vendor = { id: "shared", name_zh: "一般耗材廠", products: ["一般醫療耗材"] };
  assert.equal(analyze("帛辰", [vendor]).demands.length, 0, "長儒的留言不能歸到帛辰");
  assert.equal(analyze("長儒", [vendor]).demands[0].source, "direct");
});

test("個人補充只加強相關廠商，不把名下所有廠商硬連到同一訴求", async () => {
  const { analyze } = await prepDemandRuntime({
    prepNotes: { "灝翰": { content: "需要 Luer ISO 80369 檢測設備" } },
  });
  const result = analyze("灝翰", [
    { id: "luer", name_zh: "Luer 測試儀廠", products: ["Luer 綜合測試儀"] },
    { id: "needle", name_zh: "針具廠", products: ["活檢針"] },
  ]);
  const luer = result.demands.find((d) => d.topic.code === "luer-inspection");
  assert.equal(luer.source, "direct");
  assert.deepEqual(Array.from(luer.evidences, (e) => e.vendor.id), ["luer"]);
});

test("政哲無本人留言時，仍可依已選廠商顯示 EO／檢測與 CCD 設備推定", async () => {
  const { analyze } = await prepDemandRuntime();
  const result = analyze("政哲", [
    { id: "eo", name_zh: "檢測機構", description: "第三方檢測，具 CNAS／CMA 資質" },
    { id: "ccd", name_zh: "球囊設備廠", products: ["球囊 AI 檢測機"], description: "CCD 視覺檢測" },
  ]);
  const codes = Array.from(result.demands, (d) => d.topic.code);
  assert.ok(codes.includes("sterilization-testing"));
  assert.ok(codes.includes("automated-inspection"));
  assert.ok(result.demands.every((d) => d.source === "inferred"));
});

test("四階段圖卡明確分成研發策略地圖／生產問題、訴求、廠商、落地", async () => {
  const [app, html, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/index.html"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(html, /id="prep-strategy-deck"/);
  assert.match(app, /const PREP_STRATEGY_ORDER = \["灝翰", "長儒", "宗銘", "政哲", "昌毅", "帛辰", "柏宏"\]/);
  assert.match(app, /const PREP_PRODUCTION_MEMBERS = new Set\(\["昌毅", "帛辰", "柏宏"\]\)/);
  assert.match(app, /isProduction \? "生產問題" : "研發策略地圖"/);
  assert.match(app, /function prepStrategySlideHtml\(memberName, vendors, index\)/);
  assert.match(app, /研發策略地圖/);
  assert.match(app, /<i>2<\/i>訴求/);
  assert.match(app, /對應廠商/);
  assert.match(app, /<i>4<\/i>落地/);
  assert.match(app, /function prepMemberNotesFor\(memberName, exhibitorId\)/);
  assert.match(app, /isSameName\(n\.author, memberName\)/, "本人留言必須先核對作者");
  assert.match(app, /依選商推定/);
  assert.match(app, /data-strategy-exhibitor=/, "投影片內的廠商應能直接開啟詳情");
  assert.match(app, /rankedVendors\.map\(\(\{ vendor, matches \}\)/, "所有已選廠商都要逐家列出");
  assert.match(app, /matches\.length \? "is-matched" : "is-pending"/);
  assert.match(app, /選商目的待補/);
  assert.match(style, /\.prep-strategy-slide/);
  assert.match(style, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(style, /\.prep-slide-vendor-list[\s\S]*max-height: 245px; overflow-y: auto/, "廠商全列時卡內捲動，避免投影片無限拉長");
  assert.match(style, /\.prep-slide-demand-list/);
  assert.match(style, /\.prep-slide-landing-list/);
});

test("首頁六天行程以大標題與明顯文字控制逐日折疊", async () => {
  const [app, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(app, /<details class="itin-day/);
  assert.match(app, /<summary class="itin-day-summary">/);
  assert.match(app, /itin-toggle-open">收合/);
  assert.match(app, /itin-toggle-closed">展開/);
  assert.match(app, /previousOpen\.has\(d\.date\) \? previousOpen\.get\(d\.date\) : false/, "六天首次進入都要收合");
  assert.match(app, /previousOpen\.has\(d\.date\)/, "切換分頁後要保留使用者剛才的展開狀態");
  assert.match(app, /itin-today-tag/, "全部收合時仍保留今天標記");
  assert.match(style, /\.itin-date \{ font-size: clamp\(22px, 3vw, 29px\)/);
  assert.match(style, /\.itin-toggle \{[\s\S]*min-width: 68px/, "收合控制要靠近日期，不再推到卡片最右側");
  assert.match(style, /\.itin-day\[open\] \.itin-toggle-arrow/);
});
