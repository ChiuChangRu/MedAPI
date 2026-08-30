import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
const help = await readFile(new URL("../fieldlog/public/help.html", import.meta.url), "utf8");

test("擴充功能優先用目前分頁列印 PDF，失敗時仍送安全 HTML", () => {
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.match(serviceWorker, /Page\.printToPDF/);
  assert.match(serviceWorker, /querySelectorAll\("script,noscript,iframe,object,embed,form/);
  assert.match(serviceWorker, /pdf_base64: pdfBase64/);
  assert.match(serviceWorker, /PDF 無法建立，正在改存 HTML/);
});

test("MyWiki clips 端點驗證網址與大小並保存正文、來源及附件", () => {
  assert.match(worker, /path === "\/clips" && method === "POST"/);
  assert.match(worker, /source: "browser_clip"/);
  assert.match(worker, /PDF 超過剪藏上限 15MB/);
  assert.match(worker, /clip_format: "html", pdf_error/);
  assert.match(worker, /destination: folderId \? "folder" : "pending"/);
});

test("v166 使用說明提供擴充功能下載與 PDF／HTML 備援規則", () => {
  assert.match(help, /downloads\/mywiki-clip-v1\.zip/);
  assert.match(help, /優先保存 PDF/);
  assert.match(help, /自動改存安全 HTML/);
  assert.match(help, /v166/);
});
