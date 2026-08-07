/**
 * 暫存區與 AI 自動歸類（fieldlog/src/lib/autofile.js）。
 *
 * 這一組要守住的行為，全部來自「東西看不見就不會被處理」這個真實狀況：
 *   - 來不及分類的先進一個看得見的暫存資料夾（不是空了就消失的收件匣）
 *   - 放滿設定天數才輪到 AI，沒滿的一律不碰
 *   - AI 只能在使用者現有的資料夾裡挑，挑不出來就留在原地並標記，不亂塞
 *   - 歸完一定留下 🤖 標記與歷程，人才分得出哪些位置是機器決定的
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_FILE_DAYS_MAX,
  AUTO_FILE_DAYS_MIN,
  AUTO_FILE_MODEL,
  DEFAULT_AUTO_FILE_DAYS,
  STAGING_FOLDER_ROLE,
  autoFileDays,
  autoFileStagedEntries,
  buildPrompt,
  cutoffTimestamp,
  ensureStagingFolder,
  folderPaths,
  parseChoice,
  resolveAutoFileDays,
  saveAutoFileDays,
  summariseEntry,
} from "../fieldlog/src/lib/autofile.js";

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0); // 2026-08-07 12:00Z
const stamp = () => new Date(NOW).toISOString().replace("T", " ").slice(0, 19) + "Z";
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().replace("T", " ").slice(0, 19) + "Z";

function makeDB({ folders = [], entries = [], attachments = [], settings = {} } = {}) {
  const tables = { folders: [...folders], entries: [...entries], attachments: [...attachments], history: [] };
  const settingsRows = new Map(Object.entries(settings));
  const nextId = { folders: 100, entries: 200, history: 1 };
  const unhandled = [];

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    // resolveAutoFileDays／saveAutoFileDays 用的 key-value 設定（見 lib/settings.js）
    if (q === "SELECT value FROM settings WHERE key = ?") {
      return { results: settingsRows.has(args[0]) ? [{ value: settingsRows.get(args[0]) }] : [] };
    }
    if (q === "SELECT key FROM settings WHERE key = ?") {
      return { results: settingsRows.has(args[0]) ? [{ key: args[0] }] : [] };
    }
    if (q === "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)") {
      settingsRows.set(args[0], args[1]);
      return { results: [], changes: 1 };
    }
    if (q === "UPDATE settings SET value = ?, updated_at = ? WHERE key = ?") {
      settingsRows.set(args[2], args[0]);
      return { results: [], changes: 1 };
    }

    if (q === "SELECT * FROM folders WHERE role = ? LIMIT 1") {
      const row = tables.folders.find((f) => f.role === args[0]);
      return { results: row ? [row] : [] };
    }
    if (q === "INSERT INTO folders (name, type, parent_id, role, created_at) VALUES (?, ?, NULL, ?, ?)") {
      const id = nextId.folders++;
      tables.folders.push({ id, name: args[0], type: args[1], parent_id: null, role: args[2], created_at: args[3] });
      return { results: [], lastRowId: id, changes: 1 };
    }
    if (q === "SELECT id, name, type, parent_id, COALESCE(role, '') AS role FROM folders") {
      return { results: tables.folders.map((f) => ({ ...f, role: f.role || "" })) };
    }
    if (q.startsWith("SELECT id, folder_id, title, body, body_format, fields_json, created_at FROM entries")) {
      const [stagingId, cutoff, limit] = args;
      const rows = tables.entries
        .filter((e) => (e.folder_id === null || e.folder_id === undefined || e.folder_id === stagingId))
        .filter((e) => !(e.auto_filed_at || ""))
        .filter((e) => String(e.created_at) <= String(cutoff))
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return { results: rows };
    }
    if (q.startsWith("SELECT filename, COALESCE(ocr_text, '') AS ocr_text")) {
      return { results: tables.attachments.filter((a) => a.entry_id === args[0]) };
    }
    if (q === "UPDATE entries SET auto_filed_at = 'failed', auto_filed_reason = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[1]);
      if (row) Object.assign(row, { auto_filed_at: "failed", auto_filed_reason: args[0] });
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE entries SET folder_id = ?, auto_filed_at = ?, auto_filed_reason = ? WHERE id = ?") {
      const row = tables.entries.find((e) => e.id === args[3]);
      if (row) Object.assign(row, { folder_id: args[0], auto_filed_at: args[1], auto_filed_reason: args[2] });
      return { results: [], changes: row ? 1 : 0 };
    }

    unhandled.push(q);
    return none;
  }

  return {
    tables, unhandled,
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() {
          const r = exec(sql, args);
          return { meta: { last_row_id: r.lastRowId, changes: r.changes ?? 0 } };
        },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
}

const logHistory = async (db, entryId, folderId, action, detail) => {
  db.tables.history.push({ entry_id: entryId, folder_id: folderId, action, detail });
};

function fakeAi(responder) {
  return { calls: [], async run(model, input) { this.calls.push({ model, input }); return { response: responder(input) }; } };
}

// ---------- 小函式 ----------

test("autoFileDays：預設四天，可用環境變數調整，並夾在 0–30 天", () => {
  assert.equal(autoFileDays({}), DEFAULT_AUTO_FILE_DAYS);
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "3" }), 3);
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "5" }), 5);
  // 0 是刻意允許的合法值＝「不等待，全部立即歸檔」，不是打錯字
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "0" }), 0);
  // 負數／非數字才是真的打錯字，退回預設值
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "-1" }), DEFAULT_AUTO_FILE_DAYS);
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "abc" }), DEFAULT_AUTO_FILE_DAYS);
  assert.equal(autoFileDays({ AUTO_FILE_DAYS: "999" }), 30);
});

// ---------- 使用者自己調天數（不是寫死的規則）----------

test("resolveAutoFileDays：沒設定過就退回環境變數／預設值", async () => {
  const db = makeDB();
  assert.equal(await resolveAutoFileDays(db, {}), DEFAULT_AUTO_FILE_DAYS);
  assert.equal(await resolveAutoFileDays(db, { AUTO_FILE_DAYS: "6" }), 6);
});

test("resolveAutoFileDays：使用者設定過就用那個值，環境變數退居次位", async () => {
  const db = makeDB({ settings: { auto_file_days: "2" } });
  assert.equal(await resolveAutoFileDays(db, { AUTO_FILE_DAYS: "6" }), 2,
    "使用者在畫面上設定過，就不該再被環境變數蓋過去");
});

test("saveAutoFileDays：夾在 0–30 之間，寫壞的值退回預設值而不是存進一個荒謬的數字", async () => {
  const db = makeDB();
  assert.equal(await saveAutoFileDays(db, 2, "t"), 2);
  assert.equal(await resolveAutoFileDays(db, {}), 2);

  assert.equal(await saveAutoFileDays(db, 999, "t"), AUTO_FILE_DAYS_MAX);
  // 0 是刻意允許的合法值（不等待、全部立即歸檔），要真的存成 0，不能被當成打錯字擋掉
  assert.equal(await saveAutoFileDays(db, 0, "t"), 0);
  assert.equal(await resolveAutoFileDays(db, {}), 0);
  assert.equal(await saveAutoFileDays(db, -5, "t"), DEFAULT_AUTO_FILE_DAYS);
  assert.equal(await saveAutoFileDays(db, "abc", "t"), DEFAULT_AUTO_FILE_DAYS);
});

test("saveAutoFileDays：改第二次是更新同一個 key，不是疊加出一列新的", async () => {
  const db = makeDB();
  await saveAutoFileDays(db, 3, "t1");
  await saveAutoFileDays(db, AUTO_FILE_DAYS_MIN, "t2");
  assert.equal(await resolveAutoFileDays(db, {}), AUTO_FILE_DAYS_MIN);
});

test("自動歸類真的會用使用者設定的天數，不是還在用環境變數", async () => {
  const db = baseDB();
  await saveAutoFileDays(db, 1, stamp());
  const days = await resolveAutoFileDays(db, { AUTO_FILE_DAYS: "30" });
  const ai = fakeAi(() => '{"folder_id": 2, "reason": "x"}');
  // baseDB 裡兩筆記事分別是 6 天前與 1 天前建立的；設定成 1 天後，兩筆都該到期
  const result = await autoFileStagedEntries(db, { ai, days, nowMs: NOW, timestamp: stamp, logHistory });
  assert.equal(result.filed, 2);
});

// 「再做一個 0 天的！全部歸檔！」——0 要能真的立即歸檔剛建立的東西，不是
// 只把「本來就已經到期」的舊記事順便歸掉，兩者是不同的斷言。
test("days=0：連剛建立、還沒放滿一天的記事都立即歸檔，不用等", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "CVC", type: "產品", parent_id: null, role: "" },
      { id: 9, name: "暫存區", type: "其他", parent_id: null, role: STAGING_FOLDER_ROLE },
    ],
    entries: [
      { id: 201, folder_id: 9, title: "剛剛才建立", body: "", fields_json: "{}", created_at: stamp() },
    ],
  });
  const ai = fakeAi(() => '{"folder_id": 1, "reason": "不等待"}');
  const result = await autoFileStagedEntries(db, { ai, days: 0, nowMs: NOW, timestamp: stamp, logHistory });
  assert.equal(result.filed, 1, "0 天要連剛建立的都歸檔，不是只歸掉本來就過期的");
  assert.equal(db.tables.entries[0].folder_id, 1);
});

test("cutoffTimestamp 與 worker 的 now() 同格式，字串比大小就等於比時間", () => {
  const cutoff = cutoffTimestamp(4, NOW);
  assert.match(cutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
  assert.ok(daysAgo(5) < cutoff, "五天前的記事算逾期");
  assert.ok(daysAgo(1) > cutoff, "昨天的記事還不到期");
});

test("parseChoice：模型在 JSON 前後加廢話也要抓得到，folder_id 為 0／壞掉一律當沒挑到", () => {
  assert.deepEqual(parseChoice('好的，我的判斷是 {"folder_id": 7, "reason": "談的是塗層試驗"} 以上'),
    { folderId: 7, reason: "談的是塗層試驗" });
  assert.equal(parseChoice('{"folder_id": 0, "reason": "看不出來"}'), null);
  assert.equal(parseChoice("我不知道"), null);
  assert.equal(parseChoice('{"folder_id": "第三個"}'), null);
  assert.equal(parseChoice(""), null);
});

test("folderPaths：四層資料夾攤成完整路徑，父子關係壞掉也不會無限迴圈", () => {
  const paths = folderPaths([
    { id: 1, name: "CVC", parent_id: null },
    { id: 2, name: "法規與標準", parent_id: 1 },
    { id: 3, name: "ISO 10555", parent_id: 2 },
    { id: 9, name: "自己指自己", parent_id: 9 },
  ]);
  assert.equal(paths.get(3), "CVC / 法規與標準 / ISO 10555");
  assert.equal(paths.get(9), "自己指自己");
});

test("summariseEntry：標題、內文與附件擷取文字都餵給 AI，且各自截斷", () => {
  const summary = summariseEntry(
    { title: "親水塗層測試", body: "摩擦力量測結果" },
    [{ filename: "報告.pdf", ocr_text: "coefficient of friction" }],
  );
  assert.match(summary, /親水塗層測試/);
  assert.match(summary, /摩擦力量測結果/);
  assert.match(summary, /報告\.pdf/);
  assert.match(summary, /coefficient of friction/);
});

test("buildPrompt 明講「只能挑清單裡的編號、不確定回 0」", () => {
  const prompt = buildPrompt("標題：測試", [{ id: 3, path: "CVC / 法規", type: "法規與標準" }]);
  assert.match(prompt, /3\. CVC \/ 法規/);
  assert.match(prompt, /不可以自己發明分類/);
  assert.match(prompt, /folder_id 請回 0/);
});

// ---------- 暫存區 ----------

test("暫存區資料夾建一次就好，之後一律沿用同一個", async () => {
  const db = makeDB();
  const first = await ensureStagingFolder(db, stamp());
  const second = await ensureStagingFolder(db, stamp());
  assert.equal(first.role, STAGING_FOLDER_ROLE);
  assert.equal(Number(second.id), Number(first.id));
  assert.equal(db.tables.folders.length, 1, "不能每次呼叫都多長一個暫存區");
});

test("暫存區靠 role 欄位認，不靠名字——使用者改名之後自動歸類仍找得到", async () => {
  const db = makeDB({ folders: [{ id: 5, name: "我改過的名字", type: "其他", parent_id: null, role: STAGING_FOLDER_ROLE, created_at: stamp() }] });
  const staging = await ensureStagingFolder(db, stamp());
  assert.equal(Number(staging.id), 5);
  assert.equal(db.tables.folders.length, 1);
});

// ---------- 自動歸類 ----------

function baseDB() {
  return makeDB({
    folders: [
      { id: 1, name: "CVC", type: "中央靜脈導管（CVC）", parent_id: null, role: "" },
      { id: 2, name: "法規與標準", type: "法規與標準", parent_id: 1, role: "" },
      { id: 9, name: "⏳ 暫存區（待歸類）", type: "其他", parent_id: null, role: STAGING_FOLDER_ROLE },
    ],
    entries: [
      { id: 201, folder_id: 9, title: "ISO 10555 摘要", body: "導管標準", fields_json: "{}", created_at: daysAgo(6) },
      { id: 202, folder_id: 9, title: "今天剛錄的", body: "", fields_json: "{}", created_at: daysAgo(1) },
    ],
  });
}

test("放滿天數的才歸類，還沒滿的完全不碰", async () => {
  const db = baseDB();
  const ai = fakeAi(() => '{"folder_id": 2, "reason": "講的是導管標準"}');
  const result = await autoFileStagedEntries(db, { ai, days: 4, nowMs: NOW, timestamp: stamp, logHistory });

  assert.equal(result.filed, 1);
  assert.equal(ai.calls.length, 1, "只該為逾期的那一筆呼叫 AI");
  assert.equal(ai.calls[0].model, AUTO_FILE_MODEL);
  const filed = db.tables.entries.find((e) => e.id === 201);
  assert.equal(filed.folder_id, 2);
  assert.match(filed.auto_filed_at, /^\d{4}-\d{2}-\d{2} /, "要標記歸類時間，人才看得出這是 AI 分的");
  assert.equal(filed.auto_filed_reason, "講的是導管標準");
  const untouched = db.tables.entries.find((e) => e.id === 202);
  assert.equal(untouched.folder_id, 9, "還沒放滿天數的留在暫存區");
  assert.equal(untouched.auto_filed_at, undefined);
  assert.deepEqual(db.unhandled, [], "不該下出預期外的 SQL");
});

// 2026-08-09 實際回報：把天數改成 1 天之後，「最近作業」最上面還是看得到
// 一堆好幾天前建立、使用者早就沒再碰過的舊記事。根因是自動歸類的 UPDATE
// 連 updated_at 一起蓋成「現在」，而首頁最近作業正是照 updated_at 排序——
// 排程一跑，被掃到的舊記事全部因為「被 AI 動過」而跳回最上面，跟使用者
// 期待的「真的最近有在動的東西」完全相反。
test("AI 自動歸類不改 updated_at——不能因為排程掃過，讓舊記事跳回「最近作業」最上面", async () => {
  const db = baseDB();
  const before = db.tables.entries.find((e) => e.id === 201).updated_at;
  await autoFileStagedEntries(db, {
    ai: fakeAi(() => '{"folder_id": 2, "reason": "講的是導管標準"}'),
    days: 4, nowMs: NOW, timestamp: stamp, logHistory,
  });
  const after = db.tables.entries.find((e) => e.id === 201);
  assert.equal(after.updated_at, before, "updated_at 不該被自動歸類動到");
  assert.match(after.auto_filed_at, /^\d{4}-\d{2}-\d{2} /, "有沒有被 AI 動過看 auto_filed_at 就夠了");
});

test("歸完會寫一筆歷程，說清楚搬去哪、為什麼", async () => {
  const db = baseDB();
  await autoFileStagedEntries(db, {
    ai: fakeAi(() => '{"folder_id": 2, "reason": "講的是導管標準"}'),
    days: 4, nowMs: NOW, timestamp: stamp, logHistory,
  });
  const entry = db.tables.history.find((h) => h.action === "AI 自動歸類");
  assert.ok(entry, "一定要留下歷程");
  assert.match(entry.detail, /CVC \/ 法規與標準/);
  assert.match(entry.detail, /講的是導管標準/);
});

test("AI 挑不出來就留在暫存區並標記，不亂塞一個資料夾了事", async () => {
  const db = baseDB();
  const result = await autoFileStagedEntries(db, {
    ai: fakeAi(() => '{"folder_id": 0, "reason": "內容太少"}'),
    days: 4, nowMs: NOW, timestamp: stamp, logHistory,
  });
  assert.equal(result.filed, 0);
  assert.equal(result.unresolved, 1);
  const entry = db.tables.entries.find((e) => e.id === 201);
  assert.equal(entry.folder_id, 9, "位置不動");
  assert.equal(entry.auto_filed_at, "failed");
});

test("AI 回一個不存在的資料夾編號時當作沒挑到（不能寫進一個不存在的 folder_id）", async () => {
  const db = baseDB();
  await autoFileStagedEntries(db, {
    ai: fakeAi(() => '{"folder_id": 777, "reason": "亂編的"}'),
    days: 4, nowMs: NOW, timestamp: stamp, logHistory,
  });
  const entry = db.tables.entries.find((e) => e.id === 201);
  assert.equal(entry.folder_id, 9);
  assert.equal(entry.auto_filed_at, "failed");
});

test("暫存區自己不會出現在候選清單裡（歸到暫存區等於什麼都沒做）", async () => {
  const db = baseDB();
  const ai = fakeAi(() => '{"folder_id": 2}');
  await autoFileStagedEntries(db, { ai, days: 4, nowMs: NOW, timestamp: stamp, logHistory });
  const prompt = ai.calls[0].input.messages[0].content;
  assert.doesNotMatch(prompt, /暫存區/);
  assert.match(prompt, /法規與標準/);
});

test("AI 掛掉不會讓整批停下來，那一筆留著下次再試", async () => {
  const db = baseDB();
  const ai = { async run() { throw new Error("AI 暫時無法使用"); } };
  const result = await autoFileStagedEntries(db, { ai, days: 4, nowMs: NOW, timestamp: stamp, logHistory });
  assert.equal(result.filed, 0);
  assert.equal(result.unresolved, 1);
});

test("外部來源同步管理的記事不插手（它有自己的歸屬）", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "CVC", type: "產品", parent_id: null, role: "" },
      { id: 9, name: "暫存區", type: "其他", parent_id: null, role: STAGING_FOLDER_ROLE },
    ],
    entries: [{ id: 201, folder_id: null, title: "litdb 文獻", body: "x", fields_json: JSON.stringify({ _sid: "coating:P01" }), created_at: daysAgo(9) }],
  });
  const ai = fakeAi(() => '{"folder_id": 1}');
  const result = await autoFileStagedEntries(db, { ai, days: 4, nowMs: NOW, timestamp: stamp, logHistory });
  assert.equal(ai.calls.length, 0, "同步管理的記事連問都不該問 AI");
  assert.equal(result.filed, 0);
  assert.equal(db.tables.entries[0].folder_id, null);
});

test("沒有 Workers AI 時只確保暫存區存在，不動任何記事", async () => {
  const db = baseDB();
  const result = await autoFileStagedEntries(db, { ai: null, days: 4, nowMs: NOW, timestamp: stamp, logHistory });
  assert.match(result.skipped, /尚未啟用 Workers AI/);
  assert.equal(db.tables.entries.find((e) => e.id === 201).folder_id, 9);
});

test("一次最多處理設定的筆數，不會單次爆量呼叫 AI", async () => {
  const db = makeDB({
    folders: [
      { id: 1, name: "CVC", type: "產品", parent_id: null, role: "" },
      { id: 9, name: "暫存區", type: "其他", parent_id: null, role: STAGING_FOLDER_ROLE },
    ],
    entries: Array.from({ length: 5 }, (_, i) => ({
      id: 300 + i, folder_id: 9, title: `第 ${i} 筆`, body: "", fields_json: "{}", created_at: daysAgo(10),
    })),
  });
  const ai = fakeAi(() => '{"folder_id": 1}');
  const result = await autoFileStagedEntries(db, { ai, days: 4, limit: 2, nowMs: NOW, timestamp: stamp, logHistory });
  assert.equal(result.checked, 2);
  assert.equal(ai.calls.length, 2);
});
