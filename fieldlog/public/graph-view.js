/* v248 關聯圖：以一筆記事為中心，畫出跟它有關的記事與「為什麼有關」。
 * 資料來自 GET /api/graph（正式關聯、語意相似、共同編號）。
 * v255 起改用共用的 3D 引擎（graph3d.js）：可旋轉、縮放、拖節點，有透視與落影。
 * 需要 app.js 的全域：api、esc、showToast、FOLDER_CATEGORY_META、openEntry、showEntryPreview、PREVIEW_ENABLED。
 */
(function () {
  const KIND_META = {
    relation: { label: "正式關聯", color: "#2f6f5e", dash: "", width: 2.6, length: 140, rank: 3 },
    identifier: { label: "共同編號", color: "#c2410c", dash: "2 5", width: 2.2, length: 170, rank: 2 },
    similar: { label: "內容相似", color: "#64748b", dash: "7 5", width: 1.6, length: 210, rank: 1 },
  };
  const NODE_ICON = { link: "🔗", audio: "🎙️", photo: "🖼️", video: "🎬", file: "📄", note: "📝" };
  const state = { data: null, center: null, min: 0.6, hidden: new Set(), selected: null, history: [], synth: null, synthMode: false, synthBusy: false };

  function $(id) { return document.getElementById(id); }
  function nodeColor(node) { return (FOLDER_CATEGORY_META[node.category] || FOLDER_CATEGORY_META.misc).accent; }
  function strongestKind(edge) { return [...edge.kinds].sort((a, b) => KIND_META[b].rank - KIND_META[a].rank)[0]; }
  function shortTitle(text, n = 14) { const t = String(text || ""); return t.length > n ? `${t.slice(0, n)}…` : t; }

  /** 3D 引擎：第一次用到才建立（overlay 打開後才有尺寸） */
  function engine() {
    if (!state.g3d) {
      state.g3d = Graph3D.create($("graph-stage"), {
        label: "立體關聯圖：拖曳旋轉，滾輪縮放，點節點看說明",
        onSelect: (id) => selectNode(id),
        onActivate: (id) => recenter(id),
      });
    }
    return state.g3d;
  }

  function visibleGraph() {
    const { nodes, edges, center } = state.data;
    const shownEdges = edges.filter((e) => e.kinds.some((k) => !state.hidden.has(k)));
    const keep = new Set([center]);
    for (const e of shownEdges) { keep.add(e.source); keep.add(e.target); }
    return { nodes: nodes.filter((n) => keep.has(n.id)), edges: shownEdges.map((e) => ({ ...e, kinds: e.kinds.filter((k) => !state.hidden.has(k)) })) };
  }

  /** 畫圖：資料或篩選改變時呼叫；只換選取請用 selectNode（不重新排版，畫面不會跳動） */
  function render() {
    const { nodes, edges } = visibleGraph();
    const center = state.data.center;
    const g = engine();
    g.setData({
      center,
      selected: state.selected,
      nodes: nodes.map((n) => ({ id: n.id, kind: "doc", label: n.title, color: nodeColor(n), icon: NODE_ICON[n.kind] || "📝", center: n.id === center, dashed: !n.embedded, tip: `${n.title}${n.path ? `\n${n.path}` : ""}` })),
      edges: edges.map((e) => {
        const kind = strongestKind(e), meta = KIND_META[kind];
        let length = meta.length;
        if (kind === "similar" && e.score) length -= (e.score - 0.6) * 300;
        const opacity = kind === "similar" ? Math.min(0.9, 0.35 + Math.max(0, (e.score || 0.6) - 0.55) * 2) : 0.9;
        return { source: e.source, target: e.target, color: meta.color, width: meta.width, dash: meta.dash ? meta.dash.split(" ").map(Number) : null, opacity, length, tip: e.labels.join("、") };
      }),
    });
    if (state.synthMode) renderSynth(); else renderInfo();
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

  function selectNode(id) { state.selected = id; state.synthMode = false; $("graph-body")?.classList.remove("synth"); state.g3d?.setSelected(id); renderInfo(); }

  // ---- v249 AI 綜整：把圖上顯示的資料一起交給 AI 做橫向整理 ----
  /** 圖上目前顯示的節點，中心第一，其餘依關聯強度（正式關聯＞共同編號＞相似度）排，最多 20 筆 */
  function synthIds() {
    const { nodes, edges } = visibleGraph();
    const center = state.data.center;
    const strength = (id) => {
      const e = edges.find((x) => (x.source === id && x.target === center) || (x.target === id && x.source === center));
      if (!e) return 0;
      return (e.kinds.includes("relation") ? 3 : 0) + (e.kinds.includes("identifier") ? 2 : 0) + (e.score || 0);
    };
    return [center, ...nodes.filter((n) => n.id !== center).map((n) => n.id).sort((a, b) => strength(b) - strength(a))].slice(0, 20);
  }

  async function runSynthesis() {
    if (!state.data || state.synthBusy) return;
    const ids = synthIds();
    if (ids.length < 2) { showToast("圖上至少要有兩筆資料才能綜整"); return; }
    const question = $("graph-question").value.trim();
    const button = $("graph-synth");
    state.synthBusy = true; button.disabled = true;
    try {
      const est = await api("/graph/synthesize", { method: "POST", body: JSON.stringify({ center: state.data.center, ids, question, estimate_only: true }) });
      const claims = est.docs.filter((d) => d.claims).length;
      const msg = `AI 會讀圖上 ${est.docs.length} 筆資料（約 ${Math.round(est.estimate.input_tokens / 1000)} 千 token）。`
        + (est.truncated ? `\n長文件只讀部分內容${claims ? `（其中 ${claims} 份優先讀請求項）` : ""}。` : "")
        + `\n預估約用 ${est.estimate.neurons} Neurons，約每日免費額度的 ${est.estimate.percent_of_daily_free}%。\n\n要開始嗎？`;
      if (!confirm(msg)) return;
      state.synthMode = true;
      $("graph-body").classList.add("synth");
      $("graph-info").innerHTML = `<p class="graph-info-kind">AI 綜整</p><p class="sub">AI 正在閱讀 ${est.docs.length} 筆資料，約需 10～40 秒…</p>`;
      const result = await api("/graph/synthesize", { method: "POST", body: JSON.stringify({ center: state.data.center, ids, question }) });
      state.synth = { ...result, ids, question, center: state.data.center };
      render();
    } catch (error) {
      if (state.synthMode) $("graph-info").innerHTML = `<p class="sub">AI 綜整失敗：${esc(error.message)}</p><div class="graph-info-actions"><button class="btn small" type="button" id="graph-synth-back">回到節點資訊</button></div>`;
      else showToast("AI 綜整失敗：" + error.message);
      $("graph-synth-back")?.addEventListener("click", leaveSynth);
    } finally {
      state.synthBusy = false; button.disabled = false;
    }
  }

  function leaveSynth() { state.synthMode = false; $("graph-body").classList.remove("synth"); render(); }

  function renderSynth() {
    const box = $("graph-info");
    const r = state.synth;
    if (!r) return;
    const warnings = [
      r.truncated ? "部分長文件只讀了一部分" : "",
      r.invalid_citations ? `有 ${r.invalid_citations} 處引用編號不在資料中，已標成 [#?]` : "",
    ].filter(Boolean);
    box.innerHTML = `<p class="graph-info-kind">AI 綜整（${r.docs.length} 筆資料）${r.question ? `｜問題：${esc(r.question)}` : ""}</p>
      <p class="graph-synth-note">AI 產生的整理，引用前請點 [#編號] 回原文確認。${warnings.length ? `<br>${esc(warnings.join("；"))}` : ""}</p>
      <div class="graph-synth-body">${r.html}</div>
      <div class="graph-info-actions">
        <button class="btn small primary" type="button" id="graph-synth-save">存成記事</button>
        <button class="btn small" type="button" id="graph-synth-copy">複製文字</button>
        <button class="btn small" type="button" id="graph-synth-back">回到節點資訊</button>
      </div>`;
    box.querySelectorAll(".graph-cite").forEach((el) => {
      const go = () => { state.selected = Number(el.dataset.cite); const keep = box.scrollTop; state.g3d?.setSelected(state.selected); state.synthMode = false; $("graph-body")?.classList.remove("synth"); renderInfo(); $("graph-info").scrollTop = keep; };
      el.onclick = go;
      el.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
      const node = state.data.nodes.find((n) => n.id === Number(el.dataset.cite));
      if (node) el.title = node.title;
    });
    $("graph-synth-back").onclick = leaveSynth;
    $("graph-synth-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(r.markdown); showToast("已複製"); } catch { showToast("無法複製，請手動選取文字"); }
    };
    $("graph-synth-save").onclick = async () => {
      const btn = $("graph-synth-save");
      btn.disabled = true;
      try {
        const saved = await api("/graph/synthesize/save", { method: "POST", body: JSON.stringify({ center: r.center, ids: r.ids, question: r.question, markdown: r.markdown }) });
        showToast(`已存成記事「${saved.title}」，並與 ${saved.sources} 筆來源建立關聯`);
        state.synthMode = false;
        $("graph-body").classList.remove("synth");
        await load({ type: "entry", id: r.center }, { keepSelection: saved.id });
      } catch (error) { showToast("存檔失敗：" + error.message); btn.disabled = false; }
    };
  }

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
    state.g3d?.clear();
    $("graph-info").innerHTML = `<p class="sub">讀取關聯中…</p>`;
    try {
      const data = await api(`/graph?type=${encodeURIComponent(target.type)}&id=${encodeURIComponent(target.id)}&min=${state.min}`);
      state.data = data;
      state.selected = keepSelection || data.center;
      if (data.center !== state.synth?.center) { state.synthMode = false; $("graph-body")?.classList.remove("synth"); }
      const centerNode = data.nodes.find((n) => n.id === data.center);
      $("graph-title").textContent = `關聯圖：${centerNode?.title || ""}`;
      $("graph-back").hidden = !state.history.length;
      renderStats();
      if (data.nodes.length <= 1) {
        state.g3d?.clear();
        $("graph-info").innerHTML = `<h3>${esc(centerNode?.title || "")}</h3><p class="sub">目前找不到相關的記事。可以把相似度門檻調低，或先補齊語意向量；也可以在記事裡用「🔗 新增關聯」手動連結。</p>`;
        return;
      }
      render();
    } catch (error) {
      $("graph-info").innerHTML = `<p class="sub">關聯圖讀取失敗：${esc(error.message)}</p>`;
    }
  }

  function close() {
    state.g3d?.pause();
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
    // v254 切到實體關聯圖（以同一筆資料為中心）
    $("graph-kg").onclick = () => { const id = state.data?.center || target.id; close(); window.openEntityGraph?.({ entry: id }); };
    $("graph-synth").onclick = runSynthesis;
    state.synthMode = false;
    $("graph-body")?.classList.remove("synth");
    $("graph-back").onclick = async () => { const prev = state.history.pop(); if (prev) await load({ type: "entry", id: prev }); };
    $("graph-min").value = String(state.min);
    $("graph-min").onchange = async () => { state.min = Number($("graph-min").value); await load({ type: "entry", id: state.data?.center || target.id }); };
    document.querySelectorAll("[data-graph-kind]").forEach((c) => {
      c.onchange = () => {
        if (c.checked) state.hidden.delete(c.dataset.graphKind); else state.hidden.add(c.dataset.graphKind);
        if (state.data && state.data.nodes.length > 1) render();
      };
    });
    state.g3d?.resume();
    await load(target);
  }

  window.openRelationGraph = openRelationGraph;
})();
