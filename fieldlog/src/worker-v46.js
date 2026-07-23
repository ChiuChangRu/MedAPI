import previousWorker from "./worker-v45.js";

const MAX_FOLDER_DEPTH = 4;

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

  newSubfolder = safeNewSubfolderDepth4;
  const button = document.getElementById("btn-new-subfolder");
  if (button) button.onclick = safeNewSubfolderDepth4;

  openFolder = async function fieldlogDepth4OpenFolder(id) {
    const result = await originalOpenFolderDepth4(id);
    syncSubfolderButton();
    return result;
  };

  syncSubfolderButton();
})();
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
      // 先讓既有 Worker 完成 schema migration，避免下一步暫時移除索引後又被 migration 立即建立回來。
      await warmSchema(request, env, ctx);

      // 舊檔補寫 SHA-256 時，若較晚的附件與既有附件相同，唯一索引會在刪除重複檔前先中斷。
      // 整理期間暫時移除索引，讓既有流程先補 hash、刪除較晚重複檔，再恢復索引。
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
