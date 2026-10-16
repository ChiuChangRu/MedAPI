/**
 * patent-mcp — USPTO 美國專利查詢 MCP Server（Cloudflare Worker，唯讀）
 *
 * 改寫自 riemannzeta/patent_mcp_server（MIT，v1.8.1）的 Patent Public Search
 * （ppubs.uspto.gov）部分：只做「不需要 USPTO API key」的四支工具——
 *   patent_search          全文檢索（核准專利／公開申請案）
 *   patent_get             用專利號取全文（書目、摘要、請求項、說明書，可只取部分）
 *   patent_get_document    用檢索結果的 guid 取全文（公開申請案用這支）
 *   patent_citing          被引用（哪些後來的核准專利引用了這件）
 * 審查歷程（ODP）、PTAB、商標都需要另外申請 key，這裡不做。
 *
 * 驗證：與 medapi-mcp 相同的 PIN 方式——?pin=、x-pin 或 Authorization: Bearer <MCP_PIN>。
 *   MCP_PIN 未設定時一律拒絕（fail-closed）。wrangler.jsonc 有 keep_vars，部署不會清掉 Secret。
 * 協定：MCP JSON-RPC over stateless streamable HTTP（POST /mcp，回 JSON）。
 *
 * 注意（未驗證*）：USPTO 的 Public Search 是網頁內部 API，沒有官方文件；
 * 從 Cloudflare 機房連過去會不會被 USPTO 擋，要部署後實測才知道。
 */

const PPUBS = "https://ppubs.uspto.gov";
const PROTOCOL_DEFAULT = "2025-03-26";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const SESSION_MINUTES = 25;          // 原版快取 30 分鐘；保守一點
const MAX_TEXT = 60000;              // 單次回傳文字上限（字元），超過就截斷並註明
const VERSION = "1.0.0";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-pin, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

// 原版 json/search_query.json 的檢索範本
const SEARCH_TEMPLATE = {
  start: 0, pageCount: 500, sort: "date_publ desc", docFamilyFiltering: "familyIdFiltering", searchType: 1,
  familyIdEnglishOnly: true, familyIdFirstPreferred: "US-PGPUB", familyIdSecondPreferred: "USPAT",
  familyIdThirdPreferred: "FPRS", showDocPerFamilyPref: "showEnglish", queryId: 0, tagDocSearch: false,
  query: {
    caseId: 0, hl_snippets: "2", op: "OR", q: "", queryName: "", highlights: "1", qt: "brs", spellCheck: false,
    viewName: "tile", plurals: true, britishEquivalents: true, databaseFilters: [], searchType: 1,
    ignorePersist: true, userEnteredQuery: "",
  },
};
const SRC = { patents: "USPAT", applications: "US-PGPUB", ocr: "USOCR" };
const SECTIONS = ["biblio", "abstract", "claims", "description"];
const HTML_FIELDS = { abstract: ["abstractHtml"], claims: ["claimsHtml"], description: ["descriptionHtml", "briefHtml", "backgroundTextHtml"] };
const IDENTITY = ["guid", "type", "inventionTitle", "datePublished", "applicationNumber", "publicationReferenceDocumentNumber"];
const HIT_DROP = new Set(["urpn", "urpnCode"]);

// ---------- USPTO Public Search 連線（cookie 與 X-Access-Token 自己管） ----------
// Worker 的 fetch 沒有 cookie jar，要手動收 Set-Cookie、手動帶 Cookie。
// 同一個 isolate 內共用一個 session；過期或 403 時重建。
let S = { cookies: new Map(), token: null, caseId: null, until: 0, pending: null };

function baseHeaders() {
  return {
    "x-requested-with": "XMLHttpRequest",
    "user-agent": `patent-mcp-worker/${VERSION} (+patent_mcp_server port)`,
    origin: PPUBS,
    referer: `${PPUBS}/pubwebapp/`,
    pragma: "no-cache",
    "cache-control": "no-cache",
  };
}
function keepCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  for (const c of list) { const kv = String(c).split(";")[0]; const i = kv.indexOf("="); if (i > 0) S.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
}
function cookieHeader() { return [...S.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }

async function establish() {
  S = { cookies: new Map(), token: null, caseId: null, until: 0, pending: null };
  const r1 = await fetch(`${PPUBS}/pubwebapp/`, { headers: baseHeaders(), redirect: "follow" });
  keepCookies(r1);
  const r2 = await fetch(`${PPUBS}/api/users/me/session`, {
    method: "POST",
    headers: { ...baseHeaders(), "content-type": "application/json", "x-access-token": "null", cookie: cookieHeader() },
    body: "-1",
  });
  keepCookies(r2);
  if (r2.status !== 200) throw new Error(`USPTO 建立連線失敗（HTTP ${r2.status}）：${(await r2.text()).slice(0, 200)}`);
  const body = await r2.json();
  S.caseId = body?.userCase?.caseId;
  S.token = r2.headers.get("x-access-token");
  if (!S.caseId || !S.token) throw new Error("USPTO 建立連線失敗：回應沒有 caseId 或 access token（USPTO 可能改了網頁內部 API）");
  S.until = Date.now() + SESSION_MINUTES * 60000;
}
async function session() {
  if (S.token && Date.now() < S.until) return;
  if (!S.pending) S.pending = establish().finally(() => { S.pending = null; });
  await S.pending;
}
async function ppubs(method, path, { json, params } = {}) {
  await session();
  const go = async () => {
    const u = new URL(PPUBS + path);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v == null ? "null" : String(v));
    const res = await fetch(u, {
      method,
      headers: { ...baseHeaders(), "x-access-token": S.token, cookie: cookieHeader(), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    keepCookies(res);
    return res;
  };
  let res = await go();
  if (res.status === 403) { S.until = 0; await session(); res = await go(); }            // session 過期
  if (res.status === 429) {                                                                  // 限流：等一下再試一次
    const wait = Math.min(15, (parseInt(res.headers.get("x-rate-limit-retry-after-seconds") || "5", 10) || 5) + 1);
    await new Promise(r => setTimeout(r, wait * 1000)); res = await go();
  }
  if (res.status !== 200) throw new Error(`USPTO 回應 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function runQuery(q, { offset = 0, limit = 20, sort = "date_publ desc", sources = [SRC.patents] } = {}) {
  await session();
  const d = JSON.parse(JSON.stringify(SEARCH_TEMPLATE));
  d.start = offset; d.pageCount = Math.min(limit, 500); d.sort = sort;
  Object.assign(d.query, { caseId: S.caseId, op: "AND", q, queryName: q, userEnteredQuery: q, databaseFilters: sources.map(s => ({ databaseName: s, countryCodes: [] })) });
  await ppubs("POST", "/api/searches/counts", { json: d.query });
  d.query.caseId = S.caseId;   // counts 可能觸發重建 session
  const r = await ppubs("POST", "/api/searches/searchWithBeFamily", { json: d });
  if (r && r.error != null) throw new Error(`USPTO 檢索錯誤：${r.error.errorMessage || JSON.stringify(r.error).slice(0, 200)}`);
  return r;
}

// ---------- 整理回傳內容 ----------
const empty = v => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
function slimHit(h) { const o = {}; for (const [k, v] of Object.entries(h || {})) if (!empty(v) && !k.includes("KwicHits") && !k.includes("Highlights") && !HIT_DROP.has(k)) o[k] = v; return o; }
function htmlToText(s) {
  return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function slimDoc(doc, sections) {
  const textFields = new Set(Object.values(HTML_FIELDS).flat());
  const keepText = new Set((sections && sections.length ? sections : SECTIONS).flatMap(s => HTML_FIELDS[s] || []));
  const keepBiblio = !sections || !sections.length || sections.includes("biblio");
  const o = {};
  for (const [k, v] of Object.entries(doc || {})) {
    if (empty(v) || k.includes("KwicHits") || k.includes("Highlights")) continue;
    if (textFields.has(k)) { if (keepText.has(k)) o[k.replace(/Html$/, "Text")] = htmlToText(v); }   // HTML 轉純文字，省 token
    else if (keepBiblio || IDENTITY.includes(k)) o[k] = v;
  }
  if (sections && sections.length) o._sections = sections;
  return o;
}
function envelope(r, offset, limit, extra) {
  const results = (r.patents || r.docs || []).map(slimHit);
  return { source: "USPTO Patent Public Search (ppubs.uspto.gov)", total: r.numFound ?? results.length, count: results.length, offset, limit, ...extra, results };
}
function normPatentNo(v) {
  let c = String(v || "").toUpperCase().replace(/[\s,.\-/]+/g, "");
  if (c.startsWith("US")) c = c.slice(2);
  const m = c.match(/^(RE|PP|AI|D|T|H|X)?(\d+)([A-Z]\d?)?$/);
  if (m) return (m[1] || "") + m[2];
  const d = c.replace(/\D/g, ""); if (!d) throw new Error("專利號至少要有一個數字");
  return d;
}
function checkSections(s) { if (s == null) return null; if (!Array.isArray(s)) throw new Error("sections 要是陣列"); const bad = s.filter(x => !SECTIONS.includes(x)); if (bad.length) throw new Error(`不認得的 sections：${bad.join(", ")}；可用：${SECTIONS.join(", ")}`); return s; }
const clampInt = (v, d, lo, hi) => { const n = Number.isFinite(+v) ? Math.trunc(+v) : d; return Math.max(lo, Math.min(hi, n)); };

// ---------- 工具 ----------
const QUERY_HELP = "USPTO BRS 語法：多個詞預設 AND；片語要加雙引號（\"luer lock\"）；欄位限定用點號後綴：.ti.（標題）.ab.（摘要）.clm.（請求項）.in.（發明人）.as.（申請人）.cpc.（CPC 分類，例如 A61M39/10.cpc.）.pn.（專利號）。舊式 TTL/、IN/ 寫法已失效。可用 AND／OR／NOT 與括號。";
const TOOLS = [
  {
    name: "patent_search",
    description: "檢索美國專利全文（USPTO Patent Public Search，每日更新）。用來找同類醫材的設計、失效對策或既有技術。預設依公開日新到舊排序，範圍太廣時請加欄位限定。" + QUERY_HELP,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "檢索式。" + QUERY_HELP },
      kind: { type: "string", enum: ["patents", "applications", "both"], description: "patents＝核准專利（預設）；applications＝公開申請案；both＝兩者" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "回傳筆數，預設 10" },
      offset: { type: "integer", minimum: 0, description: "分頁起點，預設 0" },
      sort: { type: "string", description: "排序，預設 \"date_publ desc\"（新到舊）；舊到新用 \"date_publ asc\"" },
    }, required: ["query"] },
    async run(a) {
      const q = String(a.query || "").trim(); if (!q) throw new Error("query 不可空白");
      const kind = a.kind || "patents", limit = clampInt(a.limit, 10, 1, 50), offset = clampInt(a.offset, 0, 0, 100000);
      const sources = kind === "both" ? [SRC.applications, SRC.patents] : kind === "applications" ? [SRC.applications] : [SRC.patents];
      const r = await runQuery(q, { offset, limit, sort: a.sort || "date_publ desc", sources });
      return envelope(r, offset, limit, { query: q, kind });
    },
  },
  {
    name: "patent_get",
    description: "用美國核准專利號取全文。整份約 2～4 萬 token，大多是說明書；通常用 sections=[\"biblio\",\"claims\"] 就夠（書目＋請求項，約 5 千 token）。biblio 內含本專利引用的前案。公開申請案請改用 patent_get_document。",
    inputSchema: { type: "object", properties: {
      patent_number: { type: "string", description: "專利號，例如 \"7123456\"、\"US 10,000,000 B2\"、\"D845123\"、\"RE49123\"" },
      sections: { type: "array", items: { type: "string", enum: SECTIONS }, description: "只取哪些部分；省略＝全部" },
    }, required: ["patent_number"] },
    async run(a) {
      const pn = normPatentNo(a.patent_number), sections = checkSections(a.sections);
      const r = await runQuery(`${pn}.pn.`, { limit: 1, sources: [SRC.patents] });
      const hit = (r.patents || r.docs || [])[0]; if (!hit) throw new Error(`查無專利 ${pn}`);
      const doc = await ppubs("GET", `/api/patents/highlight/${encodeURIComponent(hit.guid)}`, { params: { queryId: 1, source: hit.type, includeSections: true, uniqueId: null } });
      return slimDoc(doc, sections);
    },
  },
  {
    name: "patent_get_document",
    description: "用檢索結果裡的 guid 與 type 取全文（核准專利或公開申請案都可）。sections 同 patent_get。",
    inputSchema: { type: "object", properties: {
      guid: { type: "string", description: "檢索結果的 guid，例如 \"US-20240123456-A1\"" },
      source_type: { type: "string", enum: ["USPAT", "US-PGPUB", "USOCR"], description: "檢索結果的 type：USPAT＝核准專利，US-PGPUB＝公開申請案" },
      sections: { type: "array", items: { type: "string", enum: SECTIONS } },
    }, required: ["guid", "source_type"] },
    async run(a) {
      const sections = checkSections(a.sections);
      const doc = await ppubs("GET", `/api/patents/highlight/${encodeURIComponent(String(a.guid))}`, { params: { queryId: 1, source: a.source_type, includeSections: true, uniqueId: null } });
      return slimDoc(doc, sections);
    },
  },
  {
    name: "patent_citing",
    description: "被引用檢索：列出後來引用這件專利的美國核准專利（forward citations），total 就是被引用次數。尚未核准的申請案不在內。",
    inputSchema: { type: "object", properties: {
      patent_number: { type: "string", description: "被引用的專利號" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "預設 10" },
      offset: { type: "integer", minimum: 0 },
    }, required: ["patent_number"] },
    async run(a) {
      const pn = normPatentNo(a.patent_number), limit = clampInt(a.limit, 10, 1, 50), offset = clampInt(a.offset, 0, 0, 100000);
      const r = await runQuery(`${pn}.urpn.`, { offset, limit, sources: [SRC.patents] });
      return envelope(r, offset, limit, { cited_patent: pn });
    },
  },
];

// ---------- 驗證（同 medapi-mcp 的 PIN 方式） ----------
async function sha256(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function authorize(request, env) {
  const secret = String(env.MCP_PIN || "").trim();
  if (!secret) return { ok: false, reason: "尚未設定 MCP_PIN" };
  const url = new URL(request.url);
  const given = String(request.headers.get("x-pin") || url.searchParams.get("pin") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  if (!given) return { ok: false, reason: "需要 PIN（?pin=、x-pin 或 Authorization: Bearer）" };
  const [x, y] = await Promise.all([sha256(given), sha256(secret)]);
  return constantTimeEqual(x, y) ? { ok: true } : { ok: false, reason: "PIN 不正確" };
}

// ---------- MCP JSON-RPC ----------
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS } });
const rpcResult = (id, result) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => json({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMcp(request) {
  if (request.method === "GET") return json({ error: "此端點只接受 MCP POST 請求" }, 405);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let msg; try { msg = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
  if (Array.isArray(msg)) return rpcError(null, -32600, "不支援 batch 請求");
  const { id, method, params } = msg || {};
  if (!method) return rpcError(id ?? null, -32600, "Invalid Request");
  if (method.startsWith("notifications/")) return new Response(null, { status: 202, headers: CORS_HEADERS });
  if (method === "ping") return rpcResult(id, {});
  if (method === "initialize") {
    const want = params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(want) ? want : PROTOCOL_DEFAULT,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "patent-mcp", version: VERSION },
      instructions: "美國專利（USPTO Patent Public Search）唯讀查詢：patent_search 全文檢索、patent_get 依專利號取全文、patent_get_document 依 guid 取全文、patent_citing 被引用。只涵蓋美國，查不到台灣、歐洲、中國專利。專利內容是申請人的主張，不等於產品實際表現；引用時註明專利號。",
    });
  }
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `沒有這個工具：${params?.name}`);
    try {
      const out = await tool.run(params?.arguments || {});
      let text = JSON.stringify(out, null, 1);
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…（內容超過 ${MAX_TEXT} 字元已截斷；請用 sections 只取需要的部分，或調小 limit）`;
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return rpcResult(id, { content: [{ type: "text", text: `查詢失敗：${err.message}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      const auth = await authorize(request, env);
      if (!auth.ok) return json({ error: "unauthorized", error_description: auth.reason }, 401);
      try { return await handleMcp(request); } catch (err) { return rpcError(null, -32603, `伺服器錯誤：${err.message}`); }
    }
    if (url.pathname === "/") {
      return new Response(`patent-mcp OK — MCP 端點在 POST /mcp（需要 PIN）\n工具數：${TOOLS.length}\n版本：${VERSION}\n`, { headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS } });
    }
    return json({ error: "not found" }, 404);
  },
};
