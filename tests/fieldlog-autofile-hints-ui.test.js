/**
 * 首頁的「🤖 分類規則建議」通知面板——候選規則不會自己生效，這裡檢查前端
 * 真的有把「通知使用者、讓人補關鍵字採用」這件事接上線，不是後端做完
 * 就沒了。跟這個專案其他前端測試一致：沒有 DOM 可以真的渲染，檢查原始碼
 * 裡的關鍵接線在不在。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("index.html 有分類規則建議面板的容器", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="autofile-hints-panel"/);
});

test("loadStagingStatus 看到 pending_hints 才去抓候選規則詳情，沒有就清空面板", async () => {
  const app = await read("../fieldlog/public/app.js");
  const fn = app.match(/async function loadStagingStatus[\s\S]*?\n}\n/)[0];
  assert.match(fn, /if \(status\.pending_hints\) loadAutoFileHintSuggestions\(\); else renderAutoFileHintSuggestions\(\[\]\);/);
});

test("每條建議都要有關鍵字輸入框＋採用／忽略，且採用時要真的帶著填的關鍵字送出", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /class="autofile-hint-keyword"/, "要有讓使用者填關鍵字的欄位");
  const approve = app.match(/panel\.querySelectorAll\("\.autofile-hint-approve"\)[\s\S]*?\n {2}\}\);/)[0];
  assert.match(approve, /if \(!keyword\)/, "沒填關鍵字不能送出");
  assert.match(approve, /\/auto-file\/hints\/\$\{btn\.dataset\.id\}\/approve/);
  assert.match(approve, /body: JSON\.stringify\(\{ keyword \}\)/);
  const reject = app.match(/panel\.querySelectorAll\("\.autofile-hint-reject"\)[\s\S]*?\n {2}\}\);/)[0];
  assert.match(reject, /confirm\(/, "忽略要先跟使用者確認，不能點錯就消失");
  assert.match(reject, /method: "DELETE"/);
});
