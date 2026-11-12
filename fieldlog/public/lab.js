/* v250 MyLab／藥品櫃：試劑清冊、到期燈號、盤點、COA、首頁提醒。
 * 資料來自 /api/lab/*；需要 app.js 的全域：api、esc、showToast、pin。
 */
(function () {
  const GROUPS = [
    { title: "基本資料", keys: ["code", "name_zh", "name_en", "formula", "cas"] },
    { title: "盤點", keys: ["remaining_qty", "unit", "location", "opened_date", "purchased_qty"] },
    { title: "期限", keys: ["expiry_date", "retest_date", "retest_month", "manufactured_date", "released_date"] },
    { title: "來源與規格", keys: ["brand", "catalog_no", "grade", "purity_spec", "coa_result", "lot_no", "source"] },
    { title: "備註", keys: ["note"] },
  ];
  const LABELS = {
    code: "編號", name_zh: "中文名稱", name_en: "英文名稱", formula: "化學式", cas: "CAS No.", brand: "品牌", catalog_no: "貨號",
    grade: "等級", purity_spec: "純度規格", coa_result: "COA 實測", lot_no: "批號", purchased_qty: "已知購買量", remaining_qty: "實際餘量",
    unit: "單位", location: "存放位置", opened_date: "開封日期", manufactured_date: "製造日期", released_date: "放行／檢驗日期",
    expiry_date: "有效期限", retest_date: "複驗日期", retest_month: "複驗月份（僅年月）", source: "資料來源", note: "備註",
  };
  const TYPES = {
    purchased_qty: "number", remaining_qty: "number", opened_date: "date", manufactured_date: "date", released_date: "date",
    expiry_date: "date", retest_date: "date", retest_month: "month", note: "textarea", unit: "unit",
  };
  const UNITS = ["g", "kg", "mg", "mL", "L", "瓶", "個"];
  const STATE_META = {
    expired: { label: "已過期", cls: "lab-badge expired" },
    soon: { label: "即將到期", cls: "lab-badge soon" },
    unknown: { label: "期限待確認", cls: "lab-badge unknown" },
    ok: { label: "期限內", cls: "lab-badge ok" },
  };
  const FILTERS = [
    ["all", "全部"], ["attention", "需注意"], ["expired", "已過期"], ["soon", "即將到期"], ["unknown", "期限待確認"], ["inventory", "待盤點"],
  ];
  const state = { data: null, filter: "all", query: "", editing: null };
  const $ = (id) => document.getElementById(id);

  function needsAttention(r) { return ["expired", "soon", "unknown"].includes(r.status.state) || r.status.flags.length; }
  function matches(r) {
    const f = state.filter;
    if (f === "attention" && !needsAttention(r)) return false;
    if (["expired", "soon", "unknown"].includes(f) && r.status.state !== f) return false;
    if (f === "inventory" && !r.status.flags.includes("待盤點")) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [r.code, r.name_zh, r.name_en, r.formula, r.cas, r.brand, r.lot_no, r.location].some((v) => String(v || "").toLowerCase().includes(q));
  }
  function qty(r) {
    if (r.remaining_qty === null || r.remaining_qty === undefined) return `<span class="lab-missing">待盤點</span>`;
    return `${r.remaining_qty} ${esc(r.unit || "g")}`;
  }
  function deadlineText(r) {
    const d = r.status.deadline;
    return d ? `<small>${esc(d.label)}</small><br>${esc(d.display)}` : `<span class="lab-missing">待補</span>`;
  }

  function renderSummary() {
    const s = state.data.summary;
    $("lab-summary").innerHTML = [
      `共 <b>${s.total}</b> 項`,
      s.expired ? `<span class="lab-badge expired">已過期 ${s.expired}</span>` : "",
      s.soon ? `<span class="lab-badge soon">即將到期 ${s.soon}</span>` : "",
      s.unknown ? `<span class="lab-badge unknown">期限待確認 ${s.unknown}</span>` : "",
      s.need_inventory ? `<span class="lab-badge inventory">待盤點 ${s.need_inventory}</span>` : "",
      s.need_location ? `<span class="lab-badge inventory">位置待補 ${s.need_location}</span>` : "",
    ].filter(Boolean).join(" ");
    $("lab-filters").innerHTML = FILTERS.map(([k, label]) => `<button type="button" class="btn small${state.filter === k ? " active" : ""}" data-lab-filter="${k}">${label}</button>`).join("");
    $("lab-filters").querySelectorAll("[data-lab-filter]").forEach((b) => b.onclick = () => { state.filter = b.dataset.labFilter; renderSummary(); renderTable(); });
  }

  function renderTable() {
    const rows = state.data.reagents.filter(matches);
    $("lab-table").innerHTML = rows.length ? `<table class="lab-table">
      <thead><tr><th>編號</th><th>名稱</th><th>CAS</th><th>品牌／批號</th><th>餘量</th><th>位置</th><th>期限</th><th>狀態</th><th>COA</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-lab-id="${r.id}" tabindex="0">
        <td class="lab-code">${esc(r.code)}</td>
        <td><b>${esc(r.name_zh || r.name_en || "")}</b>${r.name_zh && r.name_en ? `<br><small>${esc(r.name_en)}</small>` : ""}${r.formula ? `<br><small class="lab-formula">${esc(r.formula)}</small>` : ""}</td>
        <td>${esc(r.cas || "")}</td>
        <td>${esc(r.brand || "")}${r.lot_no ? `<br><small>批號 ${esc(r.lot_no)}</small>` : ""}</td>
        <td>${qty(r)}</td>
        <td>${r.location ? esc(r.location) : `<span class="lab-missing">待補</span>`}</td>
        <td>${deadlineText(r)}</td>
        <td><span class="${STATE_META[r.status.state].cls}">${esc(r.status.text)}</span></td>
        <td>${r.coa ? "📄" : ""}</td>
      </tr>`).join("")}</tbody></table>` : `<p class="sub">沒有符合的藥品。</p>`;
    $("lab-table").querySelectorAll("[data-lab-id]").forEach((tr) => {
      const open = () => openEditor(Number(tr.dataset.labId));
      tr.onclick = open;
      tr.onkeydown = (ev) => { if (ev.key === "Enter") open(); };
    });
  }

  async function load() {
    $("lab-table").innerHTML = `<p class="sub">讀取中…</p>`;
    try {
      state.data = await api("/lab/reagents");
      $("lab-warn-days").value = String(state.data.warn_days);
      renderSummary();
      renderTable();
      updateBadges(state.data);
    } catch (error) {
      $("lab-table").innerHTML = `<p class="sub">讀取失敗：${esc(error.message)}</p>`;
    }
  }

  function fieldInput(key, value) {
    const type = TYPES[key] || "text";
    const v = value === null || value === undefined ? "" : String(value);
    if (type === "textarea") return `<textarea id="lab-f-${key}" rows="3">${esc(v)}</textarea>`;
    if (type === "unit") return `<select id="lab-f-${key}">${UNITS.map((u) => `<option${(v || "g") === u ? " selected" : ""}>${u}</option>`).join("")}</select>`;
    const htmlType = type === "number" ? "number" : type === "date" ? "date" : type === "month" ? "month" : "text";
    return `<input id="lab-f-${key}" type="${htmlType}" ${type === "number" ? 'step="any" min="0"' : ""} value="${esc(v)}" placeholder="${type === "text" ? "待補" : ""}">`;
  }

  async function openEditor(id) {
    const r = id ? state.data.reagents.find((x) => x.id === id) : { unit: "g" };
    state.editing = id || null;
    const box = $("lab-editor");
    box.hidden = false;
    $("lab-list-wrap").classList.add("editing");
    box.innerHTML = `<div class="lab-editor-head">
        <h3>${id ? `${esc(r.code)}　${esc(r.name_zh || r.name_en || "")}` : "新增藥品"}</h3>
        ${id ? `<span class="${STATE_META[r.status.state].cls}">${esc(r.status.text)}</span>` : ""}
      </div>
      <form id="lab-form" class="lab-form">
        ${GROUPS.map((g) => `<fieldset><legend>${g.title}</legend>${g.keys.map((k) => `<label for="lab-f-${k}">${LABELS[k]}</label>${fieldInput(k, r[k])}`).join("")}</fieldset>`).join("")}
        <label for="lab-f-log-note">這次修改的說明（可不填，例如：11/20 盤點）</label><input id="lab-f-log-note" type="text" maxlength="200">
        <div class="lab-form-actions">
          <button class="btn primary" type="submit">儲存</button>
          <button class="btn" type="button" id="lab-cancel">關閉</button>
          ${id ? `<button class="btn danger" type="button" id="lab-delete">刪除</button>` : ""}
        </div>
      </form>
      ${id ? `<div class="lab-coa"><h4>COA</h4>
        ${r.coa ? `<a class="btn small" href="/api/lab/reagents/${id}/coa" target="_blank" rel="noopener">📄 ${esc(r.coa.filename)}</a>` : `<span class="sub">還沒有 COA</span>`}
        <label class="btn small">${r.coa ? "更換" : "上傳"} COA<input type="file" id="lab-coa-file" accept="application/pdf,image/*" hidden></label>
      </div>
      <div class="lab-log"><h4>修改紀錄</h4><div id="lab-log-list"><p class="sub">讀取中…</p></div></div>` : ""}`;
    $("lab-cancel").onclick = closeEditor;
    $("lab-form").onsubmit = (ev) => { ev.preventDefault(); save(); };
    $("lab-delete")?.addEventListener("click", remove);
    $("lab-coa-file")?.addEventListener("change", (ev) => uploadCoa(ev.target.files?.[0]));
    if (id) loadLog(id);
    box.scrollTop = 0;
  }

  function closeEditor() {
    state.editing = null;
    $("lab-editor").hidden = true;
    $("lab-list-wrap").classList.remove("editing");
  }

  async function save() {
    const body = {};
    for (const g of GROUPS) for (const k of g.keys) body[k] = $(`lab-f-${k}`).value;
    body.log_note = $("lab-f-log-note").value;
    try {
      const r = state.editing
        ? await api(`/lab/reagents/${state.editing}`, { method: "PUT", body: JSON.stringify(body) })
        : await api("/lab/reagents", { method: "POST", body: JSON.stringify(body) });
      showToast(r.unchanged ? "沒有變更" : "已儲存");
      await load();
      openEditor(r.reagent.id);
    } catch (error) { alert(`儲存失敗：${error.message}`); }
  }

  async function remove() {
    const r = state.data.reagents.find((x) => x.id === state.editing);
    if (!confirm(`刪除「${r.code} ${r.name_zh || r.name_en || ""}」？（會保留修改紀錄）`)) return;
    try { await api(`/lab/reagents/${state.editing}`, { method: "DELETE" }); showToast("已刪除"); closeEditor(); await load(); }
    catch (error) { alert(`刪除失敗：${error.message}`); }
  }

  async function uploadCoa(file) {
    if (!file || !state.editing) return;
    try {
      const res = await fetch(`/api/lab/reagents/${state.editing}/coa`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name), "x-pin": pin() },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast("COA 已上傳");
      await load();
      openEditor(state.editing);
    } catch (error) { alert(`COA 上傳失敗：${error.message}`); }
  }

  async function loadLog(id) {
    try {
      const { log } = await api(`/lab/reagents/${id}/log`);
      const actionLabel = { create: "建立", update: "修改", inventory: "盤點", delete: "刪除", coa: "COA", import: "匯入" };
      $("lab-log-list").innerHTML = log.length ? `<ul>${log.map((l) => `<li><b>${esc(String(l.created_at).slice(0, 16).replace("T", " "))}</b> ${actionLabel[l.action] || esc(l.action)}${l.note ? `｜${esc(l.note)}` : ""}
        ${Object.keys(l.changes || {}).length && l.action !== "create" && l.action !== "import" ? `<br><small>${Object.entries(l.changes).map(([k, [a, b]]) => `${esc(LABELS[k] || k)}：${esc(a ?? "空")} → ${esc(b ?? "空")}`).join("；")}</small>` : ""}</li>`).join("")}</ul>` : `<p class="sub">沒有紀錄</p>`;
    } catch (error) { $("lab-log-list").innerHTML = `<p class="sub">讀取失敗：${esc(error.message)}</p>`; }
  }

  function updateBadges(data) {
    const n = (data.summary.expired || 0) + (data.summary.soon || 0);
    const badge = $("lab-alert-badge");
    if (badge) { badge.hidden = !n; badge.textContent = String(n); badge.title = `${n} 項已過期或即將到期`; }
  }

  /** 首頁提醒卡：已過期、即將到期列出來；待盤點只顯示數量 */
  async function loadLabHome() {
    const card = $("lab-home");
    if (!card) return;
    try {
      const data = await api("/lab/reagents");
      updateBadges(data);
      if (!data.summary.total) { card.hidden = true; return; }
      const urgent = data.reagents.filter((r) => ["expired", "soon"].includes(r.status.state))
        .sort((a, b) => (a.status.days ?? 0) - (b.status.days ?? 0)).slice(0, 5);
      card.hidden = false;
      $("lab-home-body").innerHTML = `${urgent.length ? `<ul class="lab-home-list">${urgent.map((r) => `<li><span class="${STATE_META[r.status.state].cls}">${esc(r.status.text)}</span> ${esc(r.code)} ${esc(r.name_zh || r.name_en || "")}<small>（${esc(r.status.deadline.label)} ${esc(r.status.deadline.display)}）</small></li>`).join("")}</ul>` : `<p class="sub">沒有即將到期的藥品。</p>`}
        <p class="sub">共 ${data.summary.total} 項${data.summary.unknown ? `｜期限待確認 ${data.summary.unknown}` : ""}${data.summary.need_inventory ? `｜待盤點 ${data.summary.need_inventory}` : ""}</p>`;
    } catch { card.hidden = true; }
  }

  // ---- 批次上傳 COA：一份多頁 PDF，依「資料來源：PDF 第 N 頁」拆頁後掛到各項 ----
  function loadPdfLib() {
    if (window.PDFLib?.PDFDocument) return Promise.resolve(window.PDFLib);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
      script.onload = () => window.PDFLib?.PDFDocument ? resolve(window.PDFLib) : reject(new Error("PDF 程式庫載入失敗"));
      script.onerror = () => reject(new Error("PDF 程式庫載入失敗，請檢查網路"));
      document.head.appendChild(script);
    });
  }

  /** 每項試劑對應的 PDF 頁碼（來自資料來源欄「PDF 第 N 頁」） */
  function coaPageMap(reagents, pageCount) {
    const mapped = []; const unmatched = [];
    for (const r of reagents) {
      const m = String(r.source || "").match(/PDF\s*第\s*(\d+)\s*頁/);
      const page = m ? Number(m[1]) : 0;
      if (page >= 1 && page <= pageCount) mapped.push({ reagent: r, page }); else unmatched.push(r);
    }
    return { mapped, unmatched };
  }

  async function uploadCoaBytes(id, bytes, filename) {
    const res = await fetch(`/api/lab/reagents/${id}/coa`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(filename), "x-pin": pin() },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  }

  async function bulkCoa(file) {
    if (!file) return;
    const status = $("lab-summary");
    try {
      const PDFLib = await loadPdfLib();
      const source = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      const pageCount = source.getPageCount();
      const { mapped, unmatched } = coaPageMap(state.data.reagents, pageCount);
      if (!mapped.length) { alert(`這份 PDF 有 ${pageCount} 頁，但沒有任何藥品的「資料來源」寫著「PDF 第 N 頁」，無法自動對應。請改在各項按「上傳 COA」。`); return; }
      const replaced = mapped.filter((m) => m.reagent.coa).length;
      const msg = `這份 PDF 共 ${pageCount} 頁，會依「資料來源：PDF 第 N 頁」拆成 ${mapped.length} 份，分別掛到：\n`
        + mapped.map((m) => `第 ${m.page} 頁 → ${m.reagent.code} ${m.reagent.name_zh || m.reagent.name_en || ""}`).join("\n")
        + (unmatched.length ? `\n\n沒有對應頁的（不處理）：${unmatched.map((r) => r.code).join("、")}` : "")
        + (replaced ? `\n\n其中 ${replaced} 項已有 COA，會被取代。` : "")
        + "\n\n要開始嗎？";
      if (!confirm(msg)) return;
      let done = 0; const failed = [];
      for (const { reagent, page } of mapped) {
        status.textContent = `上傳 COA ${done + 1}/${mapped.length}：${reagent.code}…`;
        try {
          const single = await PDFLib.PDFDocument.create();
          const [copied] = await single.copyPages(source, [page - 1]);
          single.addPage(copied);
          const bytes = await single.save();
          await uploadCoaBytes(reagent.id, bytes, `${reagent.code}_${reagent.name_zh || reagent.name_en || "COA"}_COA（原檔第${page}頁）.pdf`);
          done++;
        } catch (error) { failed.push(`${reagent.code}：${error.message}`); }
      }
      showToast(`COA 已上傳 ${done} 項${failed.length ? `，失敗 ${failed.length} 項` : ""}`);
      if (failed.length) alert(`以下沒有上傳成功：\n${failed.join("\n")}`);
      await load();
    } catch (error) {
      alert(`批次上傳 COA 失敗：${error.message}`);
      await load();
    }
  }

  function close() {
    $("lab-overlay").classList.remove("open");
    $("lab-overlay").setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
    document.querySelectorAll("#desktop-lab-reagents").forEach((b) => b.classList.remove("active"));
    loadLabHome();
  }
  function onKey(ev) { if (ev.key === "Escape") { if (!$("lab-editor").hidden) closeEditor(); else close(); } }

  async function openLab() {
    const overlay = $("lab-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKey);
    document.querySelectorAll("#desktop-lab-reagents").forEach((b) => b.classList.add("active"));
    $("lab-close").onclick = close;
    $("lab-add").onclick = () => openEditor(null);
    $("lab-bulk-coa-file").onchange = (ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; bulkCoa(f); };
    $("lab-search").oninput = () => { state.query = $("lab-search").value; renderTable(); };
    $("lab-warn-days").onchange = async () => {
      try { await api("/lab/settings", { method: "PUT", body: JSON.stringify({ warn_days: Number($("lab-warn-days").value) }) }); await load(); }
      catch (error) { showToast("設定失敗：" + error.message); }
    };
    closeEditor();
    await load();
  }

  function init() {
    $("desktop-lab-reagents")?.addEventListener("click", openLab);
    $("lab-home-open")?.addEventListener("click", openLab);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.openLab = openLab;
  window.__labCoaPageMap = coaPageMap;
  window.loadLabHome = loadLabHome;
})();
