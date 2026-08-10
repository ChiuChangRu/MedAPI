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

/**
 * 2026-08-10：長儒實際拿官方目錄跑出 881 家的 CSV 餵進來，發現名稱比對
 * 不夠用——「Lonyi Medicath Co., Ltd」（既有）跟「Lonyi Medicath CO LTD」
 * （新抓的）因為標點不同，name_key() 對不上，581 家裡有數百家會被誤判成
 * 新公司，重複塞進資料庫。兩邊的 directory_url 裡其實都藏著同一組官方
 * 數字 id（.../exhibitor/467193/...），這組 id 比公司名穩，改成優先用它
 * 比對。同一份 CSV 也混進了 54 筆沒解碼的 URL 編碼公司名（例如
 * "Aixway3d%EF%BC%88jiangsu%EF%BC%89co LTD"），這裡一併鎖住清理邏輯。
 */

test("官方數字 id 比對優先於名稱比對：公司名標點/縮寫不同也認得出是同一家，不會重複新增", () => {
  const { dataFile } = setup([{
    ...ex("ex-0001", ""),
    name_en: "Lonyi Medicath Co., Ltd",
    directory_url: "https://exhibitors.informamarkets-info.com/event/2026Medtec/en-US/exhibitor/467193/lonyi-medicath-co-ltd",
  }]);
  const { data } = runImport(dataFile,
    "name_en,directory_url\n" +
    'Lonyi Medicath CO LTD,https://exhibitors.informamarkets-info.com/event/2026Medtec/en-US/exhibitor/467193/lonyi-medicath-co---ltd\n');

  assert.equal(data.exhibitors.length, 1,
    "同一個官方數字 id（467193）就是同一家公司，不該因為標點不同被當成新公司");
  assert.equal(data.exhibitors[0].id, "ex-0001");
});

test("沒有官方數字 id 可用時（例如手動補的資料），仍然退回用名稱比對", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司")]);
  const { data } = runImport(dataFile, "name_zh,booth_no\n甲公司,B9\n");
  assert.equal(data.exhibitors.length, 1);
  assert.equal(data.exhibitors[0].id, "ex-0001");
  assert.equal(data.exhibitors[0].booth_no, "B9");
});

test("公司名含未解碼的 URL 編碼時，直接解碼還原（%EF%BC%88／%89 其實是全形括號）", () => {
  // 真實案例：長儒 2026-08-10 掃到的 881 家名單裡有 54 筆長這樣，都是公司
  // 英文名帶全形括號「（　）」，網頁抓取時沒解碼就存進來了
  const { dataFile } = setup([]);
  const { data } = runImport(dataFile,
    "name_en,directory_url\n" +
    "Aixway3d%EF%BC%88jiangsu%EF%BC%89co LTD,https://x/event/2026Medtec/en-US/exhibitor/466959/aixway3d%EF%BC%88jiangsu%EF%BC%89co--ltd\n");

  assert.equal(data.exhibitors.length, 1);
  assert.doesNotMatch(data.exhibitors[0].name_en, /%[0-9A-Fa-f]{2}/,
    "不該把沒解碼的 URL 編碼原樣存進資料庫");
  assert.equal(data.exhibitors[0].name_en, "Aixway3d（jiangsu）co LTD",
    "直接解碼就乾淨的話，比丟掉重編更保留原意");
});

test("雙重編碼（解一次後還是留著合法的 %XX）時，才退回用 directory_url 的 slug 還原", () => {
  // %25EF 解一次只會變成 %EF（%25 本身就是「%」的編碼），這種雙重編碼
  // 解一次還不夠乾淨，要能認得出「解完仍然是 %XX」而不是照單全收
  const { dataFile } = setup([]);
  const { data } = runImport(dataFile,
    "name_en,directory_url\n" +
    "Aixway3d%25EF%25BC%2588jiangsu%25EF%25BC%2589co LTD,https://x/event/2026Medtec/en-US/exhibitor/999001/aixway3d-jiangsu-co-ltd\n");

  assert.equal(data.exhibitors.length, 1);
  assert.doesNotMatch(data.exhibitors[0].name_en, /%[0-9A-Fa-f]{2}/,
    "解一次不乾淨就該退回用 slug，不能把雙重編碼的殘渣留著");
  assert.match(data.exhibitors[0].name_en, /Aixway3d/i);
});

test("公司名是乾淨的英文時，不會被誤判成亂碼而被 slug 蓋掉（只在真的有 %XX 時才處理）", () => {
  const { dataFile } = setup([]);
  const { data } = runImport(dataFile,
    "name_en,directory_url\n" +
    "3M China,https://x/event/2026Medtec/en-US/exhibitor/999002/3m-china\n");
  assert.equal(data.exhibitors[0].name_en, "3M China");
});

test("同一份 CSV 裡同一個官方數字 id 出現兩次，只新增一筆——id_index 要在新增當下就更新", () => {
  const { dataFile } = setup([]);
  const { data } = runImport(dataFile,
    "name_en,directory_url\n" +
    "Foo Co,https://x/event/2026Medtec/en-US/exhibitor/999003/foo-co\n" +
    "Foo Co.,https://x/event/2026Medtec/en-US/exhibitor/999003/foo-co\n");
  assert.equal(data.exhibitors.length, 1,
    "同一個 id 在同一批 CSV 裡出現兩次，不該因為 id_index 沒即時更新而重複新增");
});

/**
 * 2026-08-10：長儒問「有些公司只有英文名，能不能檢索出中文名（簡體即可）」。
 * 官方目錄本身有中文（zh-CN）語系頁面，用同一支 scrape_exhibitor_list.js
 * 重跑一次那個網址就能拿到中文名——但那個語系頁面的 name_en 是從網址 slug
 * 硬猜出來的（例如中文 slug 猜出來的英文字串），品質比既有的英文名差，
 * 不能整批覆蓋。--fields name_zh 就是為了只取需要的那一欄。
 */

test("--fields 限制只更新指定欄位：既有的 name_en 不會被較差的猜測值覆蓋", () => {
  const { dataFile } = setup([{
    ...ex("ex-0001", ""),
    name_en: "Lonyi Medicath Co., Ltd",
    directory_url: "https://x/event/2026Medtec/en-US/exhibitor/467193/lonyi-medicath",
  }]);
  const { data } = runImport(dataFile,
    "name_zh,name_en,directory_url\n" +
    "深圳朗醫科技,亂猜的英文名,https://x/event/2026Medtec/en-US/exhibitor/467193/lonyi-medicath\n",
    ["--fields", "name_zh"]);

  assert.equal(data.exhibitors[0].name_zh, "深圳朗醫科技", "指定的欄位要正常更新");
  assert.equal(data.exhibitors[0].name_en, "Lonyi Medicath Co., Ltd",
    "沒被列進 --fields 的欄位，就算 CSV 裡有值也不該套用");
});

test("--fields 限制欄位時，不會把「CSV 沒提到的公司」誤標成不在名單——這種局部增補不是完整名單", () => {
  const { dataFile } = setup([ex("ex-0001", "甲公司"), ex("ex-0002", "乙公司")]);
  const { data } = runImport(dataFile, "name_zh\n甲公司\n", ["--fields", "name_zh"]);

  assert.equal(data.exhibitors.find((e) => e.id === "ex-0002").in_directory, undefined,
    "乙公司沒出現在這份局部 CSV 裡，不代表牠真的不在展商名單上，不該被標記");
});

test("--fields 限制欄位時，真的配不到既有公司的新列仍然保留 directory_url（不然這筆資料無從追查來源）", () => {
  const { dataFile } = setup([]);
  const { data } = runImport(dataFile,
    "name_zh,directory_url\n" +
    "全新公司,https://x/event/2026Medtec/en-US/exhibitor/999009/new-co\n",
    ["--fields", "name_zh"]);

  assert.equal(data.exhibitors.length, 1);
  assert.equal(data.exhibitors[0].directory_url, "https://x/event/2026Medtec/en-US/exhibitor/999009/new-co");
});
