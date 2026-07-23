import previousWorker from "./worker-v45.js";

const MAX_FOLDER_DEPTH = 4;
const DEVICE_CATEGORIES = new Set([
  "",
  "中央靜脈導管（CVC）",
  "血液透析導管（HD）",
  "引流導管（Pigtail）",
  "高壓注射筒組",
  "輸液器具／逆止閥",
  "其他",
]);

let categorySchemaReady = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const url = new URL(request.url);
  const expected = String(env.FIELD_PIN || "").trim();
  const supplied = String(request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
  return Boolean(expected) && supplied === expected;
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function warmSchema(request, env, ctx) {
  const url = new URL(request.url);
  url.pathname = "/api/folders";
  url.search = "";
  const headers = new Headers();
  headers.set("x-pin", request.headers.get("x-pin") || new URL(request.url).searchParams.get("pin") || "");
  const response = await previousWorker.fetch(new Request(url, { method: "GET", headers }), env, ctx);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `初始化資料庫失敗（HTTP ${response.status}）`);
  }
}

async function ensureCategorySchema(env) {
  if (categorySchemaReady || !env.DB) return;
  await env.DB.prepare("ALTER TABLE attachments ADD COLUMN device_category TEXT DEFAULT ''").run().catch(() => {});
  categorySchemaReady = true;
}

async function folderDepth(env, folderId) {
  let currentId = Number(folderId || 0);
  let depth = 0;
  const visited = new Set();

  while (currentId) {
    if (visited.has(currentId)) throw new Error("資料夾層級形成循環，請先檢查資料");
    visited.add(currentId);
    const folder = await env.DB.prepare("SELECT id, parent_id FROM folders WHERE id = ?").bind(currentId).first();
    if (!folder) return 0;
    depth++;
    currentId = Number(folder.parent_id || 0);
    if (depth > 20) throw new Error("資料夾層級異常");
  }
  return depth;
}

async function createFolderWithDepthLimit(request, env, ctx) {
  await warmSchema(request, env, ctx);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const type = String(body.type || "其他").trim() || "其他";
  const parentId = body.parent_id ? Number(body.parent_id) : null;

  if (!name) return json({ error: "name 為必填" }, 400);

  let depth = 1;
  if (parentId) {
    const parentDepth = await folderDepth(env, parentId);
    if (!parentDepth) return json({ error: "找不到上層資料夾" }, 404);
    if (parentDepth >= MAX_FOLDER_DEPTH) {
      return json({ error: `資料夾最多 ${MAX_FOLDER_DEPTH} 層，不能再新增子資料夾` }, 400);
    }
    depth = parentDepth + 1;
  }

  const createdAt = now();
  const result = await env.DB.prepare(
    "INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)"
  ).bind(name.slice(0, 80), type.slice(0, 30), parentId, createdAt).run();
  const id = Number(result.meta.last_row_id);
  await env.DB.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (NULL, ?, '建立資料夾', ?, ?)"
  ).bind(id, `${name}（${type}，第 ${depth} 層）`.slice(0, 200), createdAt).run().catch(() => {});

  return json({ id, ok: true, depth, max_depth: MAX_FOLDER_DEPTH });
}

async function readAttachmentCategory(env, attachmentId) {
  await ensureCategorySchema(env);
  const attachment = await env.DB.prepare(
    "SELECT id, entry_id, filename, COALESCE(device_category, '') AS device_category FROM attachments WHERE id = ?"
  ).bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };
  return {
    ok: true,
    id: attachment.id,
    filename: attachment.filename,
    category: attachment.device_category || "",
    categories: [...DEVICE_CATEGORIES].filter(Boolean),
  };
}

async function saveAttachmentCategory(env, attachmentId, request) {
  await ensureCategorySchema(env);
  const body = await request.json().catch(() => ({}));
  const category = String(body.category || "").trim();
  if (!DEVICE_CATEGORIES.has(category)) return { error: "分類選項不正確", status: 400 };

  const attachment = await env.DB.prepare(
    "SELECT id, entry_id, filename FROM attachments WHERE id = ?"
  ).bind(attachmentId).first();
  if (!attachment) return { error: "找不到附件", status: 404 };

  await env.DB.prepare("UPDATE attachments SET device_category = ? WHERE id = ?")
    .bind(category, attachmentId).run();
  await env.DB.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, NULL, '更新醫材分類', ?, ?)"
  ).bind(
    attachment.entry_id,
    `${attachment.filename}：${category || "未分類"}`.slice(0, 200),
    now()
  ).run().catch(() => {});

  return { ok: true, category };
}

const FOLDER_LAYOUT_AND_DEPTH_UI = String.raw`
;(() => {
  if (window.__fieldlogFolderLayoutDepth4) return;
  window.__fieldlogFolderLayoutDepth4 = true;

  const MAX_DEPTH = 4;
  const originalOpenFolderDepth4 = openFolder;
  const originalNewSubfolderDepth4 = newSubfolder;

  const style = document.createElement("style");
  style.id = "fieldlog-card-layout-depth4";
  style.textContent = [
    ".folder-file-row .folder-file-delete{width:40px!important;height:36px!important;padding:0!important;border:1px solid var(--border)!important;border-radius:7px!important;background:#fff!important;color:#b91c1c!important;cursor:pointer!important}",
    ".folder-file-row .folder-file-manage{width:40px!important;height:36px!important;padding:0!important}",
    ".file-primary-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}",
    ".file-primary-actions button,.file-primary-actions a{display:flex;align-items:center;justify-content:center;min-height:44px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:#fff;color:var(--text);text-decoration:none;cursor:pointer;font-weight:600}",
    ".file-primary-actions button:hover,.file-primary-actions a:hover{border-color:var(--accent);background:#f0fdfa}",
    ".file-primary-actions .disabled{opacity:.45;pointer-events:none}",
    ".file-category-panel{display:none;margin:0 0 14px;padding:12px;border:1px solid var(--border);border-radius:9px;background:#f8faf9}",
    ".file-category-panel.open{display:block}",
    ".file-category-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:7px}",
    ".file-category-row select{min-width:0;width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;background:#fff}",
    ".file-category-current{margin:6px 0 0;color:var(--text-muted);font-size:12px}",
    "@media(max-width:719px){.file-primary-actions{grid-template-columns:1fr 1fr}.file-category-row{grid-template-columns:1fr}}",
    "@media(min-width:720px){",
    ".folder-file-list.grid-view{grid-template-columns:repeat(auto-fill,minmax(250px,1fr))!important;align-items:stretch!important}",
    ".folder-file-list.grid-view .folder-file-row.folder-file-row{min-height:180px!important;display:grid!important;grid-template-columns:minmax(0,1fr) 40px 40px!important;grid-template-rows:36px minmax(0,1fr) auto!important;align-content:stretch!important;align-items:start!important;gap:8px!important;padding:14px!important;overflow:hidden!important}",
    ".folder-file-list.grid-view .folder-file-row .folder-file-icon{grid-column:1!important;grid-row:1!important;text-align:left!important;font-size:24px!important;align-self:center!important}",
    ".folder-file-list.grid-view .folder-file-row .folder-file-delete{grid-column:2!important;grid-row:1!important;justify-self:end!important}",
    ".folder-file-list.grid-view .folder-file-row .folder-file-manage{grid-column:3!important;grid-row:1!important;justify-self:end!important}",
    ".folder-file-list.grid-view .folder-file-row .folder-file-name{grid-column:1 / 4!important;grid-row:2!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:4!important;overflow:hidden!important;line-height:1.45!important;max-height:5.8em!important;align-self:start!important}",
    ".folder-file-list.grid-view .folder-file-row .folder-file-meta{grid-column:1 / 4!important;grid-row:3!important;align-self:end!important;margin:0!important;padding-top:8px!important;border-top:1px solid var(--border)!important}",
    "}"
  ].join("");
  document.head.appendChild(style);

  function depthOf(folder) {
    if (!folder) return 0;
    let depth = 0;
    let current = folder;
    const visited = new Set();
    while (current) {
      const id = Number(current.id || 0);
      if (!id || visited.has(id)) break;
      visited.add(id);
      depth++;
      current = current.parent_id ? FOLDERS.find((item) => Number(item.id) === Number(current.parent_id)) : null;
    }
    return depth;
  }

  function syncSubfolderButton() {
    const button = document.getElementById("btn-new-subfolder");
    if (!button) return;
    const depth = depthOf(CURRENT_FOLDER);
    const atLimit = depth >= MAX_DEPTH;
    button.hidden = atLimit;
    button.disabled = atLimit;
    button.title = atLimit
      ? "資料夾最多四層"
      : "新增第 " + Math.max(1, depth + 1) + " 層子資料夾（最多四層）";
  }

  async function safeNewSubfolderDepth4() {
    if (depthOf(CURRENT_FOLDER) >= MAX_DEPTH) {
      showToast("資料夾最多四層，這一層不能再新增子資料夾");
      syncSubfolderButton();
      return;
    }
    return originalNewSubfolderDepth4();
  }

  function currentAttachmentId(modal) {
    const item = modal.querySelector(".att-item[data-id]");
    return Number(item && item.dataset.id || 0);
  }

  function injectFilePrimaryActions() {
    const modal = document.getElementById("entry-modal");
    if (!modal || !modal.querySelector("#file-note") || modal.querySelector(".file-primary-actions")) return;

    const attachmentId = currentAttachmentId(modal);
    if (!attachmentId) return;
    const attachmentItem = modal.querySelector(".att-item[data-id=\"" + attachmentId + "\"]");
    const readLink = attachmentItem && attachmentItem.querySelector("a[href*=\"/api/file/\"]");
    const doodleLink = attachmentItem && attachmentItem.querySelector(".att-pdf-doodle");
    const heading = modal.querySelector(".detail-head");
    if (!heading) return;

    const actions = document.createElement("div");
    actions.className = "file-primary-actions";
    actions.innerHTML = [
      readLink ? '<a id="file-read-action" href="' + readLink.href + '" target="_blank" rel="noopener">📖 閱讀</a>' : '<span class="disabled">📖 閱讀</span>',
      '<button id="file-doodle-action" type="button"' + (doodleLink ? '' : ' class="disabled" disabled') + '>✍️ 塗鴉</button>',
      '<button id="file-category-action" type="button">🏷 分類</button>',
      '<button id="file-note-action" type="button">📝 Note</button>'
    ].join("");

    const panel = document.createElement("div");
    panel.className = "file-category-panel";
    panel.innerHTML = [
      '<strong>醫療器材分類</strong>',
      '<div class="file-category-row">',
      '<select id="file-device-category"><option value="">未分類</option><option>中央靜脈導管（CVC）</option><option>血液透析導管（HD）</option><option>引流導管（Pigtail）</option><option>高壓注射筒組</option><option>輸液器具／逆止閥</option><option>其他</option></select>',
      '<button class="btn primary" id="file-category-save" type="button">儲存分類</button>',
      '</div>',
      '<p class="file-category-current" id="file-category-current">讀取分類中…</p>'
    ].join("");

    heading.insertAdjacentElement("afterend", panel);
    heading.insertAdjacentElement("afterend", actions);

    const noteLabel = modal.querySelector('label[for="file-note"]');
    if (noteLabel) noteLabel.textContent = "Note 文字（只屬於這一份檔案）";
    const noteSave = modal.querySelector("#file-note-save");
    if (noteSave) noteSave.textContent = "儲存 Note";

    const categoryButton = modal.querySelector("#file-category-action");
    const categorySelect = modal.querySelector("#file-device-category");
    const categoryCurrent = modal.querySelector("#file-category-current");

    modal.querySelector("#file-note-action").onclick = () => {
      const textarea = modal.querySelector("#file-note");
      textarea.scrollIntoView({ behavior: "smooth", block: "center" });
      textarea.focus();
    };
    categoryButton.onclick = () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) categorySelect.focus();
    };
    if (doodleLink) {
      modal.querySelector("#file-doodle-action").onclick = () => doodleLink.click();
    }

    api("/attachments/" + attachmentId + "/category").then((result) => {
      categorySelect.value = result.category || "";
      categoryCurrent.textContent = "目前分類：" + (result.category || "未分類");
    }).catch((error) => {
      categoryCurrent.textContent = "讀取分類失敗：" + error.message;
    });

    modal.querySelector("#file-category-save").onclick = async () => {
      const saveButton = modal.querySelector("#file-category-save");
      saveButton.disabled = true;
      try {
        const result = await api("/attachments/" + attachmentId + "/category", {
          method: "PUT",
          body: JSON.stringify({ category: categorySelect.value })
        });
        categoryCurrent.textContent = "目前分類：" + (result.category || "未分類");
        showToast("醫療器材分類已儲存");
      } catch (error) {
        showToast("分類儲存失敗：" + error.message);
      } finally {
        saveButton.disabled = false;
      }
    };
  }

  newSubfolder = safeNewSubfolderDepth4;
  const button = document.getElementById("btn-new-subfolder");
  if (button) button.onclick = safeNewSubfolderDepth4;

  openFolder = async function fieldlogDepth4OpenFolder(id) {
    const result = await originalOpenFolderDepth4(id);
    syncSubfolderButton();
    return result;
  };

  syncSubfolderButton();
  injectFilePrimaryActions();
  new MutationObserver(injectFilePrimaryActions).observe(document.getElementById("entry-modal") || document.documentElement, { childList: true, subtree: true });
})();
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const categoryMatch = url.pathname.match(/^\/api\/attachments\/(\d+)\/category$/);
    if (categoryMatch && (request.method === "GET" || request.method === "PUT")) {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        const result = request.method === "GET"
          ? await readAttachmentCategory(env, Number(categoryMatch[1]))
          : await saveAttachmentCategory(env, Number(categoryMatch[1]), request);
        return json(result, result.status || 200);
      } catch (error) {
        return json({ error: `醫療器材分類處理失敗：${error.message}` }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/folders") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        return await createFolderWithDepthLimit(request, env, ctx);
      } catch (error) {
        return json({ error: `建立資料夾失敗：${error.message}` }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/javascript; charset=utf-8");
      headers.set("cache-control", "no-store, max-age=0");
      return new Response(`${await response.text()}\n${FOLDER_LAYOUT_AND_DEPTH_UI}`, {
        status: response.status,
        headers,
      });
    }

    if (request.method !== "POST" || url.pathname !== "/api/attachments/rename-existing") {
      return previousWorker.fetch(request, env, ctx);
    }
    if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);

    let cleanupResponse;
    try {
      await warmSchema(request, env, ctx);
      await env.DB.prepare("DROP INDEX IF EXISTS idx_att_entry_hash").run();
      cleanupResponse = await previousWorker.fetch(request, env, ctx);
    } catch (error) {
      cleanupResponse = json({ error: `既有附件整理失敗：${error.message}` }, 500);
    }

    try {
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_att_entry_hash ON attachments(entry_id, content_hash) WHERE content_hash IS NOT NULL AND content_hash <> ''"
      ).run();
    } catch (error) {
      return json({
        error: `重複檔整理後無法恢復資料庫索引：${error.message}`,
        cleanup_status: cleanupResponse?.status || 500,
      }, 500);
    }

    return cleanupResponse;
  },
};
