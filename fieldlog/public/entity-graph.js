/* v254 實體關聯圖（知識圖譜試做）。
 * 方框＝AI 擷取的實體（廠商、材料、設備、人員、技術…類型由 AI 自己判斷），圓點＝資料。
 * 資料來自 /api/kg/*：擷取（逐批）、搜尋關鍵字、建圖、合併建議、標為雜訊。
 * 需要 app.js 的全域：api、esc、showToast、openEntry、showEntryPreview、PREVIEW_ENABLED。
 */
(function () {
  const PALETTE = ["#0f766e", "#b45309", "#7c3aed", "#be123c", "#1d4ed8", "#15803d", "#a16207", "#0e7490", "#9333ea", "#c2410c", "#4d7c0f", "#475569"];
  const DOC_ICON = { link: "🔗", audio: "🎙️", photo: "🖼️", video: "🎬", file: "📄", note: "📝" };
  const state = { data: null, history: [], hiddenTypes: new Set(), selected: null, folder: null, searchResults: [], extracting: false, stopRequested: false };

  function $(id) { return document.getElementById(id); }
  // 類型顏色依「第一次出現」的順序分配，同一次使用中不會變色，也不會像雜湊那樣兩個類型撞同色
  const typeColors = new Map();
  function typeColor(type) {
    const key = String(type || "其他");
    if (!typeColors.has(key)) typeColors.set(key, PALETTE[typeColors.size % PALETTE.length]);
    return typeColors.get(key);
  }
  function short(text, n) { const t = String(text || ""); return t.length > n ? `${t.slice(0, n)}…` : t; }

  function visible() {
    const { nodes, edges, center } = state.data;
    const keepNodes = nodes.filter((n) => n.id === center || n.kind === "doc" || !state.hiddenTypes.has(n.type));
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

  function layout(nodes, edges, centerId) {
    const pos = new Map();
    const others = nodes.filter((n) => n.id !== centerId);
    others.forEach((n, i) => {
      const angle = (i / Math.max(1, others.length)) * Math.PI * 2;
      const r = n.kind === "entity" ? 170 : 290;
      pos.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 });
    });
    pos.set(centerId, { x: 0, y: 0, vx: 0, vy: 0, fixed: true });
    const ids = [...pos.keys()];
    for (let step = 0; step < 420; step++) {
      const cooling = 1 - step / 460;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i]), b = pos.get(ids[j]);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = 14000 / d2, d = Math.sqrt(d2);
          a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const a = pos.get(e.source), b = pos.get(e.target);
        if (!a || !b) continue;
        const length = e.kind === "relation" ? 150 : 120;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = (d - length) * 0.035;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const id of ids) {
        const p = pos.get(id);
        if (p.fixed) { p.vx = p.vy = 0; continue; }
        p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
        p.x += Math.max(-30, Math.min(30, p.vx)) * cooling; p.y += Math.max(-30, Math.min(30, p.vy)) * cooling;
        p.vx *= 0.6; p.vy *= 0.6;
      }
    }
    return pos;
  }

  function render() {
    const svg = $("kg-svg");
    if (!state.data) { svg.innerHTML = ""; return; }
    const { nodes, edges } = visible();
    const center = state.data.center;
    const pos = layout(nodes, edges, center);
    const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
    const pad = 80;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    svg.setAttribute("viewBox", `${minX} ${minY} ${Math.max(220, maxX - minX)} ${Math.max(220, maxY - minY)}`);
    const edgeSvg = edges.map((e) => {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) return "";
      if (e.kind === "relation") {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        return `<line class="kg-edge relation" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#334155" stroke-width="2.4"></line>
          <text class="kg-edge-label" x="${mx}" y="${my - 4}" text-anchor="middle">${esc(e.label)}</text>`;
      }
      return `<line class="kg-edge mention" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#94a3b8" stroke-width="${0.6 + e.weight * 0.5}" stroke-opacity="0.75"><title>${esc(e.evidence || "")}</title></line>`;
    }).join("");
    const nodeSvg = nodes.map((n) => {
      const p = pos.get(n.id);
      const isCenter = n.id === center;
      const selected = state.selected === n.id;
      if (n.kind === "entity") {
        const label = short(n.title, isCenter ? 24 : 18);
        const w = Math.max(44, Math.min(230, [...label].reduce((sum, ch) => sum + (/[\u2E80-\uFFFF]/.test(ch) ? 13 : 7.5), 0) + 20)), h = isCenter ? 30 : 24;
        return `<g class="kg-node entity${isCenter ? " is-center" : ""}${selected ? " is-selected" : ""}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.title)}">
          <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="7" fill="${typeColor(n.type)}" stroke="${selected ? "#111" : "#fff"}" stroke-width="${selected ? 3 : 1.5}"></rect>
          <text class="kg-entity-label" y="5" text-anchor="middle">${esc(label)}</text>
          <title>${esc(n.title)}｜${esc(n.type)}｜${n.docs} 份資料</title>
        </g>`;
      }
      const r = isCenter ? 15 : 9;
      return `<g class="kg-node doc${isCenter ? " is-center" : ""}${selected ? " is-selected" : ""}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.title)}">
        <circle r="${r + 7}" fill="transparent"></circle>
        <circle r="${r}" fill="#e2e8f0" stroke="${selected ? "#111" : "#64748b"}" stroke-width="${selected ? 3 : 1.2}"></circle>
        <text y="4" text-anchor="middle" font-size="${isCenter ? 13 : 9}">${DOC_ICON[n.doc_kind] || "📝"}</text>
        <text class="graph-label" y="${r + 14}" text-anchor="middle">${esc(short(n.title, isCenter ? 22 : 12))}</text>
        <title>${esc(n.title)}\n${esc(n.path || "")}</title>
      </g>`;
    }).join("");
    svg.innerHTML = `<g>${edgeSvg}</g><g>${nodeSvg}</g>`;
    svg.querySelectorAll(".kg-node").forEach((g) => {
      const id = g.dataset.node;
      g.onclick = () => { state.selected = id; render(); };
      g.ondblclick = () => recenter(id);
      g.onkeydown = (ev) => { if (ev.key === "Enter") { state.selected = id; render(); } };
    });
    renderTypes();
    renderInfo();
  }

  function renderTypes() {
    const box = $("kg-types");
    const counts = new Map();
    for (const n of state.data.nodes) if (n.kind === "entity" && n.id !== state.data.center) counts.set(n.type, (counts.get(n.type) || 0) + 1);
    box.innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => `
      <label class="kg-type-chip${state.hiddenTypes.has(type) ? " off" : ""}"><input type="checkbox" data-kg-type="${esc(type)}" ${state.hiddenTypes.has(type) ? "" : "checked"}>
        <i style="background:${typeColor(type)}"></i>${esc(type)} <small>${count}</small></label>`).join("");
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
        <p class="graph-info-kind">${isCenter ? "中心實體" : "實體"}｜<span class="kg-type-tag" style="background:${typeColor(node.type)}">${esc(node.type)}</span>${node.type_label && node.type_label !== node.type ? ` <small class="sub">（AI 原標：${esc(node.type_label)}）</small>` : ""}</p>
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
        ${ents.length ? `<p class="kg-section">提到的實體</p><ul class="kg-list">${ents.map(({ ent, e }) => `<li><span class="kg-type-tag" style="background:${typeColor(ent.type)}">${esc(ent.type)}</span> <button class="link-btn" type="button" data-pick="${esc(ent.id)}">${esc(ent.title)}</button>${e.evidence ? `<br><q>${esc(e.evidence)}</q>` : ""}</li>`).join("")}</ul>` : ""}
        <div class="graph-info-actions">
          <button class="btn small primary" type="button" data-act="open">開啟</button>
          ${isCenter ? "" : `<button class="btn small" type="button" data-act="center">以這筆為中心</button>`}
        </div>`;
    }
    box.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => openDoc(b.dataset.open); });
    box.querySelectorAll("[data-pick]").forEach((b) => { b.onclick = () => { state.selected = b.dataset.pick; render(); }; });
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
      $("kg-svg").innerHTML = "";
      $("kg-types").innerHTML = "";
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
    $("kg-svg").innerHTML = "";
    $("kg-types").innerHTML = "";
    try {
      const r = await api("/kg/search?q=");
      if (!r.results.length) {
        $("kg-info").innerHTML = `<p class="sub">還沒有擷取過實體。${state.folder ? "按上方「擷取這個資料夾的實體」開始。" : "請到要試做的資料夾（例如檢體針專案），按資料夾工具列的「實體關聯」再擷取。"}</p>`;
        return;
      }
      $("kg-info").innerHTML = `<p class="graph-info-kind">從這裡開始</p><p class="sub">輸入關鍵字，或點一個常出現的實體：</p>
        <ul class="kg-list kg-start">${r.results.map((e) => `<li><span class="kg-type-tag" style="background:${typeColor(e.type_group)}">${esc(e.type_group)}</span> <button class="link-btn" type="button" data-start="${e.id}">${esc(e.name)}</button> <small class="sub">${e.docs} 份</small></li>`).join("")}</ul>`;
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
        $("kg-search-list").innerHTML = r.results.map((e) => `<option value="${esc(e.name)}">${esc(e.type_group)}｜${e.docs} 份</option>`).join("");
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

  function close() {
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
    await refreshStatus();
    if (target.entry || target.entity || target.q) await load(target);
    else await showStart();
  }

  window.openEntityGraph = openEntityGraph;
  window.__kgLayoutForTests = layout;
})();
