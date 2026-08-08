/**
 * 標準文件節錄版偵測（2026-07-27 長儒回報：ISO 10555-8 這份 PDF 深度處理
 * 6/6 頁都完成，但其實只到 p6、缺 Annex A/B——系統當時完全沒發現這件事，
 * 只能靠人自己記住哪些文件不完整）。
 *
 * 長儒提出的建議分成三塊，這裡對應鎖住：
 * ① 頁碼連續性比對：從目錄文字 best-effort 推算「應該有幾頁」，跟 Tier 2
 *    深度處理讀到的實際頁數（pdf.js 的 pdf.numPages，存進 attachments.total_pages）
 *    比對，兩者不符就是節錄版的強訊號。
 * ② 來源標記：上傳時選填的來源網址（attachments.source_url）若命中已知的
 *    標準預覽站網域，直接標記提醒人工確認。
 * ③ UI 顯示：①②任一命中，在「深度頁面」那行下面多一行紅字警示。
 *
 * ①②的純函式（deriveExpectedPages／matchPreviewDomain）在 app.js，用跟
 * fieldlog-usage-stale-warning.test.js 同一招（vm 執行原始碼）直接測試；
 * 後端則測 source_url／total_pages 兩個新欄位真的會被存進去、且不會被
 * Tier 2 產生的頁面圖附件污染（那些不是「這份文件本身」）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import fieldlogWorker from "../fieldlog/src/worker.js";
import { resetSchemaCacheForTests } from "../fieldlog/src/lib/schema.js";

async function loadAppFns(names) {
  const src = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const extract = (name) => {
    const constStart = src.indexOf(`const ${name} =`);
    if (constStart >= 0) {
      const end = src.indexOf(";", constStart);
      return src.slice(constStart, end + 1);
    }
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `找不到 function/const ${name}`);
    let depth = 0;
    let i = src.indexOf("{", start);
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  };
  const code = names.map(extract).join("\n") + `\nglobalThis.__fns = { ${names.join(", ")} };`;
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return context.__fns;
}

// ---------- ① deriveExpectedPages ----------

test("deriveExpectedPages：目錄裡 Annex/Bibliography 後面的頁碼，取最大值當推算頁數", async () => {
  const { deriveExpectedPages } = await loadAppFns(["deriveExpectedPages"]);
  const text = [
    "Foreword ................ iv",
    "1 Scope ................. 1",
    "Annex A (informative) Rationale ... 3",
    "Annex B (informative) Test report ... 7",
    "Bibliography ............ 8",
  ].join("\n");
  assert.equal(deriveExpectedPages(text), 8);
});

test("deriveExpectedPages：沒有目錄關鍵字時回 null，不亂猜一個數字", async () => {
  const { deriveExpectedPages } = await loadAppFns(["deriveExpectedPages"]);
  assert.equal(deriveExpectedPages("這只是一段普通的內文，沒有目錄結構"), null);
  assert.equal(deriveExpectedPages(""), null);
  assert.equal(deriveExpectedPages(null), null);
});

test("deriveExpectedPages：行尾沒有數字的 Annex 標題不算命中（例如純粹內文提到 Annex 這個詞）", async () => {
  const { deriveExpectedPages } = await loadAppFns(["deriveExpectedPages"]);
  const text = "本文件的 Annex 部分說明如下，但這一行沒有列頁碼";
  assert.equal(deriveExpectedPages(text), null);
});

test("deriveExpectedPages：明顯不合理的大數字（例如條款編號誤判）不採用", async () => {
  const { deriveExpectedPages } = await loadAppFns(["deriveExpectedPages"]);
  const text = "Annex A 條款參照 ISO 594-2 3000"; // 尾數 3000，超出合理頁數範圍
  assert.equal(deriveExpectedPages(text), null);
});

// ---------- ② matchPreviewDomain ----------

test("matchPreviewDomain：命中已知預覽站網域", async () => {
  const { matchPreviewDomain } = await loadAppFns(["PREVIEW_SOURCE_DOMAINS", "matchPreviewDomain"]);
  assert.equal(matchPreviewDomain("https://standards.iteh.ai/catalog/standards/iso/xxx"), "standards.iteh.ai");
  assert.equal(matchPreviewDomain("HTTPS://STANDARDS.ITEH.AI/xxx"), "standards.iteh.ai", "應該不分大小寫");
});

test("matchPreviewDomain：不是已知預覽站、或沒填來源網址時回 null", async () => {
  const { matchPreviewDomain } = await loadAppFns(["PREVIEW_SOURCE_DOMAINS", "matchPreviewDomain"]);
  assert.equal(matchPreviewDomain("https://www.iso.org/standard/12345.html"), null);
  assert.equal(matchPreviewDomain(""), null);
  assert.equal(matchPreviewDomain(null), null);
});

// ---------- 後端：source_url／total_pages 兩個新欄位 ----------

function makeDB({ attachments = [] } = {}) {
  const tables = { attachments, history: [] };
  let nextAttId = attachments.length ? Math.max(...attachments.map((a) => a.id)) + 1 : 1;

  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    const none = { results: [], changes: 0 };

    if (q === "SELECT folder_id FROM entries WHERE id = ?") {
      return { results: [{ folder_id: null }], changes: 0 };
    }
    // 重複檔比對：兩種形狀都回空集合，測試裡每次都是新檔案
    if (q.startsWith("SELECT id, key, filename, size, content_hash FROM attachments")) return none;
    if (q.startsWith("SELECT a.id, a.key, a.filename, a.size, a.content_hash")) return none;
    if (q.startsWith("INSERT INTO attachments (entry_id, kind, filename, original_filename, key, size, mime, offset_secs, source_pdf_id, page_no, duration_secs, content_hash, source_url, created_at)")) {
      const [entry_id, kind, filename, original_filename, key, size, mime, offset_secs, source_pdf_id, page_no, duration_secs, content_hash, source_url, created_at] = args;
      const id = nextAttId++;
      tables.attachments.push({ id, entry_id, kind, filename, original_filename, key, size, mime, offset_secs, source_pdf_id, page_no, duration_secs, content_hash, source_url, total_pages: null, created_at });
      return { results: [], meta: { last_row_id: id }, changes: 1 };
    }
    if (q === "SELECT * FROM attachments WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[0]);
      return { results: row ? [{ ...row }] : [], changes: 0 };
    }
    if (q === "UPDATE attachments SET total_pages = ? WHERE id = ?") {
      const row = tables.attachments.find((a) => a.id === args[1]);
      if (row) row.total_pages = args[0];
      return { results: [], changes: row ? 1 : 0 };
    }
    // autoRenameAttachment／logHistory 可能下的查詢：不是本測試重點，當沒動作
    return none;
  }

  const db = {
    tables,
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    prepare(sql) {
      const make = (args) => ({
        async all() { return { results: exec(sql, args).results }; },
        async first() { return exec(sql, args).results[0] || null; },
        async run() { const r = exec(sql, args); return { meta: r.meta || { changes: r.changes } }; },
      });
      return { bind: (...args) => make(args), ...make([]) };
    },
  };
  return db;
}

function makeEnv(db) {
  resetSchemaCacheForTests();
  const putCalls = [];
  return {
    FIELD_PIN: "pin", DB: db,
    FILES: {
      async put(key, body, opts) { putCalls.push({ key, opts }); },
    },
    __putCalls: putCalls,
  };
}

async function callUpload(env, { entryId, filename, sourcePdfId, pageNo, sourceUrl, mime = "application/pdf" }) {
  const headers = {
    "x-pin": "pin",
    "x-entry-id": String(entryId),
    "x-filename": encodeURIComponent(filename),
    "content-type": mime,
  };
  if (sourcePdfId !== undefined) headers["x-source-pdf-id"] = String(sourcePdfId);
  if (pageNo !== undefined) headers["x-page-no"] = String(pageNo);
  if (sourceUrl !== undefined) headers["x-source-url"] = encodeURIComponent(sourceUrl);
  const req = new Request("https://x/api/upload", { method: "POST", headers, body: new Uint8Array([1, 2, 3, 4]) });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

async function callSetTotalPages(env, attachmentId, totalPages) {
  const req = new Request(`https://x/api/attachments/${attachmentId}`, {
    method: "PUT", headers: { "x-pin": "pin", "content-type": "application/json" },
    body: JSON.stringify({ total_pages: totalPages }),
  });
  const res = await fieldlogWorker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

test("上傳頂層文件時帶 x-source-url，會存進這筆附件的 source_url", async () => {
  const db = makeDB({});
  const env = makeEnv(db);
  const res = await callUpload(env, {
    entryId: 40, filename: "spec-notes.pdf", sourceUrl: "https://standards.iteh.ai/catalog/standards/iso/xxx",
  });
  assert.equal(res.status, 200);
  const att = db.tables.attachments.find((a) => a.id === res.data.id);
  assert.equal(att.source_url, "https://standards.iteh.ai/catalog/standards/iso/xxx");
});

test("Tier 2 深度處理拆出來的頁面圖（帶 x-source-pdf-id）即使也帶了 x-source-url，也不會存——那個網址是原始 PDF 的來源，不是頁面圖自己的", async () => {
  const db = makeDB({});
  const env = makeEnv(db);
  const res = await callUpload(env, {
    entryId: 40, filename: "spec-notes-p1.png", sourcePdfId: 1, pageNo: 1,
    sourceUrl: "https://standards.iteh.ai/should-not-be-stored", mime: "image/png",
  });
  assert.equal(res.status, 200);
  const att = db.tables.attachments.find((a) => a.id === res.data.id);
  assert.equal(att.source_url, "", "頁面圖不該繼承來源 PDF 的 source_url——那一欄只給頂層檔案用");
});

test("沒填來源網址時，source_url 存空字串，不是 undefined／null（往後渲染時不用額外判斷）", async () => {
  const db = makeDB({});
  const env = makeEnv(db);
  const res = await callUpload(env, { entryId: 40, filename: "plain.pdf" });
  assert.equal(res.status, 200);
  const att = db.tables.attachments.find((a) => a.id === res.data.id);
  assert.equal(att.source_url, "");
});

test("PUT /attachments/:id 可以設定 total_pages（Tier 2 深度處理讀到 pdf.js 的真實頁數後存下來）", async () => {
  const db = makeDB({ attachments: [{ id: 5, entry_id: 40, filename: "iso.pdf", total_pages: null }] });
  const env = makeEnv(db);
  const res = await callSetTotalPages(env, 5, 6);
  assert.equal(res.status, 200);
  assert.equal(db.tables.attachments.find((a) => a.id === 5).total_pages, 6);
});

test("worker.js 的 source_url 只在沒有 source_pdf_id 時才收——guard 條件要同時檢查兩者", async () => {
  const src = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
  assert.match(src, /!sourcePdfId && sourceUrlRaw/, "guard 條件寫錯的話，Tier 2 頁面圖會意外繼承來源 PDF 的網址");
});
