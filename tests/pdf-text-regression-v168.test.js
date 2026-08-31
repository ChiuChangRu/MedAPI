import assert from "node:assert/strict";
import test from "node:test";

import { stripPdfMetadata } from "../cloudflare/src/imageSkill.js";

test("PDF metadata：只移除檔名與 Metadata，不吃掉真正本文", () => {
  const raw = [
    "# Lipidure-ＣＭ5206_紹介資料(英語版)_170623.pdf",
    "",
    "## Metadata",
    "- PDFFormatVersion=1.4",
    "- Creator=PowerPoint",
    "",
    "# MPC polymer for medical device",
    "# Lipidure®-CM5206",
    "Revised date : May, 2016",
  ].join("\n");
  const text = stripPdfMetadata(raw);
  assert.match(text, /MPC polymer for medical device/);
  assert.match(text, /Lipidure®-CM5206/);
  assert.doesNotMatch(text, /PDFFormatVersion/);
});

test("PDF metadata：沒有 Metadata 時，開頭 H1 是本文，不能整段跳過", () => {
  const raw = [
    "# MPC polymer for medical device",
    "# Lipidure®-CM5206",
    "# 1-1 What is MPC ?",
    "# Feature of PC Group",
  ].join("\n");
  assert.equal(stripPdfMetadata(raw), raw);
});

test("PDF metadata：純頁面骨架仍視為沒有可搜尋文字", () => {
  const raw = [
    "# file.pdf",
    "## Metadata",
    "- PDFFormatVersion=1.7",
    "",
    "## Contents",
    "### Page 1",
    "### Page 2",
  ].join("\n");
  assert.equal(stripPdfMetadata(raw), "");
});
