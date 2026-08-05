/**
 * 記事富文字內文（entries.body_format = 'html'）編輯框——封裝 Quill，
 * app.js 只呼叫這支模組暴露的函式，不用自己管 Quill 細節。
 * 比照 pdf-editor.js 的做法：獨立檔案、IIFE、掛一個全域物件。
 */
;(() => {
  if (window.fieldlogRichEditor) return;

  const TOOLBAR = [
    ["bold", "italic", "underline", "strike"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["blockquote", "link"],
    ["clean"],
  ];

  /**
   * 建立編輯器；container 是空的 <div>，initialHtml 是已經補好顯示用 pin 的 HTML。
   * opts.onImagePaste(file)：貼上剪貼簿圖片時呼叫（例如螢幕截圖後直接 Ctrl+V）。
   * 一定要攔截掉，不然 Quill 預設會把圖片轉成 base64 直接塞進 body，存進資料庫
   * 又大又沒有對應的 attachments 列（縮圖、刪除、OCR 都吃不到這種圖）。
   */
  function init(container, initialHtml, opts = {}) {
    if (!container || !window.Quill) return null;
    const quill = new window.Quill(container, { theme: "snow", modules: { toolbar: TOOLBAR } });
    // 貼上從別處複製來的內容（例如從附件清單複製了縮圖＋擷取文字那一整段）時，
    // Quill 預設會原樣保留裡面的 <img>——那張圖不是透過這篇記事的附件流程建立
    // 的，src 通常連不到（或連到別筆記事的檔案，甚至帶著舊 PIN），畫面上會變
    // 一個破圖示。只有 insertImage() 自己插入、帶 data-att-id 的圖片才留下；
    // 其餘來源的 <img> 一律拿掉，文字內容不受影響。這個轉換規則同時套用在
    // 貼上事件跟下面載入既有內容的 dangerouslyPasteHTML，所以已存的合法圖片
    // 不會被誤刪。
    const Delta = window.Quill.import("delta");
    quill.clipboard.addMatcher("img", (node, delta) => {
      return node.hasAttribute && node.hasAttribute("data-att-id") ? delta : new Delta();
    });
    if (initialHtml) quill.clipboard.dangerouslyPasteHTML(initialHtml);
    container.__fieldlogQuill = quill;
    if (typeof opts.onImagePaste === "function") {
      quill.root.addEventListener("paste", (ev) => {
        const items = Array.from(ev.clipboardData?.items || []);
        const imageItem = items.find((it) => it.kind === "file" && (it.type || "").startsWith("image/"));
        if (!imageItem) return; // 不是圖片（純文字／一般貼上）：交給 Quill 預設行為處理
        ev.preventDefault();
        const file = imageItem.getAsFile();
        if (file) opts.onImagePaste(file);
      });
    }
    return quill;
  }

  /** 目前編輯框的內容（HTML，含畫面用的 pin，存檔前呼叫端要自己剝掉）。 */
  function getHtml(container) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return "";
    // Quill 完全清空時 root 是 <p><br></p>，視為空字串；只要有文字或圖片就算有內容
    const hasContent = quill.getText().trim().length > 0 || !!quill.root.querySelector("img");
    return hasContent ? quill.root.innerHTML : "";
  }

  /** 在目前游標位置插入一張圖片，並把 attachment id 記在 data-att-id 屬性上。 */
  function insertImage(container, url, attId) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return;
    const range = quill.getSelection(true) || { index: quill.getLength() };
    quill.insertEmbed(range.index, "image", url, "user");
    quill.setSelection(range.index + 1, 0, "user");
    const [leaf] = quill.getLeaf(range.index);
    if (leaf && leaf.domNode) leaf.domNode.setAttribute("data-att-id", String(attId));
  }

  window.fieldlogRichEditor = { init, getHtml, insertImage };
})();
