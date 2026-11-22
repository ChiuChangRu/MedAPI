/* v254 實體關聯圖（知識圖譜試做）。v256 加三大類：專案開發（行政）／技術／法規——
 * 每個關鍵字只有一個主要大類，顏色與 3D 分群依大類；不同大類之間照樣連線。另有樹狀圖：大類 → 類型 → 關鍵字。
 * 方框＝AI 擷取的實體（廠商、材料、設備、人員、技術…類型由 AI 自己判斷），圓點＝資料。
 * 資料來自 /api/kg/*：擷取（逐批）、搜尋關鍵字、建圖、合併建議、標為雜訊。
 * 需要 app.js 的全域：api、esc、showToast、openEntry、showEntryPreview、PREVIEW_ENABLED。
 */
(function () {
  // 與後端 lib/kg.js 的 KG_DOMAINS 一致；同一大類內的類型用同一色系的不同深淺
  const DOMAINS = [
    { key: "project", label: "專案開發（行政）", short: "專案開發", color: "#1d4ed8", colors: ["#1d4ed8", "#4f46e5", "#0369a1", "#6366f1", "#2563eb"] },
    { key: "tech", label: "技術", short: "技術", color: "#0f766e", colors: ["#0f766e", "#15803d", "#b45309", "#4d7c0f", "#0e7490", "#a16207"] },
    { key: "reg", label: "法規", short: "法規", color: "#b91c1c", colors: ["#b91c1c", "#be123c", "#9f1239", "#c2410c", "#a21caf"] },
  ];
  const domainOf = (key) => DOMAINS.find((d) => d.key === key) || DOMAINS[0];
  const DOC_ICON = { link: "🔗", audio: "🎙️", photo: "🖼️", video: "🎬", file: "📄", note: "📝" };
  const state = { data: null, history: [], hiddenTypes: new Set(), domainFilter: "all", view: "star", selected: null, folder: null, searchResults: [], extracting: false, stopRequested: false, g3d: null };

  function $(id) { return document.getElementById(id); }
  // 類型顏色：取所屬大類的色系，依「第一次出現」的順序分配深淺，同一次使用中不會變色
  const typeColors = new Map();
  const domainUsed = new Map();
  function typeColor(type, domain) {
    const key = `${domain || ""}|${String(type || "其他")}`;
    if (!typeColors.has(key)) {
      const d = domainOf(domain);
      const i = domainUsed.get(d.key) || 0;
      domainUsed.set(d.key, i + 1);
      typeColors.set(key, d.colors[i % d.colors.length]);
    }
    return typeColors.get(key);
  }
  function short(text, n) { const t = String(text || ""); return t.length > n ? `${t.slice(0, n)}…` : t; }

  function visible() {
    const { nodes, edges, center } = state.data;
    const keepNodes = nodes.filter((n) => n.id === center || n.kind === "doc"
      || (!state.hiddenTypes.has(n.type) && (state.domainFilter === "all" || n.domain === state.domainFilter)));
    const ids = new Set(keepNodes.map((n) => n.id));
    let shownEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    // 資料點如果因為篩選而沒有任何連線，就不畫
    const linked = new Set([center]);
    for (const e of shownEdges) { linked.add(e.source); linked.add(e.target); }
    const finalNodes = keepNodes.filter((n) => linked.has(n.id));
    const finalIds = new Set(finalNodes.map((n) => n.id));
    shownEdges = shownEdges.filter((e) => finalIds.has(e.source) && finalIds.has(e.target));
    return { nodes: finalNodes, edges: shownEdges };
  }

  /** 3D 引擎：第一次用到才建立（overlay 打開後才有尺寸） */
  function engine() {
    if (!state.g3d) {
      state.g3d = Graph3D.create($("kg-stage"), {
        label: "立體實體關聯圖：拖曳旋轉，滾輪縮放，點節點看原文依據",
        onSelect: (id) => { state.selected = id; state.g3d.setSelected(id); renderInfo(); },
        onActivate: (id) => recenter(id),
      });
    }
    return state.g3d;
  }

  /** 資料或篩選改變時呼叫；只換選取走 onSelect（不重新排版，畫面不會跳動） */
  function render() {
    if (!state.data) { state.g3d?.clear(); return; }
    const { nodes, edges } = visible();
    const center = state.data.center;
    engine().setData({
      center,
      selected: state.selected,
      groups: DOMAINS.map((d) => ({ key: d.key, label: d.short, color: d.color })),
      nodes: nodes.map((n) => n.kind === "entity"
        ? { id: n.id, kind: "entity", group: n.id === center ? undefined : n.domain, label: short(n.title, n.id === center ? 24 : 18), color: typeColor(n.type, n.domain), center: n.id === center, tip: `${n.title}｜${domainOf(n.domain).short}／${n.type}｜${n.docs} 份資料` }
        : { id: n.id, kind: "doc", label: n.title, color: "#64748b", icon: DOC_ICON[n.doc_kind] || "📝", center: n.id === center, tip: `${n.title}${n.path ? `\n${n.path}` : ""}` }),
      edges: edges.map((e) => e.kind === "relation"
        ? { source: e.source, target: e.target, color: "#334155", width: 2.6, opacity: 0.95, length: 150, label: e.label, tip: e.evidence || "" }
        : { source: e.source, target: e.target, color: "#94a3b8", width: 0.8 + e.weight * 0.5, opacity: 0.8, length: 120, tip: e.evidence || "" }),
    });
    renderDomains();
    renderTypes();
    renderInfo();
  }

  /** 三大類切換：全部／專案開發（行政）／技術／法規，數字是圖上該類的關鍵字數 */
  function renderDomains() {
    const box = $("kg-domains");
    if (!state.data) { box.innerHTML = ""; return; }
    const counts = state.data.domain_counts || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    box.innerHTML = [`<button type="button" class="kg-domain-tab${state.domainFilter === "all" ? " on" : ""}" data-kg-domain="all">全部 <small>${total}</small></button>`,
      ...DOMAINS.map((d) => `<button type="button" class="kg-domain-tab${state.domainFilter === d.key ? " on" : ""}" data-kg-domain="${d.key}" style="--dc:${d.color}"><i></i>${esc(d.label)} <small>${counts[d.key] || 0}</small></button>`)].join("")
      + (state.data.cross_relations ? `<span class="sub kg-cross">跨大類的明寫關係 ${state.data.cross_relations} 條</span>` : "");
    box.querySelectorAll("[data-kg-domain]").forEach((b) => { b.onclick = () => { state.domainFilter = b.dataset.kgDomain; render(); }; });
  }

  function renderTypes() {
    const box = $("kg-types");
    const counts = new Map();
    const domainOfType = new Map();
    for (const n of state.data.nodes) if (n.kind === "entity" && n.id !== state.data.center && (state.domainFilter === "all" || n.domain === state.domainFilter)) { counts.set(n.type, (counts.get(n.type) || 0) + 1); domainOfType.set(n.type, n.domain); }
    box.innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `
      <label class="kg-type-chip${state.hiddenTypes.has(type) ? " off" : ""}"><input type="checkbox" data-kg-type="${esc(type)}" ${state.hiddenTypes.has(type) ? "" : "checked"}>
        <i style="background:${typeColor(type, domainOfType.get(type))}"></i>${esc(type)} <small>${count}</small></label>`).join("");
    box.querySelectorAll("[data-kg-type]").forEach((c) => {
      c.onchange = () => { if (c.checked) state.hiddenTypes.delete(c.dataset.kgType); else state.hiddenTypes.add(c.dataset.kgType); render(); };
    });
  }

  function nodeById(id) { return state.data.nodes.find((n) => n.id === id); }

  function renderInfo() {
    const box = $("kg-info");
    const node = nodeById(state.selected) || nodeById(state.data.center);
    if (!node) { box.innerHTML = ""; return; }
    const isCenter = node.id === state.data.center;
    const linked = state.data.edges.filter((e) => e.kind === "mention" && (e.source === node.id || e.target === node.id));
    if (node.kind === "entity") {
      const rels = state.data.edges.filter((e) => e.kind === "relation" && (e.source === node.id || e.target === node.id));
      const docs = linked.map((e) => ({ doc: nodeById(e.target), e })).filter((x) => x.doc);
      box.innerHTML = `
        <p class="graph-info-kind">${isCenter ? "中心實體" : "實體"}｜<span class="kg-type-tag" style="background:${domainOf(node.domain).color}">${esc(domainOf(node.domain).short)}</span> <span class="kg-type-tag" style="background:${typeColor(node.type, node.domain)}">${esc(node.type)}</span>${node.type_label && node.type_label !== node.type ? ` <small class="sub">（AI 原標：${esc(node.type_label)}）</small>` : ""}</p>
        <h3>${esc(node.title)}</h3>
        ${node.aliases?.length ? `<p class="sub">別名：${esc(node.aliases.join("、"))}</p>` : ""}
        <p class="sub">全庫有 ${node.docs} 份資料提到它${docs.length < node.docs ? `（圖上顯示 ${docs.length} 份）` : ""}</p>
        ${rels.length ? `<p class="kg-section">原文寫明的關係</p><ul class="kg-list">${rels.map((r) => `<li>${esc(nodeById(r.source)?.title || "")} <b>—${esc(r.label)}→</b> ${esc(nodeById(r.target)?.title || "")}${r.evidence ? `<br><q>${esc(r.evidence)}</q>` : ""}</li>`).join("")}</ul>` : ""}
        ${docs.length ? `<p class="kg-section">出現在</p><ul class="kg-list">${docs.map(({ doc, e }) => `<li><button class="link-btn" type="button" data-open="${esc(doc.id)}">${esc(doc.title)}</button>${"★".repeat(e.weight > 1 ? e.weight - 1 : 0)}${e.evidence ? `<br><q>${esc(e.evidence)}</q>` : ""}</li>`).join("")}</ul>` : ""}
        <div class="graph-info-actions">
          ${isCenter ? "" : `<button class="btn small primary" type="button" data-act="center">以這個為中心</button>`}
          <button class="btn small" type="button" data-act="hide" title="之後擷取時也會跳過這個名稱">標為雜訊</button>
        </div>`;
    } else {
      const ents = linked.map((e) => ({ ent: nodeById(e.source), e })).filter((x) => x.ent);
      box.innerHTML = `
        <p class="graph-info-kind">${isCenter ? "中心資料" : "資料"}</p>
        <h3>${esc(node.title)}</h3>
        <p class="sub">${esc(node.path || "待分類")}｜${esc(String(node.created_at || "").slice(0, 10))}</p>
        ${ents.length ? `<p class="kg-section">提到的實體</p><ul class="kg-list">${ents.map(({ ent, e }) => `<li><span class="kg-type-tag" style="background:${typeColor(ent.type, ent.domain)}">${esc(domainOf(ent.domain).short)}／${esc(ent.type)}</span> <button class="link-btn" type="button" data-pick="${esc(ent.id)}">${esc(ent.title)}</button>${e.evidence ? `<br><q>${esc(e.evidence)}</q>` : ""}</li>`).join("")}</ul>` : ""}
        <div class="graph-info-actions">
          <button class="btn small primary" type="button" data-act="open">開啟</button>
          ${isCenter ? "" : `<button class="btn small" type="button" data-act="center">以這筆為中心</button>`}
        </div>`;
    }
    box.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => openDoc(b.dataset.open); });
    box.querySelectorAll("[data-pick]").forEach((b) => { b.onclick = () => { state.selected = b.dataset.pick; state.g3d?.setSelected(state.selected); renderInfo(); }; });
    box.querySelector('[data-act="open"]')?.addEventListener("click", () => openDoc(node.id));
    box.querySelector('[data-act="center"]')?.addEventListener("click", () => recenter(node.id));
    box.querySelector('[data-act="hide"]')?.addEventListener("click", () => hideEntity(node));
  }

  function targetOf(nodeId) {
    const [kind, id] = String(nodeId).split(":");
    return kind === "e" ? { entity: Number(id) } : { entry: Number(id) };
  }

  async function recenter(nodeId) {
    if (!state.data || nodeId === state.data.center) return;
    state.history.push(targetOf(state.data.center));
    await load(targetOf(nodeId));
  }

  function openDoc(nodeId) {
    const id = Number(String(nodeId).split(":")[1]);
    close();
    if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches && typeof showEntryPreview === "function") {
      showEntryPreview(id).catch((error) => showToast("開啟失敗：" + error.message));
    } else openEntry(id);
  }

  async function hideEntity(node) {
    if (!confirm(`把「${node.title}」標為雜訊？\n圖上不再顯示它，之後擷取時也會請 AI 跳過這個名稱。`)) return;
    try {
      await api(`/kg/entities/${node.entity_id}`, { method: "POST", body: JSON.stringify({ action: "hide" }) });
      showToast("已標為雜訊");
      if (node.id === state.data.center) { const prev = state.history.pop(); if (prev) await load(prev); else { state.data = null; render(); showStart(); } }
      else await load(targetOf(state.data.center), { keepSelection: state.data.center });
    } catch (error) { showToast("操作失敗：" + error.message); }
  }

  async function load(target, { keepSelection = null } = {}) {
    $("kg-info").innerHTML = `<p class="sub">讀取中…</p>`;
    const qs = target.entity ? `entity=${target.entity}` : target.entry ? `entry=${target.entry}` : `q=${encodeURIComponent(target.q || "")}`;
    try {
      const data = await api(`/kg/graph?${qs}`);
      state.data = data;
      state.selected = keepSelection || data.center;
      const centerNode = data.nodes.find((n) => n.id === data.center);
      $("kg-title").textContent = `實體關聯圖：${centerNode?.title || ""}`;
      $("kg-back").hidden = !state.history.length;
      updateMergeButton(data.pending_merges);
      render();
    } catch (error) {
      state.data = null;
      state.g3d?.clear();
      $("kg-types").innerHTML = "";
      $("kg-domains").innerHTML = "";
      $("kg-info").innerHTML = `<p class="sub">${esc(error.message)}</p>`;
    }
  }

  function updateMergeButton(count) {
    const b = $("kg-merges");
    b.hidden = !count;
    b.textContent = `待確認合併（${count || 0}）`;
  }

  /** 沒有中心時：列出最常出現的實體當起點 */
  async function showStart() {
    $("kg-title").textContent = "實體關聯圖";
    state.g3d?.clear();
    $("kg-types").innerHTML = "";
    $("kg-domains").innerHTML = "";
    try {
      const r = await api("/kg/search?q=");
      if (!r.results.length) {
        $("kg-info").innerHTML = `<p class="sub">還沒有擷取過實體。${state.folder ? "按上方「擷取這個資料夾的實體」開始。" : "請到要試做的資料夾（例如檢體針專案），按資料夾工具列的「實體關聯」再擷取。"}</p>`;
        return;
      }
      $("kg-info").innerHTML = `<p class="graph-info-kind">從這裡開始</p><p class="sub">輸入關鍵字，或點一個常出現的實體：</p>
        <ul class="kg-list kg-start">${r.results.map((e) => `<li><span class="kg-type-tag" style="background:${typeColor(e.type_group, e.domain)}">${esc(domainOf(e.domain).short)}／${esc(e.type_group)}</span> <button class="link-btn" type="button" data-start="${e.id}">${esc(e.name)}</button> <small class="sub">${e.docs} 份</small></li>`).join("")}</ul>`;
      $("kg-info").querySelectorAll("[data-start]").forEach((b) => { b.onclick = () => load({ entity: Number(b.dataset.start) }); });
    } catch (error) { $("kg-info").innerHTML = `<p class="sub">${esc(error.message)}</p>`; }
  }

  let searchTimer = 0;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = $("kg-search").value.trim();
    if (!q) return;
    searchTimer = setTimeout(async () => {
      try {
        const r = await api(`/kg/search?q=${encodeURIComponent(q)}`);
        state.searchResults = r.results;
        $("kg-search-list").innerHTML = r.results.map((e) => `<option value="${esc(e.name)}">${esc(domainOf(e.domain).short)}／${esc(e.type_group)}｜${e.docs} 份</option>`).join("");
      } catch { /* 打字中途失敗就算了，按「以此為中心」時會再查一次 */ }
    }, 250);
  }

  async function goSearch() {
    const q = $("kg-search").value.trim();
    if (!q) { showStart(); return; }
    const exact = state.searchResults.find((e) => e.name === q);
    if (state.data) state.history.push(targetOf(state.data.center));
    await load(exact ? { entity: exact.id } : { q });
  }

  async function refreshStatus() {
    const bar = $("kg-extract");
    if (!state.folder) { bar.hidden = true; return null; }
    bar.hidden = false;
    try {
      const s = await api(`/kg/status?folder_id=${state.folder.id}`);
      $("kg-extract-status").textContent = `「${state.folder.name}」：已擷取 ${s.done}／${s.total} 筆${s.pending ? `，還有 ${s.pending} 筆` : ""}${s.failed ? `，${s.failed} 筆失敗` : ""}；全庫實體 ${s.entities} 個`;
      $("kg-extract-run").textContent = s.pending ? "擷取這個資料夾的實體" : (s.failed ? "重試失敗的" : "已全部擷取");
      $("kg-extract-run").disabled = !s.pending && !s.failed;
      $("kg-extract-run").dataset.retry = !s.pending && s.failed ? "1" : "";
      updateMergeButton(s.pending_merges);
      return s;
    } catch (error) { $("kg-extract-status").textContent = `讀取狀態失敗：${error.message}`; return null; }
  }

  async function runExtract() {
    const button = $("kg-extract-run");
    if (state.extracting) { state.stopRequested = true; button.textContent = "停止中…"; return; }
    const s = await refreshStatus();
    if (!s) return;
    const retry = button.dataset.retry === "1";
    const count = retry ? s.failed : s.pending;
    if (!count) return;
    // ＊粗估：每筆讀約 6,000 字（≈8 千 token）＋輸出約 1 千 token，約 100 Neurons
    const neurons = count * 100;
    if (!confirm(`AI 會讀「${state.folder.name}」裡 ${count} 筆資料，找出廠商、材料、設備、人員、技術……等實體與它們的關係。\n粗估約 ${neurons.toLocaleString()} Neurons（每日免費額度 10,000），約需 ${Math.ceil(count * 12 / 60)} 分鐘。\n過程中可以按「停止」，已擷取的會保留。\n\n要開始嗎？`)) return;
    state.extracting = true; state.stopRequested = false;
    button.textContent = "停止";
    let processed = 0, failed = 0, merges = 0;
    try {
      for (;;) {
        if (state.stopRequested) break;
        const r = await api("/kg/extract", { method: "POST", body: JSON.stringify({ folder_id: state.folder.id, limit: 3, retry_failed: retry }) });
        processed += r.processed; failed += r.failed; merges += r.new_merges;
        $("kg-extract-status").textContent = `擷取中：完成 ${processed} 筆${failed ? `、失敗 ${failed} 筆` : ""}，還有 ${r.remaining} 筆…`;
        if (r.stopped) { showToast(`已暫停：${r.errors?.[0] || "AI 額度保護"}`); break; }
        if (!r.remaining || (!r.processed && !r.failed)) break;
      }
      showToast(`擷取完成 ${processed} 筆${failed ? `，${failed} 筆失敗` : ""}${merges ? `；有 ${merges} 組名稱可能是同一個，請到「待確認合併」確認` : ""}`);
    } catch (error) {
      showToast("擷取失敗：" + error.message);
    } finally {
      state.extracting = false;
      await refreshStatus();
      if (state.data) await load(targetOf(state.data.center), { keepSelection: state.selected }); else await showStart();
    }
  }

  async function openMerges() {
    const box = $("kg-info");
    box.innerHTML = `<p class="sub">讀取中…</p>`;
    try {
      const r = await api("/kg/merges");
      if (!r.results.length) { box.innerHTML = `<p class="sub">沒有待確認的合併。</p>`; updateMergeButton(0); return; }
      box.innerHTML = `<p class="graph-info-kind">待確認合併（${r.results.length}）</p>
        <p class="sub">AI 依名稱判斷這些可能是同一個東西；確認後，兩邊的出現紀錄會合在一起，另一個名稱變成別名。</p>
        <ul class="kg-list kg-merge-list">${r.results.map((m) => `<li data-merge="${m.id}">
          <b>${esc(m.a_name)}</b> <small class="sub">${esc(m.a_type)}｜${m.a_docs} 份</small><br>
          <b>${esc(m.b_name)}</b> <small class="sub">${esc(m.b_type)}｜${m.b_docs} 份</small><br>
          <small class="sub">理由：${esc(m.reason)}</small>
          <div class="graph-info-actions">
            <button class="btn small" type="button" data-keep="${m.a_id}">合併，用「${esc(short(m.a_name, 28))}」</button>
            <button class="btn small" type="button" data-keep="${m.b_id}">合併，用「${esc(short(m.b_name, 28))}」</button>
            <button class="btn small ghost" type="button" data-reject="1">不是同一個</button>
          </div></li>`).join("")}</ul>`;
      box.querySelectorAll("[data-merge]").forEach((li) => {
        const id = li.dataset.merge;
        const act = async (payload) => {
          li.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          try {
            await api(`/kg/merges/${id}`, { method: "POST", body: JSON.stringify(payload) });
            li.remove();
            const left = box.querySelectorAll("[data-merge]").length;
            updateMergeButton(left);
            if (!left) box.innerHTML = `<p class="sub">都處理完了。</p>`;
          } catch (error) { showToast("操作失敗：" + error.message); li.querySelectorAll("button").forEach((b) => { b.disabled = false; }); }
        };
        li.querySelectorAll("[data-keep]").forEach((b) => { b.onclick = () => act({ action: "accept", keep_id: Number(b.dataset.keep) }); });
        li.querySelector("[data-reject]").onclick = () => act({ action: "reject" });
      });
    } catch (error) { box.innerHTML = `<p class="sub">${esc(error.message)}</p>`; }
  }

  // ---- v256 樹狀圖：大類 → 類型 → 關鍵字；可在這裡改類型的大類 ----
  function setView(view) {
    state.view = view;
    $("kg-view-star").classList.toggle("on", view === "star");
    $("kg-view-tree").classList.toggle("on", view === "tree");
    $("kg-view-star").setAttribute("aria-pressed", String(view === "star"));
    $("kg-view-tree").setAttribute("aria-pressed", String(view === "tree"));
    $("kg-stage").hidden = view !== "star";
    $("kg-tree").hidden = view !== "tree";
    $("kg-domains").hidden = view !== "star";
    $("kg-types").hidden = view !== "star";
    if (view === "tree") { state.g3d?.pause(); renderTree(); } else { state.g3d?.resume(); }
  }

  async function renderTree() {
    const box = $("kg-tree");
    box.innerHTML = `<p class="sub">讀取中…</p>`;
    try {
      const r = await api("/kg/tree");
      const total = r.tree.reduce((n, d) => n + d.count, 0);
      if (!total) { box.innerHTML = `<p class="sub">還沒有關鍵字。請先到資料夾按「擷取這個資料夾的實體」。</p>`; return; }
      box.innerHTML = `<p class="sub kg-tree-help">每個關鍵字只有一個主要大類；類型右邊的選單可以把整個類型搬到別的大類（之後 AI 不會改回）。灰色＝候選，尚未畫進關聯圖。</p>`
        + r.tree.map((d) => {
          const meta = domainOf(d.key);
          return `<details class="kg-tree-domain" open style="--dc:${meta.color}">
            <summary><i></i><b>${esc(d.label)}</b> <small>${d.count} 個關鍵字</small></summary>
            ${d.types.length ? d.types.map((t) => `<details class="kg-tree-type"${d.types.length <= 4 ? " open" : ""}>
              <summary><span class="kg-type-tag" style="background:${typeColor(t.type, d.key)}">${esc(t.type)}</span> <small>${t.count}</small>
                <select class="kg-tree-move" data-type="${esc(t.type)}" aria-label="把「${esc(t.type)}」搬到別的大類" title="${t.source === "user" ? "你指定的大類" : t.source === "ai" ? "AI 判斷的大類" : "依名稱自動歸類"}">
                  ${DOMAINS.map((o) => `<option value="${o.key}"${o.key === d.key ? " selected" : ""}>${esc(o.short)}</option>`).join("")}
                </select>${t.source === "user" ? ` <small class="sub">已指定</small>` : ""}</summary>
              <ul class="kg-tree-items">${t.entities.map((e) => e.status === "active"
                ? `<li><button type="button" class="link-btn" data-tree-entity="${e.id}">${esc(e.name)}</button> <small class="sub">${e.docs} 份</small></li>`
                : `<li class="cand" title="候選關鍵字，尚未畫進關聯圖">${esc(e.name)} <small class="sub">候選・${e.docs} 份</small></li>`).join("")}</ul>
            </details>`).join("") : `<p class="sub">（目前沒有）</p>`}
          </details>`;
        }).join("");
      box.querySelectorAll("[data-tree-entity]").forEach((b) => {
        b.onclick = async () => { setView("star"); if (state.data) state.history.push(targetOf(state.data.center)); await load({ entity: Number(b.dataset.treeEntity) }); };
      });
      box.querySelectorAll(".kg-tree-move").forEach((sel) => {
        sel.addEventListener("click", (ev) => ev.stopPropagation());
        sel.onchange = async () => {
          sel.disabled = true;
          try {
            await api(`/kg/types/${encodeURIComponent(sel.dataset.type)}`, { method: "POST", body: JSON.stringify({ domain: sel.value }) });
            showToast(`已把「${sel.dataset.type}」搬到「${domainOf(sel.value).label}」`);
            await renderTree();
          } catch (error) { showToast("修改失敗：" + error.message); sel.disabled = false; }
        };
      });
    } catch (error) { box.innerHTML = `<p class="sub">${esc(error.message)}</p>`; }
  }

  function close() {
    state.g3d?.pause();
    $("kg-overlay").classList.remove("open");
    $("kg-overlay").setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) { if (ev.key === "Escape") close(); }

  /** 入口：{ entry } 以某筆資料為中心；{ entity } 以實體為中心；{ q } 以關鍵字為中心；{ folderId, folderName } 顯示該資料夾的擷取進度 */
  async function openEntityGraph(target = {}) {
    state.history = [];
    state.data = null;
    state.selected = null;
    state.folder = target.folderId ? { id: Number(target.folderId), name: target.folderName || "這個資料夾" } : null;
    const overlay = $("kg-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKey);
    $("kg-close").onclick = close;
    $("kg-back").onclick = async () => { const prev = state.history.pop(); if (prev) await load(prev); };
    $("kg-search").value = target.q || "";
    $("kg-search").oninput = onSearchInput;
    $("kg-search").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); goSearch(); } };
    $("kg-go").onclick = goSearch;
    $("kg-merges").onclick = openMerges;
    $("kg-extract-run").onclick = runExtract;
    $("kg-view-star").onclick = () => setView("star");
    $("kg-view-tree").onclick = () => setView("tree");
    state.domainFilter = "all";
    if (state.view !== "star") setView("star");
    state.g3d?.resume();
    await refreshStatus();
    if (target.entry || target.entity || target.q) await load(target);
    else await showStart();
  }

  window.openEntityGraph = openEntityGraph;
})();
