/**
 * 2026-10-02 實際回報（附截圖）：資料夾內頁切成「清單」模式時，子資料夾／
 * 單一檔案／錄音資料包／純文字筆記四種列混在同一份清單裡，彼此的「圖示到
 * 名稱」間距不一致，標題忽左忽右，整份清單看起來「對齊亂七八糟」。
 *
 * 根因：
 *   - 子資料夾／錄音資料包的圖示欄沒有固定寬度（只有 font-size，實際寬度
 *     隨 emoji 字符不同而變），跟單一檔案列固定 24px 的圖示欄對不齊。
 *   - 純文字筆記（entryRowHtml）在資料夾清單裡完全沒有圖示，標題直接貼齊
 *     列的 padding-left，比其他三種列整整少了一個圖示欄＋間距的寬度。
 *
 * 修法：四種列在清單模式下一律是「padding 10px → 24px 寬圖示欄 → 7px 間距
 * → 名稱」，筆記補上一個只在資料夾清單（explorer:true）出現的圖示，不影響
 * 首頁「待處理」等其他沿用同一支 entryRowHtml() 的畫面。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("entryRowHtml：explorer 模式才會補圖示，首頁「待處理」等其他畫面不受影響", () => {
  const fn = app.match(/function entryRowHtml\(e, \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /const explorerIcon = explorer \? `<span class="entry-explorer-icon">🗒️<\/span>` : "";/);
  assert.match(fn, /\$\{explorerIcon\}/, "要真的把圖示插進輸出的 HTML 裡，不能宣告了卻沒用到");
});

test("entry-explorer-icon 預設隱藏，只在資料夾清單的清單模式顯示", () => {
  assert.match(css, /\.entry-explorer-icon \{ display: none; \}/,
    "沒有這行的話，圖示會在首頁待處理、詳細模式、卡片模式等沒設計過的地方跑出來");
  assert.match(css, /\.folder-content-list\.list-view > \.entry-row > \.entry-explorer-icon \{[\s\S]*?display: inline-flex;/);
});

test("清單模式下，四種列（子資料夾／錄音資料包／單一檔案／筆記）的圖示欄寬度完全一致", () => {
  // 子資料夾／錄音資料包共用同一條選取器：flex 版面，圖示是 <span>
  const folderOrRecordIcon = css.match(
    /\.folder-content-list\.list-view > \.child-folder-card > span,\n\.folder-content-list\.list-view > \.record-group-card > span \{([^}]*)\}/
  )[1];
  assert.match(folderOrRecordIcon, /width:\s*24px/);
  assert.match(folderOrRecordIcon, /font-size:\s*18px/);

  // 單一檔案：grid 版面，圖示欄寬度是 grid-template-columns 的第一個值
  const fileRow = css.match(/\.folder-content-list\.list-view > \.folder-file-row \{([^}]*)\}/)[1];
  assert.match(fileRow, /grid-template-columns:\s*24px minmax\(0, 1fr\)/);
  const fileIcon = css.match(/\.folder-content-list\.list-view > \.folder-file-row \.folder-file-icon \{([^}]*)\}/)[1];
  assert.match(fileIcon, /font-size:\s*18px/);

  // 筆記：新補的圖示
  const noteIcon = css.match(/\.folder-content-list\.list-view > \.entry-row > \.entry-explorer-icon \{([^}]*)\}/)[1];
  assert.match(noteIcon, /width:\s*24px/);
  assert.match(noteIcon, /font-size:\s*18px/);

  // 三種圖示欄的 gap、padding 也要一致，不然算出來的「名稱起始位置」還是會錯開
  const folderOrRecordRow = css.match(
    /\.folder-content-list\.list-view > \.child-folder-card,\n\.folder-content-list\.list-view > \.record-group-card \{([^}]*)\}/
  )[1];
  assert.match(folderOrRecordRow, /gap:\s*7px/);
  assert.match(folderOrRecordRow, /padding:\s*6px 10px/);
  assert.match(fileRow, /gap:\s*7px/);
  assert.match(fileRow, /padding:\s*6px 10px/);
  const entryRow = css.match(/\.folder-content-list\.list-view > \.entry-row \{([^}]*)\}/)[1];
  assert.match(entryRow, /gap:\s*7px/);
  assert.match(entryRow, /padding:\s*6px 10px/);
});
