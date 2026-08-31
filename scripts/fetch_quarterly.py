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
1) 交易所 OpenAPI（最新一期，格式乾淨但只有已申報最新季的公司）
   上市 https://openapi.twse.com.tw/v1/opendata/t187ap06_L_<業別>
   上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_<業別>

2) 公開資訊觀測站 t163sb04（可指定年度／季別，涵蓋全市場）
   https://mopsov.twse.com.tw/mops/web/ajax_t163sb04

只靠 (1) 的話，季報剛開始申報時涵蓋率很低（例如 Q2 截止前只有三成公司
送件），還沒送 Q2 的公司就完全沒有資料。因此再用 (2) 逐季回補：
先抓較舊的季別，再讓較新的覆蓋，每檔股票最後保留它自己最新的一期。

兩個來源的「基本每股盈餘（元）」都是<當年度累計>，不是單季 —— 已用實際
資料與交易所近四季 EPS 交叉比對確認（比值集中在 0.5 附近，即 Q2 為上半年）。

各公司申報時間不同，因此本檔採累積方式：只在「年度／季別比既有的新」時覆蓋。
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
            rev = fnum(r.get("營業收入"))
            net = next((fnum(r[k]) for k in r
                        if k.startswith("淨利") and "歸屬於母公司業主" in k), None)
            # 毛利取「淨額」版（已沖銷未實現／已實現銷貨損益）；沒有就退回未沖銷的
            gp = next((fnum(r[k]) for k in r
                       if k.startswith("營業毛利") and "淨額" in k), None)
            if gp is None:
                gp = next((fnum(r[k]) for k in r if k.startswith("營業毛利")), None)
            op = next((fnum(r[k]) for k in r if k.startswith("營業利益")), None)
            key = (int(y), int(q))
            cur = out.get(code)
            if cur is None or key > (cur["y"], cur["q"]):
                out[code] = {"y": int(y), "q": int(q), "cum": round(eps, 4),
                             "rev": round(rev, 2) if rev and rev > 0 else None,
                             "ni": round(net, 2) if net else None,
                             "gp": round(gp, 2) if gp is not None else None,
                             "op": round(op, 2) if op is not None else None,
                             "m": market}
                n += 1
        print("   %-6s %4d 筆" % (sec, n))
        time.sleep(0.3)
    return out


MOPS_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t163sb04"


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
        except Exception:  # noqa: BLE001
            time.sleep(2 + i * 3)
    return None


def strip_tags(s):
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ").strip()


def parse_mops(page):
    """從 t163sb04 的 HTML 取出 {代號: {eps, rev}}。

    回傳頁面依產業拆成好幾張表，各表欄位數不同，所以逐表用表頭定位欄位，
    而不是寫死索引。金融保險業沒有「營業收入」（是利息淨收益），rev 會是 None。
    """
    out = {}
    for tbl in re.findall(r"<table[^>]*>.*?</table>", page, re.S):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tbl, re.S)
        if len(rows) < 2:
            continue
        hdr = [strip_tags(c) for c in
               re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", rows[0], re.S)]
        try:
            ci = hdr.index("公司代號")
        except ValueError:
            continue
        # 要「基本每股盈餘」，不要「稀釋每股盈餘」
        ei = next((j for j, h in enumerate(hdr) if h.startswith("基本每股盈餘")), None)
        if ei is None:
            continue
        # 精確比對「營業收入」，避開「營業外收入及支出」
        ri = hdr.index("營業收入") if "營業收入" in hdr else None
        # 淨利欄名有「淨利（淨損）歸屬於母公司業主」與「淨利（損）…」兩種寫法
        ni = next((j for j, h in enumerate(hdr)
                   if h.startswith("淨利") and "歸屬於母公司業主" in h), None)
        # 毛利率與營益率用。取「營業毛利（毛損）淨額」而非未沖銷的「營業毛利（毛損）」——
        # 前者已扣除未實現／已實現銷貨損益，跨公司比較才一致。
        # 金融保險業的表沒有這兩欄（他們報的是利息淨收益），會是 None。
        gi = next((j for j, h in enumerate(hdr) if h.startswith("營業毛利") and "淨額" in h), None)
        if gi is None:
            gi = next((j for j, h in enumerate(hdr) if h.startswith("營業毛利")), None)
        oi = next((j for j, h in enumerate(hdr) if h.startswith("營業利益")), None)
        for r in rows[1:]:
            cells = [strip_tags(c) for c in
                     re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)]
            if len(cells) <= max(ci, ei):
                continue
            code = cells[ci]
            if len(code) != 4 or not code.isdigit():
                continue
            eps = fnum(cells[ei])
            if eps is None:
                continue
            rev = fnum(cells[ri]) if (ri is not None and len(cells) > ri) else None
            net = fnum(cells[ni]) if (ni is not None and len(cells) > ni) else None
            gp = fnum(cells[gi]) if (gi is not None and len(cells) > gi) else None
            op = fnum(cells[oi]) if (oi is not None and len(cells) > oi) else None
            out[code] = {"eps": round(eps, 4),
                         "rev": round(rev, 2) if rev and rev > 0 else None,
                         "ni": round(net, 2) if net else None,
                         # 毛利與營業利益可能為負（虧損），不能用 `if x > 0` 過濾
                         "gp": round(gp, 2) if gp is not None else None,
                         "op": round(op, 2) if op is not None else None}
    return out


def collect_mops(year, season, typek, market):
    page = fetch_html(MOPS_URL, {
        "encodeURIComponent": 1, "step": 1, "firstin": 1, "off": 1,
        "isQuery": "Y", "TYPEK": typek, "year": year, "season": "%02d" % season,
    })
    if not page or "每股盈餘" not in page:
        print("   %s %d/Q%d  無資料" % (market, year, season))
        return {}
    rows = parse_mops(page)
    nrev = sum(1 for v in rows.values() if v["rev"])
    print("   %s %d/Q%d  %4d 筆（含營收 %d）" % (market, year, season, len(rows), nrev))
    return {c: {"y": year, "q": season, "cum": v["eps"], "rev": v["rev"],
                "ni": v["ni"], "gp": v["gp"], "op": v["op"], "m": market}
            for c, v in rows.items()}


def load_existing():
    try:
        with open(os.path.join(OUT_DIR, "quarterly.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def recent_periods(n=3):
    """最近 n 個季別（民國年, 季），由舊到新。"""
    now = datetime.now(TPE)
    y, q = now.year - 1911, (now.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        q -= 1
        if q == 0:
            q, y = 4, y - 1
        out.append((y, q))
    return list(reversed(out))


def annual_periods(back=2):
    """過去 n 個年度的 Q4（全年結算），供計算年增率用。"""
    y = datetime.now(TPE).year - 1911
    return [(y - i, 4) for i in range(1, back + 2)]


def main():
    batches = []
    old = load_existing() or {}
    history = {k: dict(v) for k, v in (old.get("history") or {}).items()}

    # 最近三季每天都要抓：公司陸續申報，內容會變
    periods = list(recent_periods(3))
    # 年度基準（Q4 全年）用來算成長率與毛利率趨勢，抓過就不必重抓。
    # 判斷條件看的是「有沒有毛利欄」而不是「有沒有這一期」—— 舊版檔案存的
    # 期別沒有 g/o 兩欄，只檢查 key 在不在會永遠不回補。
    for y, q in annual_periods(2):
        key = "%d/%d" % (y, q)
        if sum(1 for h in history.values() if "g" in (h.get(key) or {})) < 100:
            periods.append((y, q))

    print("== 公開資訊觀測站（逐季回補）==")
    for y, q in periods:
        for typek, market in (("sii", "上市"), ("otc", "上櫃")):
            batches.append(collect_mops(y, q, typek, market))
            time.sleep(1.5)

    # 再用 OpenAPI 蓋上最新一期（格式乾淨、當日即時）
    print("== 交易所 OpenAPI（最新一期）==")
    print("  上市")
    batches.append(collect(TWSE_URL, "上市"))
    print("  上櫃")
    batches.append(collect(TPEX_URL, "上櫃"))

    merged = dict(old.get("eps", {}))
    added = updated = 0
    for code, e in [kv for b in batches for kv in b.items()]:
        # 逐期保存，PEG 需要用歷年同期比較成長率
        h = history.setdefault(code, {})
        rec = {"e": e["cum"]}
        if e.get("rev"):
            rec["r"] = e["rev"]
        if e.get("ni"):
            rec["n"] = e["ni"]
        # 毛利／營業利益：0 與負值都要保留，只有「沒有這一欄」才略過
        if e.get("gp") is not None:
            rec["g"] = e["gp"]
        if e.get("op") is not None:
            rec["o"] = e["op"]
        h["%d/%d" % (e["y"], e["q"])] = rec

        cur = merged.get(code)
        if cur is None:
            merged[code] = e; added += 1
        elif (e["y"], e["q"]) > (cur["y"], cur["q"]):
            merged[code] = e; updated += 1
        elif (e["y"], e["q"]) == (cur["y"], cur["q"]) and (
                (cur.get("rev") is None and e.get("rev") is not None) or
                (cur.get("ni") is None and e.get("ni") is not None) or
                (cur.get("gp") is None and e.get("gp") is not None) or
                (cur.get("op") is None and e.get("op") is not None)):
            # 同一期但補到了營收／淨利（舊版檔案沒有這些欄），一併補上
            merged[code] = e; updated += 1

    # 歷史只留最近 12 期，避免檔案無限膨脹
    for code, h in history.items():
        if len(h) > 12:
            keep = sorted(h, key=lambda k: tuple(int(x) for x in k.split("/")),
                          reverse=True)[:12]
            history[code] = {k: h[k] for k in keep}

    from collections import Counter
    dist = Counter((e["y"], e["q"]) for e in merged.values())
    hdist = Counter(k for h in history.values() for k in h)
    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "note": ("cum 為該公司當年度累計基本每股盈餘（非單季），rev 為累計營業收入、"
                 "ni 為歸屬母公司累計淨利（皆千元，金融保險業無 rev）；"
                 "年化 EPS = cum ÷ q × 4；每股營收 = cum × rev ÷ ni。"
                 "gp 為累計營業毛利淨額、op 為累計營業利益（皆千元，可為負），"
                 "供計算毛利率與營業利益率；金融保險業無此兩欄。"
                 "history 逐期保存，供計算年增率。各公司申報進度不同，本檔逐次累積。"),
        "count": len(merged),
        "periods": {"%d/%d" % k: v for k, v in sorted(dist.items(), reverse=True)},
        "history_periods": dict(sorted(hdist.items(), reverse=True)),
        "eps": merged,
        "history": history,
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
