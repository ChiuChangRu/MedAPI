// PDCA品質輔助系統（DMAIC_02 medqs）匿名使用紀錄
// ---------------------------------------------------------------
// 網頁端（GitHub Pages 與 claude.ai artifact 兩版）用 sendBeacon／fetch
// 送 POST /pdca/hit，這裡寫進獨立的 D1「pdca-usage」（binding DB_PDCA），
// 不碰 fieldlog／medtec 的生產資料。
// 只收：事件類型、頁面／工具／流程步驟名稱、來源網站網域、活動代碼、
// 網頁版本、裝置類型（手機／桌機）、分頁隨機編號。
// 不收：IP、帳號、姓名、任何案件內容、數據、AI 對話。
// 這支 Worker 只做 INSERT（不寫 UPDATE／DELETE，跟其他工具同一條鐵律）；統計最多回看 400 天。

const EVENTS = new Set(["open", "view", "tool", "step", "analyze"]);

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) || null;

export async function handlePdcaHit(request, env, corsHeaders) {
  const headers = { "content-type": "application/json; charset=utf-8", ...corsHeaders };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return new Response('{"error":"method not allowed"}', { status: 405, headers });
  if (!env.DB_PDCA) return new Response('{"error":"未設定 DB_PDCA"}', { status: 503, headers });
  const raw = await request.text();
  if (raw.length > 2000) return new Response('{"error":"too large"}', { status: 413, headers });
  let b;
  try { b = JSON.parse(raw); } catch { return new Response('{"error":"bad json"}', { status: 400, headers }); }
  const ev = clip(b?.ev, 16);
  if (!EVENTS.has(ev)) return new Response('{"error":"bad ev"}', { status: 400, headers });
  // 來源只留網域，不留完整網址（網址可能帶查詢字串）
  let ref = null;
  try { if (b.ref) ref = new URL(String(b.ref)).hostname.slice(0, 80); } catch { /* 非網址就不記 */ }
  await env.DB_PDCA.prepare(
    "INSERT INTO pdca_usage (ts, sid, ev, view, tool, step, host, ref, src, ver, dev) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    new Date().toISOString(), clip(b.sid, 24), ev, clip(b.view, 40), clip(b.tool, 40), clip(b.step, 40),
    clip(b.host, 80), ref, clip(b.src, 40), clip(b.ver, 20), b.dev === "m" ? "m" : "d",
  ).run();
  return new Response('{"ok":true}', { status: 200, headers });
}

const HOST_LABEL = (h) => (!h ? "（未知）" : /github\.io$/.test(h) ? `GitHub Pages（${h}）` : /claude|anthropic/.test(h) ? `claude.ai 版（${h}）` : h);

export const PDCA_TOOL = {
  name: "pdca_usage_stats",
  description: "查 PDCA品質輔助系統（DMAIC_02 medqs 網站）的匿名使用統計：期間內開啟次數、不同分頁數、各版本（GitHub Pages／claude.ai）、來源網站與活動代碼排行、各工具使用次數、PDCA 流程走到哪一步、按「分析」次數、手機／桌機比例、每日趨勢。只讀不寫；紀錄不含 IP、帳號或任何案件內容。",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "integer", description: "統計最近幾天（預設 30，最多 400）" },
      top: { type: "integer", description: "每個排行列幾名（預設 10）" },
    },
  },
  async handler(env, args = {}) {
    if (!env.DB_PDCA) return "這台 MCP 還沒綁定 DB_PDCA（pdca-usage 資料庫），無法查詢。";
    const days = Math.min(400, Math.max(1, parseInt(args.days, 10) || 30));
    const top = Math.min(50, Math.max(1, parseInt(args.top, 10) || 10));
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const q = (sql, ...p) => env.DB_PDCA.prepare(sql).bind(since, ...p).all().then((r) => r.results || []);
    const [tot] = await q("SELECT COUNT(*) n, COUNT(DISTINCT sid) s, SUM(ev='open') o, SUM(ev='analyze') a, SUM(dev='m' AND ev='open') m, MIN(ts) t0, MAX(ts) t1 FROM pdca_usage WHERE ts >= ?");
    if (!tot?.n) return `最近 ${days} 天沒有任何 PDCA 網站使用紀錄。`;
    const [hosts, refs, srcs, tools, steps, views, ana, daily] = await Promise.all([
      q("SELECT host k, COUNT(*) n FROM pdca_usage WHERE ts >= ? AND ev='open' GROUP BY host ORDER BY n DESC LIMIT ?", top),
      q("SELECT COALESCE(ref,'（直接開啟／無來源）') k, COUNT(*) n FROM pdca_usage WHERE ts >= ? AND ev='open' GROUP BY ref ORDER BY n DESC LIMIT ?", top),
      q("SELECT src k, COUNT(*) n FROM pdca_usage WHERE ts >= ? AND ev='open' AND src IS NOT NULL GROUP BY src ORDER BY n DESC LIMIT ?", top),
      q("SELECT tool k, COUNT(*) n, COUNT(DISTINCT sid) s FROM pdca_usage WHERE ts >= ? AND ev='tool' GROUP BY tool ORDER BY n DESC LIMIT ?", top),
      q("SELECT step k, COUNT(*) n, COUNT(DISTINCT sid) s FROM pdca_usage WHERE ts >= ? AND ev='step' GROUP BY step ORDER BY s DESC LIMIT ?", top),
      q("SELECT view k, COUNT(*) n FROM pdca_usage WHERE ts >= ? AND ev='view' GROUP BY view ORDER BY n DESC LIMIT ?", top),
      q("SELECT tool k, COUNT(*) n FROM pdca_usage WHERE ts >= ? AND ev='analyze' GROUP BY tool ORDER BY n DESC LIMIT ?", top),
      q("SELECT substr(datetime(ts,'+8 hours'),1,10) k, SUM(ev='open') n, COUNT(DISTINCT sid) s FROM pdca_usage WHERE ts >= ? GROUP BY k ORDER BY k DESC LIMIT 31"),
    ]);
    const list = (rows, fmt) => (rows.length ? rows.map(fmt) : ["- （無）"]);
    return [
      `# PDCA 網站使用統計（最近 ${days} 天）`,
      `紀錄期間：${tot.t0} ～ ${tot.t1}（UTC）｜事件 ${tot.n} 筆｜不同分頁 ${tot.s} 個｜開啟 ${tot.o} 次（手機 ${tot.m || 0}）｜按分析 ${tot.a || 0} 次`,
      "", "## 版本（開啟次數）", ...list(hosts, (r) => `- ${HOST_LABEL(r.k)}：${r.n}`),
      "", "## 來源網站（開啟次數）", ...list(refs, (r) => `- ${r.k}：${r.n}`),
      "", "## 活動代碼 ?src=（開啟次數）", ...list(srcs, (r) => `- ${r.k}：${r.n}`),
      "", "## 工具使用（次數／分頁數）", ...list(tools, (r) => `- ${r.k}：${r.n} 次／${r.s} 個分頁`),
      "", "## PDCA 流程步驟（走到該步的分頁數）", ...list(steps, (r) => `- ${r.k}：${r.s} 個分頁（${r.n} 次）`),
      "", "## 頁面瀏覽", ...list(views, (r) => `- ${r.k}：${r.n}`),
      "", "## 按「分析」的工具", ...list(ana, (r) => `- ${r.k}：${r.n}`),
      "", "## 每日（台灣時間）開啟次數／分頁數", ...list(daily, (r) => `- ${r.k}：${r.n}／${r.s}`),
      "", "（匿名紀錄：不含 IP、帳號、案件內容；分頁數 ≈ 使用次數，同一人開兩個分頁會算兩次）",
    ].join("\n");
  },
};
