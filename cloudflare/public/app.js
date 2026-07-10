// ===== Medtec China 2026 展商作戰地圖（團隊版）=====

let EXHIBITORS = [];
let CATEGORIES = [];
let CAT_MAP = {};
let LINE_MATCHES = {};      // lineId -> Set(exhibitorId)
let SPEC_MATCHES = {};      // specId -> Set(exhibitorId)
let STATE = {};             // exhibitorId -> 共筆狀態
let MEMBERS = [];
let API_OK = false;

// 篩選條件（單位、產品別、科別三個維度可交叉組合）
let ACTIVE_CATS = new Set();
let ACTIVE_LINE = "";
let ACTIVE_DEPT = "";
let ACTIVE_SPEC = "";
let POCKET_ONLY = false;
let VISIT_ONLY = false;
let KEY_VISIT_MAP = {};     // exhibitorId -> KEY_VISITS 項目

let CURRENT_ID = null;      // detail modal 顯示中的展商
let VIEW = localStorage.getItem("medtec_view") || "cards";

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

  $("search").addEventListener("input", render);
  $("hall-filter").addEventListener("change", render);
  $("country-filter").addEventListener("change", render);
  $("status-filter").addEventListener("change", render);
  $("sort-select").addEventListener("change", render);
  $("btn-pocket-filter").onclick = () => { POCKET_ONLY = !POCKET_ONLY; refreshPocketBtn(); render(); };
  $("btn-visit-filter").onclick = () => { VISIT_ONLY = !VISIT_ONLY; refreshPocketBtn(); render(); };
  $("view-cards").onclick = () => setView("cards");
  $("view-table").onclick = () => setView("table");
  refreshViewToggle();
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
    if (!pin() && MEMBERS !== null) {
      // TEAM_PIN 未設定（開發模式）也需要選名字
    }
    if (!me()) { showLogin(); } else { $("user-chip").textContent = me(); renderRecommendBar(); }
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
    chip.textContent = m.dept ? `${m.name}（${m.dept}）` : m.name;
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
  for (const spec of HOSPITAL_SPECIALTIES) {
    const set = new Set();
    for (const e of EXHIBITORS) {
      const text = exhibitorText(e);
      if (spec.keywords.some((k) => text.includes(k.toLowerCase()))) set.add(e.id);
    }
    SPEC_MATCHES[spec.id] = set;
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

  const specGrid = $("spec-grid");
  specGrid.innerHTML = "";
  for (const spec of HOSPITAL_SPECIALTIES) {
    const count = SPEC_MATCHES[spec.id].size;
    const card = document.createElement("div");
    card.className = "entry-card";
    card.dataset.spec = spec.id;
    card.innerHTML = `<div class="entry-name">${spec.name}</div><div class="entry-count">${count} 家</div>`;
    card.title = `關鍵字：${spec.keywords.join("、")}`;
    card.onclick = () => applySpecPreset(spec.id);
    specGrid.appendChild(card);
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
    } else if (chip.k === "spec") {
      const s = HOSPITAL_SPECIALTIES.find((x) => x.id === chip.id);
      el.textContent = s.name;
      el.onclick = () => applySpecPreset(chip.id);
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

function applySpecPreset(specId) {
  ACTIVE_SPEC = ACTIVE_SPEC === specId ? "" : specId;
  refreshEntryCards(); refreshChips(); refreshPresetBar(); render();
  $("stats").scrollIntoView({ behavior: "smooth", block: "center" });
}

function refreshEntryCards() {
  document.querySelectorAll(".entry-card").forEach((c) => {
    c.classList.toggle("active", Boolean(
      (c.dataset.dept && c.dataset.dept === ACTIVE_DEPT) ||
      (c.dataset.line && c.dataset.line === ACTIVE_LINE) ||
      (c.dataset.spec && c.dataset.spec === ACTIVE_SPEC)));
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
    parts.push(`<strong>產品別｜${l.name}</strong>：${l.desc}（關鍵字「${l.keywords.join("、")}」自動比對）<button class="btn small ghost" onclick="applyLinePreset('${l.id}')">取消</button>`);
  }
  if (ACTIVE_SPEC) {
    const s = HOSPITAL_SPECIALTIES.find((x) => x.id === ACTIVE_SPEC);
    parts.push(`<strong>科別｜${s.name}</strong>（關鍵字「${s.keywords.join("、")}」自動比對）<button class="btn small ghost" onclick="applySpecPreset('${s.id}')">取消</button>`);
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

function refreshPocketBtn() {
  $("btn-pocket-filter").classList.toggle("primary", POCKET_ONLY);
  $("btn-visit-filter").classList.toggle("primary", VISIT_ONLY);
}

function setView(view) {
  VIEW = view;
  localStorage.setItem("medtec_view", view);
  refreshViewToggle();
  render();
}

function refreshViewToggle() {
  $("view-cards").classList.toggle("on", VIEW === "cards");
  $("view-table").classList.toggle("on", VIEW === "table");
}

function clearAll() {
  ACTIVE_CATS.clear(); ACTIVE_LINE = ""; ACTIVE_DEPT = ""; ACTIVE_SPEC = ""; POCKET_ONLY = false; VISIT_ONLY = false;
  $("search").value = ""; $("hall-filter").value = ""; $("country-filter").value = ""; $("status-filter").value = "";
  $("assignee-filter").value = "";
  $("sort-select").value = "default";
  refreshEntryCards(); refreshChips(); refreshPresetBar(); refreshPocketBtn(); render();
}

// ---------- 主列表 ----------
function getState(id) {
  return STATE[id] || { status: "未排定", assignee: "", dept_tags: [], collected: [], pocket: false, note_count: 0 };
}

function filtered() {
  const keywords = $("search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hall = $("hall-filter").value;
  const country = $("country-filter").value;
  const statusF = $("status-filter").value;
  const lineSet = ACTIVE_LINE ? LINE_MATCHES[ACTIVE_LINE] : null;
  const specSet = ACTIVE_SPEC ? SPEC_MATCHES[ACTIVE_SPEC] : null;
  const dept = ACTIVE_DEPT ? DEPT_PRESETS.find((d) => d.id === ACTIVE_DEPT) : null;

  return EXHIBITORS.filter((e) => {
    if (ACTIVE_CATS.size && !ACTIVE_CATS.has(e.category)) return false;
    if (lineSet && !lineSet.has(e.id)) return false;
    if (specSet && !specSet.has(e.id)) return false;
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

function render() {
  let list = filtered();
  const sort = $("sort-select").value;
  if (sort === "booth") {
    list = [...list].sort((a, b) => (a.booth_no || "").localeCompare(b.booth_no || ""));
  } else if (sort === "notes") {
    list = [...list].sort((a, b) => getState(b.id).note_count - getState(a.id).note_count);
  }

  const pocketCount = Object.values(STATE).filter((s) => s.pocket).length;
  $("stats").textContent =
    `共 ${EXHIBITORS.length} 家展商，符合條件 ${list.length} 家` +
    (API_OK ? `｜口袋名單 ${pocketCount} 家` : "");

  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").style.display = list.length ? "none" : "block";

  if (VIEW === "table") {
    if (list.length) grid.appendChild(renderTable(list));
    return;
  }

  // 依關聯分組（產品線或科別視角時）
  if ((ACTIVE_LINE || ACTIVE_SPEC) && list.length) {
    const groups = {};
    for (const e of list) {
      const role = CAT_ROLES[e.category] || "service";
      (groups[role] = groups[role] || []).push(e);
    }
    for (const role of ["supply", "process", "tech", "market", "service"]) {
      if (!groups[role]) continue;
      const h = document.createElement("h3");
      h.className = "group-title";
      h.textContent = `${ROLE_LABELS[role]}（${groups[role].length}）`;
      grid.appendChild(h);
      const sub = document.createElement("div");
      sub.className = "grid-inner";
      for (const e of groups[role]) sub.appendChild(renderCard(e));
      grid.appendChild(sub);
    }
  } else {
    const sub = document.createElement("div");
    sub.className = "grid-inner";
    for (const e of list) sub.appendChild(renderCard(e));
    grid.appendChild(sub);
  }
}

// ---------- 列表檢視 ----------
function renderTable(list) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "listview";
  table.innerHTML = `
    <thead><tr>
      <th></th><th>公司</th><th>攤位</th><th>分類</th><th>國家</th>
      ${API_OK ? "<th>狀態</th><th>負責</th><th>紀錄</th>" : ""}
      <th>連結</th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const e of list) {
    const st = getState(e.id);
    const cat = CAT_MAP[e.category];
    const statusColor = STATUS_COLORS[st.status] || "#8a8a82";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="row-star ${st.pocket ? "on" : ""}" title="口袋名單">${st.pocket ? "★" : "☆"}</span></td>
      <td class="co"><div class="zh">${KEY_VISIT_MAP[e.id] ? '<span class="badge visit">行程</span> ' : ""}${esc(e.name_zh)}</div><div class="en">${esc(e.name_en || "")}</div></td>
      <td class="booth-cell">${esc(e.booth_no)}</td>
      <td>${esc(cat ? cat.name_zh : e.category)}</td>
      <td>${esc(e.country)}</td>
      ${API_OK ? `
      <td class="status-cell"><span class="status-dot" style="background:${statusColor};"></span>${esc(st.status)}</td>
      <td>${esc(st.assignee || "—")}</td>
      <td>${st.note_count || ""}</td>` : ""}
      <td class="links-cell">
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

function renderCard(e) {
  const st = getState(e.id);
  const card = document.createElement("div");
  card.className = "card";
  const cat = CAT_MAP[e.category];
  const statusColor = STATUS_COLORS[st.status] || "#94a3b8";
  const visit = KEY_VISIT_MAP[e.id];
  card.innerHTML = `
    <div class="badge-row">
      ${visit ? `<span class="badge visit">行程重點</span>` : ""}
      <span class="badge">${esc(cat ? cat.name_zh : e.category)}</span>
      <span class="badge booth">攤位 ${esc(e.booth_no)}</span>
      ${API_OK ? `<span class="badge status" style="background:${statusColor}1a; color:${statusColor}; border-color:${statusColor}55;">${esc(st.status)}</span>` : ""}
      ${st.assignee ? `<span class="badge">負責 ${esc(st.assignee)}</span>` : ""}
    </div>
    <div class="card-title-row">
      <h3>${esc(e.name_zh)}</h3>
      <button class="star ${st.pocket ? "on" : ""}" title="加入/移出口袋名單">${st.pocket ? "★" : "☆"}</button>
    </div>
    <p class="name-en">${esc(e.name_en || "")} ${e.country ? "· " + esc(e.country) : ""}</p>
    <p class="desc">${esc((e.description || "").slice(0, 100))}${(e.description || "").length > 100 ? "…" : ""}</p>
    <div class="tags">${(e.products || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    <div class="card-footer">
      ${st.dept_tags.length ? st.dept_tags.map((t) => `<span class="dept-tag">${esc(t)}</span>`).join("") : ""}
      <span class="note-count">${st.note_count ? st.note_count + " 則紀錄" : ""}</span>
    </div>
    <div class="link-row">
      ${e.website ? `<a class="directory-link" href="${e.website}" target="_blank" rel="noopener">官網</a>` : ""}
      ${(e.pdfs || []).map((p, i) => `<a class="directory-link" href="${p}" target="_blank" rel="noopener">型錄${e.pdfs.length > 1 ? i + 1 : ""}</a>`).join("")}
      ${e.directory_url ? `<a class="directory-link" href="${e.directory_url}" target="_blank" rel="noopener">展商頁</a>` : ""}
    </div>
    <button class="ask">查看 / 共筆</button>
  `;
  card.querySelector("button.ask").onclick = () => openDetail(e.id);
  card.querySelector("button.star").onclick = (ev) => { ev.stopPropagation(); togglePocket(e.id); };
  return card;
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
  const specHits = HOSPITAL_SPECIALTIES.filter((s) => SPEC_MATCHES[s.id].has(id));
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
        ${lineHits.length ? `<p class="sub">產品別關聯：${lineHits.map((l) => l.name).join("、")}</p>` : ""}
        ${specHits.length ? `<p class="sub">科別關聯：${specHits.map((s) => s.name).join("、")}</p>` : ""}
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
    </div>

    <hr/>
    <h3 class="section-title">團隊紀錄（任何人可新增、修改）</h3>
    <div class="note-form">
      <select id="d-note-type">
        <option>現場紀錄</option>
        <option>想詢問的問題</option>
        <option>索取資料備註</option>
        <option>後續追蹤</option>
      </select>
      <textarea id="d-note-content" placeholder="想請去的同事代為詢問什麼？現場聊到什麼？要跟進什麼？"></textarea>
      <button class="btn primary small" id="d-note-add">送出</button>
    </div>
    <div id="d-notes" class="notes-list">載入中...</div>
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
  $("d-note-add").onclick = () => addNote(id);

  loadNotes(id);
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
