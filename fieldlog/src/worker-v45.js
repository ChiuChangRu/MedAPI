import previousWorker from "./worker-v43.js";

const TOOLBAR_BUTTON = '<button class="btn small" id="btn-folder-entry">✏️ 新紀錄</button>';
const TOOLBAR_WITH_UPLOAD = `${TOOLBAR_BUTTON}
        <button class="btn small upload-btn" id="btn-folder-upload-file" type="button">＋ 上傳檔案</button>
        <input id="folder-upload-file-input" type="file" multiple hidden />`;

const FILE_UPLOAD_UI = [
  ';(() => {',
  '  if (window.__fieldlogFileUploadV45) return;',
  '  window.__fieldlogFileUploadV45 = true;',
  '',
  '  const DEFAULT_LABEL = "＋ 上傳檔案";',
  '',
  '  function bindFileUpload() {',
  '    const button = document.getElementById("btn-folder-upload-file");',
  '    const input = document.getElementById("folder-upload-file-input");',
  '    if (!button || !input || button.dataset.bound === "1") return;',
  '    button.dataset.bound = "1";',
  '',
  '    button.onclick = () => {',
  '      if (!CURRENT_FOLDER) {',
  '        showToast("請先進入要存放檔案的資料夾");',
  '        return;',
  '      }',
  '      input.click();',
  '    };',
  '',
  '    input.onchange = async () => {',
  '      const files = Array.from(input.files || []);',
  '      input.value = "";',
  '      if (!files.length || !CURRENT_FOLDER) return;',
  '',
  '      const folderId = Number(CURRENT_FOLDER.id);',
  '      button.disabled = true;',
  '      let uploadedCount = 0;',
  '      let duplicateCount = 0;',
  '      let failedCount = 0;',
  '',
  '      try {',
  '        for (let index = 0; index < files.length; index++) {',
  '          const file = files[index];',
  '          button.textContent = "上傳中 " + (index + 1) + "/" + files.length;',
  '',
  '          if (file.size > 50 * 1024 * 1024) {',
  '            failedCount++;',
  '            showToast(file.name + " 超過 50MB，已略過");',
  '            continue;',
  '          }',
  '',
  '          let entryId = 0;',
  '          try {',
  '            const rawName = String(file.name || "上傳檔案");',
  '            const dotIndex = rawName.lastIndexOf(".");',
  '            const title = dotIndex > 0 ? rawName.slice(0, dotIndex) : rawName;',
  '            entryId = Number(await createEntry(folderId, title));',
  '            const result = await putFile(entryId, file, file.name, null);',
  '            if (result && result.duplicate) {',
  '              duplicateCount++;',
  '              await api("/entries/" + entryId, { method: "DELETE" }).catch(() => {});',
  '            } else {',
  '              uploadedCount++;',
  '            }',
  '          } catch (error) {',
  '            failedCount++;',
  '            if (entryId) await api("/entries/" + entryId, { method: "DELETE" }).catch(() => {});',
  '            console.error("檔案上傳失敗 [" + file.name + "]", error);',
  '          }',
  '        }',
  '',
  '        const parts = ["已加入 " + uploadedCount + " 個檔案"];',
  '        if (duplicateCount) parts.push("略過 " + duplicateCount + " 個重複檔");',
  '        if (failedCount) parts.push(failedCount + " 個失敗");',
  '        showToast(parts.join("，"));',
  '',
  '        if (CURRENT_FOLDER && Number(CURRENT_FOLDER.id) === folderId) {',
  '          await openFolder(folderId);',
  '        }',
  '      } finally {',
  '        button.disabled = false;',
  '        button.textContent = DEFAULT_LABEL;',
  '      }',
  '    };',
  '  }',
  '',
  '  if (document.readyState === "loading") {',
  '    document.addEventListener("DOMContentLoaded", bindFileUpload, { once: true });',
  '  } else {',
  '    bindFileUpload();',
  '  }',
  '  new MutationObserver(bindFileUpload).observe(document.documentElement, { childList: true, subtree: true });',
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
        .replace(TOOLBAR_BUTTON, TOOLBAR_WITH_UPLOAD)
        .replace(/app\.js\?v=\d+/g, "app.js?v=45")
        .replace(/style\.css\?v=\d+/g, "style.css?v=45");
      return noStoreResponse(html, response, "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const response = await previousWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      return noStoreResponse(`${await response.text()}\n${FILE_UPLOAD_UI}`, response, "application/javascript; charset=utf-8");
    }

    return previousWorker.fetch(request, env, ctx);
  },
};
