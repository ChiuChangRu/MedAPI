/**
 * v230 左側欄「常用連結」：與首頁「常用網頁」同一份清單，載入與儲存後都同步重畫。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("側欄有常用連結區塊，與首頁常用網頁同步", async () => {
  const [html, app] = await Promise.all([read("../fieldlog/public/index.html"), read("../fieldlog/public/app.js")]);
  const nav = html.slice(html.indexOf('id="desktop-explorer-nav"'), html.indexOf("</aside>"));
  assert.match(nav, /id="desktop-links"/);
  assert.ok(nav.indexOf('id="desktop-links"') > nav.indexOf('id="desktop-pending"'), "放在待分類下面");
  assert.ok(nav.indexOf('id="desktop-links"') < nav.indexOf('id="desktop-folder-tree"'), "放在資料夾分類上面");
  const load = app.match(/async function loadLinksWidget\(\)[\s\S]*?\n}/)[0];
  const save = app.match(/async function saveLinks\(list\)[\s\S]*?\n}/)[0];
  assert.match(load, /renderSidebarLinks\(\)/);
  assert.match(save, /renderSidebarLinks\(\)/);
  assert.match(app, /target="_blank" rel="noopener"[^`]*desktop-link-mark|desktop-link-row" href="\$\{esc\(l\.url\)\}" target="_blank" rel="noopener"/);
});
