// 執行：node patent-mcp/test/mock.test.mjs（不連網，用假的 USPTO 回應）
// 用假的 USPTO 回應測：MCP 協定、PIN、session/cookie、403 重建、工具參數與輸出整理
const calls = [];
let sessionN = 0, expireOnce = true;
globalThis.fetch = async (u, o = {}) => {
  const url = String(u); calls.push([o.method || 'GET', url.replace('https://ppubs.uspto.gov', ''), (o.headers || {}).cookie || '', (o.headers || {})['x-access-token'] || '']);
  const H = (h) => { const hd = new Headers(h); return hd; };
  if (url.endsWith('/pubwebapp/')) { const h = new Headers(); h.append('set-cookie', 'JSESSIONID=abc; Path=/'); h.append('set-cookie', 'AWSALB=x1; Path=/'); return new Response('<html>', { status: 200, headers: h }); }
  if (url.endsWith('/api/users/me/session')) { sessionN++; return new Response(JSON.stringify({ userCase: { caseId: 1000 + sessionN } }), { status: 200, headers: { 'x-access-token': 'TOK' + sessionN } }); }
  if (url.endsWith('/api/searches/counts')) { if (expireOnce && sessionN === 1) { expireOnce = false; return new Response('expired', { status: 403 }); } return new Response('{}', { status: 200 }); }
  if (url.endsWith('/api/searches/searchWithBeFamily')) { const b = JSON.parse(o.body); return new Response(JSON.stringify({ numFound: 2, patents: [{ guid: 'US-7123456-B2', type: 'USPAT', inventionTitle: 'Luer connector', urpn: ['x'], abstractKwicHits: 'h', emptyF: '', caseSeen: b.query.caseId, q: b.query.q, db: b.query.databaseFilters.map(d => d.databaseName).join(',') }] }), { status: 200 }); }
  if (url.includes('/api/patents/highlight/')) return new Response(JSON.stringify({ guid: 'US-7123456-B2', type: 'USPAT', inventionTitle: 'Luer connector', claimsHtml: '<p>1. A connector &amp; lock.</p><p>2. The connector of claim 1.</p>', descriptionHtml: '<p>long</p>', abstractHtml: '<p>abs</p>', inventorsShort: 'Smith', claimsHighlights: 'x' }), { status: 200 });
  return new Response('nf', { status: 404 });
};
const W = (await import(new URL('../src/worker.js', import.meta.url))).default;
const env = { MCP_PIN: 'secret123' };
const rpc = async (body, pin = 'secret123', path = '/mcp') => { const r = await W.fetch(new Request('https://x.workers.dev' + path + (pin ? '?pin=' + pin : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env); return [r.status, await r.text()]; };
const ok = (c, m) => console.log((c ? '✓ ' : '✗ ') + m);
let [s, t] = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, '');
ok(s === 401, '無 PIN → 401');
[s, t] = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'bad'); ok(s === 401 && t.includes('PIN 不正確'), '錯 PIN → 401');
[s, t] = await W.fetch(new Request('https://x/mcp?pin=a', { method: 'POST', body: '{}' }), {}).then(async r => [r.status, await r.text()]); ok(s === 401 && t.includes('尚未設定'), '沒設定 MCP_PIN → fail-closed');
[s, t] = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }); ok(JSON.parse(t).result.protocolVersion === '2025-06-18', 'initialize');
[s, t] = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); ok(JSON.parse(t).result.tools.map(x => x.name).join() === 'patent_search,patent_get,patent_get_document,patent_citing', 'tools/list 4 支');
[s, t] = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }); ok(s === 202, 'notification → 202');
[s, t] = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'patent_search', arguments: { query: '"luer lock" AND crack.ab.', kind: 'both', limit: 5 } } });
let out = JSON.parse(JSON.parse(t).result.content[0].text); ok(out.total === 2 && out.results[0].guid === 'US-7123456-B2' && !('urpn' in out.results[0]) && !('abstractKwicHits' in out.results[0]) && !('emptyF' in out.results[0]), 'search 結果整理（去掉 urpn/KwicHits/空欄）');
ok(out.results[0].db === 'US-PGPUB,USPAT', 'kind=both 兩個資料庫');
ok(sessionN === 2 && out.results[0].caseSeen === 1002, '403 後重建 session，用新 caseId');
const cs = calls.find(c => c[1] === '/api/searches/searchWithBeFamily'); ok(cs[2].includes('JSESSIONID=abc') && cs[2].includes('AWSALB=x1') && cs[3] === 'TOK2', '帶 cookie 與新 token');
[s, t] = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'patent_get', arguments: { patent_number: 'US 7,123,456 B2', sections: ['biblio', 'claims'] } } });
out = JSON.parse(JSON.parse(t).result.content[0].text); ok(out.claimsText === '1. A connector & lock.\n2. The connector of claim 1.' && !out.descriptionText && !out.abstractText && out.inventorsShort === 'Smith' && !out.claimsHighlights, 'patent_get sections＋HTML 轉文字');
const q = calls.filter(c => c[1] === '/api/searches/searchWithBeFamily').length; ok(q === 2, 'patent_get 先以 .pn. 查 guid');
[s, t] = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'patent_citing', arguments: { patent_number: 'D845123' } } });
out = JSON.parse(JSON.parse(t).result.content[0].text); ok(out.cited_patent === 'D845123' && out.results[0].q === 'D845123.urpn.', 'citing 用 .urpn.、保留 D 前綴');
[s, t] = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'patent_get', arguments: { patent_number: '7123456', sections: ['bad'] } } });
ok(JSON.parse(t).result.isError && JSON.parse(t).result.content[0].text.includes('不認得'), '錯誤 sections → isError');
[s, t] = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } }); ok(JSON.parse(t).error.code === -32602, '未知工具');
const r0 = await W.fetch(new Request('https://x/'), env); ok((await r0.text()).includes('工具數：4'), '健康檢查 /');
