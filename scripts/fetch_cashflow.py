#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""收集季度營業活動現金流，輸出 data/cashflow.json。

為什麼要單獨抓
--------------
站上原本九種公式全部建立在「盈餘、淨值、營收、股利」四類數字上，沒有任何
一個看現金流。盈餘含折舊攤銷與各種應計項目，可以在不動用現金的情況下被調整；
營業活動現金流是真的收進來的錢，兩者長期背離通常值得追究。

美股頁用的是自由現金流（營業現金流 − 資本支出），台股做不到同一件事：
公開資訊觀測站的彙總現金流量表只有三大活動的合計，**沒有資本支出、也沒有
折舊攤銷**，要拿到得逐檔翻財報附註（幾千次請求）。所以台股這邊改用
「股價營業現金流比（P/OCF）」—— 少扣一段資本支出，但同樣看得到現金。

資料來源
--------
公開資訊觀測站 https://mopsov.twse.com.tw/mops/web/ajax_t163sb20
  參數 TYPEK=sii（上市）/ otc（上櫃），year 民國年，season 01~04。
  回傳依產業拆成好幾張 HTML 表，欄位順序不一，所以逐表用表頭定位。

與 fetch_quarterly.py 同樣是「每天累積」：各公司申報時間不同，一次抓不齊，
所以每次把新抓到的併進既有檔案，各檔保留自己最新的一期。
"""

import html as htmllib
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "cashflow.json")
TPE = timezone(timedelta(hours=8))
MOPS_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t163sb20"


def fetch_html(url, data, retries=3, timeout=90):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    body = urllib.parse.urlencode(data).encode()
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers={
                "User-Agent": UA,
                "Content-Type": "application/x-www-form-urlencoded",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - 外部來源，任何錯誤都重試
            time.sleep(2 + i * 3)
    return None


def strip_tags(s):
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ").strip()


def fnum(v):
    s = str(v).replace(",", "").strip()
    if not s or s in ("-", "--"):
        return None
    # 括號代表負數，現金流出很常見
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        f = float(s)
    except ValueError:
        return None
    return -f if neg else f


def parse(page):
    """取出 {代號: 營業活動之淨現金流入（流出）}，單位為千元。

    每張表的欄位數不同（金融業多很多欄），所以逐表用表頭定位，不寫死索引。
    """
    out = {}
    for tbl in re.findall(r"<table[^>]*>.*?</table>", page, re.S):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tbl, re.S)
        if len(rows) < 2:
            continue
        hdr = [strip_tags(c) for c in
               re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", rows[0], re.S)]
        if "公司代號" not in hdr:
            continue
        ci = hdr.index("公司代號")
        oi = next((j for j, h in enumerate(hdr) if h.startswith("營業活動")), None)
        if oi is None:
            continue
        for r in rows[1:]:
            cells = [strip_tags(c) for c in
                     re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)]
            if len(cells) <= max(ci, oi):
                continue
            code = cells[ci]
            if len(code) != 4 or not code.isdigit():
                continue
            v = fnum(cells[oi])
            if v is not None:
                out[code] = v
    return out


def collect(year, season, typek, market):
    page = fetch_html(MOPS_URL, {
        "encodeURIComponent": 1, "step": 1, "firstin": 1, "off": 1,
        "isQuery": "Y", "TYPEK": typek, "year": year, "season": "%02d" % season,
    })
    if not page or "營業活動" not in page:
        print("   %s %d/Q%d  無資料" % (market, year, season))
        return {}
    rows = parse(page)
    print("   %s %d/Q%d  %4d 筆" % (market, year, season, len(rows)))
    # ocf 存成百萬元，前端顯示時本來就要換算，也讓 JSON 小一點
    return {c: {"y": year, "q": season, "ocf": round(v / 1e3, 2), "m": market}
            for c, v in rows.items()}


def load_existing():
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f).get("cf", {})
    except (OSError, ValueError):
        return {}


def main():
    now = datetime.now(TPE)
    roc = now.year - 1911
    # 從舊季別往新的抓，讓新的覆蓋舊的；季報有 45 天申報期，往回三季夠涵蓋
    targets = []
    y, q = roc, (now.month - 1) // 3 + 1
    for _ in range(4):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        targets.append((y, q))
    targets.reverse()

    print("== 收集營業活動現金流（公開資訊觀測站）==")
    cf = load_existing()
    print("   既有 %d 檔" % len(cf))
    got = 0
    for year, season in targets:
        for typek, market in (("sii", "上市"), ("otc", "上櫃")):
            rows = collect(year, season, typek, market)
            for code, rec in rows.items():
                old = cf.get(code)
                # 只讓「更新的一期」覆蓋，避免舊季別把新的蓋掉
                if not old or (rec["y"], rec["q"]) >= (old["y"], old["q"]):
                    cf[code] = rec
                    got += 1
            time.sleep(0.5)

    if not cf:
        print("一筆都沒抓到，保留既有檔案不覆蓋。", file=sys.stderr)
        return 1

    out = {
        "updated_at": now.strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "count": len(cf),
        "source": "公開資訊觀測站 t163sb20 合併現金流量表",
        "cf": cf,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔，%.1f KB）==" % (OUT, len(cf), os.path.getsize(OUT) / 1024))
    pos = sum(1 for v in cf.values() if v["ocf"] > 0)
    print("   本次更新 %d 筆／營業現金流為正 %d 檔" % (got, pos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
