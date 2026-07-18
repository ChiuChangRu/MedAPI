"""將真實展商名單（CSV）轉換成 app/data/exhibitors.json 可用的格式。

使用方式：
    python3 scripts/import_exhibitors.py real_exhibitors.csv

CSV 欄位（第一列為標題，順序不拘）：
    name_zh, name_en, booth_no, hall, country, category, tags, description, products, website

- category 請填入 app/data/exhibitors.json 內 categories 區塊裡任一 id
  （materials / electronics / machining / packaging / automation /
    testing / oem / ivd / digital），沒有合適分類可自行在 exhibitors.json
  的 "categories" 陣列新增一筆。
- tags、products 若有多個值，用「;」分隔，例如：親水塗層;導管材料

轉換後會同步覆寫 app/data/exhibitors.json 與 docs/data/exhibitors.json 的
"exhibitors" 陣列（兩份資料要一致，分別給完整版 FastAPI 網頁與 GitHub Pages
靜態版網頁使用），event 與 categories 區塊維持不變（可自行到 app/data/exhibitors.json
調整活動資訊，腳本會一併同步到 docs）。
"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILES = [
    ROOT / "app" / "data" / "exhibitors.json",
    ROOT / "docs" / "data" / "exhibitors.json",
    ROOT / "cloudflare" / "public" / "data" / "exhibitors.json",
]


def split_multi(value: str) -> list[str]:
    return [v.strip() for v in value.split(";") if v.strip()] if value else []


def main() -> None:
    if len(sys.argv) != 2:
        print("用法: python3 scripts/import_exhibitors.py <csv檔案路徑>")
        sys.exit(1)

    csv_path = Path(sys.argv[1])
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        exhibitors = []
        for i, row in enumerate(reader, start=1):
            exhibitors.append(
                {
                    "id": f"ex-{i:04d}",
                    "name_zh": row.get("name_zh", "").strip(),
                    "name_en": row.get("name_en", "").strip(),
                    "booth_no": row.get("booth_no", "").strip(),
                    "hall": row.get("hall", "").strip(),
                    "country": row.get("country", "").strip(),
                    "category": row.get("category", "").strip(),
                    "tags": split_multi(row.get("tags", "")),
                    "description": row.get("description", "").strip(),
                    "products": split_multi(row.get("products", "")),
                    "website": row.get("website", "").strip(),
                }
            )

    with open(DATA_FILES[0], encoding="utf-8") as f:
        data = json.load(f)

    data["exhibitors"] = exhibitors
    data["event"]["note"] = "本資料已由 scripts/import_exhibitors.py 匯入真實展商名單。"

    for data_file in DATA_FILES:
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"已匯入 {len(exhibitors)} 家廠商至 {data_file}")


if __name__ == "__main__":
    main()
