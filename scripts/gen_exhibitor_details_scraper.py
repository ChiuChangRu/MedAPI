"""從 exhibitors.json 目前缺縮圖／官網／型錄的公司，更新
scrape_exhibitor_details.js 裡的 LIST 清單（直接在原檔案裡改 const LIST
那一行，不產生額外檔案，跟腳本本身放在同一個檔案裡方便直接複製貼上）。

使用方式：
    python3 scripts/gen_exhibitor_details_scraper.py

之後展商名單再更新、又多出一批缺資料的新公司時，重跑這支就會換成最新的
待處理清單。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scrape_exhibitor_details.js"
DATA_FILE = ROOT / "cloudflare" / "public" / "data" / "exhibitors.json"

LIST_RE = re.compile(r"const LIST = \[.*?\];")


def main():
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    missing = [
        {"id": e["id"], "url": e["directory_url"]}
        for e in data["exhibitors"]
        if e.get("in_directory", True) and not e.get("photo") and e.get("directory_url")
    ]

    src = SCRIPT.read_text(encoding="utf-8")
    new_list_line = f"const LIST = {json.dumps(missing, ensure_ascii=False)};"
    new_src, count = LIST_RE.subn(new_list_line, src, count=1)
    if count != 1:
        raise SystemExit(f"在 {SCRIPT} 裡找不到 'const LIST = [...];' 這一行，腳本可能被改過結構")
    SCRIPT.write_text(new_src, encoding="utf-8")
    print(f"缺縮圖/官網/型錄的公司：{len(missing)} 家 → 已更新 {SCRIPT}")


if __name__ == "__main__":
    main()
