"""Merge WebSearch product findings into CIIF2026_exhibitors_with_keywords.json.

Only fills blank/待查 fields; never modifies an existing non-blank value.
Usage: python3 merge_products.py  (reads results/*.json, writes out/…)
"""
import copy
import glob
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
SRC = BASE / "CIIF2026_exhibitors_with_keywords.json"
OUT_DIR = BASE / "out"
CHECKED_AT = "2026-09-24"
SOURCE_LABEL = "官方網域搜尋摘要"
STATUS_LABEL = "產品：官方網域搜尋摘要（待開頁複核）"


def blank(v):
    if v is None:
        return True
    if isinstance(v, list):
        return len(v) == 0 or all((not str(x).strip()) or "待查" in str(x) for x in v)
    s = str(v).strip()
    return s == "" or "待查" in s


def host(url):
    h = urlparse(url if "//" in url else "//" + url).netloc.lower()
    return h[4:] if h.startswith("www.") else h


def same_site(evidence_url, website):
    a, b = host(evidence_url), host(website)
    if not a or not b:
        return False
    # allow subdomains of the recorded site (e.g. www-prepro.chlrob.com vs chlrob.com)
    return a == b or a.endswith("." + b) or b.endswith("." + a)


# Manual review decisions after reading the agents' notes.
EXCLUDE = {
    "CIIF26-R1699": "證據僅為日本集團企業站，未見展出產品，不採用",
    "CIIF26-R2020": "證據為母公司品牌站，非本法人官網，不自動寫入",
    "CIIF26-R0505": "聯合展位三家只查到一家，不自動寫入",
}
EXTRA_FLAGS = {
    "CIIF26-R1690": "weak_evidence",
    "CIIF26-R1722": "domain_verify",
    "CIIF26-R0489": "site_compromised",
    "CIIF26-R1373": "site_compromised",
    "CIIF26-R1807": "site_compromised",
    "CIIF26-R0252": "name_mismatch",
}


def load_results():
    rows = {}
    for f in sorted(glob.glob(str(BASE / "results" / "*.json"))):
        tier_b = "tierB" in f
        for r in json.load(open(f, encoding="utf-8")):
            r["_tier_b"] = tier_b
            rows[r["source_id"]] = r
    return rows


def main():
    data = json.load(open(SRC, encoding="utf-8"))
    orig = copy.deepcopy(data)
    by_id = {e["source_id"]: e for e in data["exhibitors"]}
    results = load_results()

    log = {"filled": [], "not_found": [], "not_searched": [], "rejected_domain": [], "flags": [], "notes": []}
    for sid, r in results.items():
        e = by_id.get(sid)
        if e is None:
            log["rejected_domain"].append((sid, "source_id 不在資料庫"))
            continue
        if r.get("flag") == "not_searched":
            log["not_searched"].append((sid, e["name_zh"]))
            continue
        if sid in EXCLUDE:
            log["not_found"].append((sid, e["name_zh"], EXCLUDE[sid]))
            continue
        for flag in filter(None, [r.get("flag"), EXTRA_FLAGS.get(sid)]):
            e.setdefault("review_flags", [])
            if flag not in e["review_flags"]:
                e["review_flags"].append(flag)
            log["flags"].append((sid, e["name_zh"], flag, r.get("note", "")))
        products = [p.strip() for p in r.get("products") or [] if p and p.strip()]
        if not (r.get("found") and products):
            log["not_found"].append((sid, e["name_zh"], r.get("note", "")))
            continue
        ev = r.get("evidence_url", "")
        if r["_tier_b"] and blank(e.get("website")) and r.get("official_domain"):
            dom = r["official_domain"].strip()
            if not same_site(ev, dom):
                log["rejected_domain"].append((sid, f"證據網域 {host(ev)} ≠ 新找到官網 {dom}"))
                continue
            e["website"] = f"{urlparse(ev).scheme or 'https'}://{urlparse(ev).netloc or dom}/"
            e["website_source"] = "官方網域搜尋摘要（本次新找到）"
        if not same_site(ev, e.get("website", "")):
            log["rejected_domain"].append((sid, f"證據網域 {host(ev)} ≠ 官網 {host(e.get('website',''))}"))
            continue
        changed = []
        if blank(e.get("products")):
            e["products"] = products
            changed.append("products")
        if blank(e.get("description")) and r.get("description"):
            e["description"] = r["description"].strip()
            changed.append("description")
        if blank(e.get("product_anchor_url")):
            e["product_anchor_url"] = ev
            changed.append("product_anchor_url")
        if blank(e.get("product_anchor_label")) and r.get("description"):
            e["product_anchor_label"] = r["description"].strip()
            changed.append("product_anchor_label")
        if not changed:
            log["not_found"].append((sid, e["name_zh"], "欄位原本已有值，未覆蓋"))
            continue
        e["product_source"] = SOURCE_LABEL
        e["product_evidence_url"] = ev
        e["product_checked_at"] = CHECKED_AT
        e["product_check_status"] = STATUS_LABEL
        if r.get("note"):
            e["product_note"] = r["note"]
            if "醫療" in r["note"] or "医疗" in r["note"]:
                log["notes"].append((sid, e["name_zh"], r["note"]))
        log["filled"].append((sid, e["name_zh"], changed))

    problems = audit(orig, data)
    OUT_DIR.mkdir(exist_ok=True)
    json.dump(data, open(OUT_DIR / "CIIF2026_exhibitors_with_keywords.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    json.dump(log, open(OUT_DIR / "merge_log.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"results={len(results)} filled={len(log['filled'])} not_found={len(log['not_found'])} "
          f"not_searched={len(log['not_searched'])} "
          f"rejected={len(log['rejected_domain'])} flags={len(log['flags'])} medical_notes={len(log['notes'])}")
    if problems:
        print("AUDIT FAILED:")
        for p in problems[:30]:
            print(" -", p)
        sys.exit(1)
    print("audit OK")


NEW_FIELDS = {"product_source", "product_evidence_url", "product_checked_at",
              "product_check_status", "product_note", "review_flags", "website_source"}


def audit(orig, new):
    p = []
    ex, ox = new["exhibitors"], orig["exhibitors"]
    if len(ex) != 2670:
        p.append(f"筆數 {len(ex)} ≠ 2670")
    ids = [e["source_id"] for e in ex]
    if ids != [f"CIIF26-R{i:04d}" for i in range(1, 2671)]:
        p.append("source_id 不連續或順序改變")
    if len(set(e["id"] for e in ex)) != len(ex):
        p.append("id 重複")
    for o, n in zip(ox, ex):
        for k, v in o.items():
            if k not in n:
                p.append(f"{o['source_id']} 欄位 {k} 被刪除")
            elif n[k] != v and not blank(v):
                p.append(f"{o['source_id']} 非空白欄位 {k} 被改動")
        for k in n:
            if k not in o and k not in NEW_FIELDS:
                p.append(f"{o['source_id']} 出現未預期新欄位 {k}")
        if "product_evidence_url" in n and not same_site(n["product_evidence_url"], n.get("website", "")):
            p.append(f"{o['source_id']} 證據網域與官網不符")
    for k in orig:
        if k != "exhibitors" and orig[k] != new[k]:
            p.append(f"頂層 {k} 被改動")
    json.loads(json.dumps(new, ensure_ascii=False))
    return p


if __name__ == "__main__":
    main()
