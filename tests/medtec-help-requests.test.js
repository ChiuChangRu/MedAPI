/**
 * cloudflare/src/worker.js：廠商協尋看板（同事有需求但沒空找廠商，
 * 把問題列成卡片，AI 從展商目錄挑候選廠商供參考）。
 *
 * 2026-08-19 長儒的情境：同事提出問題但沒時間去找廠商，希望把問題列成卡片，
 * 讓 LLM 協助協尋，放在網頁上。這裡鎖住幾件事：
 * 1. 基本 CRUD（建立要擋空白問題、列表排序、標記已解決/重新開放、刪除）
 * 2. AI 建議是加分項，失敗（沒設 env.AI、模型出錯）不能擋住卡片建立本身
 * 3. AI 只能選候選清單裡列出的編號——範圍外/重複的編號要被丟棄，
 *    防止模型自己編造清單以外的廠商（幻覺）
 * 4. in_directory=false（已確認不在今年官方名單）的展商不該進候選清單，
 *    不然等於叫同事跑一趟去找一家根本沒參展的公司
 */

import assert from "node:assert/strict";
import test from "node:test";

import medtecWorker, { parseSuggestionLines, scoreCandidate, shortlistCandidates, tokenizeQuestion } from "../cloudflare/src/worker.js";

const TEAM_PIN = "pin1234";
const STATIC_EXHIBITORS = [
  { id: "ex-0001", name_zh: "蘇州鍍膜科技", name_en: "Suzhou Coating Tech", booth_no: "N1-A01", country: "中國", category: "cat-08", tags: [], description: "PTFE 披膜與精密塗層加工，具醫療器械經驗", products: ["PTFE披膜"], website: "", in_directory: true },
  { id: "ex-0002", name_zh: "上海包裝材料", name_en: "Shanghai Packaging", booth_no: "N1-A02", country: "中國", category: "cat-13", tags: [], description: "無菌吸塑盒包裝", products: [], website: "", in_directory: true },
  { id: "ex-0003", name_zh: "已下架披膜廠商", name_en: "Delisted Coating Co", booth_no: "N1-A03", country: "中國", category: "cat-08", tags: [], description: "PTFE 披膜加工", products: [], website: "", in_directory: false },
];
const CATEGORIES = [
  { id: "cat-08", name_zh: "電子元件與感測", name_en: "Electronic Components" },
  { id: "cat-13", name_zh: "包裝材料", name_en: "Packaging" },
];

function makeDB() {
  const tables = { members: [], exhibitor_state: [], notes: [], history: [], attachments: [], line_recipients: [], custom_exhibitors: [], help_requests: [] };

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (/^CREATE (TABLE|INDEX)/i.test(q)) return none;
    if (/^ALTER TABLE/i.test(q)) return none;

    if (q === "SELECT * FROM custom_exhibitors WHERE deleted = 0") {
      return { results: tables.custom_exhibitors.filter((r) => !r.deleted).map((r) => ({ ...r })), changes: 0 };
    }

    if (q === "SELECT * FROM help_requests ORDER BY (status = 'open') DESC, created_at DESC") {
      const rows = [...tables.help_requests].sort((a, b) => {
        const openDiff = (b.status === "open") - (a.status === "open");
        if (openDiff) return openDiff;
        return b.created_at.localeCompare(a.created_at);
      });
      return { results: rows.map((r) => ({ ...r })), changes: 0 };
    }
    if (q.startsWith("INSERT INTO help_requests")) {
      const [id, question, created_by, created_at, updated_at] = args;
      tables.help_requests.push({ id, question, created_by, status: "open", matched_exhibitor_id: "", matched_note: "", ai_suggestions: "[]", ai_note: "", ai_checked_at: "", created_at, updated_at });
      return { results: [], changes: 1 };
    }
    if (q === "SELECT * FROM help_requests WHERE id = ?") {
      const row = tables.help_requests.find((r) => r.id === args[0]);
      return { results: row ? [{ ...row }] : [], changes: 0 };
    }
    if (q === "UPDATE help_requests SET ai_suggestions = ?, ai_note = ?, ai_checked_at = ?, updated_at = ? WHERE id = ?") {
      const [ai_suggestions, ai_note, ai_checked_at, updated_at, id] = args;
      const row = tables.help_requests.find((r) => r.id === id);
      if (row) Object.assign(row, { ai_suggestions, ai_note, ai_checked_at, updated_at });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE help_requests SET status = ?, matched_exhibitor_id = ?, matched_note = ?, updated_at = ? WHERE id = ?") {
      const [status, matched_exhibitor_id, matched_note, updated_at, id] = args;
      const row = tables.help_requests.find((r) => r.id === id);
      if (row) Object.assign(row, { status, matched_exhibitor_id, matched_note, updated_at });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "DELETE FROM help_requests WHERE id = ?") {
      const before = tables.help_requests.length;
      tables.help_requests = tables.help_requests.filter((r) => r.id !== args[0]);
      return { results: [], changes: before - tables.help_requests.length };
    }

    if (q === "SELECT * FROM exhibitor_state") return { results: tables.exhibitor_state.map((r) => ({ ...r })), changes: 0 };
    return none;
  }

  const db = {
    tables,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { const r = exec(sql, args); return { meta: { changes: r.changes } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db, { exhibitors = STATIC_EXHIBITORS, categories = CATEGORIES, ai = null } = {}) {
  return {
    TEAM_PIN,
    DB: db,
    AI: ai,
    ASSETS: {
      async fetch() {
        return { async json() { return { exhibitors, categories }; } };
      },
    },
  };
}

function fakeAi(response) {
  return { async run() { return { response }; } };
}

function call(env, path, { method = "GET", body } = {}) {
  const req = new Request(`https://x/api${path}`, {
    method,
    headers: { "x-team-pin": TEAM_PIN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ctx = { waitUntil: () => {} };
  return medtecWorker.fetch(req, env, ctx).then(async (res) => ({ status: res.status, data: await res.json() }));
}

test("建立協尋問題：空白問題要擋下來", async () => {
  const env = makeEnv(makeDB());
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "   " } });
  assert.equal(res.status, 400);
});

test("建立協尋問題成功：沒有 env.AI 時仍要建立成功，只是沒有建議（AI 是加分項不擋主流程）", async () => {
  const env = makeEnv(makeDB(), { ai: null });
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "需要找 PTFE 披膜廠商", created_by: "昌毅" } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "open");
  assert.deepEqual(res.data.ai_suggestions, []);
  assert.match(res.data.ai_note, /尚未啟用 Workers AI/);
});

test("建立協尋問題：AI 回傳候選清單內的編號，正確解析成展商快照", async () => {
  const env = makeEnv(makeDB(), { ai: fakeAi("1: 主打 PTFE 披膜加工，且有醫療器材經驗") });
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "需要找 PTFE 披膜加工廠商", created_by: "昌毅" } });
  assert.equal(res.status, 200);
  assert.equal(res.data.ai_suggestions.length, 1);
  assert.equal(res.data.ai_suggestions[0].exhibitor_id, "ex-0001");
  assert.match(res.data.ai_suggestions[0].reason, /PTFE 披膜/);
});

test("AI 建議：候選清單以外/格式不對的編號要被丟棄，不能出現幻覺廠商", async () => {
  const env = makeEnv(makeDB(), { ai: fakeAi("1: 相關\n99: 幻覺出來的編號\n亂寫一行沒有冒號") });
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "需要找 PTFE 披膜加工廠商", created_by: "昌毅" } });
  assert.equal(res.data.ai_suggestions.length, 1, "只有編號 1 在候選清單範圍內，99 跟格式不對的行都要丟棄");
  assert.equal(res.data.ai_suggestions[0].exhibitor_id, "ex-0001");
});

test("AI 建議：in_directory=false 的展商不該出現在候選清單裡", async () => {
  // 只用問題關鍵字命中 ex-0001（在架）跟 ex-0003（已下架，同樣是披膜廠商）；
  // 若下架展商混進候選清單，AI 可能選到它，等於叫同事跑一趟去找沒參展的公司
  const env = makeEnv(makeDB(), { ai: fakeAi("1: 相關") });
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "需要找披膜廠商", created_by: "昌毅" } });
  const ids = res.data.ai_suggestions.map((s) => s.exhibitor_id);
  assert.ok(!ids.includes("ex-0003"), "已下架的展商不該被建議");
});

test("AI 建議：候選清單找不到關鍵字相關的公司時誠實回報，不硬湊", async () => {
  const env = makeEnv(makeDB(), { ai: fakeAi("不重要，因為關鍵字比對不到任何候選就不會呼叫 AI") });
  const res = await call(env, "/help-requests", { method: "POST", body: { question: "需要找火箭引擎製造商", created_by: "昌毅" } });
  assert.deepEqual(res.data.ai_suggestions, []);
  assert.match(res.data.ai_note, /找不到|沒有明顯相關/);
});

test("列表排序：待協尋（open）排在已解決前面", async () => {
  const env = makeEnv(makeDB());
  await call(env, "/help-requests", { method: "POST", body: { question: "問題一" } });
  const second = (await call(env, "/help-requests", { method: "POST", body: { question: "問題二" } })).data;
  await call(env, `/help-requests/${second.id}`, { method: "PUT", body: { status: "resolved" } });

  const list = (await call(env, "/help-requests")).data;
  assert.equal(list[0].status, "open");
  assert.equal(list[list.length - 1].status, "resolved");
});

test("/help-requests/:id/suggest 手動重新協尋：找不到 id 回 404", async () => {
  const env = makeEnv(makeDB(), { ai: fakeAi("1: 相關") });
  const res = await call(env, "/help-requests/help-not-exist/suggest", { method: "POST" });
  assert.equal(res.status, 404);
});

test("/help-requests/:id/suggest 手動重新協尋：!env.AI 回 501", async () => {
  const env = makeEnv(makeDB(), { ai: null });
  const created = (await call(env, "/help-requests", { method: "POST", body: { question: "需要找廠商" } })).data;
  const res = await call(env, `/help-requests/${created.id}/suggest`, { method: "POST" });
  assert.equal(res.status, 501);
});

test("PUT 標記已解決：matched_exhibitor_id 要存進去", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/help-requests", { method: "POST", body: { question: "需要找廠商" } })).data;
  const res = await call(env, `/help-requests/${created.id}`, { method: "PUT", body: { status: "resolved", matched_exhibitor_id: "ex-0001", matched_note: "問過了，就是這家" } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "resolved");
  assert.equal(res.data.matched_exhibitor_id, "ex-0001");
  assert.equal(res.data.matched_note, "問過了，就是這家");
});

test("PUT 重新開放：找不到 id 回 404", async () => {
  const env = makeEnv(makeDB());
  const res = await call(env, "/help-requests/help-not-exist", { method: "PUT", body: { status: "open" } });
  assert.equal(res.status, 404);
});

test("DELETE 成功刪除，找不到回 404", async () => {
  const env = makeEnv(makeDB());
  const created = (await call(env, "/help-requests", { method: "POST", body: { question: "要刪的問題" } })).data;
  const res = await call(env, `/help-requests/${created.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(env.DB.tables.help_requests.length, 0);

  const res2 = await call(env, `/help-requests/${created.id}`, { method: "DELETE" });
  assert.equal(res2.status, 404);
});

test("/config 回報 help_ai 旗標", async () => {
  const withAi = await call(makeEnv(makeDB(), { ai: fakeAi("") }), "/config");
  assert.equal(withAi.data.help_ai, true);
  const withoutAi = await call(makeEnv(makeDB(), { ai: null }), "/config");
  assert.equal(withoutAi.data.help_ai, false);
});

// ---------- 純函式單元測試 ----------

test("tokenizeQuestion：中文用 2-gram、英數字詞至少 2 字", () => {
  const words = tokenizeQuestion("需要 PTFE 披膜廠商");
  assert.ok(words.has("ptfe"));
  assert.ok(words.has("披膜"));
  assert.ok(words.has("膜廠"));
});

test("scoreCandidate：關鍵字命中名稱/分類/簡介才有分數，完全不相關是 0 分", () => {
  const ex = { name_zh: "蘇州鍍膜科技", description: "PTFE 披膜加工" };
  const hit = scoreCandidate(ex, "電子元件", tokenizeQuestion("PTFE 披膜"));
  const miss = scoreCandidate(ex, "電子元件", tokenizeQuestion("火箭引擎"));
  assert.ok(hit > 0);
  assert.equal(miss, 0);
});

test("shortlistCandidates：分數為 0 的候選不列入，讓「查無候選」誠實呈現", () => {
  const catMap = { "cat-08": { name_zh: "電子元件" } };
  const got = shortlistCandidates(STATIC_EXHIBITORS, catMap, "火箭引擎");
  assert.deepEqual(got, []);
});

test("parseSuggestionLines：只信任候選清單範圍內、未重複的編號", () => {
  const candidates = [{ exhibitor_id: "ex-a" }, { exhibitor_id: "ex-b" }];
  const got = parseSuggestionLines("1: 理由甲\n1: 重複的第一筆\n5: 超出範圍\n沒有冒號的一行\n2: 理由乙", candidates);
  assert.deepEqual(got.map((g) => g.exhibitor_id), ["ex-a", "ex-b"]);
});
