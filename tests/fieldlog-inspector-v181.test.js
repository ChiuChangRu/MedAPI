import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const nodes = new Map(), renders = [], notices = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: "", hidden: false, disabled: false,
      dataset: {}, attributes: {}, value: "", setAttribute(k, v) { this.attributes[k] = v; },
      querySelectorAll() { return []; }, focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({ console, $: node,
    document: { getElementById: node, querySelectorAll: () => [] },
    showToast: (text) => notices.push(text), esc: String,
    setFolderPreviewTitle: (text) => { node("folder-preview-title").textContent = text; },
    clearFolderPreviewEditorToolbar() {}, usesDesktopRightPane: () => true,
    CURRENT_FOLDER: { id: 1 }, FILE_MARQUEE: null,
    FILE_SELECTION: { keys: new Set(), scope: {}, anchor: null, focus: null },
    selectedFileItems() { return [...context.FILE_SELECTION.keys].map((key) => ({ key, type: "entry", id: Number(key.split(":")[1]), title: key })); },
    renderFileSelection() {},
  });
  vm.runInContext(readFileSync(new URL("../fieldlog/public/inspector.js", import.meta.url), "utf8"), context);
  const renderFile = context.renderInspectorFile;
  context.renderInspectorEntry = async (item, tab) => { renders.push([item.id, tab]); node("folder-preview-body").innerHTML = `${item.id}:${tab}`; };
  context.renderInspectorFile = context.renderInspectorEntry;
  return { c: context, node, renders, notices, renderFile, state: () => vm.runInContext("INSPECTOR", context) };
}

test("single selection opens preview; multiple selection exposes batch actions without editable tabs", async () => {
  const h = harness();
  h.c.FILE_SELECTION.keys = new Set(["entry:1"]);
  h.c.syncInspectorSelection(); await h.state().queue;
  assert.deepEqual(h.renders, [[1, "preview"]]);
  assert.equal(h.node("file-preview-mode-toggle").hidden, false);
  h.c.FILE_SELECTION.keys.add("entry:2");
  h.c.syncInspectorSelection(); await h.state().queue;
  assert.match(h.node("folder-preview-body").innerHTML, /已選 2 項/);
  assert.equal(h.node("file-preview-mode-toggle").hidden, true);
  assert.equal(h.node("folder-preview-save").hidden, true);
  assert.equal(h.node("folder-preview-manage").hidden, true);
});

test("Cancel keeps the draft and restores selection without reopening or repeating the prompt", async () => {
  const h = harness();
  h.c.FILE_SELECTION.keys = new Set(["entry:1"]);
  h.c.syncInspectorSelection(); await h.state().queue;
  let draft = "original";
  h.c.inspectorTrack(() => draft, async () => {}); draft = "edited";
  h.c.FILE_SELECTION.keys = new Set(["entry:2"]); h.c.syncInspectorSelection();
  await flush();
  h.c.FILE_SELECTION.keys = new Set(["entry:3"]); h.c.syncInspectorSelection();
  await h.node("inspector-unsaved-cancel").onclick(); await h.state().queue;
  assert.equal(draft, "edited");
  assert.equal(h.c.inspectorHasUnsaved(), true);
  assert.deepEqual([...h.c.FILE_SELECTION.keys], ["entry:1"]);
  assert.deepEqual(h.renders, [[1, "preview"]]);
  h.c.syncInspectorSelection(); await h.state().queue;
  assert.equal(h.node("inspector-unsaved").open, false);
});

test("failed save retains edits and leaves the switch dialog open; retry saves before changing tab", async () => {
  const h = harness();
  await h.c.openInspector({ type: "entry", id: 1 }, "info");
  let draft = "original", offline = true, saved;
  h.c.inspectorTrack(() => draft, async () => { if (offline) throw Error("offline"); saved = draft; }); draft = "edited";
  const transition = h.c.openInspector({ type: "entry", id: 1 }, "preview");
  await flush(); await h.node("inspector-unsaved-save").onclick();
  assert.equal(h.node("inspector-unsaved").open, true);
  assert.equal(h.c.inspectorHasUnsaved(), true);
  assert.equal(h.state().tab, "info");
  offline = false; await h.node("inspector-unsaved-save").onclick(); await transition;
  assert.equal(saved, "edited"); assert.equal(h.state().tab, "preview");
});

test("Discard permits switching without writing a draft", async () => {
  const h = harness(); let value = "before", writes = 0;
  h.c.inspectorTrack(() => value, async () => { writes++; }); value = "after";
  const transition = h.c.openInspector({ type: "entry", id: 2 });
  await flush(); h.node("inspector-unsaved-discard").onclick(); await transition;
  assert.equal(writes, 0); assert.equal(h.state().item.id, 2);
});

test("edits typed during an in-flight save remain dirty and require a second save", async () => {
  const h = harness(); let value = "before", release, writes = [];
  h.c.inspectorTrack(() => value, async () => { writes.push(value); await new Promise((resolve) => { release = resolve; }); });
  value = "first"; const saving = h.c.saveInspector();
  value = "second"; release(); await saving;
  assert.deepEqual(writes, ["first"]); assert.equal(h.c.inspectorHasUnsaved(), true);
  const again = h.c.saveInspector(); release(); await again;
  assert.deepEqual(writes, ["first", "second"]); assert.equal(h.c.inspectorHasUnsaved(), false);
});

test("slow preview renders are serialized and the latest selection wins", async () => {
  const h = harness(); let release;
  h.c.renderInspectorEntry = async (item) => {
    if (item.id === 1) await new Promise((resolve) => { release = resolve; });
    h.node("folder-preview-body").innerHTML = String(item.id);
  };
  const first = h.c.openInspector({ type: "entry", id: 1 }); await flush();
  const second = h.c.openInspector({ type: "entry", id: 2 });
  const third = h.c.openInspector({ type: "entry", id: 3 });
  release(); await Promise.all([first, second, third]);
  assert.equal(h.node("folder-preview-body").innerHTML, "3");
  assert.equal(h.node("folder-preview-body").inert, false);
  assert.equal(h.state().item.id, 3);
});

test("guarded navigation never runs when the user cancels", async () => {
  const h = harness(); let value = "before", moved = false;
  h.c.inspectorTrack(() => value, async () => {}); value = "after";
  const navigation = h.c.inspectorNavigate(() => { moved = true; });
  await flush(); h.node("inspector-unsaved-cancel").onclick(); await navigation;
  assert.equal(moved, false); assert.equal(h.c.inspectorHasUnsaved(), true);
});

test("marquee updates wait until release before changing the inspector", async () => {
  const h = harness(); h.c.FILE_MARQUEE = {};
  h.c.FILE_SELECTION.keys.add("entry:1"); h.c.syncInspectorSelection(); await h.state().queue;
  assert.equal(h.renders.length, 0);
  h.c.FILE_MARQUEE = null; h.c.syncInspectorSelection(); await h.state().queue;
  assert.deepEqual(h.renders, [[1, "preview"]]);
});

test("returning to the current file supersedes an already queued different file", async () => {
  const h = harness();
  await h.c.openInspector({ type: "entry", id: 1 });
  const next = h.c.openInspector({ type: "entry", id: 2 });
  const back = h.c.openInspector({ type: "entry", id: 1 });
  await Promise.all([next, back]);
  assert.equal(h.state().item.id, 1);
  assert.equal(h.node("folder-preview-body").innerHTML, "1:preview");
});

async function fileInfoHarness() {
  const h = harness(), calls = [];
  const entry = { id: 11, folder_id: 1, attachments: [{ id: 5 }] };
  const attachment = { id: 5, filename: "old.pdf", note: "note", key: "key", mime: "application/pdf" };
  Object.assign(h.c, {
    attachmentWithText: async () => ({ entry, attachment }), FOLDERS: [{ id: 1, name: "Folder" }],
    localDateTime: () => "date", fmtBytes: () => "1 KB", isPdfAtt: () => true,
    fileUrlForKey: () => "/files/key", window: {},
    api: async (path, options) => { calls.push([path, options]); return { category: "A", categories: ["A", "B"] }; },
  });
  h.node("folder-preview-open").removeAttribute = () => {};
  const fields = [h.node("inspector-name"), h.node("inspector-note"), h.node("inspector-category")];
  fields[0].value = "old.pdf"; fields[1].value = "note";
  h.node("inspector-info-form").querySelectorAll = () => fields;
  h.c.renderInspectorFile = h.renderFile;
  await h.c.openInspector({ type: "attachment", id: 5, entryId: 11 }, "info");
  return { ...h, calls };
}

test("file info saves only metadata; partial failure keeps the draft and retry skips completed writes", async () => {
  const h = await fileInfoHarness();
  let fail = true;
  h.c.api = async (path, options) => {
    h.calls.push([path, options]);
    if (path.endsWith("/note") && fail) throw Error("offline");
    return { filename: "new.pdf" };
  };
  h.node("inspector-name").value = "new.pdf";
  h.node("inspector-note").value = "new note";
  h.node("inspector-category").value = "B";
  assert.equal(await h.c.saveInspector(), false);
  assert.equal(h.c.inspectorHasUnsaved(), true);
  fail = false; assert.equal(await h.c.saveInspector(), true);
  assert.equal(h.c.inspectorHasUnsaved(), false);
  const writes = h.calls.filter(([, options]) => options);
  assert.deepEqual(writes.map(([path]) => path), ["/attachments/5", "/attachments/5/note", "/attachments/5/note", "/attachments/5/category"]);
  assert.deepEqual(JSON.parse(writes[0][1].body), { filename: "new.pdf" });
  assert.ok(writes.every(([, options]) => !/ocr_text|transcript|body_format/.test(options.body)));
});

test("moving an inspected attachment uses that file, independently of selected parent entry", async () => {
  const h = await fileInfoHarness(); let moved;
  h.c.FILE_SELECTION.keys = new Set(["entry:11"]);
  h.c.openFolderPicker = async () => ({ id: 8, name: "Target" });
  h.c.runFileBatch = async (items, folder) => { moved = { items, folder }; };
  await h.node("inspector-move").onclick();
  assert.equal(moved.items.length, 1);
  assert.equal(moved.items[0].type, "attachment");
  assert.equal(moved.items[0].id, 5);
  assert.equal(moved.folder.id, 8);
});

test("Discard restores saved values even when a subsequent move picker is cancelled", async () => {
  const h = harness(); let value = "saved", opened = false;
  h.c.renderInspectorEntry = async () => { value = "saved"; h.c.inspectorTrack(() => value, async () => {}); };
  await h.c.openInspector({ type: "entry", id: 1 }, "info");
  value = "draft";
  const action = h.c.inspectorNavigate(() => { opened = true; return null; });
  await flush(); h.node("inspector-unsaved-discard").onclick(); await action;
  assert.equal(opened, true); assert.equal(value, "saved");
  assert.equal(h.c.inspectorHasUnsaved(), false);
  value = "another edit"; assert.equal(h.c.inspectorHasUnsaved(), true);
});
