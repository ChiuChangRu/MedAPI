import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");
const index = await readFile(new URL("../fieldlog/public/index.html", import.meta.url), "utf8");
const sw = await readFile(new URL("../fieldlog/public/sw.js", import.meta.url), "utf8");

test("手機版載入最新版殼與快取", () => {
  assert.match(app, /const APP_VERSION = "149"/);
  assert.match(index, /app\.js\?v=149/);
  assert.match(index, /style\.css\?v=149/);
  assert.match(sw, /app\.js\?v=149/);
  assert.match(sw, /style\.css\?v=149/);
});

test("手機寬度不顯示桌機側欄，沿用可操作的單欄資料夾清單", () => {
  assert.match(css, /\.desktop-explorer-nav \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 720px\) \{[\s\S]*\.desktop-explorer-nav \{/);
  assert.match(app, /data-act="add-child"/);
  assert.match(app, /data-act="move"/);
  assert.match(app, /data-act="merge"/);
  assert.match(app, /data-act="delete"/);
  assert.match(css, /@media \(max-width: 719px\) \{[\s\S]*\.folder-card-main/);
});
