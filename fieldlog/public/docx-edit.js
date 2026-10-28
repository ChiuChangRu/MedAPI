// Word（.docx）簡易文字編輯（v224）：只改段落文字，不轉成網頁再轉回 Word。
// 直接改 word/document.xml 裡被修改的段落，其他段落、表格、編號、頁首頁尾、
// 圖片一律原封不動，格式才不會跑掉。
//
// 規則：
// - 段落內只有一般文字、Tab、換行時才可編輯；含圖片、欄位、超連結、註腳等
//   特殊物件的段落只顯示、不能改（改了可能把物件弄壞）。
// - 文件有追蹤修訂時整份不能編輯，要先在 Word 接受或拒絕修訂。
// - 改過的段落會合併成一個文字片段，沿用該段第一個文字片段的格式；
//   同一段有混合格式（例如只有部分字加粗）時，改了會統一成第一個片段的格式，UI 會先提醒。
// - 編輯框裡的換行寫回 Word 的段內換行（Shift＋Enter），Tab 寫回 Tab。
import { loadJsZip } from "./docx-preview.js?v=224";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const PARA_CHILDREN_OK = new Set(["pPr", "r", "proofErr", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "permStart", "permEnd"]);
const RUN_CHILDREN_OK = new Set(["rPr", "t", "tab", "br", "cr", "lastRenderedPageBreak"]);
const TRACKED = ["ins", "del", "moveFrom", "moveTo"];

function wChildren(node) {
  return Array.from(node.childNodes).filter((child) => child.nodeType === 1);
}

function hasAncestor(node, localName) {
  for (let cur = node.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) {
    if (cur.namespaceURI === W_NS && cur.localName === localName) return true;
  }
  return false;
}

function runText(run) {
  let text = "";
  for (const child of wChildren(run)) {
    if (child.localName === "t") text += child.textContent;
    else if (child.localName === "tab") text += "\t";
    else if (child.localName === "br" || child.localName === "cr") text += "\n";
  }
  return text;
}

function lockReason(paragraph) {
  for (const child of wChildren(paragraph)) {
    if (child.namespaceURI !== W_NS || !PARA_CHILDREN_OK.has(child.localName)) return "含超連結、欄位或特殊物件";
    if (child.localName !== "r") continue;
    for (const part of wChildren(child)) {
      if (part.namespaceURI !== W_NS || !RUN_CHILDREN_OK.has(part.localName)) return "含圖片、欄位、註腳或特殊符號";
      if (part.localName === "br" && (part.getAttributeNS(W_NS, "type") || "textWrapping") !== "textWrapping") return "含分頁或分欄符號";
    }
  }
  return "";
}

/**
 * 解析 document.xml，回傳要顯示的段落（略過空白段落）。
 * 每段：index（在全部段落中的序號，寫回時用）、text、editable、reason、inTable、mixed。
 */
export function analyzeDocumentXml(doc, serializer) {
  const tracked = TRACKED.some((name) => doc.getElementsByTagNameNS(W_NS, name).length > 0);
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W_NS, "p"));
  const items = [];
  paragraphs.forEach((p, index) => {
    if (hasAncestor(p, "txbxContent")) return;
    const runs = wChildren(p).filter((child) => child.namespaceURI === W_NS && child.localName === "r");
    const reason = lockReason(p);
    // 鎖住的段落只顯示；超連結等巢狀文字也要看得到，所以改抓所有 w:t
    const text = reason
      ? Array.from(p.getElementsByTagNameNS(W_NS, "t")).map((t) => t.textContent).join("")
      : runs.map(runText).join("");
    if (!text.trim()) return;
    const formats = new Set(runs.filter((run) => runText(run)).map((run) => {
      const rPr = wChildren(run).find((child) => child.localName === "rPr");
      return rPr ? serializer.serializeToString(rPr) : "";
    }));
    items.push({
      index,
      text,
      editable: !tracked && !reason,
      reason: tracked ? "文件有追蹤修訂" : reason,
      inTable: hasAncestor(p, "tc"),
      mixed: formats.size > 1,
    });
  });
  return { tracked, items };
}

function appendText(doc, run, text) {
  for (const piece of String(text).replace(/\r\n?/g, "\n").split(/(\n|\t)/)) {
    if (piece === "") continue;
    if (piece === "\n") run.appendChild(doc.createElementNS(W_NS, "w:br"));
    else if (piece === "\t") run.appendChild(doc.createElementNS(W_NS, "w:tab"));
    else {
      const t = doc.createElementNS(W_NS, "w:t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = piece;
      run.appendChild(t);
    }
  }
}

/**
 * 把修改寫回 XML DOM。edits：Map(段落 index → 新文字)。只動被修改的段落：
 * 移除原本的文字片段（w:r、w:proofErr），在第一個片段的位置放一個沿用其格式的新片段。
 * 書籤、段落格式（pPr：樣式、編號、縮排、間距）保留。
 */
export function applyParagraphEdits(doc, edits) {
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W_NS, "p"));
  let changed = 0;
  for (const [index, text] of edits) {
    const p = paragraphs[index];
    if (!p || lockReason(p)) continue;
    const runs = wChildren(p).filter((child) => child.namespaceURI === W_NS && child.localName === "r");
    const first = runs.find((run) => runText(run)) || runs[0] || null;
    const run = doc.createElementNS(W_NS, "w:r");
    const rPr = first && wChildren(first).find((child) => child.localName === "rPr");
    if (rPr) run.appendChild(rPr.cloneNode(true));
    appendText(doc, run, text);
    p.insertBefore(run, first || null);
    for (const child of wChildren(p)) {
      if (child !== run && child.namespaceURI === W_NS && (child.localName === "r" || child.localName === "proofErr")) p.removeChild(child);
    }
    changed++;
  }
  return changed;
}

/** XMLSerializer 不輸出 XML 宣告；Word 的 document.xml 原本有，照原樣補回 */
export function serializeDocumentXml(doc, serializer, originalXml) {
  const body = serializer.serializeToString(doc);
  const decl = String(originalXml).match(/^\s*<\?xml[^>]*\?>/);
  return decl && !/^\s*<\?xml/.test(body) ? `${decl[0].trim()}\r\n${body}` : body;
}

// ---------- 右欄「文字內容」分頁的編輯畫面（用 app.js／inspector.js 的全域函式） ----------
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function autoRows(text) {
  return Math.min(12, Math.max(1, String(text).split("\n").length + Math.floor(String(text).length / 60)));
}

async function uploadDocx(attachment, bytes) {
  const response = await fetch(`/api/attachments/${attachment.id}/content`, {
    method: "PUT",
    headers: { "x-pin": pin(), "content-type": DOCX_MIME, "x-filename": encodeURIComponent(attachment.filename) },
    body: bytes,
  });
  if (response.status === 401) { showLogin(); throw new Error("PIN 錯誤"); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function renderVersions(attachment, onRestored) {
  const wrap = $("docx-edit-versions");
  if (!wrap) return;
  let versions = [];
  try { versions = (await api(`/attachments/${attachment.id}/versions`)).versions || []; } catch { wrap.innerHTML = ""; return; }
  wrap.innerHTML = versions.length
    ? `<details><summary>舊版本（${versions.length}）</summary><ul>${versions.map((v) => `<li><span>${esc(localDateTimeShort(v.created_at))}｜${esc(fmtBytes(Number(v.size) || 0))}</span><button type="button" class="btn small" data-restore="${v.id}">還原這一版</button></li>`).join("")}</ul></details>`
    : `<p class="sub">尚無舊版本；第一次儲存後，原本的檔案會保留在這裡。</p>`;
  wrap.querySelectorAll("[data-restore]").forEach((button) => button.onclick = async () => {
    if (!confirm("還原後，目前的版本會存成一個舊版本，可以再還原回來。要還原嗎？")) return;
    button.disabled = true;
    try {
      const result = await api(`/attachments/${attachment.id}/versions/${button.dataset.restore}/restore`, { method: "POST", body: "{}" });
      attachment.key = result.key || attachment.key;
      showToast("已還原");
      await onRestored();
    } catch (error) { button.disabled = false; showToast("還原失敗：" + error.message); }
  });
}

export async function renderDocxEditor(attachment) {
  const body = $("folder-preview-body");
  body.innerHTML = `<p class="folder-preview-empty">正在讀取 Word 文字…</p>`;
  const JSZip = await loadJsZip();
  const response = await fetch(fileUrlForKey(attachment.key), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Word 讀取失敗（HTTP ${response.status}）`);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("讀不到 Word 內容，檔案可能損毀或不是 .docx");
  const originalXml = await entry.async("string");
  const doc = new DOMParser().parseFromString(originalXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Word 內容格式無法解析");
  const serializer = new XMLSerializer();
  const { tracked, items } = analyzeDocumentXml(doc, serializer);
  const editableCount = items.filter((item) => item.editable).length;
  body.innerHTML = `<div class="docx-edit">
    <div class="docx-edit-help">
      <strong>Word 文字編輯</strong>
      <p>只改文字；編輯框內的換行會存成 Word 的段內換行（Shift＋Enter）。只有改過的段落會被替換，其他內容與格式不變。按右上角「儲存」或停止輸入後自動儲存，舊版會保留。</p>
      ${tracked ? '<p class="docx-edit-warn">這份文件有追蹤修訂，為避免弄亂修訂紀錄，請先在 Word 接受或拒絕所有修訂後再上傳編輯。</p>' : ""}
      <p class="sub">可編輯 ${editableCount} 段／共 ${items.length} 段（空白段落不列出）。</p>
      <div id="docx-edit-versions"></div>
    </div>
    ${items.map((item, n) => `<div class="docx-edit-para${item.editable ? "" : " locked"}">
      <small>第 ${n + 1} 段${item.inTable ? "｜表格" : ""}${item.mixed && item.editable ? '｜<b class="docx-edit-mixed" title="這段有不同格式的文字，修改後整段會統一成第一個字的格式">混合格式</b>' : ""}${item.editable ? "" : `｜不能編輯：${esc(item.reason)}`}</small>
      ${item.editable
        ? `<textarea data-docx-para="${item.index}" rows="${autoRows(item.text)}" spellcheck="false">${esc(item.text)}</textarea>`
        : `<p>${esc(item.text)}</p>`}
    </div>`).join("")}
  </div>`;
  body.querySelectorAll("[data-docx-para]").forEach((area) => { area.dataset.original = area.value; });
  const snapshot = () => JSON.stringify([...body.querySelectorAll("[data-docx-para]")].map((area) => [area.dataset.docxPara, area.value]));
  const persist = async () => {
    const changedAreas = [...body.querySelectorAll("[data-docx-para]")].filter((area) => area.value !== area.dataset.original);
    if (!changedAreas.length) return;
    applyParagraphEdits(doc, new Map(changedAreas.map((area) => [Number(area.dataset.docxPara), area.value])));
    // createFolders: false——不要多寫一個「word/」資料夾項目，讓壓縮檔內容清單與原檔一致
    zip.file("word/document.xml", serializeDocumentXml(doc, serializer, originalXml), { createFolders: false });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: DOCX_MIME });
    const result = await uploadDocx(attachment, bytes);
    attachment.key = result.key || attachment.key;
    attachment.size = result.size || bytes.byteLength;
    changedAreas.forEach((area) => { area.dataset.original = area.value; });
    document.querySelectorAll(`.folder-file-row[data-att-id="${attachment.id}"]`).forEach((row) => { row.dataset.key = attachment.key; });
    await renderVersions(attachment, () => renderDocxEditor(attachment));
  };
  await renderVersions(attachment, () => renderDocxEditor(attachment));
  if (editableCount) inspectorTrack(snapshot, persist);
}
