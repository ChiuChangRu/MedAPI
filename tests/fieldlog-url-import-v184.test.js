import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import fieldlogWorker, {
  assertPublicImportUrl,
  contentDispositionFilename,
  importedPdfFilename,
  readUrlImportBytes,
} from "../fieldlog/src/worker.js";

function makeDb() {
  const state = { entries: [], attachments: [], history: [], nextEntry: 40, nextAttachment: 80 };
  function execute(sql, args) {
    if (/^CREATE (?:TABLE|INDEX)|^ALTER TABLE|^PRAGMA/i.test(sql.trim())) return { results: [] };
    if (sql.includes("SELECT id, name FROM folders WHERE id = ?")) {
      return { results: Number(args[0]) === 7 ? [{ id: 7, name: "法規" }] : [] };
    }
    if (sql.includes("SELECT a.id AS attachment_id")) {
      const found = state.attachments.find((item) => item.folderId === Number(args[0]) && item.hash === args[1]);
      return { results: found ? [{ attachment_id: found.id, entry_id: found.entryId, filename: found.filename }] : [] };
    }
    if (sql.includes("INSERT INTO entries (folder_id, title, fields_json, body, body_format, created_at)")) {
      const id = state.nextEntry++;
      state.entries.push({ id, folderId: Number(args[0]), title: args[1], fields: JSON.parse(args[2]), body: args[3] });
      return { results: [], lastRowId: id };
    }
    if (sql.includes("INSERT INTO attachments")) {
      const id = state.nextAttachment++;
      const entry = state.entries.find((item) => item.id === Number(args[0]));
      state.attachments.push({ id, entryId: Number(args[0]), folderId: entry?.folderId, filename: args[1], hash: args[6], sourceUrl: args[7] });
      return { results: [], lastRowId: id };
    }
    if (sql.includes("INSERT INTO history")) { state.history.push(args); return { results: [] }; }
    if (sql.includes("DELETE FROM entries WHERE id = ?")) {
      state.entries = state.entries.filter((item) => item.id !== Number(args[0]));
      return { results: [] };
    }
    return { results: [] };
  }
  return {
    state,
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
    prepare(sql) {
      const runner = (args = []) => ({
        async all() { return { results: execute(sql, args).results }; },
        async first() { return execute(sql, args).results[0] || null; },
        async run() {
          const result = execute(sql, args);
          return { meta: { last_row_id: result.lastRowId, changes: 1 } };
        },
      });
      return { bind: (...args) => runner(args), ...runner() };
    },
  };
}

async function importUrl(env, body) {
  const request = new Request("https://mywiki.example/api/import-url", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pin": "pin" },
    body: JSON.stringify({ folder_id: 7, ...body }),
  });
  const response = await fieldlogWorker.fetch(request, env);
  return { status: response.status, data: await response.json() };
}

test("網址安全檢查接受公開網址並拒絕本機、私有 IP 與非標準連接埠", () => {
  assert.equal(assertPublicImportUrl("example.com/report.pdf").toString(), "https://example.com/report.pdf");
  for (const url of [
    "http://localhost/a.pdf",
    "http://127.0.0.1/a.pdf",
    "http://10.0.0.8/a.pdf",
    "http://169.254.169.254/latest/meta-data",
    "https://intranet.local/report",
    "https://example.com:8443/report",
    "http://[::1]/report",
  ]) assert.throws(() => assertPublicImportUrl(url));
});

test("檔名解析支援 UTF-8 Content-Disposition 並清掉不安全字元", () => {
  assert.equal(contentDispositionFilename("attachment; filename*=UTF-8''%E6%B8%AC%E8%A9%A6.pdf"), "測試.pdf");
  assert.equal(importedPdfFilename('../季報:最終版?.PDF'), "季報 最終版.pdf");
});

test("讀取網址內容會在宣告大小超過 50MB 時先拒絕", async () => {
  const response = new Response("", { headers: { "content-length": String(50 * 1024 * 1024 + 1) } });
  await assert.rejects(readUrlImportBytes(response), (error) => error.status === 413 && /50MB/.test(error.message));
});

test("PDF 網址直接保存，不會呼叫網頁轉 PDF", async () => {
  const originalFetch = globalThis.fetch;
  const DB = makeDb();
  const objects = [];
  let browserCalls = 0;
  globalThis.fetch = async () => new Response(new TextEncoder().encode("%PDF-1.7 direct"), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename*=UTF-8''direct-report.pdf",
    },
  });
  try {
    const result = await importUrl({
      FIELD_PIN: "pin", DB,
      FILES: { async put(key, bytes) { objects.push({ key, bytes }); }, async delete() {} },
      BROWSER: { async quickAction() { browserCalls++; throw new Error("不應呼叫"); } },
    }, { url: "https://files.example.com/download?id=1" });
    assert.equal(result.status, 200);
    assert.equal(result.data.format, "pdf");
    assert.equal(result.data.filename, "direct-report.pdf");
    assert.equal(browserCalls, 0);
    assert.equal(objects.length, 1);
    assert.equal(DB.state.entries[0].fields.source_url, "https://files.example.com/download?id=1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("公開 HTML 才呼叫 Browser Run 並把結果存成 PDF", async () => {
  const originalFetch = globalThis.fetch;
  const DB = makeDb();
  let action;
  globalThis.fetch = async () => new Response("<!doctype html><html><head><title>公開規範</title></head><body>內容</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  try {
    const result = await importUrl({
      FIELD_PIN: "pin", DB,
      FILES: { async put() {}, async delete() {} },
      BROWSER: {
        async quickAction(kind, options) {
          action = { kind, options };
          return new Response(new TextEncoder().encode("%PDF-1.7 rendered"), { headers: { "content-type": "application/pdf" } });
        },
      },
    }, { url: "https://public.example.com/article" });
    assert.equal(result.status, 200);
    assert.equal(result.data.format, "webpage_pdf");
    assert.equal(result.data.filename, "公開規範.pdf");
    assert.equal(action.kind, "pdf");
    assert.equal(action.options.gotoOptions.waitUntil, "networkidle2");
    assert.equal(action.options.pdfOptions.format, "a4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v185 網址匯入查重不會查詢 attachments.deleted_at", async () => {
  const [html, app, sw, config, worker] = await Promise.all([
    readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="btn-folder-import-url"/);
  assert.match(html, /id="url-import-overlay"/);
  assert.match(app, /api\("\/import-url"/);
  assert.doesNotMatch(app.match(/function childFolderHtml[\s\S]*?\n\}/)?.[0] || "", /folderCategoryChipHtml|entry_count|folder-level-chip/);
  assert.match(sw, /fieldlog-v185-url-import-fix/);
  assert.match(config, /"browser"\s*:\s*\{\s*"binding"\s*:\s*"BROWSER"/);
  assert.doesNotMatch(worker, /a\.deleted_at/);
  assert.match(worker, /WHERE e\.folder_id = \? AND a\.content_hash = \?[\s\S]*COALESCE\(e\.deleted_at, ''\) = ''/);
});
