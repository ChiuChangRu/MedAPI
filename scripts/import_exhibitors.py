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


def build_index(existing):
    """既有展商的 名稱 → id 對照表。

    同一個 key 出現兩次（舊資料本來就有重複公司）時保留第一筆，並回報，
    因為第二筆之後不管配到誰都是猜的，要讓人知道去處理。
    """
    index, dupes = {}, []
    for ex in existing:
        for field in ("name_zh", "name_en"):
            key = name_key(ex.get(field))
            if not key:
                continue
            if key in index and index[key] != ex["id"]:
                dupes.append((key, index[key], ex["id"]))
                continue
            index[key] = ex["id"]
    return index, dupes


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


def merge(existing, rows):
    index, dupes = build_index(existing)
    make_id = next_id_maker(existing)
    by_id = {ex["id"]: ex for ex in existing}

    matched_ids, added, updated, unchanged = set(), [], [], 0

    for row in rows:
        key = name_key(row.get("name_zh")) or name_key(row.get("name_en"))
        if not key:
            continue  # 沒有名字的列直接跳過，不可能安全對應
        payload = {f: (row.get(f) or "").strip() for f in CSV_FIELDS}
        payload.update({f: split_multi(row.get(f)) for f in MULTI_FIELDS})

        ex_id = index.get(key)
        if ex_id and ex_id in by_id:
            target = by_id[ex_id]
            matched_ids.add(ex_id)
            before = {k: target.get(k) for k in payload}
            # CSV 沒填的欄位不要把既有值洗成空字串——官方目錄有時候某些
            # 欄位是空的，但我們手上可能已經有更完整的資料
            changes = {k: v for k, v in payload.items() if v and v != before.get(k)}
            if changes:
                target.update(changes)
                target["in_directory"] = True
                updated.append((ex_id, target.get("name_zh"), sorted(changes)))
            else:
                target["in_directory"] = True
                unchanged += 1
        else:
            new_ex = {"id": make_id(), **payload, "in_directory": True}
            new_ex.setdefault("tags", [])
            existing.append(new_ex)
            by_id[new_ex["id"]] = new_ex
            index[key] = new_ex["id"]
            matched_ids.add(new_ex["id"])
            added.append((new_ex["id"], new_ex.get("name_zh") or new_ex.get("name_en")))

    missing = []
    for ex in existing:
        if ex["id"] in matched_ids:
            continue
        ex["in_directory"] = False
        missing.append((ex["id"], ex.get("name_zh")))

    return {
        "added": added, "updated": updated, "unchanged": unchanged,
        "missing": missing, "dupes": dupes,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="只印差異，不寫檔")
    ap.add_argument("--data-file", type=Path, action="append",
                    help="覆寫要寫入的 exhibitors.json（測試用，可重複指定）")
    args = ap.parse_args()

    targets = args.data_file or DATA_FILES

    with open(args.csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    with open(targets[0], encoding="utf-8") as f:
        data = json.load(f)

    before_count = len(data["exhibitors"])
    report = merge(data["exhibitors"], rows)

    print(f"CSV 讀入 {len(rows)} 列｜既有 {before_count} 家 → 現在 {len(data['exhibitors'])} 家")
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
