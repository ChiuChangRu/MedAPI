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

async function prepRdMatcher({ notes = {}, pending = [], state = {}, categories = {} } = {}) {
  const app = await read("cloudflare/public/app.js");
  const start = app.indexOf("const PREP_RD_TOPICS");
  const end = app.indexOf("function prepVendorHtml", start);
  assert.ok(start >= 0 && end > start, "應能擷取研發關聯的純判斷邏輯");
  const sandbox = {
    CAT_MAP: categories,
    getState: (id) => state[id] || {},
    notesCache: () => notes,
    getPending: () => pending,
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.__match = prepRAndDRelationshipsFor;`, sandbox);
  return sandbox.__match;
}

test("研發關聯以四位同事與廠商／Note 證據動態比對，沒有證據就待確認", async () => {
  const match = await prepRdMatcher({
    notes: {
      verify: [{ type: "現場紀錄", content: "供應商可提供抗菌披膜的 EO 滅菌後檢驗報告" }],
    },
  });

  assert.deepEqual(Array.from(match("長儒", { id: "coat", products: ["親水塗層"] }).matches, (x) => x.no), [2]);
  assert.deepEqual(Array.from(match("宗銘", { id: "tube", products: ["編織增強導管", "TPU 球囊"] }).matches, (x) => x.no), [4, 6]);
  assert.deepEqual(Array.from(match("灝翰", { id: "laser", description: "精密激光打孔與雷射切割" }).matches, (x) => x.no), [1]);
  assert.deepEqual(Array.from(match("政哲", { id: "verify" }).matches, (x) => x.no), [8]);
  assert.equal(match("政哲", { id: "unknown", products: ["一般醫療耗材"] }).matches.length, 0);
  assert.equal(match("昌毅", { id: "laser", products: ["雷射加工"] }).role, null, "只對指定四位加入研發關聯");
});

test("研發關聯卡片顯示拜訪依據、現場查證與待確認狀態", async () => {
  const [app, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(app, /"長儒"[\s\S]*topicNos: \[2, 7, 8\]/);
  assert.match(app, /"宗銘"[\s\S]*topicNos: \[3, 4, 5, 6\]/);
  assert.match(app, /"灝翰"[\s\S]*kind: "製圖／模治具支援"/);
  assert.match(app, /"政哲"[\s\S]*kind: "滅菌／檢驗驗證"/);
  assert.match(app, /研發關聯待確認/);
  assert.match(app, /<strong>拜訪依據：<\/strong>/);
  assert.match(app, /<strong>現場查證：<\/strong>/);
  assert.match(app, /prepVendorHtml\(e, name\)/);
  assert.match(style, /\.prep-rd-match/);
  assert.match(style, /\.prep-rd-pending/);
});

test("研發策略投影片依序連起策略地圖、問題、廠商與落地策略", async () => {
  const [app, html, style] = await Promise.all([
    read("cloudflare/public/app.js"),
    read("cloudflare/public/index.html"),
    read("cloudflare/public/style.css"),
  ]);

  assert.match(html, /id="prep-strategy-deck"/);
  assert.match(app, /const PREP_STRATEGY_ORDER = \["灝翰", "長儒", "宗銘", "政哲", "昌毅", "帛辰", "柏宏"\]/);
  assert.match(app, /const PREP_FIELD_STRATEGY_ROLES = \{/);
  assert.match(app, /"昌毅"[\s\S]*kind: "生產／材料導入"/);
  assert.match(app, /"帛辰"[\s\S]*kind: "電子／自動化檢測"/);
  assert.match(app, /"柏宏"[\s\S]*kind: "工業工程／設備採購"/);
  assert.match(app, /職能策略地圖（推定）/, "沒有正式策略地圖的三人必須標明是推定");
  assert.match(app, /function prepStrategySlideHtml\(memberName, vendors, index\)/);
  assert.match(app, /研發策略地圖/);
  assert.match(app, /要回答的問題/);
  assert.match(app, /對應廠商/);
  assert.match(app, /落地策略/);
  assert.match(app, /prepStrategyRelationshipsFor\(memberName, vendor\)/, "七人的投影片都要依廠商資料比對關聯");
  assert.match(app, /data-strategy-exhibitor=/, "投影片內的廠商應能直接開啟詳情");
  assert.match(app, /ranked\.map\(\(\{ vendor, matches \}\)/, "所有已選廠商都要逐家列出，不能只列命中的前五家");
  assert.match(app, /matches\.length \? "is-matched" : "is-pending"/);
  assert.match(app, /matches\.length \? matches\.map\(prepStrategyTopicMark\)\.join\(" · "\) : "待確認"/);
  assert.match(style, /\.prep-strategy-slide/);
  assert.match(style, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(style, /\.prep-slide-vendor-list[\s\S]*max-height: 245px; overflow-y: auto/, "廠商全列時卡內捲動，避免投影片無限拉長");
});

test("三位現場主管的推定策略可依廠商資料找出職能關聯", async () => {
  const app = await read("cloudflare/public/app.js");
  const start = app.indexOf("const PREP_RD_TOPICS");
  const end = app.indexOf("function prepVendorHtml", start);
  const sandbox = {
    CAT_MAP: {},
    getState: () => ({}),
    notesCache: () => ({}),
    getPending: () => [],
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.__match = prepStrategyRelationshipsFor;`, sandbox);
  const match = sandbox.__match;

  assert.deepEqual(Array.from(match("昌毅", { id: "chem", products: ["醫療 UV 黏著膠"] }).matches, (x) => x.code), ["接合"]);
  assert.deepEqual(Array.from(match("帛辰", { id: "vision", description: "CCD 視覺檢測與 MES 批次追溯" }).matches, (x) => x.code), ["檢測", "追溯"]);
  assert.deepEqual(Array.from(match("柏宏", { id: "line", description: "自動化設備，提供 UPH 與 IQ OQ 驗證" }).matches, (x) => x.code), ["設備", "產能", "採購"]);
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
