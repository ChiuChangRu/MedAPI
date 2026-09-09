import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { trashStandaloneFile, restoreTrashItem } from "../fieldlog/src/lib/trash.js";

function selectionHarness() {
  const handlers = {}, calls = [], notices = [], frames = new Map();
  let nextFrame = 1;
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
  scope.querySelector = () => rows[0];
  scope.closest = (selector) => selector.includes(".folder-content-list") ? scope : null;
  Object.assign(scope, { isConnected: true, clientWidth: 300, clientHeight: 400, scrollWidth: 300, scrollHeight: 400, scrollTop: 0, scrollLeft: 0 });
  scope.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: scope.clientHeight, width: 300, height: scope.clientHeight });
  scope.getClientRects = () => [1];
  scope.focus = () => {};
  scope.setPointerCapture = () => { scope.captured = true; };
  scope.hasPointerCapture = () => scope.captured;
  scope.releasePointerCapture = () => { scope.captured = false; };
  rows.forEach((row, index) => { row.getBoundingClientRect = () => ({ left: 20, right: 220, top: 20 + index * 50 - scope.scrollTop, bottom: 60 + index * 50 - scope.scrollTop, width: 200, height: 40 }); });
  const document = {
    body: { classList: classList(), appendChild() {} },
    getElementById: element, querySelectorAll: (selector) => selector.includes(".folder-file-row") ? rows : [],
    addEventListener: (type, fn) => { handlers[type] = fn; },
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    scrollingElement: { scrollTop: 0 },
  };
  const context = vm.createContext({ document, console,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener: (type, fn) => { handlers[type] = fn; } },
    getComputedStyle: () => ({ overflowY: "auto" }),
    requestAnimationFrame: (fn) => { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    matchMedia: () => ({ matches: true }), CURRENT_FOLDER: { id: 7 }, FOLDERS: [{ id: 8, name: "Target" }],
    confirm: () => true, api: async (path, options) => { calls.push({ path, options }); },
    refreshFolderView: async () => {}, showToast: (message) => notices.push(message),
  });
  vm.runInContext(readFileSync(new URL("../fieldlog/public/file-selection.js", import.meta.url), "utf8"), context);
  context.initFileSelection();
  const keys = () => Array.from(context.selectedFileItems(), (item) => item.id);
  const event = (target, extra = {}) => ({ target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  return { context, rows, handlers, calls, keys, event, notices, scope, frames };
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


test("desktop single click selects without opening; double click and Enter open exactly once", () => {
  const h = selectionHarness();
  const row = h.rows[0];
  delete row.dataset.attId; row.dataset.id = "21";
  row.classList.contains = (name) => name === "child-folder-card";
  const opened = [];
  h.context.openFolder = async (id) => { opened.push(id); };
  const click = h.event(row);
  h.handlers.click(click);
  assert.equal(click.stopped, true);
  assert.equal(click.prevented, true);
  assert.deepEqual(opened, []);
  assert.deepEqual(h.keys(), [21]);
  h.handlers.dblclick(h.event(row));
  assert.deepEqual(opened, [21]);
  h.handlers.keydown(h.event(row, { key: "Enter" }));
  assert.deepEqual(opened, [21, 21]);
});

test("Ctrl selects folders and files together without navigation; modifier double-click never opens", () => {
  const h = selectionHarness();
  const folder = h.rows[1];
  delete folder.dataset.attId; folder.dataset.id = "21";
  folder.classList.contains = (name) => name === "child-folder-card";
  const opened = [];
  h.context.openFolder = async (id) => { opened.push(id); };
  h.handlers.click(h.event(h.rows[0], { ctrlKey: true }));
  const click = h.event(folder, { ctrlKey: true });
  h.handlers.click(click);
  assert.equal(click.stopped, true);
  assert.deepEqual(h.keys(), [1, 21]);
  assert.deepEqual(Array.from(h.context.selectedFileItems(), (item) => item.type), ["attachment", "folder"]);
  h.handlers.dblclick(h.event(folder, { ctrlKey: true }));
  assert.deepEqual(opened, []);
});

test("touch single tap retains the existing opener", () => {
  const h = selectionHarness();
  h.context.matchMedia = () => ({ matches: false });
  const click = h.event(h.rows[0]);
  h.handlers.click(click);
  assert.notEqual(click.stopped, true);
});

test("batch folder moves use parent_id and trash uses the recoverable folder route", async () => {
  const h = selectionHarness();
  const items = [{ key: "folder:21", type: "folder", id: 21, title: "Folder" }];
  await h.context.runFileBatch(items, { id: 8, name: "Target" });
  assert.equal(h.calls[0].path, "/folders/21");
  assert.equal(h.calls[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { parent_id: 8 });
  await h.context.runFileBatch(items);
  assert.equal(h.calls[1].path, "/folders/21");
  assert.equal(h.calls[1].options.method, "DELETE");
  h.context.FOLDERS = [{ id: 21 }, { id: 22, parent_id: 21 }];
  await h.context.runFileBatch(items, { id: 21, name: "Self" });
  await h.context.runFileBatch(items, { id: 22, name: "Child" });
  assert.equal(h.calls.length, 2);
  assert.match(h.notices.at(-1), /不能把資料夾移到自己/);
});


function pointer(h, type, x, y, extra = {}) {
  h.handlers[type](h.event(h.scope, { pointerType: "mouse", button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y, ...extra }));
}

test("marquee selects intersecting rows in both drag directions and leaves them selected after release", () => {
  for (const reverse of [false, true]) {
    const h = selectionHarness();
    pointer(h, "pointerdown", reverse ? 240 : 4, reverse ? 116 : 4);
    pointer(h, "pointermove", reverse ? 4 : 240, reverse ? 4 : 116);
    assert.deepEqual(h.keys(), [1, 2]);
    pointer(h, "pointerup", reverse ? 4 : 240, reverse ? 4 : 116);
    assert.deepEqual(h.keys(), [1, 2]);
    assert.equal(h.scope.captured, false);
    assert.equal(h.frames.size, 0);
    // The synthetic click after releasing a box must not collapse selection or open a file.
    const click = h.event(h.rows[1], { detail: 1 });
    h.handlers.click(click);
    assert.equal(click.stopped, true);
    assert.deepEqual(h.keys(), [1, 2]);
  }
});

test("Ctrl marquee adds to existing selection; Escape cancels and restores the prior selection", () => {
  const h = selectionHarness();
  h.context.selectFileRow(h.rows[3]);
  pointer(h, "pointerdown", 4, 4, { ctrlKey: true });
  pointer(h, "pointermove", 240, 116, { ctrlKey: true });
  assert.deepEqual(h.keys(), [1, 2, 4]);
  h.handlers.keydown(h.event(h.scope, { key: "Escape" }));
  assert.deepEqual(h.keys(), [4]);
  assert.equal(h.scope.captured, false);
  assert.equal(h.frames.size, 0);
});

test("row drags and touch scrolling never start marquee; a blank click clears selection", () => {
  const h = selectionHarness();
  h.context.selectFileRow(h.rows[0]);
  h.handlers.pointerdown(h.event(h.rows[0], { pointerType: "mouse", button: 0, pointerId: 1, clientX: 40, clientY: 30 }));
  assert.notEqual(h.scope.captured, true);
  pointer(h, "pointerdown", 4, 4, { pointerType: "touch" });
  assert.notEqual(h.scope.captured, true);
  pointer(h, "pointerdown", 4, 4);
  pointer(h, "pointerup", 4, 4);
  assert.deepEqual(h.keys(), []);
});

test("edge autoscroll extends the rectangle in content coordinates and cancels its frame on pointer cancellation", () => {
  const h = selectionHarness();
  h.scope.clientHeight = 150;
  h.scope.scrollHeight = 800;
  pointer(h, "pointerdown", 4, 4);
  pointer(h, "pointermove", 240, 140);
  assert.deepEqual(h.keys(), [1, 2, 3]);
  for (let i = 0; i < 4; i++) {
    const [id, callback] = h.frames.entries().next().value;
    h.frames.delete(id); callback();
  }
  assert.equal(h.scope.scrollTop, 48);
  assert.deepEqual(h.keys(), [1, 2, 3, 4]);
  pointer(h, "pointercancel", 240, 140);
  assert.deepEqual(h.keys(), []);
  assert.equal(h.frames.size, 0);
});
