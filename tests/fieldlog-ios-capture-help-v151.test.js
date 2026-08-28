import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const index = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const sw = await readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8");
const help = await readFile(new URL("../fieldlog/public/help.html", import.meta.url), "utf8");

test("v156 強制檢查新 service worker 與說明頁", () => {
  assert.match(app, /register\("sw\.js\?v=156"\)\.then\(\(registration\) => registration\.update\(\)\)/);
  assert.match(index, /help\.html\?v=156/);
  assert.match(sw, /help\.html\?v=156/);
});

test("最新版說明涵蓋資料架構、搬移、垃圾桶與裝置限制", () => {
  for (const text of ["八個工作主目錄", "最多四層", "來源資料夾會消失", "小型載入視窗", "垃圾桶保留 60 天", "AI導用", "v156"]) {
    assert.ok(help.includes(text), `使用說明應包含：${text}`);
  }
  assert.match(help, /iPhone／iPad[\s\S]*切走，系統會結束並保存已錄內容/);
  assert.doesNotMatch(help, /回到 MyWiki 後會自動接續/);
});
