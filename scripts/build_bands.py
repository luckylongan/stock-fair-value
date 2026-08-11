#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""建立各股歷史評價區間（本益比 / 股價淨值比 / 殖利率的百分位），輸出 data/bands.json。

作法：向 TWSE 抓取過去 N 年、每月數個交易日的「全市場」快照
（一次請求就涵蓋上千檔），再算出每檔股票的 P20 / P50 / P80。
估價頁用這些分位數當作「便宜 / 合理 / 昂貴」的倍數依據，
比固定倍數（例如一律 15 倍本益比）更貼近該股自身的歷史評價。

上櫃（TPEx）無對等的歷史全市場 API，會由每日快照逐步累積；
在累積足夠之前，上櫃股票於前端自動改用固定倍數估價。

用法：
    python3 scripts/build_bands.py            # 預設回溯 5 年
    python3 scripts/build_bands.py --years 3
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
TPE = timezone(timedelta(hours=8))
MIN_SAMPLES = 8  # 樣本太少的分位數沒有意義


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
            time.sleep(2 + i * 3)
    return None


def num(v):
    s = str(v).replace(",", "").strip()
    if s in ("", "-", "--", "N/A"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f > 0 else None


def sample_dates(years):
    """回溯 N 年，每月取 3 個取樣日（月初 / 月中 / 月底附近）。"""
    today = datetime.now(TPE).date()
    out = []
    y, m = today.year, today.month
    for _ in range(years * 12 + 1):
        for day in (8, 18, 26):
            d = date(y, m, day)
            if d <= today:
                out.append(d)
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return sorted(set(out))


def percentile(sorted_vals, q):
    """線性插值百分位（q 為 0~1）。"""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * q
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def trim(vals, lo_q=0.02, hi_q=0.98):
    """去掉極端離群值（虧損轉盈時本益比常出現數百倍的雜訊）。"""
    vals = sorted(vals)
    if len(vals) < 10:
        return vals
    a = int(len(vals) * lo_q)
    b = max(a + 1, int(len(vals) * hi_q))
    return vals[a:b]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=5, help="回溯年數（預設 5）")
    args = ap.parse_args()

    dates = sample_dates(args.years)
    print("== 取樣 %d 個日期（約 %d 年）==" % (len(dates), args.years))

    # code -> {"pe": [...], "pb": [...], "y": [...]}
    acc = {}
    names = {}
    ok_days = 0

    for i, d in enumerate(dates, 1):
        if d.weekday() >= 5:
            continue
        ds = d.strftime("%Y%m%d")
        url = ("https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d"
               "?date=%s&selectType=ALL&response=json" % ds)
        j = fetch_json(url)
        if not j or j.get("stat") != "OK" or not j.get("data"):
            print("  [%3d/%3d] %s 無資料" % (i, len(dates), ds))
            time.sleep(0.8)
            continue

        ok_days += 1
        for r in j["data"]:
            code = str(r[0]).strip()
            if len(code) != 4 or not code.isdigit():
                continue
            names[code] = str(r[1]).strip()
            e = acc.setdefault(code, {"pe": [], "pb": [], "y": []})
            v = num(r[5])
            if v and v < 300:      # 本益比 >300 視為雜訊
                e["pe"].append(v)
            v = num(r[6])
            if v and v < 50:       # 股價淨值比 >50 視為雜訊
                e["pb"].append(v)
            v = num(r[3])
            if v and v < 30:       # 殖利率 >30% 多為一次性配發
                e["y"].append(v)
        print("  [%3d/%3d] %s ✓ %d 檔" % (i, len(dates), ds, len(j["data"])))
        time.sleep(0.8)  # 對來源禮貌一點，避免被限流

    if ok_days < 4:
        print("有效取樣日太少（%d），不覆蓋既有 bands.json" % ok_days, file=sys.stderr)
        return 1

    bands = {}
    for code, e in acc.items():
        entry = {}
        for key in ("pe", "pb", "y"):
            vals = trim(e[key])
            if len(vals) >= MIN_SAMPLES:
                entry[key] = [round(percentile(vals, q), 3) for q in (0.2, 0.5, 0.8)]
                entry[key + "n"] = len(vals)
        if entry:
            bands[code] = entry

    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "years": args.years,
        "sample_days": ok_days,
        "percentiles": [20, 50, 80],
        "note": "pe/pb/y 各為 [P20, P50, P80]；僅涵蓋上市（TWSE）股票",
        "bands": bands,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "bands.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔 / %d 個取樣日，%.1f KB）==" % (
        path, len(bands), ok_days, os.path.getsize(path) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
