import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import {
  detectNativeTextKind,
  extractNativeText,
} from "../cloudflare/src/imageSkill.js";

// ---------- 手刻一個「真正合法」的 zip（含真正的 deflate 壓縮），
// 拿來測試我們自己寫的 zip reader（不依賴任何外部套件，也沒有真的 .docx 檔案可讀）----------

function crc32(buf) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.from(content, "utf8");
    const compressed = deflateRawSync(dataBuf);
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, compressed]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += localEntry.length;
  }
  const localDir = Buffer.concat(localParts);
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localDir.length, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([localDir, centralDir, eocd]));
}

test("detectNativeTextKind 依副檔名／mime 判斷", () => {
  assert.equal(detectNativeTextKind("report.docx", ""), "docx");
  assert.equal(detectNativeTextKind("data.xlsx", ""), "xlsx");
  assert.equal(detectNativeTextKind("slides.pptx", ""), "pptx");
  assert.equal(detectNativeTextKind("note.txt", ""), "text");
  assert.equal(detectNativeTextKind("note.CSV", ""), "text");
  assert.equal(detectNativeTextKind("old.doc", ""), "legacy-office");
  assert.equal(detectNativeTextKind("old.xls", ""), "legacy-office");
  assert.equal(detectNativeTextKind("photo.jpg", "image/jpeg"), null);
  assert.equal(detectNativeTextKind("noext", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
});

test("純文字檔直接解碼，不需要 zip", async () => {
  const text = await extractNativeText("text", new TextEncoder().encode("親水塗層 UV 固化\n第二行"));
  assert.equal(text, "親水塗層 UV 固化\n第二行");
});

test("legacy-office（.doc/.xls/.ppt 舊格式）給友善指引而不是系統錯誤", async () => {
  await assert.rejects(
    () => extractNativeText("legacy-office", new Uint8Array()),
    /另存成新格式/,
  );
});

test("損毀／非 zip 內容擷取時明確報錯，不會靜默回空字串", async () => {
  await assert.rejects(() => extractNativeText("docx", new Uint8Array([1, 2, 3, 4])), /zip/);
});

test("docx：多段落、多 run、XML 實體都正確還原", async () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>` +
    `<w:p><w:r><w:t>親水塗層測試報告</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">固化溫度 &amp; 時間：80</w:t></w:r><w:r><w:t>°C、30 分鐘</w:t></w:r></w:p>` +
    `</w:body></w:document>`;
  const zip = buildZip([{ name: "word/document.xml", content: xml }]);
  const text = await extractNativeText("docx", zip);
  assert.equal(text, "親水塗層測試報告\n固化溫度 & 時間：80°C、30 分鐘");
});

test("docx：讀不到 word/document.xml 時明確報錯", async () => {
  const zip = buildZip([{ name: "other.xml", content: "<x/>" }]);
  await assert.rejects(() => extractNativeText("docx", zip), /document\.xml/);
});

test("pptx：多張投影片依編號排序，各自標出投影片編號", async () => {
  const slide1 = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>標題投影片</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const slide2 = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二頁重點</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  // 刻意用「10」跟「2」測數字排序而不是字串排序（字串排序會把 10 排在 2 前面）
  const zip = buildZip([
    { name: "ppt/slides/slide2.xml", content: slide2 },
    { name: "ppt/slides/slide10.xml", content: slide1 },
  ]);
  const text = await extractNativeText("pptx", zip);
  const idx2 = text.indexOf("投影片 2");
  const idx10 = text.indexOf("投影片 10");
  assert.ok(idx2 >= 0 && idx10 > idx2, text);
  assert.match(text, /第二頁重點/);
  assert.match(text, /標題投影片/);
});

test("xlsx：共用字串與 inline/數值儲存格都正確組成 tab 分隔文字", async () => {
  const shared = `<sst><si><t>廠商</t></si><si><t>親水塗層</t></si></sst>`;
  const sheet = `<worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>百賽飛</t></is></c><c r="B2"><v>80</v></c></row>` +
    `</sheetData></worksheet>`;
  const zip = buildZip([
    { name: "xl/sharedStrings.xml", content: shared },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
  const text = await extractNativeText("xlsx", zip);
  assert.equal(text, "== 工作表 1 ==\n廠商\t親水塗層\n百賽飛\t80");
});

test("xlsx：多個工作表依編號排序", async () => {
  const sheet1 = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>`;
  const zip = buildZip([
    { name: "xl/worksheets/sheet2.xml", content: sheet2 },
    { name: "xl/worksheets/sheet1.xml", content: sheet1 },
  ]);
  const text = await extractNativeText("xlsx", zip);
  assert.ok(text.indexOf("工作表 1") < text.indexOf("工作表 2"), text);
});
