// PDCA品質輔助系統（GitHub Pages 版）自帶 API key 的轉送站
// ---------------------------------------------------------------
// StepFun 的 API 不允許網頁直接呼叫（瀏覽器 CORS 擋下，2026-10-28 使用者實測
// 「Failed to fetch」；直接開 api.stepfun.ai/v1/models 有回應，網路是通的）。
// 這裡只做一件事：把 POST /relay/stepfun[-cn]/v1/chat/completions 原樣轉給
// StepFun，回應（含串流）原樣傳回，並補上 CORS header。
// - 目的地寫死，不能用來轉到其他網址。
// - 只接受 PDCA 網頁（GitHub Pages）的 Origin。
// - Authorization（使用者自己的 key）只轉送，不記錄、不儲存；這支檔案沒有任何 console 輸出或寫入。

const TARGETS = {
  "/relay/stepfun/v1/chat/completions": "https://api.stepfun.ai/v1/chat/completions",
  "/relay/stepfun-cn/v1/chat/completions": "https://api.stepfun.com/v1/chat/completions",
};
const ALLOWED_ORIGINS = new Set(["https://chiuchangru.github.io"]);
const MAX_BODY = 12 * 1024 * 1024;   // 對話＋最多 8 張 base64 圖片

export function isRelayPath(pathname) {
  return Object.hasOwn(TARGETS, pathname);
}

export async function handleRelay(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin);
  const cors = allowed ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  } : { vary: "origin" };
  const fail = (status, message) => new Response(JSON.stringify({ error: { message, type: "relay_error" } }), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
  if (!allowed) return fail(403, "此轉送站只接受 PDCA品質輔助系統網頁的呼叫");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return fail(405, "method not allowed");
  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return fail(401, "缺少 API key");
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return fail(413, "內容太大");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return fail(413, "內容太大");
  let upstream;
  try {
    upstream = await fetch(TARGETS[url.pathname], {
      method: "POST",
      headers: { authorization: auth, "content-type": request.headers.get("content-type") || "application/json" },
      body,
    });
  } catch {
    return fail(502, "轉送站連不到 StepFun");
  }
  const headers = new Headers(cors);
  headers.set("content-type", upstream.headers.get("content-type") || "application/json");
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}
