import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAudioZipStream, recordingZipFilename } from "../fieldlog/src/lib/audio-zip.js";

const inspector = readFileSync(new URL("../fieldlog/public/inspector.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../fieldlog/src/worker.js", import.meta.url), "utf8");

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("錄音預覽提供一鍵下載該筆紀錄全部音檔", () => {
  assert.match(inspector, /一鍵下載全部錄音（\$\{audio\.length\} 段 ZIP）/);
  assert.match(inspector, /\/api\/entries\/\$\{entry\.id\}\/audio\.zip/);
  assert.match(worker, /entryAudioZipMatch/);
  assert.match(worker, /kind = 'audio' AND source_pdf_id IS NULL/);
});

test("ZIP 逐段串流，包含 UTF-8 檔名、資料與中央目錄", async () => {
  const files = [
    { filename: "課程錄音.webm", key: "a", created_at: "2026-09-14T01:02:03Z" },
    { filename: "第二段.m4a", key: "b", created_at: "2026-09-14T01:12:03Z" },
  ];
  const data = { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5]) };
  const zip = await streamBytes(createAudioZipStream(files, async (file) => ({ body: new Blob([data[file.key]]).stream() })));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(zip.toString("utf8"), /001_課程錄音\.webm/);
  assert.match(zip.toString("utf8"), /002_第二段\.m4a/);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
});

test("下載包名稱移除作業系統不允許的字元", () => {
  assert.equal(recordingZipFilename('A/B:課程?'), "A B 課程_全部錄音.zip");
});
