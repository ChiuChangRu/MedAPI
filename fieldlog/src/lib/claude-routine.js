/**
 * 錄音轉錄完成 → 觸發 claude.ai Routine 整理逐字稿。
 *
 * 整理本身在 Routine（Claude Code 雲端 session，用長儒自己的 claude.ai 額度）
 * 裡跑：它透過 MyWiki MCP 讀逐字稿、新增【AI彙整】記事並建立關聯。這支 Worker
 * 只負責「什麼時候叫它」，不呼叫任何 LLM，也不碰 Claude 的帳號登入狀態——
 * 用的是 Routine 官方的 API trigger（每支 Routine 專屬、只能觸發那一支的 token）。
 *
 * 需要的 Worker Secret：
 *   CLAUDE_ROUTINE_FIRE_URL  https://api.anthropic.com/v1/claude_code/routines/trig_xxx/fire
 *   CLAUDE_ROUTINE_TOKEN     claude.ai/code/routines → Edit → API trigger → Generate token
 * 兩個都沒設定時，自動觸發安靜跳過，手動按鈕回 501 說明原因。
 */

// /fire 端點目前在 research preview，beta header 版本若改變只要改這一行。
const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

export const CLAUDE_ROUTINE_CRON = "*/10 * * * *";
export const CLAUDE_ROUTINE_CUTOFF_KEY = "claude_routine.cutoff";
// 最後一段錄音上傳後安靜這麼久才自動觸發：錄音是一段一段上傳、邊錄邊轉，
// 只看「目前每段都轉完了」會在錄音還沒結束時就提早整理半份逐字稿。
export const CLAUDE_ROUTINE_QUIET_MINUTES = 10;
export const CLAUDE_ROUTINE_AUTO_MAX_ATTEMPTS = 3;
// 手動按鈕防連點：同一筆在這段時間內不重複觸發（每次觸發都是一個完整雲端 session）。
export const CLAUDE_ROUTINE_MANUAL_COOLDOWN_SECS = 120;

export function claudeRoutineConfigured(env) {
  return Boolean(String(env?.CLAUDE_ROUTINE_FIRE_URL || "").trim() && String(env?.CLAUDE_ROUTINE_TOKEN || "").trim());
}

// text 會以 <routine-fire-payload> 包起來、標成不受信任資料交給 Routine；
// Routine 的 prompt 只從裡面取 entry_id，其他欄位僅供人看執行紀錄時辨識。
export function routineFireText({ entryId, title, revision, trigger }) {
  return JSON.stringify({ entry_id: entryId, title: String(title || ""), transcript_revision: revision, trigger });
}

export async function fireClaudeRoutine(env, text, fetchImpl = fetch) {
  const res = await fetchImpl(String(env.CLAUDE_ROUTINE_FIRE_URL).trim(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(env.CLAUDE_ROUTINE_TOKEN).trim()}`,
      "anthropic-beta": ROUTINE_BETA,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* 錯誤回應不一定是 JSON */ }
  if (!res.ok) {
    const detail = data?.error?.message || raw.slice(0, 200) || res.statusText;
    const err = new Error(`Claude Routine 觸發失敗（HTTP ${res.status}）：${detail}`);
    err.status = res.status;
    throw err;
  }
  // 網址會被放進前台的 <a href>，只收 https，避免異常回應變成 javascript: 連結。
  const sessionUrl = String(data.claude_code_session_url || "");
  return { sessionId: data.claude_code_session_id || "", sessionUrl: /^https:\/\//.test(sessionUrl) ? sessionUrl : "" };
}
