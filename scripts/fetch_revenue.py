#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""收集每月營業收入，輸出 data/revenue.json。

為什麼要月營收
--------------
台股規定每月 10 日前公布上月營收，是**最即時**的基本面資料 —— 比季報快
約 35 天（季報要等季末後 45 天）。獲利動能出現轉折時，月營收會先反映，
近四季 EPS 甚至當季季報都還看不出來。

前端用它推估全年獲利：

    推估年營收 = 當年累計營收 ÷ 已過月數 × 12
    推估年 EPS = 推估年營收 × (季報累計 EPS ÷ 季報累計營收)

括號裡那項是「每一元營收貢獻多少每股盈餘」，由季報反推，因此不需要
知道股數，也自動涵蓋了稅率與業外損益的平均水準。

金融保險業沒有可比的營收概念（是利息淨收益），這類公司不會出現在
彙總表中，前端對它們會標示此法不適用。

資料來源
--------
上市 https://openapi.twse.com.tw/v1/opendata/t187ap05_L
上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O
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

SOURCES = [
    ("上市", "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"),
    ("上櫃", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"),
]


def fetch_json(url, retries=3, timeout=60):
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
    print("  ! 取得失敗 %s" % url, file=sys.stderr)
    return None


def fnum(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def main():
    out = {}
    for market, url in SOURCES:
        rows = fetch_json(url)
        if not rows:
            print("   %s 無資料" % market)
            continue
        n = 0
        for r in rows:
            code = str(r.get("公司代號", "")).strip()
            if len(code) != 4 or not code.isdigit():
                continue
            ym = str(r.get("資料年月", "")).strip()
            cum = fnum(r.get("累計營業收入-當月累計營收"))
            if len(ym) != 5 or not cum or cum <= 0:
                continue
            month = int(ym[3:5])
            if not 1 <= month <= 12:
                continue
            out[code] = {
                "ym": ym,
                "mo": month,                                   # 已過月數
                "cum": round(cum, 2),                          # 當年累計營收（千元）
                "mon": fnum(r.get("營業收入-當月營收")),          # 當月營收
                "yoy": fnum(r.get("累計營業收入-前期比較增減(%)")),  # 累計年增率
                "yoyM": fnum(r.get("營業收入-去年同月增減(%)")),    # 當月年增率
                "m": market,
            }
            n += 1
        print("   %s %4d 筆" % (market, n))

    if not out:
        print("兩個來源都失敗，保留既有 data/revenue.json 不覆蓋。", file=sys.stderr)
        return 1

    from collections import Counter
    dist = Counter(v["ym"] for v in out.values())
    payload = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "note": ("cum 為當年度累計營收（千元），mo 為已過月數；"
                 "推估年營收 = cum ÷ mo × 12。金融保險業不在此表。"),
        "count": len(out),
        "months": dict(sorted(dist.items(), reverse=True)),
        "rev": out,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "revenue.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔，%.1f KB）==" % (
        path, len(out), os.path.getsize(path) / 1024))
    print("   年月分佈:", dict(list(payload["months"].items())[:4]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
