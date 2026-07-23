;(() => {
  if (window.__fieldlogPdfFolderButtonV40) return;
  window.__fieldlogPdfFolderButtonV40 = true;

  const originalFolderFileHtml = typeof folderFileHtml === "function" ? folderFileHtml : null;
  if (originalFolderFileHtml) {
    folderFileHtml = function fieldlogV40FolderFileHtml(attachment, entryId) {
      let html = originalFolderFileHtml(attachment, entryId);
      const isPdf = (attachment.mime || "") === "application/pdf" || /\.pdf$/i.test(attachment.filename || "");
      if (isPdf) {
        html = html.replace(
          `<button class="folder-file-manage" type="button" data-entry-id="${entryId}">詳情</button>`,
          `<button class="folder-file-doodle" type="button" data-entry-id="${entryId}" data-att-id="${attachment.id}">✍️ 塗鴉</button><button class="folder-file-manage" type="button" data-entry-id="${entryId}">詳情</button>`
        );
      }
      return html;
    };
  }

  function bindFolderDoodleButtons() {
    document.querySelectorAll(".folder-file-doodle").forEach((button) => {
      button.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = "開啟中…";
        try {
          await openEntry(Number(button.dataset.entryId));
          const detailButton = document.querySelector(`.att-pdf-doodle[data-id="${button.dataset.attId}"]`);
          if (!detailButton) throw new Error("PDF 塗鴉功能尚未載入，請重新整理後再試");
          detailButton.click();
        } catch (error) {
          if (typeof showToast === "function") showToast("開啟 PDF 塗鴉失敗：" + error.message);
        } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      };
    });
  }

  const originalOpenFolder = typeof openFolder === "function" ? openFolder : null;
  if (originalOpenFolder) {
    openFolder = async function fieldlogV40OpenFolder(id) {
      const result = await originalOpenFolder(id);
      bindFolderDoodleButtons();
      return result;
    };
  }
  bindFolderDoodleButtons();
})();
