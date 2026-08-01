/**
 * 富文字編輯框貼上剪貼簿圖片（例如螢幕截圖後直接 Ctrl+V）。
 *
 * 這裡沒有瀏覽器/DOM 環境可以真的觸發 paste 事件並操作 Quill，所以用跟這個
 * 專案既有前端測試一致的做法：直接檢查原始碼裡的關鍵邏輯有沒有接上，確保
 * 「攔截圖片貼上、不讓 Quill 用預設的 base64 內嵌」與「app.js 有把貼上事件
 * 接回既有的上傳＋插圖流程」這兩件事都在，不是規劃了卻忘記接線。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("richtext-editor.js：貼上圖片時要攔截並阻止 Quill 預設的 base64 內嵌", async () => {
  const src = await readFile(new URL("../fieldlog/public/richtext-editor.js", import.meta.url), "utf8");
  assert.match(src, /addEventListener\("paste"/, "要監聽貼上事件");
  assert.match(src, /it\.kind === "file" && \(it\.type \|\| ""\)\.startsWith\("image\/"\)/, "要判斷剪貼簿內容是不是圖片檔");
  const pasteHandler = src.match(/quill\.root\.addEventListener\("paste"[\s\S]*?\n\s*\}\);/)?.[0] || "";
  assert.match(pasteHandler, /ev\.preventDefault\(\)/, "偵測到圖片要 preventDefault，不能讓 Quill 用預設行為把圖片轉成 base64 塞進 body");
  assert.match(pasteHandler, /opts\.onImagePaste\(file\)/, "要把貼上的檔案交給呼叫端處理（上傳＋插圖）");
});

test("app.js：openEntry 對富文字記事有接上 onImagePaste，重用既有的上傳＋插圖流程", async () => {
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  assert.match(
    app,
    /onImagePaste:\s*\(file\)\s*=>\s*insertFilesIntoRichEditor\(id,\s*\$\("e-body-rich"\),\s*\[file\]\)/,
    "貼上圖片要走跟拖曳圖片同一套 insertFilesIntoRichEditor（putFile 建附件＋插入 <img>），不是另外重寫一次"
  );
});
