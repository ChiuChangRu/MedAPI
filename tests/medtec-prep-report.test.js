import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
