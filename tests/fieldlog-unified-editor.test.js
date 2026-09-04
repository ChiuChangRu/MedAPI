import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("首頁先啟動 MyWiki，選用 CDN 不再阻塞 3% 載入畫面", async () => {
  const index = await read("../fieldlog/public/index.html");
  const appPosition = index.indexOf('<script src="app.js?v=168"></script>');
  const pdfPosition = index.indexOf("pdfjs-dist@3.11.174/build/pdf.min.js");
  const quillPosition = index.indexOf("quill@2.0.3/dist/quill.js");

  assert.ok(appPosition >= 0, "應載入 v168 首頁程式");
  assert.ok(pdfPosition > appPosition, "PDF.js 必須在首頁程式之後");
  assert.ok(quillPosition > appPosition, "Quill 必須在首頁程式之後");
  assert.match(index, /<script async src="https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@3\.11\.174\/build\/pdf\.min\.js"><\/script>/);
  assert.match(index, /<script async src="https:\/\/cdn\.jsdelivr\.net\/npm\/quill@2\.0\.3\/dist\/quill\.js"><\/script>/);
  assert.match(index, /quill\.snow\.css"\s+media="print" onload="this\.media='all'"/);
});

test("一般記事不再依資料夾類型產生上海參展式專用欄位", async () => {
  const app = await read("../fieldlog/public/app.js");
  const editor = app.match(/async function showEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function attachmentWithText/)?.[0] || "";
  assert.ok(editor, "應能定位桌機右欄編輯流程");
  assert.doesNotMatch(editor, /template\.map/);
  assert.match(editor, /const fields = visibleEntryFields\(entry\)/);
  assert.match(editor, /body\.querySelectorAll\("textarea\[data-field\]"\)/);
  assert.match(editor, /await api\(`\/entries\/\$\{entryId\}`/);
});

test("桌機記事只有同一個右欄 Word 畫面，附件仍使用右欄預覽及編輯", async () => {
  const app = await read("../fieldlog/public/app.js");
  const index = await read("../fieldlog/public/index.html");

  assert.match(index, /id="folder-preview"/);
  assert.match(app, /async function showEntryPreview\(entryId\)/);
  assert.match(app, /async function showEntryEditor\(entryId\)/);
  const preview = app.match(/async function showEntryPreview\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(preview, /return showEntryEditor\(entryId\)/);
  assert.doesNotMatch(app, /async function renderEntryPreview/);
  assert.doesNotMatch(app, /entry-side-preview/);
  assert.match(app, /async function showFilePreview\(/);
  assert.match(app, /async function showFileEditor\(entryId, attachmentId\)/);
  assert.match(app, /if \(!PREVIEW_ENABLED \|\| !matchMedia\("\(min-width: 1000px\)"\)\.matches\) return openEntry\(entryId\)/);
  assert.match(app, /if \(usesDesktopRightPane\(\)\) return showEntryEditor\(entryId\)/);
  assert.match(app, /if \(usesDesktopRightPane\(\)\) return showFileEditor\(entryId, attachmentId\)/);
  assert.match(app, /return withViewLoading\("正在載入編輯欄…"/);
  assert.match(app, /return withViewLoading\("正在載入檔案編輯欄…"/);
});

test("錄音卡直接開啟同一份 Word 文件，原始資料集中在 ⋯ 管理", async () => {
  const app = await read("../fieldlog/public/app.js");
  const recordingPreview = app.match(/async function showRecordingPreview\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  const recordingEditor = app.match(/async function openRecordingEditor\(entryId\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(recordingPreview, /showEntryEditor\(entryId\)/);
  assert.match(recordingEditor, /showEntryEditor\(entryId\)/);
  assert.match(app, /async function openRecordingManager\(entryId\)/);
  assert.match(app, /依時間軸整理圖文/);
  assert.match(app, /人工修改過的 Word 文件不會被覆蓋/);
});

test("桌機右欄的一般記事統一使用 Word 類富文字編輯器", async () => {
  const [app, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  const editor = app.match(/async function renderEntryEditor\(entryId\)[\s\S]*?\n}\n\nasync function showRecordingPreview/)?.[0] || "";
  assert.ok(editor, "應能定位桌機右欄記事編輯器");
  assert.match(editor, /id="preview-entry-rich"/);
  assert.match(editor, /setFolderPreviewTitle\(entry\.title \|\| "記事", !isWeeklyReport\)/,
    "文件名稱只能在右欄頂部出現並直接編輯");
  assert.doesNotMatch(editor, /id="preview-entry-title"/,
    "白紙內不得再產生第二個文件名稱");
  assert.match(editor, /fieldlogRichEditor\?\.init/);
  assert.match(editor, /toolbarHost: \$\("folder-preview-editor-toolbar"\)/,
    "格式工具列要放在右欄頂部，不得留在白紙內容內");
  assert.match(editor, /textToHtmlForEditor\(entry\.body \|\| ""\)/,
    "舊純文字記事要直接載入同一編輯器");
  assert.match(editor, /patch\.body_format = "html"/,
    "一般記事儲存後要統一成富文字格式");
  assert.doesNotMatch(editor, /舊版富文字資料|舊內文維持唯讀/,
    "富文字記事不能再被錯誤鎖成唯讀");
  assert.match(css, /\.word-note-page/);
  assert.match(css, /\.word-rich-editor \.ql-editor/);
  assert.match(css, /\.word-note-editor \{[\s\S]*overflow: visible/,
    "記事表面不得建立第二個捲軸");
});

test("Word 編輯器不把 1.、-、* 自動轉成清單，工具列清單仍保留", async () => {
  const editor = await read("../fieldlog/public/richtext-editor.js");
  assert.match(editor, /"list autofill": \{/,
    "要用 Quill 的同名 keyboard binding 覆寫內建自動清單");
  assert.match(editor, /prefix: \/\(\?!\)\//,
    "自動清單 binding 必須使用不可能匹配的 prefix");
  assert.match(editor, /keyboard: \{ bindings: KEYBOARD_BINDINGS \}/,
    "覆寫必須在 Quill 初始化時注入，初始化後新增會晚於內建 binding");
  assert.match(editor, /\[\{ list: "ordered" \}, \{ list: "bullet" \}\]/,
    "手動編號與項目符號按鈕仍要保留");
});

test("首頁記事直接建立 HTML 草稿並開啟同一套 Word 編輯器", async () => {
  const app = await read("../fieldlog/public/app.js");
  const quick = app.match(/async function quickNote\(\)[\s\S]*?\n}\n\n\/\*\* 快速備忘/)?.[0] || "";
  assert.ok(quick, "應能定位首頁記事流程");
  assert.match(quick, /body_format: "html"/,
    "首頁記事必須直接使用 HTML 格式，不能再建立簡易純文字記事");
  assert.match(quick, /await openEntry\(Number\(created\.id\)\)/,
    "建立草稿後要開啟全系統共用的記事編輯器");
  assert.doesNotMatch(quick, /openEditModal/,
    "首頁記事不能再使用舊簡易文字框");
});

test("Word 工具列有安全插圖按鈕，圖片先上傳附件而不是內嵌 base64", async () => {
  const editor = await read("../fieldlog/public/richtext-editor.js");
  assert.match(editor, /\["blockquote", "code-block", "link", "image"\]/,
    "工具列要顯示插入圖片按鈕");
  assert.match(editor, /addHandler\("image"/,
    "要覆寫 Quill 內建的 base64 圖片處理");
  assert.match(editor, /picker\.accept = "image\/\*"/);
  assert.match(editor, /picker\.multiple = true/);
  assert.match(editor, /從相簿選擇圖片/);
  assert.match(editor, /opts\.onImagePaste\(file\)/,
    "選到的圖片要交給既有 R2 上傳與附件插入流程");
});

test("桌機編輯器把儲存移到上方工具列，不再用底部固定操作列", async () => {
  const [app, index, css] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
    read("../fieldlog/public/style.css"),
  ]);
  assert.match(index, /id="folder-preview-save"[^>]*hidden/);
  assert.match(app, /\$\("folder-preview-save"\)\.onclick = \(\) => \$\("entry-preview-editor"\)\.requestSubmit\(\)/);
  assert.doesNotMatch(app, /class="preview-editor-actions"/,
    "記事、檔案與錄音編輯器都不應再各自產生底部儲存列");
  assert.doesNotMatch(css, /\.preview-editor-actions/);
});

test("右欄提供窄、標準、寬選單並保留拖曳微調", async () => {
  const [app, index] = await Promise.all([
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/index.html"),
  ]);
  assert.match(index, /id="folder-preview-width"/);
  for (const option of ["40", "60", "80"]) assert.match(index, new RegExp(`value="${option}"`));
  assert.match(app, /function applyPreviewWidthMode\(mode, persist = false\)/);
  assert.match(app, /widthSelect\.onchange = \(\) => applyPreviewWidthMode/);
  assert.match(app, /handle\.addEventListener\("pointerdown"/);
});

test("Markdown 維持安全的輸入轉格式，不提供會遺失附件的原始碼雙向切換", async () => {
  const [editor, help] = await Promise.all([
    read("../fieldlog/public/richtext-editor.js"),
    read("../fieldlog/public/help.html"),
  ]);
  assert.match(editor, /function mdToHtml\(src\)/);
  assert.match(editor, /looksLikeMarkdown\(text\)/);
  assert.match(help, /Word／Markdown 原始碼雙向切換/);
  assert.match(help, /圖片、附件與複雜格式/);
});
