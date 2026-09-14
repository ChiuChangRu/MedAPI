const encoder = new TextEncoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32Update(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function zipTimestamp(value) {
  const date = new Date(value || Date.now());
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.max(1980, valid.getUTCFullYear());
  return {
    time: ((valid.getUTCHours() & 0x1f) << 11) | ((valid.getUTCMinutes() & 0x3f) << 5) | ((Math.floor(valid.getUTCSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((valid.getUTCMonth() + 1) & 0x0f) << 5) | (valid.getUTCDate() & 0x1f),
  };
}

function record(size, fill) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  fill(view);
  return bytes;
}

function safeZipName(value, index) {
  const original = String(value || `recording-${index + 1}.webm`).replace(/[\\/\0]/g, "_").trim();
  const name = original || `recording-${index + 1}.webm`;
  return `${String(index + 1).padStart(3, "0")}_${name}`;
}

/**
 * 建立不壓縮（store）的串流 ZIP。音檔本身通常已壓縮，再做 deflate 幾乎不會變小；
 * 逐塊串流可避免長時間錄音在手機或 Worker 記憶體裡被整批展開。
 */
export function createAudioZipStream(files, openFile) {
  return new ReadableStream({
    async start(controller) {
      let offset = 0;
      const central = [];
      const push = (bytes) => { controller.enqueue(bytes); offset += bytes.byteLength; };
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const nameBytes = encoder.encode(safeZipName(file.filename, index));
          const stamp = zipTimestamp(file.created_at);
          const localOffset = offset;
          const flags = 0x0808; // UTF-8 filename + data descriptor
          push(record(30, (view) => {
            view.setUint32(0, 0x04034b50, true);
            view.setUint16(4, 20, true);
            view.setUint16(6, flags, true);
            view.setUint16(8, 0, true);
            view.setUint16(10, stamp.time, true);
            view.setUint16(12, stamp.date, true);
            view.setUint16(26, nameBytes.byteLength, true);
          }));
          push(nameBytes);

          const object = await openFile(file);
          if (!object?.body) throw new Error(`找不到錄音檔：${file.filename || file.key}`);
          const reader = object.body.getReader();
          let crc = 0xffffffff;
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            size += chunk.byteLength;
            if (size > 0xffffffff) throw new Error("單一錄音超過 ZIP 4GB 上限");
            crc = crc32Update(crc, chunk);
            push(chunk);
          }
          crc = (crc ^ 0xffffffff) >>> 0;
          push(record(16, (view) => {
            view.setUint32(0, 0x08074b50, true);
            view.setUint32(4, crc, true);
            view.setUint32(8, size, true);
            view.setUint32(12, size, true);
          }));
          central.push({ nameBytes, stamp, flags, crc, size, localOffset });
        }

        const centralOffset = offset;
        for (const file of central) {
          push(record(46, (view) => {
            view.setUint32(0, 0x02014b50, true);
            view.setUint16(4, 20, true);
            view.setUint16(6, 20, true);
            view.setUint16(8, file.flags, true);
            view.setUint16(10, 0, true);
            view.setUint16(12, file.stamp.time, true);
            view.setUint16(14, file.stamp.date, true);
            view.setUint32(16, file.crc, true);
            view.setUint32(20, file.size, true);
            view.setUint32(24, file.size, true);
            view.setUint16(28, file.nameBytes.byteLength, true);
            view.setUint32(42, file.localOffset, true);
          }));
          push(file.nameBytes);
        }
        const centralSize = offset - centralOffset;
        push(record(22, (view) => {
          view.setUint32(0, 0x06054b50, true);
          view.setUint16(8, central.length, true);
          view.setUint16(10, central.length, true);
          view.setUint32(12, centralSize, true);
          view.setUint32(16, centralOffset, true);
        }));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function recordingZipFilename(title) {
  const cleaned = String(title || "錄音").replace(/[\\/:*?"<>|#\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "錄音";
  return `${cleaned}_全部錄音.zip`;
}
