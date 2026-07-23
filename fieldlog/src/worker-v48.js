import previousWorker from "./worker-v47.js";

const MANAGE_WITHOUT_ATTACHMENT = 'class="folder-file-manage" type="button" data-entry-id="${entryId}"';
const MANAGE_WITH_ATTACHMENT = 'class="folder-file-manage" type="button" data-entry-id="${entryId}" data-att-id="${a.id}"';

const SCOPED_FILE_UI = [
  ';(() => {',
  '  if (window.__fieldlogScopedFileV48) return;',
  '  window.__fieldlogScopedFileV48 = true;',
  '',
  '  let focusedEntryId = 0;',
  '  let focusedAttachmentId = 0;',
  '  const originalOpenEntryV48 = openEntry;',
  '  const originalCloseEntryV48 = closeEntry;',
  '  const originalOpenFolderV48 = openFolder;',
  '',
  '  function clearFocusedFile() {',
  '    focusedEntryId = 0;',
  '    focusedAttachmentId = 0;',
  '  }',
  '',
  '  function selectedFilename(item) {',
  '    return item.querySelector("a[href*=\"/api/file/\"]")?.textContent?.trim() || "檔案";',
  '  }',
  '',
  '  function renderFocusedFile() {',
  '    if (!focusedEntryId || !focusedAttachmentId) return;',
  '    const modal = document.getElementById("entry-modal");',
  '    if (!modal) return;',
  '    const item = modal.querySelector(".att-item[data-id=\"" + focusedAttachmentId + "\"]");',
  '    if (!item) {',
  '      showToast("這個檔案已不存在");',
  '      originalCloseEntryV48();',
  '      if (CURRENT_FOLDER) originalOpenFolderV48(CURRENT_FOLDER.id);',
  '      clearFocusedFile();',
  '      return;',
  '    }',
  '',
  '    const filename = selectedFilename(item);',
  '    const focusedItem = item.cloneNode(true);',
  '    modal.innerHTML = [',
  '      "<div class=\"modal-close-float\"><button class=\"btn small ghost\" id=\"e-close\" type=\"button\" aria-label=\"關閉檔案\" title=\"關閉檔案\">✕</button></div>",',
  '      "<div class=\"detail-head\"><h2 style=\"margin:0;overflow-wrap:anywhere\">" + esc(filename) + "</h2></div>",',
  '      "<p class=\"sub\">只顯示目前選取的檔案；同一筆舊記事中的其他附件不會顯示或變更。</p>",',
  '      "<div class=\"upload-row\"><button class=\"btn small\" id=\"v48-normalize-name\" type=\"button\">🏷 整理中文檔名</button><span id=\"e-upload-status\" class=\"sub\"></span></div>",',
  '      "<div id=\"e-attachments\" class=\"att-list\"></div>"',
  '    ].join("");',
  '    document.getElementById("e-attachments").appendChild(focusedItem);',
  '    document.getElementById("e-close").onclick = closeEntry;',
  '    bindAttActions(focusedEntryId);',
  '',
  '    const normalizeButton = document.getElementById("v48-normalize-name");',
  '    normalizeButton.onclick = async () => {',
  '      normalizeButton.disabled = true;',
  '      normalizeButton.textContent = "整理中…";',
  '      try {',
  '        const result = await api("/attachments/" + focusedAttachmentId + "/normalize-name", { method: "POST", body: "{}" });',
  '        showToast(result.renamed ? "已更新中文檔名" : (result.incomplete_year ? "尚未辨識到年份，請先擷取文字或深度處理" : "檔名已是目前可確認的格式"));',
  '        await openEntry(focusedEntryId, focusedAttachmentId);',
  '      } catch (error) {',
  '        showToast("整理檔名失敗：" + error.message);',
  '        normalizeButton.disabled = false;',
  '        normalizeButton.textContent = "🏷 整理中文檔名";',
  '      }',
  '    };',
  '  }',
  '',
  '  openEntry = async function scopedOpenEntryV48(id, attachmentId) {',
  '    const numericEntryId = Number(id || 0);',
  '    const numericAttachmentId = Number(attachmentId || 0);',
  '    if (numericAttachmentId) {',
  '      focusedEntryId = numericEntryId;',
  '      focusedAttachmentId = numericAttachmentId;',
  '    } else if (focusedEntryId !== numericEntryId) {',
  '      clearFocusedFile();',
  '    }',
  '    await originalOpenEntryV48(numericEntryId);',
  '    if (focusedEntryId === numericEntryId && focusedAttachmentId) renderFocusedFile();',
  '  };',
  '',
  '  closeEntry = function scopedCloseEntryV48() {',
  '    clearFocusedFile();',
  '    return originalCloseEntryV48();',
  '  };',
  '',
  '  function bindScopedManageButtons() {',
  '    document.querySelectorAll(".folder-file-manage").forEach((button) => {',
  '      const row = button.closest(".folder-file-row");',
  '      const attachmentId = Number(button.dataset.attId || row?.querySelector("[data-att-id]")?.dataset.attId || 0);',
  '      if (!attachmentId) return;',
  '      button.dataset.attId = String(attachmentId);',
  '      button.onclick = (event) => {',
  '        event.preventDefault();',
  '        event.stopPropagation();',
  '        openEntry(Number(button.dataset.entryId), attachmentId);',
  '      };',
  '    });',
  '  }',
  '',
  '  openFolder = async function scopedOpenFolderV48(id) {',
  '    const result = await originalOpenFolderV48(id);',
  '    bindScopedManageButtons();',
  '    return result;',
  '  };',
  '',
  '  bindScopedManageButtons();',
  '  new MutationObserver(bindScopedManageButtons).observe(document.documentElement, { childList: true, subtree: true });',
  '})();',
].join("\n");

function noStoreResponse(body, response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, max-age=0");
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const html = (await response.text())
        .replace(/app\.js\?v=\d+/g, "app.js?v=48")
        .replace(/style\.css\?v=\d+/g, "style.css?v=48");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      let source = await response.text();
      source = source.replace(MANAGE_WITHOUT_ATTACHMENT, MANAGE_WITH_ATTACHMENT);
      return noStoreResponse(`${source}\n${SCOPED_FILE_UI}`, response, "application/javascript; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
