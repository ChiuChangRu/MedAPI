/**
 * 參展系統的團隊名單（MEMBER_PROFILES）結構測試。
 *
 * 為什麼需要：renderRecommendBar() 是 `DEPT_PRESETS.find(...).name` 這種寫法，
 * chip 的 id 只要打錯一個字就會在那個人登入時整條推薦列拋錯——而且只有「那個人」
 * 會遇到，其他人完全正常，很難發現。這裡在 CI 就把對照關係釘死。
 *
 * 另一件事是姓名模糊比對：dedupedRoster() 用「互為子字串就視為同一人」來把
 * 「邱長儒」與「長儒」歸戶，代價是新成員的名字若剛好是別人的子字串就會被吃掉。
 * 每次加人都要重驗一次，所以做成測試。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// config.js 是瀏覽器端的純資料檔（沒有 export、也沒碰任何 DOM／localStorage），
// 用 vm 跑一遍就能拿到裡面所有頂層常數
async function loadConfig() {
  const src = await readFile(new URL("../cloudflare/public/config.js", import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(`${src}\n;globalThis.__cfg = { MEMBER_PROFILES, DEPT_PRESETS, PRODUCT_LINES, TECH_MAP, NAME_ALIASES, HIDDEN_MEMBERS };`, context);
  return context.__cfg;
}

async function loadCategoryIds() {
  const raw = await readFile(new URL("../cloudflare/public/data/exhibitors.json", import.meta.url), "utf8");
  return new Set((JSON.parse(raw).categories || []).map((c) => c.id));
}

test("每個成員的推薦 chip 都指到真的存在的 preset／分類", async () => {
  const { MEMBER_PROFILES, DEPT_PRESETS, PRODUCT_LINES, TECH_MAP } = await loadConfig();
  const catIds = await loadCategoryIds();
  const ids = {
    dept: new Set(DEPT_PRESETS.map((d) => d.id)),
    line: new Set(PRODUCT_LINES.map((l) => l.id)),
    tech: new Set(TECH_MAP.map((t) => t.id)),
  };

  for (const person of MEMBER_PROFILES) {
    assert.ok(person.name, "每個人都要有名字");
    assert.ok(Array.isArray(person.chips), `${person.name} 的 chips 要是陣列`);
    for (const chip of person.chips) {
      if (chip.k === "cats") {
        assert.ok(chip.label, `${person.name} 的 cats chip 要有 label（畫面上顯示的字）`);
        for (const id of chip.ids) {
          assert.ok(catIds.has(id), `${person.name} 指到不存在的分類 ${id}`);
        }
        continue;
      }
      assert.ok(ids[chip.k], `${person.name} 用了不認識的 chip 類型「${chip.k}」`);
      assert.ok(ids[chip.k].has(chip.id), `${person.name} 指到不存在的 ${chip.k} preset「${chip.id}」`);
    }
  }
});

test("名單裡沒有人的名字是別人的子字串（否則模糊比對會把兩個人歸成一個）", async () => {
  const { MEMBER_PROFILES, HIDDEN_MEMBERS } = await loadConfig();
  // 跟 app.js 的 isSameName 同一套規則
  const isSameName = (a, b) =>
    a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));

  // 隱藏名單裡「龍欽／沈龍欽」是同一個人的兩種寫法，本來就該互相命中，不算撞名
  const names = [...MEMBER_PROFILES.map((p) => p.name), ...HIDDEN_MEMBERS];
  const known = new Set(["龍欽|沈龍欽"]);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (!isSameName(names[i], names[j])) continue;
      assert.ok(
        known.has(`${names[i]}|${names[j]}`) || known.has(`${names[j]}|${names[i]}`),
        `「${names[i]}」與「${names[j]}」會被模糊比對視為同一人——請改用 NAME_ALIASES 別名表`
      );
    }
  }
});

test("灝翰在名單上，職掌涵蓋模具射出與製圖設計", async () => {
  const { MEMBER_PROFILES } = await loadConfig();
  const person = MEMBER_PROFILES.find((p) => p.name === "灝翰");
  assert.ok(person, "灝翰要在團隊名單上");
  assert.match(person.duty, /模具|射出/);
  assert.match(person.duty, /製圖|設計/);
  // 射出成型的核心分類（cat-09 塑膠成型服務與裝置）與設計服務（cat-16）都要涵蓋到
  const catIds = person.chips.filter((c) => c.k === "cats").flatMap((c) => c.ids);
  assert.ok(catIds.includes("cat-09"), "要涵蓋塑膠成型服務與裝置");
  assert.ok(catIds.includes("cat-16"), "要涵蓋研發設計／製圖服務");
});
