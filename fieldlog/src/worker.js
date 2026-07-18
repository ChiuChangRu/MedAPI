/**
 * 隨身助理記事本（fieldlog）— Cloudflare Worker API
 *
 * 定位：現場採集參展/拜訪/實驗/上課的原始資料（錄音、照片、速記），
 * AI 事後彙整成報告送 Notion。本 Worker 只管 raw data 的存取：
 *   - folders：一個活動/工作項目＝一個資料夾（自帶欄位模板 type）
 *   - entries：一筆紀錄（folder_id 為空＝收件匣，之後再歸檔）
 *   - attachments：照片/錄音段/檔案（存 R2），offset_secs 記錄「錄音第幾秒拍的」
 *   - history：append-only 歷程
 *   - /api/export/folder/:id：整個資料夾匯出成一份 Markdown 原料包，貼給 AI 彙整
 *
 * 驗證：所有 /api/* 需帶 x-pin header（或 ?pin=），與 FIELD_PIN（Secret）比對。
 * FIELD_PIN 未設定時一律拒絕（fail-closed）。raw data 只增不刪。
 */

import { extractImageText, judgeRelation } from "./imageSkill.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT '其他',
    status TEXT DEFAULT '進行中',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER,
    title TEXT DEFAULT '',
    fields_json TEXT DEFAULT '{}',
    body TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    kind TEXT DEFAULT 'file',
    filename TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime TEXT DEFAULT '',
    transcript TEXT DEFAULT '',
    offset_secs INTEGER,
    category TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    folder_id INTEGER,
    action TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_folder ON entries(folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id)`,
];

// 舊表補欄位用（D1 沒有 ADD COLUMN IF NOT EXISTS，欄位已存在時失敗直接忽略即可）
const MIGRATIONS = [
  `ALTER TABLE folders ADD COLUMN notion_page_id TEXT DEFAULT ''`,
  `ALTER TABLE folders ADD COLUMN notion_last_entry_id INTEGER DEFAULT 0`,
  `ALTER TABLE folders ADD COLUMN notion_synced_at TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN ocr_text TEXT DEFAULT ''`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    await db.prepare(sql).run().catch(() => {});
  }
  schemaReady = true;
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message, status = 400) {
  return json({ error: message }, status);
}

async function logHistory(db, entryId, folderId, action, detail) {
  await db
    .prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(entryId, folderId, action, (detail || "").slice(0, 200), now())
    .run();
}

function fmtSecs(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// 貼上的 Notion 頁面網址 → 32 碼 page ID（補回標準 UUID 格式的連字號）
function parseNotionPageId(input) {
  const raw = (input || "").trim();
  if (!raw) return "";
  const hex = raw.replace(/[^a-f0-9]/gi, "");
  const id32 = hex.slice(-32);
  if (id32.length !== 32) return "";
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}

async function handleApi(request, env, url) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (path === "/config" && method === "GET") {
    return json({ uploads: !!env.FILES, transcribe: !!(env.FILES && env.AI) });
  }

  // ---- folders ----
  if (path === "/folders" && method === "GET") {
    const { results } = await db.prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM entries e WHERE e.folder_id = f.id) AS entry_count
       FROM folders f ORDER BY f.status = '進行中' DESC, f.id DESC`
    ).all();
    return json(results);
  }
  if (path === "/folders" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    if (!name) return bad("name 為必填");
    const type = (body.type || "其他").trim();
    const r = await db.prepare("INSERT INTO folders (name, type, created_at) VALUES (?, ?, ?)")
      .bind(name, type, now()).run();
    await logHistory(db, null, r.meta.last_row_id, "建立資料夾", `${name}（${type}）`);
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const folderMatch = path.match(/^\/folders\/(\d+)$/);
  if (folderMatch && method === "PUT") {
    const id = Number(folderMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到資料夾", 404);
    const name = body.name !== undefined ? (body.name || "").trim() : old.name;
    const status = body.status !== undefined ? (body.status || "").trim() : old.status;
    if (!name) return bad("name 不可為空");
    await db.prepare("UPDATE folders SET name = ?, status = ? WHERE id = ?").bind(name, status, id).run();
    await logHistory(db, null, id, "更新資料夾", `${name}／${status}`);
    return json({ ok: true });
  }

  // ---- entries ----
  if (path === "/entries" && method === "GET") {
    const folderId = url.searchParams.get("folder_id");
    const inbox = url.searchParams.get("inbox");
    let q;
    if (inbox) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id IS NULL ORDER BY e.id DESC`
      );
    } else if (folderId) {
      q = db.prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = e.id) AS att_count
         FROM entries e WHERE e.folder_id = ? ORDER BY e.id DESC`
      ).bind(Number(folderId));
    } else {
      return bad("需指定 folder_id 或 inbox=1");
    }
    const { results } = await q.all();
    return json(results);
  }
  if (path === "/entries" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const folderId = body.folder_id ? Number(body.folder_id) : null;
    const r = await db.prepare(
      "INSERT INTO entries (folder_id, title, fields_json, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(folderId, (body.title || "").trim(), JSON.stringify(body.fields || {}), (body.body || "").trim(), now()).run();
    await logHistory(db, r.meta.last_row_id, folderId, "新增紀錄", body.title || "");
    return json({ id: r.meta.last_row_id, ok: true });
  }
  const entryMatch = path.match(/^\/entries\/(\d+)$/);
  if (entryMatch && method === "GET") {
    const id = Number(entryMatch[1]);
    const entry = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!entry) return bad("找不到紀錄", 404);
    const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(id).all();
    return json({ ...entry, attachments: atts });
  }
  if (entryMatch && method === "PUT") {
    const id = Number(entryMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const title = body.title !== undefined ? (body.title || "").trim() : old.title;
    const bodyText = body.body !== undefined ? (body.body || "").trim() : old.body;
    const fields = body.fields !== undefined ? JSON.stringify(body.fields) : old.fields_json;
    const folderId = body.folder_id !== undefined ? (body.folder_id ? Number(body.folder_id) : null) : old.folder_id;
    await db.prepare("UPDATE entries SET title = ?, body = ?, fields_json = ?, folder_id = ?, updated_at = ? WHERE id = ?")
      .bind(title, bodyText, fields, folderId, now(), id).run();
    if (body.folder_id !== undefined && folderId !== old.folder_id) {
      await logHistory(db, id, folderId, "歸檔", title);
    } else {
      await logHistory(db, id, folderId, "更新紀錄", title);
    }
    return json({ ok: true });
  }
  if (entryMatch && method === "DELETE") {
    const id = Number(entryMatch[1]);
    const old = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到紀錄", 404);
    const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ?").bind(id).all();
    if (env.FILES) {
      for (const a of atts) await env.FILES.delete(a.key).catch(() => {});
    }
    await db.prepare("DELETE FROM attachments WHERE entry_id = ?").bind(id).run();
    await db.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
    await logHistory(db, null, old.folder_id, "刪除紀錄", old.title);
    return json({ ok: true });
  }

  // ---- 附件上傳（R2）----
  if (path === "/upload" && method === "POST") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存（見 fieldlog/README.md）", 501);
    const entryId = Number(request.headers.get("x-entry-id") || 0);
    if (!entryId) return bad("缺 x-entry-id");
    const filename = decodeURIComponent(request.headers.get("x-filename") || "file").trim();
    const mime = request.headers.get("content-type") || "application/octet-stream";
    const offsetRaw = request.headers.get("x-offset-secs");
    const offsetSecs = offsetRaw !== null && offsetRaw !== "" ? Number(offsetRaw) : null;
    const kind = mime.startsWith("image/") ? "photo" : mime.startsWith("audio/") ? "audio" : "file";
    const body = await request.arrayBuffer();
    if (!body.byteLength) return bad("空檔案");
    if (body.byteLength > 50 * 1024 * 1024) return bad("檔案過大（上限 50MB）");
    const key = `${entryId}/${Date.now()}-${filename.replace(/[^\w.\-一-鿿]+/g, "_")}`;
    await env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
    const r = await db.prepare(
      "INSERT INTO attachments (entry_id, kind, filename, key, size, mime, offset_secs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(entryId, kind, filename, key, body.byteLength, mime, offsetSecs, now()).run();
    await logHistory(db, entryId, null, "上傳附件", `${filename}（${(body.byteLength / 1024 / 1024).toFixed(1)}MB）`);
    return json({ id: r.meta.last_row_id, key, ok: true });
  }
  const fileMatch = path.match(/^\/file\/(.+)$/);
  if (fileMatch && method === "GET") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存", 501);
    const obj = await env.FILES.get(decodeURIComponent(fileMatch[1]));
    if (!obj) return bad("找不到檔案", 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  }
  const attMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attMatch && method === "PUT") {
    const id = Number(attMatch[1]);
    const body = await request.json().catch(() => ({}));
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (body.ocr_text !== undefined) {
      const ocrText = (body.ocr_text || "").trim();
      await db.prepare("UPDATE attachments SET ocr_text = ? WHERE id = ?").bind(ocrText, id).run();
      await logHistory(db, old.entry_id, null, "編輯擷取文字", `${old.filename}：「${ocrText.slice(0, 80)}」`);
      return json({ ok: true });
    }
    const category = (body.category !== undefined ? body.category : old.category) || "";
    await db.prepare("UPDATE attachments SET category = ? WHERE id = ?").bind(category.trim(), id).run();
    return json({ ok: true });
  }
  if (attMatch && method === "DELETE") {
    const id = Number(attMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (env.FILES) await env.FILES.delete(old.key);
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
    await logHistory(db, old.entry_id, null, "刪除附件", old.filename);
    return json({ ok: true });
  }

  // ---- 錄音轉文字（Workers AI Whisper）----
  const transcribeMatch = path.match(/^\/attachments\/(\d+)\/transcribe$/);
  if (transcribeMatch && method === "POST") {
    if (!env.AI) return bad("尚未啟用 Workers AI（見 fieldlog/README.md）", 501);
    const id = Number(transcribeMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (old.kind !== "audio") return bad("只有錄音檔可以轉文字");
    const obj = await env.FILES.get(old.key);
    if (!obj) return bad("找不到檔案內容", 404);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(binary), task: "transcribe" });
    const text = (result?.text || "").trim();
    await db.prepare("UPDATE attachments SET transcript = ? WHERE id = ?").bind(text, id).run();
    await logHistory(db, old.entry_id, null, "錄音轉文字", `${old.filename}：${text.slice(0, 60)}`);
    return json({ text });
  }

  // ---- 照片擷取文字（影像 skill，與 Medtec 共用同一份模組）----
  // 同一筆紀錄（entry）就是一段採集經驗：照片的 offset_secs 落在哪一段錄音
  // 的範圍，就拿那段的逐字稿判斷「拍這張時在講什麼」，附上關聯句
  const ocrMatch = path.match(/^\/attachments\/(\d+)\/ocr$/);
  if (ocrMatch && method === "POST") {
    if (!env.AI || !env.FILES) return bad("尚未啟用圖片擷取文字（需 Workers AI 與 R2）", 501);
    const id = Number(ocrMatch[1]);
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (old.kind !== "photo") return bad("只有照片可以擷取文字");
    const obj = await env.FILES.get(old.key);
    if (!obj) return bad("找不到檔案內容", 404);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const r = await extractImageText(env.AI, bytes);
    if (!r.ok) return bad(r.error, 502);
    let text = r.text;
    if (old.offset_secs !== null && old.offset_secs !== undefined) {
      // 找同一筆紀錄裡「起始秒數 ≤ 照片秒數」最近的那段錄音（分段錄音的起點都記在 offset_secs）
      const { results: siblings } = await db
        .prepare("SELECT * FROM attachments WHERE entry_id = ? AND kind = 'audio' AND offset_secs IS NOT NULL ORDER BY offset_secs ASC")
        .bind(old.entry_id)
        .all();
      let seg = null;
      for (const a of siblings) {
        if (a.offset_secs <= old.offset_secs) seg = a;
      }
      const transcript = seg ? (seg.transcript || "").trim() : "";
      if (transcript) {
        const relation = await judgeRelation(env.AI, transcript, text);
        if (relation && !relation.includes("看不出明顯關聯")) {
          text += `\n\n【對話關聯】${relation}（錄音 ${fmtSecs(old.offset_secs)} 時拍攝）`;
        }
      }
    }
    await db.prepare("UPDATE attachments SET ocr_text = ? WHERE id = ?").bind(text, id).run();
    await logHistory(db, old.entry_id, null, "照片擷取文字", `${old.filename}：${text.slice(0, 60)}`);
    return json({ ocr_text: text });
  }

  // ---- 匯出：整個資料夾 → Markdown 原料包（給 AI 彙整用）----
  const exportMatch = path.match(/^\/export\/folder\/(\d+)$/);
  if (exportMatch && method === "GET") {
    const id = Number(exportMatch[1]);
    const folder = await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first();
    if (!folder) return bad("找不到資料夾", 404);
    const { results: entries } = await db.prepare("SELECT * FROM entries WHERE folder_id = ? ORDER BY id").bind(id).all();
    const lines = [
      `# ${folder.name}（${folder.type}）`,
      ``,
      `> 隨身記事本原始資料匯出｜共 ${entries.length} 筆紀錄｜匯出於 ${now()}`,
      `> 這是現場採集的 raw data（速記、錄音轉文字、照片時間點），`,
      `> 請依內容彙整成一份結構清楚的報告。照片無法直接檢視，`,
      `> 但每張都標注了「錄音第幾分幾秒拍攝」，可對照轉錄文字判斷拍攝當下的語境。`,
      ``,
    ];
    for (const e of entries) {
      const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE entry_id = ? ORDER BY id").bind(e.id).all();
      lines.push(`---`, ``, `## ${e.title || "（未命名紀錄）"}`, ``, `建立：${e.created_at}${e.updated_at ? `｜更新：${e.updated_at}` : ""}`);
      const fields = JSON.parse(e.fields_json || "{}");
      const filled = Object.entries(fields).filter(([, v]) => v && String(v).trim());
      if (filled.length) {
        lines.push(``);
        for (const [k, v] of filled) lines.push(`- **${k}**：${v}`);
      }
      if (e.body) lines.push(``, e.body);
      const audios = atts.filter((a) => a.kind === "audio");
      const photos = atts.filter((a) => a.kind === "photo");
      const files = atts.filter((a) => a.kind === "file");
      if (audios.length) {
        lines.push(``, `### 錄音轉文字`);
        for (const a of audios) {
          const label = a.offset_secs !== null ? `（起於 ${fmtSecs(a.offset_secs)}）` : "";
          lines.push(``, `**${a.filename}**${label}`, a.transcript ? a.transcript : "（尚未轉文字）");
        }
      }
      if (photos.length) {
        lines.push(``, `### 照片（共 ${photos.length} 張）`);
        for (const a of photos) {
          const when = a.offset_secs !== null ? `錄音 ${fmtSecs(a.offset_secs)} 時拍攝` : a.created_at;
          lines.push(`- ${a.filename}｜${when}${a.category ? `｜分類：${a.category}` : ""}`);
          if (a.ocr_text) lines.push(`  - 照片內文字（AI 擷取）：${a.ocr_text.replace(/\n+/g, " ／ ")}`);
        }
      }
      if (files.length) {
        lines.push(``, `### 其他檔案`);
        for (const a of files) lines.push(`- ${a.filename}（${(a.size / 1024 / 1024).toFixed(1)}MB）`);
      }
      lines.push(``);
    }
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="fieldlog-folder-${id}.md"`,
      },
    });
  }

  return bad("不存在的 API 路徑", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /wiki/* 是個人知識庫內容（wrangler run_worker_first 導進來的），
    // 與 API 同一套 PIN 驗證，通過才放行到靜態資產
    if (url.pathname.startsWith("/wiki/")) {
      const pin = (env.FIELD_PIN || "").trim();
      if (!pin) return bad("尚未設定 FIELD_PIN：請至 Worker Settings → Variables and Secrets 新增", 401);
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
      if (given !== pin) return bad("PIN 錯誤或未提供", 401);
      return env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin), request));
    }
    if (url.pathname.startsWith("/api/")) {
      // fail-closed：FIELD_PIN 未設定時全部拒絕
      const pin = (env.FIELD_PIN || "").trim();
      if (!pin) return bad("尚未設定 FIELD_PIN：請至 Worker Settings → Variables and Secrets 新增", 401);
      const given = (request.headers.get("x-pin") || url.searchParams.get("pin") || "").trim();
      if (given !== pin) return bad("PIN 錯誤或未提供", 401);
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad(`伺服器錯誤：${err.message}`, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
