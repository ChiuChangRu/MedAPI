/**
 * fieldlog/src/lib/richtext.js — entries.body_format = 'html' 的共用處理函式。
 * 純函式，不碰資料庫，直接測輸出。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { htmlToPlainText, sanitizeEntryHtml, textToHtml } from "../fieldlog/src/lib/richtext.js";

test("htmlToPlainText: 一般段落與換行轉成純文字", () => {
  const html = "<p>第一段</p><p>第二行<br>第三行</p>";
  assert.equal(htmlToPlainText(html), "第一段\n第二行\n第三行");
});

test("htmlToPlainText: <img alt> 轉成圖片標註", () => {
  const html = '<p>看這張</p><img src="/api/file/abc" alt="收據.jpg">';
  assert.equal(htmlToPlainText(html), "看這張\n[圖片：收據.jpg]");
});

test("htmlToPlainText: 沒有 alt 的 <img> 轉成通用標註", () => {
  const html = '<img src="/api/file/abc">';
  assert.equal(htmlToPlainText(html), "[圖片]");
});

test("htmlToPlainText: 不合法/危險標籤被整個拿掉（含內容）", () => {
  const html = "<p>正文</p><script>alert(1)</script><style>.x{}</style>";
  assert.equal(htmlToPlainText(html), "正文");
});

test("htmlToPlainText: HTML entity 解碼", () => {
  assert.equal(htmlToPlainText("<p>A&amp;B &lt;test&gt; &quot;q&quot;</p>"), 'A&B <test> "q"');
});

test("htmlToPlainText: 空白輸入回傳空字串", () => {
  assert.equal(htmlToPlainText(""), "");
  assert.equal(htmlToPlainText(null), "");
  assert.equal(htmlToPlainText("<p><br></p>"), "");
});

test("sanitizeEntryHtml: 允許的標籤與屬性保留", () => {
  const html = '<p>文字<strong>粗體</strong></p><img src="/api/file/x" alt="a" data-att-id="5">';
  assert.equal(sanitizeEntryHtml(html), '<p>文字<strong>粗體</strong></p><img src="/api/file/x" alt="a" data-att-id="5">');
});

test("sanitizeEntryHtml: 不在白名單的標籤被移除但保留文字內容", () => {
  const html = '<div onclick="evil()">文字</div><p>正常</p>';
  assert.equal(sanitizeEntryHtml(html), "文字<p>正常</p>");
});

test("sanitizeEntryHtml: script/style 連內容一起移除", () => {
  const html = "<script>alert(1)</script><p>正常</p>";
  assert.equal(sanitizeEntryHtml(html), "<p>正常</p>");
});

test("sanitizeEntryHtml: 不在白名單的屬性被拿掉", () => {
  const html = '<p onclick="evil()" style="color:red">文字</p>';
  assert.equal(sanitizeEntryHtml(html), "<p>文字</p>");
});

test("sanitizeEntryHtml: javascript: 連結被擋掉", () => {
  const html = '<a href="javascript:alert(1)">連結</a>';
  assert.equal(sanitizeEntryHtml(html), "<a>連結</a>");
});

test("sanitizeEntryHtml: HTML 註解被清掉（body_format=html 不承載同步標記）", () => {
  const html = "<!-- sync:start --><p>文字</p><!-- sync:end -->";
  assert.equal(sanitizeEntryHtml(html), "<p>文字</p>");
});

test("textToHtml: 空白分隔段落，單一換行變 <br>", () => {
  assert.equal(textToHtml("第一行\n第二行\n\n第二段"), "<p>第一行<br>第二行</p><p>第二段</p>");
});

test("textToHtml: 轉義 HTML 特殊字元", () => {
  assert.equal(textToHtml("A & B <tag>"), "<p>A &amp; B &lt;tag&gt;</p>");
});

test("textToHtml: 空字串回傳空字串", () => {
  assert.equal(textToHtml(""), "");
  assert.equal(textToHtml("   "), "");
});
