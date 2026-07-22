// ===== 隨身記（fieldlog）=====
// 採集優先：先記再說，歸檔是事後（交給 AI）的事。

const $ = (id) => document.getElementById(id);

// 四種活動的欄位模板（夠用就好，第五種場景出現再加）
const FOLDER_TEMPLATES = {
  "參展": ["廠商名", "攤位", "目標", "取得資料", "下一步"],
  "拜訪": ["對象", "聯絡人", "討論事項", "結論", "待辦"],
  "實驗": ["主題", "條件／參數", "觀察結果", "判定", "下次調整"],
  "上課": ["課程名", "講者", "重點", "待查資料"],
  "其他": [],
};

let FOLDERS = [];
let CURRENT_FOLDER = null; // 開啟中的資料夾物件
let TRANSCRIBE_ENABLED = false;
let FOLDER_VIEW = localStorage.getItem("fieldlog_folder_view") || (matchMedia("(max-width: 719px)").matches ? "list" : "grid");
let MERGE_SOURCE_ID = null;

// ---------- API ----------
function pin() { return localStorage.getItem("fieldlog_pin") || ""; }

async function api(path, options = {}) {
  const res = await fetch("/api" + path, {
    ...options,
    headers: { "content-type": "application/json", "x-pin": pin(), ...(options.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error("PIN 錯誤"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isPdfAtt(a) {
  return (a.mime || "") === "application/pdf" || (a.filename || "").toLowerCase().endsWith(".pdf");
}

// 長文（PDF 全文可達數萬字）在清單裡只顯示開頭
function clipText(s, n) {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字）` : s;
}

function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

// 全螢幕編輯框：轉文字稿／擷取文字（PDF 全文可達數萬字）用瀏覽器原生 prompt()
// 編輯區太小根本編不動，改用這個大文字框＋明確的儲存/取消按鈕
function openEditModal({ title, value, onSave }) {
  $("edit-modal-title").textContent = title;
  const ta = $("edit-modal-textarea");
  ta.value = value || "";
  const countEl = $("edit-modal-count");
  const updateCount = () => { countEl.textContent = `${ta.value.length} 字`; };
  updateCount();
  ta.oninput = updateCount;
  const overlay = $("edit-overlay");
  overlay.classList.add("open");
  ta.focus();
  const close = () => { overlay.classList.remove("open"); ta.oninput = null; };
  $("edit-modal-close").onclick = close;
  $("edit-modal-cancel").onclick = close;
  $("edit-modal-save").onclick = async () => {
    const saveBtn = $("edit-modal-save");
    saveBtn.disabled = true;
    try {
      await onSave(ta.value.trim());
      close();
    } catch (err) {
      showToast("儲存失敗：" + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  };
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtUsageNumber(n) {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(Number(n || 0));
}

async function loadUsage() {
  const wrap = $("usage-content");
  if (!wrap) return;
  wrap.innerHTML = `<p class="sub">正在讀取 Cloudflare 帳單用量…</p>`;
  try {
    const data = await api("/usage");
    if (!data.products.length) {
      wrap.innerHTML = `<p class="sub">目前沒有 Workers AI、D1 或 R2 的付費用量紀錄。免費額度內可能不會產生帳單項目。</p>`;
      return;
    }
    wrap.innerHTML = `<div class="usage-total">
        <span>本期實際費用</span><strong>${esc(data.currency)} ${fmtUsageNumber(data.totalCost)}</strong>
        <small>${Number(data.totalCost) === 0 ? "目前都在包含額度內" : "已有超額費用"}</small>
      </div>
      <div class="usage-limits"><h3>包含額度使用率</h3>${(data.limits || []).map((item) => {
        const percent = item.limit ? item.used / item.limit * 100 : 0;
        return `<div class="usage-limit ${percent > 100 ? "over" : ""}">
          <div><strong>${esc(item.label)}</strong><span>${fmtUsageNumber(item.used)} / ${fmtUsageNumber(item.limit)} ${esc(item.unit)}</span></div>
          <div class="usage-bar" role="progressbar" aria-valuenow="${Math.round(percent)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, percent)}%"></i></div>
          <small>${percent > 100 ? `已超出免費額度 ${fmtUsageNumber(percent - 100)}%` : `已使用 ${fmtUsageNumber(percent)}%`}</small>
        </div>`;
      }).join("")}</div>
      <p class="sub usage-updated">${data.source === "billable" ? "實際帳單資料" : "Pay-as-you-go 帳單資料"}｜更新：${new Date(data.updatedAt).toLocaleString("zh-TW")}</p>`;
  } catch (err) {
    wrap.innerHTML = `<p class="usage-error">暫時無法讀取用量：${esc(err.message)}</p>`;
  }
}

// ---------- 登入 ----------
function showLogin() { $("login-overlay").classList.add("open"); }

async function doLogin() {
  localStorage.setItem("fieldlog_pin", $("login-pin").value.trim());
  const err = $("login-error");
  err.style.display = "none";
  try {
    await api("/folders");
    $("login-overlay").classList.remove("open");
    boot();
  } catch (e) {
    err.textContent = e.message;
    err.style.display = "block";
  }
}

// ---------- 首頁 ----------
async function boot() {
  try {
    const cfg = await api("/config");
    TRANSCRIBE_ENABLED = cfg.transcribe;
    localStorage.setItem("fieldlog_config", JSON.stringify(cfg));
  } catch {
    // /config 偶發失敗（手機網路不穩）時退回上次成功的值，
    // 避免整理/轉文字按鈕憑空消失；就算誤開，後端也會擋
    TRANSCRIBE_ENABLED = !!JSON.parse(localStorage.getItem("fieldlog_config") || "{}").transcribe;
  }
  await Promise.all([loadFolders(), loadInbox()]);
  loadUsage();
  syncPendingFiles();
}

async function loadFolders() {
  FOLDERS = await api("/folders");
  renderFolders();
}

function renderFolders() {
  const wrap = $("folder-list");
  wrap.className = `folder-list ${FOLDER_VIEW === "grid" ? "grid-view" : "list-view"}`;
  $("btn-folder-grid")?.classList.toggle("active", FOLDER_VIEW === "grid");
  $("btn-folder-list")?.classList.toggle("active", FOLDER_VIEW === "list");
  if (!FOLDERS.length) {
    wrap.innerHTML = `<p class="sub">還沒有資料夾。採集會先進收件匣；建了資料夾之後可以歸檔進去。</p>`;
    return;
  }
  wrap.innerHTML = FOLDERS.map((f) => `
    <div class="folder-card ${f.status !== "進行中" ? "done" : ""}" data-id="${f.id}">
      <button class="folder-drag" type="button" draggable="true" title="拖曳合併或刪除" aria-label="拖曳${esc(f.name)}">⠿</button>
      <div class="folder-card-main">
        <span class="folder-type">${esc(f.type)}</span>
        <span class="folder-name">${esc(f.name)}</span>
        <span class="folder-count">${f.entry_count} 筆記事</span>
        <span class="folder-date">建立於 ${esc((f.created_at || "").slice(0, 10))}</span>
      </div>
      <button class="folder-more" type="button" aria-label="${esc(f.name)}操作選單">⋯</button>
      <div class="folder-menu" hidden>
        <button type="button" data-act="rename">重新命名</button>
        <button type="button" data-act="merge">合併至其他資料夾</button>
        <button type="button" data-act="delete" class="danger">刪除資料夾</button>
      </div>
    </div>`).join("");
  wrap.querySelectorAll(".folder-card").forEach((el) => {
    el.querySelector(".folder-card-main").onclick = () => openFolder(Number(el.dataset.id));
    el.querySelector(".folder-more").onclick = (ev) => {
      ev.stopPropagation();
      wrap.querySelectorAll(".folder-menu").forEach((m) => { if (m !== el.querySelector(".folder-menu")) m.hidden = true; });
      el.querySelector(".folder-menu").hidden = !el.querySelector(".folder-menu").hidden;
    };
    el.querySelector('[data-act="rename"]').onclick = () => renameFolder(Number(el.dataset.id));
    el.querySelector('[data-act="merge"]').onclick = () => openMergeFolderDialog(Number(el.dataset.id));
    el.querySelector('[data-act="delete"]').onclick = () => deleteFolder(Number(el.dataset.id));
    const drag = el.querySelector(".folder-drag");
    drag.ondragstart = (ev) => {
      const sourceId = Number(el.dataset.id);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", String(sourceId));
      el.classList.add("dragging");
      document.body.classList.add("folder-dragging");
    };
    drag.ondragend = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("folder-dragging");
      wrap.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
    };
    el.ondragover = (ev) => { ev.preventDefault(); el.classList.add("drop-target"); ev.dataTransfer.dropEffect = "move"; };
    el.ondragleave = () => el.classList.remove("drop-target");
    el.ondrop = (ev) => {
      ev.preventDefault();
      el.classList.remove("drop-target");
      const sourceId = Number(ev.dataTransfer.getData("text/plain"));
      const targetId = Number(el.dataset.id);
      if (sourceId && sourceId !== targetId) mergeFolder(sourceId, targetId);
    };
  });
}

function setFolderView(view) {
  FOLDER_VIEW = view;
  localStorage.setItem("fieldlog_folder_view", view);
  renderFolders();
}

async function renameFolder(id) {
  const folder = FOLDERS.find((f) => f.id === id);
  if (!folder) return;
  const name = prompt("新的資料夾名稱：", folder.name);
  if (!name || !name.trim() || name.trim() === folder.name) return;
  await api(`/folders/${id}`, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
  showToast("資料夾已重新命名");
  loadFolders();
}

async function deleteFolder(id) {
  const folder = FOLDERS.find((f) => f.id === id);
  if (!folder) return;
  const detail = folder.entry_count
    ? `裡面的 ${folder.entry_count} 筆記事與附件會移回收件匣，不會刪除資料。`
    : "這是空資料夾。";
  if (!confirm(`確定刪除資料夾「${folder.name}」？\n\n${detail}`)) return;
  const result = await api(`/folders/${id}`, { method: "DELETE" });
  showToast(result.moved ? `資料夾已刪除，${result.moved} 筆記事移回收件匣` : "空資料夾已刪除");
  await Promise.all([loadFolders(), loadInbox()]);
}

function openMergeFolderDialog(sourceId) {
  const source = FOLDERS.find((f) => f.id === sourceId);
  const targets = FOLDERS.filter((f) => f.id !== sourceId);
  if (!source || !targets.length) { showToast("沒有其他資料夾可以合併"); return; }
  MERGE_SOURCE_ID = sourceId;
  $("merge-folder-desc").textContent = `將「${source.name}」的記事移入另一個資料夾；原資料夾會在合併後刪除。`;
  $("merge-folder-target").innerHTML = targets.map((f) => `<option value="${f.id}">${esc(f.type)}｜${esc(f.name)}（${f.entry_count} 筆）</option>`).join("");
  $("merge-folder-overlay").classList.add("open");
}

function closeMergeFolderDialog() {
  MERGE_SOURCE_ID = null;
  $("merge-folder-overlay").classList.remove("open");
}

async function mergeFolder(sourceId, targetId) {
  const source = FOLDERS.find((f) => f.id === sourceId);
  const target = FOLDERS.find((f) => f.id === targetId);
  if (!source || !target) return;
  if (!confirm(`確定將「${source.name}」合併到「${target.name}」？\n\n${source.entry_count} 筆記事與附件會移入目標資料夾，來源資料夾才會刪除。`)) return;
  const result = await api(`/folders/${sourceId}/merge`, { method: "POST", body: JSON.stringify({ target_id: targetId }) });
  closeMergeFolderDialog();
  showToast(`已合併，移動 ${result.moved} 筆記事`);
  await Promise.all([loadFolders(), loadInbox()]);
}

async function loadInbox() {
  const entries = await api("/entries?inbox=1");
  $("inbox-count").textContent = entries.length ? `（${entries.length}）` : "";
  $("inbox-panel").style.display = entries.length ? "block" : "none";
  $("inbox-list").innerHTML = entries.map(entryRowHtml).join("");
  bindEntryRows($("inbox-list"));
}

function entryRowHtml(e) {
  return `<div class="entry-row" data-id="${e.id}">
    <span class="entry-title">${esc(e.title || "（未命名）")}</span>
    <span class="entry-meta">${esc(e.created_at.slice(5, 16))}${e.att_count ? `｜📎${e.att_count}` : ""}</span>
    <button class="entry-del" data-id="${e.id}" type="button" title="刪除這筆紀錄">🗑</button>
  </div>`;
}

function bindEntryRows(wrap) {
  wrap.querySelectorAll(".entry-row").forEach((el) => {
    el.onclick = () => openEntry(Number(el.dataset.id));
  });
  wrap.querySelectorAll(".entry-del").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation(); // 不要連帶觸發外層 .entry-row 的開啟
      const id = Number(btn.dataset.id);
      if (!confirm("確定刪除這筆紀錄？裡面的附件也會一起刪除，無法復原。")) return;
      try {
        await api(`/entries/${id}`, { method: "DELETE" });
        showToast("已刪除");
        if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadInbox(); loadFolders(); }
      } catch (err) { showToast("刪除失敗：" + err.message); }
    };
  });
}

async function newFolder() {
  const name = prompt("資料夾名稱（例：2026 上海 Medtec、○○廠商拜訪、親水塗層 batch 12）：");
  if (!name || !name.trim()) return;
  const types = Object.keys(FOLDER_TEMPLATES);
  const type = prompt(`類型（${types.join("／")}）：`, "其他");
  const resolved = types.includes((type || "").trim()) ? type.trim() : "其他";
  await api("/folders", { method: "POST", body: JSON.stringify({ name: name.trim(), type: resolved }) });
  showToast("資料夾已建立");
  loadFolders();
}

// ---------- 資料夾內頁 ----------
async function openFolder(id) {
  CURRENT_FOLDER = FOLDERS.find((f) => f.id === id);
  if (!CURRENT_FOLDER) return;
  $("view-home").style.display = "none";
  $("view-folder").style.display = "block";
  $("folder-title").textContent = `${CURRENT_FOLDER.type}｜${CURRENT_FOLDER.name}`;
  const entries = await api(`/entries?folder_id=${id}`);
  $("folder-entries").innerHTML = entries.length
    ? entries.map(entryRowHtml).join("")
    : `<p class="sub">還沒有紀錄。按「採集」或「新紀錄」開始。</p>`;
  bindEntryRows($("folder-entries"));
}

function backHome() {
  CURRENT_FOLDER = null;
  $("view-folder").style.display = "none";
  $("view-home").style.display = "block";
  loadFolders();
  loadInbox();
}

// ---------- 紀錄 ----------
async function createEntry(folderId, title) {
  const r = await api("/entries", { method: "POST", body: JSON.stringify({ folder_id: folderId, title }) });
  return r.id;
}

async function quickNote() {
  const text = prompt("快速備忘（先進收件匣，之後歸檔）：");
  if (!text || !text.trim()) return;
  await api("/entries", { method: "POST", body: JSON.stringify({ folder_id: null, title: text.trim().slice(0, 30), body: text.trim() }) });
  showToast("已存入收件匣");
  loadInbox();
}

async function openEntry(id) {
  const e = await api(`/entries/${id}`);
  const folder = e.folder_id ? FOLDERS.find((f) => f.id === e.folder_id) : null;
  const template = FOLDER_TEMPLATES[folder ? folder.type : "其他"] || [];
  const fields = JSON.parse(e.fields_json || "{}");
  const mergedTranscript = (e.attachments || [])
    .filter((a) => a.kind === "audio" && (a.transcript || "").trim())
    .sort((a, b) => (a.offset_secs ?? 0) - (b.offset_secs ?? 0) || a.id - b.id)
    .map((a) => `【${fmtSecs(a.offset_secs ?? 0)}｜${a.filename}】\n${a.transcript.trim()}`)
    .join("\n\n");
  const modal = $("entry-modal");
  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="e-close" type="button" aria-label="關閉記事" title="關閉記事">✕</button></div>
    <div class="detail-head">
      <input id="e-title" class="title-input" value="${esc(e.title)}" placeholder="標題" />
    </div>
    <p class="sub">${esc(e.created_at)}｜${folder ? esc(folder.name) : "📥 收件匣"}</p>
    <section class="merged-transcript ${mergedTranscript ? "" : "empty"}">
      <div><strong>📝 合併逐字稿</strong><button class="btn small" id="e-copy-transcript" type="button" ${mergedTranscript ? "" : "disabled"}>複製</button></div>
      ${mergedTranscript ? `<pre>${esc(mergedTranscript)}</pre>` : `<p class="sub" id="e-auto-status">新錄音會在 70% 安全額度內自動轉錄並合併；舊錄音請使用下方「Cloudflare AI 整理」。</p>`}
      ${mergedTranscript ? `<p class="sub" id="e-auto-status">正在檢查是否有新的安全轉錄項目…</p>` : ""}
    </section>
    ${!folder ? `<div class="archive-row"><label>歸檔到：</label><select id="e-folder">
      <option value="">— 留在收件匣 —</option>
      ${FOLDERS.map((f) => `<option value="${f.id}">${esc(f.type)}｜${esc(f.name)}</option>`).join("")}
    </select></div>` : ""}
    ${template.map((k) => `<label>${esc(k)}</label><input class="e-field" data-key="${esc(k)}" value="${esc(fields[k] || "")}" />`).join("")}
    <label>內文／速記</label>
    <textarea id="e-body">${esc(e.body)}</textarea>
    <div class="modal-actions"><button class="btn primary" id="e-save">儲存</button></div>
    <hr/>
    <h3 class="section-title">附件</h3>
    <div class="upload-row">
      <button class="btn small capture-btn" id="e-video">🎥 錄影</button>
      <button class="btn small capture-btn" id="e-photo">📷 拍照</button>
      <button class="btn small capture-btn" id="e-audio">🎙 錄音</button>
      <label class="btn small upload-btn">📁 上傳<input type="file" id="e-file" accept="image/*,video/*,audio/*,application/pdf" multiple hidden /></label>
      <button class="btn small" id="e-process" type="button" title="用 Cloudflare AI 把還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取（已處理過的不會重跑）">🪄 Cloudflare AI 整理</button>
      <span id="e-upload-status" class="sub"></span>
    </div>
    <div id="e-attachments" class="att-list">${e.attachments.map((a) => attHtml(a, e.attachments)).join("") || `<p class="sub">尚無附件</p>`}</div>
    <div class="entry-danger-zone">
      <button class="btn entry-delete" id="e-delete" type="button">🗑 刪除整筆記事</button>
      <p class="sub">刪除後無法復原，附件也會一併刪除。</p>
    </div>
  `;
  $("entry-overlay").classList.add("open");
  lockBodyScroll();
  $("e-close").onclick = closeEntry;
  $("e-copy-transcript").onclick = async () => {
    if (!mergedTranscript) return;
    await navigator.clipboard.writeText(mergedTranscript);
    showToast("已複製合併逐字稿");
  };
  $("e-delete").onclick = async () => {
    if (!confirm(`確定刪除整筆紀錄「${e.title || "（未命名）"}」？裡面的附件也會一起刪除，無法復原。`)) return;
    try {
      await api(`/entries/${id}`, { method: "DELETE" });
      showToast("已刪除");
      closeEntry();
      if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadInbox(); loadFolders(); }
    } catch (err) { showToast("刪除失敗：" + err.message); }
  };
  $("e-save").onclick = async () => {
    const newFields = {};
    modal.querySelectorAll(".e-field").forEach((i) => { newFields[i.dataset.key] = i.value.trim(); });
    const patch = { title: $("e-title").value.trim(), body: $("e-body").value.trim(), fields: newFields };
    const sel = $("e-folder");
    if (sel && sel.value) patch.folder_id = Number(sel.value);
    await api(`/entries/${id}`, { method: "PUT", body: JSON.stringify(patch) });
    showToast("已儲存");
    closeEntry();
    if (CURRENT_FOLDER) openFolder(CURRENT_FOLDER.id); else { loadInbox(); loadFolders(); }
  };
  $("e-video").onclick = () => { closeEntry(); startVideo(id); };
  $("e-photo").onclick = () => { closeEntry(); startPhoto(id); };
  $("e-audio").onclick = () => { closeEntry(); startAudio(id); };
  const fileInput = $("e-file");
  fileInput.onchange = () => uploadFiles(id, fileInput);
  const processBtn = $("e-process");
  if (processBtn) processBtn.onclick = () => processEntryAttachments(id, processBtn);
  bindAttActions(id);
  api(`/entries/${id}/auto-transcribe`, { method: "POST", body: "{}" }).then((r) => {
    if (r.processed) {
      showToast(`已安全自動轉錄 ${r.processed} 段`);
      openEntry(id);
      return;
    }
    const status = $("e-auto-status");
    if (status && r.reason) status.textContent = r.reason;
  }).catch((err) => {
    const status = $("e-auto-status");
    if (status) status.textContent = `自動轉錄未執行：${err.message}`;
  });
}

// 🪄 一鍵整理：這筆紀錄還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取。
// 先錄音後照片——照片的【對話關聯】需要逐字稿先就位。失敗跳過，可個別重試。
async function processEntryAttachments(id, btn) {
  if (!TRANSCRIBE_ENABLED) { showToast("尚未啟用 AI 功能"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const e = await api(`/entries/${id}`);
    // 「處理過但結果是空的」（transcribed_at/ocr_at 有時間戳）不算待整理，不重跑
    const audioTodo = (e.attachments || []).filter((a) => a.kind === "audio" && !a.transcript && !a.transcribed_at);
    const photoTodo = (e.attachments || []).filter((a) => (a.kind === "photo" || isPdfAtt(a)) && !a.ocr_text && !a.ocr_at);
    const total = audioTodo.length + photoTodo.length;
    if (!total) { showToast("沒有需要整理的附件，都處理過了"); return; }
    let done = 0;
    let failed = 0;
    const errCounts = new Map(); // 各種失敗原因各出現幾次，跑完常駐顯示（toast 幾秒就消失，來不及看）
    let quotaHit = false; // Cloudflare AI 每日額度用完（4006）就立刻停，不再逐筆撞牆
    const queue = [
      ...audioTodo.map((a) => ({ a, ep: "transcribe" })),
      ...photoTodo.map((a) => ({ a, ep: "ocr" })),
    ];
    let gotText = 0;
    let gotEmpty = 0;
    const processedIds = [];
    for (const { a, ep } of queue) {
      btn.textContent = `🪄 ${++done}/${total}`;
      try {
        const res = await api(`/attachments/${a.id}/${ep}`, { method: "POST", body: "{}" });
        const resultText = (res.text ?? res.ocr_text ?? "").trim();
        if (resultText) gotText++; else gotEmpty++;
        processedIds.push(String(a.id));
      } catch (err) {
        failed++;
        errCounts.set(err.message, (errCounts.get(err.message) || 0) + 1);
        console.error(`整理失敗 [${a.filename}]`, err);
        if (/4006|neuron/i.test(err.message)) { quotaHit = true; break; }
      }
    }
    const errSummary = [...errCounts.entries()].map(([m, c]) => `${m}（×${c}）`).join("；");
    const okSummary = `有內容 ${gotText} 筆・無內容 ${gotEmpty} 筆`;
    await openEntry(id); // 先重新渲染，再把摘要寫進狀態欄（否則會被重繪洗掉）
    // 這次剛整理的附件標綠邊條＋自動展開結果，一眼看到新結果
    for (const pid of processedIds) {
      const item = document.querySelector(`.att-item[data-id="${pid}"]`);
      if (!item) continue;
      item.classList.add("just-processed");
      item.querySelectorAll("details.att-ai").forEach((d) => { d.open = true; });
    }
    const statusEl = $("e-upload-status");
    if (quotaHit) {
      showToast(`⛔ Cloudflare AI 每日免費額度已用完，已停止整理`);
      if (statusEl) statusEl.textContent = `⛔ 額度用完（台北早上 8 點重置後再按一次續跑）`;
    } else if (failed) {
      showToast(`整理完成，${failed} 筆失敗（原因見按鈕旁）`);
      if (statusEl) statusEl.textContent = `⚠️ ${failed} 筆失敗：${errSummary}${processedIds.length ? `｜成功 ${processedIds.length} 筆（${okSummary}），結果標綠在下方 ↓` : ""}`;
    } else {
      showToast(`整理完成：${total} 筆`);
      if (statusEl) statusEl.textContent = `✓ 本次整理 ${total} 筆：${okSummary}，結果標綠在下方 ↓`;
    }
  } catch (err) {
    showToast("整理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🪄 Cloudflare AI 整理";
  }
}

// 🔬 Tier 2 深度處理：手動指定單一 PDF 才會跑，絕不背景全庫批次（見 DATA-MODEL.md）。
// Cloudflare Worker 沒有 PDF 渲染能力，這步只能在瀏覽器端用 pdf.js 把每一頁畫成圖片，
// 再把每張頁面圖丟進既有的照片 OCR 流程——向量圖表跟排版化的技術參數文字都變成看得見
// 的像素，Llama Vision 抄得到，也自動進搜尋索引，不用另外蓋一套 Tier 2 儲存/搜尋機制。
async function deepProcessPdf(entryId, pdfAtt, btn) {
  if (!window.pdfjsLib) { showToast("PDF 渲染程式庫載入失敗，請檢查網路連線後重新整理頁面再試"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }
    btn.textContent = "下載 PDF…";
    const fileRes = await fetch(`/api/file/${encodeURIComponent(pdfAtt.key)}?pin=${encodeURIComponent(pin())}`);
    if (!fileRes.ok) throw new Error(`下載 PDF 失敗（HTTP ${fileRes.status}）`);
    const pdf = await pdfjsLib.getDocument({ data: await fileRes.arrayBuffer() }).promise;
    const total = pdf.numPages;
    if (total > 40 && !confirm(`這份 PDF 有 ${total} 頁，深度處理會產生 ${total} 張截圖並逐一跑 AI 辨識，較耗時間與額度。確定要繼續嗎？`)) {
      return;
    }
    let done = 0, failed = 0;
    const baseName = pdfAtt.filename.replace(/\.pdf$/i, "");
    for (let p = 1; p <= total; p++) {
      try {
        btn.textContent = `渲染第 ${p}/${total} 頁…`;
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2 }); // scale 2：解析度足夠給 OCR 辨識文字
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("畫布輸出失敗");
        const uploaded = await putFile(entryId, blob, `${baseName}-p${p}.png`, null, { sourcePdfId: pdfAtt.id, pageNo: p });
        btn.textContent = `辨識第 ${p}/${total} 頁…`;
        await api(`/attachments/${uploaded.id}/ocr`, { method: "POST", body: "{}" });
        done++;
      } catch (err) {
        failed++;
        console.error(`Tier 2 第 ${p} 頁失敗`, err);
        if (/4006|neuron/i.test(err.message || "")) {
          showToast("⛔ Cloudflare AI 每日免費額度已用完，深度處理中止（已完成的頁面已保留）");
          break;
        }
      }
    }
    showToast(failed ? `深度處理完成：${done} 頁成功、${failed} 頁失敗` : `深度處理完成：共 ${total} 頁`);
    openEntry(entryId);
  } catch (err) {
    showToast("深度處理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// 詳情頁開啟時鎖住底層頁面捲動（iOS Safari 光 overflow:hidden 不夠，
// 要用 position:fixed 才真的鎖得住），關閉時還原原本的捲動位置
function lockBodyScroll() {
  if (document.body.classList.contains("modal-open")) return; // 重複開啟（整理後刷新）時別把捲動位置蓋成 0
  document.body.dataset.scrollY = String(window.scrollY);
  document.body.style.top = `-${window.scrollY}px`;
  document.body.classList.add("modal-open");
}
function unlockBodyScroll() {
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, Number(document.body.dataset.scrollY || 0));
}

function closeEntry() { $("entry-overlay").classList.remove("open"); unlockBodyScroll(); }

function attHtml(a, siblings) {
  const url = `/api/file/${encodeURIComponent(a.key)}?pin=${encodeURIComponent(pin())}`;
  let preview = `<a href="${url}" target="_blank" rel="noopener">${esc(a.filename)}</a>`;
  if (a.kind === "photo") preview = `<a href="${url}" target="_blank" rel="noopener"><img class="att-thumb" src="${url}" loading="lazy" alt="${esc(a.filename)}" /></a>`;
  if (a.kind === "audio") preview = `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
  const offset = a.offset_secs !== null && a.offset_secs !== undefined ? `<span class="att-offset">📸 錄音 ${fmtSecs(a.offset_secs)}</span>` : "";
  // AI 整理區塊預設收合，只露一行狀態（附件一多頁面才不會被文字撐爆），點狀態展開全文與操作
  const aiFold = (summary, body) =>
    `<details class="att-ai"><summary>${summary}</summary><div class="att-ai-body">${body}</div></details>`;
  const transcribeBit = a.kind === "audio" && TRANSCRIBE_ENABLED
    ? (a.transcript
      ? aiFold(`📝 已整理｜${esc(clipText(a.transcript, 40))}`,
          `<p class="att-transcript">📝 ${esc(a.transcript)} <a href="#" class="att-transcribe skip-link" data-id="${a.id}" title="重新跑 AI 辨識並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
      : a.transcribed_at === "skipped"
        ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" class="att-transcribe" data-id="${a.id}">還是要辨識</a></p>`)
        : a.transcribed_at === "auto_failed"
          ? aiFold(`⚠️ 自動轉錄失敗`, `<p class="att-transcript">系統不會自動重試，以免重複計費。<a href="#" class="att-transcribe" data-id="${a.id}">手動重試</a></p>`)
          : a.transcribed_at === "processing"
            ? aiFold(`⏳ 自動轉錄中`, `<p class="att-transcript">正在安全轉錄，請稍後重新開啟記事。</p>`)
        : a.transcribed_at
          ? aiFold(`📝 已整理（無語音內容）`, `<p class="att-transcript">辨識過，沒有語音內容 <a href="#" class="att-transcribe" data-id="${a.id}">重新辨識</a></p>`)
          : aiFold(`⏳ 未整理`, `<a href="#" class="att-transcribe" data-id="${a.id}">轉文字</a> <a href="#" class="att-skip skip-link" data-id="${a.id}" data-field="skip_transcribe" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`))
    : "";
  const ocrBit = (a.kind === "photo" || isPdfAtt(a)) && TRANSCRIBE_ENABLED
    ? (a.ocr_text
      ? aiFold(`🔍 已整理｜${esc(clipText(a.ocr_text, 40))}`,
          `<p class="att-transcript">🔍 ${esc(clipText(a.ocr_text, 600))} <a href="#" class="att-ocr-edit" data-id="${a.id}">編輯</a> <a href="#" class="att-ocr skip-link" data-id="${a.id}" title="重新跑 AI 擷取並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
      : a.ocr_at === "skipped"
        ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" class="att-ocr" data-id="${a.id}">還是要擷取</a></p>`)
        : a.ocr_at
          ? aiFold(`🔍 已整理（沒有文字內容）`, `<p class="att-transcript">擷取過，沒有文字內容 <a href="#" class="att-ocr" data-id="${a.id}">重新擷取</a></p>`)
          : aiFold(`⏳ 未整理`, `<a href="#" class="att-ocr" data-id="${a.id}">🔍 擷取文字</a> <a href="#" class="att-skip skip-link" data-id="${a.id}" data-field="skip_ocr" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`))
    : "";
  // Tier 2 深度處理：只給 PDF，手動觸發，絕不自動全庫跑（見 DATA-MODEL.md）
  const tier2Count = (siblings || []).filter((x) => x.source_pdf_id === a.id).length;
  const tier2Bit = !isPdfAtt(a) || !TRANSCRIBE_ENABLED ? "" : tier2Count
    ? `<p class="att-tier2">🔬 已深度處理（${tier2Count} 頁截圖，在附件清單裡） <a href="#" class="att-tier2-btn skip-link" data-id="${a.id}">重新處理</a></p>`
    : `<p class="att-tier2"><a href="#" class="att-tier2-btn" data-id="${a.id}" title="把這份 PDF 逐頁轉成圖片並跑 AI 辨識，補齊一般擷取抓不到的圖形化排版/圖表內容。手動觸發、只處理這一份，較耗時間與額度">🔬 深度處理（逐頁轉圖辨識）</a></p>`;
  return `<div class="att-item" data-id="${a.id}" data-ocr="${esc(a.ocr_text || "")}">
    <div class="att-meta">${esc(a.created_at.slice(5, 16))} ${offset}
      <a href="#" class="att-delete" data-id="${a.id}">刪除</a>
    </div>
    ${preview}${ocrBit}${transcribeBit}${tier2Bit}
  </div>`;
}

function bindAttActions(entryId) {
  document.querySelectorAll(".att-transcribe").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      el.textContent = "轉錄中…";
      try {
        await api(`/attachments/${el.dataset.id}/transcribe`, { method: "POST", body: "{}" });
        openEntry(entryId);
      } catch (e) { el.textContent = "失敗，點我重試"; showToast(e.message); }
    };
  });
  document.querySelectorAll(".att-delete").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      if (!confirm("確定刪除這個附件？刪除後無法復原。")) return;
      try {
        await api(`/attachments/${el.dataset.id}`, { method: "DELETE" });
        openEntry(entryId);
      } catch (e) { showToast("刪除失敗：" + e.message); }
    };
  });
  document.querySelectorAll(".att-ocr").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      el.textContent = "擷取中…（約 10–20 秒）";
      try {
        await api(`/attachments/${el.dataset.id}/ocr`, { method: "POST", body: "{}" });
        openEntry(entryId);
      } catch (e) { el.textContent = "🔍 擷取失敗，點我重試"; showToast(e.message); }
    };
  });
  document.querySelectorAll(".att-ocr-edit").forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      const current = el.closest(".att-item").dataset.ocr || "";
      openEditModal({
        title: "修改擷取文字（AI 抄錯的地方直接改成正確內容）",
        value: current,
        onSave: async (text) => {
          await api(`/attachments/${el.dataset.id}`, { method: "PUT", body: JSON.stringify({ ocr_text: text }) });
          openEntry(entryId);
        },
      });
    };
  });
  // 「略過」＝標成不整理（不呼叫 AI），待整理數與批次都會跳過；可從「還是要辨識/擷取」反悔
  document.querySelectorAll(".att-skip").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      try {
        await api(`/attachments/${el.dataset.id}`, { method: "PUT", body: JSON.stringify({ [el.dataset.field]: true }) });
        openEntry(entryId);
      } catch (e) { showToast("設定失敗：" + e.message); }
    };
  });
  // Tier 2 深度處理：手動觸發，一次只處理使用者點的這一份 PDF
  document.querySelectorAll(".att-tier2-btn").forEach((el) => {
    el.onclick = async (ev) => {
      ev.preventDefault();
      const e = await api(`/entries/${entryId}`);
      const pdfAtt = (e.attachments || []).find((x) => String(x.id) === el.dataset.id);
      if (!pdfAtt) return;
      const existingCount = (e.attachments || []).filter((x) => x.source_pdf_id === pdfAtt.id).length;
      if (existingCount && !confirm(`這份 PDF 已經深度處理過（${existingCount} 頁），要重新處理一次嗎？會再產生一組新的頁面截圖。`)) return;
      deepProcessPdf(entryId, pdfAtt, el);
    };
  });
}

// ---------- 上傳（含離線佇列保底）----------
async function putFile(entryId, blob, filename, offsetSecs, meta) {
  const headers = {
    "content-type": blob.type || "application/octet-stream",
    "x-pin": pin(),
    "x-entry-id": String(entryId),
    "x-filename": encodeURIComponent(filename),
  };
  if (offsetSecs !== null && offsetSecs !== undefined) headers["x-offset-secs"] = String(offsetSecs);
  if (meta?.durationSecs) headers["x-duration-secs"] = String(Math.round(meta.durationSecs));
  // Tier 2 深度處理：PDF 逐頁 render 成圖片時，帶回來源 PDF id 與頁碼
  if (meta && meta.sourcePdfId !== undefined && meta.sourcePdfId !== null) headers["x-source-pdf-id"] = String(meta.sourcePdfId);
  if (meta && meta.pageNo !== undefined && meta.pageNo !== null) headers["x-page-no"] = String(meta.pageNo);
  const res = await fetch("/api/upload", { method: "POST", headers, body: blob });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function uploadFiles(entryId, input) {
  const files = input.files ? Array.from(input.files) : [];
  if (!files.length) return;
  input.value = "";
  const status = $("e-upload-status");
  let done = 0;
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { showToast(`${f.name} 超過 50MB，略過`); continue; }
    status.textContent = `上傳中…（${done + 1}/${files.length}）`;
    try { await putFile(entryId, f, f.name, null); done++; }
    catch { await queueFile(entryId, f, f.name, null); done++; }
  }
  status.textContent = "";
  showToast(`已處理 ${done} 個檔案`);
  openEntry(entryId);
}

// 離線佇列：IndexedDB 先存後傳（沿用 Medtec 驗證過的模式）
const FILE_DB = "fieldlog_pending";
function openFileDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pending", { keyPath: "tmp_id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueFile(entryId, blob, filename, offsetSecs) {
  const db = await openFileDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("pending", "readwrite");
    tx.objectStore("pending").put({
      tmp_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      entry_id: entryId, filename, offset_secs: offsetSecs, blob,
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function syncPendingFiles() {
  if (!navigator.onLine) return;
  let db;
  try { db = await openFileDB(); } catch { return; }
  const all = await new Promise((resolve) => {
    const req = db.transaction("pending", "readonly").objectStore("pending").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  let synced = 0;
  for (const f of all) {
    try {
      await putFile(f.entry_id, f.blob, f.filename, f.offset_secs);
      await new Promise((resolve) => {
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").delete(f.tmp_id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      synced++;
    } catch { break; }
  }
  if (synced) showToast(`已補傳 ${synced} 個離線檔案`);
}

// ---------- 現場採集：錄影／拍照／錄音是三個獨立入口，不互相綁定 ----------
// 各自獨立的理由：按「拍照」不該順便開始錄音；按「錄音」也不該
// 順便打開鏡頭全螢幕——只有按「錄影」才是真的要錄影。
// 拍照永遠要看得到即時畫面才拍（不做隱藏鏡頭盲拍那套）。
const SEG_MINUTES = 10;

function segOffset(session) { return Math.floor((Date.now() - session.startedAt) / 1000); }

async function ensureEntryForCapture(entryId, titlePrefix) {
  if (entryId) return { entryId, folderId: CURRENT_FOLDER ? CURRENT_FOLDER.id : null };
  const folderId = CURRENT_FOLDER ? CURRENT_FOLDER.id : null;
  const d = new Date();
  const title = `${titlePrefix} ${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const newId = await createEntry(folderId, title);
  return { entryId: newId, folderId };
}

async function addTimedNote(session) {
  if (!session) return;
  const text = prompt("記一句（會標上目前的時間點）：");
  if (!text || !text.trim()) return;
  const offset = fmtSecs(segOffset(session));
  try {
    const entry = await api(`/entries/${session.entryId}`);
    const line = `[${offset}] ${text.trim()}`;
    const body = entry.body ? `${entry.body}\n${line}` : line;
    await api(`/entries/${session.entryId}`, { method: "PUT", body: JSON.stringify({ body }) });
    showToast("已記錄");
  } catch (err) { showToast("記錄失敗：" + err.message); }
}

// ---- 資料夾／專案歸屬 chip：video/photo 兩個全螢幕模式共用同一套邏輯 ----
function folderChipLabel(folderId) {
  const folder = folderId ? FOLDERS.find((f) => f.id === folderId) : null;
  return folder ? `📂 ${folder.name}` : "📥 收件匣";
}

async function createFolderInline() {
  const name = prompt("資料夾名稱：");
  if (!name || !name.trim()) return undefined;
  const types = Object.keys(FOLDER_TEMPLATES);
  const type = prompt(`類型（${types.join("／")}）：`, "其他");
  const resolved = types.includes((type || "").trim()) ? type.trim() : "其他";
  const r = await api("/folders", { method: "POST", body: JSON.stringify({ name: name.trim(), type: resolved }) });
  FOLDERS = await api("/folders");
  return r.id;
}

function setupFolderChip(chipId, pickerId, getSession) {
  const chip = $(chipId);
  const picker = $(pickerId);
  chip.onclick = () => {
    if (picker.style.display === "block") { picker.style.display = "none"; return; }
    picker.innerHTML = [
      `<div class="cfp-item" data-id="">📥 收件匣（不歸檔）</div>`,
      ...FOLDERS.map((f) => `<div class="cfp-item" data-id="${f.id}">📂 ${esc(f.name)}</div>`),
      `<div class="cfp-item cfp-new" data-new="1">＋ 新資料夾</div>`,
    ].join("");
    picker.querySelectorAll(".cfp-item").forEach((el) => {
      el.onclick = async () => {
        picker.style.display = "none";
        const session = getSession();
        if (!session) return;
        let folderId = el.dataset.id ? Number(el.dataset.id) : null;
        if (el.dataset.new) {
          const created = await createFolderInline();
          if (created === undefined) return;
          folderId = created;
        }
        try {
          await api(`/entries/${session.entryId}`, { method: "PUT", body: JSON.stringify({ folder_id: folderId }) });
          session.folderId = folderId;
          chip.textContent = folderChipLabel(folderId);
        } catch (err) { showToast("歸檔失敗：" + err.message); }
      };
    });
    picker.style.display = "block";
  };
}

// ================= 🎥 錄影（開鏡頭，錄音+錄影全螢幕） =================
let VIDEO = null;

function startVideoSegRecorder() {
  const audioTrack = new MediaStream(VIDEO.stream.getAudioTracks());
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = mimeType ? new MediaRecorder(audioTrack, { mimeType }) : new MediaRecorder(audioTrack);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onVideoSegmentStop(recorder, chunks);
  VIDEO.recorder = recorder;
  VIDEO.segStartMs = Date.now();
  recorder.start();
}

async function startVideo(entryId) {
  if (VIDEO) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { showToast("這個瀏覽器不支援錄影"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true,
    });
  } catch (err) { showToast("無法開啟相機或麥克風：" + err.message); return; }
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "錄影"); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); showToast("無法建立紀錄：" + err.message); return; }
  $("capture-video").srcObject = stream;
  VIDEO = { stream, recorder: null, startedAt: Date.now(), segIndex: 1, segStartMs: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId, ending: false, autoStopped: false, timerId: 0 };
  startVideoSegRecorder();
  $("capture-count").textContent = "";
  $("capture-timer").textContent = "00:00";
  $("capture-folder-chip").textContent = folderChipLabel(VIDEO.folderId);
  $("capture-overlay").style.display = "flex";
  VIDEO.timerId = setInterval(() => {
    if (!VIDEO || VIDEO.ending) return;
    $("capture-timer").textContent = fmtSecs(segOffset(VIDEO));
    if (VIDEO.recorder.state === "recording" && Date.now() - VIDEO.segStartMs >= SEG_MINUTES * 60 * 1000) {
      VIDEO.recorder.stop();
    }
  }, 1000);
}

async function videoSnap() {
  if (!VIDEO) return;
  const video = $("capture-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const offset = segOffset(VIDEO);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("capture-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  VIDEO.photos++;
  $("capture-count").textContent = `📷 ${VIDEO.photos}`;
  const { entryId } = VIDEO;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${fmtSecs(offset).replace(":", "")}.jpg`;
  try { await putFile(entryId, blob, filename, offset); }
  catch { await queueFile(entryId, blob, filename, offset); showToast("網路不穩，照片先存手機"); }
}

function stopVideo() {
  if (!VIDEO) return;
  VIDEO.ending = true;
  if (VIDEO.recorder && VIDEO.recorder.state !== "inactive") VIDEO.recorder.stop();
}

async function onVideoSegmentStop(recorder, chunks) {
  if (!VIDEO) return;
  const { stream, entryId, photos, timerId, ending, autoStopped, segIndex, segStartMs, startedAt, folderId } = VIDEO;
  const segStartOffset = Math.floor((segStartMs - startedAt) / 1000);
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `錄影音軌-段${segIndex}.${ext}`;

  if (ending) {
    clearInterval(timerId);
    stream.getTracks().forEach((t) => t.stop());
    $("capture-video").srcObject = null;
    $("capture-folder-picker").style.display = "none";
    $("capture-overlay").style.display = "none";
    VIDEO = null;
    if (blob.size) {
      showToast(autoStopped ? "偵測到切換 App，已自動結束並存檔" : "錄影中的錄音上傳中…");
      try { await putFile(entryId, blob, filename, segStartOffset); }
      catch { await queueFile(entryId, blob, filename, segStartOffset); }
    }
    showToast(`錄影完成：錄音 ${segIndex} 段＋照片 ${photos} 張`);
    if (CURRENT_FOLDER && folderId === CURRENT_FOLDER.id) openFolder(CURRENT_FOLDER.id);
    else { loadInbox(); loadFolders(); }
    openEntry(entryId);
  } else {
    VIDEO.segIndex++;
    startVideoSegRecorder();
    if (blob.size) {
      putFile(entryId, blob, filename, segStartOffset)
        .catch(() => queueFile(entryId, blob, filename, segStartOffset));
    }
  }
}

// ================= 📷 拍照（單獨鏡頭，不錄音） =================
let PHOTO = null;

async function startPhoto(entryId) {
  if (PHOTO) return;
  if (!navigator.mediaDevices) { showToast("這個瀏覽器不支援拍照"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "拍照"); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); showToast("無法建立紀錄：" + err.message); return; }
  $("photo-video").srcObject = stream;
  PHOTO = { stream, startedAt: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId };
  $("photo-count").textContent = "";
  $("photo-folder-chip").textContent = folderChipLabel(PHOTO.folderId);
  $("photo-overlay").style.display = "flex";
}

async function photoSnap() {
  if (!PHOTO) return;
  const video = $("photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("photo-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  PHOTO.photos++;
  $("photo-count").textContent = `📷 ${PHOTO.photos}`;
  const { entryId } = PHOTO;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${Date.now()}.jpg`;
  try { await putFile(entryId, blob, filename, null); }
  catch { await queueFile(entryId, blob, filename, null); showToast("網路不穩，照片先存手機"); }
}

function finishPhoto() {
  if (!PHOTO) return;
  const { stream, entryId, photos, folderId } = PHOTO;
  stream.getTracks().forEach((t) => t.stop());
  $("photo-video").srcObject = null;
  $("photo-folder-picker").style.display = "none";
  $("photo-overlay").style.display = "none";
  PHOTO = null;
  if (photos) showToast(`已拍 ${photos} 張`);
  if (CURRENT_FOLDER && folderId === CURRENT_FOLDER.id) openFolder(CURRENT_FOLDER.id);
  else { loadInbox(); loadFolders(); }
  if (photos) openEntry(entryId);
}

// ================= 🎙 錄音（不開鏡頭；浮動控制列，拍照時才臨時開鏡頭預覽） =================
let AUDIO = null;

function startAudioSegRecorder() {
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = mimeType ? new MediaRecorder(AUDIO.stream, { mimeType }) : new MediaRecorder(AUDIO.stream);
  const chunks = [];
  // 把這一段的中繼資料快照進閉包，不在 onstop 時才去讀 AUDIO——這樣「背景被系統中斷
  // 的舊 recorder」與「前台回復時接續的新 recorder」不會互相搶 segIndex/offset。
  const seg = { index: AUDIO.segIndex, startOffset: Math.floor((Date.now() - AUDIO.startedAt) / 1000), entryId: AUDIO.entryId, startedAt: Date.now() };
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onAudioSegmentStop(recorder, chunks, seg);
  AUDIO.recorder = recorder;
  AUDIO.segStartMs = Date.now();
  recorder.start();
}

async function startAudio(entryId) {
  if (AUDIO) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { showToast("這個瀏覽器不支援錄音"); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (err) { showToast("無法開啟麥克風：" + err.message); return; }
  let ref;
  try { ref = await ensureEntryForCapture(entryId, "錄音"); }
  catch (err) { stream.getTracks().forEach((t) => t.stop()); showToast("無法建立紀錄：" + err.message); return; }
  AUDIO = { stream, recorder: null, startedAt: Date.now(), segIndex: 1, segStartMs: Date.now(), photos: 0, entryId: ref.entryId, folderId: ref.folderId, ending: false, autoStopped: false, timerId: 0 };
  startAudioSegRecorder();
  $("audio-timer").textContent = "00:00";
  $("audio-badge").style.display = "flex";
  AUDIO.timerId = setInterval(() => {
    if (!AUDIO || AUDIO.ending) return;
    $("audio-timer").textContent = fmtSecs(segOffset(AUDIO));
    if (AUDIO.recorder.state === "recording" && Date.now() - AUDIO.segStartMs >= SEG_MINUTES * 60 * 1000) {
      AUDIO.recorder.stop();
    }
  }, 1000);
}

function stopAudio() {
  if (!AUDIO) return;
  AUDIO.ending = true;
  if (AUDIO.recorder && AUDIO.recorder.state !== "inactive") {
    AUDIO.recorder.stop(); // → onstop 走 ending 收尾路徑（會上傳最後一段）
  } else {
    finalizeAudioStop(); // recorder 已被系統停掉（背景中斷）：沒有新段可傳，直接收尾
  }
}

// 收尾：關麥克風、藏浮動列、跳完成提示、重開紀錄。stopAudio 與 onstop 收尾路徑共用
function finalizeAudioStop() {
  if (!AUDIO) return;
  const { stream, timerId, photos, entryId, segIndex } = AUDIO;
  clearInterval(timerId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  $("audio-badge").style.display = "none";
  AUDIO = null;
  showToast(`錄音完成：共 ${segIndex} 段${photos ? `＋照片 ${photos} 張` : ""}`);
  openEntry(entryId);
}

async function onAudioSegmentStop(recorder, chunks, seg) {
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `錄音-段${seg.index}.${ext}`;
  const durationSecs = Math.max(1, Math.ceil((Date.now() - seg.startedAt) / 1000));
  const uploadSeg = async () => {
    if (!blob.size) return;
    try { await putFile(seg.entryId, blob, filename, seg.startOffset, { durationSecs }); }
    catch { await queueFile(seg.entryId, blob, filename, seg.startOffset); }
  };

  // AUDIO 已整個結束（stopAudio 收尾時把 AUDIO 設成 null）：這是最後一段，只上傳
  if (!AUDIO) { await uploadSeg(); return; }

  // 只有「仍是當前 recorder」的 onstop 才負責收尾或接續下一段——避免背景中被系統
  // 停掉的舊 recorder，其延遲觸發的 onstop 跟前台回復時已接續的新 recorder 重複啟動
  const isCurrent = AUDIO.recorder === recorder;

  if (AUDIO.ending && isCurrent) {
    if (blob.size) showToast(AUDIO.autoStopped ? "頁面關閉，已自動存檔" : "錄音上傳中…");
    await uploadSeg();
    finalizeAudioStop();
    return;
  }

  // 一般段落輪替，或背景中被系統停掉：仍是當前 recorder 才接續下一段
  if (isCurrent && !AUDIO.ending) {
    AUDIO.segIndex++;
    startAudioSegRecorder();
  }
  await uploadSeg();
}

// 回到前台時：若背景中錄音被系統中斷（iOS 一定會、Android 記憶體吃緊時可能），
// 且沒有自動接上，就接續錄新的一段。錄音不會整個結束，切走前錄的也都保住。
function resumeAudioOnForeground() {
  if (!AUDIO || AUDIO.ending) return;
  const st = AUDIO.recorder && AUDIO.recorder.state;
  if (st !== "recording") {
    // 桌機 Chrome 背景分頁不會中斷，這條通常不會走到；留著是保底（其他情境被系統停掉時接續）
    try {
      AUDIO.segIndex++;
      startAudioSegRecorder();
      showToast("錄音曾被系統中斷，已接續錄音");
    } catch (err) {
      showToast("錄音無法自動接續，請再按一次錄音：" + err.message);
    }
  }
}

// 錄音中臨時拍照：另外開一個鏡頭串流，看得到畫面才拍，拍完立刻關閉鏡頭
// （錄音本身走另一條 stream，鏡頭開關不會中斷錄音）
let AUDIO_PHOTO_STREAM = null;

async function openAudioPhotoPopup() {
  if (!AUDIO || AUDIO_PHOTO_STREAM) return;
  try {
    AUDIO_PHOTO_STREAM = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  $("audio-photo-video").srcObject = AUDIO_PHOTO_STREAM;
  $("audio-photo-popup").style.display = "flex";
}

function closeAudioPhotoPopup() {
  if (AUDIO_PHOTO_STREAM) AUDIO_PHOTO_STREAM.getTracks().forEach((t) => t.stop());
  AUDIO_PHOTO_STREAM = null;
  $("audio-photo-video").srcObject = null;
  $("audio-photo-popup").style.display = "none";
}

async function audioPhotoSnap() {
  if (!AUDIO || !AUDIO_PHOTO_STREAM) return;
  const video = $("audio-photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const offset = segOffset(AUDIO);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  AUDIO.photos++;
  const { entryId } = AUDIO;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${fmtSecs(offset).replace(":", "")}.jpg`;
  closeAudioPhotoPopup();
  showToast(`已拍照（第 ${AUDIO.photos} 張）`);
  try { await putFile(entryId, blob, filename, offset); }
  catch { await queueFile(entryId, blob, filename, offset); showToast("網路不穩，照片先存手機"); }
}

// 切到別的分頁/App（頁面隱藏）：錄影要用鏡頭、背景無法運作，維持自動結束存檔；
// 純錄音則「不結束」，繼續在背景錄——Android 真的會繼續，iOS 系統會暫停但回前台
// 自動接續、切走前錄的都保住。頁面「真的卸載」（pagehide）才把錄音收尾存檔。
function onPageHidden() {
  if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
  if (AUDIO_PHOTO_STREAM) closeAudioPhotoPopup(); // 拍照鏡頭關掉，但錄音續錄
}

function stopAnyActiveCapture() {
  if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
  if (AUDIO) { AUDIO.autoStopped = true; stopAudio(); }
  if (AUDIO_PHOTO_STREAM) closeAudioPhotoPopup();
}

// ---------- 匯出 ----------
function exportFolder() {
  if (!CURRENT_FOLDER) return;
  window.open(`/api/export/folder/${CURRENT_FOLDER.id}?pin=${encodeURIComponent(pin())}`, "_blank");
}

// ---------- init ----------
function init() {
  $("btn-login").onclick = doLogin;
  $("login-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("btn-video").onclick = () => startVideo(null);
  $("btn-photo").onclick = () => startPhoto(null);
  $("btn-audio").onclick = () => startAudio(null);
  $("btn-quick-note").onclick = quickNote;
  $("btn-new-folder").onclick = newFolder;
  $("btn-folder-grid").onclick = () => setFolderView("grid");
  $("btn-folder-list").onclick = () => setFolderView("list");
  $("merge-folder-cancel").onclick = closeMergeFolderDialog;
  $("merge-folder-confirm").onclick = () => {
    const targetId = Number($("merge-folder-target").value);
    if (MERGE_SOURCE_ID && targetId) mergeFolder(MERGE_SOURCE_ID, targetId);
  };
  $("merge-folder-overlay").addEventListener("click", (e) => { if (e.target === $("merge-folder-overlay")) closeMergeFolderDialog(); });
  const trash = $("folder-trash-zone");
  trash.ondragover = (ev) => { ev.preventDefault(); trash.classList.add("active"); ev.dataTransfer.dropEffect = "move"; };
  trash.ondragleave = () => trash.classList.remove("active");
  trash.ondrop = (ev) => {
    ev.preventDefault();
    trash.classList.remove("active");
    const sourceId = Number(ev.dataTransfer.getData("text/plain"));
    if (sourceId) deleteFolder(sourceId);
  };
  $("btn-usage-refresh").onclick = loadUsage;
  $("btn-back").onclick = backHome;
  $("btn-video-f").onclick = () => startVideo(null);
  $("btn-photo-f").onclick = () => startPhoto(null);
  $("btn-audio-f").onclick = () => startAudio(null);
  $("btn-folder-entry").onclick = async () => {
    const id = await createEntry(CURRENT_FOLDER.id, "");
    openFolder(CURRENT_FOLDER.id);
    openEntry(id);
  };
  $("btn-folder-export").onclick = exportFolder;

  // 🎥 錄影
  $("capture-snap").onclick = videoSnap;
  $("capture-stop").onclick = stopVideo;
  $("capture-note").onclick = () => addTimedNote(VIDEO);
  setupFolderChip("capture-folder-chip", "capture-folder-picker", () => VIDEO);

  // 📷 拍照
  $("photo-snap").onclick = photoSnap;
  $("photo-done").onclick = finishPhoto;
  setupFolderChip("photo-folder-chip", "photo-folder-picker", () => PHOTO);

  // 🎙 錄音
  $("audio-photo-btn").onclick = openAudioPhotoPopup;
  $("audio-note-btn").onclick = () => addTimedNote(AUDIO);
  $("audio-stop-btn").onclick = stopAudio;
  $("audio-photo-cancel").onclick = closeAudioPhotoPopup;
  $("audio-photo-snap").onclick = audioPhotoSnap;

  $("entry-overlay").addEventListener("click", (e) => { if (e.target === $("entry-overlay")) closeEntry(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onPageHidden();     // 背景：錄影結束、錄音續錄
    else resumeAudioOnForeground();          // 回前台：錄音若被系統中斷則接續
  });
  window.addEventListener("pagehide", stopAnyActiveCapture); // 真的關頁面：全部收尾存檔
  window.addEventListener("online", syncPendingFiles);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (!pin()) { showLogin(); } else {
    api("/folders").then(() => boot()).catch(() => showLogin());
  }
}

init();
