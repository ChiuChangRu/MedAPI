// ===== Medtec China 2026 展商作戰地圖（團隊版）=====

let EXHIBITORS = [];
let CATEGORIES = [];
let CAT_MAP = {};
let LINE_MATCHES = {};      // lineId -> Set(exhibitorId)
let STATE = {};             // exhibitorId -> 共筆狀態
let MEMBERS = [];
let API_OK = false;
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

// ---------- 初始化 ----------
async function init() {
  const res = await fetch("data/exhibitors.json");
  const data = await res.json();
  EXHIBITORS = data.exhibitors;
  CATEGORIES = data.categories;
  for (const c of CATEGORIES) CAT_MAP[c.id] = c;

  $("event-sub").textContent = `團隊內部版 · ${data.event.dates} · ${data.event.venue_zh} · 共 ${EXHIBITORS.length} 家展商`;

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
  $("btn-export").onclick = exportCsv;
  $("assignee-filter").addEventListener("change", render);
  $("btn-activity").onclick = openActivity;
  $("activity-close").onclick = () => $("activity-overlay").classList.remove("open");
  $("activity-overlay").addEventListener("click", (e) => { if (e.target === $("activity-overlay")) $("activity-overlay").classList.remove("open"); });
  $("user-chip").onclick = () => { if (confirm("要切換使用者嗎？")) logout(); };
  $("btn-login").onclick = doLogin;
  $("login-overlay").addEventListener("click", (e) => e.stopPropagation());
  $("detail-overlay").addEventListener("click", (e) => { if (e.target === $("detail-overlay")) closeDetail(); });

  render();
  await connectBackend();
}

async function connectBackend() {
  try {
    MEMBERS = await api("/members");
    API_OK = true;
    $("offline-banner").style.display = "none";
    try { UPLOADS_ENABLED = (await api("/config")).uploads; } catch { UPLOADS_ENABLED = false; }
    if (!pin() && MEMBERS !== null) {
      // TEAM_PIN 未設定（開發模式）也需要選名字
    }
    if (!me()) { showLogin(); } else { document.body.classList.remove("locked"); $("user-chip").textContent = me(); renderRecommendBar(); }
    STATE = await api("/state");
    render();
  } catch (err) {
    if (String(err.message).includes("PIN")) { showLogin(); return; }
    API_OK = false;
    $("offline-banner").style.display = "block";
  }
}

// ---------- 登入 ----------
function showLogin() {
  document.body.classList.add("locked");
  $("login-overlay").classList.add("open");
  const deptSel = $("login-dept");
  deptSel.innerHTML = '<option value="">— 選擇單位 —</option>' +
    DEPT_PRESETS.map((d) => `<option value="${d.name}">${d.name}</option>`).join("");
  $("login-pin").value = pin();
  renderMemberChoices();
}

function renderMemberChoices() {
  const wrap = $("member-choices");
  wrap.innerHTML = "";
  // 預建團隊名單優先，其後是已登入過但不在名單上的人
  const extras = MEMBERS.filter((m) => !MEMBER_PROFILES.some((p) => p.name === m.name));
  const choices = [
    ...MEMBER_PROFILES.map((p) => ({ name: p.name, dept: p.duty })),
    ...extras.map((m) => ({ name: m.name, dept: m.dept })),
  ];
  for (const m of choices) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = m.name;
    chip.onclick = () => {
      $("login-name").value = m.name;
      const deptSel = $("login-dept");
      deptSel.value = [...deptSel.options].some((o) => o.value === m.dept) ? m.dept : "";
      wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    };
    wrap.appendChild(chip);
  }
}

async function doLogin() {
  const pinVal = $("login-pin").value.trim();
  const name = $("login-name").value.trim();
  const profile = MEMBER_PROFILES.find((p) => p.name === name);
  const dept = $("login-dept").value || (profile ? profile.duty : "");
  const errEl = $("login-error");
  errEl.style.display = "none";
  if (!name) { errEl.textContent = "請選擇或輸入你的名字"; errEl.style.display = "block"; return; }
  localStorage.setItem("medtec_pin", pinVal);
  try {
    MEMBERS = await api("/members", { method: "POST", body: JSON.stringify({ name, dept }) });
    localStorage.setItem("medtec_user", name);
    $("user-chip").textContent = name;
    renderRecommendBar();
    document.body.classList.remove("locked");
    $("login-overlay").classList.remove("open");
    API_OK = true;
    $("offline-banner").style.display = "none";
    STATE = await api("/state");
    render();
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
  const deptGrid = $("dept-grid");
  deptGrid.innerHTML = "";
  for (const d of DEPT_PRESETS) {
    const count = EXHIBITORS.filter((e) => deptMatch(d, e)).length;
    const card = document.createElement("div");
    card.className = "entry-card";
    card.dataset.dept = d.id;
    card.innerHTML = `<div class="entry-name">${d.name}</div><div class="entry-count">${count} 家</div>`;
    card.title = d.hint;
    card.onclick = () => applyDeptPreset(d.id);
    deptGrid.appendChild(card);
  }

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

function allMemberNames() {
  const names = MEMBER_PROFILES.map((p) => p.name);
  for (const m of MEMBERS) if (!names.includes(m.name)) names.push(m.name);
  return names;
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
  for (const n of allMemberNames()) {
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

// 我的清單：指派給我的廠商，依攤位排路線
function openMyList() {
  if (!me()) { showLogin(); return; }
  clearAll();
  $("assignee-filter").value = me();
  SORT_KEY = "booth"; SORT_DIR = 1;
  render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
  showToast(`我的清單：指派給 ${me()} 的廠商（依攤位排序）`);
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
  refreshEntryCards(); refreshChips(); refreshPresetBar(); refreshPocketBtn(); refreshTechChips(); render();
}

// ---------- 主列表 ----------
function getState(id) {
  return STATE[id] || { status: "未排定", assignee: "", dept_tags: [], collected: [], goal_tags: [], quals: [], post_class: "", pocket: false, note_count: 0 };
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
    if (assigneeF && st.assignee !== assigneeF) return false;
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
    (API_OK ? `｜已拜訪 ${kpi["已拜訪"]}・已排定 ${kpi["已排定"]}・需追蹤 ${kpi["需追蹤"]}｜口袋名單 ${pocketCount} 家` : "");

  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").style.display = list.length ? "none" : "block";
  if (list.length) grid.appendChild(renderTable(list));
}

// ---------- 列表（唯一檢視，欄位標題可排序）----------
function renderTable(list) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "listview";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of SORT_COLUMNS) {
    if (col.team && !API_OK) continue;
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
  for (const e of list) {
    const st = getState(e.id);
    const cat = CAT_MAP[e.category];
    const statusColor = STATUS_COLORS[st.status] || "#8a8a82";
    // 有任何團隊紀錄/分配 → 列的差異化顯示
    const hasData = Boolean(st.assignee || st.status !== "未排定" || st.note_count || st.pocket ||
      st.post_class || st.goal_tags.length || st.quals.length || st.collected.length || st.dept_tags.length);
    const tr = document.createElement("tr");
    if (hasData) tr.className = "has-data";
    tr.innerHTML = `
      <td><span class="row-star ${st.pocket ? "on" : ""}" title="口袋名單">${st.pocket ? "★" : "☆"}</span></td>
      <td class="co"><div class="zh">${KEY_VISIT_MAP[e.id] ? '<span class="badge visit">行程</span> ' : ""}${esc(e.name_zh)}${hasData ? ' <span class="data-dot" title="已有團隊紀錄"></span>' : ""}</div><div class="en">${esc(e.name_en || "")}</div></td>
      <td class="booth-cell">${esc(e.booth_no)}</td>
      <td class="col-cat">${esc(cat ? cat.name_zh : e.category)}</td>
      <td class="col-country">${esc(e.country)}</td>
      ${API_OK ? `
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function togglePocket(id) {
  if (!API_OK) { showToast("共筆後端未連線"); return; }
  const st = getState(id);
  try {
    const updated = await api(`/state/${id}`, {
      method: "PUT",
      body: JSON.stringify({ pocket: !st.pocket, author: me() }),
    });
    STATE[id] = { ...st, ...updated };
    render();
    if (CURRENT_ID === id) openDetail(id);
  } catch (err) { showToast("更新失敗：" + err.message); }
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

    ${API_OK ? `
    <hr/>
    <div class="state-grid">
      <div>
        <label>拜訪狀態</label>
        <select id="d-status">${STATUS_OPTIONS.map((s) => `<option ${s === st.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
      <div>
        <label>負責同事</label>
        <select id="d-assignee">
          <option value="">— 未指派 —</option>
          ${allMemberNames().map((n) => `<option ${n === st.assignee ? "selected" : ""}>${esc(n)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>部門標籤（誰想看）</label>
        <div class="check-row" id="d-dept-tags">
          ${DEPT_PRESETS.map((d) => `<label class="check-chip ${st.dept_tags.includes(d.name) ? "on" : ""}"><input type="checkbox" value="${d.name}" ${st.dept_tags.includes(d.name) ? "checked" : ""}/>${d.name}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>已索取資料</label>
        <div class="check-row" id="d-collected">
          ${COLLECTED_OPTIONS.map((c) => `<label class="check-chip ${st.collected.includes(c.id) ? "on" : ""}"><input type="checkbox" value="${c.id}" ${st.collected.includes(c.id) ? "checked" : ""}/>${c.label}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>觀展目標（為什麼看這家）</label>
        <div class="check-row" id="d-goal-tags">
          ${GOAL_OPTIONS.map((g) => `<label class="check-chip ${st.goal_tags.includes(g) ? "on" : ""}"><input type="checkbox" value="${esc(g)}" ${st.goal_tags.includes(g) ? "checked" : ""}/>${esc(g)}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>資質確認（現場詢問後勾選）</label>
        <div class="check-row" id="d-quals">
          ${QUAL_OPTIONS.map((q) => `<label class="check-chip ${st.quals.includes(q.id) ? "on" : ""}"><input type="checkbox" value="${q.id}" ${st.quals.includes(q.id) ? "checked" : ""}/>${q.label}</label>`).join("")}
        </div>
      </div>
      <div>
        <label>展後分類（回台彙整用）</label>
        <select id="d-post-class">
          <option value="">— 未分類 —</option>
          ${POST_CLASS_OPTIONS.map((p) => `<option ${p === st.post_class ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </div>
    </div>

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
    ` : `<p class="sub">共筆後端未連線，僅供瀏覽。</p>`}
  `;

  $("detail-overlay").classList.add("open");
  $("d-close").onclick = closeDetail;
  const star = $("d-star");
  if (star) star.onclick = () => togglePocket(id);

  if (!API_OK) return;

  $("d-status").onchange = () => saveState(id, { status: $("d-status").value });
  $("d-assignee").onchange = () => saveState(id, { assignee: $("d-assignee").value });
  bindCheckRow("d-dept-tags", (values) => saveState(id, { dept_tags: values }));
  bindCheckRow("d-collected", (values) => saveState(id, { collected: values }));
  bindCheckRow("d-goal-tags", (values) => saveState(id, { goal_tags: values }));
  bindCheckRow("d-quals", (values) => saveState(id, { quals: values }));
  $("d-post-class").onchange = () => saveState(id, { post_class: $("d-post-class").value });
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

async function saveState(id, patch) {
  try {
    const updated = await api(`/state/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...patch, author: me() }),
    });
    STATE[id] = { ...getState(id), ...updated };
    render();
    loadHistory(id);
    showToast("已儲存");
  } catch (err) { showToast("儲存失敗：" + err.message); }
}

async function loadNotes(id) {
  const wrap = $("d-notes");
  try {
    const notes = await api(`/notes?exhibitor_id=${id}`);
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
        if (a.dataset.act === "edit") editNote(id, noteId, noteEl.querySelector(".note-content").textContent);
        else deleteNote(id, noteId);
      };
    });
  } catch (err) {
    wrap.innerHTML = `<p class="sub">載入失敗：${esc(err.message)}</p>`;
  }
}

async function addNote(id) {
  const content = $("d-note-content").value.trim();
  if (!content) { showToast("請先輸入內容"); return; }
  try {
    await api("/notes", {
      method: "POST",
      body: JSON.stringify({ exhibitor_id: id, author: me(), type: $("d-note-type").value, content }),
    });
    $("d-note-content").value = "";
    const st = getState(id);
    STATE[id] = { ...st, note_count: (st.note_count || 0) + 1 };
    loadNotes(id); loadHistory(id); render();
    showToast("已新增紀錄");
  } catch (err) { showToast("新增失敗：" + err.message); }
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
