const TABLE_SQL = `CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, entry_id INTEGER NOT NULL,
  attachment_id INTEGER, snapshot_json TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT DEFAULT '',
  allow_attachments INTEGER DEFAULT 1, allow_download INTEGER DEFAULT 0, created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL, access_count INTEGER DEFAULT 0, last_accessed_at TEXT DEFAULT ''
)`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeStoredHtml(value) {
  return String(value || "")
    .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[\s\S]*?\2/gi, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headers(contentType = "text/html; charset=utf-8") {
  return {
    "content-type": contentType,
    "cache-control": "no-store, private",
    "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:#f3f7f6;color:#17332f;margin:0;padding:32px 16px}.page{max-width:900px;margin:auto;background:white;border:1px solid #dbe5e2;border-radius:18px;padding:clamp(22px,5vw,48px);box-shadow:0 14px 40px #174a3b18}h1{color:#087f70;overflow-wrap:anywhere}.meta{color:#62736f}.body{line-height:1.75;overflow-wrap:anywhere}.files{display:grid;gap:14px;margin-top:30px}.file{border:1px solid #dbe5e2;border-radius:12px;padding:16px}.file img,.file iframe,.file video{display:block;max-width:100%;width:100%;max-height:70vh;border:0;border-radius:8px}.badge{display:inline-block;background:#e8f5f2;color:#087f70;padding:5px 9px;border-radius:999px;font-size:13px}a{color:#087f70}</style></head><body><main class="page">${body}</main></body></html>`, { status, headers: headers() });
}

async function activeShare(env, token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  await env.DB.prepare(TABLE_SQL).run();
  return env.DB.prepare(
    "SELECT * FROM share_links WHERE token_hash = ? AND COALESCE(revoked_at, '') = '' AND expires_at > ?"
  ).bind(await sha256Hex(token), new Date().toISOString()).first();
}

function renderAttachment(token, attachment, allowDownload) {
  const src = `/s/${encodeURIComponent(token)}/file/${attachment.id}`;
  const name = escapeHtml(attachment.filename);
  const mime = String(attachment.mime || "");
  let preview = `<p>此格式不提供公開預覽。</p>`;
  if (mime.startsWith("image/")) preview = `<img src="${src}" alt="${name}">`;
  else if (mime.startsWith("audio/")) preview = `<audio controls src="${src}"></audio>`;
  else if (mime.startsWith("video/")) preview = `<video controls src="${src}"></video>`;
  else if (mime === "application/pdf" || /\.pdf$/i.test(attachment.filename || "")) preview = `<iframe src="${src}" title="${name}" height="650"></iframe>`;
  const download = allowDownload ? `<p><a href="${src}?download=1">下載附件</a></p>` : `<p class="meta">此分享未開放下載。</p>`;
  return `<section class="file"><h2>${name}</h2>${preview}${download}</section>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: headers("text/plain; charset=utf-8") });
    const fileMatch = url.pathname.match(/^\/s\/([^/]+)\/file\/(\d+)$/);
    if (fileMatch) {
      const share = await activeShare(env, fileMatch[1]);
      if (!share || !share.allow_attachments) return new Response("找不到或分享已失效", { status: 404, headers: headers("text/plain; charset=utf-8") });
      const snapshot = JSON.parse(share.snapshot_json);
      const attachment = (snapshot.attachments || []).find((item) => Number(item.id) === Number(fileMatch[2]));
      if (!attachment) return new Response("附件未包含在此分享", { status: 404, headers: headers("text/plain; charset=utf-8") });
      if (url.searchParams.get("download") === "1" && !share.allow_download) return new Response("此分享未開放下載", { status: 403, headers: headers("text/plain; charset=utf-8") });
      const object = await env.FILES.get(attachment.key);
      if (!object) return new Response("檔案不存在", { status: 404, headers: headers("text/plain; charset=utf-8") });
      const responseHeaders = new Headers(headers(object.httpMetadata?.contentType || attachment.mime || "application/octet-stream"));
      responseHeaders.set("content-disposition", url.searchParams.get("download") === "1" ? `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}` : "inline");
      return new Response(request.method === "HEAD" ? null : object.body, { headers: responseHeaders });
    }
    const match = url.pathname.match(/^\/s\/([^/]+)$/);
    if (!match) return page("MyWiki 分享", "<h1>MyWiki 唯讀分享</h1><p>請使用完整分享連結。</p>", 404);
    const share = await activeShare(env, match[1]);
    if (!share) return page("分享已失效", "<h1>分享不存在或已失效</h1><p>連結可能已到期或被撤銷。</p>", 404);
    const snapshot = JSON.parse(share.snapshot_json);
    const entry = snapshot.entry || {};
    const body = entry.body_format === "html" ? safeStoredHtml(entry.body) : `<pre>${escapeHtml(entry.body)}</pre>`;
    const files = share.allow_attachments ? (snapshot.attachments || []).map((item) => renderAttachment(match[1], item, !!share.allow_download)).join("") : "";
    ctx.waitUntil(env.DB.prepare("UPDATE share_links SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?").bind(new Date().toISOString(), share.id).run());
    return page(entry.title || "MyWiki 分享", `<span class="badge">唯讀快照</span><h1>${escapeHtml(entry.title || "未命名資料")}</h1><p class="meta">分享期限：${escapeHtml(new Date(share.expires_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }))}</p><article class="body">${body}</article>${files ? `<div class="files">${files}</div>` : ""}`);
  },
};
