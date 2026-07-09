/**
 * Medtec China 2026 展商導覽（邦特團隊版）— Cloudflare Worker API
 *
 * 靜態前端由 assets（public/）供應，本 Worker 只處理 /api/*：
 *   - 團隊成員（members）
 *   - 展商共筆狀態（exhibitor_state：拜訪狀態、負責人、部門標籤、索取資料、口袋名單）
 *   - 留言/紀錄（notes，保留修改歷程）
 *   - 修改歷程（history，追加不刪）
 *   - CSV 匯出
 *
 * 驗證：所有 /api/* 需帶 x-team-pin header，與 TEAM_PIN（secret）比對。
 * 未設定 TEAM_PIN 時視為開發模式、不驗證（正式部署請務必設定）。
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    dept TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exhibitor_state (
    exhibitor_id TEXT PRIMARY KEY,
    status TEXT DEFAULT '未排定',
    assignee TEXT DEFAULT '',
    dept_tags TEXT DEFAULT '[]',
    collected TEXT DEFAULT '[]',
    pocket INTEGER DEFAULT 0,
    updated_by TEXT DEFAULT '',
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT NOT NULL,
    author TEXT NOT NULL,
    type TEXT DEFAULT '現場紀錄',
    content TEXT NOT NULL,
    deleted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT,
    author TEXT,
    action TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_ex ON notes(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hist_ex ON history(exhibitor_id)`,
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
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

async function logHistory(db, exhibitorId, author, action, detail) {
  await db
    .prepare("INSERT INTO history (exhibitor_id, author, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(exhibitorId, author, action, detail, now())
    .run();
}

const STATE_FIELDS = ["status", "assignee", "dept_tags", "collected", "pocket"];
const STATE_LABELS = { status: "拜訪狀態", assignee: "負責人", dept_tags: "部門標籤", collected: "索取資料", pocket: "口袋名單" };

async function handleApi(request, env, url) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // ---- members ----
  if (path === "/members" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM members ORDER BY id").all();
    return json(results);
  }
  if (path === "/members" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    if (!name) return bad("name 為必填");
    if (name.length > 30) return bad("名字太長");
    await db
      .prepare("INSERT INTO members (name, dept, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET dept = excluded.dept")
      .bind(name, (body.dept || "").trim(), now())
      .run();
    const { results } = await db.prepare("SELECT * FROM members ORDER BY id").all();
    return json(results);
  }

  // ---- state（一次抓全部，前端載入時用）----
  if (path === "/state" && method === "GET") {
    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: counts } = await db
      .prepare("SELECT exhibitor_id, COUNT(*) AS note_count FROM notes WHERE deleted = 0 GROUP BY exhibitor_id")
      .all();
    const countMap = {};
    for (const row of counts) countMap[row.exhibitor_id] = row.note_count;
    const out = {};
    for (const s of states) {
      out[s.exhibitor_id] = {
        status: s.status,
        assignee: s.assignee,
        dept_tags: JSON.parse(s.dept_tags || "[]"),
        collected: JSON.parse(s.collected || "[]"),
        pocket: !!s.pocket,
        updated_by: s.updated_by,
        updated_at: s.updated_at,
        note_count: countMap[s.exhibitor_id] || 0,
      };
    }
    for (const id of Object.keys(countMap)) {
      if (!out[id]) out[id] = { status: "未排定", assignee: "", dept_tags: [], collected: [], pocket: false, note_count: countMap[id] };
    }
    return json(out);
  }

  // ---- state 更新 ----
  const stateMatch = path.match(/^\/state\/([\w-]+)$/);
  if (stateMatch && method === "PUT") {
    const exhibitorId = stateMatch[1];
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";

    const updates = {};
    for (const f of STATE_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (f === "dept_tags" || f === "collected") v = JSON.stringify(Array.isArray(v) ? v : []);
      if (f === "pocket") v = v ? 1 : 0;
      updates[f] = v;
    }
    if (!Object.keys(updates).length) return bad("沒有可更新的欄位");

    await db
      .prepare("INSERT INTO exhibitor_state (exhibitor_id, updated_by, updated_at) VALUES (?, ?, ?) ON CONFLICT(exhibitor_id) DO NOTHING")
      .bind(exhibitorId, author, now())
      .run();
    const sets = Object.keys(updates).map((f) => `${f} = ?`).join(", ");
    await db
      .prepare(`UPDATE exhibitor_state SET ${sets}, updated_by = ?, updated_at = ? WHERE exhibitor_id = ?`)
      .bind(...Object.values(updates), author, now(), exhibitorId)
      .run();

    const detail = Object.entries(updates)
      .map(([f, v]) => `${STATE_LABELS[f] || f} → ${f === "pocket" ? (v ? "加入" : "移除") : v}`)
      .join("；");
    await logHistory(db, exhibitorId, author, "更新狀態", detail);

    const row = await db.prepare("SELECT * FROM exhibitor_state WHERE exhibitor_id = ?").bind(exhibitorId).first();
    return json({
      status: row.status,
      assignee: row.assignee,
      dept_tags: JSON.parse(row.dept_tags || "[]"),
      collected: JSON.parse(row.collected || "[]"),
      pocket: !!row.pocket,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    });
  }

  // ---- notes ----
  if (path === "/notes" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) return bad("缺 exhibitor_id");
    const { results } = await db
      .prepare("SELECT * FROM notes WHERE exhibitor_id = ? AND deleted = 0 ORDER BY id DESC")
      .bind(exhibitorId)
      .all();
    return json(results);
  }
  if (path === "/notes" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const exhibitorId = (body.exhibitor_id || "").trim();
    const author = (body.author || "").trim();
    const content = (body.content || "").trim();
    if (!exhibitorId || !author || !content) return bad("exhibitor_id、author、content 為必填");
    const type = (body.type || "現場紀錄").trim();
    const result = await db
      .prepare("INSERT INTO notes (exhibitor_id, author, type, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(exhibitorId, author, type, content, now())
      .run();
    await logHistory(db, exhibitorId, author, "新增紀錄", `[${type}] ${content.slice(0, 80)}`);
    return json({ id: result.meta.last_row_id, ok: true });
  }
  const noteMatch = path.match(/^\/notes\/(\d+)$/);
  if (noteMatch && method === "PUT") {
    const id = Number(noteMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const content = (body.content || "").trim();
    if (!content) return bad("content 為必填");
    const old = await db.prepare("SELECT * FROM notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?").bind(content, now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "修改紀錄", `原：「${String(old.content).slice(0, 60)}」→ 新：「${content.slice(0, 60)}」`);
    return json({ ok: true });
  }
  if (noteMatch && method === "DELETE") {
    const id = Number(noteMatch[1]);
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM notes WHERE id = ? AND deleted = 0").bind(id).first();
    if (!old) return bad("找不到這筆紀錄", 404);
    await db.prepare("UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?").bind(now(), id).run();
    await logHistory(db, old.exhibitor_id, author, "刪除紀錄", `[${old.type}] ${String(old.content).slice(0, 80)}`);
    return json({ ok: true });
  }

  // ---- history ----
  if (path === "/history" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    let stmt;
    if (exhibitorId) {
      stmt = db.prepare("SELECT * FROM history WHERE exhibitor_id = ? ORDER BY id DESC LIMIT 100").bind(exhibitorId);
    } else {
      stmt = db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT 200");
    }
    const { results } = await stmt.all();
    return json(results);
  }

  // ---- CSV 匯出 ----
  if (path === "/export.csv" && method === "GET") {
    const assetRes = await env.ASSETS.fetch(new Request(new URL("/data/exhibitors.json", url).toString()));
    const data = await assetRes.json();
    const exMap = {};
    for (const e of data.exhibitors) exMap[e.id] = e;

    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: notes } = await db
      .prepare("SELECT * FROM notes WHERE deleted = 0 ORDER BY exhibitor_id, id")
      .all();
    const notesByEx = {};
    for (const n of notes) {
      (notesByEx[n.exhibitor_id] = notesByEx[n.exhibitor_id] || []).push(n);
    }

    const COLLECTED_LABELS = { catalog: "型錄", card: "名片", sample: "樣品", quote: "報價" };
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["﻿廠商,攤位,館別,拜訪狀態,負責人,部門標籤,索取資料,口袋名單,紀錄數,所有紀錄"];

    const allIds = new Set([...states.map((s) => s.exhibitor_id), ...Object.keys(notesByEx)]);
    for (const id of allIds) {
      const ex = exMap[id] || {};
      const s = states.find((x) => x.exhibitor_id === id) || {};
      const exNotes = notesByEx[id] || [];
      const noteText = exNotes.map((n) => `[${n.created_at} ${n.author}/${n.type}] ${n.content}`).join("\n");
      const collected = JSON.parse(s.collected || "[]").map((c) => COLLECTED_LABELS[c] || c).join("、");
      lines.push(
        [
          esc(ex.name_zh || id),
          esc(ex.booth_no || ""),
          esc(ex.hall || ""),
          esc(s.status || "未排定"),
          esc(s.assignee || ""),
          esc(JSON.parse(s.dept_tags || "[]").join("、")),
          esc(collected),
          esc(s.pocket ? "是" : ""),
          esc(exNotes.length),
          esc(noteText),
        ].join(",")
      );
    }
    return new Response(lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=medtec_team_records.csv",
      },
    });
  }

  return bad("不存在的 API 路徑", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      // PIN 驗證：TEAM_PIN 未設定時放行（開發模式）
      if (env.TEAM_PIN) {
        const pin = request.headers.get("x-team-pin") || url.searchParams.get("pin") || "";
        if (pin !== env.TEAM_PIN) return bad("PIN 錯誤或未提供", 401);
      }
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad(`伺服器錯誤：${err.message}`, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
