import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  foldSnippet,
  foldText,
  stripPdfMetadata as stripMcpPdfMetadata,
} from "../mcp/src/textFold.js";
import {
  collapseRepeats,
  dedupeRepetition,
  detectRepetitionLoop,
  stripPdfMetadata as stripImagePdfMetadata,
} from "../fieldlog/src/imageSkill.js";

test("繁簡、全半形與大小寫可摺疊成一致搜尋文字", () => {
  assert.equal(foldText("親水塗層ＡＢＣ"), "亲水涂层abc");
  assert.equal(foldText("醫療導管"), foldText("医疗导管"));
});

test("摺疊搜尋仍回傳原始繁體片段", () => {
  const raw = "供應商提供親水塗層與抗菌導管的測試資料";
  const snippet = foldSnippet(raw, foldText("亲水涂层"), 8);
  assert.match(snippet, /親水塗層/);
});

test("MCP 與影像模組都會剝除 PDF metadata", () => {
  const input = "# brochure.pdf\n\n## Metadata\n- Creator=Affinity\n- PDFFormatVersion=1.7\n\n## 本文\n親水塗層資料";
  const expected = "## 本文\n親水塗層資料";
  assert.equal(stripMcpPdfMetadata(input), expected);
  assert.equal(stripImagePdfMetadata(input), expected);
});

test("只有頁面標題而沒有本文的 PDF 視為無內容", () => {
  const input = "# scan.pdf\n## Metadata\n- Creator=Scanner\n\n## Contents\n### Page 1\n### Page 2";
  assert.equal(stripMcpPdfMetadata(input), "");
  assert.equal(stripImagePdfMetadata(input), "");
});

test("OCR 重複迴圈可偵測並搶救", () => {
  const repeated = Array(12).fill("加入導管測試液中").join("\n");
  assert.equal(detectRepetitionLoop(repeated), true);
  assert.ok(collapseRepeats("[看不清] [看不清] [看不清]").length < 20);
  const salvaged = dedupeRepetition(repeated);
  assert.match(salvaged, /已自動截斷/);
});

test("Medtec 與 fieldlog 共用的 imageSkill 保持逐位元一致", async () => {
  const [medtec, fieldlog] = await Promise.all([
    readFile(new URL("../cloudflare/src/imageSkill.js", import.meta.url), "utf8"),
    readFile(new URL("../fieldlog/src/imageSkill.js", import.meta.url), "utf8"),
  ]);
  assert.equal(medtec, fieldlog);
});
