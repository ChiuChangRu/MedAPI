/**
 * 桌機側欄（.desktop-explorer-nav）可以用滑鼠拖曳調整寬度，並記住使用者
 * 選的寬度。檢查原始碼裡的關鍵接線在不在，不用真的跑 DOM（跟其他 fieldlog
 * UI 測試同一套做法）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("index.html：側欄有拖曳把手，role=separator 給鍵盤／輔助科技用", async () => {
  const html = await read("../fieldlog/public/index.html");
  assert.match(html, /id="desktop-explorer-resize"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
});

test("style.css：--sidebar-width 同時驅動側欄寬度與 .container 的 margin-left", async () => {
  const css = await read("../fieldlog/public/style.css");
  assert.match(css, /--sidebar-width:\s*276px;/, "要有預設值");
  assert.match(css, /\.desktop-explorer-nav\s*\{[\s\S]*?width:\s*var\(--sidebar-width\);/);
  assert.match(css, /\.container\s*\{[\s\S]*?margin-left:\s*var\(--sidebar-width\);/);
  assert.match(css, /\.desktop-explorer-resize\s*\{[\s\S]*?cursor:\s*col-resize;/);
});

test("app.js：initDesktopSidebarResize 有讀寫 localStorage、有夾住最小/最大寬度、且真的被呼叫", async () => {
  const app = await read("../fieldlog/public/app.js");
  assert.match(app, /function initDesktopSidebarResize\(\)/);
  assert.match(app, /const SIDEBAR_WIDTH_KEY = "fieldlog_sidebar_width";/);
  assert.match(app, /localStorage\.getItem\(SIDEBAR_WIDTH_KEY\)/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_WIDTH_KEY,/);
  assert.match(app, /SIDEBAR_WIDTH_MIN/);
  assert.match(app, /SIDEBAR_WIDTH_MAX/);
  assert.match(app, /pointerdown/);
  assert.match(app, /setProperty\("--sidebar-width",/);
  // 真的有掛上去，不是只定義了沒人呼叫
  assert.match(app, /\binitDesktopSidebarResize\(\);/);
});

test("桌機資料夾側欄可像 ChatGPT 收合並記住狀態", async () => {
  const [app, html, css] = await Promise.all([
    read("../fieldlog/public/app.js"), read("../fieldlog/public/index.html"), read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="desktop-sidebar-close"/);
  assert.match(html, /id="desktop-sidebar-open"/);
  assert.match(app, /const SIDEBAR_COLLAPSED_KEY = "fieldlog_sidebar_collapsed"/);
  assert.match(app, /function initDesktopSidebarCollapse\(\)/);
  assert.match(app, /\binitDesktopSidebarCollapse\(\);/);
  assert.match(css, /body\.sidebar-collapsed \.desktop-explorer-nav/);
  assert.match(css, /body\.sidebar-collapsed \.container/);
});
