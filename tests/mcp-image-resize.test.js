/**
 * get_fieldlog_image：邊長超過門檻時要自動縮圖，控制 token 消耗。
 *
 * 背景：手機拍照常見 3000-4000px 寬，Claude 的圖片 token 大致跟像素數成正比
 * （(寬×高)÷750），不縮圖的話一張現場照片可能吃掉上萬 token——一份報告拉
 * 10-20 張就是十幾萬 token。縮到 1568px（Claude 官方建議的效率上限）內，
 * 每張穩定落在 ~3000 token，跟原始解析度無關。
 *
 * 用 photon 的 create_gradient() 在測試當下產生合成圖片，不把二進位測試檔
 * checked 進 repo。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { create_gradient, PhotonImage } from "@cf-wasm/photon";

import worker from "../mcp/src/worker.js";

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function makeTestJpegBase64(width, height) {
  const img = create_gradient(width, height);
  try {
    return bytesToBase64(img.get_bytes_jpeg(85));
  } finally {
    img.free();
  }
}

function decodedDimensions(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const img = PhotonImage.new_from_byteslice(bytes);
  try {
    return { width: img.get_width(), height: img.get_height() };
  } finally {
    img.free();
  }
}

// entry_id=1、attachment 內容由呼叫端指定；其餘查詢回最低限度的假資料
function makeDB(attachment) {
  const stmt = (sql) => ({
    bind: (...args) => stmt2(sql, args),
    all: async () => ({ results: [] }),
    first: async () => stmt2(sql, []).first(),
  });
  const stmt2 = (sql, args) => ({
    first: async () => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q === "SELECT * FROM attachments WHERE id = ?") {
        return args[0] === attachment.id ? attachment : null;
      }
      if (q === "SELECT id, title FROM entries WHERE id = ?") {
        return { id: attachment.entry_id, title: "測試紀錄" };
      }
      return null;
    },
    all: async () => ({ results: [] }),
  });
  return { prepare: stmt };
}

function makeFieldlogBinding(base64, mimeType, sizeBytes) {
  return {
    fetch: async () => new Response(JSON.stringify({
      data: base64, mime_type: mimeType, size_bytes: sizeBytes,
    }), { status: 200 }),
  };
}

async function callGetFieldlogImage(env, id) {
  const req = new Request("https://x/mcp?pin=testpin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_fieldlog_image", arguments: { id } } }),
  });
  const res = await worker.fetch(req, { MCP_PIN: "testpin", ...env });
  return (await res.json()).result;
}

test("超過 1568px 的照片會被縮小，回傳的圖片實際尺寸不超過門檻", async () => {
  const base64 = makeTestJpegBase64(2400, 1800);
  const attachment = { id: 1, entry_id: 10, mime: "image/jpeg", filename: "現場照.jpg", size: 300000, created_at: "2026-08-03" };
  const env = {
    DB_FIELDLOG: makeDB(attachment),
    FIELDLOG: makeFieldlogBinding(base64, "image/jpeg", 300000),
    FIELD_PIN: "fieldpin",
  };
  const result = await callGetFieldlogImage(env, 1);
  assert.ok(!result.isError, `不該報錯：${JSON.stringify(result)}`);
  const imageBlock = result.content.find((c) => c.type === "image");
  assert.ok(imageBlock, "要有 image 內容區塊");
  const dims = decodedDimensions(imageBlock.data);
  assert.ok(dims.width <= 1568 && dims.height <= 1568,
    `縮圖後應該都 ≤1568px，實得 ${dims.width}x${dims.height}`);
  const textBlock = result.content.find((c) => c.type === "text");
  assert.match(textBlock.text, /已縮圖/, "要在回傳的說明文字裡標示縮圖前後尺寸");
  assert.match(textBlock.text, /2400.*1800/, "要標出原始尺寸方便追查");
});

test("門檻內的照片不縮圖，原樣回傳（不做無謂的重新編碼）", async () => {
  const base64 = makeTestJpegBase64(200, 150);
  const attachment = { id: 2, entry_id: 10, mime: "image/jpeg", filename: "小圖.jpg", size: 5000, created_at: "2026-08-03" };
  const env = {
    DB_FIELDLOG: makeDB(attachment),
    FIELDLOG: makeFieldlogBinding(base64, "image/jpeg", 5000),
    FIELD_PIN: "fieldpin",
  };
  const result = await callGetFieldlogImage(env, 2);
  assert.ok(!result.isError);
  const imageBlock = result.content.find((c) => c.type === "image");
  assert.equal(imageBlock.data, base64, "門檻內的圖片應該回傳原始 base64，不重新編碼");
  const textBlock = result.content.find((c) => c.type === "text");
  assert.doesNotMatch(textBlock.text, /已縮圖/, "沒縮圖就不該顯示縮圖字樣");
});

test("剛好等於門檻（1568x1568）不觸發縮圖", async () => {
  const base64 = makeTestJpegBase64(1568, 1568);
  const attachment = { id: 3, entry_id: 10, mime: "image/jpeg", filename: "剛好.jpg", size: 100000, created_at: "2026-08-03" };
  const env = {
    DB_FIELDLOG: makeDB(attachment),
    FIELDLOG: makeFieldlogBinding(base64, "image/jpeg", 100000),
    FIELD_PIN: "fieldpin",
  };
  const result = await callGetFieldlogImage(env, 3);
  const imageBlock = result.content.find((c) => c.type === "image");
  assert.equal(imageBlock.data, base64, "剛好等於門檻不該被當成超過");
});

test("縮圖失敗（例如壞掉的圖檔）不能讓整支工具掛掉，退回原圖並註明", async () => {
  const attachment = { id: 4, entry_id: 10, mime: "image/jpeg", filename: "壞檔.jpg", size: 100, created_at: "2026-08-03" };
  const brokenBase64 = btoa("this is not a real image");
  const env = {
    DB_FIELDLOG: makeDB(attachment),
    FIELDLOG: makeFieldlogBinding(brokenBase64, "image/jpeg", 100),
    FIELD_PIN: "fieldpin",
  };
  const result = await callGetFieldlogImage(env, 4);
  assert.ok(!result.isError, "解碼失敗不該讓整支工具回 isError，至少要把原圖交出去");
  const imageBlock = result.content.find((c) => c.type === "image");
  assert.equal(imageBlock.data, brokenBase64, "縮圖失敗要退回原始資料，不能整個吞掉");
  const textBlock = result.content.find((c) => c.type === "text");
  assert.match(textBlock.text, /縮圖失敗/, "要讓人知道縮圖這步失敗了，不是靜悄悄地退化");
});
