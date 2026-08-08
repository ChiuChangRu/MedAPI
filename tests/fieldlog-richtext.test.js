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

// ---------- 2026-08-07：「貼入 MD 檔，存檔後格式跑掉」 ----------
// 病灶不在編輯器而在這支清理函式：標題、程式碼、分隔線根本不在白名單，
// 存檔那一刻就被吃掉；Quill 2 的項目符號清單也是 <ol>，靠 <li data-list="bullet">
// 區分，data-list 一被剝掉，重新開啟整串就變成編號清單。

test("sanitizeEntryHtml: Markdown 的標題／程式碼／分隔線要留得住", () => {
  const html = "<h1>大標</h1><h3>小標</h3><pre>code()</pre><hr><p>正文</p>";
  assert.equal(sanitizeEntryHtml(html), html);
});

test("sanitizeEntryHtml: 項目符號清單的 data-list 要保留，否則會變成編號清單", () => {
  const html = '<ol><li data-list="bullet">甲</li><li data-list="ordered">乙</li></ol>';
  assert.equal(sanitizeEntryHtml(html), html);
});

test("sanitizeEntryHtml: data-list 只收 Quill 定義的值", () => {
  assert.equal(sanitizeEntryHtml('<li data-list="evil">x</li>'), "<li>x</li>");
});

test("sanitizeEntryHtml: 蠟筆重點（ql-bg-*）的 class 要留住，其他 class 一律拿掉", () => {
  assert.equal(
    sanitizeEntryHtml('<p><span class="ql-bg-yellow">重點</span></p>'),
    '<p><span class="ql-bg-yellow">重點</span></p>'
  );
  assert.equal(sanitizeEntryHtml('<p class="from-some-website">文字</p>'), "<p>文字</p>");
  assert.equal(sanitizeEntryHtml('<p class="ql-indent-1 evil">文字</p>'), '<p class="ql-indent-1">文字</p>');
});

test("sanitizeEntryHtml: style 屬性仍然一律不收（蠟筆走 class，不走行內樣式）", () => {
  assert.equal(sanitizeEntryHtml('<span style="background-color:red">x</span>'), "<span>x</span>");
});

test("sanitizeEntryHtml: 字體大小（ql-size-*）與對齊方式（ql-align-*）的 class 要留住", () => {
  assert.equal(
    sanitizeEntryHtml('<p class="ql-align-center"><span class="ql-size-huge">大字</span></p>'),
    '<p class="ql-align-center"><span class="ql-size-huge">大字</span></p>'
  );
  assert.equal(sanitizeEntryHtml('<h1 class="ql-align-right">標題</h1>'), '<h1 class="ql-align-right">標題</h1>');
});

test("htmlToPlainText: 標題與程式碼區塊後面要換行，不然匯出會整段黏在一起", () => {
  assert.equal(htmlToPlainText("<h2>章節</h2><p>內文</p>"), "章節\n內文");
  assert.equal(htmlToPlainText("<pre>code()</pre><p>說明</p>"), "code()\n說明");
  assert.equal(htmlToPlainText("<p>上</p><hr><p>下</p>"), "上\n\n---\n下");
});
