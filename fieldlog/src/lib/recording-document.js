/**
 * 錄音資料包 → 單一 Word 內文的純函式。
 *
 * audio.offset_secs / photo.offset_secs 都是從同一次錄音開始算的秒數；Whisper
 * 的 VTT 則是單一音檔內的相對時間。兩者相加後就能把逐字稿與照片放回同一條
 * 真實時間軸，不需要讓 AI 猜照片應該插在哪一段。
 */

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timestampToSeconds(value) {
  const raw = String(value || "").trim().replace(",", ".");
  if (!raw) return null;
  const parts = raw.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function parseVtt(vtt) {
  const source = String(vtt || "").replace(/^\uFEFF/, "").trim();
  if (!source) return [];
  const blocks = source.split(/\r?\n\s*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/([^\s]+)\s*-->\s*([^\s]+)/);
    if (!timing) continue;
    const start = timestampToSeconds(timing[1]);
    const end = timestampToSeconds(timing[2]);
    const text = lines.slice(timingIndex + 1).join(" ")
      .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (start === null || end === null || !text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

function joinCueText(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a) return b;
  if (!b) return a;
  // 中文／日文等沒有天然空白的文字不要被硬插空格；拉丁文字仍保留單字間距。
  const noSpace = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)
    || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、]/u.test(b);
  return `${a}${noSpace ? "" : " "}${b}`;
}

function endsSentence(text) {
  return /[。！？!?；;：:]\s*$/.test(String(text || ""));
}

/**
 * Whisper 的 VTT 有時會把中文切成「一個字一個 cue」，甚至十幾個 cue 都落在
 * 同一秒。VTT 在這裡只是定位工具，不是排版規格：把相鄰短 cue 合併成可讀段落，
 * 仍保留段落起始時間供照片穿插。遇完整句、明顯停頓或約 6 秒就另起一段。
 */
export function mergeTranscriptCues(cues) {
  const source = Array.isArray(cues) ? cues.filter((cue) => cue && String(cue.text || "").trim()) : [];
  if (!source.length) return [];
  const merged = [];
  let current = null;
  for (const cue of source) {
    const item = {
      start: Math.max(0, Number(cue.start) || 0),
      end: Math.max(0, Number(cue.end) || Number(cue.start) || 0),
      text: String(cue.text).trim(),
    };
    if (!current) {
      current = item;
      continue;
    }
    const gap = item.start - current.end;
    const span = item.end - current.start;
    const shouldBreak = endsSentence(current.text) || gap > 1.25 || span > 6;
    if (shouldBreak) {
      merged.push(current);
      current = item;
      continue;
    }
    current.text = joinCueText(current.text, item.text);
    current.end = Math.max(current.end, item.end);
  }
  if (current) merged.push(current);
  return merged;
}

export function formatRecordingOffset(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function shouldRegenerateRecordingDocument(currentBody, currentHash, generatedHash) {
  if (!String(currentBody || "").trim()) return true;
  return !!generatedHash && generatedHash === currentHash;
}

function fileUrl(key) {
  return `/api/file/${String(key || "").split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * 照片與逐字稿同秒時先放逐字稿，再放照片；如此照片會緊接在拍攝當下正在說的
 * 文字之後。附件 id 去重，避免離線補傳或重建時同一張圖重複出現。
 */
export function buildRecordingDocumentHtml(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const events = [];
  for (const audio of items.filter((item) => item.kind === "audio")) {
    const base = Math.max(0, Number(audio.offset_secs) || 0);
    const cues = mergeTranscriptCues(parseVtt(audio.transcript_vtt));
    if (cues.length) {
      for (const cue of cues) {
        events.push({ type: "text", at: base + cue.start, end: base + cue.end, id: Number(audio.id) || 0, text: cue.text });
      }
    } else if (String(audio.transcript || "").trim()) {
      events.push({ type: "text", at: base, end: base, id: Number(audio.id) || 0, text: String(audio.transcript).trim() });
    }
  }

  const seenPhotos = new Set();
  for (const photo of items.filter((item) => item.kind === "photo" || /^image\//i.test(item.mime || ""))) {
    const id = Number(photo.id) || 0;
    if (!id || seenPhotos.has(id) || !photo.key) continue;
    seenPhotos.add(id);
    events.push({
      type: "photo", at: Math.max(0, Number(photo.offset_secs) || 0), end: 0, id,
      filename: photo.filename || photo.original_filename || "照片", key: photo.key,
    });
  }

  events.sort((a, b) => a.at - b.at || (a.type === b.type ? a.id - b.id : a.type === "text" ? -1 : 1));
  return events.map((event) => {
    const time = formatRecordingOffset(event.at);
    if (event.type === "photo") {
      return `<p><strong>📷 ${time}</strong></p><p><img src="${escapeHtml(fileUrl(event.key))}" alt="${escapeHtml(event.filename)}" data-att-id="${event.id}"></p>`;
    }
    return `<p><strong>${time}</strong> ${escapeHtml(event.text)}</p>`;
  }).join("");
}
