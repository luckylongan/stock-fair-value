#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""收集各公司最新一期季報的每股盈餘，輸出 data/quarterly.json。

用途
----
交易所公布的本益比是用「近四季 EPS」算的，反映的是過去一整年的獲利。
獲利正在成長或衰退的公司，近四季會落後於現況。本檔提供最新一期的
「當年度累計 EPS」，前端據此年化成全年預估 EPS：

    年化 EPS = 當年度累計 EPS ÷ 季別 × 4

（Q1 ×4、Q2 ×2、Q3 ×4/3、Q4 ×1；Q4 的累計本來就是全年。）

資料來源
--------
上市 https://openapi.twse.com.tw/v1/opendata/t187ap06_L_<業別>
上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_<業別>

兩邊的「基本每股盈餘（元）」都是<當年度累計>，不是單季 —— 已用實際資料
與交易所近四季 EPS 交叉比對確認（比值集中在 0.5 附近，即 Q2 為上半年）。

各公司申報時間不同，API 又只提供最新一期，因此本檔採累積方式：
每次執行只在「年度／季別比既有的新」時才覆蓋。
"""

import json
import os
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
TPE = timezone(timedelta(hours=8))

SECTORS = ["ci", "basi", "bd", "mim", "ins", "fh"]   # 一般/金融/證券/異業/保險/金控
TWSE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_%s"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_%s"
EPS_KEY = "基本每股盈餘（元）"


def fetch_json(url, retries=3, timeout=45):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception:  # noqa: BLE001
            time.sleep(1 + i * 2)
    return None


def fnum(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def pick(r, *names):
    """兩個交易所的欄位命名不同：上市用中文，上櫃用英文。"""
    for n in names:
        if r.get(n) not in (None, ""):
            return r[n]
    return None


def collect(url_tmpl, market):
    out = {}
    for sec in SECTORS:
        rows = fetch_json(url_tmpl % sec)
        if not rows:
            continue
        n = 0
        for r in rows:
            code = str(pick(r, "公司代號", "SecuritiesCompanyCode") or "").strip()
            if len(code) != 4 or not code.isdigit():
                continue
            eps = fnum(r.get(EPS_KEY))
            y, q = fnum(pick(r, "年度", "Year")), fnum(pick(r, "季別", "Season"))
            if eps is None or not y or not q:
                continue
            key = (int(y), int(q))
            cur = out.get(code)
            if cur is None or key > (cur["y"], cur["q"]):
                out[code] = {"y": int(y), "q": int(q), "cum": round(eps, 4), "m": market}
                n += 1
        print("   %-6s %4d 筆" % (sec, n))
        time.sleep(0.3)
    return out


def load_existing():
    try:
        with open(os.path.join(OUT_DIR, "quarterly.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main():
    print("== 上市季報 ==")
    a = collect(TWSE_URL, "上市")
    print("== 上櫃季報 ==")
    b = collect(TPEX_URL, "上櫃")

    merged = dict((load_existing() or {}).get("eps", {}))
    added = updated = 0
    for code, e in list(a.items()) + list(b.items()):
        cur = merged.get(code)
        if cur is None:
            merged[code] = e; added += 1
        elif (e["y"], e["q"]) > (cur["y"], cur["q"]):
            merged[code] = e; updated += 1

    from collections import Counter
    dist = Counter((e["y"], e["q"]) for e in merged.values())
    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "note": ("cum 為該公司當年度累計基本每股盈餘（非單季）；"
                 "年化 EPS = cum ÷ q × 4。各公司申報進度不同，本檔逐次累積。"),
        "count": len(merged),
        "periods": {"%d/%d" % k: v for k, v in sorted(dist.items(), reverse=True)},
        "eps": merged,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "quarterly.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔，新增 %d、更新 %d，%.1f KB）==" % (
        path, len(merged), added, updated, os.path.getsize(path) / 1024))
    print("   期別分佈:", dict(list(out["periods"].items())[:6]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
