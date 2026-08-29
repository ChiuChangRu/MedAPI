import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("左側資料夾欄可收合、重開並記住狀態", async () => {
  const [html, app, css] = await Promise.all([
    read("../fieldlog/public/index.html"),
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="desktop-sidebar-close"/);
  assert.match(html, /id="desktop-sidebar-open"/);
  assert.match(app, /const SIDEBAR_COLLAPSED_KEY = "fieldlog_sidebar_collapsed"/);
  assert.match(app, /function setDesktopSidebarCollapsed\(collapsed, persist = true\)/);
  assert.match(app, /function initDesktopSidebarCollapse\(\)/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_COLLAPSED_KEY/);
  assert.match(css, /body\.sidebar-collapsed \.desktop-explorer-nav \{ display: none; \}/);
  assert.match(css, /body\.sidebar-collapsed \.container \{ margin-left: 52px; \}/);
});

test("右欄可切換最寬模式，清除內容時會恢復分欄", async () => {
  const [html, app, css] = await Promise.all([
    read("../fieldlog/public/index.html"),
    read("../fieldlog/public/app.js"),
    read("../fieldlog/public/style.css"),
  ]);
  assert.match(html, /id="folder-preview-expand"/);
  assert.match(html, /id="folder-preview-close"/);
  assert.match(app, /function setReaderFullscreen\(enabled\)/);
  assert.match(app, /classList\.toggle\("reader-fullscreen", isFullscreen\)/);
  assert.match(app, /if \(expand\) expand\.onclick = \(\) => setReaderFullscreen/);
  const clear = app.match(/function clearFilePreview[\s\S]*?\n}/)?.[0] || "";
  assert.match(clear, /setReaderFullscreen\(false\)/);
  assert.match(css, /body\.reader-fullscreen \.folder-workspace-main/);
  assert.match(css, /body\.reader-fullscreen \.folder-preview/);
});
