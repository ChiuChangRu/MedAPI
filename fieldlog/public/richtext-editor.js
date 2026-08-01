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

  /** 建立編輯器；container 是空的 <div>，initialHtml 是已經補好顯示用 pin 的 HTML。 */
  function init(container, initialHtml) {
    if (!container || !window.Quill) return null;
    const quill = new window.Quill(container, { theme: "snow", modules: { toolbar: TOOLBAR } });
    if (initialHtml) quill.clipboard.dangerouslyPasteHTML(initialHtml);
    container.__fieldlogQuill = quill;
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
