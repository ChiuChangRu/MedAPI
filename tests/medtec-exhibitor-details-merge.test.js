/**
 * scripts/merge_exhibitor_details.py：把 scrape_exhibitor_details.js 抓回來的
 * 縮圖／官網／型錄併回 exhibitors.json，只補空的欄位，不覆蓋既有資料
 * （官網是 best-effort 猜測，抓錯的話不該蓋掉本來就對的資料）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/merge_exhibitor_details.py", import.meta.url).pathname;

function setup(exhibitors) {
  const dir = mkdtempSync(join(tmpdir(), "medtec-details-merge-"));
  const dataFile = join(dir, "exhibitors.json");
  writeFileSync(dataFile, JSON.stringify({ event: {}, categories: [], exhibitors }, null, 2));
  return { dir, dataFile };
}

function runMerge(dataFile, details, extraArgs = []) {
  const detailsPath = join(dataFile, "..", "details.json");
  writeFileSync(detailsPath, JSON.stringify(details));
  const stdout = execFileSync("python3",
    [SCRIPT, detailsPath, "--data-file", dataFile, ...extraArgs],
    { encoding: "utf8" });
  return { stdout, data: JSON.parse(readFileSync(dataFile, "utf8")) };
}

const ex = (id, overrides = {}) => ({
  id, name_zh: "", name_en: "", booth_no: "", category: "", pdfs: [], ...overrides,
});

test("補上目前是空的縮圖／官網／型錄", () => {
  const { dataFile } = setup([ex("ex-0001")]);
  const { data } = runMerge(dataFile, {
    "ex-0001": { photo: "https://img.example/a.jpg", website: "https://a.com", pdf: "https://img.example/a.pdf" },
  });
  const e = data.exhibitors[0];
  assert.equal(e.photo, "https://img.example/a.jpg");
  assert.equal(e.website, "https://a.com");
  assert.deepEqual(e.pdfs, ["https://img.example/a.pdf"]);
});

test("既有的縮圖／官網不會被覆蓋——官網是 best-effort 猜測，抓錯的話不該蓋掉本來就對的資料", () => {
  const { dataFile } = setup([ex("ex-0001", { photo: "https://old.example/photo.jpg", website: "https://real-company.com" })]);
  const { data } = runMerge(dataFile, {
    "ex-0001": { photo: "https://guessed.example/wrong.jpg", website: "https://guessed-wrong.com", pdf: null },
  });
  const e = data.exhibitors[0];
  assert.equal(e.photo, "https://old.example/photo.jpg", "既有縮圖不該被新猜的覆蓋");
  assert.equal(e.website, "https://real-company.com", "既有官網不該被新猜的覆蓋");
});

test("型錄用附加而不是覆蓋：同一份型錄不會重複塞兩次，不同型錄會累積", () => {
  const { dataFile } = setup([ex("ex-0001", { pdfs: ["https://img.example/existing.pdf"] })]);
  const { data: after1 } = runMerge(dataFile, { "ex-0001": { pdf: "https://img.example/existing.pdf" } });
  assert.deepEqual(after1.exhibitors[0].pdfs, ["https://img.example/existing.pdf"], "同一份型錄重跑一次不該變成兩份");

  const { data: after2 } = runMerge(dataFile, { "ex-0001": { pdf: "https://img.example/new.pdf" } });
  assert.deepEqual(after2.exhibitors[0].pdfs, ["https://img.example/existing.pdf", "https://img.example/new.pdf"]);
});

test("擷取結果是 null（那家完全沒抓到任何資料）時不出錯，其他欄位維持原樣", () => {
  const { dataFile } = setup([ex("ex-0001", { photo: "https://old.example/photo.jpg" })]);
  const { data } = runMerge(dataFile, { "ex-0001": null });
  assert.equal(data.exhibitors[0].photo, "https://old.example/photo.jpg");
});

test("擷取結果裡的 id 在展商名冊裡已經不存在時不出錯，只在統計裡回報", () => {
  const { dataFile } = setup([ex("ex-0001")]);
  const { stdout } = runMerge(dataFile, { "ex-9999": { photo: "https://x/a.jpg" } });
  assert.match(stdout, /對不到既有公司 id：1 家/);
});

test("--dry-run 只印差異、完全不寫檔", () => {
  const { dataFile } = setup([ex("ex-0001")]);
  const before = readFileSync(dataFile, "utf8");
  const { stdout } = runMerge(dataFile, { "ex-0001": { photo: "https://x/a.jpg" } }, ["--dry-run"]);
  assert.equal(readFileSync(dataFile, "utf8"), before);
  assert.match(stdout, /沒有寫入任何檔案/);
  assert.match(stdout, /補上縮圖：1 家/);
});
