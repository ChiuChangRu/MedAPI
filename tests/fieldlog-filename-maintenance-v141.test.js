import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../fieldlog/src/lib/schema.js", import.meta.url), "utf8");

test("檔名整理不再由資料夾頁或記事編輯頁手動觸發", () => {
  assert.doesNotMatch(html, /btn-cleanup-filenames/);
  assert.doesNotMatch(app, /runLegacyCleanupOnce|cleanupFilenames|e-rename-files/);
  assert.doesNotMatch(app, /attachments\/rename-existing/);
});

test("每日排程以 D1 維護版本保證舊附件整理只成功執行一次", () => {
  assert.match(worker, /const FILENAME_MAINTENANCE_KEY = "maintenance\.filename_cleanup"/);
  assert.match(worker, /SELECT value FROM settings WHERE key = \?/);
  assert.match(worker, /if \(state\?\.value === FILENAME_MAINTENANCE_VERSION\)/);
  assert.match(worker, /await runFilenameMaintenanceOnce\(env\)/);
  assert.match(worker, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
  assert.match(schema, /後臺維護版本標記/);
});

test("後臺檔名整理沿用規則式端點而不是 Cloudflare AI", () => {
  const start = worker.indexOf("async function runFilenameMaintenanceOnce");
  const end = worker.indexOf("\nexport default", start);
  const maintenance = worker.slice(start, end);
  assert.match(maintenance, /attachments\/rename-existing/);
  assert.doesNotMatch(maintenance, /env\.AI|AI\.run|Workers AI/);
});
