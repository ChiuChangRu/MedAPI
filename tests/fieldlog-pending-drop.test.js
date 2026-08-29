import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ensureStagingFolder,
  STAGING_FOLDER_NAME,
} from "../fieldlog/src/lib/autofile.js";

test("待分類系統容器會沿用既有資料並升級名稱，不建立第二份", async () => {
  const existing = {
    id: 9,
    name: "舊名稱",
    type: "舊類型",
    parent_id: 3,
    role: "staging",
    created_at: "2026-08-01T00:00:00Z",
  };
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /SELECT \* FROM folders WHERE role/);
              return { ...existing };
            },
            async run() {
              calls.push({ sql, args });
              return { meta: { last_row_id: 10 } };
            },
          };
        },
      };
    },
  };

  const result = await ensureStagingFolder(db, "2026-08-14T00:00:00Z");
  assert.equal(STAGING_FOLDER_NAME, "⏳ 待分類");
  assert.equal(result.id, 9);
  assert.equal(result.name, STAGING_FOLDER_NAME);
  assert.equal(result.type, "其他");
  assert.equal(result.parent_id, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE folders SET name = \?, type = \?, parent_id = NULL WHERE id = \?/);
  assert.deepEqual(calls[0].args, [STAGING_FOLDER_NAME, "其他", 9]);
});

test("外部檔案拖到首頁或資料夾頁都進待分類；筆記內拖入仍附加到該筆記", async () => {
  const app = await readFile(new URL("../fieldlog/public/app.js", import.meta.url), "utf8");
  const init = app.match(/function init\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const pendingUpload = app.match(/async function uploadDroppedFilesToPending\([\s\S]*?\n\}/)?.[0] || "";
  const tree = app.match(/function folderTreeOrdered\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(init, /setupFileDropZone\(\$\("view-home"\), uploadDroppedFilesToPending\)/);
  assert.match(init, /setupFileDropZone\(\$\("view-folder"\), uploadDroppedFilesToPending\)/);
  assert.match(pendingUpload, /await stagingFolderId\(\)/);
  assert.match(pendingUpload, /uploadStandaloneFiles\(files, folderId/);
  assert.match(app, /setupFileDropZone\(\$\("entry-modal"\), \(files\) => uploadFiles\(id, files\)\)/,
    "在既有筆記內拖檔必須維持附加到該筆記，不能拆成新的待分類內容");
  assert.match(tree, /if \(f\.role === "staging"\) continue/,
    "待分類系統容器不能顯示成第一階資料夾");
});

test("公開介面統一使用待分類與移動用語", async () => {
  const files = await Promise.all([
    "../fieldlog/public/app.js",
    "../fieldlog/public/index.html",
    "../fieldlog/public/help.html",
    "../fieldlog/public/style.css",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const publicText = files.join("\n");

  assert.match(publicText, /待分類/);
  assert.doesNotMatch(publicText, /歸檔|待歸類|暫存區|收件匣|歸類/);
});
