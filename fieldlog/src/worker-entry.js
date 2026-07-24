import previousWorker from "./worker-v49.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  const url = new URL(request.url);
  const expected = String(env.FIELD_PIN || "").trim();
  const supplied = String(request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
  return Boolean(expected) && supplied === expected;
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function noStoreResponse(body, response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new Response(body, { status: response.status, headers });
}

async function warmSchema(request, env, ctx) {
  const url = new URL(request.url);
  url.pathname = "/api/config";
  url.search = "";
  const response = await previousWorker.fetch(new Request(url, {
    method: "GET",
    headers: request.headers,
  }), env, ctx);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `初始化資料庫失敗（HTTP ${response.status}）`);
  }
}

async function appendTimedNote(request, env, ctx, entryId) {
  await warmSchema(request, env, ctx);
  const body = await request.json().catch(() => ({}));
  const line = String(body.line || "").trim();
  if (!line) return json({ error: "line 為必填" }, 400);

  const old = await env.DB.prepare(
    "SELECT id, folder_id FROM entries WHERE id = ?"
  ).bind(entryId).first();
  if (!old) return json({ error: "找不到紀錄" }, 404);

  const updatedAt = timestamp();
  const result = await env.DB.prepare(
    "UPDATE entries SET body = CASE WHEN body IS NULL OR body = '' THEN ? ELSE body || char(10) || ? END, updated_at = ? WHERE id = ?"
  ).bind(line, line, updatedAt, entryId).run();
  if (!result.meta.changes) return json({ error: "找不到紀錄" }, 404);

  await env.DB.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, '記一句', ?, ?)"
  ).bind(entryId, old.folder_id ?? null, line.slice(0, 200), updatedAt).run();

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const noteMatch = url.pathname.match(/^\/api\/entries\/(\d+)\/notes$/);

    if (noteMatch && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);
      try {
        return await appendTimedNote(request, env, ctx, Number(noteMatch[1]));
      } catch (error) {
        return json({ error: `記一句失敗：${error.message}` }, 500);
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const html = (await response.text()).replace(
        /home\.js(?:\?v=[^"' ]+)?/g,
        "home.js?v=atomic-note"
      );
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
