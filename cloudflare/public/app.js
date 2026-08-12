// ===== Medtec China 2026 展商作戰地圖（團隊版）=====

let EXHIBITORS = [];
let CUSTOM_EXHIBITORS = [];  // 官方展商目錄以外，團隊自己新增的（見 setCustomExhibitors）
let CATEGORIES = [];
let CAT_MAP = {};
let LINE_MATCHES = {};      // lineId -> Set(exhibitorId)
let STATE = {};             // exhibitorId -> 共筆狀態
let MEMBERS = [];
let API_OK = false;
let OFFLINE = false;        // 離線模式（用手機快取的資料瀏覽＋紀錄排隊待同步）
let UPLOADS_ENABLED = false;
let TRANSCRIBE_ENABLED = false;

// 篩選條件（單位、產品／科別兩個維度可交叉組合）
let ACTIVE_CATS = new Set();
let ACTIVE_LINE = "";
let ACTIVE_DEPT = "";
let ACTIVE_TECH = "";       // 策略地圖主題（未來五年開發，藍色入口卡）
let POCKET_ONLY = false;
let VISIT_ONLY = false;
let KEY_VISIT_MAP = {};     // exhibitorId -> KEY_VISITS 項目

let CURRENT_ID = null;      // detail modal 顯示中的展商

// 官方名冊重新匯入後，有 16 家舊資料不在最新的 881 家名單裡（保留不刪除，
// 避免既有拜訪紀錄變孤兒，見 data-changelog.json）。「共 N 家展商」這種
// 對外的總數要算最新名單的 881 家，不是資料庫裡全部 897 筆
function currentDirectoryCount() {
  return EXHIBITORS.filter((e) => e.in_directory !== false).length;
}
let SESSIONS = [];          // 論壇議程（官網研討會場次，跟展商無關的獨立實體）

const $ = (id) => document.getElementById(id);

// 點 overlay 背景關閉，但只看「按下」跟「放開」都在背景上才關——
// 不然在 textarea 裡選字往右拖、放開時滑到 modal 外面，會被誤判成點背景關閉
function closeOnBackdropClick(overlayId, onClose) {
  const el = $(overlayId);
  let downOnBackdrop = false;
  el.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === el; });
  el.addEventListener("click", (e) => { if (e.target === el && downOnBackdrop) onClose(); });
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

// 詳情頁（第二頁）往右用力滑關閉，回到清單（第一頁）——手機上比找 ✕ 按鈕直覺，
// 用距離門檻（非單純方向）判斷，避免滑一下手指就誤觸關閉。
// excludeSelector 內的區塊（例如附件/相片區）手指開始觸碰時就不追蹤，
// 避免在照片上左右滑動、想瀏覽附件時被誤判成「滑動關閉整頁」。
function attachSwipeToClose(overlayId, panelSelector, onClose, excludeSelector) {
  const panel = $(overlayId).querySelector(panelSelector);
  if (!panel) return;
  const THRESHOLD = 90;
  let startX = 0, startY = 0, dx = 0, dy = 0, tracking = false;

  panel.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    if (excludeSelector && e.target.closest(excludeSelector)) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0; dy = 0; tracking = true;
    panel.style.transition = "none";
  }, { passive: true });

  panel.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    dx = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;
    if (dx > 0 && dx > Math.abs(dy)) {
      panel.style.transform = `translateX(${dx}px)`;
      panel.style.opacity = String(Math.max(1 - dx / 400, 0.4));
    }
  }, { passive: true });

  function reset() {
    panel.style.transition = "transform .2s ease, opacity .2s ease";
    panel.style.transform = "";
    panel.style.opacity = "";
  }

  panel.addEventListener("touchend", () => {
    if (!tracking) return;
    tracking = false;
    const shouldClose = dx > THRESHOLD && dx > Math.abs(dy);
    reset();
    if (shouldClose) onClose();
  });

  panel.addEventListener("touchcancel", () => { tracking = false; reset(); });
}

// ---------- API ----------
function pin() { return localStorage.getItem("medtec_pin") || ""; }
function me() { return localStorage.getItem("medtec_user") || ""; }

async function api(path, options = {}) {
  const res = await fetch("/api" + path, {
    ...options,
    headers: { "content-type": "application/json", "x-team-pin": pin(), ...(options.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error("PIN 錯誤"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function logout() {
  localStorage.removeItem("medtec_user");
  showLogin();
}

function isNetworkError(err) {
  return err instanceof TypeError || /fetch|network|Failed/i.test(String(err && err.message));
}

// ---------- 離線筆記佇列 ----------
function getPending() {
  return JSON.parse(localStorage.getItem("medtec_pending_notes") || "[]");
}

function setPending(list) {
  localStorage.setItem("medtec_pending_notes", JSON.stringify(list));
  updateOfflineBanner();
}

function addPending(note) {
  const list = getPending();
  list.push({ ...note, tmp_id: Date.now(), created_at: new Date().toISOString().replace("T", " ").slice(0, 19) });
  setPending(list);
}

// 離線狀態更新佇列（拜訪成果、狀態、口袋名單等），每家展商合併成一筆 patch
function getPendingState() {
  return JSON.parse(localStorage.getItem("medtec_pending_state") || "{}");
}

function setPendingState(map) {
  localStorage.setItem("medtec_pending_state", JSON.stringify(map));
  updateOfflineBanner();
}

function queueStatePatch(id, patch) {
  const map = getPendingState();
  const prev = map[id] ? map[id].patch : {};
  map[id] = { patch: { ...prev, ...patch }, author: me(), ts: Date.now() };
  setPendingState(map);
}

// ---------- 離線照片／錄音佇列（IndexedDB 存原始檔案，localStorage 存不了二進位內容）----------
// 斷線時先把檔案本體存在手機（IndexedDB），畫面照樣能從本機檔案顯示；
// 連上網路後 syncPending() 自動逐一補傳，跟文字紀錄／狀態走同一套邏輯
const FILE_DB_NAME = "medtec_offline_files";
const FILE_STORE = "pending";

function openFileDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILE_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(FILE_STORE, { keyPath: "tmp_id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addPendingFile(entry) {
  const db = await openFileDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await refreshPendingFileCount();
}

async function getPendingFiles(exhibitorId) {
  const db = await openFileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const req = tx.objectStore(FILE_STORE).getAll();
    req.onsuccess = () => resolve(exhibitorId ? req.result.filter((r) => r.exhibitor_id === exhibitorId) : req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deletePendingFile(tmpId) {
  const db = await openFileDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).delete(tmpId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await refreshPendingFileCount();
}

function pendingFileEntry(exhibitorId, file, filename, meta) {
  return {
    tmp_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    exhibitor_id: exhibitorId,
    author: me(),
    filename: filename || file.name || "file",
    mime: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    meta: meta || null, // 採集 session 資訊（sessionId/offsetSecs/durationSecs），補傳時要一併帶上
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
}

// 待同步照片/錄音卡片的本機預覽——直接用 blob 產生的 object URL 顯示，完全不用連網路
function pendingFileNoteHtml(f) {
  const url = URL.createObjectURL(f.blob);
  const isImage = (f.mime || "").startsWith("image/");
  const isAudio = (f.mime || "").startsWith("audio/");
  const isVideo = (f.mime || "").startsWith("video/");
  const preview = isImage ? `<img class="att-thumb" src="${url}" alt="${esc(f.filename)}" data-lightbox="${url}">`
    : isAudio ? `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`
    : isVideo ? `<video controls preload="none" src="${url}" class="att-video"></video>`
    : `<a href="${url}" target="_blank" rel="noopener">${esc(f.filename)}</a>`;
  return `<div class="note pending">
    <div class="note-meta"><strong>${esc(f.author)}</strong> · ${esc(f.created_at)} · ${(f.size / 1024 / 1024).toFixed(1)}MB · <span class="pending-tag">待同步（存在手機）</span></div>
    ${preview}
  </div>`;
}

// updateOfflineBanner() 的待同步計數是同步讀 localStorage，IndexedDB 是非同步的，
// 所以另外存一個記憶體變數，add/delete 時更新，開機時先讀一次
let PENDING_FILE_COUNT = 0;
async function refreshPendingFileCount() {
  try { PENDING_FILE_COUNT = (await getPendingFiles()).length; } catch { PENDING_FILE_COUNT = 0; }
  updateOfflineBanner();
}

let SYNCING = false;
async function syncPending() {
  if (SYNCING || !navigator.onLine) return;
  if (!getPending().length && !Object.keys(getPendingState()).length && !PENDING_FILE_COUNT) return;
  SYNCING = true;
  let synced = 0;
  try {
    // 先送狀態更新（拜訪成果等），再送筆記
    while (Object.keys(getPendingState()).length) {
      const map = getPendingState();
      const id = Object.keys(map)[0];
      await api(`/state/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...map[id].patch, author: map[id].author || me() }),
      });
      const cur = getPendingState();
      delete cur[id];
      setPendingState(cur);
      synced++;
    }
    while (getPending().length) {
      const [head, ...rest] = getPending();
      await api("/notes", {
        method: "POST",
        body: JSON.stringify({ exhibitor_id: head.exhibitor_id, author: head.author, type: head.type, content: head.content }),
      });
      setPending(rest);
      synced++;
    }
    // 最後補傳離線時存在手機的照片／錄音
    let pendingFiles = await getPendingFiles();
    while (pendingFiles.length) {
      const f = pendingFiles[0];
      await putFile(f.exhibitor_id, f.blob, f.filename, f.meta);
      await deletePendingFile(f.tmp_id);
      synced++;
      pendingFiles = await getPendingFiles();
    }
  } catch {
    // 還是沒網路（或 PIN 失效），剩下的留著下次再試
  }
  SYNCING = false;
  if (synced) {
    showToast(`已同步 ${synced} 筆離線紀錄`);
    try {
      STATE = await api("/state");
      API_OK = true;
      OFFLINE = false;
      updateOfflineBanner();
      render();
      renderTaskSummary();
      if (CURRENT_ID) { loadNotes(CURRENT_ID); loadAttachments(CURRENT_ID); }
    } catch { /* 稍後由重新整理接手 */ }
  }
}

function updateOfflineBanner() {
  const banner = $("offline-banner");
  const pending = getPending().length + Object.keys(getPendingState()).length + PENDING_FILE_COUNT;
  if (OFFLINE) {
    const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
    banner.textContent = `離線模式：顯示 ${snap.ts || "上次"} 同步的資料。可正常瀏覽與寫紀錄` +
      (pending ? `（${pending} 則待同步，連上網路會自動送出）` : "，紀錄會先存在手機。") +
      "📌 請保持此頁面開啟、不要關閉分頁——斷網後重新開啟不一定能載入。";
    banner.style.display = "block";
  } else if (pending) {
    banner.textContent = `有 ${pending} 則離線紀錄待同步，恢復連線後會自動送出。`;
    banner.style.display = "block";
  } else if (API_OK) {
    banner.style.display = "none";
  }
  updateOfflineModeUI();
}

// ---------- 行程模式（出發前=連線版綠燈，行程中=離線版紅燈） ----------
function tripPhase() {
  const force = new URLSearchParams(location.search).get("trip");
  if (force === "before" || force === "during" || force === "after") return force;
  const now = new Date();
  if (now < new Date(TRIP.depart)) return "before";
  if (now <= new Date(TRIP.return)) return "during";
  return "after";
}

function updateModeLight() {
  const light = $("mode-light");
  if (!light) return;
  const online = API_OK && !OFFLINE;
  light.classList.toggle("green", online);
  light.classList.toggle("red", !online);
  $("mode-light-text").textContent = online ? "連線版" : "離線版";
  light.title = (online ? "已連上共筆後端，所有功能可用" : "離線版：瀏覽與寫紀錄可用，紀錄先存手機、連線後自動同步") + "（點擊檢查離線備妥度）";
}

function renderTripBanner() {
  const el = $("trip-banner");
  if (!el) return;
  const phase = tripPhase();
  if (phase === "before") {
    const days = Math.max(0, Math.ceil((new Date(TRIP.depart) - new Date()) / 86400000));
    const assigned = Object.values(STATE).filter((st) => st.assignee).length;
    el.innerHTML = `<span class="trip-plane">✈️</span> <strong>8/31（一）12:30 CI201</strong> 出發，還有 <strong>${days}</strong> 天` +
      (API_OK ? `｜任務分配進度：已指派 <strong>${assigned}</strong> 家` : "");
    el.style.display = "block";
  } else if (phase === "during") {
    const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD（當地時區，滬台同為 +8）
    const day = TRIP_DAYS.find((d) => d.date === today);
    if (day) {
      // 橫幅只給一行摘要，細節在「📅 行程總覽」頁籤；點橫幅直接跳過去
      el.innerHTML = `📍 <strong>今日行程</strong>｜${esc(day.kindLabel)}　${esc(day.headline)}` +
        `　<a href="#" class="trip-more" id="trip-banner-more">看完整行程 →</a>`;
      el.style.display = "block";
      const more = $("trip-banner-more");
      if (more) more.onclick = (ev) => { ev.preventDefault(); setView("itinerary"); };
    } else {
      el.style.display = "none";
    }
  } else {
    el.style.display = "none"; // 回台後不再顯示
  }
}

// 今日 AI 用量提醒：隨身記與本系統共用同一份 Cloudflare Workers AI 免費額度
// （約 10,000 Neurons/天），這裡只加總兩邊「轉文字／擷取文字」的呼叫次數，
// 是粗略參考值不是精確 Neurons 用量，純粹讓人有感、避免當天不知不覺按到超額。
async function renderAiUsageBanner() {
  const el = $("ai-usage-banner");
  if (!el || !API_OK || OFFLINE) { if (el) el.style.display = "none"; return; }
  try {
    const usage = await api("/ai-usage");
    // 2026-07-18 實測校準：約 200 次轉文字/OCR ≈ 10,000 Neurons（一次平均 ~50），
    // 150 次（約 75%）起提示「開始進入計費區」——帳號已升級 Workers Paid，
    // 超過免費額度不會失敗，只是按 $0.011/千 Neurons 計費（先扣月費內含的 $5）
    const nearLimit = usage.total >= 150;
    el.textContent = nearLimit
      ? `💰 今日 AI 已處理 ${usage.total} 筆（本系統 ${usage.medtec}・隨身記 ${usage.fieldlog}）——已超過每日免費額度，超出部分依用量計費（很便宜，先扣月費內含 $5），免費額度台北早上 8 點重置`
      : `🪄 今日 AI 已處理 ${usage.total} 筆（本系統 ${usage.medtec}・隨身記 ${usage.fieldlog}）｜每日前 10,000 Neurons 免費，供參考`;
    el.classList.toggle("warn", nearLimit);
    el.style.display = "block";
  } catch {
    el.style.display = "none"; // 查不到就默默隱藏，不影響其他功能
  }
}

function updateOfflineModeUI() {
  const btn = $("btn-offline-toggle");
  updateModeLight();
  if (!btn) return;
  if (OFFLINE) {
    document.body.classList.add("is-offline");
    btn.textContent = "🔄 重新連線";
    btn.title = "嘗試重新連上後端，恢復完整功能";
    btn.classList.add("reconnect-btn");
  } else {
    document.body.classList.remove("is-offline");
    btn.textContent = "離線測試";
    btn.title = "模擬斷網，確認在中國時離線功能是否足夠";
    btn.classList.remove("reconnect-btn");
  }
}

// 離線備妥度檢查：實際清點這台裝置存了哪些離線資料
async function showCacheReport() {
  $("cache-overlay").classList.add("open");
  const wrap = $("cache-report");
  wrap.innerHTML = '<p class="sub">檢查中…</p>';
  const items = [];
  let ok = true;

  // 1) Service Worker 頁面程式快取（斷網後冷啟動靠這個）
  try {
    const names = (await caches.keys()).filter((k) => k.startsWith("medtec-shell"));
    const CORE = ["/", "/app.js", "/config.js", "/style.css", "/data/exhibitors.json"];
    const found = new Set();
    let files = 0, bytes = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      files += keys.length;
      for (const req of keys) {
        const res = await cache.match(req);
        if (res) { try { bytes += (await res.clone().blob()).size; } catch { /* 部分瀏覽器不給讀 */ } }
      }
      for (const p of CORE) {
        if (!found.has(p) && await cache.match(p)) found.add(p);
      }
    }
    const complete = found.size >= CORE.length;
    if (!complete) ok = false;
    items.push(`📦 頁面程式快取：核心檔案 ${found.size}/${CORE.length}，共 ${files} 個檔案（${(bytes / 1048576).toFixed(1)} MB）${complete ? "✅" : "⚠️ 未完整，請連網重新整理一次"}`);
  } catch {
    ok = false;
    items.push("📦 頁面程式快取：無法檢查 ⚠️（可能是無痕模式，離線會失效，請改用一般模式）");
  }

  // 2) 展商目錄 localStorage 備份（快取失效時的最後防線）
  const cat = localStorage.getItem("medtec_catalog") || "";
  if (cat) {
    items.push(`🗂 展商目錄備份：約 ${(cat.length * 2 / 1048576).toFixed(1)} MB（${EXHIBITORS.length || "全部"} 家可離線瀏覽）✅`);
  } else {
    ok = false;
    items.push("🗂 展商目錄備份：尚未建立 ❌（連網開啟一次本頁即可）");
  }

  // 3) 團隊共筆快照（離線看指派與紀錄靠這個）
  const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
  if (snap.state) {
    items.push(`👥 團隊紀錄快照：${snap.ts || ""} 同步，${Object.keys(snap.state).length} 家有紀錄 ✅`);
  } else {
    ok = false;
    items.push("👥 團隊紀錄快照：尚未建立 ❌（登入一次即可）");
  }

  // 4) 待同步佇列
  const pendingNotes = getPending().length;
  const pendingStates = Object.keys(getPendingState()).length;
  if (pendingNotes || pendingStates) {
    items.push(`⏳ 待同步：${pendingStates ? `${pendingStates} 家狀態更新` : ""}${pendingStates && pendingNotes ? "、" : ""}${pendingNotes ? `${pendingNotes} 則紀錄` : ""}（連上網路自動送出）`);
  }

  // 5) 整體占用（瀏覽器提供的估計值）
  try {
    const est = await navigator.storage.estimate();
    if (est && est.usage != null) items.push(`💾 本站在此裝置總占用：約 ${(est.usage / 1048576).toFixed(1)} MB`);
  } catch { /* 舊瀏覽器不支援，略過 */ }

  wrap.innerHTML =
    (ok ? '<p class="cache-verdict ok">✅ 離線備妥——這台手機斷網也能用</p>'
        : '<p class="cache-verdict warn">⚠️ 尚未備妥——請在有網路時開啟本頁並登入一次</p>') +
    items.map((t) => `<p class="cache-item">${t}</p>`).join("");
}

// 展商名冊每次重新匯入的前後差異記錄（不是團隊拜訪紀錄，那個在「團隊動態」）。
// 內容來自 data-changelog.json，之後要加新的一則直接編那個檔案，不用改這裡的程式。
let DATA_CHANGELOG_CACHE = null;
async function showDataChangelog() {
  $("data-changelog-overlay").classList.add("open");
  const wrap = $("data-changelog-body");
  if (!DATA_CHANGELOG_CACHE) {
    wrap.innerHTML = '<p class="sub">載入中…</p>';
    try {
      const res = await fetch("data/data-changelog.json");
      DATA_CHANGELOG_CACHE = await res.json();
    } catch {
      wrap.innerHTML = '<p class="sub">目前沒有網路，且這台裝置還沒有成功載入過異動記錄。</p>';
      return;
    }
  }
  if (!DATA_CHANGELOG_CACHE.length) {
    wrap.innerHTML = '<p class="sub">目前還沒有異動記錄。</p>';
    return;
  }
  // 新的在最上面，跟 App 其他地方的時間排序習慣一致
  const entries = [...DATA_CHANGELOG_CACHE].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  wrap.innerHTML = entries.map((e) => `
    <div class="changelog-entry">
      <div class="changelog-date">${esc(e.date || "")}</div>
      <h3>${esc(e.title || "")}</h3>
      ${e.summary ? `<p class="sub">${esc(e.summary)}</p>` : ""}
      ${(e.details || []).length ? `<ul class="changelog-details">${e.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      ${e.note ? `<p class="changelog-note">✅ ${esc(e.note)}</p>` : ""}
    </div>
  `).join("");
}

function forceOffline() {
  if (!me()) { showToast("請先登入再測試離線模式"); return; }
  const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
  if (!snap.state) { showToast("請先成功登入一次（建立快照）再測試離線模式"); return; }
  API_OK = false;
  OFFLINE = true;
  STATE = snap.state;
  MEMBERS = snap.members || [];
  $("user-chip").textContent = me() + "（離線）";
  updateOfflineBanner();
  render();
  showToast("已切換到離線測試模式，相關功能已顯示為不可用");
}

function saveSnapshot() {
  const indicator = $("save-indicator");
  try {
    localStorage.setItem("medtec_snapshot", JSON.stringify({
      state: STATE,
      members: MEMBERS,
      ts: new Date().toISOString().replace("T", " ").slice(0, 16),
    }));
    if (indicator) {
      const hhmm = new Date().toLocaleTimeString("zh-Hant-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      indicator.textContent = `✓ 已存 ${hhmm}`;
      indicator.classList.remove("save-fail");
    }
  } catch {
    // 空間不足等寫入失敗：明確告知，不要讓使用者誤以為資料已經存進手機
    if (indicator) { indicator.textContent = "⚠️ 存檔失敗"; indicator.classList.add("save-fail"); }
  }
}

function saveCatalogSnapshot(data) {
  try {
    localStorage.setItem("medtec_catalog", JSON.stringify(data));
  } catch { /* 空間不足時放棄快照，不影響主流程（展商目錄仍可靠 SW 快取離線開啟）*/ }
}

// ---------- 初始化 ----------
async function init() {
  let data;
  try {
    const res = await fetch("data/exhibitors.json");
    data = await res.json();
    saveCatalogSnapshot(data);
  } catch {
    // 完全沒有網路、且 Service Worker 快取沒生效時的最後防線：讀 localStorage 備份的展商目錄
    data = JSON.parse(localStorage.getItem("medtec_catalog") || "null");
    if (!data) {
      document.body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#6f6f68;">' +
        '目前沒有網路，且這台裝置還沒有成功載入過展商資料。<br/>請先連上網路開啟一次本頁面（建立離線備份）後再試。</div>';
      return;
    }
  }
  EXHIBITORS = data.exhibitors;
  CATEGORIES = data.categories;
  for (const c of CATEGORIES) CAT_MAP[c.id] = c;

  $("event-sub").textContent = `團隊內部版 · ${data.event.dates} · ${data.event.venue_zh} · 共 ${currentDirectoryCount()} 家展商`;

  // 舊版可能存了全名（邱長儒）當登入名，開機時自動校正成正式短名，
  // 否則負責人篩選對不上，「分派清單」會靜默失效變成整串 585 家
  if (me()) {
    const canonical = resolveCanonicalName(me());
    if (canonical !== me()) localStorage.setItem("medtec_user", canonical);
  }

  computeLineMatches();
  buildEntrySection();
  buildCategoryChips();
  buildSelectOptions();

  $("search").addEventListener("input", render);
  $("hall-filter").addEventListener("change", render);
  $("country-filter").addEventListener("change", render);
  $("status-filter").addEventListener("change", render);
  $("btn-pocket-filter").onclick = () => { POCKET_ONLY = !POCKET_ONLY; refreshPocketBtn(); render(); };
  $("btn-visit-filter").onclick = () => { VISIT_ONLY = !VISIT_ONLY; refreshPocketBtn(); render(); };
  $("btn-my-list").onclick = openMyList;
  $("btn-my-report").onclick = openMyReport;
  $("btn-clear").onclick = clearAll;
  $("btn-add-custom").onclick = openAddCustomExhibitor;
  $("add-custom-save").onclick = saveCustomExhibitor;
  $("add-custom-cancel").onclick = () => $("add-custom-overlay").classList.remove("open");
  $("add-custom-close").onclick = () => $("add-custom-overlay").classList.remove("open");
  closeOnBackdropClick("add-custom-overlay", () => $("add-custom-overlay").classList.remove("open"));
  document.querySelectorAll(".view-tab[data-view]").forEach((btn) => { btn.onclick = () => setView(btn.dataset.view); });
  $("btn-mylist-pdf").onclick = printMyList;
  $("btn-export").onclick = exportCsv;
  $("assignee-filter").addEventListener("change", render);
  $("btn-activity").onclick = openActivity;
  $("activity-close").onclick = () => $("activity-overlay").classList.remove("open");
  closeOnBackdropClick("activity-overlay", () => $("activity-overlay").classList.remove("open"));
  $("user-chip").onclick = () => { if (confirm("要切換使用者嗎？")) logout(); };
  $("btn-login").onclick = doLogin;
  $("login-overlay").addEventListener("click", (e) => e.stopPropagation());
  closeOnBackdropClick("detail-overlay", closeDetail);
  attachSwipeToClose("detail-overlay", "#detail-modal", closeDetail, "#d-attachments, .att-thumb, .att-video, audio");
  closeOnBackdropClick("session-overlay", closeSessionDetail);
  $("lightbox-close").onclick = closeLightbox;
  closeOnBackdropClick("lightbox-overlay", closeLightbox);

  // 離線測試切換按鈕
  $("btn-offline-toggle").onclick = () => {
    if (OFFLINE) { connectBackend(); } else { forceOffline(); }
  };

  // 點紅綠燈 → 離線備妥度檢查
  $("mode-light").onclick = showCacheReport;
  $("cache-close").onclick = () => $("cache-overlay").classList.remove("open");
  closeOnBackdropClick("cache-overlay", () => $("cache-overlay").classList.remove("open"));

  // 資料異動記錄（展商名冊重新匯入的前後差異，不是團隊拜訪紀錄）
  $("btn-data-changelog").onclick = showDataChangelog;
  $("data-changelog-close").onclick = () => $("data-changelog-overlay").classList.remove("open");
  closeOnBackdropClick("data-changelog-overlay", () => $("data-changelog-overlay").classList.remove("open"));


  // 現場採集模式（overlay 全頁只有一份，按鈕綁一次即可）
  $("capture-photo-btn").onclick = openCapturePhotoPopup;
  $("capture-photo-snap").onclick = capturePhotoSnap;
  $("capture-photo-cancel").onclick = closeCapturePhotoPopup;
  $("capture-stop-btn").onclick = stopCapture;
  $("photo-snap").onclick = photoBurstSnap;
  $("photo-done").onclick = finishPhotoBurst;
  $("photo-save").onclick = saveBurstToAlbum;
  // 採集中切去別的 App／收起瀏覽器：手機網頁沒辦法在「切換前」跳警告，
  // 所以改成事後保底——自動結束採集並存檔（錄音先寫進手機離線佇列再補傳，不會遺失）
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (CAPTURE) { CAPTURE.autoStopped = true; stopCapture(); }
    if (CAPTURE_PHOTO_STREAM) closeCapturePhotoPopup();
    if (PHOTO_BURST) finishPhotoBurst();
  });
  window.addEventListener("pagehide", () => {
    if (CAPTURE) { CAPTURE.autoStopped = true; stopCapture(); }
    if (CAPTURE_PHOTO_STREAM) closeCapturePhotoPopup();
    if (PHOTO_BURST) finishPhotoBurst();
  });

  // 離線快取與自動同步
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  window.addEventListener("online", () => { syncPending(); if (OFFLINE) connectBackend(); });

  // 保險存檔：切到背景／關閉分頁前最後強制寫一次快照（手機上 visibilitychange／pagehide
  // 比 beforeunload 可靠，避免「關掉前有沒有存到」全靠猜的）
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveSnapshot(); });
  window.addEventListener("pagehide", () => saveSnapshot());
  setInterval(syncPending, 45000);
  refreshPendingFileCount(); // 開機先讀一次 IndexedDB，抓上次沒同步完的照片/錄音數量

  render();

  // 行程期間（起飛後、回台前）：自動進離線版，直接用快照，不等連線逾時。
  // 想試連網（例如飯店 VPN）可按「🔄 重新連線」。
  const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
  if (tripPhase() === "during" && me() && snap.state) {
    API_OK = false;
    OFFLINE = true;
    STATE = snap.state;
    MEMBERS = snap.members || [];
    document.body.classList.remove("locked");
    $("user-chip").textContent = me() + "（離線）";
    renderRecommendBar();
    updateOfflineBanner();
    render();
    renderTaskSummary();
    autoLandingView();
    showToast("行程期間：已自動切換離線版（按 🔄 重新連線可嘗試連網）");
  } else {
    await connectBackend();
  }

  renderAiUsageBanner();
  setInterval(renderAiUsageBanner, 5 * 60 * 1000);

  // 分享連結：網址帶 ?ex=展商id 時，開頁直接跳到那家廠商的詳情頁
  const sharedId = new URLSearchParams(location.search).get("ex");
  if (sharedId && EXHIBITORS.some((e) => e.id === sharedId)) openDetail(sharedId);
}

async function connectBackend() {
  try {
    MEMBERS = await api("/members");
    API_OK = true;
    OFFLINE = false;
    try {
      setCustomExhibitors(await api("/custom-exhibitors"));
    } catch {
      // 偶發失敗（手機網路不穩）時退回上次快取的自訂廠商，不影響其他登入流程
      setCustomExhibitors(JSON.parse(localStorage.getItem("medtec_custom_exhibitors") || "[]"));
    }
    buildEntrySection(); // 自訂廠商可能命中產品／科別關鍵字，重建入口卡片數字
    try {
      const cfg = await api("/config");
      UPLOADS_ENABLED = cfg.uploads;
      TRANSCRIBE_ENABLED = cfg.transcribe;
      localStorage.setItem("medtec_config", JSON.stringify(cfg));
    } catch {
      // /config 偶發失敗（手機網路不穩最常見）時退回上次成功的值——
      // 否則採集/錄音/整理整排按鈕會憑空消失，看起來像「沒部署 R2」。
      // 就算快取過期造成誤開，按下去後端也會擋，不會出事
      const cached = JSON.parse(localStorage.getItem("medtec_config") || "{}");
      UPLOADS_ENABLED = !!cached.uploads;
      TRANSCRIBE_ENABLED = !!cached.transcribe;
    }
    if (!me()) { showLogin(); } else { document.body.classList.remove("locked"); $("user-chip").textContent = me(); renderRecommendBar(); }
    STATE = await api("/state");
    saveSnapshot();
    snapshotAllNotes(); // 順便把全隊筆記（含代問）快照到手機，離線看得到
    updateOfflineBanner();
    render();
    renderTaskSummary();
    autoLandingView();
    syncPending();
    loadSearchTexts(); // 背景載入照片擷取文字＋錄音逐字稿，搜尋框連照片裡的字都搜得到
  } catch (err) {
    if (String(err.message).includes("PIN")) { showLogin(); return; }
    // 網路不通：曾登入過就進離線模式（用手機快取的資料）
    API_OK = false;
    const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
    if (me() && snap.state) {
      OFFLINE = true;
      STATE = snap.state;
      MEMBERS = snap.members || [];
      setCustomExhibitors(JSON.parse(localStorage.getItem("medtec_custom_exhibitors") || "[]"));
      document.body.classList.remove("locked");
      $("user-chip").textContent = me() + "（離線）";
      renderRecommendBar();
      render();
      renderTaskSummary();
      autoLandingView();
    }
    updateOfflineBanner();
    if (!me()) $("offline-banner").style.display = "block";
  }
}

// ---------- 登入 ----------
function showLogin() {
  document.body.classList.add("locked");
  $("login-overlay").classList.add("open");
  $("login-pin").value = pin();
  renderMemberChoices();
}

function renderMemberChoices() {
  const wrap = $("member-choices");
  wrap.innerHTML = "";
  const choices = dedupedRoster();
  for (const m of choices) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = m.name;
    chip.title = m.dept || "";
    chip.onclick = () => {
      $("login-name").value = m.name;
      wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    };
    wrap.appendChild(chip);
  }
}

async function doLogin() {
  const pinVal = $("login-pin").value.trim();
  const rawName = $("login-name").value.trim();
  const errEl = $("login-error");
  errEl.style.display = "none";
  if (!rawName) { errEl.textContent = "請選擇或輸入你的名字"; errEl.style.display = "block"; return; }
  const name = resolveCanonicalName(rawName); // 打全名（邱長儒）自動轉成正式短名（長儒），避免同一人變兩筆
  const rec = dedupedRoster().find((r) => isSameName(r.name, name));
  const dept = rec ? rec.dept : ""; // 單位自動帶入，不用選
  localStorage.setItem("medtec_pin", pinVal);
  try {
    MEMBERS = await api("/members", { method: "POST", body: JSON.stringify({ name, dept }) });
    localStorage.setItem("medtec_user", name);
    $("user-chip").textContent = name;
    if (name !== rawName) showToast(`已辨識為團隊名單上的「${name}」`);
    renderRecommendBar();
    document.body.classList.remove("locked");
    $("login-overlay").classList.remove("open");
    API_OK = true;
    OFFLINE = false;
    STATE = await api("/state");
    saveSnapshot();
    snapshotAllNotes();
    updateOfflineBanner();
    render();
    renderTaskSummary();
    AUTO_LANDING_DONE = false; // 剛登入，重新帶一次落地頁
    autoLandingView();
    syncPending();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ---------- 產品別／科別關鍵字比對 ----------
// 每家展商「照片擷取文字＋錄音逐字稿」的彙整（後端 /search-texts），
// 併進搜尋比對範圍——照片裡抄出來的型號、認證、公司資訊都搜得到
let EXTRA_TEXT = {};

async function loadSearchTexts() {
  try { EXTRA_TEXT = await api("/search-texts"); } catch { /* 搜尋加值功能，失敗不影響主流程 */ }
}

function exhibitorText(e) {
  return [e.name_zh, e.name_en, e.description, ...(e.products || []), ...(e.tags || []), EXTRA_TEXT[e.id] || ""]
    .join(" ")
    .toLowerCase();
}

// 官方展商目錄以外，團隊自己新增的廠商（見 cloudflare/src/worker.js 的
// custom_exhibitors 表）。合併方式：EXHIBITORS 裡先濾掉舊的自訂項目
// （用 e.custom 旗標認），再接上最新一批——這樣不管呼叫幾次都是乾淨的
// 全量替換，不會累積出重複項目，也不用額外追蹤「這次新增了誰」。
// 合併完一定要重跑 computeLineMatches()，不然新加的公司不會出現在
// 「產品／科別」入口的計數與行程重點標記裡。
function setCustomExhibitors(list) {
  CUSTOM_EXHIBITORS = list || [];
  try { localStorage.setItem("medtec_custom_exhibitors", JSON.stringify(CUSTOM_EXHIBITORS)); } catch { /* 空間不足時放棄快取，不影響本次瀏覽 */ }
  EXHIBITORS = EXHIBITORS.filter((e) => !e.custom).concat(CUSTOM_EXHIBITORS);
  computeLineMatches();
}

function computeLineMatches() {
  for (const line of PRODUCT_LINES) {
    const set = new Set();
    for (const e of EXHIBITORS) {
      const text = exhibitorText(e);
      if (line.keywords.some((k) => text.includes(k.toLowerCase()))) set.add(e.id);
    }
    LINE_MATCHES[line.id] = set;
  }
  for (const v of KEY_VISITS) {
    for (const e of EXHIBITORS) {
      if (e.name_zh.includes(v.match) || (e.name_en || "").includes(v.match)) {
        KEY_VISIT_MAP[e.id] = v;
      }
    }
  }
}

// ---------- 首頁入口 ----------
function buildEntrySection() {
  const lineGrid = $("line-grid");
  lineGrid.innerHTML = "";
  for (const line of PRODUCT_LINES) {
    const count = LINE_MATCHES[line.id].size;
    const card = document.createElement("div");
    card.className = "entry-card";
    card.dataset.line = line.id;
    card.innerHTML = `<div class="entry-name">${line.name}</div><div class="entry-count">${count} 家</div>`;
    card.title = line.desc;
    card.onclick = () => applyLinePreset(line.id);
    lineGrid.appendChild(card);
  }
  // 策略地圖廠商檢索（藍色卡）：對應未來五年技術開發主題，混排在同一個入口清單裡
  for (const t of TECH_MAP) {
    const count = EXHIBITORS.filter((e) => {
      const text = exhibitorText(e);
      return t.keywords.some((k) => text.includes(k.toLowerCase()));
    }).length;
    const card = document.createElement("div");
    card.className = "entry-card tech-card";
    card.dataset.tech = t.id;
    card.innerHTML = `<div class="entry-name">${t.label}</div><div class="entry-count">${count} 家</div>`;
    card.title = `策略地圖主題（未來五年開發）：關鍵字「${t.keywords.join("、")}」命中任一即列出`;
    card.onclick = () => applyTechPreset(t.id);
    lineGrid.appendChild(card);
  }
}

// 姓名模糊去重共用邏輯：別名表對應（振哲→政哲）＋ 全名/短名互相包含視為同一人
// （邱長儒＝長儒）。MEMBER_PROFILES 預建名單優先，決定顯示用的名字與單位。
// 唯一有風險的情況：兩個不同的人剛好一個名字是另一個的子字串（例如「凌」與「和凌」），
// 目前 9+1 人名單沒有這種情況（2026-07-26 加入灝翰時再確認過一次），
// 但若未來新增成員撞名，要改用別名表而非單純子字串比對。
function isSameName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 2 && b.length >= 2) && (a.includes(b) || b.includes(a));
}

function dedupedRoster() {
  const roster = []; // [{ name, dept }]
  const tryAdd = (name, dept) => {
    if (!name) return;
    const resolved = NAME_ALIASES[name] || name;
    if (/^test/i.test(resolved)) return; // test 開頭的一律視為測試帳號，不列入任何名單
    if (HIDDEN_MEMBERS.some((h) => isSameName(h, resolved))) return;
    if (roster.some((r) => isSameName(r.name, resolved))) return;
    roster.push({ name: resolved, dept: dept || "" });
  };
  for (const p of MEMBER_PROFILES) tryAdd(p.name, p.duty);
  for (const m of MEMBERS) tryAdd(m.name, m.dept);
  return roster;
}

// 可指派名單：排除總經理（隱藏名單已在 dedupedRoster 過濾）
function assignableNames() {
  return dedupedRoster().map((r) => r.name).filter((n) => n !== "總經理");
}

// 登入輸入的名字轉成團隊正式名單上的名字（別名對應＋全名/短名視同一人），
// 從源頭避免「邱長儒」與「長儒」被當成兩個人存進資料庫
function resolveCanonicalName(raw) {
  const aliased = NAME_ALIASES[raw] || raw;
  const match = dedupedRoster().find((r) => isSameName(r.name, aliased));
  return match ? match.name : aliased;
}

// ---------- 依職掌推薦視角 ----------
function renderRecommendBar() {
  const bar = $("recommend-bar");
  const profile = MEMBER_PROFILES.find((p) => p.name === me());
  if (!profile || !profile.chips.length) { bar.style.display = "none"; return; }

  bar.innerHTML = `<span class="recommend-label">依你的職掌推薦：</span>`;
  for (const chip of profile.chips) {
    const el = document.createElement("span");
    el.className = "chip";
    if (chip.k === "dept") {
      const d = DEPT_PRESETS.find((x) => x.id === chip.id);
      el.textContent = d.name;
      el.onclick = () => applyDeptPreset(chip.id);
    } else if (chip.k === "line") {
      const l = PRODUCT_LINES.find((x) => x.id === chip.id);
      el.textContent = l.name;
      el.onclick = () => applyLinePreset(chip.id);
    } else if (chip.k === "tech") {
      const t = TECH_MAP.find((x) => x.id === chip.id);
      el.textContent = t.label;
      el.onclick = () => applyTechPreset(chip.id);
    } else if (chip.k === "cats") {
      el.textContent = chip.label;
      el.onclick = () => {
        ACTIVE_DEPT = "";
        ACTIVE_CATS = new Set(chip.ids);
        refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
        $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
      };
    }
    bar.appendChild(el);
  }
  bar.style.display = "block";
}

// 個人進度摘要文字已移除（版面精簡，跟頁籤列直接相鄰）；
// 這裡只保留頁籤（分派清單／完成拜訪清單）的顯示與數字徽章，「我的清單」按鈕在頁首常駐。
function renderTaskSummary() {
  const tabs = $("view-tabs");
  const loggedIn = me() && (API_OK || OFFLINE);
  if (tabs) tabs.style.display = loggedIn ? "flex" : "none";
  const assignedBadge = $("tab-count-assigned");
  const visitedBadge = $("tab-count-visited");
  if (!loggedIn) {
    if (assignedBadge) assignedBadge.textContent = "";
    if (visitedBadge) visitedBadge.textContent = "";
    return;
  }
  const myStates = Object.values(STATE).filter((st) => isSameName(st.assignee, me()));
  const visited = myStates.filter((st) => st.status === "已拜訪").length;
  const myTotal = myStates.length;
  if (assignedBadge) assignedBadge.textContent = myTotal ? myTotal : "";
  if (visitedBadge) visitedBadge.textContent = visited ? visited : "";
}

function deptMatch(d, e) {
  if (!d.cats.includes(e.category)) return false;
  if (d.keywords && d.keywords.length) {
    const text = exhibitorText(e);
    return d.keywords.some((k) => text.includes(k.toLowerCase()));
  }
  return true;
}

function applyDeptPreset(deptId) {
  if (ACTIVE_DEPT === deptId) { ACTIVE_DEPT = ""; ACTIVE_CATS.clear(); }
  else {
    ACTIVE_DEPT = deptId;
    const d = DEPT_PRESETS.find((x) => x.id === deptId);
    ACTIVE_CATS = new Set(d.cats);
  }
  refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

function applyLinePreset(lineId) {
  ACTIVE_LINE = ACTIVE_LINE === lineId ? "" : lineId;
  if (ACTIVE_LINE) ACTIVE_TECH = "";
  refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

// 策略地圖主題（藍色卡）：跟產品線入口互斥，點了就檢索全部展商（OR 比對該主題關鍵字組）
function applyTechPreset(techId) {
  ACTIVE_TECH = ACTIVE_TECH === techId ? "" : techId;
  if (ACTIVE_TECH) ACTIVE_LINE = "";
  refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

function refreshEntryCards() {
  document.querySelectorAll(".entry-card").forEach((c) => {
    c.classList.toggle("active", Boolean(
      (c.dataset.dept && c.dataset.dept === ACTIVE_DEPT) ||
      (c.dataset.line && c.dataset.line === ACTIVE_LINE) ||
      (c.dataset.tech && c.dataset.tech === ACTIVE_TECH)));
  });
}

function refreshPresetBar() {
  const bar = $("active-preset");
  const parts = [];
  if (ACTIVE_DEPT) {
    const d = DEPT_PRESETS.find((x) => x.id === ACTIVE_DEPT);
    parts.push(`<strong>單位｜${d.name}</strong>：${d.hint} <button class="btn small ghost" onclick="applyDeptPreset('${d.id}')">取消</button>`);
  }
  if (ACTIVE_LINE) {
    const l = PRODUCT_LINES.find((x) => x.id === ACTIVE_LINE);
    parts.push(`<strong>產品／科別｜${l.name}</strong>：${l.desc}（關鍵字「${l.keywords.join("、")}」自動比對）<button class="btn small ghost" onclick="applyLinePreset('${l.id}')">取消</button>`);
  }
  if (ACTIVE_TECH) {
    const t = TECH_MAP.find((x) => x.id === ACTIVE_TECH);
    parts.push(`<strong>策略地圖｜${t.label}</strong>：未來五年開發主題，檢索全部展商（關鍵字「${t.keywords.join("、")}」命中任一即列出）<button class="btn small ghost" onclick="applyTechPreset('${t.id}')">取消</button>`);
  }
  if (parts.length) {
    bar.innerHTML = parts.join("<br/>");
    bar.style.display = "block";
  } else {
    bar.style.display = "none";
  }
}

// ---------- 篩選 UI ----------
function buildCategoryChips() {
  const wrap = $("category-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  const all = document.createElement("div");
  all.className = "chip";
  all.textContent = "全部分類";
  all.onclick = () => { ACTIVE_CATS.clear(); ACTIVE_DEPT = ""; refreshEntryCards(); refreshChips(); refreshPresetBar(); render(); };
  wrap.appendChild(all);
  for (const cat of CATEGORIES) {
    const count = EXHIBITORS.filter((e) => e.category === cat.id).length;
    if (!count) continue;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.cat = cat.id;
    chip.textContent = `${cat.name_zh}（${count}）`;
    chip.onclick = () => {
      if (ACTIVE_CATS.has(cat.id)) ACTIVE_CATS.delete(cat.id); else ACTIVE_CATS.add(cat.id);
      ACTIVE_DEPT = "";
      refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
    };
    wrap.appendChild(chip);
  }
  refreshChips();
}

function refreshChips() {
  document.querySelectorAll("#category-chips .chip").forEach((chip) => {
    const isAll = !chip.dataset.cat;
    chip.classList.toggle("active", isAll ? ACTIVE_CATS.size === 0 : ACTIVE_CATS.has(chip.dataset.cat));
  });
}

function buildSelectOptions() {
  const hallSel = $("hall-filter");
  for (const h of [...new Set(EXHIBITORS.map((e) => e.hall))].sort()) {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h.startsWith("N") ? h + " 館" : h;
    hallSel.appendChild(opt);
  }
  const countrySel = $("country-filter");
  const counts = {};
  for (const e of EXHIBITORS) counts[e.country] = (counts[e.country] || 0) + 1;
  for (const c of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${c}（${counts[c]}）`;
    countrySel.appendChild(opt);
  }
  const statusSel = $("status-filter");
  for (const s of STATUS_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    statusSel.appendChild(opt);
  }
  const assigneeSel = $("assignee-filter");
  for (const n of assignableNames()) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = `負責人：${n}`;
    assigneeSel.appendChild(opt);
  }
}


function refreshPocketBtn() {
  $("btn-pocket-filter").classList.toggle("primary", POCKET_ONLY);
  $("btn-visit-filter").classList.toggle("primary", VISIT_ONLY);
}

// 視圖切換：行程總覽（首頁）／檢索清單／分派給我／我已完成拜訪／論壇議程
let CURRENT_VIEW = "itinerary";   // 落地頁＝行程總覽（見 autoLandingView）
function setActiveViewTab(view) {
  CURRENT_VIEW = view;
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  // 分派清單／完成拜訪清單：當成個人代辦頁面，不是在檢索頁上疊一個篩選條件，
  // 所以把逛全部展商用的入口收起來，畫面上看起來就是「我的清單」這一頁
  document.body.classList.toggle("todo-view", view === "assigned" || view === "visited");
  // 論壇議程：跟展商是不同的實體，切過去時蓋掉整個展商清單畫面
  document.body.classList.toggle("agenda-view", view === "agenda");
  // 行程總覽：同理，切過去時整頁只有六天行程
  document.body.classList.toggle("itinerary-view", view === "itinerary");
  // 參訪前報告：同理
  document.body.classList.toggle("prep-view", view === "prep");
}

// 設定負責人篩選值；選單裡沒有這個名字就補一個 option，
// 絕不允許「設了篩選其實沒生效、整串 585 家照列」的靜默失敗
function setAssigneeFilter(name) {
  const sel = $("assignee-filter");
  sel.value = name;
  if (sel.value !== name) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `負責人：${name}`;
    sel.appendChild(opt);
    sel.value = name;
  }
}

// scroll=false 用在「開頁自動落地」：頁面本來就在最上面，這時再捲動反而
// 會把頁首與頁籤推出畫面，看起來像跳掉一截
function setView(view, { scroll = true } = {}) {
  clearAll();
  if (view === "assigned") {
    setAssigneeFilter(me());
    SORT_KEY = "booth"; SORT_DIR = 1;
    render();
  } else if (view === "visited") {
    setAssigneeFilter(me());
    $("status-filter").value = "已拜訪";
    SORT_KEY = "booth"; SORT_DIR = 1;
    render();
  } else if (view === "agenda") {
    loadSessions();
  } else if (view === "itinerary") {
    renderItinerary();
  } else if (view === "prep") {
    renderPrepReport();
    loadPrepNotes();
  }
  setActiveViewTab(view);
  if (!scroll) return;
  if (view === "agenda") {
    $("agenda-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (view === "itinerary") {
    $("itinerary-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (view === "prep") {
    $("prep-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// 我的清單：指派給我的廠商，依攤位排路線
function openMyList() {
  if (!me()) { showLogin(); return; }
  setView("assigned");
  showToast(`我的清單：指派給 ${me()} 的廠商（依攤位排序）`);
}

// 登入／開啟後的落地頁＝行程總覽（首頁）。六天行程是全隊每天都要看的東西，
// 比展商清單更適合當第一眼；有分派給自己的廠商時只用 toast 提示，不強制
// 把人帶去分派清單（想看自己按頁籤或頁首「我的清單」一下就到）。僅套一次。
let AUTO_LANDING_DONE = false;
function autoLandingView() {
  if (AUTO_LANDING_DONE || !me()) return;
  AUTO_LANDING_DONE = true;
  setView("itinerary", { scroll: false });
  const mine = Object.values(STATE).filter((st) => isSameName(st.assignee, me())).length;
  if (mine) showToast(`分派給你的有 ${mine} 家，切上方「📌 分派清單」查看`);
}

// 分派清單 PDF：純前端產生可列印頁（離線也能印），當紙本備援——
// 軟體完全失效時，照這張紙也知道要去哪些攤位、幫誰問什麼
function printMyList() {
  if (!me()) { showLogin(); return; }
  const mine = EXHIBITORS.filter((e) => isSameName(getState(e.id).assignee, me()));
  if (!mine.length) { showToast("目前沒有指派給你的廠商"); return; }
  const sorted = [...mine].sort((a, b) => (a.booth_no || "").localeCompare(b.booth_no || ""));
  const nmap = notesCache();
  const today = new Date().toLocaleString("zh-Hant-TW", { hour12: false });
  let lastKey = null;
  const rows = sorted.map((e) => {
    const st = getState(e.id);
    const g = boothGroup(e);
    const cat = CAT_MAP[e.category];
    const visit = KEY_VISIT_MAP[e.id];
    const qs = (nmap[e.id] || []).filter((n) => n.type === "想詢問的問題");
    const header = g.key !== lastKey ? `<tr class="g"><td colspan="4">📍 ${esc(g.label)}</td></tr>` : "";
    lastKey = g.key;

    const metaBits = [e.country, cat ? cat.name_zh : "", (e.products || []).join("、")].filter(Boolean);
    const meta = metaBits.length ? `<div class="meta">${esc(metaBits.join(" · "))}</div>` : "";
    const desc = e.description ? `<div class="desc">${esc(e.description)}</div>` : "";

    const knownBits = [];
    if (st.goal_tags.length) knownBits.push(`觀展目標：${st.goal_tags.join("、")}`);
    if (st.collected.length) {
      const labels = st.collected.map((id) => (COLLECTED_OPTIONS.find((o) => o.id === id) || {}).label || id);
      knownBits.push(`已取得：${labels.join("、")}`);
    }
    if (st.quals.length) {
      const labels = st.quals.map((id) => (QUAL_OPTIONS.find((o) => o.id === id) || {}).label || id);
      knownBits.push(`資質：${labels.join("、")}`);
    }
    const known = knownBits.length ? `<div class="known">${knownBits.map(esc).join("｜")}</div>` : "";

    const vr = st.visit_record || {};
    const prevBits = [];
    if (vr.contact) prevBits.push(`聯絡人：${vr.contact}`);
    if (vr.solves) prevBits.push(`可解決：${vr.solves}`);
    if (vr.diff) prevBits.push(`差異：${vr.diff}`);
    if (vr.next_step) prevBits.push(`下一步：${vr.next_step}`);
    const prev = prevBits.length ? `<div class="prev">📝 上次拜訪：${prevBits.map(esc).join("｜")}</div>` : "";

    return header + `<tr>
      <td class="booth">${esc(e.booth_no)}</td>
      <td><strong>${esc(e.name_zh)}</strong><br/><span class="en">${esc(e.name_en || "")}</span>
        ${meta}
        ${desc}
        ${visit ? `<div class="visit">⭐ ${esc(visit.when)}${visit.contact ? "｜" + esc(visit.contact) : ""}</div>` : ""}
        ${known}
        ${prev}
        ${qs.length ? `<div class="qs">${qs.map((q) => `🙋 ${esc(q.author)}：${esc(q.content)}`).join("<br/>")}</div>` : ""}
      </td>
      <td class="status">${esc(st.status)}</td>
      <td class="memo"></td>
    </tr>`;
  }).join("");
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(me())} 分派清單</title>
<style>
body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#1c1c1a;max-width:800px;margin:20px auto;padding:0 14px;}
h1{font-size:19px;border-bottom:3px solid #c8102e;padding-bottom:8px;}
h1 small{display:block;font-size:12px;color:#6f6f68;font-weight:normal;margin-top:4px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{border:1px solid #d4d4d0;padding:7px 8px;text-align:left;vertical-align:top;}
th{background:#f4f4f2;}
tr.g td{background:#fbeaec;color:#a00d24;font-weight:700;border-top:2px solid #c8102e;}
.booth{font-family:ui-monospace,monospace;white-space:nowrap;font-weight:700;}
.en{color:#6f6f68;font-size:11px;}
.meta{color:#6f6f68;font-size:11px;margin-top:3px;}
.desc{font-size:12px;margin-top:3px;line-height:1.5;}
.visit{color:#a00d24;font-size:12px;margin-top:3px;}
.known{color:#1d4ed8;font-size:12px;margin-top:3px;}
.prev{background:#eef2ff;border:1px solid #c7d2fe;border-radius:4px;padding:4px 6px;font-size:12px;margin-top:4px;}
.qs{background:#fff8e6;border:1px solid #f0dfa8;border-radius:4px;padding:4px 6px;font-size:12px;margin-top:4px;}
.status{white-space:nowrap;}
.memo{min-width:120px;}
.print-btn{position:fixed;top:14px;right:14px;padding:10px 18px;background:#c8102e;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;}
@media print{.print-btn{display:none;} tr{page-break-inside:avoid;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">列印 / 存 PDF</button>
<h1>Medtec 2026 分派清單──${esc(me())}<small>共 ${mine.length} 家｜產出 ${today}｜紙本備援：手機完全失效時照這張跑；「現場筆記」欄可手寫</small></h1>
<table><thead><tr><th>攤位</th><th>公司／代問事項</th><th>狀態</th><th>現場筆記</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) { showToast("瀏覽器阻擋了新視窗，請允許彈出視窗後再試"); return; }
  w.document.write(html);
  w.document.close();
}

// 我的報告：開啟個人參訪報告頁（可列印存 PDF）
function openMyReport() {
  if (!me()) { showLogin(); return; }
  const url = `/api/report?author=${encodeURIComponent(me())}&pin=${encodeURIComponent(pin())}`;
  window.open(url, "_blank");
}

function clearAll() {
  ACTIVE_CATS.clear(); ACTIVE_LINE = ""; ACTIVE_DEPT = ""; POCKET_ONLY = false; VISIT_ONLY = false; ACTIVE_TECH = "";
  $("search").value = ""; $("hall-filter").value = ""; $("country-filter").value = ""; $("status-filter").value = "";
  $("assignee-filter").value = "";
  setActiveViewTab("search");
  refreshEntryCards(); refreshChips(); refreshPresetBar(); refreshPocketBtn(); render();
}

// 新增自訂廠商：官方展商目錄要重新爬網站才能更新，團隊自己想追蹤的公司
// （例如評估中、根本沒參展的 CDMO 候選）不必等我們重新匯入整份名冊
function openAddCustomExhibitor() {
  if (!me()) { showLogin(); return; }
  $("add-custom-name-zh").value = "";
  $("add-custom-name-en").value = "";
  $("add-custom-booth").value = "";
  $("add-custom-note").value = "";
  $("add-custom-error").style.display = "none";
  $("add-custom-overlay").classList.add("open");
  $("add-custom-name-zh").focus();
}

async function saveCustomExhibitor() {
  const errEl = $("add-custom-error");
  errEl.style.display = "none";
  const name_zh = $("add-custom-name-zh").value.trim();
  const name_en = $("add-custom-name-en").value.trim();
  if (!name_zh && !name_en) {
    errEl.textContent = "中文或英文名稱至少要填一個";
    errEl.style.display = "block";
    return;
  }
  const btn = $("add-custom-save");
  btn.disabled = true;
  try {
    const created = await api("/custom-exhibitors", {
      method: "POST",
      body: JSON.stringify({
        name_zh, name_en,
        booth_no: $("add-custom-booth").value.trim(),
        description: $("add-custom-note").value.trim(),
        author: me(),
      }),
    });
    setCustomExhibitors([...CUSTOM_EXHIBITORS, created]);
    buildEntrySection();
    $("add-custom-overlay").classList.remove("open");
    showToast(`已新增「${created.name_zh || created.name_en}」`);
    render();
    openDetail(created.id); // 直接開詳情頁，方便馬上指派負責人／設定狀態
  } catch (err) {
    errEl.textContent = "新增失敗：" + err.message;
    errEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

// ---------- 主列表 ----------
function getState(id) {
  return STATE[id] || { status: "未排定", assignee: "", dept_tags: [], collected: [], goal_tags: [], quals: [], post_class: "", pocket: false, note_count: 0, visit_record: {} };
}

function visitCompleteness(st) {
  const vr = st.visit_record || {};
  let done = 0;
  const hasText = (s) => s && s.trim();
  if (hasText(vr.solves) || hasText(vr.diff) || hasText(vr.note)) done++; // note=舊版欄位相容
  if (vr.obtained && vr.obtained.length > 0) done++;
  if (vr.next_step) done++;
  if (hasText(vr.contact)) done++;
  return done; // out of 4
}

function filtered() {
  const keywords = $("search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hall = $("hall-filter").value;
  const country = $("country-filter").value;
  const statusF = $("status-filter").value;
  const lineSet = ACTIVE_LINE ? LINE_MATCHES[ACTIVE_LINE] : null;
  const dept = ACTIVE_DEPT ? DEPT_PRESETS.find((d) => d.id === ACTIVE_DEPT) : null;
  const techMap = ACTIVE_TECH ? TECH_MAP.find((t) => t.id === ACTIVE_TECH) : null;
  // 有打字搜尋或點了策略地圖主題時，視為要查全部展商，不受目前選的產品線／部門入口限制
  const searching = keywords.length > 0 || !!techMap;

  return EXHIBITORS.filter((e) => {
    if (!searching) {
      if (ACTIVE_CATS.size && !ACTIVE_CATS.has(e.category)) return false;
      if (lineSet && !lineSet.has(e.id)) return false;
      if (dept && dept.keywords && !deptMatch(dept, e)) return false;
    }
    if (hall && e.hall !== hall) return false;
    if (country && e.country !== country) return false;
    const st = getState(e.id);
    if (POCKET_ONLY && !st.pocket) return false;
    if (VISIT_ONLY && !KEY_VISIT_MAP[e.id]) return false;
    const assigneeF = $("assignee-filter").value;
    if (assigneeF && !isSameName(st.assignee, assigneeF)) return false; // 全名/短名視同一人，舊資料也對得上
    if (statusF && st.status !== statusF) return false;
    if (keywords.length || techMap) {
      const text = exhibitorText(e);
      // 交叉檢索：所有關鍵字都要命中（AND）
      if (keywords.length && !keywords.every((k) => text.includes(k))) return false;
      // 策略地圖主題：命中該主題任一關鍵字即可（OR）
      if (techMap && !techMap.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
    }
    return true;
  });
}

// ---------- 排序 ----------
let SORT_KEY = "booth";
let SORT_DIR = 1; // 1 升冪, -1 降冪

const SORT_COLUMNS = [
  { key: "pocket", label: "★", get: (e, st) => (st.pocket ? 0 : 1) },
  { key: "name", label: "公司", get: (e) => e.name_zh },
  { key: "booth", label: "攤位", get: (e) => e.booth_no || "" },
  { key: "cat", label: "分類", get: (e) => (CAT_MAP[e.category] ? CAT_MAP[e.category].name_zh : ""), cls: "col-cat" },
  { key: "country", label: "國家", get: (e) => e.country, cls: "col-country" },
  { key: "status", label: "狀態", get: (e, st) => STATUS_OPTIONS.indexOf(st.status), team: true },
  { key: "post", label: "展後", get: (e, st) => st.post_class || "～", team: true, cls: "col-post" },
  { key: "goal", label: "目標", get: (e, st) => -st.goal_tags.length, team: true, cls: "col-goal" },
  { key: "assignee", label: "負責", get: (e, st) => st.assignee || "～", team: true },
  { key: "notes", label: "紀錄", get: (e, st) => -st.note_count, team: true, cls: "col-notes" },
  { key: "", label: "連結", get: null, cls: "col-links" },
];

function sortList(list) {
  const col = SORT_COLUMNS.find((c) => c.key === SORT_KEY);
  if (!col || !col.get) return list;
  return [...list].sort((a, b) => {
    const va = col.get(a, getState(a.id));
    const vb = col.get(b, getState(b.id));
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "zh-Hant");
    return cmp * SORT_DIR;
  });
}

function render() {
  const list = sortList(filtered());

  const allStates = Object.values(STATE);
  const pocketCount = allStates.filter((s) => s.pocket).length;
  const kpi = { "已拜訪": 0, "已排定": 0, "需追蹤": 0 };
  for (const s of allStates) if (s.status in kpi) kpi[s.status]++;
  $("stats").textContent =
    `共 ${currentDirectoryCount()} 家展商，符合條件 ${list.length} 家` +
    ((API_OK || OFFLINE) ? `｜已拜訪 ${kpi["已拜訪"]}・已排定 ${kpi["已排定"]}・需追蹤 ${kpi["需追蹤"]}｜口袋名單 ${pocketCount} 家` : "");

  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").style.display = list.length ? "none" : "block";
  if (list.length) grid.appendChild(renderTable(list));
  renderTripBanner();
  // 報告頁仍可能開著廠商詳情並修改負責人／狀態；共筆狀態一變就立即重算七人清單，
  // 不必切走再切回才看到結果。renderPrepReport 會保留尚未儲存的個人補充草稿。
  if (document.body.classList.contains("prep-view")) renderPrepReport();
}

// ---------- 列表（唯一檢視，欄位標題可排序）----------
function renderTable(list) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "listview";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const teamView = API_OK || OFFLINE; // 離線用快照資料照樣顯示團隊欄位
  for (const col of SORT_COLUMNS) {
    if (col.team && !teamView) continue;
    const th = document.createElement("th");
    th.textContent = col.label;
    if (col.cls) th.className = col.cls;
    if (col.get) {
      th.classList.add("sortable");
      if (SORT_KEY === col.key) th.textContent = `${col.label} ${SORT_DIR === 1 ? "▲" : "▼"}`;
      th.onclick = () => {
        if (SORT_KEY === col.key) SORT_DIR = -SORT_DIR;
        else { SORT_KEY = col.key; SORT_DIR = 1; }
        render();
      };
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const showGroups = SORT_KEY === "booth" && list.length > 1;
  const groupCounts = {};
  if (showGroups) for (const e of list) { const k = boothGroup(e).key; groupCounts[k] = (groupCounts[k] || 0) + 1; }
  let lastGroupKey = null;
  const colCount = headRow.children.length;
  for (const e of list) {
    if (showGroups) {
      const g = boothGroup(e);
      if (g.key !== lastGroupKey) {
        lastGroupKey = g.key;
        const gTr = document.createElement("tr");
        gTr.className = "group-header-row";
        gTr.innerHTML = `<td colspan="${colCount}">📍 ${esc(g.label)}（${groupCounts[g.key]} 家）</td>`;
        tbody.appendChild(gTr);
      }
    }
    const st = getState(e.id);
    const cat = CAT_MAP[e.category];
    const statusColor = STATUS_COLORS[st.status] || "#8a8a82";
    // 有任何團隊紀錄/分配 → 列的差異化顯示
    const hasData = Boolean(st.assignee || st.status !== "未排定" || st.note_count || st.pocket ||
      st.post_class || st.goal_tags.length || st.quals.length || st.collected.length || st.dept_tags.length);
    const tr = document.createElement("tr");
    if (hasData) tr.className = "has-data";
    const comp = teamView ? visitCompleteness(st) : -1;
    const compBadge = comp >= 0 && (comp > 0 || st.status === "已拜訪")
      ? `<span class="comp-badge comp-${comp}" title="拜訪成果完整度 ${comp}/4">${comp}/4</span>` : "";
    tr.innerHTML = `
      <td><span class="row-star ${st.pocket ? "on" : ""}" title="口袋名單">${st.pocket ? "★" : "☆"}</span></td>
      <td class="co"><div class="co-inner"><div class="co-photo-slot">${e.photo ? `<img class="co-photo" src="${esc(e.photo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}</div><div class="co-text"><div class="zh">${KEY_VISIT_MAP[e.id] ? '<span class="badge visit">行程</span> ' : ""}${e.custom ? '<span class="badge custom">自訂</span> ' : ""}${e.in_directory === false ? '<span class="badge not-in-directory" title="最新官方名冊已無此公司，保留舊紀錄不刪除">非本屆</span> ' : ""}${esc(e.name_zh || e.name_en)}${hasData ? ' <span class="data-dot" title="已有團隊紀錄"></span>' : ""}${compBadge}</div><div class="en">${esc(e.name_en || "")}</div></div></div></td>
      <td class="booth-cell">${esc(e.booth_no)}</td>
      <td class="col-cat">${esc(cat ? cat.name_zh : e.category)}</td>
      <td class="col-country">${esc(e.country)}</td>
      ${teamView ? `
      <td class="status-cell"><span class="status-dot" style="background:${statusColor};"></span>${esc(st.status)}</td>
      <td class="status-cell col-post">${st.post_class ? `<span class="status-dot" style="background:${POST_CLASS_COLORS[st.post_class] || "#8a8a82"};"></span>${esc(st.post_class)}` : "—"}</td>
      <td class="col-goal">${st.goal_tags.length ? st.goal_tags.map((t) => `<span class="goal-tag">${esc(t)}</span>`).join(" ") : "—"}</td>
      <td>${esc(st.assignee || "—")}</td>
      <td class="col-notes">${st.note_count || ""}</td>` : ""}
      <td class="links-cell col-links">
        ${e.website ? `<a href="${e.website}" target="_blank" rel="noopener">官網</a>` : ""}
        ${(e.pdfs || []).map((p, i) => `<a href="${p}" target="_blank" rel="noopener">型錄${e.pdfs.length > 1 ? i + 1 : ""}</a>`).join("")}
        ${e.directory_url ? `<a href="${e.directory_url}" target="_blank" rel="noopener">展商頁</a>` : ""}
      </td>`;
    tr.onclick = (ev) => {
      if (ev.target.closest("a")) return;
      if (ev.target.closest(".row-star")) { togglePocket(e.id); return; }
      openDetail(e.id);
    };
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// 攤位分組（依館別＋走道區域，如 N1-A210 → N1 館・A 區），依攤位排序時用來分段顯示，
// 同區的公司排在一起走，減少繞路
function boothGroup(e) {
  const b = e.booth_no || "";
  const m = /^([A-Za-z0-9]+)-([A-Za-z]+)\d+/.exec(b);
  if (m) return { key: `${m[1]}-${m[2]}`, label: `${m[1]} 館・${m[2]} 區` };
  return { key: e.hall || b || "其他", label: e.hall || b || "其他" };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 長文（PDF 全文可達數萬字）在清單裡只顯示開頭，完整內容按「編輯」看
function clipText(s, n) {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字，按「編輯」看全文）` : s;
}

async function togglePocket(id) {
  if (!API_OK && !OFFLINE) { showToast("共筆後端未連線"); return; }
  const st = getState(id);
  await saveState(id, { pocket: !st.pocket });
  if (CURRENT_ID === id) openDetail(id);
}

// ---------- 詳情 modal ----------
async function openDetail(id) {
  CURRENT_ID = id;
  const e = EXHIBITORS.find((x) => x.id === id);
  const st = getState(id);
  const cat = CAT_MAP[e.category];
  const modal = $("detail-modal");

  const lineHits = PRODUCT_LINES.filter((l) => LINE_MATCHES[l.id].has(id));
  const visit = KEY_VISIT_MAP[id];

  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="d-close">✕</button></div>
    <div class="detail-head">
      <div class="detail-head-main">
        ${e.photo ? `<img class="detail-photo" src="${esc(e.photo)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div>
        <h2>${esc(e.name_zh || e.name_en)} ${e.custom ? '<span class="custom-badge" title="團隊自行新增，不是官方展商目錄裡的資料">🆕 自訂</span>' : ""} ${e.in_directory === false ? '<span class="custom-badge not-in-directory" title="最新官方展商名冊已無此公司，保留舊紀錄不刪除">⚠️ 非本屆</span>' : ""} <button class="star big ${st.pocket ? "on" : ""}" id="d-star">${st.pocket ? "★" : "☆"}</button></h2>
        <p class="sub">${esc(e.name_en || "")}｜${esc(cat ? cat.name_zh : "")}｜攤位 ${esc(e.booth_no)}｜${esc(e.country)}</p>
        <p class="sub link-row">
          ${e.website ? `<a class="directory-link" href="${e.website}" target="_blank" rel="noopener">公司官網</a>` : ""}
          ${(e.pdfs || []).map((p, i) => `<a class="directory-link" href="${p}" target="_blank" rel="noopener">型錄 PDF${e.pdfs.length > 1 ? " " + (i + 1) : ""}</a>`).join("")}
          ${e.directory_url ? `<a class="directory-link" href="${e.directory_url}" target="_blank" rel="noopener">官方展商頁</a>` : ""}
          <a class="directory-link" href="#" id="d-share">🔗 複製分享連結</a>
          ${e.custom ? `<a class="directory-link danger" href="#" id="d-delete-custom">🗑 移除這筆自訂廠商</a>` : ""}
        </p>
        ${visit ? `<p class="sub visit-info"><strong>行程重點</strong>：${esc(visit.when)}${visit.contact ? `｜${esc(visit.contact)}` : ""}${visit.note ? `｜${esc(visit.note)}` : ""}</p>` : ""}
        ${lineHits.length ? `<p class="sub">產品／科別關聯：${lineHits.map((l) => l.name).join("、")}</p>` : ""}
        </div>
      </div>
    </div>
    <p class="detail-desc">${esc(e.description || "（無簡介）")}</p>
    ${(e.products || []).length ? `<div class="tags">${e.products.map((p) => `<span class="tag">${esc(p)}</span>`).join("")}</div>` : ""}

    ${(API_OK || (OFFLINE && me())) ? `
    <hr/>
    <div class="state-grid" id="d-state-grid">
      <div>
        <label>拜訪狀態</label>
        <div class="check-row" id="d-status">
          ${STATUS_OPTIONS.map((s) => `<label class="check-chip ${s === st.status ? "on" : ""}"><input type="radio" name="d-status-${id}" value="${esc(s)}" ${s === st.status ? "checked" : ""}>${esc(s)}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>負責同事</label>
        <div class="check-row" id="d-assignee">
          <label class="check-chip ${!st.assignee ? "on" : ""}"><input type="radio" name="d-assignee-${id}" value="" ${!st.assignee ? "checked" : ""}>未指派</label>
          ${(() => { const names = assignableNames();
            // 舊資料存全名（邱長儒）時對應到正式短名 chip 點亮，不另外長出一顆全名 chip；
            // 完全不在名單上的名字才補一顆，避免看起來沒指派
            const current = st.assignee ? (names.find((n) => isSameName(n, st.assignee)) || st.assignee) : "";
            if (current && !names.includes(current)) names.push(current);
            return names.map((n) => `<label class="check-chip ${n === current ? "on" : ""}"><input type="radio" name="d-assignee-${id}" value="${esc(n)}" ${n === current ? "checked" : ""}>${esc(n)}</label>`).join(""); })()}
        </div>
      </div>
      <div>
        <label>已索取資料</label>
        <div class="check-row" id="d-collected">
          ${COLLECTED_OPTIONS.map((c) => `<label class="check-chip ${st.collected.includes(c.id) ? "on" : ""}"><input type="checkbox" value="${c.id}" ${st.collected.includes(c.id) ? "checked" : ""}>${c.label}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>觀展目標（為什麼看這家）</label>
        <div class="check-row" id="d-goal-tags">
          ${GOAL_OPTIONS.map((g) => `<label class="check-chip ${st.goal_tags.includes(g) ? "on" : ""}"><input type="checkbox" value="${esc(g)}" ${st.goal_tags.includes(g) ? "checked" : ""}>${esc(g)}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>資質確認（現場詢問後勾選）</label>
        <div class="check-row" id="d-quals">
          ${QUAL_OPTIONS.map((q) => `<label class="check-chip ${st.quals.includes(q.id) ? "on" : ""}"><input type="checkbox" value="${q.id}" ${st.quals.includes(q.id) ? "checked" : ""}>${q.label}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>展後分類（回台彙整用）</label>
        <div class="check-row" id="d-post-class">
          <label class="check-chip ${!st.post_class ? "on" : ""}"><input type="radio" name="d-post-class-${id}" value="" ${!st.post_class ? "checked" : ""}>未分類</label>
          ${POST_CLASS_OPTIONS.map((p) => `<label class="check-chip ${p === st.post_class ? "on" : ""}"><input type="radio" name="d-post-class-${id}" value="${esc(p)}" ${p === st.post_class ? "checked" : ""}>${esc(p)}</label>`).join("")}
        </div>
      </div>
    </div>

    <div id="d-questions"></div>

    <hr/>
    <h3 class="section-title">拜訪成果記錄
      ${(()=>{ const c=visitCompleteness(st); return c>0||st.status==="已拜訪"?`<span class="comp-inline comp-${c}">${c}/4</span>`:""; })()}
    </h3>
    <div class="visit-record-form">
      <div class="vr-row">
        <span class="vr-label">取得了什麼</span>
        <div class="check-row" id="d-vr-obtained">
          ${OBTAINED_OPTIONS.map((o) => `<label class="check-chip ${((st.visit_record||{}).obtained||[]).includes(o) ? "on" : ""}"><input type="checkbox" value="${esc(o)}" ${((st.visit_record||{}).obtained||[]).includes(o) ? "checked" : ""}>${esc(o)}</label>`).join("")}
        </div>
      </div>
      <div class="vr-fields">
        <div><label>聯絡人</label><input class="vr-input" id="d-vr-contact" placeholder="姓名或職稱" value="${esc((st.visit_record||{}).contact||"")}" /></div>
      </div>
      <div class="vr-row">
        <span class="vr-label">① 能為邦特解決什麼問題？</span>
        <textarea id="d-vr-solves" class="vr-note" placeholder="例：第二供應商、降低成本、補齊親水塗層產能…">${esc((st.visit_record||{}).solves || (st.visit_record||{}).note || "")}</textarea>
      </div>
      <div class="vr-row">
        <span class="vr-label">② 相較現有方案，差異在哪裡？</span>
        <textarea id="d-vr-diff" class="vr-note" placeholder="例：交期比現有短一半、有 ISO 13485、精度較差但便宜…">${esc((st.visit_record||{}).diff||"")}</textarea>
      </div>
      <div class="vr-next-row">
        <label>下一步</label>
        <select id="d-vr-next">
          <option value="">— 未決定 —</option>
          ${NEXT_STEP_OPTIONS.map((n) => `<option value="${esc(n)}" ${n===((st.visit_record||{}).next_step||"")?"selected":""}>${esc(n)}</option>`).join("")}
        </select>
        <button class="btn small primary" id="d-vr-save">儲存</button>
      </div>
    </div>
    ` : ""}

    ${API_OK ? `
    <hr/>
    <h3 class="section-title">團隊紀錄（任何人可新增、修改）</h3>
    <div class="note-form">
      <select id="d-note-type">
        ${NOTE_TYPES.map((t) => `<option>${t}</option>`).join("")}
      </select>
      <textarea id="d-note-content" placeholder="想請去的同事代為詢問什麼？現場聊到什麼？要跟進什麼？"></textarea>
      <button class="btn primary small" id="d-note-add">送出</button>
    </div>
    <div id="d-notes" class="notes-list">載入中...</div>

    <hr/>
    <details id="d-att-wrap" open>
      <summary class="section-title">附件（照片／錄音／影片）<span id="d-att-count" class="att-count"></span></summary>
      ${UPLOADS_ENABLED ? `
      <div class="upload-row">
        <button class="btn small capture-btn" id="d-capture-btn" type="button">📸 採集模式<small>可拍照</small></button>
        <button class="btn small record-btn" id="d-record-btn" type="button">🎙 錄音<small>純錄音</small></button>
        <button class="btn small photo-btn" id="d-photo-btn" type="button">📷 連續拍照</button>
        <label class="btn small upload-btn">📁 上傳檔案<input type="file" id="d-file" accept="image/*,video/*,audio/*,application/pdf,.docx,.xlsx,.pptx,.txt,.md,.csv" multiple hidden /></label>
        <button class="btn small ghost" id="d-att-process" type="button" title="用 Cloudflare AI 把這家展商還沒處理的錄音全部轉文字、照片全部擷取文字（已處理過的不會重跑；結果照樣可編輯）">🪄 Cloudflare AI 整理</button>
        <button class="btn small ghost" id="d-att-reorganize" type="button" title="剛剛分類的照片還沒歸位時，點這個立刻重新整理">🗂 整理歸檔</button>
        <span id="d-att-pending" class="sub"></span>
        <span id="d-upload-status" class="sub"></span>
      </div>
      <p class="sub">採集模式＝不開鏡頭，錄音在背景跑，浮動列可隨時拍照（拍照時才臨時開鏡頭，拍完立刻關閉，錄音不中斷），每張照片自動標上「錄音第幾分幾秒拍的」；錄音每 10 分鐘自動分段上傳，段落即傳即安全。連續拍照＝不錄音，鏡頭持續開著，拍完一張直接拍下一張，不用重新點選。</p>` : `<p class="sub">檔案上傳尚未啟用（需先在 Cloudflare 建立 R2 bucket，設定方式見 cloudflare/README.md）。</p>`}
      <div id="d-attachments" class="notes-list"></div>
    </details>

    <details id="d-history-wrap"><summary>修改歷程</summary><div id="d-history">載入中...</div></details>
    ` : (OFFLINE && me()) ? `
    <hr/>
    <h3 class="section-title">團隊紀錄（離線模式）</h3>
    <p class="sub">現在沒有網路：寫的紀錄會先存在手機，連上網路後自動同步到團隊。</p>
    <div class="note-form">
      <select id="d-note-type">
        ${NOTE_TYPES.map((t) => `<option>${t}</option>`).join("")}
      </select>
      <textarea id="d-note-content" placeholder="現場聊到什麼？要跟進什麼？"></textarea>
      <button class="btn primary small" id="d-note-add">存到手機（待同步）</button>
    </div>
    <div id="d-notes" class="notes-list"></div>
    ` : `<p class="sub">共筆後端未連線，僅供瀏覽。</p>`}
  `;

  $("detail-overlay").classList.add("open");
  lockBodyScroll();
  $("d-close").onclick = closeDetail;
  const star = $("d-star");
  if (star) star.onclick = () => togglePocket(id);

  setShareParam(id);
  $("d-share").onclick = async (ev) => {
    ev.preventDefault();
    try {
      await navigator.clipboard.writeText(shareUrlFor(id));
      showToast("連結已複製，貼給同事就能直接打開這家廠商");
    } catch {
      showToast("複製失敗，請手動複製網址列");
    }
  };

  if (e.custom) {
    $("d-delete-custom").onclick = async (ev) => {
      ev.preventDefault();
      if (!confirm(`確定要移除自訂廠商「${e.name_zh || e.name_en}」？\n這家底下如果已經有指派狀態或現場紀錄，資料庫裡不會真的刪掉，只會從清單上消失。`)) return;
      try {
        await api(`/custom-exhibitors/${encodeURIComponent(id)}?author=${encodeURIComponent(me())}`, { method: "DELETE" });
        setCustomExhibitors(CUSTOM_EXHIBITORS.filter((x) => x.id !== id));
        closeDetail();
        render();
        showToast("已移除");
      } catch (err) {
        showToast("移除失敗：" + err.message);
      }
    };
  }

  // 狀態選單與拜訪成果表單：連線、離線都能填（離線先存手機）
  if (API_OK || (OFFLINE && me())) {
    bindRadioRow("d-status", (value) => saveState(id, { status: value }));
    bindRadioRow("d-assignee", (value) => saveState(id, { assignee: value }));
    bindCheckRow("d-collected", (values) => saveState(id, { collected: values }));
    bindCheckRow("d-goal-tags", (values) => saveState(id, { goal_tags: values }));
    bindCheckRow("d-quals", (values) => saveState(id, { quals: values }));
    bindRadioRow("d-post-class", (value) => saveState(id, { post_class: value }));
    bindCheckRow("d-vr-obtained", () => {}); // keep chip styling in sync, save on button
    $("d-vr-save").onclick = () => {
      const obtained = [...document.querySelectorAll("#d-vr-obtained input:checked")].map((i) => i.value);
      const vr = {
        obtained,
        contact: $("d-vr-contact").value.trim(),
        solves: $("d-vr-solves").value.trim(),
        diff: $("d-vr-diff").value.trim(),
        next_step: $("d-vr-next").value,
      };
      const patch = { visit_record: vr };
      if (getState(id).status === "未排定" && (vr.solves || vr.diff || vr.obtained.length || vr.next_step || vr.contact)) {
        patch.status = "已拜訪";
        setRadioChipValue("d-status", "已拜訪");
      }
      saveState(id, patch);
    };
  }

  if (!API_OK) {
    // 離線模式：綁紀錄表單，顯示這家廠商的待同步紀錄與快照裡的代問事項
    if ($("d-note-add")) {
      $("d-note-add").onclick = () => addNote(id);
      renderPendingNotes(id);
    }
    renderQuestions(id, notesCache()[id] || []);
    return;
  }

  $("d-note-add").onclick = () => addNote(id);
  const fileInput = $("d-file");
  if (fileInput) fileInput.onchange = () => uploadFile(id, fileInput);
  const recordBtn = $("d-record-btn");
  if (recordBtn) recordBtn.onclick = () => toggleRecording(id, recordBtn);
  const captureBtn = $("d-capture-btn");
  if (captureBtn) captureBtn.onclick = () => startCapture(id);
  const photoBtn = $("d-photo-btn");
  if (photoBtn) photoBtn.onclick = () => startPhotoBurst(id);
  const reorganizeBtn = $("d-att-reorganize");
  if (reorganizeBtn) reorganizeBtn.onclick = () => loadAttachments(id);
  const processBtn = $("d-att-process");
  if (processBtn) processBtn.onclick = () => processAllAttachments(id, processBtn);

  loadNotes(id);
  loadAttachments(id);
  loadHistory(id);
}

function bindCheckRow(elId, onChange) {
  const wrap = $(elId);
  wrap.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      input.closest(".check-chip").classList.toggle("on", input.checked);
      const values = [...wrap.querySelectorAll("input:checked")].map((i) => i.value);
      onChange(values);
    };
  });
}

function bindRadioRow(elId, onChange) {
  const wrap = $(elId);
  if (!wrap) return;
  wrap.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      wrap.querySelectorAll(".check-chip").forEach((c) => c.classList.remove("on"));
      input.closest(".check-chip").classList.add("on");
      onChange(input.value);
    };
  });
}

function setRadioChipValue(elId, value) {
  const wrap = $(elId);
  if (!wrap) return;
  wrap.querySelectorAll("input").forEach((input) => {
    const on = input.value === value;
    input.checked = on;
    input.closest(".check-chip").classList.toggle("on", on);
  });
}

function saveStateOffline(id, patch) {
  queueStatePatch(id, patch);
  STATE[id] = { ...getState(id), ...patch };
  saveSnapshot(); // 寫回快照，關掉重開也不會掉
  render();
  renderTaskSummary();
  showToast("沒有網路，已存在手機（連線後自動同步）");
}

async function saveState(id, patch) {
  if (!API_OK) { saveStateOffline(id, patch); return; }
  try {
    const updated = await api(`/state/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...patch, author: me() }),
    });
    STATE[id] = { ...getState(id), ...updated };
    saveSnapshot(); // 立刻寫回本機，斷網或關閉頁面都不會遺失剛存的內容
    render();
    renderTaskSummary();
    loadHistory(id);
    showToast("已儲存");
  } catch (err) {
    if (isNetworkError(err)) { saveStateOffline(id, patch); return; } // 展場網路突然斷掉也不丟資料
    showToast("儲存失敗：" + err.message);
  }
}

// ---------- 筆記快照與代問 ----------
// 登入時整批快照全隊筆記到手機：離線打開任何一家廠商，都看得到廠內同事的代問事項
function notesCache() {
  return JSON.parse(localStorage.getItem("medtec_notes") || "{}");
}

function setNotesCache(map) {
  try { localStorage.setItem("medtec_notes", JSON.stringify(map)); } catch { /* 空間不足時略過 */ }
}

async function snapshotAllNotes() {
  try {
    const all = await api("/notes");
    const map = {};
    for (const n of all) (map[n.exhibitor_id] = map[n.exhibitor_id] || []).push(n);
    setNotesCache(map);
  } catch { /* 離線時略過，用上次的快照 */ }
}

// 代問區塊：把「想詢問的問題」類型的紀錄放到顯眼位置（含離線待同步的），
// 並提供快速新增入口——廠內沒去展的同事也能請現場的人幫忙問
function renderQuestions(id, notes) {
  const box = $("d-questions");
  if (!box) return;
  const pendingQ = getPending().filter((n) => n.exhibitor_id === id && n.type === "想詢問的問題");
  const qs = [...(notes || []).filter((n) => n.type === "想詢問的問題"), ...pendingQ];
  let inner = qs.length
    ? `<div class="q-title">🙋 廠內同事想代問（${qs.length} 則）——現場記得幫問</div>` +
      qs.map((q) => `<div class="q-item"><strong>${esc(q.author)}</strong>：${esc(q.content)}</div>`).join("")
    : `<div class="q-title q-empty">🙋 沒去現場但想了解這家？請同事代問</div>`;
  inner += `<button class="btn small ghost" id="d-add-question">＋新增代問問題</button>`;
  box.innerHTML = `<div class="question-box">${inner}</div>`;
  $("d-add-question").onclick = () => {
    const typeSel = $("d-note-type");
    if (!typeSel) { showToast("請先登入才能新增代問"); return; }
    typeSel.value = "想詢問的問題";
    const content = $("d-note-content");
    content.placeholder = "想請現場同事幫忙問什麼？（例：報價與 MOQ、有沒有 ISO 13485、能否寄樣）";
    content.scrollIntoView({ behavior: "smooth", block: "center" });
    content.focus();
  };
}

function pendingNotesHtml(id) {
  return getPending()
    .filter((n) => n.exhibitor_id === id)
    .map((n) => `
      <div class="note pending">
        <div class="note-meta"><strong>${esc(n.author)}</strong> · ${esc(n.type)} · ${esc(n.created_at)} · <span class="pending-tag">待同步</span></div>
        <div class="note-content">${esc(n.content)}</div>
      </div>`).join("");
}

function renderPendingNotes(id) {
  const wrap = $("d-notes");
  if (!wrap) return;
  wrap.innerHTML = pendingNotesHtml(id) || "";
}

async function loadNotes(id) {
  const wrap = $("d-notes");
  const pendingHtml = pendingNotesHtml(id);
  try {
    const notes = await api(`/notes?exhibitor_id=${id}`);
    const cache = notesCache(); cache[id] = notes; setNotesCache(cache);
    renderQuestions(id, notes);
    if (document.body.classList.contains("prep-view")) renderPrepReport();
    if (!notes.length && !pendingHtml) { wrap.innerHTML = '<p class="sub">還沒有任何紀錄，寫下第一筆吧。</p>'; return; }
    wrap.innerHTML = pendingHtml + notes.map((n) => `
      <div class="note" data-id="${n.id}">
        <div class="note-meta">
          <strong>${esc(n.author)}</strong> · ${esc(n.type)} · ${esc(n.created_at)}${n.updated_at ? "（已編輯）" : ""}
          <span class="note-actions">
            <a href="#" data-act="edit">編輯</a> <a href="#" data-act="del">刪除</a>
          </span>
        </div>
        <div class="note-content">${esc(n.content)}</div>
      </div>`).join("");
    wrap.querySelectorAll("a[data-act]").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const noteEl = a.closest(".note");
        const noteId = noteEl.dataset.id;
        if (a.dataset.act === "edit") editNote(id, noteId, noteEl.querySelector(".note-content").textContent);
        else deleteNote(id, noteId);
      };
    });
  } catch (err) {
    wrap.innerHTML = pendingHtml + `<p class="sub">（線上紀錄暫時無法載入）</p>`;
  }
}

async function addNote(id) {
  const content = $("d-note-content").value.trim();
  if (!content) { showToast("請先輸入內容"); return; }
  const note = { exhibitor_id: id, author: me(), type: $("d-note-type").value, content };
  if (!API_OK) {
    // 離線：直接進佇列
    addPending(note);
    $("d-note-content").value = "";
    renderPendingNotes(id);
    renderQuestions(id, notesCache()[id] || []);
    if (document.body.classList.contains("prep-view")) renderPrepReport();
    showToast("沒有網路，已存在手機（連線後自動同步）");
    return;
  }
  try {
    await api("/notes", { method: "POST", body: JSON.stringify(note) });
    $("d-note-content").value = "";
    const st = getState(id);
    STATE[id] = { ...st, note_count: (st.note_count || 0) + 1 };
    saveSnapshot();
    loadNotes(id); loadHistory(id); render();
    showToast("已新增紀錄");
  } catch (err) {
    if (isNetworkError(err)) {
      addPending(note);
      $("d-note-content").value = "";
      loadNotes(id);
      showToast("網路不穩，已存在手機（連線後自動同步）");
    } else {
      showToast("新增失敗：" + err.message);
    }
  }
}

async function editNote(exhibitorId, noteId, oldContent) {
  const content = prompt("修改紀錄內容：", oldContent);
  if (content === null || !content.trim()) return;
  try {
    await api(`/notes/${noteId}`, { method: "PUT", body: JSON.stringify({ content: content.trim(), author: me() }) });
    loadNotes(exhibitorId); loadHistory(exhibitorId);
    showToast("已修改（歷程有保留原文）");
  } catch (err) { showToast("修改失敗：" + err.message); }
}

async function deleteNote(exhibitorId, noteId) {
  if (!confirm("確定刪除這筆紀錄？（修改歷程仍會保留內容）")) return;
  try {
    await api(`/notes/${noteId}?author=${encodeURIComponent(me())}`, { method: "DELETE" });
    const st = getState(exhibitorId);
    STATE[exhibitorId] = { ...st, note_count: Math.max(0, (st.note_count || 0) - 1) };
    saveSnapshot();
    loadNotes(exhibitorId); loadHistory(exhibitorId); render();
  } catch (err) { showToast("刪除失敗：" + err.message); }
}

// 詳情頁開啟時鎖住底層頁面捲動（iOS Safari 光 overflow:hidden 不夠，
// 要用 position:fixed 才真的鎖得住），關閉時還原原本的捲動位置
function lockBodyScroll() {
  if (document.body.classList.contains("modal-open")) return; // 重複開啟（詳情間切換/刷新）時別把捲動位置蓋成 0
  document.body.dataset.scrollY = String(window.scrollY);
  document.body.style.top = `-${window.scrollY}px`;
  document.body.classList.add("modal-open");
}
function unlockBodyScroll() {
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, Number(document.body.dataset.scrollY || 0));
}

// ---------- 附件 ----------
function fileUrl(key) {
  return `/api/file/${encodeURIComponent(key)}?pin=${encodeURIComponent(pin())}`;
}

// 🪄 一鍵整理：這家展商還沒轉文字的錄音全部轉、還沒擷取文字的照片全部擷取。
// 順序刻意先錄音後照片——照片的【對話關聯】需要逐字稿先就位才判得出來。
// 逐筆處理、失敗跳過（可事後個別重試），人在迴圈的原則不變：結果照樣可編輯。
async function processAllAttachments(id, btn) {
  if (!TRANSCRIBE_ENABLED) { showToast("尚未啟用 AI 功能（需 Workers AI 與 R2）"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const atts = await api(`/attachments?exhibitor_id=${id}`);
    // 「處理過但結果是空的」（transcribed_at/ocr_at 有時間戳）不算待整理，不重跑
    const audioTodo = atts.filter((a) => (a.mime || "").startsWith("audio/") && !a.transcript && !a.transcribed_at);
    const imgTodo = atts.filter((a) => ((a.mime || "").startsWith("image/") || isPdfAtt(a) || isNativeDocAtt(a)) && !a.ocr_text && !a.ocr_at);
    const total = audioTodo.length + imgTodo.length;
    if (!total) { showToast("沒有需要整理的附件，都處理過了"); return; }
    let done = 0;
    let failed = 0;
    const errCounts = new Map(); // 各種失敗原因各出現幾次，跑完常駐顯示（toast 2.5 秒根本來不及看）
    let quotaHit = false; // Cloudflare AI 每日額度用完（錯誤碼 4006）就立刻停，不再逐筆撞牆
    const queue = [
      ...audioTodo.map((a) => ({ a, ep: "transcribe" })),
      ...imgTodo.map((a) => ({ a, ep: "ocr" })),
    ];
    let gotText = 0;
    let gotEmpty = 0;
    const processedIds = [];
    for (const { a, ep } of queue) {
      btn.textContent = `🪄 整理中 ${++done}/${total}`;
      try {
        const res = await api(`/attachments/${a.id}/${ep}`, { method: "POST", body: JSON.stringify({ author: me() }) });
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
    const statusEl = $("d-upload-status");
    if (quotaHit) {
      const remaining = total - done;
      showToast(`⛔ Cloudflare AI 每日免費額度已用完。已停止整理，剩 ${remaining + 1} 筆`);
      if (statusEl) statusEl.textContent = `⛔ 額度用完，剩 ${remaining + 1} 筆未跑（台北早上 8 點重置後再按一次續跑）`;
    } else if (failed) {
      showToast(`整理完成，${failed} 筆失敗（原因見按鈕旁）`);
      if (statusEl) statusEl.textContent = `⚠️ ${failed} 筆失敗：${errSummary}${processedIds.length ? `｜成功 ${processedIds.length} 筆（${okSummary}），結果標綠在下方 ↓` : ""}`;
    } else {
      showToast(`整理完成：${total} 筆`);
      if (statusEl) statusEl.textContent = `✓ 本次整理 ${total} 筆：${okSummary}，結果標綠在下方 ↓`;
    }
    await loadAttachments(id);
    // 這次剛整理的附件標綠邊條＋自動展開結果，捲下去一眼就知道哪些是新結果
    for (const pid of processedIds) {
      const note = $("d-attachments")?.querySelector(`.note[data-id="${pid}"]`);
      if (!note) continue;
      note.classList.add("just-processed");
      note.querySelectorAll("details.att-ai").forEach((d) => { d.open = true; });
    }
    loadHistory(id); loadSearchTexts();
  } catch (err) {
    showToast("整理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🪄 Cloudflare AI 整理";
  }
}

// 🔬 Tier 2 深度處理：手動指定單一 PDF 才會跑，絕不背景全庫批次（見 DATA-MODEL.md）。
// Cloudflare Worker 沒有 PDF 渲染能力，這步只能在瀏覽器端用 pdf.js 把每一頁畫成圖片，
// 再把每張頁面圖丟進既有的照片 OCR 流程——這樣向量圖表（整頁截圖天生就含）跟排版化的
// 技術參數文字都變成看得見的像素，Llama Vision 抄得到，也自動進 search_exhibitor_files
// 全文索引，不用另外蓋一套 Tier 2 儲存/搜尋機制。
async function deepProcessPdf(exhibitorId, pdfAtt, btn) {
  if (!window.pdfjsLib) { showToast("PDF 渲染程式庫載入失敗，請檢查網路連線後重新整理頁面再試"); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }
    btn.textContent = "下載 PDF…";
    const res = await fetch(fileUrl(pdfAtt.key));
    if (!res.ok) throw new Error(`下載 PDF 失敗（HTTP ${res.status}）`);
    const pdf = await pdfjsLib.getDocument({ data: await res.arrayBuffer() }).promise;
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
        const uploaded = await putFile(exhibitorId, blob, `${baseName}-p${p}.png`, { sourcePdfId: pdfAtt.id, pageNo: p });
        btn.textContent = `辨識第 ${p}/${total} 頁…`;
        await api(`/attachments/${uploaded.id}/ocr`, { method: "POST", body: JSON.stringify({ author: me() }) });
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
    loadAttachments(exhibitorId); loadHistory(exhibitorId); loadSearchTexts();
  } catch (err) {
    showToast("深度處理失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function putFile(id, file, filename, meta) {
  const headers = {
    "content-type": file.type || "application/octet-stream",
    "x-team-pin": pin(),
    "x-exhibitor-id": id,
    "x-author": encodeURIComponent(me()),
    "x-filename": encodeURIComponent(filename || file.name || "file"),
  };
  // 採集 session 資訊：照片/錄音段掛同一個 session，offset 是釘在錄音時間軸的秒數
  if (meta && meta.sessionId) headers["x-session-id"] = String(meta.sessionId);
  if (meta && meta.offsetSecs !== undefined && meta.offsetSecs !== null) headers["x-offset-secs"] = String(meta.offsetSecs);
  if (meta && meta.durationSecs !== undefined && meta.durationSecs !== null) headers["x-duration-secs"] = String(meta.durationSecs);
  // Tier 2 深度處理：PDF 逐頁 render 成圖片時，帶回來源 PDF id 與頁碼
  if (meta && meta.sourcePdfId !== undefined && meta.sourcePdfId !== null) headers["x-source-pdf-id"] = String(meta.sourcePdfId);
  if (meta && meta.pageNo !== undefined && meta.pageNo !== null) headers["x-page-no"] = String(meta.pageNo);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers,
    body: file,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function uploadFile(id, input) {
  const files = input.files ? Array.from(input.files) : [];
  if (!files.length) return;
  input.value = "";
  const status = $("d-upload-status");
  const multi = files.length > 1;
  let failed = 0;
  let queued = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progress = multi ? `（${i + 1}/${files.length}）` : "";
    if (file.size > 50 * 1024 * 1024) {
      status.textContent = `${file.name} 超過 50MB，已略過${progress}`;
      failed++;
      continue;
    }
    if (!API_OK) {
      // 離線：檔案先存手機（IndexedDB），連上網路後 syncPending() 自動補傳
      await addPendingFile(pendingFileEntry(id, file));
      queued++;
      continue;
    }
    status.textContent = `上傳中…${progress}${(file.size / 1024 / 1024).toFixed(1)}MB`;
    try {
      const uploaded = await putFile(id, file);
      // 一次只選一個檔案時，順便問說明；多選時略過（之後可個別補說明）
      if (!multi) {
        const caption = prompt("為這個檔案寫一段說明（可留空，之後也能補）：", "");
        if (caption && caption.trim()) {
          await api(`/attachments/${uploaded.id}`, {
            method: "PUT",
            body: JSON.stringify({ caption: caption.trim(), author: me() }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      if (isNetworkError(err)) {
        await addPendingFile(pendingFileEntry(id, file));
        queued++;
      } else {
        status.textContent = `${file.name} 上傳失敗：${err.message}`;
        failed++;
      }
    }
  }
  status.textContent = "";
  const ok = files.length - failed - queued;
  const parts = [];
  if (ok) parts.push(`已上傳 ${ok} 個`);
  if (queued) parts.push(`${queued} 個沒有網路，已存手機（連線後自動同步）`);
  if (failed) parts.push(`${failed} 個失敗`);
  showToast(parts.join("，") || "上傳失敗");
  loadAttachments(id);
  loadHistory(id);
}

// 瀏覽器內建錄音（手機的檔案選單通常只給拍照／錄影，沒有錄音的即時選項，
// 所以另外用麥克風權限做一顆錄音按鈕，錄完直接當附件上傳）
let activeRecording = null; // { recorder, stream, timerId }

async function toggleRecording(id, btn) {
  if (activeRecording) { activeRecording.recorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showToast("這個瀏覽器不支援錄音，請改用手機錄音 App 錄好後再上傳檔案");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast("無法使用麥克風：" + err.message);
    return;
  }
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const startedAt = Date.now();
  const updateLabel = () => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    btn.textContent = `⏹ 停止（${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}）`;
  };
  recorder.onstop = async () => {
    clearInterval(activeRecording.timerId);
    stream.getTracks().forEach((t) => t.stop());
    activeRecording = null;
    btn.textContent = "🎙 錄音";
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    if (!blob.size) return;
    btn.disabled = true;
    const status = $("d-upload-status");
    status.textContent = "上傳錄音中…";
    const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
    const filename = `錄音-${Date.now()}.${ext}`;
    if (!API_OK) {
      await addPendingFile(pendingFileEntry(id, blob, filename));
      status.textContent = "";
      showToast("沒有網路，錄音已存手機（連線後自動同步）");
      loadAttachments(id);
      btn.disabled = false;
      return;
    }
    try {
      await putFile(id, blob, filename);
      status.textContent = "";
      showToast("錄音已上傳");
      loadAttachments(id);
      loadHistory(id);
    } catch (err) {
      if (isNetworkError(err)) {
        await addPendingFile(pendingFileEntry(id, blob, filename));
        status.textContent = "";
        showToast("沒有網路，錄音已存手機（連線後自動同步）");
        loadAttachments(id);
      } else {
        status.textContent = "錄音上傳失敗：" + err.message;
      }
    }
    btn.disabled = false;
  };
  recorder.start();
  updateLabel();
  activeRecording = { recorder, stream, timerId: setInterval(updateLabel, 1000) };
}

// ---------- 現場採集模式 ----------
// 錄音全程不中斷＋相機即時預覽隨時抓拍。每張照片的說明自動標上
// 「錄音第幾分幾秒拍的」，之後錄音轉文字就能對出「拍這張時在講什麼」。
// 錄音每 CAPTURE_SEG_MINUTES 分鐘自動分段、即切即傳：檔案不會撐爆 50MB
// 上限、每段轉文字都跑得動、中途出狀況最多只損失錄到一半的那一段。
const CAPTURE_SEG_MINUTES = 10;

let CAPTURE = null; // { stream, recorder, startedAt, segIndex, segStartMs, photos, exhibitorId, session, timerId, ending, autoStopped }

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function captureOffsetLabel() {
  return fmtSecs(Math.floor((Date.now() - CAPTURE.startedAt) / 1000));
}

// 開一段新錄音（換段時錄音只斷幾十毫秒，聽感上無縫）
function startSegmentRecorder() {
  const audioOnly = new MediaStream(CAPTURE.stream.getAudioTracks());
  const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const recorder = mimeType ? new MediaRecorder(audioOnly, { mimeType }) : new MediaRecorder(audioOnly);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => onSegmentStop(recorder, chunks);
  CAPTURE.recorder = recorder;
  CAPTURE.segStartMs = Date.now();
  recorder.start();
}

async function startCapture(id) {
  if (CAPTURE) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showToast("這個瀏覽器不支援採集模式，可改用「錄音」＋「拍照／上傳」分開記");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast("無法開啟麥克風：" + err.message);
    return;
  }
  CAPTURE = { stream, recorder: null, startedAt: Date.now(), segIndex: 1, segStartMs: Date.now(), photos: 0, exhibitorId: id, session: Date.now(), timerId: 0, ending: false, autoStopped: false };
  startSegmentRecorder();
  $("capture-count").textContent = "";
  $("capture-timer").textContent = "00:00";
  $("capture-badge").style.display = "flex";
  CAPTURE.timerId = setInterval(() => {
    if (!CAPTURE) return;
    $("capture-timer").textContent = captureOffsetLabel();
    if (!CAPTURE.ending && CAPTURE.recorder.state === "recording" &&
        Date.now() - CAPTURE.segStartMs >= CAPTURE_SEG_MINUTES * 60 * 1000) {
      CAPTURE.recorder.stop(); // 到段落長度自動換段，onSegmentStop 會接著開下一段
    }
  }, 1000);
}

// 採集中臨時拍照：另外開一個鏡頭串流，看得到畫面才拍，拍完立刻關閉鏡頭
// （錄音走另一條 audio-only stream，鏡頭開關不會中斷錄音）
let CAPTURE_PHOTO_STREAM = null;

async function openCapturePhotoPopup() {
  if (!CAPTURE || CAPTURE_PHOTO_STREAM) return;
  try {
    CAPTURE_PHOTO_STREAM = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  $("capture-photo-video").srcObject = CAPTURE_PHOTO_STREAM;
  $("capture-photo-popup").style.display = "flex";
}

function closeCapturePhotoPopup() {
  if (CAPTURE_PHOTO_STREAM) CAPTURE_PHOTO_STREAM.getTracks().forEach((t) => t.stop());
  CAPTURE_PHOTO_STREAM = null;
  $("capture-photo-video").srcObject = null;
  $("capture-photo-popup").style.display = "none";
}

async function capturePhotoSnap() {
  if (!CAPTURE || !CAPTURE_PHOTO_STREAM) return;
  const video = $("capture-photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒，再等一下"); return; }
  const offsetSecs = Math.floor((Date.now() - CAPTURE.startedAt) / 1000);
  const offset = fmtSecs(offsetSecs);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("capture-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  CAPTURE.photos++;
  $("capture-count").textContent = `📷 ${CAPTURE.photos}`;
  const { exhibitorId, session } = CAPTURE;
  const meta = { sessionId: session, offsetSecs };
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `採集${session}-${offset.replace(":", "")}.jpg`;
  closeCapturePhotoPopup();
  try {
    const uploaded = await putFile(exhibitorId, blob, filename, meta);
    await api(`/attachments/${uploaded.id}`, {
      method: "PUT",
      body: JSON.stringify({ caption: `📸 錄音 ${offset} 時拍攝`, author: me() }),
    }).catch(() => {});
  } catch (err) {
    // 網路不穩時照片先進手機離線佇列，連線後 syncPending 自動補傳
    try {
      await addPendingFile(pendingFileEntry(exhibitorId, blob, filename, meta));
      showToast("網路不穩，照片先存手機（待同步）");
    } catch {
      showToast("照片上傳失敗：" + err.message);
    }
  }
}

function stopCapture() {
  if (!CAPTURE) return;
  CAPTURE.ending = true;
  if (CAPTURE.recorder && CAPTURE.recorder.state !== "inactive") CAPTURE.recorder.stop();
  if (CAPTURE_PHOTO_STREAM) closeCapturePhotoPopup();
}

// 一段錄音結束——「自動換段」與「使用者/切 App 結束採集」都走到這裡
async function onSegmentStop(recorder, chunks) {
  if (!CAPTURE) return;
  const { stream, exhibitorId, photos, timerId, session, ending, autoStopped, segIndex, segStartMs, startedAt } = CAPTURE;
  const segStartOffset = Math.floor((segStartMs - startedAt) / 1000);
  const segDur = Math.floor((Date.now() - segStartMs) / 1000);
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

  if (ending) {
    const total = fmtSecs(Math.floor((Date.now() - startedAt) / 1000));
    clearInterval(timerId);
    stream.getTracks().forEach((t) => t.stop());
    $("capture-badge").style.display = "none";
    CAPTURE = null;
    showToast(autoStopped ? "偵測到切換 App，已自動結束採集並存檔" : "採集錄音上傳中…");
    await uploadSegment(exhibitorId, blob, session, segIndex, segStartOffset, segDur,
      `；全程 ${total}、共 ${photos} 張照片（照片說明有對應時間點）`, photos);
    if (CURRENT_ID === exhibitorId) { loadAttachments(exhibitorId); loadHistory(exhibitorId); }
  } else {
    CAPTURE.segIndex++;
    startSegmentRecorder(); // 先無縫接上下一段，剛結束的段落在背景上傳
    uploadSegment(exhibitorId, blob, session, segIndex, segStartOffset, segDur, "", 0);
  }
}

// 段落上傳：先寫手機離線佇列（IndexedDB）再上傳，上傳失敗也不會遺失，
// 回到連線狀態由 syncPending 自動補傳
async function uploadSegment(exhibitorId, blob, session, segIndex, startOffset, dur, extraCaption, photosForToast) {
  if (!blob.size) return;
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  const filename = `採集錄音${session}-段${segIndex}.${ext}`;
  const meta = { sessionId: session, offsetSecs: startOffset, durationSecs: dur };
  const entry = pendingFileEntry(exhibitorId, blob, filename, meta);
  let queued = false;
  try { await addPendingFile(entry); queued = true; } catch { /* IndexedDB 不可用時直接走上傳 */ }
  try {
    const uploaded = await putFile(exhibitorId, blob, filename, meta);
    await api(`/attachments/${uploaded.id}`, {
      method: "PUT",
      body: JSON.stringify({ caption: `🎙 採集第 ${segIndex} 段（${fmtSecs(startOffset)}–${fmtSecs(startOffset + dur)}）${extraCaption}`, author: me() }),
    }).catch(() => {});
    if (queued) await deletePendingFile(entry.tmp_id).catch(() => {});
    if (extraCaption) {
      showToast(`採集完成：錄音 ${segIndex} 段＋照片 ${photosForToast} 張`);
    }
  } catch {
    if (!queued) { try { await addPendingFile(entry); queued = true; } catch { /* 佇列也失敗才真的丟 */ } }
    showToast(queued ? "錄音段已先存手機（待同步），連線後自動補傳" : "錄音段上傳失敗");
  }
}

// ---------- 連續拍照：不錄音，鏡頭持續開著，拍一張後不用重新點選就能拍下一張 ----------
let PHOTO_BURST = null;

async function startPhotoBurst(id) {
  if (PHOTO_BURST) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) { showToast("無法開啟相機：" + err.message); return; }
  $("photo-video").srcObject = stream;
  PHOTO_BURST = { stream, exhibitorId: id, photos: 0, localFiles: [] };
  $("photo-count").textContent = "";
  $("photo-save").style.display = "none";
  $("photo-overlay").style.display = "flex";
}

// 手機是否支援「分享/存相簿」：iOS Safari 16.4+、多數新版 Android 瀏覽器都有，
// 舊版沒有的話就不顯示存相簿按鈕，避免點了沒反應
function canSaveToAlbum() {
  return !!(navigator.canShare && navigator.share);
}

async function photoBurstSnap() {
  if (!PHOTO_BURST) return;
  const video = $("photo-video");
  if (!video.videoWidth) { showToast("相機還沒就緒"); return; }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const flash = $("photo-flash");
  flash.classList.add("on");
  setTimeout(() => flash.classList.remove("on"), 160);
  PHOTO_BURST.photos++;
  $("photo-count").textContent = `📷 ${PHOTO_BURST.photos}`;
  const { exhibitorId } = PHOTO_BURST;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  const filename = `照片-${Date.now()}.jpg`;
  // 手機本機留一份（存進 File 陣列），拍完按「存相簿」時一次分享出去，
  // 不管上傳成不成功都留著，這樣就算網路不穩也不會連手機都沒有備份
  if (canSaveToAlbum()) {
    PHOTO_BURST.localFiles.push(new File([blob], filename, { type: "image/jpeg" }));
    $("photo-save").style.display = "inline-block";
    $("photo-save").textContent = `💾 存 ${PHOTO_BURST.localFiles.length} 張到相簿`;
  }
  try {
    const uploaded = await putFile(exhibitorId, blob, filename);
    await api(`/attachments/${uploaded.id}`, {
      method: "PUT",
      body: JSON.stringify({ caption: "", author: me() }),
    }).catch(() => {});
  } catch {
    try {
      await addPendingFile(pendingFileEntry(exhibitorId, blob, filename));
      showToast("網路不穩，照片先存手機（待同步）");
    } catch {
      showToast("照片上傳失敗");
    }
  }
}

async function saveBurstToAlbum() {
  if (!PHOTO_BURST || !PHOTO_BURST.localFiles.length) return;
  const files = PHOTO_BURST.localFiles;
  try {
    if (!navigator.canShare({ files })) throw new Error("此瀏覽器不支援分享多張照片");
    await navigator.share({ files, title: "展商照片" });
  } catch (err) {
    if (err.name !== "AbortError") showToast("無法開啟分享選單：" + err.message);
  }
}

function finishPhotoBurst() {
  if (!PHOTO_BURST) return;
  const { stream, exhibitorId, photos } = PHOTO_BURST;
  stream.getTracks().forEach((t) => t.stop());
  $("photo-video").srcObject = null;
  $("photo-overlay").style.display = "none";
  PHOTO_BURST = null;
  if (photos) showToast(`已拍 ${photos} 張`);
  if (CURRENT_ID === exhibitorId) { loadAttachments(exhibitorId); loadHistory(exhibitorId); }
}

function isPdfAtt(a) {
  return (a.mime || "") === "application/pdf" || (a.filename || "").toLowerCase().endsWith(".pdf");
}

// docx／xlsx／pptx／純文字：後端直接從檔案結構解出文字，不經過 AI（見 imageSkill.js
// 的 detectNativeTextKind），前端只需要知道「這種檔案也可以按擷取文字」
function isNativeDocAtt(a) {
  return /\.(docx|xlsx|pptx|txt|md|csv|json|log)$/i.test(a.filename || "");
}

// 一鍵整理按下去之前先讓人看得到「還有沒有東西可整理」，不用猜、不用白按一次
// 去確認（浪費一次 API 來回，也讓人誤以為每次按都會真的重新跑 AI）
function updatePendingBadge(atts) {
  const el = $("d-att-pending");
  if (!el) return;
  if (!TRANSCRIBE_ENABLED) { el.textContent = ""; return; }
  const audioTodo = atts.filter((a) => (a.mime || "").startsWith("audio/") && !a.transcript && !a.transcribed_at).length;
  const imgTodo = atts.filter((a) => ((a.mime || "").startsWith("image/") || isPdfAtt(a) || isNativeDocAtt(a)) && !a.ocr_text && !a.ocr_at).length;
  const pending = audioTodo + imgTodo;
  el.textContent = pending ? `⏳ ${pending} 筆待整理` : atts.length ? "✓ 已全部整理" : "";
  const btn = $("d-att-process");
  if (btn) btn.disabled = !pending;
}

async function loadAttachments(id) {
  const wrap = $("d-attachments");
  if (!wrap) return;
  const pendingFiles = await getPendingFiles(id);
  const pendingHtml = pendingFiles.map(pendingFileNoteHtml).join("");
  try {
    const atts = await api(`/attachments?exhibitor_id=${id}`);
    const countEl = $("d-att-count");
    const total = atts.length + pendingFiles.length;
    if (countEl) countEl.textContent = total ? `（${total}）` : "";
    updatePendingBadge(atts);
    if (!atts.length) { wrap.innerHTML = pendingHtml; return; }
    // 同名＋同大小出現超過一次 → 標「疑似重複」，讓重複上傳一眼看得出來
    const dupCount = {};
    for (const a of atts) dupCount[`${a.filename}|${a.size}`] = (dupCount[`${a.filename}|${a.size}`] || 0) + 1;
    const dupTotal = atts.filter((a) => dupCount[`${a.filename}|${a.size}`] > 1).length;
    if (dupTotal) showToast(`⚠️ 這家展商有 ${dupTotal} 個附件疑似重複上傳（同名同大小），已在清單標示`);
    // Tier 2 深度處理過的 PDF：算出每份來源 PDF 已經產生了幾張頁面截圖
    const tier2CountByPdf = {};
    for (const a of atts) if (a.source_pdf_id) tier2CountByPdf[a.source_pdf_id] = (tier2CountByPdf[a.source_pdf_id] || 0) + 1;
    const renderAttNote = (a) => {
      const url = fileUrl(a.key);
      const docName = (a.filename || "").toLowerCase();
      const fileIcon = isPdfAtt(a) ? "📕"
        : docName.endsWith(".docx") ? "📘" : docName.endsWith(".xlsx") ? "📊" : docName.endsWith(".pptx") ? "📙"
          : isNativeDocAtt(a) ? "📄" : "📎";
      let preview = `<a href="${url}" target="_blank" rel="noopener" class="directory-link">${fileIcon} ${esc(a.filename)}</a>`;
      if ((a.mime || "").startsWith("image/")) {
        preview = `<img class="att-thumb" src="${url}" alt="${esc(a.filename)}" loading="lazy" data-lightbox="${url}" />`;
      } else if ((a.mime || "").startsWith("audio/")) {
        preview = `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
      } else if ((a.mime || "").startsWith("video/")) {
        preview = `<video controls preload="none" src="${url}" class="att-video"></video>`;
      }
      const isAudio = (a.mime || "").startsWith("audio/");
      const isImage = (a.mime || "").startsWith("image/");
      const canOcr = isImage || isPdfAtt(a) || isNativeDocAtt(a); // PDF 型錄走 toMarkdown，docx/xlsx/pptx/純文字直接解出文字
      // AI 整理區塊預設收合，只露一行狀態（附件一多頁面才不會被文字撐爆），點狀態展開全文與操作
      const aiFold = (summary, body) =>
        `<details class="att-ai"><summary>${summary}</summary><div class="att-ai-body">${body}</div></details>`;
      const transcriptBlock = !isAudio || !TRANSCRIBE_ENABLED ? "" : a.transcript
        ? aiFold(`📝 已整理｜${esc(clipText(a.transcript, 40))}`,
            `<p class="att-transcript">📝 ${esc(a.transcript)} <a href="#" data-act="edit-transcript" class="att-transcribe-btn">編輯</a> <a href="#" data-act="transcribe" class="att-transcribe-btn skip-link" title="重新跑 AI 辨識並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
        : a.transcribed_at === "skipped"
          ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" data-act="transcribe" class="att-transcribe-btn">還是要辨識</a></p>`)
          : a.transcribed_at
            ? aiFold(`📝 已整理（無語音內容）`, `<p class="att-transcript">辨識過，沒有語音內容 <a href="#" data-act="transcribe" class="att-transcribe-btn">重新辨識</a></p>`)
            : aiFold(`⏳ 未整理`, `<a href="#" data-act="transcribe" class="att-transcribe-btn">轉文字</a> <a href="#" data-act="skip-transcribe" class="att-transcribe-btn skip-link" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`);
      const ocrBlock = !canOcr || !TRANSCRIBE_ENABLED ? "" : a.ocr_text
        ? aiFold(`🔍 已整理｜${esc(clipText(a.ocr_text, 40))}`,
            `<p class="att-transcript">🔍 ${esc(clipText(a.ocr_text, 600))} <a href="#" data-act="edit-ocr" class="att-transcribe-btn">編輯</a> <a href="#" data-act="ocr" class="att-transcribe-btn skip-link" title="重新跑 AI 擷取並覆蓋現有文字（會花額度）——結果亂掉時用">重抄</a></p>`)
        : a.ocr_at === "skipped"
          ? aiFold(`🚫 不整理`, `<p class="att-transcript skipped">已設為不整理 <a href="#" data-act="ocr" class="att-transcribe-btn">還是要擷取</a></p>`)
          : a.ocr_at
            ? aiFold(`🔍 已整理（沒有文字內容）`, `<p class="att-transcript">擷取過，沒有文字內容 <a href="#" data-act="ocr" class="att-transcribe-btn">重新擷取</a></p>`)
            : aiFold(`⏳ 未整理`, `<a href="#" data-act="ocr" class="att-transcribe-btn">🔍 擷取文字</a> <a href="#" data-act="skip-ocr" class="att-transcribe-btn skip-link" title="標成不整理：不呼叫 AI、不佔待整理數，之後可反悔">略過</a>`);
      const catRow = !isImage ? "" : `<div class="att-cat-row">${ATT_CATEGORIES.map((c) =>
        `<span class="cat-chip ${a.category === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</span>`
      ).join("")}</div>`;
      const dupBadge = dupCount[`${a.filename}|${a.size}`] > 1 ? `<span class="dup-badge">⚠️ 疑似重複</span>` : "";
      // Tier 2 深度處理：只給 PDF，手動觸發，絕不自動全庫跑（見 DATA-MODEL.md）
      const tier2Count = tier2CountByPdf[a.id] || 0;
      const tier2Block = !isPdfAtt(a) || !TRANSCRIBE_ENABLED ? "" : tier2Count
        ? `<p class="att-tier2">🔬 已深度處理（${tier2Count} 頁截圖，在附件清單裡） <a href="#" data-act="tier2" data-id="${a.id}" class="att-transcribe-btn skip-link">重新處理</a></p>`
        : `<p class="att-tier2"><a href="#" data-act="tier2" data-id="${a.id}" class="att-transcribe-btn" title="把這份 PDF 逐頁轉成圖片並跑 AI 辨識，補齊一般擷取抓不到的圖形化排版/圖表內容。手動觸發、只處理這一份，較耗時間與額度">🔬 深度處理（逐頁轉圖辨識）</a></p>`;
      return `<div class="note" data-id="${a.id}" data-caption="${esc(a.caption || "")}" data-transcript="${esc(a.transcript || "")}" data-ocr="${esc(a.ocr_text || "")}">
        <div class="note-meta"><strong>${esc(a.author)}</strong> · ${esc(a.created_at)} · ${(a.size / 1024 / 1024).toFixed(1)}MB ${dupBadge}
          <span class="note-actions"><a href="#" data-act="cap-att">${a.caption ? "編輯說明" : "加說明"}</a> <a href="#" data-act="del-att">刪除</a></span>
        </div>
        ${preview}
        ${catRow}
        ${ocrBlock}
        ${transcriptBlock}
        ${tier2Block}
        ${a.caption ? `<div class="att-caption">${esc(a.caption)}</div>` : ""}
      </div>`;
    };
    // 照片依分類分組收合，避免無窮捲動；未分類的照片維持攤平在最底下，逼自己去分類
    const images = atts.filter((a) => (a.mime || "").startsWith("image/"));
    const others = atts.filter((a) => !(a.mime || "").startsWith("image/"));
    const byCat = {};
    ATT_CATEGORIES.forEach((c) => { byCat[c] = []; });
    const uncategorized = [];
    images.forEach((a) => {
      if (a.category && byCat[a.category]) byCat[a.category].push(a);
      else uncategorized.push(a);
    });
    const othersHtml = others.map(renderAttNote).join("");
    const groupsHtml = ATT_CATEGORIES.map((c) => {
      const items = byCat[c];
      if (!items.length) return "";
      return `<details class="att-cat-group"><summary>${esc(c)}（${items.length}）</summary><div class="att-cat-group-items">${items.map(renderAttNote).join("")}</div></details>`;
    }).join("");
    const uncatHtml = !uncategorized.length ? "" : `
      <div class="att-uncat-heading">未分類照片（${uncategorized.length}）－點照片下方標籤整理</div>
      ${uncategorized.map(renderAttNote).join("")}`;
    wrap.innerHTML = pendingHtml + othersHtml + groupsHtml + uncatHtml;
    wrap.querySelectorAll(".cat-chip").forEach((chip) => {
      chip.onclick = () => {
        const note = chip.closest(".note");
        const attId = note.dataset.id;
        const wasOn = chip.classList.contains("on");
        const category = wasOn ? "" : chip.dataset.cat;
        // 先在畫面上立刻切換，不等網路、不整批重新整理，避免點分類時畫面頓一下、捲動位置跑掉
        note.querySelectorAll(".cat-chip").forEach((c) => c.classList.toggle("on", c === chip && !wasOn));
        api(`/attachments/${attId}`, {
          method: "PUT",
          body: JSON.stringify({ category, author: me() }),
        }).catch((err) => {
          showToast("分類失敗：" + err.message);
          note.querySelectorAll(".cat-chip").forEach((c) => c.classList.toggle("on", c === chip && wasOn));
        });
      };
    });
    wrap.querySelectorAll('a[data-act="transcribe"]').forEach((a) => {
      a.onclick = async (ev) => {
        ev.preventDefault();
        const attId = a.closest(".note").dataset.id;
        a.textContent = "轉錄中…";
        try {
          await api(`/attachments/${attId}/transcribe`, { method: "POST", body: JSON.stringify({ author: me() }) });
          loadAttachments(id);
        } catch (err) {
          a.textContent = "轉文字失敗，點一下再試";
          showToast(err.message);
        }
      };
    });
    // 「略過」＝標成不整理（不呼叫 AI），待整理數與批次都會跳過；可從「還是要辨識/擷取」反悔
    wrap.querySelectorAll('a[data-act="skip-transcribe"], a[data-act="skip-ocr"]').forEach((a) => {
      a.onclick = async (ev) => {
        ev.preventDefault();
        const attId = a.closest(".note").dataset.id;
        const field = a.dataset.act === "skip-transcribe" ? "skip_transcribe" : "skip_ocr";
        try {
          await api(`/attachments/${attId}`, { method: "PUT", body: JSON.stringify({ [field]: true, author: me() }) });
          loadAttachments(id); loadHistory(id);
        } catch (err) { showToast("設定失敗：" + err.message); }
      };
    });
    wrap.querySelectorAll('a[data-act="edit-transcript"]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const noteEl = a.closest(".note");
        const attId = noteEl.dataset.id;
        openEditModal({
          title: "修改轉文字稿（AI 轉得不準的地方直接改成正確內容）",
          value: noteEl.dataset.transcript || "",
          onSave: async (text) => {
            await api(`/attachments/${attId}`, { method: "PUT", body: JSON.stringify({ transcript: text, author: me() }) });
            loadAttachments(id); loadHistory(id);
          },
        });
      };
    });
    wrap.querySelectorAll('a[data-act="ocr"]').forEach((a) => {
      a.onclick = async (ev) => {
        ev.preventDefault();
        const attId = a.closest(".note").dataset.id;
        a.textContent = "擷取中…（約 10–20 秒）";
        try {
          await api(`/attachments/${attId}/ocr`, { method: "POST", body: JSON.stringify({ author: me() }) });
          loadAttachments(id); loadHistory(id);
          loadSearchTexts(); // 新抄出的文字馬上進搜尋範圍
        } catch (err) {
          a.textContent = "🔍 擷取失敗，點一下再試";
          showToast(err.message);
        }
      };
    });
    wrap.querySelectorAll('a[data-act="edit-ocr"]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const noteEl = a.closest(".note");
        const attId = noteEl.dataset.id;
        openEditModal({
          title: "修改擷取文字（AI 抄錯的地方直接改成正確內容，改完的文字一樣可以被搜尋）",
          value: noteEl.dataset.ocr || "",
          onSave: async (text) => {
            await api(`/attachments/${attId}`, { method: "PUT", body: JSON.stringify({ ocr_text: text, author: me() }) });
            loadAttachments(id); loadHistory(id); loadSearchTexts();
          },
        });
      };
    });
    wrap.querySelectorAll('a[data-act="del-att"]').forEach((a) => {
      a.onclick = async (ev) => {
        ev.preventDefault();
        const attId = a.closest(".note").dataset.id;
        if (!confirm("確定刪除這個附件？")) return;
        try {
          await api(`/attachments/${attId}?author=${encodeURIComponent(me())}`, { method: "DELETE" });
          loadAttachments(id); loadHistory(id);
        } catch (err) { showToast("刪除失敗：" + err.message); }
      };
    });
    wrap.querySelectorAll('a[data-act="cap-att"]').forEach((a) => {
      a.onclick = async (ev) => {
        ev.preventDefault();
        const noteEl = a.closest(".note");
        const caption = prompt("這個檔案的說明：", noteEl.dataset.caption || "");
        if (caption === null) return;
        try {
          await api(`/attachments/${noteEl.dataset.id}`, {
            method: "PUT",
            body: JSON.stringify({ caption: caption.trim(), author: me() }),
          });
          loadAttachments(id); loadHistory(id);
        } catch (err) { showToast("儲存失敗：" + err.message); }
      };
    });
    wrap.querySelectorAll("[data-lightbox]").forEach((img) => {
      img.onclick = () => openLightbox(img.dataset.lightbox);
    });
    // Tier 2 深度處理：手動觸發，一次只處理使用者點的這一份 PDF
    wrap.querySelectorAll('a[data-act="tier2"]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const pdfAtt = atts.find((x) => String(x.id) === a.dataset.id);
        if (!pdfAtt) return;
        if (tier2CountByPdf[pdfAtt.id] && !confirm(`這份 PDF 已經深度處理過（${tier2CountByPdf[pdfAtt.id]} 頁），要重新處理一次嗎？會再產生一組新的頁面截圖。`)) return;
        deepProcessPdf(id, pdfAtt, a);
      };
    });
  } catch {
    // 沒網路：至少把存在手機的待同步照片/錄音顯示出來，不是空白一片
    const countEl = $("d-att-count");
    if (countEl) countEl.textContent = pendingFiles.length ? `（${pendingFiles.length}）` : "";
    updatePendingBadge([]);
    wrap.innerHTML = pendingHtml;
  }
}

// 相片改在原頁面內開全螢幕看大圖（不再開新分頁）——原本用 target="_blank"
// 開新分頁在 PWA 獨立視窗模式下等於跳出 App，而且新分頁沒有「返回」可用，
// 只能手動切分頁，體感上像「回不去」。改成頁內 lightbox，點一下／按 ✕ 就關閉。
function openLightbox(url) {
  $("lightbox-img").src = url;
  $("lightbox-overlay").classList.add("open");
}
function closeLightbox() {
  $("lightbox-overlay").classList.remove("open");
  $("lightbox-img").src = "";
}

async function loadHistory(id) {
  const wrap = $("d-history");
  if (!wrap) return;
  try {
    const rows = await api(`/history?exhibitor_id=${id}`);
    wrap.innerHTML = rows.length
      ? rows.map((h) => `<div class="hist-row">${esc(h.created_at)}｜<strong>${esc(h.author)}</strong>｜${esc(h.action)}｜${esc(h.detail)}</div>`).join("")
      : '<p class="sub">尚無歷程。</p>';
  } catch { wrap.innerHTML = ""; }
}

function closeDetail() {
  if (activeRecording) activeRecording.recorder.stop();
  $("detail-overlay").classList.remove("open");
  unlockBodyScroll();
  CURRENT_ID = null;
  clearShareParam();
}

// 分享連結：網址加 ?ex=展商id，同事點開直接跳到那家廠商的詳情頁——
// 用 replaceState 而非 pushState，避免瀏覽器「上一頁」在詳情間堆一堆歷史紀錄
function shareUrlFor(id) {
  const url = new URL(location.href);
  url.searchParams.set("ex", id);
  return url.toString();
}
function setShareParam(id) {
  const url = new URL(location.href);
  url.searchParams.set("ex", id);
  history.replaceState(null, "", url);
}
function clearShareParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has("ex")) return;
  url.searchParams.delete("ex");
  history.replaceState(null, "", url);
}

// ---------- 團隊動態 ----------
async function openActivity() {
  if (!API_OK) { showToast("共筆後端未連線"); return; }
  $("activity-overlay").classList.add("open");
  const wrap = $("activity-list");
  wrap.innerHTML = "載入中...";
  try {
    const rows = await api("/history");
    if (!rows.length) {
      wrap.innerHTML = '<p class="sub">還沒有任何動態，開始標記狀態或寫紀錄吧。</p>';
      return;
    }
    const exMap = {};
    for (const e of EXHIBITORS) exMap[e.id] = e;
    wrap.innerHTML = rows.map((h) => {
      // exhibitor_id 是 null 的是論壇議程動態（見 logHistory(db, null, ...)），沒有對應展商可點開
      if (!h.exhibitor_id) {
        return `<div class="activity-row">
          <span class="act-time">${esc(h.created_at)}</span>
          <strong>${esc(h.author)}</strong>｜${esc(h.action)}｜<span class="act-ex">🗣 論壇議程</span>
          <div class="act-detail">${esc(h.detail)}</div>
        </div>`;
      }
      const ex = exMap[h.exhibitor_id];
      return `<div class="activity-row" data-ex="${esc(h.exhibitor_id)}">
        <span class="act-time">${esc(h.created_at)}</span>
        <strong>${esc(h.author)}</strong>｜${esc(h.action)}｜<span class="act-ex">${esc(ex ? ex.name_zh : h.exhibitor_id)}</span>
        <div class="act-detail">${esc(h.detail)}</div>
      </div>`;
    }).join("");
    wrap.querySelectorAll(".activity-row[data-ex]").forEach((row) => {
      row.onclick = () => {
        $("activity-overlay").classList.remove("open");
        openDetail(row.dataset.ex);
      };
    });
  } catch (err) {
    wrap.innerHTML = `<p class="sub">載入失敗：${esc(err.message)}</p>`;
  }
}

// ---------- 六天行程總覽（資料在 config.js 的 TRIP_DAYS，依內部行程表）----------
// 純前端渲染、不打 API，離線一樣看得到。每一天的會談／拜訪對象只要有 ex（展商 id），
// 就直接連回該展商的詳情頁——現場才不用先回清單搜尋一次才能寫紀錄。
function itinItemHtml(item) {
  const ex = item.ex ? EXHIBITORS.find((e) => e.id === item.ex) : null;
  const time = item.time ? `<span class="itin-time">${esc(item.time)}</span>` : `<span class="itin-time itin-time-empty">—</span>`;
  const meta = [
    item.booth ? `<span class="itin-booth">${esc(item.booth)}</span>` : "",
    item.sub ? `<span>${esc(item.sub)}</span>` : "",
    item.addr ? `<span>📍 ${esc(item.addr)}</span>` : "",
    item.contact ? `<span>☎️ ${esc(item.contact)}</span>` : "",
  ].filter(Boolean).join("");
  return `<div class="itin-item">
    ${time}
    <div class="itin-body">
      <div class="itin-title"><span class="itin-icon">${item.icon || "•"}</span>${esc(item.title)}</div>
      ${meta ? `<div class="itin-meta">${meta}</div>` : ""}
      ${item.warn ? `<div class="itin-warn">⚠️ ${esc(item.warn)}</div>` : ""}
      ${ex ? `<a href="#" class="itin-link" data-ex="${esc(ex.id)}">開啟展商頁寫紀錄 →</a>` : ""}
    </div>
  </div>`;
}

function itinHalfHtml(label, items) {
  if (!items || !items.length) return "";
  return `<div class="itin-half">
    <div class="itin-half-label">${label}</div>
    ${items.map(itinItemHtml).join("")}
  </div>`;
}

function renderItinerary() {
  const wrap = $("itinerary-list");
  if (!wrap) return;
  const today = new Date().toLocaleDateString("sv");
  const previousOpen = new Map([...wrap.querySelectorAll(".itin-day[data-itin-date]")]
    .map((day) => [day.dataset.itinDate, day.open]));

  wrap.innerHTML = TRIP_DAYS.map((d, i) => {
    const isToday = d.date === today;
    const shuttle = (d.shuttle || []).length ? `
      <div class="itin-shuttle">
        <div class="itin-half-label">🚐 宜蘭包車接駁</div>
        <table class="itin-shuttle-table">
          <tbody>
            ${d.shuttle.map((s) => `<tr><td class="itin-time">${esc(s.time)}</td><td class="itin-who">${esc(s.who)}</td><td>${esc(s.at)}</td></tr>`).join("")}
          </tbody>
        </table>
        ${d.shuttleNote ? `<div class="itin-shuttle-note">${esc(d.shuttleNote)}</div>` : ""}
      </div>` : "";

    // 看展日多給兩個捷徑：直接跳論壇議程、跳自己的分派清單
    const shortcuts = d.kind === "expo" ? `
      <div class="itin-shortcuts">
        <a href="#" class="itin-shortcut" data-go="agenda">🗣 今日論壇議程</a>
        <a href="#" class="itin-shortcut" data-go="assigned">📌 我的分派清單</a>
      </div>` : "";

    // 六天首次進入一律收合；使用者展開後，頁面重算時保留當下狀態。
    // details/summary 可用鍵盤操作，也保留瀏覽器原生語意。
    const open = previousOpen.has(d.date) ? previousOpen.get(d.date) : false;
    return `<details class="itin-day itin-${esc(d.kind)}${isToday ? " itin-today" : ""}" data-itin-date="${esc(d.date)}"${open ? " open" : ""}>
      <summary class="itin-day-summary">
        <span class="itin-day-head">
          <span class="itin-daynum">Day ${i + 1}</span>
          <span class="itin-date">${esc(d.label)}<span class="itin-weekday">（${esc(d.weekday)}）</span></span>
          <span class="itin-kind">${esc(d.kindLabel)}</span>
          ${isToday ? '<span class="itin-today-tag">今天</span>' : ""}
          <span class="itin-toggle" aria-hidden="true">
            <span class="itin-toggle-open">收合</span>
            <span class="itin-toggle-closed">展開</span>
            <span class="itin-toggle-arrow">⌄</span>
          </span>
        </span>
        <span class="itin-headline">${esc(d.headline)}</span>
      </summary>
      <div class="itin-day-content">
        ${shuttle}
        <div class="itin-halves">
          ${itinHalfHtml("上午", d.am)}
          ${itinHalfHtml("下午", d.pm)}
        </div>
        ${shortcuts}
        <footer class="itin-foot">
          <span>🏨 ${esc(d.stay)}</span>
          <span>🚗 ${esc(d.transit)}</span>
        </footer>
      </div>
    </details>`;
  }).join("");

  wrap.querySelectorAll(".itin-link[data-ex]").forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); openDetail(a.dataset.ex); };
  });
  wrap.querySelectorAll(".itin-shortcut[data-go]").forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); setView(a.dataset.go); };
  });
}

// ---------- 參訪前報告（主體＝七人實際指派的廠商）----------
// 「選了哪些廠商」只認共筆狀態的 assignee；不能再用職掌關鍵字命中的數百家
// 候選廠商代替。STATE 在連線時來自 D1，離線時來自手機快照，所以不新增 API、
// 不改資料表，也不破壞展場離線閱讀。
function prepAssignedExhibitors(name) {
  return EXHIBITORS
    .filter((e) => isSameName(getState(e.id).assignee, name))
    .sort((a, b) => {
      const byBooth = (a.booth_no || "").localeCompare(b.booth_no || "");
      return byBooth || (a.name_zh || a.name_en || "").localeCompare(b.name_zh || b.name_en || "");
    });
}

function prepQuestionsFor(exhibitorId) {
  const saved = (notesCache()[exhibitorId] || []).filter((n) => n.type === "想詢問的問題");
  const pending = getPending().filter((n) => n.exhibitor_id === exhibitorId && n.type === "想詢問的問題");
  return [...saved, ...pending];
}

// 報告卡片只摘出非「代問」的團隊 Note；代問已經有自己的黃色區塊，重複顯示會
// 把真正的拜訪線索淹沒。保留最近兩則、每則擷取第一段精華，完整內容仍可點廠商查看。
// notesCache 與 getPending 分別涵蓋已同步快照及手機待同步紀錄，斷網時也不漏掉剛寫的 Note。
function prepNoteExcerpt(content, limit = 120) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + "…";
}

function prepNoteHighlightsFor(exhibitorId) {
  const isHighlight = (n) => n.type !== "想詢問的問題" && String(n.content || "").trim();
  const saved = (notesCache()[exhibitorId] || []).filter(isHighlight);
  const pending = getPending().filter((n) => n.exhibitor_id === exhibitorId && isHighlight(n));
  return [...saved, ...pending]
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

// 四階段圖卡只用系統裡的「本人留言／個人補充、訴求欄、觀展目標、
// 已選廠商資料」歸納。不再以職稱模板替某人生出需求，也不把他人留言
// 算到負責人名下。只靠選商資料命中時，畫面會明示「依選商推定」。
const PREP_DEMAND_CATALOG = [
  {
    code: "needle-source",
    label: "活檢針內／外針第二來源",
    keywords: ["活檢針", "檢體針", "穿刺針", "内/外针", "內/外針", "內外針", "内外针", "biopsy needle"],
    demand: "找活檢針內／外針第二來源，比較自製能力、規格、價格與法規證據。",
    landing: "取得規格／報價／法規文件與樣品，排入第二來源試樣及承認。",
  },
  {
    code: "luer-inspection",
    label: "Luer／針具檢測設備",
    keywords: ["luer", "魯爾", "鲁尔", "80369", "9626", "7864", "圓錐接頭", "圆锥接头", "綜合測試儀", "综合测试仪"],
    demand: "評估 Luer／針具檢測設備，確認 ISO 80369、9626、7864 的適用性、測項與價格。",
    landing: "帶實際樣品試測，完成測項／法規／精度／報價比較與設備驗收表。",
  },
  {
    code: "coating-liquid",
    label: "披膜液供應商",
    keywords: ["披膜液", "塗層液", "涂层液", "親水披膜", "親水塗層", "亲水涂层", "hydrophilic coating"],
    demand: "檢索披膜液供應商，索取樣品、配方規格、檢驗方法與法規文件。",
    landing: "用我方基材安排小量試塗，以摩擦、附著、耐久與滅菌後性能建立准入門檻。",
  },
  {
    code: "coating-service",
    label: "Parylene／管內鍍層代工",
    keywords: ["派瑞林", "派拉綸", "parylene", "管內鍍層", "管内镀层", "鍍層技術", "镀层技术", "塗層代工", "涂层代工"],
    demand: "尋找 Parylene／管內鍍層代工廠，確認可做基材、內徑、膜厚、均勻性與驗證能力。",
    landing: "選定實際管件試鍍，取得膜厚／均勻性／附著力數據後再決定代工承認。",
  },
  {
    code: "catheter-material",
    label: "導管材料／管材來源",
    keywords: ["管材", "pebax", "peek", "ptfe", "fep", "tpu", "矽膠管", "硅胶管", "多腔管", "聚醯亞胺", "聚酰亚胺", "導管原料", "管材擠出"],
    demand: "補齊導管材料／管材來源，確認材料、公差、MOQ、交期與量產經驗。",
    landing: "取得材料證書、尺寸能力與樣管，依實測結果建立候選供應清單。",
  },
  {
    code: "catheter-structure",
    label: "編織／繞簧／共擠導管",
    keywords: ["編織管", "编织管", "編織機", "编织机", "繞簧", "绕簧", "鞘管", "多層共擠", "多层共挤", "多腔導管", "負壓抽吸鞘管", "扁狀線絲", "扁状线丝"],
    demand: "確認編織、繞簧、共擠與抽吸鞘管的結構能力及尺寸上限。",
    landing: "取得結構樣品、線材／節距／壁厚公差與性能報告，排出打樣驗證路徑。",
  },
  {
    code: "catheter-cdmo",
    label: "導管 CDMO／組裝代工",
    keywords: ["cdmo", "oem", "bom", "成品組裝", "成品组装", "自行組裝", "自行组装", "導管代工", "定製導管"],
    demand: "評估導管 CDMO／組裝代工，確認從 BOM、打樣、組裝、檢測到量產的邊界。",
    landing: "用一項實際產品拆解圖面、材料、治具、驗證與報價責任，形成打樣計畫。",
  },
  {
    code: "process-equipment",
    label: "球囊／導管製程設備",
    keywords: ["球囊成形機", "球囊成型機", "球囊拉伸機", "摺葉機", "fluter", "wrapper", "reflow", "tip forming", "heat forming", "尖端成形", "擠出設備", "挤出设备", "擠出生產線", "挤出生产线", "繞簧機", "编织机", "球囊焊接機"],
    demand: "評估球囊／導管製程設備，確認參數窗口、公差、換模、備品與售後支援。",
    landing: "帶我方規格實機試做，留下參數、節拍、良率、報價及 IQ／OQ／PQ 驗收條件。",
  },
  {
    code: "automated-inspection",
    label: "CCD／自動化檢驗",
    keywords: ["ccd", "視覺檢測", "视觉检测", "ai 檢測", "ai檢測", "測漏", "漏氣", "漏气", "拉力檢測", "扭矩檢測", "尺寸監測", "自動檢測", "vision inspection"],
    demand: "導入 CCD／自動化檢驗，涵蓋尺寸、外觀、漏氣、拉力或扭矩並保留可追溯數據。",
    landing: "帶良品／缺陷品試測，依檢出率、誤判率、GR&R 與資料介面定義驗收。",
  },
  {
    code: "sterilization-testing",
    label: "EO／法規檢測驗證",
    keywords: ["eo", "環氧乙烷", "環氧乙烷", "滅菌", "灭菌", "sterilization", "無菌檢驗", "无菌检验", "生物相容", "第三方檢測", "第三方检测", "cnas", "cma", "安規測試", "醫療器械註冊"],
    demand: "確認 EO／法規檢測驗證範圍，補齊方法、允收標準、資質與正式報告。",
    landing: "依產品列出滅菌前後關鍵測項與文件缺口，確認委外報價、樣品數及時程。",
  },
  {
    code: "assembly-automation",
    label: "自動組裝／產線整合",
    keywords: ["全自動", "自動組裝", "自动组装", "自動化生產線", "自动化生产线", "上下料", "自動上料", "自动上料", "產線整合", "生产线", "機器人", "机器人"],
    demand: "評估自動組裝／產線整合，確認節拍、上下料、換線、良率與現有工站介接。",
    landing: "以我方產品試跑 cycle time／UPH，完成人力、治具、維護、交期與回收期比較。",
  },
];

const PREP_STRATEGY_ORDER = ["灝翰", "長儒", "宗銘", "政哲", "昌毅", "帛辰", "柏宏"];
const PREP_PRODUCTION_MEMBERS = new Set(["昌毅", "帛辰", "柏宏"]);

function prepAllNotesFor(exhibitorId) {
  const saved = notesCache()[exhibitorId] || [];
  const pending = getPending().filter((n) => n.exhibitor_id === exhibitorId);
  return [...saved, ...pending].filter((n) => String(n.content || "").trim());
}

function prepMemberNotesFor(memberName, exhibitorId) {
  return prepAllNotesFor(exhibitorId).filter((n) => isSameName(n.author, memberName));
}

function prepDemandMatchesText(topic, text) {
  const source = String(text || "").toLowerCase();
  return !!source && topic.keywords.some((keyword) => {
    const needle = keyword.toLowerCase();
    // EO、CMA、BOM 這類短縮寫不能用單純 includes，否則英文公司名中的
    // 連續字母也可能被誤判。純英數關鍵字改用字界比對。
    if (/^[a-z0-9]+$/.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(source);
    }
    return source.includes(needle);
  });
}

function prepVendorProfileText(vendor) {
  const cat = CAT_MAP[vendor.category];
  return [
    vendor.name_zh,
    vendor.name_en,
    vendor.description,
    ...(vendor.products || []),
    cat ? cat.name_zh : "",
    cat ? cat.name_en : "",
  ].filter(Boolean).join(" ");
}

function prepVisitDemandText(state) {
  const visit = state.visit_record || {};
  return [visit.solves, visit.note, visit.diff, visit.next_step].filter(Boolean).join(" ");
}

function prepDemandEvidenceFor(memberName, vendor, topic) {
  const state = getState(vendor.id);
  const memberNotes = prepMemberNotesFor(memberName, vendor.id)
    .filter((note) => prepDemandMatchesText(topic, `${note.type || ""} ${note.content || ""}`));
  const supplement = String((PREP_NOTES[memberName] || {}).content || "").trim();
  const supplementMatch = prepDemandMatchesText(topic, supplement);
  const visitText = prepVisitDemandText(state);
  const visitMatch = prepDemandMatchesText(topic, visitText);
  const vendorMatch = prepDemandMatchesText(topic, prepVendorProfileText(vendor));
  const goalTags = state.goal_tags || [];
  // 個人補充是「全人」的需求說明，不能因此把名下所有廠商都硬連到
  // 同一訴求；只在該廠商自身資料／訴求欄／本人留言也有關聯時才加強。
  const supplementSupportsVendor = supplementMatch && (memberNotes.length || visitMatch || vendorMatch);

  if (!memberNotes.length && !visitMatch && !vendorMatch) return null;
  const source = memberNotes.length || supplementSupportsVendor
    ? "direct"
    : visitMatch ? "stated" : "inferred";
  return { vendor, topic, memberNotes, supplementMatch: supplementSupportsVendor, supplement, visitMatch, visitText, vendorMatch, goalTags, source };
}

function prepEvidenceLabel(evidences) {
  if (evidences.some((e) => e.memberNotes.length || e.supplementMatch)) return "本人留言";
  if (evidences.some((e) => e.visitMatch)) return "訴求欄";
  return "依選商推定";
}

function prepEvidenceExcerpt(evidences) {
  const note = evidences.flatMap((e) => e.memberNotes).find((n) => String(n.content || "").trim());
  if (note) return prepNoteExcerpt(note.content, 92);
  const supplement = evidences.find((e) => e.supplementMatch)?.supplement;
  if (supplement) return prepNoteExcerpt(supplement, 92);
  const visit = evidences.find((e) => e.visitMatch)?.visitText;
  if (visit) return prepNoteExcerpt(visit, 92);
  const names = evidences.slice(0, 2).map((e) => e.vendor.name_zh || e.vendor.name_en).filter(Boolean);
  return `依已選廠商「${names.join("、")}」的產品資料推定，現場需再確認。`;
}

function prepMemberDemandAnalysis(memberName, vendors) {
  const demands = PREP_DEMAND_CATALOG.map((topic) => {
    const evidences = vendors
      .map((vendor) => prepDemandEvidenceFor(memberName, vendor, topic))
      .filter(Boolean);
    if (!evidences.length) return null;
    return {
      topic,
      evidences,
      source: evidences.some((e) => e.source === "direct")
        ? "direct" : evidences.some((e) => e.source === "stated") ? "stated" : "inferred",
      sourceLabel: prepEvidenceLabel(evidences),
      excerpt: prepEvidenceExcerpt(evidences),
    };
  }).filter(Boolean);

  const rankedVendors = vendors.map((vendor) => {
    const matches = demands
      .map((demand) => ({ demand, evidence: demand.evidences.find((e) => e.vendor.id === vendor.id) }))
      .filter((item) => item.evidence);
    return { vendor, matches };
  }).sort((a, b) => b.matches.length - a.matches.length ||
    (a.vendor.booth_no || "").localeCompare(b.vendor.booth_no || ""));

  return { demands, rankedVendors };
}

function prepDemandHtml(memberName, vendor) {
  const matches = PREP_DEMAND_CATALOG
    .map((topic) => prepDemandEvidenceFor(memberName, vendor, topic))
    .filter(Boolean);
  if (!matches.length) {
    return `<span class="prep-rd prep-rd-pending">
      <span class="prep-rd-title">選商目的待補</span>
      <span>已指派給 ${esc(memberName)}，但本人留言、訴求欄與廠商資料尚無法歸類。</span>
    </span>`;
  }
  return `<span class="prep-rd prep-rd-match">
    <span class="prep-rd-title">需求對應</span>
    <span class="prep-rd-topics">${matches.map((item) => `<span>${esc(item.topic.label)}</span>`).join("")}</span>
    <span class="prep-rd-basis"><strong>來源：</strong>${esc(matches.some((item) => item.memberNotes.length || item.supplementMatch) ? "本人留言／個人補充" : matches.some((item) => item.visitMatch) ? "訴求欄" : "依選商推定")}</span>
  </span>`;
}

function prepStrategySlideHtml(memberName, vendors, index) {
  const profile = MEMBER_PROFILES.find((p) => p.name === memberName);
  if (!profile) return "";
  const { demands, rankedVendors } = prepMemberDemandAnalysis(memberName, vendors);
  const isProduction = PREP_PRODUCTION_MEMBERS.has(memberName);
  const mapLabel = isProduction ? "生產問題" : "研發策略地圖";
  const directCount = demands.filter((d) => d.source !== "inferred").length;
  const inferredCount = demands.filter((d) => d.source === "inferred").length;

  return `<article class="prep-strategy-slide" data-strategy-member="${esc(memberName)}">
    <header class="prep-slide-head">
      <span class="prep-slide-no">${String(index + 1).padStart(2, "0")}</span>
      <span class="prep-slide-person">
        <strong>${esc(memberName)}</strong>
        <span>${esc(profile.duty || "")}</span>
      </span>
      <span class="prep-slide-role${inferredCount && !directCount ? " is-inferred" : ""}">${esc(isProduction ? "生產單位" : "研發單位")}</span>
    </header>
    <p class="prep-slide-mission">依系統內的本人留言、訴求欄、觀展目標與 ${vendors.length} 家已選廠商歸納。${inferredCount ? `其中 ${inferredCount} 項只有選商證據，已標示為推定。` : ""}</p>
    <div class="prep-slide-flow" aria-label="${esc(memberName)}的需求落地路徑">
      <section class="prep-slide-step prep-slide-map">
        <span class="prep-step-label"><i>1</i>${esc(mapLabel)}</span>
        ${demands.length ? `<div class="prep-slide-topics">
          ${demands.map((demand) => `<span class="is-${demand.source}"><strong>${demand.source === "inferred" ? "推定" : "有據"}</strong>${esc(demand.topic.label)}</span>`).join("")}
        </div>` : `<p class="prep-slide-empty">已有選商，但系統資料尚不足以歸納問題。</p>`}
      </section>
      <section class="prep-slide-step prep-slide-demands">
        <span class="prep-step-label"><i>2</i>訴求 <small>${demands.length} 項</small></span>
        ${demands.length ? `<div class="prep-slide-demand-list">${demands.map((demand) => `
          <div class="prep-slide-demand is-${demand.source}">
            <strong>${esc(demand.topic.demand)}</strong>
            <span><em>${esc(demand.sourceLabel)}</em>${esc(demand.excerpt)}</span>
          </div>`).join("")}</div>` : `<p class="prep-slide-empty">請在廠商留言或訴求欄補上「要解決什麼」。</p>`}
      </section>
      <section class="prep-slide-step prep-slide-vendors">
        <span class="prep-step-label"><i>3</i>對應廠商 <small>已選 ${rankedVendors.length} 家</small></span>
        ${rankedVendors.length ? `<div class="prep-slide-vendor-list">
          ${rankedVendors.map(({ vendor, matches }) => `<button type="button" class="${matches.length ? "is-matched" : "is-pending"}" data-strategy-exhibitor="${esc(vendor.id)}">
            <span><strong>${esc(vendor.name_zh || vendor.name_en)}</strong><small>${esc([vendor.booth_no || "攤位未定", ...(getState(vendor.id).goal_tags || [])].join(" · "))}</small></span>
            <em>${matches.length ? matches.map((item) => item.demand.topic.label).join(" · ") : "選商目的待補"}</em>
          </button>`).join("")}
        </div>` : `<p class="prep-slide-empty">尚未選擇／指派廠商。</p>`}
      </section>
      <section class="prep-slide-step prep-slide-landing">
        <span class="prep-step-label"><i>4</i>落地</span>
        ${demands.length ? `<div class="prep-slide-landing-list">${demands.map((demand) => `<div><strong>${esc(demand.topic.label)}</strong><span>${esc(demand.topic.landing)}</span></div>`).join("")}</div>` : `<p class="prep-slide-empty">先補選商目的與驗收條件，再排定後續行動。</p>`}
      </section>
    </div>
  </article>`;
}

function prepVendorHtml(e, memberName = "") {
  const st = getState(e.id);
  const cat = CAT_MAP[e.category];
  const products = (e.products || []).slice(0, 2);
  const focus = (st.goal_tags || []).length
    ? st.goal_tags
    : products.length ? products : [cat ? cat.name_zh : "尚未填拜訪目標"];
  const questions = prepQuestionsFor(e.id);
  const noteHighlights = prepNoteHighlightsFor(e.id);
  const visibleHighlights = noteHighlights.slice(0, 2);
  const statusColor = STATUS_COLORS[st.status] || "#8a8a82";

  return `<button type="button" class="prep-vendor" data-exhibitor="${esc(e.id)}">
    <span class="prep-vendor-main">
      <span class="prep-vendor-name">${esc(e.name_zh || e.name_en)}</span>
      <span class="prep-vendor-booth">${esc(e.booth_no || "攤位未定")}</span>
    </span>
    <span class="prep-vendor-meta">${esc([cat ? cat.name_zh : "", e.country].filter(Boolean).join(" · "))}</span>
    <span class="prep-vendor-focus">${focus.map((t) => `<span>${esc(t)}</span>`).join("")}</span>
    ${prepDemandHtml(memberName, e)}
    <span class="prep-vendor-foot">
      <span class="prep-status"><i style="background:${statusColor}"></i>${esc(st.status || "未排定")}</span>
      <span class="prep-note-count${noteHighlights.length ? " has-notes" : ""}">${noteHighlights.length ? `📝 ${noteHighlights.length} 則 Note` : "尚無 Note"}</span>
      <span class="prep-question-count${questions.length ? " has-questions" : ""}">${questions.length ? `🙋 ${questions.length} 則代問` : "尚無代問"}</span>
    </span>
    ${visibleHighlights.length ? `<span class="prep-vendor-highlights">
      <span class="prep-highlights-title">Note 精華${noteHighlights.length > visibleHighlights.length ? `（最近 ${visibleHighlights.length}／${noteHighlights.length} 則）` : ""}</span>
      ${visibleHighlights.map((n) => `<span class="prep-highlight"><strong>${esc(n.author || "匿名")} · ${esc(n.type || "現場紀錄")}</strong><span>${esc(prepNoteExcerpt(n.content))}</span></span>`).join("")}
    </span>` : ""}
    ${questions.length ? `<span class="prep-vendor-questions">${questions.map((q) => `<span><strong>${esc(q.author || "匿名")}</strong>：${esc(q.content)}</span>`).join("")}</span>` : ""}
  </button>`;
}

let PREP_NOTES = {};   // member -> { content, updated_by, updated_at }

function renderPrepReport() {
  const wrap = $("prep-list");
  const overview = $("prep-overview");
  const strategyDeck = $("prep-strategy-deck");
  if (!wrap || !overview || !strategyDeck) return;
  const drafts = {};
  for (const name of PREP_ORDER) {
    const ta = $(`prep-ta-${name}`);
    if (ta) drafts[name] = ta.value;
  }

  const groups = PREP_ORDER.map((name) => ({ name, vendors: prepAssignedExhibitors(name) }));
  const total = groups.reduce((sum, g) => sum + g.vendors.length, 0);
  const questions = groups.reduce((sum, g) => sum + g.vendors.reduce((n, e) => n + prepQuestionsFor(e.id).length, 0), 0);
  const unassignedMembers = groups.filter((g) => !g.vendors.length).length;

  overview.innerHTML = `
    <div class="prep-kpis">
      <div><strong>${total}</strong><span>已選／已指派廠商</span></div>
      <div><strong>${questions}</strong><span>現場代問</span></div>
      <div><strong>${unassignedMembers}</strong><span>尚無廠商的人</span></div>
    </div>
    <div class="prep-member-nav" aria-label="跳到同事">
      ${groups.map((g) => `<button type="button" data-prep-jump="${esc(g.name)}" class="${isSameName(g.name, me()) ? "is-me" : ""}">${esc(g.name)} <strong>${g.vendors.length}</strong></button>`).join("")}
    </div>`;

  const strategyGroups = PREP_STRATEGY_ORDER.map((name) => ({
    name,
    vendors: groups.find((group) => group.name === name)?.vendors || [],
  }));
  strategyDeck.innerHTML = `
    <header class="prep-deck-head">
      <span>七人策略拜訪投影片</span>
      <strong>研發策略地圖／生產問題 → 訴求 → 廠商 → 落地</strong>
    </header>
    <div class="prep-deck-list">
      ${strategyGroups.map(({ name, vendors }, index) => prepStrategySlideHtml(name, vendors, index)).join("")}
    </div>`;

  wrap.innerHTML = groups.map(({ name, vendors }) => {
    const profile = MEMBER_PROFILES.find((p) => p.name === name);
    const rep = PREP_REPORT[name] || {};
    if (!profile) return "";
    const isMe = isSameName(name, me());
    const statusCounts = STATUS_OPTIONS
      .map((status) => [status, vendors.filter((e) => getState(e.id).status === status).length])
      .filter(([, count]) => count);

    return `<article class="prep-card${rep.strategic ? " prep-strategic" : ""}${isMe ? " prep-me" : ""}" data-member="${esc(name)}">
      <header class="prep-head">
        <span class="prep-name">${esc(name)}</span>
        <span class="prep-duty">${esc(profile.duty || "")}</span>
        <span class="prep-count">${vendors.length} 家</span>
        ${isMe ? '<span class="prep-me-tag">你</span>' : ""}
        ${rep.strategic ? '<span class="prep-strategic-tag">五年技術地圖</span>' : ""}
      </header>
      ${statusCounts.length ? `<div class="prep-status-summary">${statusCounts.map(([status, count]) => `<span><i style="background:${STATUS_COLORS[status] || "#8a8a82"}"></i>${esc(status)} ${count}</span>`).join("")}</div>` : ""}
      <div class="prep-vendors">
        ${vendors.length ? vendors.map((e) => prepVendorHtml(e, name)).join("") : `<div class="prep-empty"><strong>尚未選擇／指派廠商</strong><span>請先到展商詳情設定「負責同事」，這裡會自動更新。</span></div>`}
      </div>
      ${(rep.points || []).length || (rep.asks || []).length ? `
        <details class="prep-guidance">
          <summary>${rep.theme ? esc(rep.theme) : "依職掌整理的共通檢查清單"}</summary>
          ${rep.summary ? `<p class="prep-summary">${esc(rep.summary)}</p>` : ""}
          ${(rep.points || []).length ? `<div class="prep-block"><div class="prep-block-label">共通觀察重點</div><ul>${rep.points.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          ${(rep.asks || []).length ? `<div class="prep-block prep-asks"><div class="prep-block-label">共通必問</div><ul>${rep.asks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          ${rep.related ? `<div class="prep-related">🔗 ${esc(rep.related)}</div>` : ""}
        </details>` : ""}
      <div class="prep-note" data-note="${esc(name)}">
        <div class="prep-block-label">個人補充（可編輯，全隊看得到）</div>
        <textarea class="prep-textarea" id="prep-ta-${esc(name)}" placeholder="出發前想補的重點、要帶的樣品、想額外確認的事…"></textarea>
        <div class="prep-note-foot">
          <span class="prep-note-meta" id="prep-meta-${esc(name)}"></span>
          <button class="btn small primary prep-save" data-save="${esc(name)}">儲存</button>
        </div>
      </div>
    </article>`;
  }).join("");

  overview.querySelectorAll("[data-prep-jump]").forEach((btn) => {
    btn.onclick = () => [...wrap.querySelectorAll("[data-member]")]
      .find((card) => card.dataset.member === btn.dataset.prepJump)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  wrap.querySelectorAll("[data-exhibitor]").forEach((btn) => {
    btn.onclick = () => openDetail(btn.dataset.exhibitor);
  });
  strategyDeck.querySelectorAll("[data-strategy-exhibitor]").forEach((btn) => {
    btn.onclick = () => openDetail(btn.dataset.strategyExhibitor);
  });
  wrap.querySelectorAll(".prep-save").forEach((btn) => {
    btn.onclick = () => savePrepNote(btn.dataset.save, btn);
  });
  paintPrepNotes();
  for (const [name, content] of Object.entries(drafts)) {
    const ta = $(`prep-ta-${name}`);
    if (ta) ta.value = content;
  }
}

// 把已載入的內容填回各人的欄位（渲染與載入分開，離線也能先用快取顯示）
function paintPrepNotes() {
  for (const name of PREP_ORDER) {
    const ta = $(`prep-ta-${name}`);
    const meta = $(`prep-meta-${name}`);
    if (!ta) continue;
    const n = PREP_NOTES[name] || {};
    if (document.activeElement !== ta) ta.value = n.content || "";
    if (meta) meta.textContent = n.updated_at ? `最後編輯：${n.updated_by || "匿名"}　${n.updated_at}` : "尚未填寫";
  }
}

async function loadPrepNotes() {
  // 先用快取畫上去，連線後再以伺服器版本覆蓋——離線也看得到別人寫過的內容
  try { PREP_NOTES = JSON.parse(localStorage.getItem("medtec_prep_notes") || "{}"); } catch { PREP_NOTES = {}; }
  paintPrepNotes();
  if (!API_OK) return;
  try {
    PREP_NOTES = await api("/prep-notes");
    localStorage.setItem("medtec_prep_notes", JSON.stringify(PREP_NOTES));
    paintPrepNotes();
  } catch { /* 讀不到就維持快取內容，不擋畫面 */ }
}

async function savePrepNote(name, btn) {
  if (!API_OK) { showToast("共筆後端未連線，無法儲存"); return; }
  const ta = $(`prep-ta-${name}`);
  if (!ta) return;
  btn.disabled = true;
  try {
    const saved = await api(`/prep-notes/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content: ta.value, author: me() || "匿名" }),
    });
    PREP_NOTES[name] = { content: saved.content, updated_by: saved.updated_by, updated_at: saved.updated_at };
    localStorage.setItem("medtec_prep_notes", JSON.stringify(PREP_NOTES));
    paintPrepNotes();
    showToast(`已儲存 ${name} 的補充`);
  } catch (err) {
    showToast("儲存失敗：" + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 論壇議程（Medtec 官網研討會場次，跟展商無關的獨立實體）----------
// 場次熱度只反映主辦方公開內容密度，不是市場機會，所以不跟展商自動比對，
// 團隊只手動填負責人／狀態／必問／技術鏈，屬性沿用展商共筆的欄位風格。
async function loadSessions() {
  const wrap = $("agenda-list");
  if (!API_OK) { wrap.innerHTML = '<p class="sub">共筆後端未連線，無法載入議程。</p>'; return; }
  wrap.innerHTML = "載入中...";
  try {
    SESSIONS = await api("/sessions");
    renderAgenda();
  } catch (err) {
    wrap.innerHTML = `<p class="sub">載入失敗：${esc(err.message)}</p>`;
  }
}

function sessionCardHtml(s) {
  const color = SESSION_STATUS_COLORS[s.status] || "#8a8a82";
  return `<div class="agenda-card" data-session="${esc(s.id)}">
    <div class="agenda-card-head">
      <span class="agenda-place">${s.time_slot ? esc(s.time_slot) + "｜" : "時段未定｜"}${esc(s.hall || "")}${s.room ? " · " + esc(s.room) : ""}</span>
      ${s.priority ? `<span class="agenda-priority">優先 ${esc(s.priority)}</span>` : ""}
    </div>
    <h3>${esc(s.title)}</h3>
    ${s.reason ? `<p class="agenda-reason"><strong>關注原因：</strong>${esc(s.reason)}</p>` : ""}
    ${s.outline ? `<p class="agenda-outline">${esc(s.outline)}</p>` : ""}
    <div class="agenda-meta-row">
      ${s.track ? `<span class="badge">${esc(s.track)}</span>` : ""}
      <span class="badge status" style="background:${color};border-color:${color};color:#fff;">${esc(s.status)}</span>
      <span class="badge">${s.owner ? "👤 " + esc(s.owner) : "未指派"}</span>
    </div>
  </div>`;
}

function renderAgenda() {
  const wrap = $("agenda-list");
  if (!SESSIONS.length) { wrap.innerHTML = '<p class="sub">目前沒有議程資料。</p>'; return; }
  const byDate = {};
  for (const s of SESSIONS) (byDate[s.date || "日期未定"] = byDate[s.date || "日期未定"] || []).push(s);
  const dates = Object.keys(byDate).sort();
  wrap.innerHTML = dates.map((d) => `
    <div class="agenda-day">${esc(d)}</div>
    <div class="agenda-grid">${byDate[d].map(sessionCardHtml).join("")}</div>
  `).join("");
  wrap.querySelectorAll("[data-session]").forEach((card) => {
    card.onclick = () => openSessionDetail(card.dataset.session);
  });
}

async function openSessionDetail(id) {
  const s = SESSIONS.find((x) => x.id === id);
  if (!s) return;

  const modal = $("session-modal");
  modal.innerHTML = `
    <div class="modal-close-float"><button class="btn small ghost" id="s-close">✕</button></div>
    <div class="detail-head">
      <h2>${esc(s.title)}</h2>
      <p class="sub">${esc(s.date || "")}｜${s.time_slot ? esc(s.time_slot) : "時段未定"}｜${esc(s.hall || "")}${s.room ? " · " + esc(s.room) : ""}${s.source_url ? ` ｜<a class="directory-link" href="${esc(s.source_url)}" target="_blank" rel="noopener">官網頁面</a>` : ""}</p>
      ${s.reason ? `<p class="sub">關注原因：${esc(s.reason)}</p>` : ""}
      ${s.outline ? `<p class="detail-desc">${esc(s.outline)}</p>` : ""}
    </div>

    ${API_OK ? `
    <hr/>
    <div class="state-grid" id="s-state-grid">
      <div>
        <label>狀態</label>
        <div class="check-row" id="s-status">
          ${SESSION_STATUS_OPTIONS.map((v) => `<label class="check-chip ${v === s.status ? "on" : ""}"><input type="radio" name="s-status-${id}" value="${esc(v)}" ${v === s.status ? "checked" : ""}>${esc(v)}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>負責同事</label>
        <div class="check-row" id="s-owner">
          <label class="check-chip ${!s.owner ? "on" : ""}"><input type="radio" name="s-owner-${id}" value="" ${!s.owner ? "checked" : ""}>未指派</label>
          ${(() => {
            const names = assignableNames();
            const current = s.owner ? (names.find((n) => isSameName(n, s.owner)) || s.owner) : "";
            if (current && !names.includes(current)) names.push(current);
            return names.map((n) => `<label class="check-chip ${n === current ? "on" : ""}"><input type="radio" name="s-owner-${id}" value="${esc(n)}" ${n === current ? "checked" : ""}>${esc(n)}</label>`).join("");
          })()}
        </div>
      </div>
      <div>
        <label>時段（官方議程手冊確認後填入，例：14:00–15:30）</label>
        <input id="s-time-slot" value="${esc(s.time_slot || "")}" placeholder="尚未公布時段" />
      </div>
      <div>
        <label>技術鏈／主題</label>
        <input id="s-track" value="${esc(s.track || "")}" placeholder="材料／製程與製造／品質與法規／R&D／全球市場" />
      </div>
      <div>
        <label>優先序（1 最優先，可留空）</label>
        <input id="s-priority" type="number" min="1" value="${s.priority ?? ""}" />
      </div>
      <div>
        <label>三個必問（一行一題，到現場要問的問題）</label>
        <textarea id="s-must-ask" placeholder="例：貴單位的證據能不能同時用在美歐中三個市場？">${esc((s.must_ask || []).join("\n"))}</textarea>
      </div>
    </div>
    <div class="modal-actions"><button class="btn primary small" id="s-save-fields">儲存欄位</button></div>

    <hr/>
    <h3 class="section-title">現場紀錄（任何人可新增）</h3>
    <div class="note-form">
      <select id="s-note-type">
        ${SESSION_NOTE_TYPES.map((t) => `<option>${t}</option>`).join("")}
      </select>
      <textarea id="s-note-content" placeholder="這場聽到什麼？跟邦特哪個機會有關？Go／Hold／Stop 判定？"></textarea>
      <button class="btn primary small" id="s-note-add">送出</button>
    </div>
    <div id="s-notes" class="notes-list">載入中...</div>
    ` : `<p class="sub">共筆後端未連線，僅供瀏覽。</p>`}
  `;

  $("session-overlay").classList.add("open");
  lockBodyScroll();
  $("s-close").onclick = closeSessionDetail;

  if (!API_OK) return;

  bindRadioRow("s-status", (value) => saveSessionField(id, { status: value }));
  bindRadioRow("s-owner", (value) => saveSessionField(id, { owner: value }));
  $("s-save-fields").onclick = () => {
    const mustAsk = $("s-must-ask").value.split("\n").map((x) => x.trim()).filter(Boolean);
    saveSessionField(id, {
      time_slot: $("s-time-slot").value.trim(),
      track: $("s-track").value.trim(),
      priority: $("s-priority").value,
      must_ask: mustAsk,
    });
  };
  $("s-note-add").onclick = () => addSessionNote(id);
  loadSessionNotes(id);
}

function closeSessionDetail() {
  $("session-overlay").classList.remove("open");
  unlockBodyScroll();
}

async function saveSessionField(id, patch) {
  if (!API_OK) { showToast("共筆後端未連線，無法儲存"); return; }
  try {
    const updated = await api(`/sessions/${id}`, { method: "PUT", body: JSON.stringify({ ...patch, author: me() }) });
    const idx = SESSIONS.findIndex((x) => x.id === id);
    if (idx >= 0) SESSIONS[idx] = updated;
    renderAgenda();
    showToast("已儲存");
  } catch (err) {
    showToast("儲存失敗：" + err.message);
  }
}

async function loadSessionNotes(id) {
  const wrap = $("s-notes");
  try {
    const notes = await api(`/session-notes?session_id=${id}`);
    if (!notes.length) { wrap.innerHTML = '<p class="sub">還沒有任何紀錄，寫下第一筆吧。</p>'; return; }
    wrap.innerHTML = notes.map((n) => `
      <div class="note" data-id="${n.id}">
        <div class="note-meta">
          <strong>${esc(n.author)}</strong> · ${esc(n.type)} · ${esc(n.created_at)}${n.updated_at ? "（已編輯）" : ""}
          <span class="note-actions">
            <a href="#" data-act="edit">編輯</a> <a href="#" data-act="del">刪除</a>
          </span>
        </div>
        <div class="note-content">${esc(n.content)}</div>
      </div>`).join("");
    wrap.querySelectorAll("a[data-act]").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const noteEl = a.closest(".note");
        const noteId = noteEl.dataset.id;
        if (a.dataset.act === "edit") editSessionNote(id, noteId, noteEl.querySelector(".note-content").textContent);
        else deleteSessionNote(id, noteId);
      };
    });
  } catch (err) {
    wrap.innerHTML = `<p class="sub">（線上紀錄暫時無法載入）</p>`;
  }
}

async function addSessionNote(id) {
  const content = $("s-note-content").value.trim();
  if (!content) { showToast("請先輸入內容"); return; }
  try {
    await api("/session-notes", {
      method: "POST",
      body: JSON.stringify({ session_id: id, author: me(), type: $("s-note-type").value, content }),
    });
    $("s-note-content").value = "";
    loadSessionNotes(id);
    showToast("已新增紀錄");
  } catch (err) {
    showToast("新增失敗：" + err.message);
  }
}

async function editSessionNote(sessionId, noteId, oldContent) {
  const content = prompt("修改紀錄內容：", oldContent);
  if (content === null || !content.trim()) return;
  try {
    await api(`/session-notes/${noteId}`, { method: "PUT", body: JSON.stringify({ content: content.trim(), author: me() }) });
    loadSessionNotes(sessionId);
    showToast("已修改");
  } catch (err) {
    showToast("修改失敗：" + err.message);
  }
}

async function deleteSessionNote(sessionId, noteId) {
  if (!confirm("確定刪除這筆紀錄？")) return;
  try {
    await api(`/session-notes/${noteId}?author=${encodeURIComponent(me())}`, { method: "DELETE" });
    loadSessionNotes(sessionId);
  } catch (err) {
    showToast("刪除失敗：" + err.message);
  }
}

// ---------- 匯出 ----------
async function exportCsv() {
  if (!API_OK) { showToast("共筆後端未連線，無法匯出"); return; }
  try {
    const res = await fetch("/api/export.csv", { headers: { "x-team-pin": pin() } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "medtec_team_records.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { showToast("匯出失敗：" + err.message); }
}

// ---------- toast ----------
function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

init();
