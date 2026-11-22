/* v255 共用的 3D 關聯圖引擎（Canvas，不依賴外部函式庫）。
 * 文件關聯圖（graph-view.js）與實體關聯圖（entity-graph.js）共用。
 *
 * 立體感：3D 力導向排版、透視投影（近大遠小）、遠處變淡、球體節點（高光＋陰影）、地面格線與落影、慣性旋轉。
 * 操作：拖背景＝旋轉視角；拖節點＝移動它（其他節點彈性跟著調整）；Shift／右鍵／雙指拖＝平移；
 *      滾輪或雙指捏合＝縮放（以游標為中心）；點一下＝選取；點兩下＝換中心；鍵盤方向鍵旋轉、＋－縮放、0 重置。
 *
 * 節點 { id, label, kind:'entity'|'doc', color, icon?, center?, dashed?, tip? }
 * 連線 { source, target, color, width, dash?:[a,b], opacity?, length?, label?, tip? }
 */
(function (root) {
  const FONT = "system-ui, -apple-system, 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif";
  const FOCAL = 1400;
  const ZOOM_MIN = 0.2, ZOOM_MAX = 5;
  const DEFAULT_YAW = -0.5, DEFAULT_PITCH = -0.42;

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  }

  /** 3D 力導向排版。keep：沿用舊座標（只換選取或篩選時畫面不跳動）。 */
  function createSim(nodes, edges, centerId, keep = null) {
    const rand = rng(11);
    const pos = new Map();
    const others = nodes.filter((n) => n.id !== centerId);
    others.forEach((n, i) => {
      const old = keep && keep.get(n.id);
      if (old) { pos.set(n.id, { x: old.x, y: old.y, z: old.z, vx: 0, vy: 0, vz: 0 }); return; }
      const k = (i + 0.5) / Math.max(1, others.length);
      const phi = Math.acos(1 - 2 * k), theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = n.kind === 'doc' ? 260 : 170;
      pos.set(n.id, { x: r * Math.sin(phi) * Math.cos(theta), y: r * Math.cos(phi), z: r * Math.sin(phi) * Math.sin(theta), vx: 0, vy: 0, vz: 0 });
    });
    const c = keep && keep.get(centerId);
    pos.set(centerId, { x: c ? c.x : 0, y: c ? c.y : 0, z: c ? c.z : 0, vx: 0, vy: 0, vz: 0, fixed: !c });
    const ids = [...pos.keys()];
    const links = edges.filter((e) => pos.has(e.source) && pos.has(e.target));
    function tick(alpha) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos.get(ids[i]), b = pos.get(ids[j]);
          let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1) { dx = rand() - 0.5; dy = rand() - 0.5; dz = rand() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2), f = 15000 / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
          a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz;
        }
      }
      for (const e of links) {
        const a = pos.get(e.source), b = pos.get(e.target);
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const f = (d - (e.length || 130)) * 0.04;
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz;
      }
      for (const id of ids) {
        const p = pos.get(id);
        if (p.fixed || p.dragging) { p.vx = p.vy = p.vz = 0; continue; }
        p.vx -= p.x * 0.004; p.vy -= p.y * 0.004; p.vz -= p.z * 0.004;
        p.x += Math.max(-30, Math.min(30, p.vx)) * alpha;
        p.y += Math.max(-30, Math.min(30, p.vy)) * alpha;
        p.z += Math.max(-30, Math.min(30, p.vz)) * alpha;
        p.vx *= 0.6; p.vy *= 0.6; p.vz *= 0.6;
      }
    }
    function settle(steps = 380) { for (let s = 0; s < steps; s++) tick(1 - s / (steps + 40)); }
    return { pos, tick, settle };
  }

  function rotate(p, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy;
    return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
  }
  function unrotate(v, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y1 = v.y * cp + v.z * sp, z1 = -v.y * sp + v.z * cp;
    return { x: v.x * cy - z1 * sy, y: y1, z: v.x * sy + z1 * cy };
  }

  function shade(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function create(container, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'g3d-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', opts.label || '立體關聯圖：拖曳旋轉，滾輪縮放，點節點看說明');
    container.appendChild(canvas);
    const tip = document.createElement('div');
    tip.className = 'g3d-tip';
    tip.hidden = true;
    container.appendChild(tip);
    const tools = document.createElement('div');
    tools.className = 'g3d-tools';
    container.appendChild(tools);
    const ctx = canvas.getContext('2d');

    const S = {
      nodes: [], edges: [], byId: new Map(), center: null, selected: null, sim: null, alpha: 0, sig: '',
      yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, vYaw: 0, vPitch: 0, zoom: 1, panX: 0, panY: 0,
      w: 0, h: 0, dpr: 1, dirty: true, raf: 0, paused: false, auto: false, proj: new Map(), hover: null,
      pointers: new Map(), gesture: null, lastTap: { id: null, t: 0 }, measure: new Map(), fitted: false,
    };
    const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- 工具列 ----------
    const buttons = {};
    function addTool(key, text, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      tools.appendChild(b); buttons[key] = b;
    }
    addTool('in', '＋', '放大', () => zoomBy(1.25));
    addTool('out', '－', '縮小', () => zoomBy(0.8));
    addTool('reset', '⟲', '重置視角並置中', () => resetView());
    addTool('flat', '▭', '平面（俯視）', () => flatView());
    addTool('auto', '⟳', '自動旋轉', () => { S.auto = !S.auto; buttons.auto.classList.toggle('on', S.auto); S.vYaw = 0; wake(); });
    if (reduceMotion) buttons.auto.hidden = true;

    function wake() { S.dirty = true; if (!S.raf && !S.paused) S.raf = requestAnimationFrame(frame); }

    // ---------- 視角 ----------
    function bounds() {
      let r = 0;
      for (const p of S.sim ? S.sim.pos.values() : []) r = Math.max(r, Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z));
      return r;
    }
    function fit() {
      const R = bounds() + 90;
      const size = Math.max(120, Math.min(S.w, S.h));
      S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, size / (2 * R) * 1.3));
      S.panX = 0; S.panY = 0; S.fitted = S.w > 0;
    }
    /** 初始視角：在幾個角度裡挑「節點投影後最不互相重疊」的那個，進來就看得清楚 */
    function bestView() {
      const pts = S.sim ? [...S.sim.pos.values()] : [];
      if (pts.length < 3) return { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH };
      let best = { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH }, bestScore = -1;
      for (const pitch of [-0.3, -0.45, -0.6]) {
        for (let k = 0; k < 24; k++) {
          const yaw = (k / 24) * Math.PI * 2 - Math.PI;
          const q = pts.map((p) => rotate(p, yaw, pitch));
          let score = 0;
          for (let i = 0; i < q.length; i++) {
            let nearest = 1e9;
            for (let j = 0; j < q.length; j++) if (i !== j) nearest = Math.min(nearest, Math.hypot(q[i].x - q[j].x, q[i].y - q[j].y));
            score += Math.min(nearest, 140);
          }
          if (score > bestScore) { bestScore = score; best = { yaw, pitch }; }
        }
      }
      return best;
    }
    function resetView() { const v = bestView(); S.yaw = v.yaw; S.pitch = v.pitch; S.vYaw = S.vPitch = 0; fit(); wake(); }
    function flatView() { S.yaw = 0; S.pitch = -Math.PI / 2 + 0.001; S.vYaw = S.vPitch = 0; fit(); wake(); }
    function zoomBy(f, mx = S.w / 2, my = S.h / 2) {
      const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.zoom * f));
      const k = z / S.zoom;
      S.panX = (mx - S.w / 2) - ((mx - S.w / 2 - S.panX) * k);
      S.panY = (my - S.h / 2) - ((my - S.h / 2 - S.panY) * k);
      S.zoom = z; wake();
    }

    // ---------- 資料 ----------
    function setData({ nodes, edges, center, selected = null }) {
      const sig = `${center}|${nodes.map((n) => n.id).sort().join(',')}|${edges.length}`;
      const same = sig === S.sig;
      S.nodes = nodes; S.edges = edges; S.center = center; S.selected = selected;
      S.byId = new Map(nodes.map((n) => [n.id, n]));
      S.measure.clear();
      if (!same || !S.sim) {
        const keep = S.sim ? new Map([...S.sim.pos].map(([k, v]) => [k, { x: v.x, y: v.y, z: v.z }])) : null;
        const reuse = keep && center === S.center0 ? keep : null;
        S.sim = createSim(nodes, edges, center, reuse);
        S.sim.settle(reuse ? 120 : 380);
        S.sig = sig; S.center0 = center;
        if (!S.fitted || !reuse) { const v = bestView(); S.yaw = v.yaw; S.pitch = v.pitch; fit(); }
      }
      wake();
    }
    function setSelected(id) { S.selected = id; wake(); }
    function clear() { S.nodes = []; S.edges = []; S.byId.clear(); S.sim = null; S.sig = ''; S.proj.clear(); wake(); }

    // ---------- 繪製 ----------
    function project(p) {
      const r = rotate(p, S.yaw, S.pitch);
      const s = FOCAL / (FOCAL + r.z);
      return { sx: S.w / 2 + S.panX + r.x * s * S.zoom, sy: S.h / 2 + S.panY + r.y * s * S.zoom, z: r.z, s: s * S.zoom, k: s };
    }
    function textWidth(text, font) {
      const key = font + '|' + text;
      let w = S.measure.get(key);
      if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; S.measure.set(key, w); }
      return w;
    }
    function halo(text, x, y, size, fill, alpha, weight = 400) {
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = alpha;
      ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = '#fbfcfb';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = fill; ctx.fillText(text, x, y);
    }
    function draw() {
      const { w, h } = S;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#f4f7f6'); bg.addColorStop(1, '#e9eeec');
      ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      if (!S.sim) return;
      S.proj.clear();
      let zmin = Infinity, zmax = -Infinity, maxY = 0, maxR = 0;
      for (const n of S.nodes) {
        const p = S.sim.pos.get(n.id); if (!p) continue;
        const q = project(p); q.world = p; S.proj.set(n.id, q);
        zmin = Math.min(zmin, q.z); zmax = Math.max(zmax, q.z); maxY = Math.max(maxY, p.y); maxR = Math.max(maxR, Math.hypot(p.x, p.z));
      }
      const zr = Math.max(1, zmax - zmin);
      const depthAlpha = (z) => 0.5 + 0.5 * (1 - (z - zmin) / zr);

      // 地面：同心橢圓與十字線＋每個節點的落影，讓人看得出高低遠近
      const floorY = maxY + 60, ringR = Math.max(200, maxR + 40);
      ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = '#64748b';
      for (let i = 1; i <= 3; i++) {
        const R = (ringR * i) / 3;
        ctx.globalAlpha = 0.16; ctx.beginPath();
        for (let a = 0; a <= 48; a++) {
          const t = (a / 48) * Math.PI * 2, q = project({ x: Math.cos(t) * R, y: floorY, z: Math.sin(t) * R });
          if (a === 0) ctx.moveTo(q.sx, q.sy); else ctx.lineTo(q.sx, q.sy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.1; ctx.beginPath();
      const axes = [[{ x: -ringR, y: floorY, z: 0 }, { x: ringR, y: floorY, z: 0 }], [{ x: 0, y: floorY, z: -ringR }, { x: 0, y: floorY, z: ringR }]];
      for (const [a, b] of axes) { const qa = project(a), qb = project(b); ctx.moveTo(qa.sx, qa.sy); ctx.lineTo(qb.sx, qb.sy); }
      ctx.stroke(); ctx.restore();
      for (const n of S.nodes) {
        const q = S.proj.get(n.id); if (!q) continue;
        const f = project({ x: q.world.x, y: floorY, z: q.world.z });
        const r = (n.kind === 'doc' ? (n.center ? 15 : 10) : (n.center ? 16 : 12)) * q.s;
        ctx.globalAlpha = 0.13 * depthAlpha(q.z);
        ctx.strokeStyle = '#475569'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(f.sx, f.sy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#334155'; ctx.globalAlpha = 0.16 * depthAlpha(q.z);
        ctx.beginPath(); ctx.ellipse(f.sx, f.sy, r * 1.5, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      }

      // 連線（遠的先畫）
      const edgeList = S.edges.map((e) => ({ e, a: S.proj.get(e.source), b: S.proj.get(e.target) })).filter((x) => x.a && x.b);
      edgeList.sort((x, y) => (y.a.z + y.b.z) - (x.a.z + x.b.z));
      for (const { e, a, b } of edgeList) {
        const z = (a.z + b.z) / 2, s = (a.k + b.k) / 2 * S.zoom;
        ctx.globalAlpha = (e.opacity ?? 0.85) * depthAlpha(z);
        ctx.strokeStyle = e.color || '#94a3b8'; ctx.lineWidth = Math.max(0.6, (e.width || 1.4) * Math.min(1.6, s));
        ctx.setLineDash(e.dash ? e.dash.map((d) => d * Math.max(0.7, s)) : []);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); ctx.setLineDash([]);
        if (e.label) halo(e.label, (a.sx + b.sx) / 2, (a.sy + b.sy) / 2 - 6, Math.max(10, 12 * Math.min(1.3, s)), '#1e293b', depthAlpha(z), 700);
      }

      // 節點（遠的先畫）
      const order = S.nodes.filter((n) => S.proj.has(n.id)).sort((x, y) => S.proj.get(y.id).z - S.proj.get(x.id).z);
      for (const n of order) {
        const q = S.proj.get(n.id), isSel = S.selected === n.id, isHover = S.hover === n.id, da = depthAlpha(q.z);
        const sc = Math.max(0.55, Math.min(2.2, q.s));
        ctx.globalAlpha = da;
        if (n.kind === 'entity') {
          const fs = Math.max(9.5, (n.center ? 14 : 12) * sc);
          const font = `600 ${fs}px ${FONT}`;
          const wText = textWidth(n.label, font);
          const bw = wText + 22 * sc, bh = (n.center ? 30 : 25) * sc;
          q.hit = { type: 'rect', w: bw / 2 + 4, h: bh / 2 + 4 };
          ctx.save(); ctx.shadowColor = 'rgba(15,23,42,0.35)'; ctx.shadowBlur = 10 * sc; ctx.shadowOffsetY = 4 * sc;
          const g = ctx.createLinearGradient(0, q.sy - bh / 2, 0, q.sy + bh / 2);
          g.addColorStop(0, shade(n.color, 0.22)); g.addColorStop(1, shade(n.color, -0.18));
          ctx.fillStyle = g; ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(q.sx - bw / 2, q.sy - bh / 2, bw, bh, 8 * sc); else ctx.rect(q.sx - bw / 2, q.sy - bh / 2, bw, bh);
          ctx.fill(); ctx.restore();
          ctx.globalAlpha = da; ctx.lineWidth = isSel ? 3 : isHover ? 2.2 : 1.2; ctx.strokeStyle = isSel ? '#111827' : 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(q.sx - bw / 2, q.sy - bh / 2, bw, bh, 8 * sc); else ctx.rect(q.sx - bw / 2, q.sy - bh / 2, bw, bh);
          ctx.stroke();
          ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.globalAlpha = Math.max(0.75, da);
          ctx.fillText(n.label, q.sx, q.sy + 0.5);
        } else {
          const r = (n.center ? 15 : 10) * sc;
          q.hit = { type: 'circle', r: r + 6 };
          ctx.save(); ctx.shadowColor = 'rgba(15,23,42,0.35)'; ctx.shadowBlur = 9 * sc; ctx.shadowOffsetY = 4 * sc;
          const g = ctx.createRadialGradient(q.sx - r * 0.38, q.sy - r * 0.42, r * 0.1, q.sx, q.sy, r * 1.05);
          g.addColorStop(0, shade(n.color, 0.6)); g.addColorStop(0.55, n.color); g.addColorStop(1, shade(n.color, -0.38));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          ctx.globalAlpha = da; ctx.lineWidth = isSel ? 3 : isHover ? 2.2 : 1.4;
          ctx.strokeStyle = isSel ? '#111827' : 'rgba(255,255,255,0.9)'; ctx.setLineDash(n.dashed ? [3, 2] : []);
          ctx.beginPath(); ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          if (n.icon) { ctx.font = `${Math.round(r * 1.15)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.globalAlpha = Math.max(0.8, da); ctx.fillText(n.icon, q.sx, q.sy + 1); }
          halo(n.label.length > 16 ? `${n.label.slice(0, 16)}…` : n.label, q.sx, q.sy + r + 12 * Math.min(1.2, sc), Math.max(9.5, (n.center ? 13 : 11) * sc), '#1f2937', Math.max(0.6, da), n.center ? 700 : 400);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ---------- 動畫迴圈：只在需要時才跑 ----------
    function frame() {
      S.raf = 0;
      if (S.paused || !S.w) { return; }
      let busy = false;
      if (S.sim && S.alpha > 0.02) { S.sim.tick(S.alpha); S.alpha *= 0.96; busy = true; }
      if (!S.gesture || S.gesture.mode !== 'orbit') {
        if (Math.abs(S.vYaw) > 0.0004 || Math.abs(S.vPitch) > 0.0004) {
          S.yaw += S.vYaw; S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch + S.vPitch));
          S.vYaw *= 0.93; S.vPitch *= 0.93; busy = true;
        }
        if (S.auto && !S.gesture) { S.yaw += 0.0035; busy = true; }
      }
      if (S.dirty || busy) { draw(); S.dirty = false; }
      if (busy || S.dirty) S.raf = requestAnimationFrame(frame);
    }

    // ---------- 互動 ----------
    function local(ev) { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
    function hitTest(x, y) {
      const list = [...S.proj.entries()].sort((a, b) => a[1].z - b[1].z);
      for (const [id, q] of list) {
        if (!q.hit) continue;
        if (q.hit.type === 'circle' ? Math.hypot(x - q.sx, y - q.sy) <= q.hit.r : Math.abs(x - q.sx) <= q.hit.w && Math.abs(y - q.sy) <= q.hit.h) return id;
      }
      return null;
    }
    function showTip(id, x, y) {
      const n = id !== null ? S.byId.get(id) : null;
      if (!n || !n.tip) { tip.hidden = true; return; }
      tip.textContent = n.tip; tip.hidden = false;
      tip.style.left = `${Math.min(S.w - 200, x + 14)}px`; tip.style.top = `${Math.min(S.h - 40, y + 14)}px`;
    }
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('pointerdown', (ev) => {
      canvas.setPointerCapture(ev.pointerId); canvas.focus({ preventScroll: true });
      const p = local(ev);
      S.pointers.set(ev.pointerId, p);
      S.vYaw = S.vPitch = 0; tip.hidden = true;
      if (S.pointers.size === 2) {
        const [a, b] = [...S.pointers.values()];
        S.gesture = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: S.zoom, moved: true };
        return;
      }
      const id = hitTest(p.x, p.y);
      const pan = ev.button === 2 || ev.shiftKey || ev.ctrlKey || ev.button === 1;
      S.gesture = id !== null && !pan
        ? { mode: 'node', id, sx: p.x, sy: p.y, moved: false }
        : { mode: pan ? 'pan' : 'orbit', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
      if (S.gesture.mode === 'node') { const pos = S.sim.pos.get(id); pos.dragging = true; canvas.style.cursor = 'grabbing'; }
      else canvas.style.cursor = 'grabbing';
      wake();
    });
    canvas.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      if (!S.pointers.has(ev.pointerId)) {
        const id = hitTest(p.x, p.y);
        if (id !== S.hover) { S.hover = id; canvas.style.cursor = id !== null ? 'pointer' : 'grab'; wake(); }
        showTip(id, p.x, p.y);
        return;
      }
      const prev = S.pointers.get(ev.pointerId);
      S.pointers.set(ev.pointerId, p);
      const g = S.gesture; if (!g) return;
      if (g.mode === 'pinch' && S.pointers.size >= 2) {
        const [a, b] = [...S.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, g.z0 * (d / Math.max(10, g.d0))));
        zoomBy(target / S.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
        S.panX += (p.x - prev.x) / 2; S.panY += (p.y - prev.y) / 2; wake();
        return;
      }
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > 4) g.moved = true;
      if (g.mode === 'node') {
        const pos = S.sim.pos.get(g.id), q = S.proj.get(g.id);
        if (!g.moved || !q) return;
        const dx = (p.x - prev.x) / q.s, dy = (p.y - prev.y) / q.s;
        const w = unrotate({ x: dx, y: dy, z: 0 }, S.yaw, S.pitch);
        pos.x += w.x; pos.y += w.y; pos.z += w.z;
        S.alpha = Math.max(S.alpha, 0.35); wake();
      } else if (g.mode === 'pan') {
        S.panX += p.x - prev.x; S.panY += p.y - prev.y; wake();
      } else if (g.mode === 'orbit') {
        const dx = p.x - prev.x, dy = p.y - prev.y;
        S.vYaw = dx * 0.008; S.vPitch = dy * 0.008;
        S.yaw += S.vYaw; S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch + S.vPitch)); wake();
      }
    });
    function end(ev) {
      const g = S.gesture;
      S.pointers.delete(ev.pointerId);
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* 已釋放 */ }
      if (S.pointers.size === 0) canvas.style.cursor = S.hover !== null ? 'pointer' : 'grab';
      if (!g) return;
      if (g.mode === 'pinch') { if (S.pointers.size === 0) S.gesture = null; return; }
      S.gesture = null;
      if (g.mode === 'node') {
        const pos = S.sim.pos.get(g.id); if (pos) pos.dragging = false;
        if (!g.moved) {
          const now = performance.now();
          if (S.lastTap.id === g.id && now - S.lastTap.t < 380) { S.lastTap = { id: null, t: 0 }; opts.onActivate?.(g.id); }
          else { S.lastTap = { id: g.id, t: now }; opts.onSelect?.(g.id); }
        }
      }
      wake();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (!S.pointers.size) { S.hover = null; tip.hidden = true; wake(); } });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = local(ev);
      zoomBy(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016)), p.x, p.y);
    }, { passive: false });
    canvas.addEventListener('dblclick', (ev) => { if (hitTest(local(ev).x, local(ev).y) === null) resetView(); });
    canvas.addEventListener('keydown', (ev) => {
      const k = ev.key;
      if (k === 'ArrowLeft') S.yaw -= 0.12; else if (k === 'ArrowRight') S.yaw += 0.12;
      else if (k === 'ArrowUp') S.pitch = Math.max(-1.5, S.pitch - 0.1); else if (k === 'ArrowDown') S.pitch = Math.min(1.5, S.pitch + 0.1);
      else if (k === '+' || k === '=') zoomBy(1.2); else if (k === '-' || k === '_') zoomBy(0.83); else if (k === '0') resetView();
      else return;
      ev.preventDefault(); wake();
    });

    // ---------- 尺寸 ----------
    function resize() {
      const r = container.getBoundingClientRect();
      const w = Math.floor(r.width), h = Math.floor(r.height);
      if (!w || !h) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      if (w === S.w && h === S.h && dpr === S.dpr) { wake(); return; }
      S.w = w; S.h = h; S.dpr = dpr;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      if (S.sim && !S.fitted) fit();
      wake();
    }
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => resize()); ro.observe(container); }
    function pause() { S.paused = true; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
    function resume() { S.paused = false; resize(); wake(); }
    function destroy() { pause(); ro?.disconnect(); canvas.remove(); tip.remove(); tools.remove(); }
    canvas.style.cursor = 'grab';
    resize();

    return {
      setData, setSelected, clear, resize, pause, resume, destroy, resetView, flatView, zoomBy,
      /** 測試與除錯用：目前視角與節點螢幕座標 */
      debug: () => ({ yaw: S.yaw, pitch: S.pitch, zoom: S.zoom, panX: S.panX, panY: S.panY, w: S.w, h: S.h, nodes: [...S.proj.entries()].map(([id, q]) => ({ id, sx: q.sx, sy: q.sy, z: q.z, s: q.s })), alpha: S.alpha, auto: S.auto }),
    };
  }

  root.Graph3D = { create, createSim, rotate, unrotate };
})(typeof window !== 'undefined' ? window : globalThis);
