/**
 * 外部來源同步引擎（規格書 I 項目 1／2／3／4 的執行核心）。
 *
 * 取代原本一次性的 /admin/import-litdb：來源清單從 sources 表讀（不寫死）、
 * body 用通用渲染器展開（任何欄位自動可搜尋）、用 content hash 做 upsert
 * （內容沒變不動、變了才更新、來源消失標記不刪除），手動端點與 cron 排程
 * 共用同一套。每跑一次寫一列 sync_log，「資料是不是過時」變成查得到的事實。
 *
 * 人工內容的保護：同步只改寫 body 裡 SYNC_START..SYNC_END 標記之間的區塊，
 * 標記之外（使用者自己加的註記）永遠不動。litdb 的 patentResults／patent_core
 * 是 AI 深度分析產物，依「AI 產出與人工內容永久分離」原則進 analysis_json
 * 欄位，不混進 body。
 */

import { renderTree } from "./render.js";

export const SYNC_START = "<!-- sync:start 以下為來源自動同步區，同步時會整段改寫 -->";
export const SYNC_END = "<!-- sync:end 在這行之後加的註記不會被同步動到 -->";

// litdb 每筆資料裡屬於「AI 深度分析產物」的鍵——進 analysis_json，不進 body
const ANALYSIS_KEYS = ["patentResults", "patent_core"];

// 這幾個鍵已經進 fields_json 當結構化欄位（前台表格顯示用），body 不再重複；
// title 是記事標題本身。tags 刻意「兩邊都放」：fields 給表格看、body 給搜尋
// snippet 用（規格書 I 項目 2 的明確要求）。
const FIELD_ONLY_KEYS = ["title", "authors", "year", "venue", "doc_type"];

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 依 items_path（支援 a.b.c 點路徑）從來源 JSON 取出資料陣列
export function itemsAtPath(data, path) {
  let node = data;
  for (const part of String(path || "papers").split(".").filter(Boolean)) {
    if (!node || typeof node !== "object") return null;
    node = node[part];
  }
  return Array.isArray(node) ? node : null;
}

/** 同步區塊改寫：有標記就只換標記內；沒有標記＝首次建立，整個 body 就是同步區 */
export function mergeSyncedBody(oldBody, renderedText) {
  const block = `${SYNC_START}\n${renderedText}\n${SYNC_END}`;
  if (!oldBody) return block;
  const re = new RegExp(`${escapeRegExp(SYNC_START)}[\\s\\S]*?${escapeRegExp(SYNC_END)}`);
  if (re.test(oldBody)) return oldBody.replace(re, block);
  // 沒有標記的既有列＝第一版匯入器寫的（純機器產出、無人工加註的分界可辨識），
  // 整段換成帶標記的新渲染；換掉的事實會記進 history，不是靜默行為
  return block;
}

function buildFields(item, source, existingFields) {
  const sid = `${source.key}:${item[source.id_field || "id"]}`;
  // 從既有欄位出發（保留使用者自己加的欄位與舊的 litdb_id），再覆寫來源欄位
  const fields = { ...(existingFields || {}) };
  if (item.authors !== undefined) fields["作者"] = item.authors || "";
  if (item.year !== undefined) fields["年份"] = item.year || "";
  if (item.venue !== undefined) fields["來源"] = item.venue || "";
  if (item.doc_type !== undefined) fields["文件類型"] = item.doc_type || "";
  if (Array.isArray(item.tags)) fields["標籤"] = item.tags.join("、");
  fields._source_key = source.key;
  fields._sid = sid;
  delete fields._orphaned; // 來源又出現了就解除孤兒標記
  return fields;
}

function extractAnalysis(item) {
  const analysis = {};
  for (const key of ANALYSIS_KEYS) {
    if (item[key] && typeof item[key] === "object") analysis[key] = item[key];
  }
  return Object.keys(analysis).length ? JSON.stringify(analysis) : "";
}

async function ensureFolder(db, name, type, parentId, stamp) {
  const existing = parentId === null
    ? await db.prepare("SELECT id FROM folders WHERE parent_id IS NULL AND name = ?").bind(name).first()
    : await db.prepare("SELECT id FROM folders WHERE parent_id = ? AND name = ?").bind(parentId, name).first();
  if (existing) return existing.id;
  const r = await db.prepare("INSERT INTO folders (name, type, parent_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(name, type, parentId, stamp).run();
  return r.meta.last_row_id;
}

/**
 * 預載「所有由來源同步管理的記事」：_sid（新制）或 litdb_id（第一版匯入器
 * 寫的舊制，格式相同 key:id）→ {id, hash, body, fields}。一次查詢建好索引，
 * 之後每筆資料的去重／比對都在記憶體做，不用逐筆下 SELECT。
 */
async function loadSyncedEntries(db) {
  const { results } = await db.prepare(
    `SELECT id, fields_json, body FROM entries
     WHERE json_extract(fields_json, '$._sid') IS NOT NULL
        OR json_extract(fields_json, '$.litdb_id') IS NOT NULL`
  ).all();
  const bySid = new Map();
  for (const row of results) {
    let fields = {};
    try { fields = JSON.parse(row.fields_json || "{}"); } catch { /* 壞 JSON 當空 */ }
    const sid = fields._sid || fields.litdb_id;
    if (!sid) continue;
    bySid.set(sid, { id: row.id, hash: fields._content_hash || "", body: row.body || "", fields });
  }
  return bySid;
}

/** 同步單一來源。錯誤往外丟，由 syncSources 統一接住記 log（單一來源失敗不中斷其他來源）。 */
async function syncOneSource(db, source, bySid, fetchImpl) {
  const stamp = nowStamp();
  const res = await fetchImpl(source.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = itemsAtPath(data, source.items_path);
  if (!items) throw new Error(`來源 JSON 裡找不到「${source.items_path || "papers"}」陣列——檢查 sources.items_path 設定`);

  let folderId = null;
  const counts = { inserted: 0, updated: 0, skipped: 0, orphaned: 0, total: items.length };
  const seenSids = new Set();

  for (const item of items) {
    const rawId = item?.[source.id_field || "id"];
    if (rawId === undefined || rawId === null || rawId === "") { counts.skipped++; continue; }
    const sid = `${source.key}:${rawId}`;
    seenSids.add(sid);

    const contentHash = await sha256Hex(JSON.stringify(item));
    const existing = bySid.get(sid);
    if (existing && existing.hash === contentHash) { counts.skipped++; continue; }

    const title = String(item[source.title_field || "title"] || rawId);
    const rendered = renderTree(item, [...FIELD_ONLY_KEYS, ...ANALYSIS_KEYS]);
    const analysisJson = extractAnalysis(item);
    const fields = buildFields(item, source, existing?.fields);
    fields._content_hash = contentHash;

    if (existing) {
      const body = mergeSyncedBody(existing.body, rendered);
      await db.prepare(
        `UPDATE entries SET title = ?, fields_json = ?, body = ?, analysis_json = ?, analysis_at = ?, analysis_model = ?, updated_at = ? WHERE id = ?`
      ).bind(
        title, JSON.stringify(fields), body,
        analysisJson, analysisJson ? stamp : "", analysisJson ? "litdb-原生" : "",
        stamp, existing.id
      ).run();
      await db.prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(existing.id, null, "來源同步更新", `${source.key}：${title}`.slice(0, 200), stamp).run();
      bySid.set(sid, { id: existing.id, hash: contentHash, body, fields });
      counts.updated++;
      continue;
    }

    if (folderId === null) {
      const parentId = source.folder_parent
        ? await ensureFolder(db, source.folder_parent, source.folder_type || "文獻庫", null, stamp)
        : null;
      folderId = await ensureFolder(db, source.label, source.folder_type || "文獻庫", parentId, stamp);
    }
    const body = mergeSyncedBody("", rendered);
    const r = await db.prepare(
      `INSERT INTO entries (folder_id, title, fields_json, body, analysis_json, analysis_at, analysis_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      folderId, title, JSON.stringify(fields), body,
      analysisJson, analysisJson ? stamp : "", analysisJson ? "litdb-原生" : "", stamp
    ).run();
    await db.prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(r.meta.last_row_id, folderId, "來源同步新增", `${source.key}：${title}`.slice(0, 200), stamp).run();
    bySid.set(sid, { id: r.meta.last_row_id, hash: contentHash, body, fields });
    counts.inserted++;
  }

  // 來源端消失的資料：標 _orphaned 由人決定，不自動刪（raw data 只增不刪的原則）
  for (const [sid, entry] of bySid) {
    if (!sid.startsWith(`${source.key}:`) || seenSids.has(sid) || entry.fields._orphaned) continue;
    const fields = { ...entry.fields, _orphaned: true };
    await db.prepare("UPDATE entries SET fields_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(fields), stamp, entry.id).run();
    await db.prepare("INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(entry.id, null, "來源已移除", `${sid} 已不在來源清單，記事保留並標記，是否刪除由人決定`.slice(0, 200), stamp).run();
    entry.fields = fields;
    counts.orphaned++;
  }

  return counts;
}

/**
 * 同步 sources 表裡所有 enabled 的來源（only 指定 key 時只跑那一個）。
 * 手動端點與 cron 排程都呼叫這一支。每個來源各自 try/catch：
 * 一個來源掛掉（網路、JSON 壞掉）不影響其他來源，錯誤記進 sync_log 與回傳值。
 */
export async function syncSources(db, { only = null, fetchImpl = fetch } = {}) {
  const { results: sources } = only
    ? await db.prepare("SELECT * FROM sources WHERE enabled = 1 AND key = ?").bind(only).all()
    : await db.prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY id").all();
  if (!sources.length) {
    return { ok: false, results: [], note: only ? `找不到 enabled 的來源「${only}」` : "sources 表裡沒有任何 enabled 的來源" };
  }

  const bySid = await loadSyncedEntries(db);
  const results = [];
  for (const source of sources) {
    const startedAt = nowStamp();
    let counts = { inserted: 0, updated: 0, skipped: 0, orphaned: 0, total: 0 };
    let error = "";
    try {
      counts = await syncOneSource(db, source, bySid, fetchImpl);
      await db.prepare("UPDATE sources SET last_synced_at = ? WHERE id = ?").bind(nowStamp(), source.id).run();
    } catch (err) {
      error = err.message || String(err);
    }
    await db.prepare(
      `INSERT INTO sync_log (source_key, started_at, finished_at, inserted, updated, skipped, orphaned, errors, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      source.key, startedAt, nowStamp(),
      counts.inserted, counts.updated, counts.skipped, counts.orphaned,
      error, nowStamp()
    ).run();
    results.push({ source: source.key, ...counts, ...(error ? { error } : {}) });
  }
  return { ok: results.every((r) => !r.error), results };
}
