/**
 * 目錄層工具測試（《MyWiki 檢索能力改善規格書 v3》P0-A／P3）。
 *
 * 核心洞察：限制檢索全面性的瓶頸不是「比對演算法不夠聰明」，而是「AI 看不見
 * 架上有什麼書」——search_fieldlog 查不到不代表沒有這份資料，可能只是關鍵字
 * 沒猜對。這幾支工具讓 AI 能直接列目錄，不用靠猜詞。
 *
 * 對應規格書案例：L1–L5（list_fieldlog_entries／list_attachments）、
 * T1–T2（get_fieldlog_attachment 的 offset/length 分段讀取）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../mcp/src/worker.js";

// ---------- 假的 D1（fieldlog）----------

function makeFieldlogDB({ extraAttachments = [] } = {}) {
  const folders = [
    { id: 7, name: "ISO 標準", type: "標準", parent_id: null },
    { id: 8, name: "空資料夾", type: "標準", parent_id: null },
  ];
  const entries = [
    { id: 21, folder_id: 7, title: "ISO 7886-1", created_at: "2026-07-01", updated_at: null },
    { id: 22, folder_id: 7, title: "ISO 10555-8", created_at: "2026-07-02", updated_at: "2026-07-03" },
    { id: 23, folder_id: null, title: "收件匣裡的速記", created_at: "2026-07-04", updated_at: null },
  ];
  const attachments = [
    { id: 101, entry_id: 21, filename: "ISO_7886-1_2017_無菌皮下注射器.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "第一部：手動使用注射器" },
    { id: 102, entry_id: 22, filename: "ISO_10555-8_2024_血管內導管-無菌及單次使用導管-第8部_體外血液處理用導管.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "x".repeat(45000) },
    { id: 103, entry_id: 22, filename: "page1.png", kind: "photo", source_pdf_id: 102, transcript: "", ocr_text: "深度處理頁面，不該被列出" },
    ...extraAttachments,
  ];

  function normalize(sql) { return sql.replace(/\s+/g, " ").trim(); }

  function exec(sql, args) {
    const q = normalize(sql);

    if (q.startsWith("SELECT COUNT(*) AS c FROM entries e")) {
      const rows = q.includes("WHERE e.folder_id = ?") ? entries.filter((e) => e.folder_id === args[0]) : entries;
      return { results: [{ c: rows.length }] };
    }
    if (q.startsWith("SELECT e.id, e.title, e.created_at, e.updated_at")) {
      const hasWhere = q.includes("WHERE e.folder_id = ?");
      const folderId = hasWhere ? args[0] : null;
      const limit = hasWhere ? args[1] : args[0];
      const offset = hasWhere ? args[2] : args[1];
      let rows = hasWhere ? entries.filter((e) => e.folder_id === folderId) : entries.slice();
      rows = rows.slice().sort((a, b) => b.id - a.id).slice(offset, offset + limit);
      return {
        results: rows.map((e) => {
          const f = folders.find((x) => x.id === e.folder_id);
          return { id: e.id, title: e.title, created_at: e.created_at, updated_at: e.updated_at, folder_id: e.folder_id, folder_name: f?.name, folder_type: f?.type };
        }),
      };
    }
    if (q.startsWith("SELECT entry_id, id, filename, kind FROM attachments WHERE entry_id IN")) {
      const ids = args; // 全部 args 都是 entry id（IN 子句展開）
      const rows = attachments.filter((a) => ids.includes(a.entry_id) && a.source_pdf_id === null);
      return { results: rows.map((a) => ({ entry_id: a.entry_id, id: a.id, filename: a.filename, kind: a.kind })) };
    }

    if (q.startsWith("SELECT COUNT(*) AS c FROM attachments a JOIN entries e")) {
      let rows = attachments.filter((a) => a.source_pdf_id === null);
      let i = 0;
      if (q.includes("a.entry_id = ?")) { rows = rows.filter((a) => a.entry_id === args[i]); i++; }
      if (q.includes("e.folder_id = ?")) {
        const folderId = args[i];
        rows = rows.filter((a) => entries.find((e) => e.id === a.entry_id)?.folder_id === folderId);
      }
      return { results: [{ c: rows.length }] };
    }
    if (q.startsWith("SELECT a.id, a.filename, a.kind, a.entry_id, a.transcript, a.ocr_text")) {
      let rows = attachments.filter((a) => a.source_pdf_id === null);
      let i = 0;
      if (q.includes("a.entry_id = ?")) { rows = rows.filter((a) => a.entry_id === args[i]); i++; }
      if (q.includes("e.folder_id = ?")) {
        const folderId = args[i]; i++;
        rows = rows.filter((a) => entries.find((e) => e.id === a.entry_id)?.folder_id === folderId);
      }
      const limit = args[i]; const offset = args[i + 1];
      rows = rows.slice().sort((a, b) => b.id - a.id).slice(offset, offset + limit);
      return {
        results: rows.map((a) => ({
          id: a.id, filename: a.filename, kind: a.kind, entry_id: a.entry_id,
          transcript: a.transcript, ocr_text: a.ocr_text,
          entry_title: entries.find((e) => e.id === a.entry_id)?.title,
        })),
      };
    }

    // get_fieldlog_attachment 既有查詢
    if (q === "SELECT * FROM attachments WHERE id = ?") {
      const a = attachments.find((x) => x.id === args[0]);
      return { results: a ? [a] : [] };
    }
    if (q === "SELECT id, title FROM entries WHERE id = ?") {
      const e = entries.find((x) => x.id === args[0]);
      return { results: e ? [e] : [] };
    }
    // 深度處理子頁面彙總（get_fieldlog_attachment 併全文、list_attachments 算完成度）
    if (q === "SELECT * FROM attachments WHERE source_pdf_id = ? ORDER BY page_no") {
      const rows = attachments.filter((a) => a.source_pdf_id === args[0]).sort((a, b) => (a.page_no || 0) - (b.page_no || 0));
      return { results: rows };
    }
    if (q === "SELECT ocr_at FROM attachments WHERE source_pdf_id = ?") {
      const rows = attachments.filter((a) => a.source_pdf_id === args[0]).map((a) => ({ ocr_at: a.ocr_at || null }));
      return { results: rows };
    }

    return { results: [] };
  }

  return {
    folders, entries, attachments,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: exec(sql, args).results }; },
            async first() { return exec(sql, args).results[0] || null; },
          };
        },
      };
    },
  };
}

async function callTool(env, name, args) {
  const req = new Request("https://mcp.example.workers.dev/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await worker.fetch(req, env);
  const body = await res.json();
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text || "工具回錯誤");
  return body.result.content[0].text;
}

// ---------- L1–L5：list_fieldlog_entries ----------

test("L1/L2 list_fieldlog_entries(folder_id) 列出資料夾全部紀錄，含完整附件檔名", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_fieldlog_entries", { folder_id: 7 });
  assert.match(text, /共 2 筆/);
  assert.match(text, /entry 21.*ISO 7886-1/);
  assert.match(text, /entry 22.*ISO 10555-8/);
  // 檔名要完整出現、不能被截斷
  assert.match(text, /ISO_7886-1_2017_無菌皮下注射器\.pdf/);
  assert.match(text, /ISO_10555-8_2024_血管內導管-無菌及單次使用導管-第8部_體外血液處理用導管\.pdf/);
  // 深度處理的逐頁圖片不算獨立附件，不該出現在清單裡
  assert.doesNotMatch(text, /page1\.png/);
  // 不在這個資料夾的記事不該出現
  assert.doesNotMatch(text, /收件匣裡的速記/);
});

test("L3 list_attachments(entry_id) 列出該筆記事的附件與內容長度", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_attachments", { entry_id: 22 });
  assert.match(text, /共 1 筆/, "只有一份非深度處理的附件");
  assert.match(text, /attachment 102/);
  assert.match(text, /內容長度 45000 字/);
  assert.doesNotMatch(text, /attachment 103/, "深度處理頁面不算獨立附件");
});

test("L4 list_fieldlog_entries() 不給參數時列全庫並正確分頁", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const page1 = await callTool(env, "list_fieldlog_entries", { limit: 2 });
  assert.match(page1, /共 3 筆，目前顯示第 1–2 筆（還有更多，加 offset: 2 繼續拉）/);
  const page2 = await callTool(env, "list_fieldlog_entries", { limit: 2, offset: 2 });
  assert.match(page2, /共 3 筆，目前顯示第 3–3 筆（已到底）/);
});

test("L5 不存在的 folder_id 正確回空，不報錯", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_fieldlog_entries", { folder_id: 9999 });
  assert.match(text, /沒有任何紀錄/);
});

test("空資料夾（folder_id 存在但沒有紀錄）跟不存在的 folder_id 訊息不同，都不報錯", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_fieldlog_entries", { folder_id: 8 });
  assert.match(text, /沒有任何紀錄/);
});

test("list_attachments 沒有條件時列全庫，且過濾掉深度處理頁面", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_attachments", {});
  assert.match(text, /共 2 筆/);
  assert.doesNotMatch(text, /page1\.png/);
});

test("list_attachments 用 folder_id 篩選只看該資料夾底下的附件", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_attachments", { folder_id: 7 });
  assert.match(text, /共 2 筆/);
  assert.match(text, /attachment 101/);
  assert.match(text, /attachment 102/);
});

// ---------- T1–T2：get_fieldlog_attachment 分段讀取 ----------

// 回傳的全文是「## 擷取文字\n」這個標題＋內文接在一起（見 worker.js 的
// get_fieldlog_attachment：多個來源要合併分頁時，標題烤進全文裡才能只用一組
// offset/length 處理，不用另外傳「這段屬於哪個標題」）。算總長度要把標題也算進去。
const OCR_SECTION_HEADER = "## 擷取文字\n";

test("T1 超長附件會明確標示總長度與目前顯示範圍", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "get_fieldlog_attachment", { id: 102 });
  const fullLength = OCR_SECTION_HEADER.length + 45000;
  assert.match(text, new RegExp(`第 1–20000 字，共 ${fullLength} 字`));
  assert.match(text, new RegExp(`還有 ${fullLength - 20000} 字未顯示——用 offset: 20000 再呼叫一次`));
});

test("T2 用 offset 分段讀取可以完整取回全文，段落間不遺漏", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  let offset = 0;
  let collected = "";
  for (let i = 0; i < 10; i++) {
    const text = await callTool(env, "get_fieldlog_attachment", { id: 102, offset });
    const chunkMatch = text.match(/(?:字|全文)）\n([\s\S]+?)(?:\n\n（還有|$)/);
    collected += chunkMatch[1];
    const nextMatch = text.match(/offset: (\d+)/);
    if (!nextMatch) break;
    offset = Number(nextMatch[1]);
  }
  const expected = OCR_SECTION_HEADER + "x".repeat(45000);
  assert.equal(collected.length, expected.length, "分段讀完的長度要等於原始全文長度（含合併用的標題）");
  assert.equal(collected, expected, "內容要完全一致，不能有缺口或重複");
});

test("get_fieldlog_attachment 沒超過上限時標示「完整全文」，不會誤報截斷", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "get_fieldlog_attachment", { id: 101 });
  assert.match(text, /完整全文/);
  assert.doesNotMatch(text, /還有.*字未顯示/);
});

test("get_fieldlog_attachment 找不到附件時報錯，不是回一段空文字", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  await assert.rejects(() => callTool(env, "get_fieldlog_attachment", { id: 9999 }));
});

// ---------- Tier 2 深度處理：父 PDF 自己沒內容，內容在子頁面附件上 ----------
// 背景：深度處理把 PDF 逐頁轉成圖片各自 OCR，結果寫在子頁面附件（source_pdf_id
// 指到父 PDF）自己的 ocr_text，不會回寫到父附件本身。get_fieldlog_entry 因為列出
// 全部附件（含子頁面）所以看得到內容，但 get_fieldlog_attachment／list_attachments
// 原本只看父附件自己的欄位，會誤判成「尚未擷取」。

test("get_fieldlog_attachment 對深度處理過的父 PDF：父附件自己沒內容，要併入子頁面的擷取文字", async () => {
  const env = {
    MCP_PIN: "testpin",
    DB_FIELDLOG: makeFieldlogDB({
      extraAttachments: [
        { id: 104, entry_id: 22, filename: "LOCTITE-EA-E-30CL.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "" },
        { id: 105, entry_id: 22, filename: "LOCTITE-EA-E-30CL-p1.png", kind: "photo", source_pdf_id: 104, page_no: 1, ocr_at: "2026-07-29T00:00:00Z", transcript: "", ocr_text: "第一頁擷取內容" },
        { id: 106, entry_id: 22, filename: "LOCTITE-EA-E-30CL-p2.png", kind: "photo", source_pdf_id: 104, page_no: 2, ocr_at: "2026-07-29T00:01:00Z", transcript: "", ocr_text: "第二頁擷取內容" },
      ],
    }),
  };
  const text = await callTool(env, "get_fieldlog_attachment", { id: 104 });
  assert.doesNotMatch(text, /尚未轉文字\/擷取/, "父附件自己沒內容，但子頁面有，不該說沒擷取");
  assert.match(text, /第一頁擷取內容/);
  assert.match(text, /第二頁擷取內容/);
  assert.match(text, /深度處理，共 2 頁，2 頁已完成/);
});

test("get_fieldlog_attachment 對深度處理中（部分頁面還沒跑完）的父 PDF：只併入已完成的頁面", async () => {
  const env = {
    MCP_PIN: "testpin",
    DB_FIELDLOG: makeFieldlogDB({
      extraAttachments: [
        { id: 104, entry_id: 22, filename: "部分完成.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "" },
        { id: 105, entry_id: 22, filename: "部分完成-p1.png", kind: "photo", source_pdf_id: 104, page_no: 1, ocr_at: "2026-07-29T00:00:00Z", transcript: "", ocr_text: "第一頁擷取內容" },
        { id: 106, entry_id: 22, filename: "部分完成-p2.png", kind: "photo", source_pdf_id: 104, page_no: 2, ocr_at: null, transcript: "", ocr_text: "" },
      ],
    }),
  };
  const text = await callTool(env, "get_fieldlog_attachment", { id: 104 });
  assert.match(text, /第一頁擷取內容/);
  assert.match(text, /深度處理，共 2 頁，1 頁已完成/);
});

test("get_fieldlog_attachment 對完全沒有子頁面、自己也沒內容的附件：維持原本「尚未擷取」訊息", async () => {
  const env = {
    MCP_PIN: "testpin",
    DB_FIELDLOG: makeFieldlogDB({
      extraAttachments: [
        { id: 104, entry_id: 22, filename: "空白檔.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "" },
      ],
    }),
  };
  const text = await callTool(env, "get_fieldlog_attachment", { id: 104 });
  assert.match(text, /還沒轉文字\/擷取/);
});

test("list_attachments 對深度處理中的父 PDF：顯示頁面完成度，不是「尚未轉文字／擷取」", async () => {
  const env = {
    MCP_PIN: "testpin",
    DB_FIELDLOG: makeFieldlogDB({
      extraAttachments: [
        { id: 104, entry_id: 22, filename: "深度處理文件.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "" },
        { id: 105, entry_id: 22, filename: "深度處理文件-p1.png", kind: "photo", source_pdf_id: 104, page_no: 1, ocr_at: "2026-07-29T00:00:00Z", transcript: "", ocr_text: "第一頁" },
        { id: 106, entry_id: 22, filename: "深度處理文件-p2.png", kind: "photo", source_pdf_id: 104, page_no: 2, ocr_at: null, transcript: "", ocr_text: "" },
      ],
    }),
  };
  const text = await callTool(env, "list_attachments", { entry_id: 22 });
  assert.match(text, /attachment 104[^\n]*深度處理中：1\/2 頁已擷取/);
  assert.doesNotMatch(text, /attachment 104[^\n]*尚未轉文字／擷取/);
});

test("list_attachments 對深度處理已建立但還沒開始擷取任何一頁的父 PDF", async () => {
  const env = {
    MCP_PIN: "testpin",
    DB_FIELDLOG: makeFieldlogDB({
      extraAttachments: [
        { id: 104, entry_id: 22, filename: "剛建立的深度處理.pdf", kind: "file", source_pdf_id: null, transcript: "", ocr_text: "" },
        { id: 105, entry_id: 22, filename: "剛建立的深度處理-p1.png", kind: "photo", source_pdf_id: 104, page_no: 1, ocr_at: null, transcript: "", ocr_text: "" },
      ],
    }),
  };
  const text = await callTool(env, "list_attachments", { entry_id: 22 });
  assert.match(text, /attachment 104[^\n]*深度處理已建立 1 頁，尚未擷取/);
});

// ---------- 展商側延伸：list_exhibitor_files ----------

function makeMedtecDB() {
  const attachments = [
    { id: 501, exhibitor_id: "ex-0001", filename: "型錄.pdf", caption: "親水塗層型錄", author: "長儒", created_at: "2026-07-01", transcript: "", ocr_text: "y".repeat(500) },
    { id: 502, exhibitor_id: "ex-0001", filename: "現場錄音.m4a", caption: "", author: "長儒", created_at: "2026-07-02", transcript: "討論塗層方案", ocr_text: "" },
  ];
  function exec(sql, args) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q === "SELECT COUNT(*) AS c FROM attachments WHERE exhibitor_id = ?") {
      return { results: [{ c: attachments.filter((a) => a.exhibitor_id === args[0]).length }] };
    }
    if (q.startsWith("SELECT id, filename, caption, author, created_at, transcript, ocr_text")) {
      const rows = attachments.filter((a) => a.exhibitor_id === args[0])
        .sort((a, b) => b.id - a.id).slice(args[2], args[2] + args[1]);
      return { results: rows };
    }
    return { results: [] };
  }
  return {
    attachments,
    prepare(sql) {
      return { bind: (...args) => ({ async all() { return { results: exec(sql, args).results }; }, async first() { return exec(sql, args).results[0] || null; } }) };
    },
  };
}

test("list_exhibitor_files 列出某展商全部附件並附內容長度", async () => {
  const env = { MCP_PIN: "testpin", DB_MEDTEC: makeMedtecDB() };
  const text = await callTool(env, "list_exhibitor_files", { exhibitor_id: "ex-0001" });
  assert.match(text, /共 2 筆/);
  assert.match(text, /attachment 501.*型錄\.pdf.*內容長度 500 字/);
  assert.match(text, /attachment 502.*現場錄音\.m4a.*內容長度 6 字/);
});

test("list_exhibitor_files 缺 exhibitor_id 報錯", async () => {
  const env = { MCP_PIN: "testpin", DB_MEDTEC: makeMedtecDB() };
  await assert.rejects(() => callTool(env, "list_exhibitor_files", {}));
});

test("list_exhibitor_files 查無此展商正確回空，不報錯", async () => {
  const env = { MCP_PIN: "testpin", DB_MEDTEC: makeMedtecDB() };
  const text = await callTool(env, "list_exhibitor_files", { exhibitor_id: "ex-9999" });
  assert.match(text, /沒有任何附件/);
});

// ---------- X1/X2 負向測試（沿用規格書編號）----------

test("X2 folder_id 對應不存在的資料夾時查無，不報錯（等同負向測試精神）", async () => {
  const env = { MCP_PIN: "testpin", DB_FIELDLOG: makeFieldlogDB() };
  const text = await callTool(env, "list_attachments", { folder_id: 9999 });
  assert.match(text, /沒有符合條件的附件/);
});
