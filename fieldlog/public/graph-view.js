/* v248 關聯圖：以一筆記事為中心，畫出跟它有關的記事與「為什麼有關」。
 * 資料來自 GET /api/graph（正式關聯、語意相似、共同編號）。
 * 版面用簡單的力導向排版（節點最多數十個，直接在瀏覽器算完再畫 SVG），不依賴外部函式庫。
 * 需要 app.js 的全域：api、esc、showToast、FOLDER_CATEGORY_META、openEntry、showEntryPreview、PREVIEW_ENABLED。
 */
(function () {
  const KIND_META = {
    relation: { label: "正式關聯", color: "#2f6f5e", dash: "", width: 2.6, length: 140, rank: 3 },
    identifier: { label: "共同編號", color: "#c2410c", dash: "2 5", width: 2.2, length: 170, rank: 2 },
    similar: { label: "內容相似", color: "#64748b", dash: "7 5", width: 1.6, length: 210, rank: 1 },
  };
  const NODE_ICON = { link: "🔗", audio: "🎙️", photo: "🖼️", video: "🎬", file: "📄", note: "📝" };
  const state = { data: null, center: null, min: 0.6, hidden: new Set(), selected: null, history: [] };

  function $(id) { return document.getElementById(id); }
  function nodeColor(node) { return (FOLDER_CATEGORY_META[node.category] || FOLDER_CATEGORY_META.misc).accent; }
  function strongestKind(edge) { return [...edge.kinds].sort((a, b) => KIND_META[b].rank - KIND_META[a].rank)[0]; }
  function shortTitle(text, n = 14) { const t = String(text || ""); return t.length > n ? `${t.slice(0, n)}…` : t; }

  /** 力導向排版：中心固定在原點，其他節點受排斥、彈簧、向心力影響，跑固定步數後停止。 */
  function layout(nodes, edges, centerId) {
    const pos = new Map();
    const others = nodes.filter((n) => n.id !== centerId);
    others.forEach((n, i) => {
      const angle = (i / Math.max(1, others.length)) * Math.PI * 2;
      const edge = edges.find((e) => (e.source === n.id && e.target === centerId) || (e.target === n.id && e.source === centerId));
      const r = edge ? KIND_META[strongestKind(edge)].length : 260;
      pos.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 });
    });
    pos.set(centerId, { x: 0, y: 0, vx: 0, vy: 0, fixed: true });
    const ids = [...pos.keys()];
    for (let step = 0; step < 450; step++) {
      const cooling = 1 - step / 500;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i]), b = pos.get(ids[j]);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = 12000 / d2;
          const d = Math.sqrt(d2);
          a.vx += (dx / d) * f; a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const a = pos.get(e.source), b = pos.get(e.target);
        if (!a || !b) continue;
        const kind = strongestKind(e);
        let length = KIND_META[kind].length;
        if (kind === "similar" && e.score) length -= (e.score - 0.6) * 300;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = (d - length) * 0.04;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const id of ids) {
        const p = pos.get(id);
        if (p.fixed) { p.vx = p.vy = 0; continue; }
        p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
        p.x += Math.max(-30, Math.min(30, p.vx)) * cooling;
        p.y += Math.max(-30, Math.min(30, p.vy)) * cooling;
        p.vx *= 0.6; p.vy *= 0.6;
      }
    }
    return pos;
  }

  function visibleGraph() {
    const { nodes, edges, center } = state.data;
    const shownEdges = edges.filter((e) => e.kinds.some((k) => !state.hidden.has(k)));
    const keep = new Set([center]);
    for (const e of shownEdges) { keep.add(e.source); keep.add(e.target); }
    return { nodes: nodes.filter((n) => keep.has(n.id)), edges: shownEdges.map((e) => ({ ...e, kinds: e.kinds.filter((k) => !state.hidden.has(k)) })) };
  }

  function render() {
    const svg = $("graph-svg");
    const { nodes, edges } = visibleGraph();
    const center = state.data.center;
    const pos = layout(nodes, edges, center);
    const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
    const pad = 70;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    svg.setAttribute("viewBox", `${minX} ${minY} ${Math.max(200, maxX - minX)} ${Math.max(200, maxY - minY)}`);
    const edgeSvg = edges.map((e, index) => {
      const a = pos.get(e.source), b = pos.get(e.target);
      if (!a || !b) return "";
      const kind = strongestKind(e);
      const meta = KIND_META[kind];
      const opacity = kind === "similar" ? Math.min(0.9, 0.35 + Math.max(0, (e.score || 0.6) - 0.55) * 2) : 0.9;
      return `<line class="graph-edge" data-edge="${index}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${meta.color}" stroke-width="${meta.width}" stroke-dasharray="${meta.dash}" stroke-opacity="${opacity}"><title>${esc(e.labels.join("、"))}</title></line>`;
    }).join("");
    const nodeSvg = nodes.map((n) => {
      const p = pos.get(n.id);
      const isCenter = n.id === center;
      const r = isCenter ? 17 : 11;
      const selected = state.selected === n.id;
      return `<g class="graph-node${isCenter ? " is-center" : ""}${selected ? " is-selected" : ""}" data-node="${n.id}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.title)}">
        <circle r="${r + 6}" fill="transparent"></circle>
        <circle r="${r}" fill="${nodeColor(n)}" stroke="${selected ? "#111" : "#fff"}" stroke-width="${selected ? 3 : 2}" ${n.embedded ? "" : 'stroke-dasharray="3 2"'}></circle>
        <text class="graph-icon" y="4" text-anchor="middle" font-size="${isCenter ? 14 : 10}">${NODE_ICON[n.kind] || "📝"}</text>
        <text class="graph-label" y="${r + 15}" text-anchor="middle">${esc(shortTitle(n.title, isCenter ? 22 : 14))}</text>
        <title>${esc(n.title)}${n.path ? `\n${esc(n.path)}` : ""}</title>
      </g>`;
    }).join("");
    svg.innerHTML = `<g class="graph-edges">${edgeSvg}</g><g class="graph-nodes">${nodeSvg}</g>`;
    svg.querySelectorAll(".graph-node").forEach((g) => {
      const id = Number(g.dataset.node);
      g.onclick = () => selectNode(id);
      g.ondblclick = () => recenter(id);
      g.onkeydown = (ev) => { if (ev.key === "Enter") selectNode(id); };
    });
    renderInfo();
  }

  function reasonsFor(nodeId) {
    const center = state.data.center;
    const edge = state.data.edges.find((e) => (e.source === nodeId && e.target === center) || (e.target === nodeId && e.source === center));
    const via = state.data.edges.filter((e) => (e.source === nodeId || e.target === nodeId) && e !== edge);
    return { edge, via };
  }

  function renderInfo() {
    const box = $("graph-info");
    const node = state.data.nodes.find((n) => n.id === state.selected) || state.data.nodes.find((n) => n.id === state.data.center);
    const isCenter = node.id === state.data.center;
    const { edge, via } = reasonsFor(node.id);
    const reasons = edge ? edge.kinds.map((k) => {
      const labels = (edge.reasons || []).filter((r) => r.kind === k).map((r) => r.label);
      return `<li><span class="graph-dot" style="background:${KIND_META[k].color}"></span>${KIND_META[k].label}${labels.length ? `：${esc(labels.join("、"))}` : ""}</li>`;
    }).join("") : "";
    const viaText = via.length ? `<p class="sub">也連到圖上其他 ${via.length} 筆</p>` : "";
    const canSave = !isCenter && !(edge && edge.kinds.includes("relation"));
    box.innerHTML = `
      <p class="graph-info-kind">${isCenter ? "中心" : "相關記事"}</p>
      <h3>${esc(node.title)}</h3>
      <p class="sub">${esc(node.path || "待分類")}｜${esc(String(node.created_at || "").slice(0, 10))}${node.att_count ? `｜📎${node.att_count}` : ""}${node.embedded ? "" : "｜尚未建立語意向量"}</p>
      ${reasons ? `<ul class="graph-reasons">${reasons}</ul>` : ""}${viaText}
      <div class="graph-info-actions">
        <button class="btn small primary" type="button" data-act="open">開啟</button>
        ${isCenter ? "" : `<button class="btn small" type="button" data-act="center">以這筆為中心</button>`}
        ${canSave ? `<button class="btn small" type="button" data-act="save">存成正式關聯</button>` : ""}
      </div>`;
    box.querySelector('[data-act="open"]').onclick = () => openNode(node.id);
    box.querySelector('[data-act="center"]')?.addEventListener("click", () => recenter(node.id));
    box.querySelector('[data-act="save"]')?.addEventListener("click", () => saveRelation(node.id));
  }

  function selectNode(id) { state.selected = id; render(); }

  async function recenter(id) {
    if (id === state.data.center) return;
    state.history.push(state.data.center);
    await load({ type: "entry", id });
  }

  function openNode(id) {
    close();
    if (PREVIEW_ENABLED && matchMedia("(min-width: 1000px)").matches && typeof showEntryPreview === "function") {
      showEntryPreview(id).catch((error) => showToast("開啟失敗：" + error.message));
    } else {
      openEntry(id);
    }
  }

  async function saveRelation(id) {
    const type = prompt("關聯類型（例如：參考資料、同一產品、引用標準）", "相關");
    if (!type || !type.trim()) return;
    try {
      await api("/relations", { method: "POST", body: JSON.stringify({ from_entry_id: state.data.center, to_entry_id: id, relation_type: type.trim() }) });
      showToast("已存成正式關聯");
      await load({ type: "entry", id: state.data.center }, { keepSelection: id });
    } catch (error) { showToast("存檔失敗：" + error.message); }
  }

  function renderStats() {
    const s = state.data.stats;
    const embedded = s.total_entries - s.pending_embeddings;
    $("graph-stats").innerHTML = `${state.data.nodes.length - 1} 筆相關：正式關聯 ${s.relations}、內容相似 ${s.similar}、共同編號 ${state.data.identifiers.length ? esc(state.data.identifiers.join("、")) : "無"}
      ${s.pending_embeddings ? `<br>語意向量已建立 ${embedded}／${s.total_entries} 筆記事，另有 ${s.pending_embeddings} 筆還沒建立，可能漏掉相似項目。<button class="btn small" type="button" id="graph-backfill">補齊語意向量</button>` : ""}
      ${(state.data.notes || []).map((n) => `<br>${esc(n)}`).join("")}`;
    const back = $("graph-backfill");
    if (back) back.onclick = async () => {
      back.disabled = true;
      try {
        const r = await api("/admin/backfill-embeddings?limit=100", { method: "POST", body: "{}" });
        showToast(`已排入 ${r.queued} 筆，在背景建立中（還剩約 ${Math.max(0, r.remaining)} 筆，可再按一次）。幾分鐘後重開關聯圖即可。`);
      } catch (error) { showToast("排入失敗：" + error.message); back.disabled = false; }
    };
  }

  async function load(target, { keepSelection = null } = {}) {
    $("graph-svg").innerHTML = "";
    $("graph-info").innerHTML = `<p class="sub">讀取關聯中…</p>`;
    try {
      const data = await api(`/graph?type=${encodeURIComponent(target.type)}&id=${encodeURIComponent(target.id)}&min=${state.min}`);
      state.data = data;
      state.selected = keepSelection || data.center;
      const centerNode = data.nodes.find((n) => n.id === data.center);
      $("graph-title").textContent = `關聯圖：${centerNode?.title || ""}`;
      $("graph-back").hidden = !state.history.length;
      renderStats();
      if (data.nodes.length <= 1) {
        $("graph-svg").innerHTML = "";
        $("graph-info").innerHTML = `<h3>${esc(centerNode?.title || "")}</h3><p class="sub">目前找不到相關的記事。可以把相似度門檻調低，或先補齊語意向量；也可以在記事裡用「🔗 新增關聯」手動連結。</p>`;
        return;
      }
      render();
    } catch (error) {
      $("graph-info").innerHTML = `<p class="sub">關聯圖讀取失敗：${esc(error.message)}</p>`;
    }
  }

  function close() {
    $("graph-overlay").classList.remove("open");
    $("graph-overlay").setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) { if (ev.key === "Escape") close(); }

  async function openRelationGraph(target) {
    if (!target?.id) return;
    state.history = [];
    state.hidden = new Set([...document.querySelectorAll("[data-graph-kind]")].filter((c) => !c.checked).map((c) => c.dataset.graphKind));
    const overlay = $("graph-overlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onKey);
    $("graph-close").onclick = close;
    $("graph-back").onclick = async () => { const prev = state.history.pop(); if (prev) await load({ type: "entry", id: prev }); };
    $("graph-min").value = String(state.min);
    $("graph-min").onchange = async () => { state.min = Number($("graph-min").value); await load({ type: "entry", id: state.data?.center || target.id }); };
    document.querySelectorAll("[data-graph-kind]").forEach((c) => {
      c.onchange = () => {
        if (c.checked) state.hidden.delete(c.dataset.graphKind); else state.hidden.add(c.dataset.graphKind);
        if (state.data && state.data.nodes.length > 1) render();
      };
    });
    await load(target);
  }

  window.openRelationGraph = openRelationGraph;
  window.__graphLayoutForTests = layout;
})();
