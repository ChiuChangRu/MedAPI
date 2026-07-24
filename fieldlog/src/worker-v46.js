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

const KNOWLEDGE_ARCHITECTURE_UI = String.raw`
;(() => {
  if (window.__fieldlogKnowledgeArchitecture) return;
  window.__fieldlogKnowledgeArchitecture = true;

  const LEVEL_HINTS = {
    1: "產品／專案",
    2: "文件類型",
    3: "主題／試驗／標準系列",
    4: "年份／版本／特定文件群"
  };
  const LEVEL_CHOICES = {
    1: [
      ["中央靜脈導管（CVC）", "🩺", "中央靜脈導管產品資料"],
      ["血液透析導管（HD）", "🩸", "透析導管產品資料"],
      ["引流導管（Pigtail）", "🧫", "引流導管產品資料"],
      ["高壓注射筒組", "💉", "高壓注射相關產品"],
      ["輸液器具／逆止閥", "💧", "輸液與流體控制產品"],
      ["共通法規／標準", "📚", "跨產品共用規範"],
      ["供應商／合作夥伴", "🏭", "跨產品合作資料"],
      ["其他專案", "🗂️", "其他產品或專案"]
    ],
    2: [
      ["法規與標準", "📘", "ISO、ASTM、FDA、MDR 等"],
      ["設計開發", "🧩", "需求、規格、圖面與變更"],
      ["驗證與確效", "🧪", "計畫書、原始資料與報告"],
      ["風險管理", "⚠️", "風險分析、控制與追蹤"],
      ["臨床／仿單", "🩺", "臨床情境與使用說明"],
      ["註冊送件", "📮", "查驗登記與送件版本"],
      ["製造／供應商", "🏭", "製程、原料與供應商"],
      ["會議／紀錄", "👥", "決議、拜訪、查廠與課程"],
      ["其他文件", "🗂️", "其他文件類型"]
    ],
    3: [
      ["標準系列／章節", "📚", "例如 ISO 8536、ISO 10555"],
      ["試驗項目", "🧪", "例如流量、洩漏、抗拉、顯影"],
      ["零組件／功能", "⚙️", "依結構、零件或功能細分"],
      ["國家／市場", "🌏", "台灣、美國、歐盟等"],
      ["供應商／型號", "🏭", "依來源或型號細分"],
      ["專案階段", "🗓️", "設計、驗證、送件、上市後"],
      ["其他主題", "🗂️", "其他主題分類"]
    ],
    4: [
      ["年份／版本", "🗓️", "依年份、版次或修訂版"],
      ["單一標準／文件", "📄", "特定標準或正式文件"],
      ["試驗批次／報告", "🧪", "特定批次、計畫或報告"],
      ["送件版本", "📮", "補件、變更或核准版本"],
      ["會議日期", "👥", "依日期或會議場次"],
      ["其他細分", "🗂️", "最後一層自由分類"]
    ]
  };

  const extraTemplates = {
    "中央靜脈導管（CVC）": [], "血液透析導管（HD）": [], "引流導管（Pigtail）": [],
    "高壓注射筒組": [], "輸液器具／逆止閥": [], "共通法規／標準": [],
    "供應商／合作夥伴": [], "其他專案": [], "法規與標準": [], "設計開發": [],
    "驗證與確效": ["主題", "條件／參數", "觀察結果", "判定", "下次調整"],
    "風險管理": ["危害／情境", "風險評估", "控制措施", "殘餘風險", "追蹤"],
    "臨床／仿單": ["臨床情境", "使用者", "使用步驟", "關鍵功能", "注意事項"],
    "註冊送件": ["市場／國家", "送件版本", "主管機關問題", "回覆內容", "待辦"],
    "製造／供應商": ["廠商／廠區", "材料／製程", "規格", "問題／風險", "改善追蹤"],
    "會議／紀錄": ["會議主題", "與會者", "討論事項", "決議", "待辦／負責人"],
    "其他文件": [], "標準系列／章節": [], "試驗項目": [], "零組件／功能": [],
    "國家／市場": [], "供應商／型號": [], "專案階段": [], "其他主題": [],
    "年份／版本": [], "單一標準／文件": [], "試驗批次／報告": [], "送件版本": [],
    "會議日期": [], "其他細分": []
  };

  Object.keys(extraTemplates).forEach((key) => { FOLDER_TEMPLATES[key] = extraTemplates[key]; });
  const architectureOrder = [];
  Object.keys(LEVEL_CHOICES).forEach((level) => {
    LEVEL_CHOICES[level].forEach((item) => {
      const key = item[0];
      FOLDER_TYPE_META[key] = [item[1], item[2]];
      if (!architectureOrder.includes(key)) architectureOrder.push(key);
    });
  });
  ["參展", "拜訪", "實驗", "上課", "會議", "查廠", "其他"].forEach((key) => {
    if (!architectureOrder.includes(key)) architectureOrder.push(key);
  });
  FOLDER_TYPE_ORDER.splice(0, FOLDER_TYPE_ORDER.length, ...architectureOrder);

  const style = document.createElement("style");
  style.id = "fieldlog-knowledge-architecture-style";
  style.textContent = [
    ".folder-architecture-guide{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:-2px 0 14px;padding:10px 12px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#1e3a8a;font-size:12px}",
    ".folder-architecture-guide span{display:inline-flex;align-items:center;gap:5px}",
    ".folder-architecture-guide b{display:grid;place-items:center;width:21px;height:21px;border-radius:7px;background:#2563eb;color:#fff;font-size:11px}",
    ".folder-architecture-guide i{font-style:normal;color:#60a5fa}",
    ".folder-level-chip{display:inline-flex;align-items:center;margin-left:6px;padding:2px 7px;border-radius:999px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:600}",
    ".folder-type-fieldset legend::after{content:'｜依目前層級顯示建議用途';color:var(--text-muted);font-size:11px;font-weight:400}",
    "@media(max-width:719px){.folder-architecture-guide{align-items:flex-start}.folder-architecture-guide i{display:none}.folder-architecture-guide span{width:calc(50% - 4px)}}"
  ].join("");
  document.head.appendChild(style);

  function depthByFolder(folder) {
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

  function folderById(id) {
    return FOLDERS.find((item) => Number(item.id) === Number(id));
  }

  function pathForFolder(folder) {
    const path = [];
    let current = folder;
    const visited = new Set();
    while (current) {
      const id = Number(current.id || 0);
      if (!id || visited.has(id)) break;
      visited.add(id);
      path.unshift(current.name);
      current = current.parent_id ? folderById(current.parent_id) : null;
    }
    return path;
  }

  function choicesForLevel(level) {
    return LEVEL_CHOICES[Math.min(4, Math.max(1, Number(level || 1)))] || LEVEL_CHOICES[4];
  }

  askFolderDetails = function architectureAskFolderDetails(options) {
    options = options || {};
    if (CREATE_FOLDER_RESOLVE) closeCreateFolderDialog(null);
    const parentId = options.parentId ? Number(options.parentId) : null;
    const parent = parentId ? folderById(parentId) : null;
    const level = parent ? Math.min(4, depthByFolder(parent) + 1) : 1;
    const choices = choicesForLevel(level);
    const selectedType = choices.some((item) => item[0] === options.type) ? options.type : choices[0][0];
    const title = options.title || (level === 1 ? "新增產品／專案" : "新增第 " + level + " 層資料夾");
    const baseDesc = options.desc || "建立可延伸到所有文件的共用架構";

    $("create-folder-title").textContent = title;
    $("create-folder-desc").textContent = baseDesc + "｜第 " + level + " 層：" + LEVEL_HINTS[level];
    $("create-folder-name").value = options.name || "";
    $("create-folder-types").innerHTML = choices.map((item) => {
      const key = item[0];
      return '<label class="folder-type-option"><input type="radio" name="folder-type" value="' + esc(key) + '" ' + (key === selectedType ? 'checked' : '') + '><span><b>' + item[1] + '</b><strong>' + esc(key) + '</strong><small>' + esc(item[2]) + '</small></span></label>';
    }).join("");
    $("create-folder-overlay").classList.add("open");
    setTimeout(() => $("create-folder-name").focus(), 0);
    return new Promise((resolve) => { CREATE_FOLDER_RESOLVE = resolve; });
  };

  createFolderForArchive = async function architectureCreateFolderForArchive(suggestedName) {
    const defaultName = String(suggestedName || "待分類專案").replace(/（未命名）/g, "").trim() || "待分類專案";
    const details = await askFolderDetails({
      title: "建立產品／專案並歸檔",
      desc: "先建立第1層，後續可再加入文件類型與主題",
      name: defaultName,
      parentId: null
    });
    if (!details) return null;
    const folder = await api("/folders", { method: "POST", body: JSON.stringify(details) });
    return { id: Number(folder.id), ...details };
  };

  newFolder = async function architectureNewFolder() {
    const details = await askFolderDetails({
      title: "新增產品／專案",
      desc: "第1層不限定 ISO，可建立任何產品、共通法規或合作專案",
      parentId: null
    });
    if (!details) return;
    await api("/folders", { method: "POST", body: JSON.stringify(details) });
    showToast("產品／專案資料夾已建立");
    loadFolders();
  };

  newSubfolder = async function architectureNewSubfolder() {
    if (!CURRENT_FOLDER) return;
    const parentId = CURRENT_FOLDER.id;
    const nextLevel = depthByFolder(CURRENT_FOLDER) + 1;
    if (nextLevel > 4) {
      showToast("資料夾最多四層");
      return;
    }
    const details = await askFolderDetails({
      title: "新增第 " + nextLevel + " 層資料夾",
      desc: "建立在「" + CURRENT_FOLDER.name + "」裡面",
      parentId: parentId
    });
    if (!details) return;
    await api("/folders", { method: "POST", body: JSON.stringify({ ...details, parent_id: parentId }) });
    await loadFolders();
    showToast("已建立第 " + nextLevel + " 層資料夾");
    openFolder(parentId);
  };

  renderChildFolders = function architectureRenderChildFolders(parentId) {
    const children = FOLDERS.filter((item) => Number(item.parent_id) === Number(parentId)).sort(compareFolders);
    const wrap = $("folder-children");
    wrap.innerHTML = children.length ? '<h3>📂 子資料夾</h3><div class="child-folder-list ' + INNER_FOLDER_VIEW + '-view">' + children.map((folder) => {
      const depth = depthByFolder(folder);
      return '<button class="child-folder-card" type="button" data-id="' + folder.id + '"><span>📁</span><strong>' + esc(folder.name) + '</strong><small>' + esc(folder.type) + '<span class="folder-level-chip">第' + depth + '層</span>｜' + folder.entry_count + ' 筆' + (folder.child_count ? '｜' + folder.child_count + ' 個子資料夾' : '') + '</small></button>';
    }).join("") + '</div>' : "";
    wrap.querySelectorAll(".child-folder-card").forEach((element) => {
      element.onclick = () => openFolder(Number(element.dataset.id));
    });
  };

  const originalOpenFolderArchitecture = openFolder;
  openFolder = async function architectureOpenFolder(id) {
    const result = await originalOpenFolderArchitecture(id);
    if (CURRENT_FOLDER) {
      const path = pathForFolder(CURRENT_FOLDER);
      const title = $("folder-title");
      if (title) title.textContent = path.join(" ／ ");
    }
    return result;
  };

  function addArchitectureGuide() {
    if (document.querySelector(".folder-architecture-guide")) return;
    const toolbar = document.querySelector(".home-files-panel .folders-toolbar") || document.querySelector(".folders-panel .folders-toolbar");
    if (!toolbar) return;
    const guide = document.createElement("div");
    guide.className = "folder-architecture-guide";
    guide.innerHTML = '<span><b>1</b>產品／專案</span><i>›</i><span><b>2</b>文件類型</span><i>›</i><span><b>3</b>主題／試驗／標準系列</span><i>›</i><span><b>4</b>年份／版本／文件群</span>';
    toolbar.insertAdjacentElement("afterend", guide);
    const desc = document.querySelector(".home-files-section .home-section-desc");
    if (desc) desc.textContent = "所有資料夾共用四層架構；ISO、仿單、計畫書、報告書、風險與註冊資料都能依產品整理。";
  }

  const rootButton = $("btn-new-folder");
  if (rootButton) rootButton.onclick = newFolder;
  const subfolderButton = $("btn-new-subfolder");
  if (subfolderButton) subfolderButton.onclick = newSubfolder;
  addArchitectureGuide();
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
      return new Response(`${await response.text()}\n${FOLDER_LAYOUT_AND_DEPTH_UI}\n${KNOWLEDGE_ARCHITECTURE_UI}`, {
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
