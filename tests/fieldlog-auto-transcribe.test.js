/**
 * POST /api/entries/:id/auto-transcribe——「錄音怎麼看起來完全不能用」的真正
 * 成因（2026-07-27 使用者回報）。
 *
 * 使用者錄了一段音，畫面顯示多段附件卡在「⏳ 未整理」／「⚠️ 自動轉錄失敗」，
 * 看起來像整個錄音功能壞掉。實際追下去：這支端點原本一遇到某一段轉錄出錯
 * （例如 Whisper 一次性故障），就會直接 return 整批，並把 stopped:true 一起
 * 回給前端；前端看到 stopped 就會把 AUDIO.liveTranscriptionStopped 設成
 * true，永久關掉「這次錄音」剩下所有段落的即時轉錄——一次偶發錯誤，
 * 讓後面每一段都停在「未整理」，使用者只能事後手動逐段重試，看起來像
 * 錄音本身壞掉，其實音檔一直都有正常存進去。
 *
 * 這裡鎖住修好後的行為：單一段落失敗只影響那一段，其他段落（不管是同一批
 * 還是後續段落）照樣正常轉錄；只有「額度保護」才允許提早停下並回 stopped:true。
 */

import assert from "node:assert/strict";
import test from "node:test";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

function makeDB({ attachments = [] } = {}) {
  const tables = { attachments, reservations: [], history: [] };
  let nextHistoryId = 1;

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (q === "SELECT * FROM attachments WHERE entry_id = ? AND kind = 'audio' AND COALESCE(transcript, '') = '' AND COALESCE(transcribed_at, '') = '' AND duration_secs > 0 ORDER BY offset_secs, id") {
      const rows = tables.attachments
        .filter((a) => a.entry_id === args[0] && a.kind === "audio" && !a.transcript && !a.transcribed_at && a.duration_secs > 0)
        .sort((a, b) => a.offset_secs - b.offset_secs || a.id - b.id);
      return { results: rows.map((a) => ({ ...a })), changes: 0 };
    }
    if (q === "SELECT COALESCE(SUM(estimated_neurons), 0) AS total FROM ai_usage_reservations WHERE usage_date = ?") {
      const total = tables.reservations.filter((r) => r.usage_date === args[0]).reduce((s, r) => s + r.estimated_neurons, 0);
      return { results: [{ total }], changes: 0 };
    }
    if (q.startsWith("INSERT OR IGNORE INTO ai_usage_reservations")) {
      const [attachmentId, usageDate, estimate, , createdAt] = args;
      if (tables.reservations.some((r) => r.attachment_id === attachmentId)) return none;
      tables.reservations.push({ attachment_id: attachmentId, usage_date: usageDate, estimated_neurons: estimate, status: "reserved", created_at: createdAt });
      return { results: [], changes: 1 };
    }
    if (q === "UPDATE attachments SET transcribed_at = 'processing' WHERE id = ? AND COALESCE(transcribed_at, '') = ''") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      if (!row || row.transcribed_at) return none;
      row.transcribed_at = "processing";
      return { results: [], changes: 1 };
    }
    if (q === "UPDATE ai_usage_reservations SET status = 'completed' WHERE attachment_id = ?") {
      const r = tables.reservations.find((x) => x.attachment_id === args[0]);
      if (r) r.status = "completed";
      return { results: [], changes: r ? 1 : 0 };
    }
    if (q === "UPDATE ai_usage_reservations SET status = 'failed' WHERE attachment_id = ?") {
      const r = tables.reservations.find((x) => x.attachment_id === args[0]);
      if (r) r.status = "failed";
      return { results: [], changes: r ? 1 : 0 };
    }
    if (q === "UPDATE attachments SET transcribed_at = 'auto_failed' WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      if (row) row.transcribed_at = "auto_failed";
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q === "UPDATE attachments SET transcript = ?, transcribed_at = ? WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[2]);
      if (row) { row.transcript = args[0]; row.transcribed_at = args[1]; }
      return { results: [], changes: row ? 1 : 0 };
    }
    if (q.startsWith("INSERT INTO history")) {
      tables.history.push({ id: nextHistoryId++, entry_id: args[0], folder_id: args[1], action: args[2], detail: args[3], created_at: args[4] });
      return { results: [], changes: 1 };
    }
    // autoRenameAttachment 可能會下的查詢／更新：不影響本測試重點，一律當「沒動作」
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

function audioAttachment(overrides = {}) {
  return {
    id: 1, entry_id: 10, kind: "audio", filename: "錄音-段1.webm",
    key: "k1", transcript: "", transcribed_at: "", offset_secs: 0, duration_secs: 30,
    ...overrides,
  };
}

// 讓 enforceAiSoftBudget 過關：billable/usage 回傳空的 AI 用量、遠低於軟上限
function stubUsageFetch() {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, result: [] }) });
}

function makeEnv(db, { transcribeResults = {} } = {}) {
  resetSchemaCacheForTests();
  stubUsageFetch();
  return {
    FIELD_PIN: "pin", DB: db,
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_USAGE_API_TOKEN: "tok",
    FILES: { async get() { return { async arrayBuffer() { return new ArrayBuffer(4); } }; } },
    AI: {
      async run(model, input) {
        // 用 base64 反查是哪一個附件在跑：測試把附件 id 塞進假的音檔 bytes 裡，
        // 這裡直接用呼叫順序對應 transcribeResults 的 key（用 id 標記見下方組裝）
        const marker = atob(input.audio).trim();
        const outcome = transcribeResults[marker];
        if (outcome instanceof Error) throw outcome;
        return { text: outcome ?? "" };
      },
    },
  };
}

async function callAutoTranscribe(env, entryId) {
  const req = new Request(`https://x/api/entries/${entryId}/auto-transcribe`, {
    method: "POST", headers: { "x-pin": "pin", "content-type": "application/json" }, body: "{}",
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

test("單一段落轉錄失敗，只影響那一段——同一批裡其他段落照樣成功轉錄", async () => {
  const db = makeDB({
    attachments: [
      audioAttachment({ id: 1, offset_secs: 0 }),
      audioAttachment({ id: 2, offset_secs: 60 }),
      audioAttachment({ id: 3, offset_secs: 120 }),
    ],
  });
  const env = makeEnv(db);
  // db.prepare 的「UPDATE ... transcribed_at = 'processing'」是每個候選開始處理前
  // 唯一會帶上該附件 id 的一步，用它記下「現在正在跑哪個 id」，讓假的 AI.run 能
  // 依 id 決定要成功還是丟錯（模擬 Whisper 對 id=2 這一段偶發故障）。
  let currentId = 0;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (!sql.includes("UPDATE attachments SET transcribed_at = 'processing'")) return stmt;
    return { bind: (...args) => { currentId = args[0]; return stmt.bind(...args); } };
  };
  env.AI = {
    async run() {
      if (currentId === 2) throw new Error("模擬 Whisper 偶發故障");
      return { text: `逐字稿-${currentId}` };
    },
  };

  const res = await callAutoTranscribe(env, 10);
  assert.equal(res.status, 200);
  assert.equal(res.data.stopped, false, "單段失敗不該讓整批被標記成 stopped——那會害前端永久關掉這次錄音剩下所有段落的即時轉錄");
  assert.equal(res.data.processed, 2, "id=1、id=3 都要成功處理，不能被 id=2 的失敗拖累");
  assert.equal(res.data.failed.length, 1);
  assert.equal(res.data.failed[0].attachmentId, 2);
  assert.match(res.data.failed[0].reason, /模擬 Whisper 偶發故障/);

  const [a1, a2, a3] = [1, 2, 3].map((id) => db.tables.attachments.find((a) => a.id === id));
  assert.ok(a1.transcribed_at, "成功的段落要有 transcribed_at 時間戳");
  assert.match(a1.transcript, /逐字稿-1/);
  assert.equal(a2.transcribed_at, "auto_failed", "失敗的那一段要標成 auto_failed，附件上的手動重試連結才會出現");
  assert.equal(a2.transcript, "", "失敗的段落不該留下半截或假的逐字稿");
  assert.match(a3.transcript, /逐字稿-3/, "id=3 這種排在失敗段落後面的候選，也要照樣被嘗試，不能被前面的失敗擋住");
});

test("失敗的段落會寫進 history，之後可以在「這筆資料的來歷」面板查到實際錯誤訊息", async () => {
  const db = makeDB({ attachments: [audioAttachment({ id: 5, entry_id: 20 })] });
  const env = makeEnv(db);
  env.AI = { async run() { throw new Error("Whisper 暫時無法使用"); } };

  const res = await callAutoTranscribe(env, 20);
  assert.equal(res.status, 200);
  assert.equal(res.data.stopped, false);
  assert.equal(res.data.failed.length, 1);

  const entry = db.tables.history.find((h) => h.entry_id === 20);
  assert.ok(entry, "失敗要留下履歷，不能悄悄發生");
  assert.equal(entry.action, "自動轉錄失敗");
  assert.match(entry.detail, /Whisper 暫時無法使用/, "履歷要留真正的錯誤訊息，不是只說『失敗了』");
});

test("沒有可轉錄的候選時，直接回報原因，不呼叫 AI 也不動任何資料", async () => {
  const db = makeDB({ attachments: [] });
  const env = makeEnv(db);
  let aiCalled = false;
  env.AI = { async run() { aiCalled = true; return { text: "不該被呼叫" }; } };

  const res = await callAutoTranscribe(env, 30);
  assert.equal(res.status, 200);
  assert.equal(res.data.processed, 0);
  assert.match(res.data.reason, /沒有可安全自動轉錄/);
  assert.equal(aiCalled, false);
});
