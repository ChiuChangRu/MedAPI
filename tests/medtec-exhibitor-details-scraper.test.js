/**
 * scripts/scrape_exhibitor_details.js：長儒問「新增的展商是不是也能有連結、
 * 型錄、縮圖」，追下去發現名冊列表頁本身沒有這些資料，要進到每一家的展商
 * 詳情頁才抓得到——這支腳本就是做這件事的（沿用 scrape_exhibitor_photos.js
 * 已驗證過的縮圖擷取邏輯，多加型錄與官網兩項）。
 *
 * 這裡直接測 extractFromDocument() 這個純函式：給假的 DOM 物件，驗證三項
 * 各自的判斷邏輯——型錄優先認 image.imconlinereg.com 網域（跟縮圖同網域，
 * 是從既有真實資料驗證過的可靠模式），官網要濾掉主辦方/社群/追蹤網域，
 * 且不能把型錄連結誤判成官網（兩者都是 <a href>，順序判斷寫錯就會混淆）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadExtractFromDocument() {
  const src = await readFile(new URL("../scripts/scrape_exhibitor_details.js", import.meta.url), "utf8");
  const extractBlock = (startMarker) => {
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, `找不到 ${startMarker}`);
    if (startMarker.startsWith("const")) {
      const end = src.indexOf(";", start);
      return src.slice(start, end + 1);
    }
    let depth = 0;
    let i = src.indexOf("{", start);
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  };
  const code = [
    extractBlock("const NOISE_DOMAINS"),
    extractBlock("function hostOf"),
    extractBlock("function extractFromDocument"),
    "globalThis.__extractFromDocument = extractFromDocument;",
  ].join("\n");
  const context = vm.createContext({ URL });
  vm.runInContext(code, context);
  return context.__extractFromDocument;
}

// 假 DOM：只實作測試會用到的最小介面
function fakeDoc({ metas = [], imgs = [], links = [] }) {
  return {
    querySelector(sel) {
      if (sel.includes("og:image")) return metas.find((m) => m.type === "og") ? { getAttribute: () => metas.find((m) => m.type === "og").content } : null;
      if (sel.includes("twitter:image")) return metas.find((m) => m.type === "twitter") ? { getAttribute: () => metas.find((m) => m.type === "twitter").content } : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "img") {
        return imgs.map((src) => ({ getAttribute: (a) => (a === "src" ? src : null) }));
      }
      if (sel.startsWith("a[href]")) {
        return links.map((l) => ({
          getAttribute: (a) => (a === "href" ? l.href : null),
          textContent: l.text || "",
        }));
      }
      return []; // logo class 選擇器等，這裡的測試案例不需要
    },
  };
}

test("縮圖：優先挑 image.imconlinereg.com 網域的圖片，其次才是 og:image", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    metas: [{ type: "og", content: "https://cdn.example.com/og.jpg" }],
    imgs: ["https://image.imconlinereg.com/mm-mtc/2026-01-01/ABC.jpg"],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.photo, "https://image.imconlinereg.com/mm-mtc/2026-01-01/ABC.jpg");
});

test("型錄：image.imconlinereg.com 網域下的 .pdf 優先於其他 .pdf 連結", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [
      { href: "https://cdn.example.com/random.pdf", text: "隨便一份文件" },
      { href: "https://image.imconlinereg.com/mm-mtc/2026-01-09/CATALOG.pdf", text: "型錄下載" },
    ],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.pdf, "https://image.imconlinereg.com/mm-mtc/2026-01-09/CATALOG.pdf");
});

test("型錄：抓不到 imconlinereg 網域時，退回抓連結文字含「brochure/型錄」的連結", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [{ href: "https://cdn.example.com/files/company-intro", text: "下載型錄 Brochure" }],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.pdf, "https://cdn.example.com/files/company-intro");
});

test("官網：主辦方/社群/追蹤網域全部濾掉，不會被誤判成公司官網", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [
      { href: "https://www.facebook.com/sharer", text: "分享" },
      { href: "https://exhibitors.informamarkets-info.com/event/2026Medtec", text: "回列表" },
      { href: "https://www.addtoany.com/share", text: "" },
      { href: "https://www.realcompany.com", text: "公司官網" },
    ],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.website, "https://www.realcompany.com/");
});

test("官網：型錄連結（.pdf／imconlinereg）不會同時被當成官網候選", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [{ href: "https://image.imconlinereg.com/mm-mtc/2026-01-09/CATALOG.pdf", text: "型錄下載" }],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.pdf, "https://image.imconlinereg.com/mm-mtc/2026-01-09/CATALOG.pdf");
  assert.equal(r.website, null, "型錄連結被誤判成官網會讓資料品質更差，寧可官網缺著也不要抓錯");
});

test("官網：多個外部連結時，連結文字明講「website／官網」的優先於其他外部連結", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [
      { href: "https://distributor-a.com", text: "經銷商 A" },
      { href: "https://realcompany.com", text: "Visit Website" },
    ],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.website, "https://realcompany.com/");
});

test("什麼候選都沒有時，三項全部回 null，不會拋錯或回傳假資料", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({});
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.photo, null);
  assert.equal(r.website, null);
  assert.equal(r.pdf, null);
});

test("debug 用的候選清單有完整保留（方便使用者事後抽查官網有沒有抓錯）", async () => {
  const extractFromDocument = await loadExtractFromDocument();
  const doc = fakeDoc({
    links: [
      { href: "https://a.com", text: "A" },
      { href: "https://b.com", text: "B" },
    ],
  });
  const r = extractFromDocument(doc, "https://x/");
  assert.equal(r.candidates.website.length, 2, "只留下最終選中的那個不夠，人工抽查需要看到全部候選");
});
