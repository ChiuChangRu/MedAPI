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
    goal_tags TEXT DEFAULT '[]',
    quals TEXT DEFAULT '[]',
    post_class TEXT DEFAULT '',
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
  `CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exhibitor_id TEXT NOT NULL,
    author TEXT NOT NULL,
    filename TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_att_ex ON attachments(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_ex ON notes(exhibitor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hist_ex ON history(exhibitor_id)`,
];

// 後續新增的欄位（既有資料表用 ALTER 補上，新表已含在下方 MIGRATIONS 對既有表無害）
const MIGRATIONS = [
  `ALTER TABLE exhibitor_state ADD COLUMN goal_tags TEXT DEFAULT '[]'`,
  `ALTER TABLE exhibitor_state ADD COLUMN quals TEXT DEFAULT '[]'`,
  `ALTER TABLE exhibitor_state ADD COLUMN post_class TEXT DEFAULT ''`,
  `ALTER TABLE attachments ADD COLUMN caption TEXT DEFAULT ''`,
  `ALTER TABLE exhibitor_state ADD COLUMN visit_record TEXT DEFAULT '{}'`,
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!String(err.message || err).includes("duplicate column")) throw err;
    }
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

async function logHistory(db, exhibitorId, author, action, detail) {
  await db
    .prepare("INSERT INTO history (exhibitor_id, author, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(exhibitorId, author, action, detail, now())
    .run();
}

const STATE_FIELDS = ["status", "assignee", "dept_tags", "collected", "pocket", "goal_tags", "quals", "post_class"];
const JSON_FIELDS = ["dept_tags", "collected", "goal_tags", "quals"];
const STATE_LABELS = {
  status: "拜訪狀態", assignee: "負責人", dept_tags: "部門標籤", collected: "索取資料",
  pocket: "口袋名單", goal_tags: "觀展目標", quals: "資質確認", post_class: "展後分類",
  visit_record: "拜訪成果",
};

async function handleApi(request, env, url) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // ---- 前端功能開關 ----
  if (path === "/config" && method === "GET") {
    return json({ uploads: !!env.FILES });
  }

  // ---- 附件（照片/錄音/影片，存 R2）----
  if (path === "/upload" && method === "POST") {
    if (!env.FILES) return bad("尚未設定 R2 檔案儲存（見 cloudflare/README.md）", 501);
    const exhibitorId = (request.headers.get("x-exhibitor-id") || "").trim();
    const author = decodeURIComponent(request.headers.get("x-author") || "").trim() || "匿名";
    const filename = decodeURIComponent(request.headers.get("x-filename") || "file").trim();
    const mime = request.headers.get("content-type") || "application/octet-stream";
    if (!exhibitorId) return bad("缺 x-exhibitor-id");
    const body = await request.arrayBuffer();
    if (!body.byteLength) return bad("空檔案");
    if (body.byteLength > 50 * 1024 * 1024) return bad("檔案過大（上限 50MB），長影片請縮短或改用相簿分享");
    const key = `${exhibitorId}/${Date.now()}-${filename.replace(/[^\w.\-一-鿿]+/g, "_")}`;
    await env.FILES.put(key, body, { httpMetadata: { contentType: mime } });
    const result = await db
      .prepare("INSERT INTO attachments (exhibitor_id, author, filename, key, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(exhibitorId, author, filename, key, body.byteLength, mime, now())
      .run();
    await logHistory(db, exhibitorId, author, "上傳附件", `${filename}（${(body.byteLength / 1024 / 1024).toFixed(1)}MB）`);
    return json({ id: result.meta.last_row_id, key, ok: true });
  }
  if (path === "/attachments" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) return bad("缺 exhibitor_id");
    const { results } = await db
      .prepare("SELECT * FROM attachments WHERE exhibitor_id = ? ORDER BY id DESC")
      .bind(exhibitorId)
      .all();
    return json(results);
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
  const attCapMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attCapMatch && method === "PUT") {
    const id = Number(attCapMatch[1]);
    const body = await request.json().catch(() => ({}));
    const author = (body.author || "").trim() || "匿名";
    const caption = (body.caption || "").trim();
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    await db.prepare("UPDATE attachments SET caption = ? WHERE id = ?").bind(caption, id).run();
    await logHistory(db, old.exhibitor_id, author, "附件說明", `${old.filename}：「${caption.slice(0, 80)}」`);
    return json({ ok: true });
  }

  const attDelMatch = path.match(/^\/attachments\/(\d+)$/);
  if (attDelMatch && method === "DELETE") {
    const id = Number(attDelMatch[1]);
    const author = (url.searchParams.get("author") || "").trim() || "匿名";
    const old = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
    if (!old) return bad("找不到附件", 404);
    if (env.FILES) await env.FILES.delete(old.key);
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
    await logHistory(db, old.exhibitor_id, author, "刪除附件", old.filename);
    return json({ ok: true });
  }

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
        goal_tags: JSON.parse(s.goal_tags || "[]"),
        quals: JSON.parse(s.quals || "[]"),
        post_class: s.post_class || "",
        pocket: !!s.pocket,
        updated_by: s.updated_by,
        updated_at: s.updated_at,
        note_count: countMap[s.exhibitor_id] || 0,
        visit_record: JSON.parse(s.visit_record || "{}"),
      };
    }
    for (const id of Object.keys(countMap)) {
      if (!out[id]) out[id] = { status: "未排定", assignee: "", dept_tags: [], collected: [], goal_tags: [], quals: [], post_class: "", pocket: false, note_count: countMap[id], visit_record: {} };
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
      if (JSON_FIELDS.includes(f)) v = JSON.stringify(Array.isArray(v) ? v : []);
      if (f === "pocket") v = v ? 1 : 0;
      updates[f] = v;
    }
    if ("visit_record" in body) {
      const vr = (typeof body.visit_record === "object" && body.visit_record !== null) ? body.visit_record : {};
      updates.visit_record = JSON.stringify(vr);
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
      .map(([f, v]) => {
        if (f === "visit_record") return "儲存拜訪成果記錄";
        return `${STATE_LABELS[f] || f} → ${f === "pocket" ? (v ? "加入" : "移除") : v}`;
      })
      .join("；");
    await logHistory(db, exhibitorId, author, "更新狀態", detail);

    const row = await db.prepare("SELECT * FROM exhibitor_state WHERE exhibitor_id = ?").bind(exhibitorId).first();
    return json({
      status: row.status,
      assignee: row.assignee,
      dept_tags: JSON.parse(row.dept_tags || "[]"),
      collected: JSON.parse(row.collected || "[]"),
      goal_tags: JSON.parse(row.goal_tags || "[]"),
      quals: JSON.parse(row.quals || "[]"),
      post_class: row.post_class || "",
      pocket: !!row.pocket,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      visit_record: JSON.parse(row.visit_record || "{}"),
    });
  }

  // ---- notes ----
  if (path === "/notes" && method === "GET") {
    const exhibitorId = url.searchParams.get("exhibitor_id");
    if (!exhibitorId) {
      // 不帶 exhibitor_id：回傳全部筆記（登入時整批快照到手機，離線也看得到代問事項）
      const { results } = await db
        .prepare("SELECT * FROM notes WHERE deleted = 0 ORDER BY exhibitor_id, id DESC")
        .all();
      return json(results);
    }
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

  // ---- 個人參訪報告（HTML，可直接列印存 PDF）----
  if (path === "/report" && method === "GET") {
    const author = (url.searchParams.get("author") || "").trim();
    if (!author) return bad("缺 author");

    const assetRes = await env.ASSETS.fetch(new Request(new URL("/data/exhibitors.json", url).toString()));
    const data = await assetRes.json();
    const exMap = {};
    for (const e of data.exhibitors) exMap[e.id] = e;
    const catMap = {};
    for (const c of data.categories) catMap[c.id] = c.name_zh;

    const { results: states } = await db.prepare("SELECT * FROM exhibitor_state").all();
    const { results: myNotes } = await db
      .prepare("SELECT * FROM notes WHERE deleted = 0 AND author = ? ORDER BY id")
      .bind(author)
      .all();
    const { results: myAtts } = await db
      .prepare("SELECT * FROM attachments WHERE author = ? ORDER BY id")
      .bind(author)
      .all();

    const stateMap = {};
    for (const s of states) stateMap[s.exhibitor_id] = s;
    const notesByEx = {};
    for (const n of myNotes) (notesByEx[n.exhibitor_id] = notesByEx[n.exhibitor_id] || []).push(n);
    const attsByEx = {};
    for (const a of myAtts) (attsByEx[a.exhibitor_id] = attsByEx[a.exhibitor_id] || []).push(a);

    // 我的廠商 = 指派給我的 ∪ 我寫過紀錄的 ∪ 我傳過附件的
    const ids = new Set([
      ...states.filter((s) => s.assignee === author).map((s) => s.exhibitor_id),
      ...Object.keys(notesByEx),
      ...Object.keys(attsByEx),
    ]);
    const list = [...ids]
      .map((id) => ({ id, ex: exMap[id], st: stateMap[id] || {} }))
      .filter((x) => x.ex)
      .sort((a, b) => (a.ex.booth_no || "").localeCompare(b.ex.booth_no || ""));

    const QUAL_LABELS = { iso13485: "ISO 13485", fda: "FDA", ce_mdr: "CE/MDR" };
    const COLLECTED_LABELS = { catalog: "型錄", card: "名片", sample: "樣品", quote: "報價" };
    const h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const j = (raw, labels) => JSON.parse(raw || "[]").map((x) => (labels ? labels[x] || x : x)).join("、");

    const visited = list.filter((x) => x.st.status === "已拜訪").length;
    const today = new Date().toISOString().slice(0, 10);

    const sections = list.map(({ id, ex, st }) => {
      const notes = (notesByEx[id] || [])
        .map((n) => `<div class="note"><span class="meta">[${h(n.type)}｜${h(n.created_at)}]</span> ${h(n.content)}</div>`)
        .join("");
      const atts = (attsByEx[id] || [])
        .map((a) => `<li>${h(a.filename)}（${(a.size / 1024 / 1024).toFixed(1)}MB）${a.caption ? `──${h(a.caption)}` : ""}</li>`)
        .join("");
      const facts = [
        st.status && st.status !== "未排定" ? `狀態：${h(st.status)}` : "",
        st.post_class ? `展後分類：${h(st.post_class)}` : "",
        j(st.goal_tags) ? `目標：${h(j(st.goal_tags))}` : "",
        j(st.quals, QUAL_LABELS) ? `資質：${h(j(st.quals, QUAL_LABELS))}` : "",
        j(st.collected, COLLECTED_LABELS) ? `已索取：${h(j(st.collected, COLLECTED_LABELS))}` : "",
      ].filter(Boolean).join("｜");
      const vr = JSON.parse(st.visit_record || "{}");
      const vrFacts = [
        (vr.obtained || []).length ? `取得：${h(vr.obtained.join("、"))}` : "",
        vr.contact ? `聯絡人：${h(vr.contact)}` : "",
        vr.moq ? `MOQ：${h(vr.moq)}` : "",
        vr.lead_time ? `交期：${h(vr.lead_time)}` : "",
        vr.next_step ? `下一步：${h(vr.next_step)}` : "",
      ].filter(Boolean).join("｜");
      const vrText = [
        (vr.solves || vr.note) ? `<div class="note"><span class="meta">[能為邦特解決什麼問題]</span> ${h(vr.solves || vr.note)}</div>` : "",
        vr.diff ? `<div class="note"><span class="meta">[相較現有方案的差異]</span> ${h(vr.diff)}</div>` : "",
      ].join("");
      return `<section>
        <h2>${h(ex.name_zh)} <span class="booth">${h(ex.booth_no)}</span></h2>
        <p class="sub">${h(ex.name_en || "")}｜${h(catMap[ex.category] || "")}｜${h(ex.country)}</p>
        ${facts ? `<p class="facts">${facts}</p>` : ""}
        ${vrFacts ? `<p class="facts">拜訪成果：${vrFacts}</p>` : ""}
        ${vrText}
        ${notes || '<p class="none">（無個人紀錄）</p>'}
        ${atts ? `<p class="facts">附件：</p><ul>${atts}</ul>` : ""}
      </section>`;
    }).join("");

    const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${h(author)} 參訪報告 ${today}</title>
<style>
body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#1c1c1a;max-width:800px;margin:24px auto;padding:0 16px;line-height:1.7;}
h1{font-size:22px;border-bottom:3px solid #c8102e;padding-bottom:8px;}
h1 small{display:block;font-size:12px;color:#6f6f68;font-weight:normal;margin-top:4px;}
h2{font-size:16px;margin:0 0 2px;}
.booth{font-family:ui-monospace,monospace;font-size:13px;border:1px solid #1c1c1a;padding:1px 6px;border-radius:4px;margin-left:6px;}
.sub{color:#6f6f68;font-size:12px;margin:0 0 6px;}
.facts{font-size:13px;color:#a00d24;margin:4px 0;}
.note{font-size:13px;background:#f7f7f5;border:1px solid #e4e4e0;border-radius:6px;padding:8px 10px;margin:6px 0;white-space:pre-line;}
.meta{color:#6f6f68;font-size:11px;}
.none{color:#9a9a92;font-size:12px;}
section{border-bottom:1px dashed #e4e4e0;padding:14px 0;page-break-inside:avoid;}
ul{margin:4px 0;font-size:13px;}
.print-btn{position:fixed;top:16px;right:16px;padding:10px 18px;background:#c8102e;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;}
@media print{.print-btn{display:none;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">列印 / 存 PDF</button>
<h1>2026 上海 Medtec 參訪報告──${h(author)}<small>產出日期 ${today}｜涉及廠商 ${list.length} 家｜已拜訪 ${visited} 家</small></h1>
${sections || "<p>尚無任何紀錄或指派。</p>"}
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    const QUAL_LABELS = { iso13485: "ISO 13485", fda: "FDA", ce_mdr: "CE/MDR" };
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["﻿廠商,攤位,館別,拜訪狀態,展後分類,觀展目標,資質確認,負責人,索取資料,口袋名單,取得資料,聯絡人,MOQ,交期,能解決什麼問題,與現有方案差異,下一步,紀錄數,所有紀錄"];

    const allIds = new Set([...states.map((s) => s.exhibitor_id), ...Object.keys(notesByEx)]);
    for (const id of allIds) {
      const ex = exMap[id] || {};
      const s = states.find((x) => x.exhibitor_id === id) || {};
      const exNotes = notesByEx[id] || [];
      const noteText = exNotes.map((n) => `[${n.created_at} ${n.author}/${n.type}] ${n.content}`).join("\n");
      const collected = JSON.parse(s.collected || "[]").map((c) => COLLECTED_LABELS[c] || c).join("、");
      const quals = JSON.parse(s.quals || "[]").map((q) => QUAL_LABELS[q] || q).join("、");
      const vr = JSON.parse(s.visit_record || "{}");
      lines.push(
        [
          esc(ex.name_zh || id),
          esc(ex.booth_no || ""),
          esc(ex.hall || ""),
          esc(s.status || "未排定"),
          esc(s.post_class || ""),
          esc(JSON.parse(s.goal_tags || "[]").join("、")),
          esc(quals),
          esc(s.assignee || ""),
          esc(collected),
          esc(s.pocket ? "是" : ""),
          esc((vr.obtained || []).join("、")),
          esc(vr.contact || ""),
          esc(vr.moq || ""),
          esc(vr.lead_time || ""),
          esc(vr.solves || vr.note || ""),
          esc(vr.diff || ""),
          esc(vr.next_step || ""),
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
      // PIN 驗證：一律要求正確 PIN；TEAM_PIN 未設定時全部拒絕（fail-closed）
      // trim() 兩邊都做，避免 Secret 貼上時尾端夾帶看不見的換行/空白造成誤判
      const teamPin = (env.TEAM_PIN || "").trim();
      if (!teamPin) {
        return bad("系統尚未設定團隊 PIN：請至 Worker 的 Settings → Variables and Secrets 新增 Secret「TEAM_PIN」", 401);
      }
      const pin = (request.headers.get("x-team-pin") || url.searchParams.get("pin") || "").trim();
      if (pin !== teamPin) return bad("PIN 錯誤或未提供", 401);
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return bad(`伺服器錯誤：${err.message}`, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
