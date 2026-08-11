"""把 scrape_exhibitor_details.js 抓回來的 exhibitor_details.json
（{ex_id: {photo, website, pdf}}）併進 exhibitors.json。

使用方式：
    python3 scripts/merge_exhibitor_details.py exhibitor_details.json --dry-run
    python3 scripts/merge_exhibitor_details.py exhibitor_details.json

只補「目前是空的」欄位，不覆蓋既有資料：
- photo／website：既有值非空就跳過，保留原本的
- pdfs：既有清單裡沒有才附加進去（同一份型錄不會重複塞兩次）

這支腳本的官網擷取是 best-effort 猜測（見 scrape_exhibitor_details.js 開頭
的說明），寫入前建議先看 --dry-run 的輸出，抽查幾家官網有沒有抓錯。
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [
    ROOT / "app" / "data" / "exhibitors.json",
    ROOT / "docs" / "data" / "exhibitors.json",
    ROOT / "cloudflare" / "public" / "data" / "exhibitors.json",
]


def merge(existing, details):
    by_id = {ex["id"]: ex for ex in existing}
    filled = {"photo": [], "website": [], "pdf": []}
    skipped_no_data, skipped_unknown_id = 0, 0

    for ex_id, info in details.items():
        target = by_id.get(ex_id)
        if not target:
            skipped_unknown_id += 1
            continue
        if not info:
            skipped_no_data += 1
            continue

        photo = (info.get("photo") or "").strip()
        if photo and not target.get("photo"):
            target["photo"] = photo
            filled["photo"].append(ex_id)

        website = (info.get("website") or "").strip()
        if website and not target.get("website"):
            target["website"] = website
            filled["website"].append(ex_id)

        pdf = (info.get("pdf") or "").strip()
        if pdf:
            pdfs = target.setdefault("pdfs", [])
            if pdf not in pdfs:
                pdfs.append(pdf)
                filled["pdf"].append(ex_id)

    return {
        "filled": filled,
        "skipped_no_data": skipped_no_data,
        "skipped_unknown_id": skipped_unknown_id,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("details_path", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="只印差異，不寫檔")
    ap.add_argument("--data-file", type=Path, action="append",
                    help="覆寫要寫入的 exhibitors.json（測試用，可重複指定）")
    args = ap.parse_args()

    targets = args.data_file or DATA_FILES
    details = json.loads(args.details_path.read_text(encoding="utf-8"))

    with open(targets[0], encoding="utf-8") as f:
        data = json.load(f)

    report = merge(data["exhibitors"], details)

    print(f"讀入 {len(details)} 家的擷取結果")
    print(f"  補上縮圖：{len(report['filled']['photo'])} 家")
    print(f"  補上官網：{len(report['filled']['website'])} 家（best-effort 猜測，建議抽查）")
    print(f"  補上型錄：{len(report['filled']['pdf'])} 家")
    print(f"  這次沒抓到任何資料（維持空白）：{report['skipped_no_data']} 家")
    if report["skipped_unknown_id"]:
        print(f"  ⚠ 對不到既有公司 id：{report['skipped_unknown_id']} 家（展商名冊可能在這之間又更新過）")

    if args.dry_run:
        print("\n--dry-run：沒有寫入任何檔案。")
        return

    # 三個 exhibitors.json（app／docs／cloudflare）內容要完全一致，全部寫同一份 data
    for data_file in targets:
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"已寫入 {', '.join(str(t) for t in targets)}")


if __name__ == "__main__":
    main()
