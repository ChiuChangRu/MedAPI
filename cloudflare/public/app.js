// ===== Medtec China 2026 展商作戰地圖（團隊版）=====

let EXHIBITORS = [];
let CATEGORIES = [];
let CAT_MAP = {};
let LINE_MATCHES = {};      // lineId -> Set(exhibitorId)
let STATE = {};             // exhibitorId -> 共筆狀態
let MEMBERS = [];
let API_OK = false;
let OFFLINE = false;        // 離線模式（用手機快取的資料瀏覽＋紀錄排隊待同步）
let UPLOADS_ENABLED = false;

// 篩選條件（單位、產品／科別兩個維度可交叉組合）
let ACTIVE_CATS = new Set();
let ACTIVE_LINE = "";
let ACTIVE_DEPT = "";
let POCKET_ONLY = false;
let VISIT_ONLY = false;
let KEY_VISIT_MAP = {};     // exhibitorId -> KEY_VISITS 項目

let CURRENT_ID = null;      // detail modal 顯示中的展商

const $ = (id) => document.getElementById(id);

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

let SYNCING = false;
async function syncPending() {
  if (SYNCING || !navigator.onLine) return;
  if (!getPending().length && !Object.keys(getPendingState()).length) return;
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
      if (CURRENT_ID) { loadNotes(CURRENT_ID); }
    } catch { /* 稍後由重新整理接手 */ }
  }
}

function updateOfflineBanner() {
  const banner = $("offline-banner");
  const pending = getPending().length + Object.keys(getPendingState()).length;
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
    el.innerHTML = `✈️ <strong>8/31（一）12:30 CI201</strong> 出發，還有 <strong>${days}</strong> 天` +
      (API_OK ? `｜任務分配進度：已指派 <strong>${assigned}</strong> 家（出發前完成分配，落地就能直接跑）` : "");
    el.style.display = "block";
  } else if (phase === "during") {
    const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD（當地時區，滬台同為 +8）
    const item = TRIP_PLAN.find((p) => p.date === today);
    if (item) {
      el.innerHTML = `📍 <strong>今日行程</strong>｜${esc(item.plan)}`;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  } else {
    el.style.display = "none"; // 回台後不再顯示
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

  $("event-sub").textContent = `團隊內部版 · ${data.event.dates} · ${data.event.venue_zh} · 共 ${EXHIBITORS.length} 家展商`;

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
  buildTechSearch();

  $("search").addEventListener("input", () => { refreshTechChips(); render(); });
  $("hall-filter").addEventListener("change", render);
  $("country-filter").addEventListener("change", render);
  $("status-filter").addEventListener("change", render);
  $("btn-pocket-filter").onclick = () => { POCKET_ONLY = !POCKET_ONLY; refreshPocketBtn(); render(); };
  $("btn-visit-filter").onclick = () => { VISIT_ONLY = !VISIT_ONLY; refreshPocketBtn(); render(); };
  $("btn-my-list").onclick = openMyList;
  $("btn-my-report").onclick = openMyReport;
  $("btn-clear").onclick = clearAll;
  document.querySelectorAll(".view-tab[data-view]").forEach((btn) => { btn.onclick = () => setView(btn.dataset.view); });
  $("btn-mylist-pdf").onclick = printMyList;
  $("btn-export").onclick = exportCsv;
  $("assignee-filter").addEventListener("change", render);
  $("btn-activity").onclick = openActivity;
  $("activity-close").onclick = () => $("activity-overlay").classList.remove("open");
  $("activity-overlay").addEventListener("click", (e) => { if (e.target === $("activity-overlay")) $("activity-overlay").classList.remove("open"); });
  $("user-chip").onclick = () => { if (confirm("要切換使用者嗎？")) logout(); };
  $("btn-login").onclick = doLogin;
  $("login-overlay").addEventListener("click", (e) => e.stopPropagation());
  $("detail-overlay").addEventListener("click", (e) => { if (e.target === $("detail-overlay")) closeDetail(); });

  // 離線測試切換按鈕
  $("btn-offline-toggle").onclick = () => {
    if (OFFLINE) { connectBackend(); } else { forceOffline(); }
  };

  // 點紅綠燈 → 離線備妥度檢查
  $("mode-light").onclick = showCacheReport;
  $("cache-close").onclick = () => $("cache-overlay").classList.remove("open");
  $("cache-overlay").addEventListener("click", (e) => { if (e.target === $("cache-overlay")) $("cache-overlay").classList.remove("open"); });

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
    autoMyList();
    showToast("行程期間：已自動切換離線版（按 🔄 重新連線可嘗試連網）");
  } else {
    await connectBackend();
  }
}

async function connectBackend() {
  try {
    MEMBERS = await api("/members");
    API_OK = true;
    OFFLINE = false;
    try { UPLOADS_ENABLED = (await api("/config")).uploads; } catch { UPLOADS_ENABLED = false; }
    if (!me()) { showLogin(); } else { document.body.classList.remove("locked"); $("user-chip").textContent = me(); renderRecommendBar(); }
    STATE = await api("/state");
    saveSnapshot();
    snapshotAllNotes(); // 順便把全隊筆記（含代問）快照到手機，離線看得到
    updateOfflineBanner();
    render();
    renderTaskSummary();
    autoMyList();
    syncPending();
  } catch (err) {
    if (String(err.message).includes("PIN")) { showLogin(); return; }
    // 網路不通：曾登入過就進離線模式（用手機快取的資料）
    API_OK = false;
    const snap = JSON.parse(localStorage.getItem("medtec_snapshot") || "{}");
    if (me() && snap.state) {
      OFFLINE = true;
      STATE = snap.state;
      MEMBERS = snap.members || [];
      document.body.classList.remove("locked");
      $("user-chip").textContent = me() + "（離線）";
      renderRecommendBar();
      render();
      renderTaskSummary();
      autoMyList();
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
    AUTO_LIST_DONE = false; // 剛登入，重新帶一次我的清單
    autoMyList();
    syncPending();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ---------- 產品別／科別關鍵字比對 ----------
function exhibitorText(e) {
  return [e.name_zh, e.name_en, e.description, ...(e.products || []), ...(e.tags || [])]
    .join(" ")
    .toLowerCase();
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
}

// 姓名模糊去重共用邏輯：別名表對應（振哲→政哲）＋ 全名/短名互相包含視為同一人
// （邱長儒＝長儒）。MEMBER_PROFILES 預建名單優先，決定顯示用的名字與單位。
// 唯一有風險的情況：兩個不同的人剛好一個名字是另一個的子字串（例如「凌」與「和凌」），
// 目前 8+1 人名單沒有這種情況，但若未來新增成員撞名，要改用別名表而非單純子字串比對。
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

function renderTaskSummary() {
  const wrap = $("task-summary");
  const tabs = $("view-tabs");
  const loggedIn = me() && (API_OK || OFFLINE);
  if (tabs) tabs.style.display = loggedIn ? "flex" : "none";
  if (!wrap) return;
  if (!loggedIn) { wrap.style.display = "none"; return; }
  const myStates = Object.values(STATE).filter((st) => isSameName(st.assignee, me()));
  const visited = myStates.filter((st) => st.status === "已拜訪").length;
  const pocket = Object.values(STATE).filter((st) => st.pocket).length;
  const myTotal = myStates.length;
  if (!myTotal && !pocket) { wrap.style.display = "none"; return; }
  let html = `<span class="recommend-label">📋 ${esc(me())} 的進度</span>`;
  if (myTotal) html += `<span class="task-stat">負責 <strong>${myTotal}</strong> 家</span>`;
  if (visited) html += `<span class="task-stat good">已拜訪 <strong>${visited}</strong> 家 ✓</span>`;
  if (pocket) html += `<span class="task-stat">★ 口袋名單 <strong>${pocket}</strong> 家（全隊）</span>`;
  html += `<span class="task-stat go-list">點我看名單 ▸</span>`;
  wrap.innerHTML = html;
  wrap.style.display = "flex";
  wrap.onclick = openMyList;
  wrap.title = "點擊顯示指派給我的廠商（依攤位排序）";
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
  refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

function refreshEntryCards() {
  document.querySelectorAll(".entry-card").forEach((c) => {
    c.classList.toggle("active", Boolean(
      (c.dataset.dept && c.dataset.dept === ACTIVE_DEPT) ||
      (c.dataset.line && c.dataset.line === ACTIVE_LINE)));
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

function buildTechSearch() {
  const wrap = $("tech-search");
  wrap.innerHTML = '<span class="recommend-label">技術快搜：</span>';
  for (const t of TECH_SEARCHES) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t.label;
    chip.onclick = () => {
      const search = $("search");
      const active = search.value.trim() === t.q;
      search.value = active ? "" : t.q;
      refreshTechChips();
      render();
    };
    chip.dataset.q = t.q;
    wrap.appendChild(chip);
  }
}

function refreshTechChips() {
  const current = $("search").value.trim();
  document.querySelectorAll("#tech-search .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.q === current);
  });
}

function refreshPocketBtn() {
  $("btn-pocket-filter").classList.toggle("primary", POCKET_ONLY);
  $("btn-visit-filter").classList.toggle("primary", VISIT_ONLY);
}

// 視圖切換：檢索清單／分派給我／我已完成拜訪
let CURRENT_VIEW = "search";
function setActiveViewTab(view) {
  CURRENT_VIEW = view;
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
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

function setView(view) {
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
  }
  setActiveViewTab(view);
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

// 我的清單：指派給我的廠商，依攤位排路線
function openMyList() {
  if (!me()) { showLogin(); return; }
  setView("assigned");
  showToast(`我的清單：指派給 ${me()} 的廠商（依攤位排序）`);
}

// 登入／開啟後自動帶入我的清單（有指派才套，僅套一次，不蓋掉使用中的篩選）
let AUTO_LIST_DONE = false;
function autoMyList() {
  if (AUTO_LIST_DONE || !me()) return;
  AUTO_LIST_DONE = true;
  const hasMine = Object.values(STATE).some((st) => isSameName(st.assignee, me()));
  setView(hasMine ? "assigned" : "search");
  if (hasMine) showToast(`已顯示你的名單（${me()}），可切上方頁籤看其他清單`);
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
    const visit = KEY_VISIT_MAP[e.id];
    const qs = (nmap[e.id] || []).filter((n) => n.type === "想詢問的問題");
    const header = g.key !== lastKey ? `<tr class="g"><td colspan="4">📍 ${esc(g.label)}</td></tr>` : "";
    lastKey = g.key;
    return header + `<tr>
      <td class="booth">${esc(e.booth_no)}</td>
      <td><strong>${esc(e.name_zh)}</strong><br/><span class="en">${esc(e.name_en || "")}</span>
        ${visit ? `<div class="visit">⭐ ${esc(visit.when)}${visit.contact ? "｜" + esc(visit.contact) : ""}</div>` : ""}
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
.visit{color:#a00d24;font-size:12px;margin-top:3px;}
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
  ACTIVE_CATS.clear(); ACTIVE_LINE = ""; ACTIVE_DEPT = ""; POCKET_ONLY = false; VISIT_ONLY = false;
  $("search").value = ""; $("hall-filter").value = ""; $("country-filter").value = ""; $("status-filter").value = "";
  $("assignee-filter").value = "";
  setActiveViewTab("search");
  refreshEntryCards(); refreshChips(); refreshPresetBar(); refreshPocketBtn(); refreshTechChips(); render();
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

  return EXHIBITORS.filter((e) => {
    if (ACTIVE_CATS.size && !ACTIVE_CATS.has(e.category)) return false;
    if (lineSet && !lineSet.has(e.id)) return false;
    if (dept && dept.keywords && !deptMatch(dept, e)) return false;
    if (hall && e.hall !== hall) return false;
    if (country && e.country !== country) return false;
    const st = getState(e.id);
    if (POCKET_ONLY && !st.pocket) return false;
    if (VISIT_ONLY && !KEY_VISIT_MAP[e.id]) return false;
    const assigneeF = $("assignee-filter").value;
    if (assigneeF && !isSameName(st.assignee, assigneeF)) return false; // 全名/短名視同一人，舊資料也對得上
    if (statusF && st.status !== statusF) return false;
    if (keywords.length) {
      const text = exhibitorText(e);
      // 交叉檢索：所有關鍵字都要命中（AND）
      if (!keywords.every((k) => text.includes(k))) return false;
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
    `共 ${EXHIBITORS.length} 家展商，符合條件 ${list.length} 家` +
    ((API_OK || OFFLINE) ? `｜已拜訪 ${kpi["已拜訪"]}・已排定 ${kpi["已排定"]}・需追蹤 ${kpi["需追蹤"]}｜口袋名單 ${pocketCount} 家` : "");

  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").style.display = list.length ? "none" : "block";
  if (list.length) grid.appendChild(renderTable(list));
  renderTripBanner();
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
      <td class="co"><div class="zh">${KEY_VISIT_MAP[e.id] ? '<span class="badge visit">行程</span> ' : ""}${esc(e.name_zh)}${hasData ? ' <span class="data-dot" title="已有團隊紀錄"></span>' : ""}${compBadge}</div><div class="en">${esc(e.name_en || "")}</div></td>
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
    <div class="detail-head">
      <div>
        <h2>${esc(e.name_zh)} <button class="star big ${st.pocket ? "on" : ""}" id="d-star">${st.pocket ? "★" : "☆"}</button></h2>
        <p class="sub">${esc(e.name_en || "")}｜${esc(cat ? cat.name_zh : "")}｜攤位 ${esc(e.booth_no)}｜${esc(e.country)}</p>
        <p class="sub link-row">
          ${e.website ? `<a class="directory-link" href="${e.website}" target="_blank" rel="noopener">公司官網</a>` : ""}
          ${(e.pdfs || []).map((p, i) => `<a class="directory-link" href="${p}" target="_blank" rel="noopener">型錄 PDF${e.pdfs.length > 1 ? " " + (i + 1) : ""}</a>`).join("")}
          ${e.directory_url ? `<a class="directory-link" href="${e.directory_url}" target="_blank" rel="noopener">官方展商頁</a>` : ""}
        </p>
        ${visit ? `<p class="sub visit-info"><strong>行程重點</strong>：${esc(visit.when)}${visit.contact ? `｜${esc(visit.contact)}` : ""}${visit.note ? `｜${esc(visit.note)}` : ""}</p>` : ""}
        ${lineHits.length ? `<p class="sub">產品／科別關聯：${lineHits.map((l) => l.name).join("、")}</p>` : ""}
      </div>
      <button class="btn small ghost" id="d-close">✕</button>
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
          ${(() => { const names = assignableNames(); if (st.assignee && !names.includes(st.assignee)) names.push(st.assignee); // 舊資料指派的名字仍要顯示
            return names.map((n) => `<label class="check-chip ${n === st.assignee ? "on" : ""}"><input type="radio" name="d-assignee-${id}" value="${esc(n)}" ${n === st.assignee ? "checked" : ""}>${esc(n)}</label>`).join(""); })()}
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
        <div><label>MOQ</label><input class="vr-input" id="d-vr-moq" placeholder="如 1000 pcs" value="${esc((st.visit_record||{}).moq||"")}" /></div>
        <div><label>交期</label><input class="vr-input" id="d-vr-lead" placeholder="如 4-6 週" value="${esc((st.visit_record||{}).lead_time||"")}" /></div>
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
        <button class="btn small primary" id="d-vr-save">儲存成果</button>
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
    <h3 class="section-title">附件（照片／錄音／影片）</h3>
    ${UPLOADS_ENABLED ? `
    <div class="upload-row">
      <label class="btn small">拍照／上傳檔案<input type="file" id="d-file" accept="image/*,video/*,audio/*" hidden /></label>
      <span id="d-upload-status" class="sub"></span>
    </div>` : `<p class="sub">檔案上傳尚未啟用（需先在 Cloudflare 建立 R2 bucket，設定方式見 cloudflare/README.md）。</p>`}
    <div id="d-attachments" class="notes-list"></div>

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
  $("d-close").onclick = closeDetail;
  const star = $("d-star");
  if (star) star.onclick = () => togglePocket(id);

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
        moq: $("d-vr-moq").value.trim(),
        lead_time: $("d-vr-lead").value.trim(),
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
    showToast("visit_record" in patch ? "拜訪成果已儲存" : "已儲存");
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

// ---------- 附件 ----------
function fileUrl(key) {
  return `/api/file/${encodeURIComponent(key)}?pin=${encodeURIComponent(pin())}`;
}

async function uploadFile(id, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = "";
  const status = $("d-upload-status");
  if (file.size > 50 * 1024 * 1024) { status.textContent = "檔案超過 50MB，長影片請縮短"; return; }
  status.textContent = `上傳中…（${(file.size / 1024 / 1024).toFixed(1)}MB）`;
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-team-pin": pin(),
        "x-exhibitor-id": id,
        "x-author": encodeURIComponent(me()),
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const uploaded = await res.json();
    status.textContent = "";
    showToast("已上傳");
    // 上傳完直接寫說明（可留空跳過，之後也能補）
    const caption = prompt("為這個檔案寫一段說明（可留空，之後也能補）：", "");
    if (caption && caption.trim()) {
      await api(`/attachments/${uploaded.id}`, {
        method: "PUT",
        body: JSON.stringify({ caption: caption.trim(), author: me() }),
      }).catch(() => {});
    }
    loadAttachments(id);
    loadHistory(id);
  } catch (err) {
    status.textContent = "上傳失敗：" + err.message;
  }
}

async function loadAttachments(id) {
  const wrap = $("d-attachments");
  if (!wrap) return;
  try {
    const atts = await api(`/attachments?exhibitor_id=${id}`);
    if (!atts.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = atts.map((a) => {
      const url = fileUrl(a.key);
      let preview = `<a href="${url}" target="_blank" rel="noopener" class="directory-link">${esc(a.filename)}</a>`;
      if ((a.mime || "").startsWith("image/")) {
        preview = `<a href="${url}" target="_blank" rel="noopener"><img class="att-thumb" src="${url}" alt="${esc(a.filename)}" loading="lazy" /></a>`;
      } else if ((a.mime || "").startsWith("audio/")) {
        preview = `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
      } else if ((a.mime || "").startsWith("video/")) {
        preview = `<video controls preload="none" src="${url}" class="att-video"></video>`;
      }
      return `<div class="note" data-id="${a.id}" data-caption="${esc(a.caption || "")}">
        <div class="note-meta"><strong>${esc(a.author)}</strong> · ${esc(a.created_at)} · ${(a.size / 1024 / 1024).toFixed(1)}MB
          <span class="note-actions"><a href="#" data-act="cap-att">${a.caption ? "編輯說明" : "加說明"}</a> <a href="#" data-act="del-att">刪除</a></span>
        </div>
        ${preview}
        ${a.caption ? `<div class="att-caption">${esc(a.caption)}</div>` : ""}
      </div>`;
    }).join("");
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
  } catch {
    wrap.innerHTML = "";
  }
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
  $("detail-overlay").classList.remove("open");
  CURRENT_ID = null;
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
      const ex = exMap[h.exhibitor_id];
      return `<div class="activity-row" data-ex="${esc(h.exhibitor_id)}">
        <span class="act-time">${esc(h.created_at)}</span>
        <strong>${esc(h.author)}</strong>｜${esc(h.action)}｜<span class="act-ex">${esc(ex ? ex.name_zh : h.exhibitor_id)}</span>
        <div class="act-detail">${esc(h.detail)}</div>
      </div>`;
    }).join("");
    wrap.querySelectorAll(".activity-row").forEach((row) => {
      row.onclick = () => {
        $("activity-overlay").classList.remove("open");
        openDetail(row.dataset.ex);
      };
    });
  } catch (err) {
    wrap.innerHTML = `<p class="sub">載入失敗：${esc(err.message)}</p>`;
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
