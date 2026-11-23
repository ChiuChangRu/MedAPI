/* v257 MyLab／儀器設備：儀器清冊、校正期限燈號、校正證書、修改紀錄、首頁提醒。
 * 結構與藥品櫃（lab.js）一致。資料來自 /api/lab/instruments；需要 app.js 的全域：api、esc、showToast、pin。
 */
(function () {
  const CATEGORIES = ["量測", "加工", "滅菌", "環境", "試驗", "其他"];
  const USE_STATUS = ["使用中", "維修中", "停用", "報廢"];
  const GROUPS = [
    { title: "基本資料", keys: ["code", "name_zh", "name_en", "category", "use_status"] },
    { title: "規格與來源", keys: ["brand", "model", "serial_no", "asset_no", "supplier", "purchased_date"] },
    { title: "存放", keys: ["location"] },
    { title: "校正", keys: ["calibration_required", "calibration_cycle_months", "last_calibrated_date", "next_calibration_date", "calibration_vendor"] },
    { title: "備註", keys: ["source", "note"] },
  ];
  const LABELS = {
    code: "編號", name_zh: "中文名稱", name_en: "英文名稱", category: "類別", use_status: "使用狀態", brand: "品牌", model: "型號",
    serial_no: "序號", asset_no: "財產編號", supplier: "供應商", purchased_date: "購入日期", location: "存放位置",
    calibration_required: "需要校正", calibration_cycle_months: "校正週期（月）", last_calibrated_date: "上次校正日期",
    next_calibration_date: "下次校正日期（空白＝上次＋週期推算）", calibration_vendor: "校正單位", source: "資料來源", note: "備註",
  };
  const TYPES = {
    purchased_date: "date", last_calibrated_date: "date", next_calibration_date: "date", calibration_cycle_months: "int",
    note: "textarea", category: "category", use_status: "use_status", calibration_required: "bool",
  };
  const STATE_META = {
    expired: { cls: "lab-badge expired" }, soon: { cls: "lab-badge soon" }, ok: { cls: "lab-badge ok" },
    unknown: { cls: "lab-badge unknown" }, na: { cls: "lab-badge na" }, repair: { cls: "lab-badge repair" }, inactive: { cls: "lab-badge inactive" },
  };
  const FILTERS = [
    ["all", "全部"], ["attention", "需注意"], ["expired", "已逾期"], ["soon", "即將到期"], ["unknown", "日期待確認"], ["repair", "維修中"], ["inactive", "停用／報廢"],
  ];
  const state = { data: null, filter: "all", query: "", editing: null };
  const $ = (id) => document.getElementById(id);

  function needsAttention(r) { return ["expired", "soon", "unknown", "repair"].includes(r.status.state) || r.status.flags.length > 0; }
  function matches(r) {
    const f = state.filter;
    if (f === "attention" && !needsAttention(r)) return false;
    if (["expired", "soon", "unknown", "repair"].includes(f) && r.status.state !== f) return false;
    if (f === "inactive" && r.status.state !== "inactive") return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [r.code, r.name_zh, r.name_en, r.brand, r.model, r.serial_no, r.asset_no, r.location, r.category].some((v) => String(v || "").toLowerCase().includes(q));
  }
  function dueText(r) {
    const d = r.status.due;
    if (r.status.state === "na" || r.status.state === "inactive" || r.status.state === "repair") return `<span class="lab-missing">—</span>`;
    return d ? `${esc(d.date)}${d.derived ? `<br><small>由上次＋週期推算</small>` : ""}` : `<span class="lab-missing">待補</span>`;
  }

  function renderSummary() {
    const s = state.data.summary;
    $("inst-summary").innerHTML = [
      `共 <b>${s.total}</b> 台`,
      s.expired ? `<span class="lab-badge expired">已逾期 ${s.expired}</span>` : "",
      s.soon ? `<span class="lab-badge soon">即將到期 ${s.soon}</span>` : "",
      s.unknown ? `<span class="lab-badge unknown">日期待確認 ${s.unknown}</span>` : "",
      s.repair ? `<span class="lab-badge repair">維修中 ${s.repair}</span>` : "",
      s.need_location ? `<span class="lab-badge inventory">位置待補 ${s.need_location}</span>` : "",
    ].filter(Boolean).join(" ");
    $("inst-filters").innerHTML = FILTERS.map(([k, label]) => `<button type="button" class="btn small${state.filter === k ? " active" : ""}" data-inst-filter="${k}">${label}</button>`).join("");
    $("inst-filters").querySelectorAll("[data-inst-filter]").forEach((b) => b.onclick = () => { state.filter = b.dataset.instFilter; renderSummary(); renderTable(); });
  }

  function renderTable() {
    const rows = state.data.instruments.filter(matches);
    $("inst-table").innerHTML = rows.length ? `<table class="lab-table">
      <thead><tr><th>編號</th><th>名稱</th><th>類別</th><th>品牌／型號</th><th>位置</th><th>校正期限</th><th>狀態</th><th>證書</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-inst-id="${r.id}" tabindex="0">
        <td class="lab-code">${esc(r.code)}</td>
        <td><b>${esc(r.name_zh || r.name_en || "")}</b>${r.name_zh && r.name_en ? `<br><small>${esc(r.name_en)}</small>` : ""}${r.serial_no ? `<br><small class="lab-formula">S/N ${esc(r.serial_no)}</small>` : ""}</td>
        <td>${esc(r.category || "")}</td>
        <td>${esc(r.brand || "")}${r.model ? `<br><small>${esc(r.model)}</small>` : ""}</td>
        <td>${r.location ? esc(r.location) : `<span class="lab-missing">待補</span>`}</td>
        <td>${dueText(r)}</td>
        <td><span class="${(STATE_META[r.status.state] || STATE_META.unknown).cls}">${esc(r.status.text)}</span></td>
        <td>${r.cert ? "📄" : ""}</td>
      </tr>`).join("")}</tbody></table>` : `<p class="sub">${state.data.instruments.length ? "沒有符合的儀器。" : "還沒有儀器。按右上「＋ 新增儀器」開始建立。"}</p>`;
    $("inst-table").querySelectorAll("[data-inst-id]").forEach((tr) => {
      const open = () => openEditor(Number(tr.dataset.instId));
      tr.onclick = open;
      tr.onkeydown = (ev) => { if (ev.key === "Enter") open(); };
    });
  }

  async function load() {
    $("inst-table").innerHTML = `<p class="sub">讀取中…</p>`;
    try {
      state.data = await api("/lab/instruments");
      $("inst-warn-days").value = String(state.data.warn_days);
      renderSummary();
      renderTable();
      updateBadges(state.data);
    } catch (error) {
      $("inst-table").innerHTML = `<p class="sub">讀取失敗：${esc(error.message)}</p>`;
    }
  }

  function fieldInput(key, value) {
    const type = TYPES[key] || "text";
    const v = value === null || value === undefined ? "" : String(value);
    if (type === "textarea") return `<textarea id="inst-f-${key}" rows="3">${esc(v)}</textarea>`;
    if (type === "category") return `<select id="inst-f-${key}"><option value="">（未分類）</option>${CATEGORIES.map((c) => `<option${v === c ? " selected" : ""}>${c}</option>`).join("")}</select>`;
    if (type === "use_status") return `<select id="inst-f-${key}">${USE_STATUS.map((c) => `<option${(v || "使用中") === c ? " selected" : ""}>${c}</option>`).join("")}</select>`;
    if (type === "bool") return `<select id="inst-f-${key}"><option value="1"${v !== "0" ? " selected" : ""}>是</option><option value="0"${v === "0" ? " selected" : ""}>否（不需校正）</option></select>`;
    const htmlType = type === "date" ? "date" : type === "int" ? "number" : "text";
    return `<input id="inst-f-${key}" type="${htmlType}" ${type === "int" ? 'step="1" min="1" max="240"' : ""} value="${esc(v)}" placeholder="${type === "text" ? "待補" : ""}">`;
  }

  async function openEditor(id) {
    const r = id ? state.data.instruments.find((x) => x.id === id) : { use_status: "使用中", calibration_required: 1 };
    state.editing = id || null;
    const box = $("inst-editor");
    box.hidden = false;
    $("inst-list-wrap").classList.add("editing");
    box.innerHTML = `<div class="lab-editor-head">
        <h3>${id ? `${esc(r.code)}　${esc(r.name_zh || r.name_en || "")}` : "新增儀器"}</h3>
        ${id ? `<span class="${(STATE_META[r.status.state] || STATE_META.unknown).cls}">${esc(r.status.text)}</span>` : ""}
      </div>
      <form id="inst-form" class="lab-form">
        ${GROUPS.map((g) => `<fieldset><legend>${g.title}</legend>${g.keys.map((k) => `<label for="inst-f-${k}">${LABELS[k]}</label>${fieldInput(k, r[k])}`).join("")}</fieldset>`).join("")}
        <label for="inst-f-log-note">這次修改的說明（可不填，例如：11/20 送校回來）</label><input id="inst-f-log-note" type="text" maxlength="200">
        <div class="lab-form-actions">
          <button class="btn primary" type="submit">儲存</button>
          <button class="btn" type="button" id="inst-cancel">關閉</button>
          ${id ? `<button class="btn danger" type="button" id="inst-delete">刪除</button>` : ""}
        </div>
      </form>
      ${id ? `<div class="lab-coa"><h4>校正證書／說明書</h4>
        ${r.cert ? `<a class="btn small" href="/api/lab/instruments/${id}/cert" target="_blank" rel="noopener">📄 ${esc(r.cert.filename)}</a>` : `<span class="sub">還沒有檔案</span>`}
        <label class="btn small">${r.cert ? "更換" : "上傳"}<input type="file" id="inst-cert-file" accept="application/pdf,image/*" hidden></label>
      </div>
      <div class="lab-log"><h4>修改紀錄</h4><div id="inst-log-list"><p class="sub">讀取中…</p></div></div>` : ""}`;
    $("inst-cancel").onclick = closeEditor;
    $("inst-form").onsubmit = (ev) => { ev.preventDefault(); save(); };
    $("inst-delete")?.addEventListener("click", remove);
    $("inst-cert-file")?.addEventListener("change", (ev) => uploadCert(ev.target.files?.[0]));
    if (id) loadLog(id);
    box.scrollTop = 0;
  }

  function closeEditor() {
    state.editing = null;
    $("inst-editor").hidden = true;
    $("inst-list-wrap").classList.remove("editing");
  }

  async function save() {
    const body = {};
    for (const g of GROUPS) for (const k of g.keys) body[k] = $(`inst-f-${k}`).value;
    body.log_note = $("inst-f-log-note").value;
    try {
      const r = state.editing
        ? await api(`/lab/instruments/${state.editing}`, { method: "PUT", body: JSON.stringify(body) })
        : await api("/lab/instruments", { method: "POST", body: JSON.stringify(body) });
      showToast(r.unchanged ? "沒有變更" : "已儲存");
      await load();
      openEditor(r.instrument.id);
    } catch (error) { alert(`儲存失敗：${error.message}`); }
  }

  async function remove() {
    const r = state.data.instruments.find((x) => x.id === state.editing);
    if (!confirm(`刪除「${r.code} ${r.name_zh || r.name_en || ""}」？（會保留修改紀錄）`)) return;
    try { await api(`/lab/instruments/${state.editing}`, { method: "DELETE" }); showToast("已刪除"); closeEditor(); await load(); }
    catch (error) { alert(`刪除失敗：${error.message}`); }
  }

  async function uploadCert(file) {
    if (!file || !state.editing) return;
    try {
      const res = await fetch(`/api/lab/instruments/${state.editing}/cert`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name), "x-pin": pin() },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast("檔案已上傳");
      await load();
      openEditor(state.editing);
    } catch (error) { alert(`上傳失敗：${error.message}`); }
  }

  async function loadLog(id) {
    try {
      const { log } = await api(`/lab/instruments/${id}/log`);
      const actionLabel = { create: "建立", update: "修改", calibration: "校正", delete: "刪除", cert: "證書", import: "匯入" };
      $("inst-log-list").innerHTML = log.length ? `<ul>${log.map((l) => `<li><b>${esc(String(l.created_at).slice(0, 16).replace("T", " "))}</b> ${actionLabel[l.action] || esc(l.action)}${l.note ? `｜${esc(l.note)}` : ""}
        ${Object.keys(l.changes || {}).length && l.action !== "create" && l.action !== "import" ? `<br><small>${Object.entries(l.changes).map(([k, [a, b]]) => `${esc(LABELS[k] || k)}：${esc(a ?? "空")} → ${esc(b ?? "空")}`).join("；")}</small>` : ""}</li>`).join("")}</ul>` : `<p class="sub">沒有紀錄</p>`;
    } catch (error) { $("inst-log-list").innerHTML = `<p class="sub">讀取失敗：${esc(error.message)}</p>`; }
  }

  function updateBadges(data) {
    const n = (data.summary.expired || 0) + (data.summary.soon || 0);
    const badge = $("inst-alert-badge");
    if (badge) { badge.hidden = !n; badge.textContent = String(n); badge.title = `${n} 台已逾期或即將到期校正`; }
  }

  /** 首頁提醒：校正已逾期、即將到期的儀器列出來；沒有儀器時整塊不顯示 */
  async function loadInstrumentsHome() {
    const box = $("inst-home");
    if (!box) return;
    try {
      const data = await api("/lab/instruments");
      updateBadges(data);
      if (!data.summary.total) { box.hidden = true; return; }
      const urgent = data.instruments.filter((r) => ["expired", "soon"].includes(r.status.state)).sort((a, b) => (a.status.days ?? 0) - (b.status.days ?? 0)).slice(0, 5);
      box.hidden = false;
      if ($("lab-home")) $("lab-home").hidden = false;
      $("inst-home-body").innerHTML = `${urgent.length ? `<ul class="lab-home-list">${urgent.map((r) => `<li><span class="${STATE_META[r.status.state].cls}">${esc(r.status.text)}</span> ${esc(r.code)} ${esc(r.name_zh || r.name_en || "")}<small>（${esc(r.status.due.date)}）</small></li>`).join("")}</ul>` : `<p class="sub">沒有即將到期的校正。</p>`}
        <p class="sub">共 ${data.summary.total} 台${data.summary.unknown ? `｜校正日期待確認 ${data.summary.unknown}` : ""}${data.summary.repair ? `｜維修中 ${data.summary.repair}` : ""}</p>`;
    } catch { box.hidden = true; }
  }

  function close() {
    $("inst-overlay").classList.remove("open");
    $("inst-overlay").setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
    document.querySelectorAll("#desktop-lab-instruments").forEach((b) => b.classList.remove("active"));
    loadInstrumentsHome();
  }
  function onKey(ev) { if (ev.key === "Escape") { if (!$("inst-editor").hidden) closeEditor(); else close(); } }

  async function openInstruments() {
    const overlay = $("inst-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKey);
    document.querySelectorAll("#desktop-lab-instruments").forEach((b) => b.classList.add("active"));
    $("inst-close").onclick = close;
    $("inst-add").onclick = () => openEditor(null);
    $("inst-search").oninput = () => { state.query = $("inst-search").value; renderTable(); };
    $("inst-warn-days").onchange = async () => {
      try { await api("/lab/instruments/settings", { method: "PUT", body: JSON.stringify({ warn_days: Number($("inst-warn-days").value) }) }); await load(); }
      catch (error) { showToast("設定失敗：" + error.message); }
    };
    closeEditor();
    await load();
  }

  function init() {
    $("desktop-lab-instruments")?.addEventListener("click", openInstruments);
    $("inst-home-open")?.addEventListener("click", openInstruments);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.openInstruments = openInstruments;
  window.loadInstrumentsHome = loadInstrumentsHome;
})();
