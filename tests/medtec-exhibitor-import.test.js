/**
 * scripts/import_exhibitors.py：展前重新匯入官方展商名單，不能弄丟團隊共筆。
 *
 * 2026-08-10：長儒要求「重新 scan 官方網站再登錄進系統」，追下去發現舊版
 * 匯入腳本會直接把整個 exhibitors 陣列換掉，而且 id 是按 CSV 列序重編
 * （第 n 列＝ex-000n）。medtec-2026 的 D1 有四張表用 exhibitor_id 這個字串
 * 當外鍵（state／notes／attachments／history），所以官方名單只要中間插進
 * 一家新公司，後面每一家的 id 都會位移一格，於是所有現場紀錄、照片、拜訪
 * 狀態都會安靜地掛到隔壁公司身上——沒有錯誤訊息，事後也幾乎查不出來。
 * 而展前重新匯入（新報名的展商會插在名單中間）正是最容易觸發的時機。
 *
 * 這份測試鎖住「id 穩定」這件事：只要有人把腳本改回按列序編號，或是讓
 * 名稱比對變得太寬鬆而誤併兩家公司，這裡就會壞掉。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/import_exhibitors.py", import.meta.url).pathname;

function setup(exhibitors) {
  const dir = mkdtempSync(join(tmpdir(), "medtec-import-"));
  const dataFile = join(dir, "exhibitors.json");
  writeFileSync(dataFile, JSON.stringify({
    event: { name_zh: "測試展", note: "" },
    categories: [],
    exhibitors,
  }, null, 2));
  return { dir, dataFile };
}

function runImport(dataFile, csv, extraArgs = []) {
  const csvPath = join(dataFile, "..", "in.csv");
  writeFileSync(csvPath, csv);
  const stdout = execFileSync("python3",
    [SCRIPT, csvPath, "--data-file", dataFile, ...extraArgs],
    { encoding: "utf8" });
  return { stdout, data: JSON.parse(readFileSync(dataFile, "utf8")) };
}

const ex = (id, name_zh, booth_no = "") => ({
  id, name_zh, name_en: "", booth_no, hall: "", country: "中國",
  category: "cat-05", tags: [], description: "", products: [], website: "",
});

test("名單中間插進一家新公司時，既有公司的 id 全部不變——這是共筆資料不會錯位的根本保證", () => {
  const { dataFile } = setup([
    ex("ex-0001", "甲公司"),
    ex("ex-0002", "乙公司"),
    ex("ex-0003", "丙公司"),
  ]);
  // 官方名單新版：新公司「新來的」排在乙、丙之間（依官方排序，很正常）
  const { data } = runImport(dataFile,
    "name_zh,booth_no\n甲公司,A1\n乙公司,B1\n新來的,X9\n丙公司,C1\n");

  const byName = Object.fromEntries(data.exhibitors.map((e) => [e.name_zh, e.id]));
  assert.equal(byName["甲公司"], "ex-0001");
  assert.equal(byName["乙公司"], "ex-0002");
  assert.equal(byName["丙公司"], "ex-0003",
    "丙公司的 id 絕對不能因為前面插了一家而變成 ex-0004——那會讓丙公司的現場紀錄變成新公司的");
  assert.equal(byName["新來的"], "ex-0004", "新公司要從既有最大號往後接");
});

test("既有公司的欄位會被官方名單更新（例如攤位號改了），但 id 不動", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司", "A1")]);
  const { data } = runImport(dataFile, "name_zh,booth_no\n甲公司,N2-A207\n");
  assert.equal(data.exhibitors[0].id, "ex-0001");
  assert.equal(data.exhibitors[0].booth_no, "N2-A207");
});

test("這次名單裡沒有的公司不刪除，只標記 in_directory=false——它可能已經有團隊紀錄", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司"), ex("ex-0002", "退展了")]);
  const { data } = runImport(dataFile, "name_zh\n甲公司\n");

  assert.equal(data.exhibitors.length, 2, "不能因為官方名單沒有就整筆消失");
  const gone = data.exhibitors.find((e) => e.name_zh === "退展了");
  assert.equal(gone.id, "ex-0002", "id 要留著，否則它底下的紀錄會變成孤兒");
  assert.equal(gone.in_directory, false);
  assert.equal(data.exhibitors.find((e) => e.name_zh === "甲公司").in_directory, true);
});

test("名稱比對只忽略空白與英文大小寫，不會把相似但不同的公司誤併成同一家", () => {
  const { dataFile } = setup([ex("ex-0001", "上海通耀醫療")]);
  const { data } = runImport(dataFile, "name_zh\n上海通耀醫療\n上海通耀科技\n");

  assert.equal(data.exhibitors.length, 2,
    "「醫療」與「科技」是兩家公司，誤併會讓兩家的現場紀錄混在一起且查不出來");
  assert.equal(data.exhibitors.find((e) => e.name_zh === "上海通耀醫療").id, "ex-0001");
  assert.equal(data.exhibitors.find((e) => e.name_zh === "上海通耀科技").id, "ex-0002");
});

test("同一家公司名稱前後多了空白／英文大小寫不同，仍視為同一家，不會重複新增", () => {
  const { dataFile } = setup([
    { ...ex("ex-0001", "深圳朗醫科技有限公司"), name_en: "Lonyi Medicath Co., Ltd" },
  ]);
  // name_en 本身含逗號，CSV 要加引號括起來（官方匯出的檔案也是這樣）
  const { data } = runImport(dataFile,
    'name_zh,name_en,booth_no\n 深圳朗醫科技有限公司 ,"LONYI MEDICATH CO., LTD",N2-A207\n');

  assert.equal(data.exhibitors.length, 1, "同一家公司不該因為空白或大小寫而變成兩筆");
  assert.equal(data.exhibitors[0].id, "ex-0001");
  assert.equal(data.exhibitors[0].booth_no, "N2-A207");
});

test("CSV 某欄位是空的時候，不會把既有的較完整資料洗成空字串", () => {
  const { dataFile } = setup([
    { ...ex("ex-0001", "甲公司", "A1"), website: "https://example.com" },
  ]);
  const { data } = runImport(dataFile, "name_zh,booth_no,website\n甲公司,A2,\n");
  assert.equal(data.exhibitors[0].booth_no, "A2", "有值就要更新");
  assert.equal(data.exhibitors[0].website, "https://example.com",
    "官方名單這欄剛好沒填，不代表我們手上的資料要被清掉");
});

test("--dry-run 只印差異、完全不寫檔（展前敢先跑一次看看的前提）", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司", "A1")]);
  const before = readFileSync(dataFile, "utf8");
  const { stdout } = runImport(dataFile, "name_zh,booth_no\n甲公司,B9\n新公司,C1\n", ["--dry-run"]);

  assert.equal(readFileSync(dataFile, "utf8"), before, "--dry-run 不可以動到檔案");
  assert.match(stdout, /沒有寫入任何檔案/);
  assert.match(stdout, /新增（配不到既有公司）：1 家/);
});

test("重複跑同一份 CSV 結果一樣（冪等）——不會每跑一次就多長出一批重複公司", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司")]);
  const csv = "name_zh,booth_no\n甲公司,A1\n乙公司,B1\n";
  const first = runImport(dataFile, csv).data;
  const second = runImport(dataFile, csv).data;
  assert.deepEqual(
    second.exhibitors.map((e) => [e.id, e.name_zh]),
    first.exhibitors.map((e) => [e.id, e.name_zh]),
  );
});

test("腳本不再用『列序』決定 id——擋住有人改回舊寫法", async () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /ex-\{i:04d\}/,
    "按 enumerate 列序編 id 正是會讓共筆錯位的那個寫法");
  assert.doesNotMatch(src, /data\["exhibitors"\]\s*=\s*exhibitors/,
    "整個陣列直接換掉會連同既有 id 一起丟掉");
  assert.match(src, /def name_key/, "要保留以名稱對應既有 id 的機制");
});
