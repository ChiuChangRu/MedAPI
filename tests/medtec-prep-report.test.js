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
