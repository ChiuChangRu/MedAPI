import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../fieldlog/public/style.css", import.meta.url), "utf8");

test("每個工作主分類可手動建立第一層資料夾", () => {
  assert.match(app, /desktop-tree-section-add/);
  assert.match(app, /newFolderInSection\(sectionNode\.dataset\.section\)/);
  assert.match(app, /async function newFolderInSection\(section\)/);
  assert.match(app, /category: section,[\s\S]*parentId: null/);
  assert.match(app, /body: JSON\.stringify\(\{ \.\.\.details, category: section, parent_id: null \}\)/);
});

test("左欄資料夾可拖曳，整個工作主分類可接收搬移", () => {
  assert.match(app, /data-depth="\$\{depth\}" draggable="true"/);
  assert.match(app, /row\.ondragstart/);
  assert.match(app, /setData\("application\/x-fieldlog-folder", row\.dataset\.id\)/);
  assert.match(app, /sectionNode\.ondrop/);
  assert.match(app, /moveFolderToSection\(folderId, section\)/);
  assert.match(css, /\.desktop-tree-section\.drop-target/);
  assert.match(css, /\.desktop-tree-row\[draggable="true"\]/);
});
