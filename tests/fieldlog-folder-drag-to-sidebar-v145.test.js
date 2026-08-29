import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("右欄子資料夾卡片可拖曳整棵資料夾", () => {
  assert.match(app, /class="child-folder-card explorer-item" draggable="true"/);
  assert.match(app, /event\.dataTransfer\.setData\("application\/x-fieldlog-folder", String\(folderId\)\)/);
  assert.match(css, /\.child-folder-card\[draggable="true"\]/);
});

test("左側工作主目錄可接收整個資料夾", () => {
  assert.match(app, /sectionNode\.ondragover = \(event\) =>/);
  assert.match(app, /moveFolderToSection\(folderId, section\)/);
  assert.match(app, /JSON\.stringify\(\{ parent_id: null, category: section \}\)/);
  assert.match(app, /actionLabel: "復原"/);
  assert.match(css, /\.desktop-tree-section\.drop-target/);
});
