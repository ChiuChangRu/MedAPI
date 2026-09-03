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
      /^\s{0,3}#{1,6}\s+\S/.test(line)
      || /^\s*([-*+])\s+\S/.test(line)
      || /^\s*\d+\.\s+\S/.test(line)
      || /^\s*>\s?\S/.test(line)
      || /^\s*```/.test(line)
      || /^\s*\|.+\|\s*$/.test(line)
      || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    );
    if (structural) return true;
    return /\*\*[^*\n]+\*\*/.test(text) || /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(text);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function inlineMd(line) {
    return line
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function mdToHtml(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const listStack = [];
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
      if (/^\s*```/.test(raw)) {
        flushPara();
        closeLists();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
        continue;
      }
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
        flushPara(); closeLists();
        const level = m[1].length;
        out.push(`<h${level}>${inlineMd(escapeHtml(m[2].trim()))}</h${level}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
        flushPara(); closeLists(); out.push("<hr>"); continue;
      }
      if ((m = raw.match(/^\s*>\s?(.*)$/))) {
        flushPara(); closeLists();
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
    const toolbarModule = quill.getModule("toolbar");
    toolbarModule?.addHandler("image", () => {
      if (typeof opts.onImagePaste !== "function") return;
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "image/*";
      picker.multiple = true;
      picker.setAttribute("aria-label", "從相簿選擇圖片");
      picker.hidden = true;
      picker.addEventListener("change", () => {
        for (const file of Array.from(picker.files || [])) opts.onImagePaste(file);
        picker.remove();
      }, { once: true });
      document.body.appendChild(picker);
      picker.click();
    });
    const Delta = window.Quill.import("delta");
    quill.clipboard.addMatcher("img", (node, delta) => {
      return node.hasAttribute && node.hasAttribute("data-att-id") ? delta : new Delta();
    });
    quill.root.addEventListener("paste", (ev) => {
      const data = ev.clipboardData;
      if (!data) return;
      if (Array.from(data.items || []).some((it) => it.kind === "file" && (it.type || "").startsWith("image/"))) return;
      const html = data.getData("text/html");
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
        if (!imageItem) return;
        ev.preventDefault();
        const file = imageItem.getAsFile();
        if (file) opts.onImagePaste(file);
      });
    }
    const toolbar = container.previousElementSibling;
    if (toolbar && toolbar.classList.contains("ql-toolbar")) {
      const labels = {
        ".ql-header": "標題層級（貼 Markdown 的 # 會自動變成標題）",
        ".ql-size": "字體大小",
        ".ql-background": "🖍 蠟筆重點（螢光筆）",
        ".ql-align": "對齊方式",
        ".ql-blockquote": "引言",
        ".ql-code-block": "程式碼區塊",
        ".ql-image": "從相簿插入圖片",
        ".ql-clean": "清除格式",
      };
      for (const [selector, title] of Object.entries(labels)) {
        toolbar.querySelector(selector)?.setAttribute("title", title);
      }
      if (opts.toolbarHost) {
        opts.toolbarHost.replaceChildren(toolbar);
        opts.toolbarHost.hidden = false;
      }
    }
    return quill;
  }

  function getHtml(container) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return "";
    const hasContent = quill.getText().trim().length > 0
      || !!quill.root.querySelector("img, .fieldlog-attachment-card");
    return hasContent ? quill.root.innerHTML : "";
  }

  function insertImage(container, url, attId) {
    const quill = container?.__fieldlogQuill;
    if (!quill) return;
    const range = quill.getSelection(true) || { index: quill.getLength() };
    quill.insertEmbed(range.index, "image", url, "user");
    quill.setSelection(range.index + 1, 0, "user");
    const [leaf] = quill.getLeaf(range.index);
    if (leaf && leaf.domNode) leaf.domNode.setAttribute("data-att-id", String(attId));
  }

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

// 2026-09-03 iOS 背景錄音 hotfix：不要在 visibility/pagehide 一隱藏就主動 stop。
// iOS 仍可能由系統暫停麥克風，所以這是「最佳努力」而非保證不中斷；既有的
// pageshow / resume / visibilitychange-visible 恢復流程會在回前景後檢查訊號並接續。
// 隱藏當下只要求 MediaRecorder 先吐出目前 chunk，降低系統凍結時遺失尾端資料。
try {
  onPageHidden = function onPageHiddenBestEffortAudio() {
    if (VIDEO) { VIDEO.autoStopped = true; stopVideo(); }
    if (AUDIO && !AUDIO.ending) {
      try {
        if (AUDIO.recorder?.state === "recording") AUDIO.recorder.requestData();
      } catch { /* iOS 正在凍結時 requestData 可能失敗，交給回前景恢復流程 */ }
      try { setAudioStatus("🎙️ 背景錄音中（回前景會自動檢查是否中斷）"); } catch { /* 純狀態提示，不影響錄音 */ }
    }
  };
} catch (err) {
  console.warn("背景錄音 hotfix 未套用", err);
}
