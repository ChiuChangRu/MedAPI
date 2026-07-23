import previousWorker from "./worker-v45.js";

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

async function warmSchema(request, env, ctx) {
  const url = new URL(request.url);
  url.pathname = "/api/folders";
  url.search = "";
  const headers = new Headers();
  headers.set("x-pin", request.headers.get("x-pin") || new URL(request.url).searchParams.get("pin") || "");
  const response = await previousWorker.fetch(new Request(url, { method: "GET", headers }), env, ctx);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `初始化資料庫失敗（HTTP ${response.status}）`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/attachments/rename-existing") {
      return previousWorker.fetch(request, env, ctx);
    }
    if (!authorized(request, env)) return json({ error: "PIN 錯誤或未提供" }, 401);

    let cleanupResponse;
    try {
      // 先讓既有 Worker 完成 schema migration，避免下一步暫時移除索引後又被 migration 立即建立回來。
      await warmSchema(request, env, ctx);

      // 舊檔補寫 SHA-256 時，若較晚的附件與既有附件相同，唯一索引會在刪除重複檔前先中斷。
      // 整理期間暫時移除索引，讓既有流程先補 hash、刪除較晚重複檔，再恢復索引。
      await env.DB.prepare("DROP INDEX IF EXISTS idx_att_entry_hash").run();
      cleanupResponse = await previousWorker.fetch(request, env, ctx);
    } catch (error) {
      cleanupResponse = json({ error: `既有附件整理失敗：${error.message}` }, 500);
    }

    try {
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_att_entry_hash ON attachments(entry_id, content_hash) WHERE content_hash IS NOT NULL AND content_hash <> ''"
      ).run();
    } catch (error) {
      return json({
        error: `重複檔整理後無法恢復資料庫索引：${error.message}`,
        cleanup_status: cleanupResponse?.status || 500,
      }, 500);
    }

    return cleanupResponse;
  },
};
