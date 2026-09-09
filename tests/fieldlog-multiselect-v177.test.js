import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { trashStandaloneFile, restoreTrashItem } from "../fieldlog/src/lib/trash.js";

function selectionHarness() {
  const handlers = {}, calls = [], notices = [];
  const classList = () => ({ add() {}, remove() {}, toggle() {}, contains() { return false; } });
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, classList: classList(), querySelectorAll: () => [], setAttribute() {} });
    return elements.get(id);
  };
  const scope = element("folder-entries");
  const rows = [1, 2, 3, 4].map((id) => ({
    dataset: { attId: String(id), entryId: String(id + 10), filename: `file${id}.pdf` },
    classList: classList(), getClientRects: () => [1], querySelector: () => null,
    closest(selector) { return selector.includes(".folder-content-list") ? scope : selector.includes(".folder-file-row") ? this : null; },
    focus() {}, scrollIntoView() {}, setAttribute() {},
  }));
  scope.querySelectorAll = () => rows;
  const document = {
    body: { classList: classList(), appendChild() {} },
    getElementById: element, querySelectorAll: (selector) => selector.includes(".folder-file-row") ? rows : [],
    addEventListener: (type, fn) => { handlers[type] = fn; },
    createElement: () => ({ remove() {} }),
  };
  const context = vm.createContext({ document, console, CURRENT_FOLDER: { id: 7 }, FOLDERS: [{ id: 8, name: "Target" }],
    confirm: () => true, api: async (path, options) => { calls.push({ path, options }); },
    refreshFolderView: async () => {}, showToast: (message) => notices.push(message),
  });
  vm.runInContext(readFileSync(new URL("../fieldlog/public/file-selection.js", import.meta.url), "utf8"), context);
  context.initFileSelection();
  const keys = () => Array.from(context.selectedFileItems(), (item) => item.id);
  const event = (target, extra = {}) => ({ target, preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  return { context, rows, handlers, calls, keys, event, notices, scope };
}

test("Ctrl toggles individual rows; Shift extends and shrinks from the stable anchor", () => {
  const h = selectionHarness();
  h.handlers.click(h.event(h.rows[0], { ctrlKey: true }));
  h.handlers.click(h.event(h.rows[2], { ctrlKey: true }));
  assert.deepEqual(h.keys(), [1, 3]);
  h.handlers.click(h.event(h.rows[2], { ctrlKey: true }));
  assert.deepEqual(h.keys(), [1]);
  h.context.selectFileRow(h.rows[0]);
  h.handlers.keydown(h.event(h.rows[0], { key: "ArrowDown", shiftKey: true }));
  h.handlers.keydown(h.event(h.rows[1], { key: "ArrowDown", shiftKey: true }));
  assert.deepEqual(h.keys(), [1, 2, 3]);
  h.handlers.keydown(h.event(h.rows[2], { key: "ArrowUp", shiftKey: true }));
  assert.deepEqual(h.keys(), [1, 2]);
  h.handlers.keydown(h.event(h.rows[1], { key: "a", ctrlKey: true }));
  assert.deepEqual(h.keys(), [1, 2, 3, 4]);
  h.handlers.keydown(h.event(h.rows[1], { key: "Escape" }));
  assert.deepEqual(h.keys(), []);
});

test("drag snapshot includes the whole selection; dragging an unselected row replaces it", () => {
  const h = selectionHarness(), data = new Map();
  const transfer = { clearData: () => data.clear(), setData: (key, value) => data.set(key, value), getData: (key) => data.get(key), setDragImage() {} };
  h.context.selectFileRow(h.rows[0]); h.context.selectFileRow(h.rows[1], { toggle: true });
  h.handlers.dragstart(h.event(h.rows[0], { dataTransfer: transfer }));
  assert.deepEqual(Array.from(h.context.selectionDropItems({ dataTransfer: transfer }), (item) => item.id), [1, 2]);
  h.handlers.dragstart(h.event(h.rows[3], { dataTransfer: transfer }));
  assert.deepEqual(h.keys(), [4]);
});

test("batch soft deletion reports partial failures, retains failed selection and never uses permanent DELETE", async () => {
  const h = selectionHarness();
  h.context.selectFileRow(h.rows[0]); h.context.selectFileRow(h.rows[1], { toggle: true });
  h.context.api = async (path, options) => { h.calls.push({ path, options }); if (path.includes("/2/")) throw Error("offline"); };
  await h.context.runFileBatch(h.context.selectedFileItems());
  assert.deepEqual(h.calls.map((call) => call.path), ["/attachments/1/trash", "/attachments/2/trash"]);
  assert.ok(h.calls.every((call) => call.options.method === "POST"));
  assert.deepEqual(h.keys(), [2]);
  assert.match(h.notices.at(-1), /1 項已移到垃圾桶；1 項未完成/);
});

test("batch folder drop moves every selected file and cancellation sends no requests", async () => {
  const h = selectionHarness();
  h.context.selectFileRow(h.rows[0]); h.context.selectFileRow(h.rows[1], { toggle: true });
  const items = h.context.selectedFileItems();
  h.context.confirm = () => false;
  await h.context.runFileBatch(items, { id: 8, name: "Target" });
  assert.equal(h.calls.length, 0);
  h.context.confirm = () => true;
  await h.context.runFileBatch(items, { id: 8, name: "Target" });
  assert.deepEqual(h.calls.map((call) => call.path), ["/attachments/1/move", "/attachments/2/move"]);
  assert.ok(h.calls.every((call) => JSON.parse(call.options.body).folder_id === 8));
});

function trashDB() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, folder_id INTEGER, parent_entry_id INTEGER, title TEXT, body TEXT, deleted_at TEXT DEFAULT '', updated_at TEXT);
    CREATE TABLE attachments (id INTEGER PRIMARY KEY, entry_id INTEGER, source_pdf_id INTEGER, key TEXT);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, deleted_at TEXT DEFAULT '');
    CREATE TABLE trash_items (id INTEGER PRIMARY KEY, item_type TEXT, item_id INTEGER, title TEXT, deleted_at TEXT, purge_after TEXT, state TEXT, UNIQUE(item_type,item_id));
    INSERT INTO folders (id) VALUES (7);
    INSERT INTO entries(id, folder_id, title, body) VALUES (10,7,'file.pdf','Keep this note');
    INSERT INTO attachments VALUES (1,10,NULL,'original'), (2,10,1,'page-image');`);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
  });
  return { sqlite, prepare: statement, async batch(statements) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const query of statements) results.push(await query.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}

test("file trash preserves its note, PDF pages and bytes; restoring uses existing 60-day trash flow", async () => {
  const db = trashDB();
  const result = await trashStandaloneFile(db, 1, "2026-09-09T00:00:00.000Z");
  assert.equal(result.trashed, true);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM attachments").get().n, 2);
  assert.equal(db.sqlite.prepare("SELECT body FROM entries").get().body, "Keep this note");
  const item = db.sqlite.prepare("SELECT * FROM trash_items").get();
  assert.equal(item.purge_after, "2026-11-08T00:00:00.000Z");
  await restoreTrashItem(db, item.id, {}, "2026-09-10T00:00:00.000Z");
  assert.equal(db.sqlite.prepare("SELECT deleted_at FROM entries WHERE id = 10").get().deleted_at, "");
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM trash_items").get().n, 0);
  db.sqlite.close();
});

test("stale single-file selection refuses deletion after a sibling or child was added", async () => {
  for (const extra of ["INSERT INTO attachments VALUES (3,10,NULL,'new')", "INSERT INTO entries(id,parent_entry_id,title) VALUES (11,10,'child')"]) {
    const db = trashDB(); db.sqlite.exec(extra);
    assert.equal((await trashStandaloneFile(db, 1, "2026-09-09T00:00:00.000Z")).status, 409);
    assert.equal(db.sqlite.prepare("SELECT deleted_at FROM entries WHERE id=10").get().deleted_at, "");
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM trash_items").get().n, 0);
    db.sqlite.close();
  }
});
