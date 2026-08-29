/**
 * 記事富文字內文（entries.body_format = 'html'）編輯框——封裝 Quill，
 * app.js 只呼叫這支模組暴露的函式，不用自己管 Quill 細節。
 * 比照 pdf-editor.js 的做法：獨立檔案、IIFE、掛一個全域物件。
 */
;(() => {
  if (window.fieldlogRichEditor) return;

  // 蠟筆（螢光筆）用的顏色。值本身也是合法的 CSS 色名，工具列的色塊才畫得出來；
  // 實際存進 body 的是 class（見下面 registerFormats），不是行內 style。
  const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "orange", false];
  // 字體大小：false＝一般大小，其餘三檔是 Quill 內建的字級名稱
  const FONT_SIZES = ["small", false, "large", "huge"];

  const TOOLBAR = [
    [{ header: [1, 2, 3, false] }],
    [{ size: FONT_SIZES }],
    ["bold", "italic", "underline", "strike"],
    [{ background: HIGHLIGHT_COLORS }],
    [{ align: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    ["blockquote", "code-block", "link", "image"],
    ["clean"],
  ];

  // Quill 2 內建的「list autofill」會在行首輸入 `1.`、`-`、`*` 後按空白時，
  // 自動把一般文字轉成編號／項目清單。這對日期、試驗步驟與原始紀錄很容易
  // 誤判。用同名設定覆寫內建 binding，讓一般空白照常輸入；工具列上的兩種
  // 清單按鈕仍保留，只有使用者主動選擇時才套用清單格式。
  const KEYBOARD_BINDINGS = {
    "list autofill": {
      key: " ",
      collapsed: true,
      prefix: /(?!)/,
      handler() { return true; },
    },
  };

  /**
   * 蠟筆重點、字體大小、對齊方式都要存成 class（ql-bg-yellow／ql-size-large／
   * ql-align-center）而不是 Quill 預設的行內 style="…"。理由是後端
   * sanitizeEntryHtml 一律不收 style 屬性（style 能直接畫東西，開放它等於讓
   * 貼上的外部內容決定畫面），所以行內樣式一存檔就整個消失；class 版本有
   * 白名單（只收 ql-*）可以安全保留，重新開啟時設定還在。
   */
  let formatsReady = false;
  function registerFormats() {
    if (formatsReady || !window.Quill) return;
    const BackgroundClass = window.Quill.import("attributors/class/background");
    window.Quill.register(BackgroundClass, true);
    const SizeClass = window.Quill.import("attributors/class/size");
    SizeClass.whitelist = ["small", "large", "huge"];
    window.Quill.register(SizeClass, true);
    const AlignClass = window.Quill.import("attributors/class/align");
    window.Quill.register(AlignClass, true);

    // 圖片沿用 Quill 內建 image；錄音與一般檔案使用一個 block embed。
    // 內容只保存 R2 附件網址與 attachment id，不把檔案本體塞進 D1 的 body。
    const BlockEmbed = window.Quill.import("blots/block/embed");
    class FieldlogAttachmentBlot extends BlockEmbed {
      static create(value = {}) {
        const node = super.create();
        const kind = value.kind === "audio" ? "audio" : "file";
        const filename = String(value.filename || "附件");
        const url = String(value.url || "");
        node.setAttribute("contenteditable", "false");
        node.setAttribute("data-att-id", String(value.attId || ""));
        node.setAttribute("data-kind", kind);
        node.setAttribute("data-filename", filename);
        node.setAttribute("data-url", url);
        if (kind === "audio") {
          const label = document.createElement("strong");
          label.textContent = `🎙️ ${filename}`;
          const audio = document.createElement("audio");
          audio.setAttribute("controls", "controls");
          audio.setAttribute("preload", "metadata");
          audio.setAttribute("src", url);
          node.append(label, audio);
        } else {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = `📎 ${filename}`;
          node.appendChild(link);
        }
        return node;
      }

      static value(node) {
        return {
          attId: node.getAttribute("data-att-id") || "",
          kind: node.getAttribute("data-kind") || "file",
          filename: node.getAttribute("data-filename") || "附件",
          url: node.getAttribute("data-url") || "",
        };
      }
    }
    FieldlogAttachmentBlot.blotName = "fieldlogAttachment";
    FieldlogAttachmentBlot.tagName = "figure";
    FieldlogAttachmentBlot.className = "fieldlog-attachment-card";
    window.Quill.register(FieldlogAttachmentBlot, true);
    formatsReady = true;
  }

  // ---------- 貼上 Markdown ----------
  // 從別處複製一段 Markdown（AI 回覆、.md 檔內容）貼進來時，Quill 預設把它
  // 當一般文字：「## 標題」原樣變成一行普通句子、清單變成一行行「- xxx」。
  // 這裡在 Quill 之前接手，把 Markdown 先轉成 HTML 再交給 Quill，貼進來就是
  // 真的標題／清單／程式碼區塊，存檔後也是（後端白名單已含 h1–h6/pre/code）。

  /** 這段純文字看起來是不是 Markdown（有結構標記才算，避免一般文字被誤轉） */
  function looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;
    const lines = text.split(/\r?\n/);
    const structural = lines.some((line) =>
      /^\s{0,3}#{1,6}\s+\S/.test(line)          // # 標題
      || /^\s*([-*+])\s+\S/.test(line)          // - 項目
      || /^\s*\d+\.\s+\S/.test(line)            // 1. 項目
      || /^\s*>\s?\S/.test(line)                // > 引言
      || /^\s*```/.test(line)                   // ``` 程式碼
      || /^\s*\|.+\|\s*$/.test(line)            // | 表格 |
      || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) // --- 分隔線
    );
    if (structural) return true;
    return /\*\*[^*\n]+\*\*/.test(text) || /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(text);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // 行內語法。輸入已經 escapeHtml 過，所以這裡只是在安全字串上做替換，
  // 不可能因為使用者內容產生新的可執行標記。
  function inlineMd(line) {
    return line
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  /**
   * Markdown → HTML。刻意只輸出後端白名單裡有的標籤，貼進來看到什麼、存檔後
   * 就還是什麼。表格轉成 <pre>：Quill 沒有表格格式，硬轉 <table> 會在貼上時
   * 被拆成一行行散文字，反而比保留原本的對齊更難讀。
   */
  function mdToHtml(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const listStack = []; // { tag: "ul" | "ol", indent: number }
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    };
    const closeLists = (toIndent = -1) => {
      while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
        out.push(`</${listStack.pop().tag}>`);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];

      // ``` 圍起來的程式碼區塊：整段原樣保留到 </pre>
      if (/^\s*```/.test(raw)) {
        flushPara();
        closeLists();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
        continue;
      }

      // | 表格 |：連續的表格列整塊保留原始文字
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        flushPara();
        closeLists();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
        i--;
        out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
        continue;
      }

      if (!raw.trim()) { flushPara(); closeLists(); continue; }

      let m;
      if ((m = raw.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
        flushPara();
        closeLists();
        const level = m[1].length;
        out.push(`<h${level}>${inlineMd(escapeHtml(m[2].trim()))}</h${level}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
        flushPara();
        closeLists();
        out.push("<hr>");
        continue;
      }
      if ((m = raw.match(/^\s*>\s?(.*)$/))) {
        flushPara();
        closeLists();
        out.push(`<blockquote>${inlineMd(escapeHtml(m[1]))}</blockquote>`);
        continue;
      }
      if ((m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/))) {
        flushPara();
        const indent = m[1].replace(/\t/g, "  ").length;
        const tag = /^\d/.test(m[2]) ? "ol" : "ul";
        closeLists(indent);
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) {
          listStack.push({ tag, indent });
          out.push(`<${tag}>`);
        } else if (top.tag !== tag) {
          out.push(`</${listStack.pop().tag}>`);
          listStack.push({ tag, indent });
          out.push(`<${tag}>`);
        }
        out.push(`<li>${inlineMd(escapeHtml(m[3]))}</li>`);
        continue;
      }

      closeLists();
      para.push(inlineMd(escapeHtml(raw.trim())));
    }
    flushPara();
    closeLists();
    return out.join("");
  }

  /**
   * 建立編輯器；container 是空的 <div>，initialHtml 是已經補好顯示用 pin 的 HTML。
   * opts.onImagePaste(file)：貼上剪貼簿圖片時呼叫（例如螢幕截圖後直接 Ctrl+V）。
   * 一定要攔截掉，不然 Quill 預設會把圖片轉成 base64 直接塞進 body，存進資料庫
   * 又大又沒有對應的 attachments 列（縮圖、刪除、OCR 都吃不到這種圖）。
   */
  function init(container, initialHtml, opts = {}) {
    if (!container || !window.Quill) return null;
    registerFormats();
    const quill = new window.Quill(container, {
      theme: "snow",
      modules: {
        toolbar: TOOLBAR,
        keyboard: { bindings: KEYBOARD_BINDINGS },
      },
    });
    // Quill 內建的圖片按鈕會把本機圖片轉成 base64 直接塞入 HTML。這會讓 D1
    // 內容暴增，而且圖片沒有 attachment id，無法預覽、刪除或做 OCR。改成選圖後
    // 交給 app.js：先上傳 R2，再把有 data-att-id 的圖片插回目前游標位置。
    const toolbarModule = quill.getModule("toolbar");
    toolbarModule?.addHandler("image", () => {
      if (typeof opts.onImagePaste !== "function") return;
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "image/*";
      picker.multiple = true;
      picker.hidden = true;
      picker.addEventListener("change", () => {
        for (const file of Array.from(picker.files || [])) opts.onImagePaste(file);
        picker.remove();
      }, { once: true });
      document.body.appendChild(picker);
      picker.click();
    });
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
    // Markdown 要在 Quill 自己的貼上處理之前接手，所以用捕獲階段（第三個參數
    // true）掛在同一個節點上：捕獲階段的監聽一定早於 Quill 建構時掛上的冒泡
    // 監聽，preventDefault() 之後 Quill 的 onPaste 會自己跳過（它開頭就檢查
    // defaultPrevented）。順序反過來的話，畫面會先被 Quill 貼成一堆純文字。
    quill.root.addEventListener("paste", (ev) => {
      const data = ev.clipboardData;
      if (!data) return;
      // 剪貼簿裡有圖片檔時交給下面那個 handler，這裡不要插手
      if (Array.from(data.items || []).some((it) => it.kind === "file" && (it.type || "").startsWith("image/"))) return;
      const html = data.getData("text/html");
      // 從網頁／Word 複製來的內容本來就有 HTML 格式，交給 Quill 原本的流程；
      // 這裡只處理「來源只有純文字、但內容其實是 Markdown」的情況
      if (html && html.trim()) return;
      const text = data.getData("text/plain");
      if (!looksLikeMarkdown(text)) return;
      ev.preventDefault();
      const range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
      quill.deleteText(range.index, range.length, "user");
      quill.clipboard.dangerouslyPasteHTML(range.index, mdToHtml(text), "user");
    }, true);
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
    // 工具列按鈕預設只有英文 title（或沒有），中文標籤讓人看得懂哪顆是蠟筆
    const toolbar = container.previousElementSibling;
    if (toolbar && toolbar.classList.contains("ql-toolbar")) {
      const labels = {
        ".ql-header": "標題層級（貼 Markdown 的 # 會自動變成標題）",
        ".ql-size": "字體大小",
        ".ql-background": "🖍 蠟筆重點（螢光筆）",
        ".ql-align": "對齊方式",
        ".ql-blockquote": "引言",
        ".ql-code-block": "程式碼區塊",
        ".ql-image": "插入圖片（上傳到這篇記事）",
        ".ql-clean": "清除格式",
      };
      for (const [selector, title] of Object.entries(labels)) {
        toolbar.querySelector(selector)?.setAttribute("title", title);
      }
    }
    return quill;
  }

  /** 目前編輯框的內容（HTML，含畫面用的 pin，存檔前呼叫端要自己剝掉）。 */
  function getHtml(container) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return "";
    // Quill 完全清空時 root 是 <p><br></p>，視為空字串；只要有文字或圖片就算有內容
    const hasContent = quill.getText().trim().length > 0
      || !!quill.root.querySelector("img, .fieldlog-attachment-card");
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

  /** 在目前游標位置插入錄音播放器或一般檔案卡片。 */
  function insertAttachment(container, attachment) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return;
    const range = quill.getSelection(true) || { index: quill.getLength() };
    quill.insertEmbed(range.index, "fieldlogAttachment", attachment, "user");
    quill.insertText(range.index + 1, "\n", "user");
    quill.setSelection(range.index + 2, 0, "user");
  }

  window.fieldlogRichEditor = { init, getHtml, insertImage, insertAttachment, mdToHtml, looksLikeMarkdown };
})();
