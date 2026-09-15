import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");

test("資料夾附件摘要帶回輕量轉錄狀態，不傳送完整逐字稿", () => {
  assert.match(worker, /transcribed_at,/);
  assert.match(worker, /AS has_transcript/);
  const folderSummary = worker.match(/SELECT id, entry_id, kind, filename[\s\S]*?FROM attachments WHERE entry_id IN/);
  assert.ok(folderSummary);
  assert.doesNotMatch(folderSummary[0], /,\s*transcript\s*(?:,|\n)/);
});

test("已有逐字稿的錄音不會被資料夾補轉誤標成轉錄中", () => {
  assert.match(app, /function attachmentHasTranscript\(item\)/);
  assert.match(app, /Number\(item\?\.has_transcript \|\| 0\) === 1/);
  assert.match(app, /&& !attachmentHasTranscript\(item\)/);
});

test("補轉請求即使 processed=0 也重新同步徽章", () => {
  assert.match(app, /不論這次是否實際處理，都重新讀一次真實狀態/);
  assert.match(app, /await openFolder\(folderId\);/);
  assert.doesNotMatch(app, /if \(result\.processed \|\| result\.failed \|\| result\.stopped\) await openFolder/);
});
