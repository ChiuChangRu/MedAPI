"""把官方展商名單（CSV）併入 exhibitors.json，並且「保住既有的 ex-XXXX id」。

使用方式：
    python3 scripts/import_exhibitors.py new_exhibitors.csv --dry-run   # 先看差異
    python3 scripts/import_exhibitors.py new_exhibitors.csv             # 確認後才真的寫

CSV 欄位（第一列為標題，順序不拘）：
    name_zh, name_en, booth_no, hall, country, category, tags, description,
    products, website, directory_url, pdfs
- tags／products／pdfs 多值用「;」分隔，例如：親水塗層;導管材料

────────────────────────────────────────────────────────────
為什麼這支腳本要這麼小心（2026-08-10 改寫的原因）
────────────────────────────────────────────────────────────
舊版是「整個 exhibitors 陣列直接換掉」，而且 id 是按 CSV 列序重新編號
（第 1 列＝ex-0001、第 2 列＝ex-0002…）。這在只有靜態網頁的時候沒問題，
但團隊共筆上線之後就會出事：D1 裡的四張表全部用 exhibitor_id 這個字串
當外鍵——

    state.exhibitor_id      (PRIMARY KEY)  拜訪狀態、負責人、觀展目標
    notes.exhibitor_id                     現場紀錄、想詢問的問題
    attachments.exhibitor_id               照片、錄音
    history.exhibitor_id                   稽核軌跡

官方名單只要新增或移除任何一家、或是排序變了，重新匯入就會讓後面所有公司
的 id 整批位移，於是每一則現場紀錄、每一張照片、每一筆拜訪狀態都會安靜地
掛到「別家公司」身上，而且沒有任何錯誤訊息。展前重新匯入正是最可能發生
這件事的時機（新報名的展商會插進名單中間），也正是共筆資料最不能弄丟的
時候。

所以這一版改成：
1. 用「公司名稱」而不是「列序」對應既有資料，對得上就沿用原本的 id。
2. 對不上的才是真的新公司，id 從現有最大號往後接，不重複使用舊號碼。
3. 名稱比對刻意保守（只做去空白／英文大小寫），寧可誤判成「新公司」而
   多出一列（看得見、可手動併），也不要誤判成「同一家」而把別人的紀錄
   接到錯的公司上（安靜、事後查不出來）。
4. 這次名單裡沒有、但舊資料有的公司「不刪除」，只標記
   in_directory=false——那些公司可能已經有團隊紀錄，直接刪掉會讓紀錄
   變成孤兒、App 上只剩一個查不到名字的 id。
"""
import argparse
import csv
import json
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [
    ROOT / "app" / "data" / "exhibitors.json",
    ROOT / "docs" / "data" / "exhibitors.json",
    ROOT / "cloudflare" / "public" / "data" / "exhibitors.json",
]

# CSV 進來後要覆蓋的欄位。id 不在裡面（id 是我們自己維護的主鍵，永遠不從
# CSV 讀），in_directory 也不在（那是這支腳本自己算出來的狀態）。
CSV_FIELDS = [
    "name_zh", "name_en", "booth_no", "hall", "country",
    "category", "description", "website", "directory_url",
]
MULTI_FIELDS = ["tags", "products", "pdfs"]


def split_multi(value):
    return [v.strip() for v in (value or "").split(";") if v.strip()]


def name_key(name):
    """比對用的正規化名稱：去掉所有空白、英文轉小寫。

    刻意只做這兩件事。試過更聰明的正規化（例如拿掉「有限公司」「股份」
    這類後綴）反而危險：「上海通耀醫療」與「上海通耀科技」會被歸成同一家，
    一旦誤併，兩家公司的現場紀錄就混在一起，而且從結果完全看不出來。
    """
    return re.sub(r"\s+", "", (name or "")).lower()


DIRECTORY_ID_RE = re.compile(r"/exhibitor/(\d+)/")


def official_id(directory_url):
    """從官方展商目錄網址抓出數字 id（.../exhibitor/467193/公司名-slug）。

    2026-08-10 實測發現：這組數字 id 比公司名穩得多。同一家「Lonyi
    Medicath」，舊資料存的英文名是 "Lonyi Medicath Co., Ltd"，新抓的是
    "Lonyi Medicath CO LTD"——name_key() 只正規化空白跟大小寫，不動標點，
    這兩個字串對不上，會被誤判成新公司。但兩邊的 directory_url 裡都是
    同一個數字 467193，抓這個來比對完全不會有這種標點/縮寫差異的問題。
    """
    if not directory_url:
        return ""
    m = DIRECTORY_ID_RE.search(directory_url)
    return m.group(1) if m else ""


def slug_to_name(slug):
    """把網址 slug 還原成看得懂的英文名，公司名亂碼/缺漏時的保底用。

    例：yi-plus-one-medical-technology-co-ltd
        → Yi Plus One Medical Technology Co Ltd

    slug 裡偶爾還留著未解碼的 URL 編碼（公司名含中文全形符號時常見，見
    clean_name_en 的說明），先解碼一次再切詞，不然那段會被當成一個超長的
    英數字混雜詞，切不開也還原不了。
    """
    slug = unquote(slug or "")
    words = [w for w in re.split(r"[-_]+", slug) if w]
    return " ".join(w.upper() if len(w) <= 3 else w[:1].upper() + w[1:] for w in words)


def clean_name_en(name_en, directory_url):
    """公司名含未解碼的 URL 編碼（%XX）時解碼；解不乾淨就改用網址 slug 還原。

    2026-08-10 實測：881 筆裡有 54 筆 name_en 混進了像
    "Aixway3d%EF%BC%88jiangsu%EF%BC%89co LTD" 這種東西——擷取腳本在網頁上
    抓到的是還沒解碼的網址片段（%EF%BC%88／%EF%BC%89 其實是全形括號
    「（」「）」的 UTF-8 編碼）。先試著直接解碼：大多數情況解完就乾淨了
    （"Aixway3d（jiangsu）co LTD"），比丟掉重編更保留原意；只有解碼後仍然
    留著 %XX（代表這不是單純的編碼問題）才退回用 directory_url 的 slug
    重新還原一個乾淨版本。
    """
    name_en = (name_en or "").strip()
    if name_en:
        if not re.search(r"%[0-9A-Fa-f]{2}", name_en):
            return name_en
        decoded = unquote(name_en).strip()
        if not re.search(r"%[0-9A-Fa-f]{2}", decoded):
            return decoded
    m = DIRECTORY_ID_RE.search(directory_url or "")
    if not m:
        return name_en  # 亂碼但也沒有網址可還原，只能原樣留著讓人工看
    slug = directory_url.rstrip("/").split("/")[-1]
    return slug_to_name(slug) or name_en


def build_index(existing):
    """既有展商的 名稱 → id、官方數字 id → id 兩份對照表。

    同一個 key 出現兩次（舊資料本來就有重複公司）時保留第一筆，並回報，
    因為第二筆之後不管配到誰都是猜的，要讓人知道去處理。
    """
    index, id_index, dupes = {}, {}, []
    for ex in existing:
        oid = official_id(ex.get("directory_url"))
        if oid:
            id_index.setdefault(oid, ex["id"])
        for field in ("name_zh", "name_en"):
            key = name_key(ex.get(field))
            if not key:
                continue
            if key in index and index[key] != ex["id"]:
                dupes.append((key, index[key], ex["id"]))
                continue
            index[key] = ex["id"]
    return index, id_index, dupes


def next_id_maker(existing):
    """新公司的 id 從現有最大號往後接——不填補中間的空號。

    重用已刪除公司的舊號碼會讓那家公司的歷史紀錄接到新公司身上，
    跟位移一樣是安靜的資料污染。
    """
    max_n = 0
    for ex in existing:
        m = re.fullmatch(r"ex-(\d+)", str(ex.get("id", "")))
        if m:
            max_n = max(max_n, int(m.group(1)))
    counter = {"n": max_n}

    def make():
        counter["n"] += 1
        return f"ex-{counter['n']:04d}"

    return make


def merge(existing, rows, only_fields=None, fill_only_fields=None):
    """only_fields：只允許更新這些欄位，其餘 CSV 裡有值也不套用。

    2026-08-10 加的用途：官方目錄的中文（zh-CN）版本拿來補既有公司缺的
    name_zh 時，那個語系頁面的 name_en 是從網址 slug 硬猜的，品質比既有
    的英文名差——只想要 name_zh 這一欄，不想讓猜出來的英文名覆蓋掉原本
    正確的。比對用的官方數字 id 一律從 row 的 directory_url 讀，不受這個
    限制影響（只影響「會不會被寫進 payload」，不影響「用什麼比對」）。
    """
    index, id_index, dupes = build_index(existing)
    make_id = next_id_maker(existing)
    by_id = {ex["id"]: ex for ex in existing}
    allowed = set(only_fields) if only_fields else None
    fill_only = set(fill_only_fields or [])

    matched_ids, added, updated, unchanged = set(), [], [], 0
    id_matched, name_matched = 0, 0

    for row in rows:
        fields = [f for f in CSV_FIELDS if allowed is None or f in allowed]
        payload = {f: (row.get(f) or "").strip() for f in fields}
        if "name_en" in payload:
            payload["name_en"] = clean_name_en(payload["name_en"], row.get("directory_url"))
        payload.update({f: split_multi(row.get(f)) for f in MULTI_FIELDS if allowed is None or f in allowed})

        key = name_key(row.get("name_zh")) or name_key(payload.get("name_en"))
        oid = official_id(row.get("directory_url"))
        # 官方數字 id 優先——不受公司名標點/縮寫差異影響（見 official_id 的
        # 說明）。抓不到 id 的列（例如手動補的資料）才退回用名稱比對。
        ex_id = id_index.get(oid) if oid else None
        if ex_id:
            id_matched += 1
        elif key:
            ex_id = index.get(key)
            if ex_id:
                name_matched += 1
        elif not key:
            continue  # 既沒有可用的 id 也沒有名字，不可能安全對應

        if ex_id and ex_id in by_id:
            target = by_id[ex_id]
            matched_ids.add(ex_id)
            before = {k: target.get(k) for k in payload}
            # CSV 沒填的欄位不要把既有值洗成空字串——官方目錄有時候某些
            # 欄位是空的，但我們手上可能已經有更完整的資料
            changes = {k: v for k, v in payload.items() if v and v != before.get(k)}
            # fill_only 欄位：既有已經有值就不動，只補空的。
            # 2026-08-10 的實際需求：新來源的中文名是簡體，但這個專案早期
            # 特意把展商資料全面轉成繁體（臺灣用語），無條件覆蓋會讓 520 家
            # 從繁體變簡體，是退步；而且有些公司兩邊取名層級不同（母公司 vs
            # 合資公司），既有的人工整理結果通常比較貼近團隊實際認知。
            # 攤位號、分類這種「會變動的事實」則照常更新，不套用這個限制。
            for k in list(changes):
                if k in fill_only and before.get(k):
                    del changes[k]
            if changes:
                target.update(changes)
                target["in_directory"] = True
                updated.append((ex_id, target.get("name_zh"), sorted(changes)))
            else:
                target["in_directory"] = True
                unchanged += 1
        else:
            new_ex = {"id": make_id(), **payload, "in_directory": True}
            # 就算 only_fields 限制了要更新哪些欄位，全新的一筆至少要留得住
            # directory_url——不然這筆記錄以後既對不到官方數字 id，也沒有
            # 連結可以人工查證，形同一筆來歷不明的資料
            new_ex.setdefault("directory_url", (row.get("directory_url") or "").strip())
            new_ex.setdefault("tags", [])
            existing.append(new_ex)
            by_id[new_ex["id"]] = new_ex
            if key:
                index[key] = new_ex["id"]
            if oid:
                # 同一份 CSV 裡若同一家公司出現兩次（同一個 oid），第二次要
                # 認得出剛剛才新增的這筆，不能因為 id_index 沒更新而重複新增
                id_index[oid] = new_ex["id"]
            matched_ids.add(new_ex["id"])
            added.append((new_ex["id"], new_ex.get("name_zh") or new_ex.get("name_en")))

    # 「這次名單沒有的公司標成 in_directory=false」的前提是這份 CSV 代表
    # 「完整的官方名單」。only_fields 限制欄位時通常是拿某個補充來源（例如
    # 中文語系頁面只想補 name_zh）局部增補，不是完整重新匯入，這時候用同一套
    # 邏輯會把「這次沒抓進來的公司」全部誤標成不在名單——跳過這一步。
    missing = []
    if allowed is None:
        for ex in existing:
            if ex["id"] in matched_ids:
                continue
            ex["in_directory"] = False
            missing.append((ex["id"], ex.get("name_zh")))

    return {
        "added": added, "updated": updated, "unchanged": unchanged,
        "missing": missing, "dupes": dupes,
        "id_matched": id_matched, "name_matched": name_matched,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="只印差異，不寫檔")
    ap.add_argument("--data-file", type=Path, action="append",
                    help="覆寫要寫入的 exhibitors.json（測試用，可重複指定）")
    ap.add_argument("--fields",
                    help="只更新這些欄位（逗號分隔，例如 name_zh），其餘欄位有值也不套用；"
                         "同時停用「這次名單沒有就標記不在名單」的判斷（這種局部增補不代表完整名單）")
    ap.add_argument("--fill-only",
                    help="這些欄位（逗號分隔）只補空值，既有已經有值就不覆蓋。"
                         "用在「新來源某些欄位品質不一定比既有好」的情況，例如既有中文名是"
                         "人工整理過的繁體、新來源是簡體")
    args = ap.parse_args()

    targets = args.data_file or DATA_FILES
    only_fields = [f.strip() for f in args.fields.split(",") if f.strip()] if args.fields else None
    fill_only_fields = [f.strip() for f in args.fill_only.split(",") if f.strip()] if args.fill_only else None

    with open(args.csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    with open(targets[0], encoding="utf-8") as f:
        data = json.load(f)

    before_count = len(data["exhibitors"])
    report = merge(data["exhibitors"], rows, only_fields=only_fields, fill_only_fields=fill_only_fields)

    print(f"CSV 讀入 {len(rows)} 列｜既有 {before_count} 家 → 現在 {len(data['exhibitors'])} 家")
    print(f"  用官方數字 id 對應到既有公司：{report['id_matched']} 家（可靠，不受名稱標點/縮寫差異影響）")
    print(f"  沒有 id 可用、退回用名稱對應到既有公司：{report['name_matched']} 家")
    print(f"  沿用既有 id 並更新欄位：{len(report['updated'])} 家")
    print(f"  沿用既有 id、內容無變化：{report['unchanged']} 家")
    print(f"  新增（配不到既有公司）：{len(report['added'])} 家")
    print(f"  這次名單沒有、標記 in_directory=false（不刪除）：{len(report['missing'])} 家")

    for ex_id, name in report["added"][:20]:
        print(f"    ＋ {ex_id}  {name}")
    if len(report["added"]) > 20:
        print(f"    …另外還有 {len(report['added']) - 20} 家")
    for ex_id, name in report["missing"][:20]:
        print(f"    － {ex_id}  {name}（保留，僅標記不在名單）")
    if len(report["missing"]) > 20:
        print(f"    …另外還有 {len(report['missing']) - 20} 家")
    for key, kept, dropped in report["dupes"]:
        print(f"    ⚠ 舊資料同名重複：「{key}」 保留 {kept}、忽略 {dropped}，請人工確認")

    if args.dry_run:
        print("\n--dry-run：沒有寫入任何檔案。確認上面的差異沒問題後，拿掉 --dry-run 再跑一次。")
        return

    data["event"]["note"] = (
        f"本資料由 scripts/import_exhibitors.py 併入官方展商名單，"
        f"共 {len(data['exhibitors'])} 家（既有 id 保持不變）。"
    )
    for data_file in targets:
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"已寫入 {data_file}")


if __name__ == "__main__":
    main()
