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

function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
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
  } catch { TRANSCRIBE_ENABLED = false; }
  await Promise.all([loadFolders(), loadInbox()]);
  syncPendingFiles();
}

async function loadFolders() {
  FOLDERS = await api("/folders");
  const wrap = $("folder-list");
  if (!FOLDERS.length) {
    wrap.innerHTML = `<p class="sub">還沒有資料夾。採集會先進收件匣；建了資料夾之後可以歸檔進去。</p>`;
    return;
  }
  wrap.innerHTML = FOLDERS.map((f) => `
    <div class="folder-card ${f.status !== "進行中" ? "done" : ""}" data-id="${f.id}">
      <span class="folder-type">${esc(f.type)}</span>
      <span class="folder-name">${esc(f.name)}</span>
      <span class="folder-count">${f.entry_count} 筆</span>
    </div>`).join("");
  wrap.querySelectorAll(".folder-card").forEach((el) => {
    el.onclick = () => openFolder(Number(el.dataset.id));
  });
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
  </div>`;
}

function bindEntryRows(wrap) {
  wrap.querySelectorAll(".entry-row").forEach((el) => {
    el.onclick = () => openEntry(Number(el.dataset.id));
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
  const modal = $("entry-modal");
  modal.innerHTML = `
    <div class="detail-head">
      <input id="e-title" class="title-input" value="${esc(e.title)}" placeholder="標題" />
      <button class="btn small ghost" id="e-delete" title="刪除整筆紀錄">🗑</button>
      <button class="btn small ghost" id="e-close">✕</button>
    </div>
    <p class="sub">${esc(e.created_at)}｜${folder ? esc(folder.name) : "📥 收件匣"}</p>
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
      <button class="btn small" id="e-process" type="button" title="還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取">🪄 一鍵整理</button>
      <span id="e-upload-status" class="sub"></span>
    </div>
    <div id="e-attachments" class="att-list">${e.attachments.map(attHtml).join("") || `<p class="sub">尚無附件</p>`}</div>
  `;
  $("entry-overlay").classList.add("open");
  $("e-close").onclick = closeEntry;
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
}

// 🪄 一鍵整理：這筆紀錄還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取。
// 先錄音後照片——照片的【對話關聯】需要逐字稿先就位。失敗跳過，可個別重試。
async function processEntryAttachments(id, btn) {
  if (!TRANSCRIBE_ENABLED) { showToast("尚未啟用 AI 功能"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const e = await api(`/entries/${id}`);
    const audioTodo = (e.attachments || []).filter((a) => a.kind === "audio" && !a.transcript);
    const photoTodo = (e.attachments || []).filter((a) => a.kind === "photo" && !a.ocr_text);
    const total = audioTodo.length + photoTodo.length;
    if (!total) { showToast("沒有需要整理的附件，都處理過了"); return; }
    let done = 0;
    let failed = 0;
    for (const a of audioTodo) {
      btn.textContent = `🪄 ${++done}/${total}`;
      try { await api(`/attachments/${a.id}/transcribe`, { method: "POST", body: "{}" }); }
      catch { failed++; }
    }
    for (const a of photoTodo) {
      btn.textContent = `🪄 ${++done}/${total}`;
      try { await api(`/attachments/${a.id}/ocr`, { method: "POST", body: "{}" }); }
      catch { failed++; }
    }
    showToast(failed ? `整理完成，${failed} 筆失敗（可個別重試）` : `整理完成：${total} 筆`);
    openEntry(id);
  } catch (err) {
    showToast("整理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🪄 一鍵整理";
  }
}

function closeEntry() { $("entry-overlay").classList.remove("open"); }

function attHtml(a) {
  const url = `/api/file/${encodeURIComponent(a.key)}?pin=${encodeURIComponent(pin())}`;
  let preview = `<a href="${url}" target="_blank" rel="noopener">${esc(a.filename)}</a>`;
  if (a.kind === "photo") preview = `<a href="${url}" target="_blank" rel="noopener"><img class="att-thumb" src="${url}" loading="lazy" alt="${esc(a.filename)}" /></a>`;
  if (a.kind === "audio") preview = `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
  const offset = a.offset_secs !== null && a.offset_secs !== undefined ? `<span class="att-offset">📸 錄音 ${fmtSecs(a.offset_secs)}</span>` : "";
  const transcribeBit = a.kind === "audio" && TRANSCRIBE_ENABLED
    ? (a.transcript ? `<p class="att-transcript">📝 ${esc(a.transcript)}</p>` : `<a href="#" class="att-transcribe" data-id="${a.id}">轉文字</a>`)
    : "";
  const ocrBit = a.kind === "photo" && TRANSCRIBE_ENABLED
    ? (a.ocr_text
      ? `<p class="att-transcript">🔍 ${esc(a.ocr_text)} <a href="#" class="att-ocr-edit" data-id="${a.id}">編輯</a></p>`
      : `<a href="#" class="att-ocr" data-id="${a.id}">🔍 擷取文字</a>`)
    : "";
  return `<div class="att-item" data-ocr="${esc(a.ocr_text || "")}">
    <div class="att-meta">${esc(a.created_at.slice(5, 16))} ${offset}
      <a href="#" class="att-delete" data-id="${a.id}">刪除</a>
    </div>
    ${preview}${ocrBit}${transcribeBit}
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
    el.onclick = async (ev) => {
      ev.preventDefault();
      const current = el.closest(".att-item").dataset.ocr || "";
      const edited = prompt("修改擷取文字（AI 抄錯的地方直接改成正確內容）：", current);
      if (edited === null) return;
      try {
        await api(`/attachments/${el.dataset.id}`, { method: "PUT", body: JSON.stringify({ ocr_text: edited.trim() }) });
        openEntry(entryId);
      } catch (e) { showToast("儲存失敗：" + e.message); }
    };
  });
}

// ---------- 上傳（含離線佇列保底）----------
async function putFile(entryId, blob, filename, offsetSecs) {
  const headers = {
    "content-type": blob.type || "application/octet-stream",
    "x-pin": pin(),
    "x-entry-id": String(entryId),
    "x-filename": encodeURIComponent(filename),
  };
  if (offsetSecs !== null && offsetSecs !== undefined) headers["x-offset-secs"] = String(offsetSecs);
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
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onAudioSegmentStop(recorder, chunks);
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
  if (AUDIO.recorder && AUDIO.recorder.state !== "inactive") AUDIO.recorder.stop();
}

async function onAudioSegmentStop(recorder, chunks) {
  if (!AUDIO) return;
  const { stream, entryId, timerId, ending, autoStopped, segIndex, segStartMs, startedAt } = AUDIO;
  const segStartOffset = Math.floor((segStartMs - startedAt) / 1000);
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `錄音-段${segIndex}.${ext}`;

  if (ending) {
    clearInterval(timerId);
    stream.getTracks().forEach((t) => t.stop());
    $("audio-badge").style.display = "none";
    const photos = AUDIO.photos;
    AUDIO = null;
    if (blob.size) {
      showToast(autoStopped ? "偵測到切換 App，已自動結束並存檔" : "錄音上傳中…");
      try { await putFile(entryId, blob, filename, segStartOffset); }
      catch { await queueFile(entryId, blob, filename, segStartOffset); }
    }
    showToast(`錄音完成：共 ${segIndex} 段${photos ? `＋照片 ${photos} 張` : ""}`);
    openEntry(entryId);
  } else {
    AUDIO.segIndex++;
    startAudioSegRecorder();
    if (blob.size) {
      putFile(entryId, blob, filename, segStartOffset)
        .catch(() => queueFile(entryId, blob, filename, segStartOffset));
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
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopAnyActiveCapture(); });
  window.addEventListener("pagehide", stopAnyActiveCapture);
  window.addEventListener("online", syncPendingFiles);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (!pin()) { showLogin(); } else {
    api("/folders").then(() => boot()).catch(() => showLogin());
  }
}

init();
