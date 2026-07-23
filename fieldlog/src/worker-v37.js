import legacyWorker from "./worker.js";
import { stripPdfMetadata } from "./imageSkill.js";

const STANDARD_TITLES = new Map([
  ["ISO_7886-1_2017", "無菌皮下注射器－第1部：手動使用注射器"],
  ["ISO_7886-2_2020", "無菌皮下注射器－第2部：動力驅動注射泵用注射器"],
  ["ISO_7886-3_2020", "無菌皮下注射器－第3部：固定劑量免疫用自毀式注射器"],
  ["ISO_7886-4_2018", "無菌皮下注射器－第4部：具防止重複使用功能的注射器"],
  ["ISO_8536-14_2016", "醫療用輸液器具－第14部：非接液式輸血與輸液器具用夾具及流量調節器"],
  ["ISO_10555-1_2013", "血管內導管－無菌及單次使用導管－第1部：一般要求"],
  ["ISO_10555-8_2024", "血管內導管－無菌及單次使用導管－第8部：體外血液處理用導管"],
  ["ISO_10993-4_2017", "醫療器材生物性評估－第4部：與血液交互作用試驗選擇"],
  ["ASTM_F640", "醫療用不透射線性測試"],
  ["FDA_2024", "血管內導管510k指引"],
  ["MDR_2017-745", "歐盟醫療器材法規"],
]);

const DEFAULT_YEARS = new Map([
  ["ISO_7886-2", "2020"],
  ["ISO_7886-4", "2018"],
  ["ISO_8536-14", "2016"],
]);

const CLIENT_BOOTSTRAP = String.raw`
;(() => {
  const CLEANUP_KEY = "fieldlog_cleanup_v37";
  let running = false;
  let activeFolderId = null;
  const originalOpenFolder = window.openFolder;

  if (typeof originalOpenFolder === "function") {
    window.openFolder = function fieldlogV37OpenFolder(id) {
      activeFolderId = Number(id);
      return originalOpenFolder(id);
    };
  }

  function toast(message) {
    if (typeof window.showToast === "function") window.showToast(message);
    else console.info(message);
  }

  async function runCleanup(force) {
    if (running || (!force && localStorage.getItem(CLEANUP_KEY) === "done")) return;
    const pin = localStorage.getItem("fieldlog_pin") || "";
    if (!pin) return;
    running = true;
    const button = document.getElementById("btn-cleanup-v37");
    if (button) {
      button.disabled = true;
      button.textContent = "整理中…";
    }
    try {
      const response = await fetch("/api/attachments/rename-existing", {
        method: "POST",
        headers: { "content-type": "application/json", "x-pin": pin },
        body: "{}",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || ("HTTP " + response.status));
      if (result.version !== "fieldlog-v37" || !result.cleanup_executed) {
        throw new Error("正式 Worker 尚未切換至 Fieldlog v37");
      }
      localStorage.setItem(CLEANUP_KEY, "done");
      localStorage.setItem("fieldlog_legacy_rename_v34", "done");
      toast(
        "檔名整理完成：新增／更新中文標題 " + Number(result.renamed || 0) +
        " 個，移除重複檔 " + Number(result.duplicates_removed || 0) + " 個"
      );
      if (activeFolderId && typeof originalOpenFolder === "function") {
        await originalOpenFolder(activeFolderId);
      }
    } catch (error) {
      if (force) toast("整理失敗：" + error.message);
      else console.error("Fieldlog v37 自動整理失敗", error);
    } finally {
      running = false;
      if (button) {
        button.disabled = false;
        button.textContent = "🏷 整理檔名";
      }
    }
  }

  function addCleanupButton() {
    if (document.getElementById("btn-cleanup-v37")) return;
    const actions = document.querySelector(".folder-actions");
    if (!actions) return;
    const button = document.createElement("button");
    button.id = "btn-cleanup-v37";
    button.type = "button";
    button.className = "btn small";
    button.textContent = "🏷 整理檔名";
    button.title = "統一為標準組織_編號_年份_中文標題，並移除相同 PDF";
    button.addEventListener("click", () => runCleanup(true));
    const exportButton = document.getElementById("btn-folder-export");
    actions.insertBefore(button, exportButton || null);
  }

  addCleanupButton();
  document.getElementById("btn-login")?.addEventListener("click", () => {
    setTimeout(() => runCleanup(false), 1000);
  });
  setTimeout(() => runCleanup(false), 800);
})();
`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cleanPart(value, max = 96) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|#]+/g, " ")
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function standardIdentity(att) {
  // OCR 內通常有完整年份，優先於可能只含編號的原始檔名。
  const source = `${att.ocr_text || ""}\n${att.original_filename || ""}\n${att.filename || ""}`;
  let match = source.match(/\b(EN[\s_-]+ISO|ISO(?:[\s_-]*\/[\s_-]*(?:TS|TR))?|IEC|ASTM|JIS)[\s_:\-]*([A-Z]?\d{3,6}(?:-\d{1,3})?)(?:[\s_:\-]*((?:19|20)\d{2}))?/i);
  if (match) {
    const org = match[1].toUpperCase().replace(/[\s_-]+ISO$/, "_ISO").replace(/[\s_-]*\/[\s_-]*/g, "_").replace(/\s+/g, "_");
    const number = match[2].toUpperCase();
    const year = match[3] || DEFAULT_YEARS.get(`${org}_${number}`) || "";
    return { org, number, year };
  }
  match = source.match(/\bFDA\b[\s_-]*((?:19|20)\d{2})/i);
  if (match) return { org: "FDA", number: "", year: match[1] };
  match = source.match(/\bMDR\b[\s_-]*(2017[-_/]745)/i);
  if (match) return { org: "MDR", number: "2017-745", year: "" };
  return null;
}

function existingChineseTitle(att) {
  const stem = cleanPart(att.filename || "");
  const parts = stem.split("_");
  const index = parts.findIndex((part) => /[\u3400-\u9fff]/.test(part));
  return index >= 0 ? cleanPart(parts.slice(index).join("_"), 120) : "";
}

function canonicalBase(att) {
  const id = standardIdentity(att);
  return id ? [id.org, id.number, id.year].filter(Boolean).join("_") : "";
}

function canonicalFilename(att) {
  const base = canonicalBase(att);
  if (!base) return att.filename;
  const title = STANDARD_TITLES.get(base) || existingChineseTitle(att) || "標準文件";
  return `${base}_${cleanPart(title, 120)}.pdf`;
}

function normalizePdfText(text) {
  const stripped = stripPdfMetadata(String(text || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*(page|頁)\s*\d+\s*(of|\/)?\s*\d*\s*$/gim, "")
    .replace(/(?:©|copyright).*$/gim, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
  return stripped.length >= 500 ? stripped : "";
}

function equivalentPdfText(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const ratio = shorter.length / longer.length;
  if (ratio < 0.9) return false;
  if (ratio >= 0.97 && longer.includes(shorter)) return true;
  const sampleLength = 64;
  const samples = Math.min(60, Math.max(12, Math.floor(shorter.length / 1200)));
  let matched = 0;
  for (let i = 0; i < samples; i++) {
    const start = Math.floor((shorter.length - sampleLength) * i / Math.max(1, samples - 1));
    if (longer.includes(shorter.slice(start, start + sampleLength))) matched++;
  }
  return matched / samples >= 0.92;
}

async function sha256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadPdfText(env, db, att) {
  let text = String(att.ocr_text || "");
  if (normalizePdfText(text)) return text;
  if (!env.FILES || !env.AI) return text;
  const obj = await env.FILES.get(att.key);
  if (!obj) return text;
  const converted = await env.AI.toMarkdown([
    { name: att.filename, blob: new Blob([await obj.arrayBuffer()], { type: "application/pdf" }) },
  ]).catch(() => null);
  text = stripPdfMetadata(converted?.[0]?.data || "").slice(0, 60000);
  if (text) {
    await db.prepare("UPDATE attachments SET ocr_text = ?, ocr_at = COALESCE(NULLIF(ocr_at, ''), ?) WHERE id = ?")
      .bind(text, new Date().toISOString(), att.id).run();
  }
  return text;
}

async function deleteAttachment(env, db, att) {
  const { results: pages } = await db.prepare("SELECT id, key FROM attachments WHERE source_pdf_id = ?").bind(att.id).all();
  if (env.FILES) {
    for (const page of pages || []) await env.FILES.delete(page.key).catch(() => {});
    await env.FILES.delete(att.key).catch(() => {});
  }
  await db.prepare("DELETE FROM attachments WHERE source_pdf_id = ?").bind(att.id).run();
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(att.id).run();
  await db.prepare(
    "INSERT INTO history (entry_id, folder_id, action, detail, created_at) VALUES (?, NULL, '移除重複附件', ?, ?)"
  ).bind(att.entry_id, `${att.filename}（保留相同文件的較早版本）`, new Date().toISOString()).run();
}

async function enhancedCleanup(env) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT a.*, e.folder_id FROM attachments a
     JOIN entries e ON e.id = a.entry_id
     WHERE a.source_pdf_id IS NULL
     ORDER BY a.id`
  ).all();

  let renamed = 0;
  for (const att of results || []) {
    const next = canonicalFilename(att);
    if (next && next !== att.filename && /\.pdf$/i.test(next)) {
      await db.prepare(
        "UPDATE attachments SET original_filename = CASE WHEN COALESCE(original_filename, '') = '' THEN filename ELSE original_filename END, filename = ? WHERE id = ?"
      ).bind(next, att.id).run();
      att.filename = next;
      renamed++;
    }
  }

  const groups = new Map();
  for (const att of results || []) {
    if (!/\.pdf$/i.test(att.filename || "") && att.mime !== "application/pdf") continue;
    const base = canonicalBase(att);
    if (!base) continue;
    const key = `${att.folder_id ?? "inbox"}\n${base.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(att);
  }

  let pdfCompared = 0;
  let duplicatesRemoved = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keptHashes = new Map();
    const keptTexts = [];
    for (const att of group.sort((a, b) => a.id - b.id)) {
      let binaryHash = String(att.content_hash || "");
      if (!binaryHash && env.FILES) {
        const obj = await env.FILES.get(att.key);
        if (obj) {
          binaryHash = await sha256(await obj.arrayBuffer());
          await db.prepare("UPDATE attachments SET content_hash = ? WHERE id = ?").bind(binaryHash, att.id).run();
        }
      }
      if (binaryHash && keptHashes.has(binaryHash)) {
        await deleteAttachment(env, db, att);
        duplicatesRemoved++;
        continue;
      }
      if (binaryHash) keptHashes.set(binaryHash, att.id);

      const text = normalizePdfText(await loadPdfText(env, db, att));
      if (!text) continue;
      pdfCompared++;
      if (keptTexts.some((kept) => equivalentPdfText(kept, text))) {
        await deleteAttachment(env, db, att);
        duplicatesRemoved++;
        continue;
      }
      keptTexts.push(text);
    }
  }

  return { renamed, pdf_compared: pdfCompared, duplicates_removed: duplicatesRemoved };
}

async function serveAppWithV37(request, env, ctx) {
  const response = await legacyWorker.fetch(request, env, ctx);
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/javascript; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(`${await response.text()}\n${CLIENT_BOOTSTRAP}`, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/app.js") {
      return serveAppWithV37(request, env, ctx);
    }
    if (url.pathname !== "/api/attachments/rename-existing" || request.method !== "POST") {
      return legacyWorker.fetch(request, env, ctx);
    }

    const legacyResponse = await legacyWorker.fetch(request.clone(), env, ctx);
    if (!legacyResponse.ok) return legacyResponse;
    const legacy = await legacyResponse.json().catch(() => ({}));
    try {
      const enhanced = await enhancedCleanup(env);
      return json({
        ok: true,
        version: "fieldlog-v37",
        cleanup_executed: true,
        checked: legacy.checked || 0,
        renamed: Number(legacy.renamed || 0) + enhanced.renamed,
        pdf_compared: enhanced.pdf_compared,
        duplicates_removed: Number(legacy.duplicates_removed || 0) + enhanced.duplicates_removed,
      });
    } catch (err) {
      return json({ error: `既有附件增強清理失敗：${err.message}` }, 500);
    }
  },
};
