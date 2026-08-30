#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取美股估價所需的公開資料，輸出 data/us.json 與 data/us_fin.json。

台股版的每股數字是「反推」來的 —— 交易所直接公布本益比、股價淨值比與
殖利率，除一除就得到 EPS、每股淨值與股利。美國沒有這種官方統計，
所以這支程式改成正面計算：財報數字取自 SEC，股價取自那斯達克，
每股指標由兩者相除。

資料來源（皆為公開、免金鑰）
--------------------------
財報 SEC EDGAR XBRL frames API
     https://data.sec.gov/api/xbrl/frames/us-gaap/<概念>/<單位>/<期間>.json
     一次回傳「全體申報公司」在該期間的某個會計科目，所以整個市場的
     季報與年報只要幾十次請求就抓得完，不必逐檔查詢。
     依 SEC 規定，User-Agent 必須帶可聯絡的識別資訊。
代號 https://www.sec.gov/files/company_tickers_exchange.json
     股票代號 → CIK（SEC 公司編號）與掛牌交易所。
股價 https://api.nasdaq.com/api/screener/stocks
     那斯達克官網選股器，一次回傳全美掛牌約 7,000 檔的收盤價、
     市值、產業別。盤後更新，非即時報價。

TTM（近四季）怎麼算
------------------
XBRL 的季度資料有一個結構性缺口：公司的**會計年度第四季通常不會單獨
標記**，年報只揭露全年數字，Q4 要用「全年 − 前三季」才推得出來。
直接把四個日曆季相加，大部分公司會少一季。

所以這裡改用會計年度重建：

    近四季 = 最近完整會計年度 + 該年度結束後的累計 − 去年同期累計

每家公司的會計年度結束日不同（蘋果 9 月、輝達 1 月、微軟 6 月），
frames API 會把各公司的年報對應到最接近的日曆年標籤，因此年度值可以
直接取用；「年度結束後的季別」則由結束日推算，避免把年度內的季度重複計入。
"""

import json
import os
import re
import ssl
import sys
import time
import urllib.request
import gzip
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
NY = timezone(timedelta(hours=-4))     # 美東（估個大概，只用來標記更新時間）

# SEC 的存取規範要求 User-Agent 帶得到聯絡方式。這裡從環境變數讀，
# 不把個人 email 寫進原始碼 —— 這是公開 repo，寫死等於把信箱送給爬蟲。
#
#   本機：  SEC_CONTACT="you@example.com" python3 scripts/fetch_us.py
#   Actions：在 repo 的 Settings → Secrets and variables 設 SEC_CONTACT，
#            workflow 已經把它帶進來了。
#
# 沒設也能跑（實測 SEC 目前不會擋），但流量就是匿名的，對方要限流時
# 沒辦法通知你。另外注意 UA 裡不能放網址，SEC 的防護會直接回 403。
SEC_CONTACT = os.environ.get("SEC_CONTACT", "").strip()
SEC_UA = "stock-fair-value/1.0" + (" " + SEC_CONTACT if SEC_CONTACT else "")
WEB_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

SCREENER = ("https://api.nasdaq.com/api/screener/stocks"
            "?tableonly=false&limit=25000&offset=0&download=true")
QUOTE_INFO = "https://api.nasdaq.com/api/quote/%s/info?assetclass=stocks"
TICKERS = "https://www.sec.gov/files/company_tickers_exchange.json"
FRAMES = "https://data.sec.gov/api/xbrl/frames/%s/%s/%s/%s.json"

# 只收在正規交易所掛牌的普通股，與台股版「只留普通股」的原則一致
KEEP_EXCHANGES = {"Nasdaq", "NYSE", "CBOE"}
# 特別股、認股權證、SPAC 單位、存託憑證單位等不是普通股
NOT_COMMON = re.compile(
    r"\b(warrant|warrants|unit|units|right|rights|preferred|depositary|"
    r"debenture|note|notes|bond|trust preferred|subordinated)\b", re.I)


# ══════════════════════════════════════════════════════════
#  HTTP
# ══════════════════════════════════════════════════════════
def fetch(url, ua=SEC_UA, retries=3, timeout=90, referer=None):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    headers = {"User-Agent": ua, "Accept": "application/json",
               "Accept-Encoding": "gzip", "Accept-Language": "en-US,en;q=0.9"}
    if referer:
        headers["Referer"] = referer
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8-sig"))
        except Exception as e:  # noqa: BLE001 - 外部來源，任何錯誤都重試
            last = e
            time.sleep(1.5 + i * 3)
    print("  ! 取得失敗 %s (%s)" % (url[:96], last), file=sys.stderr)
    return None


def num(v):
    if v is None:
        return None
    s = str(v).replace(",", "").replace("$", "").replace("%", "").strip()
    if s in ("", "-", "--", "N/A", "null", "NA"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ══════════════════════════════════════════════════════════
#  日曆季工具
# ══════════════════════════════════════════════════════════
def quarter_end(period):
    """'CY2026Q2' -> date(2026, 6, 30)；'CY2025' -> date(2025, 12, 31)。"""
    m = re.fullmatch(r"CY(\d{4})(?:Q([1-4]))?I?", period)
    if not m:
        return None
    y = int(m.group(1))
    q = int(m.group(2)) if m.group(2) else 4
    return date(y, [3, 6, 9, 12][q - 1], [31, 30, 30, 31][q - 1])


def recent_quarters(n, today=None):
    """回傳最近 n 個已結束的日曆季標籤，由舊到新。"""
    t = today or datetime.now(NY).date()
    y, q = t.year, (t.month - 1) // 3 + 1
    q -= 1                       # 當季還沒結束
    if q == 0:
        y, q = y - 1, 4
    out = []
    for _ in range(n):
        out.append("CY%dQ%d" % (y, q))
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    return list(reversed(out))


# ══════════════════════════════════════════════════════════
#  SEC frames
# ══════════════════════════════════════════════════════════
def frame(concept, unit, period, taxonomy="us-gaap"):
    """回傳 {cik: (值, 期間結束日)}；抓不到就空的。"""
    j = fetch(FRAMES % (taxonomy, concept, unit, period))
    out = {}
    for r in (j or {}).get("data", []):
        v = r.get("val")
        if v is None:
            continue
        out[r["cik"]] = (float(v), r.get("end"))
    return out


def series(concept, unit, quarters, years, taxonomy="us-gaap"):
    """抓同一個會計科目的多個期間，回傳 {期間: {cik: (值, 結束日)}}。"""
    out = {}
    for p in list(years) + list(quarters):
        out[p] = frame(concept, unit, p, taxonomy)
        print("     %-9s n=%d" % (p, len(out[p])))
        time.sleep(0.25)          # SEC 建議每秒不超過 10 次請求
    return out


def instant(concept, unit, quarters, taxonomy="us-gaap"):
    """時點型科目（股東權益等）：由新到舊找第一個有值的期間。"""
    out = {}
    for p in reversed(quarters):
        got = frame(concept, unit, p + "I", taxonomy)
        print("     %-9s n=%d" % (p + "I", len(got)))
        for cik, v in got.items():
            out.setdefault(cik, v)   # 先填到的是較新的期間
        time.sleep(0.25)
    return out


# ══════════════════════════════════════════════════════════
#  近四季重建
# ══════════════════════════════════════════════════════════
def rebuild(cik, ann, qs, quarters):
    """把年報與季報拼成 {fy, fy_label, fy_end, ytd, ytd_n, ttm, ttm_exact}。

    ann：{期間: {cik: (值, 結束日)}} 的年度資料
    qs ：同結構的季度資料
    """
    # 1. 最近一個有申報的會計年度（frames 已把各公司年報對應到最接近的日曆年）
    fy = fy_label = fy_end = None
    for p in sorted(ann.keys(), reverse=True):
        hit = ann[p].get(cik)
        if hit:
            fy, fy_end, fy_label = hit[0], hit[1], p
            break
    if fy is None:
        return None
    try:
        fe = datetime.strptime(fy_end, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None

    # 2. 會計年度結束後的季別。容忍 45 天：季末落在年度結束日之後 45 天以上，
    #    才算是新年度的季（否則會把年度內的最後一季重複計入）。
    after = [p for p in quarters
             if quarter_end(p) and quarter_end(p) > fe + timedelta(days=45)]
    after.sort()

    # 只取「從新年度第一季起連續有值」的部分，中間斷掉就停 —— 累計數必須連續
    ytd, ytd_n = 0.0, 0
    for p in after:
        hit = qs.get(p, {}).get(cik)
        if not hit:
            break
        ytd += hit[0]
        ytd_n += 1

    # 3. 近四季 = 最近完整年度 + 本年度累計 − 去年同期累計
    ttm, exact = fy, (ytd_n == 0)
    if ytd_n:
        prev = 0.0
        ok = True
        for p in after[:ytd_n]:
            m = re.fullmatch(r"CY(\d{4})Q([1-4])", p)
            back = "CY%dQ%s" % (int(m.group(1)) - 1, m.group(2))
            hit = qs.get(back, {}).get(cik)
            if not hit:
                ok = False
                break
            prev += hit[0]
        if ok:
            ttm, exact = fy + ytd - prev, True
        else:
            ttm, exact = fy, False   # 去年同期缺季，退回用整個會計年度

    return {"fy": fy, "fyl": fy_label, "fye": fy_end,
            "ytd": ytd if ytd_n else None, "ytdn": ytd_n,
            "ytdl": after[ytd_n - 1] if ytd_n else None,
            "ttm": ttm, "exact": exact}


def pick_tag(cik, ann, qtr, quarters, years):
    """同一家公司在不同期間可能改用不同的會計科目（營收、股利都有這個問題），
    混用會前後不一致。
    這裡挑「涵蓋期間最多」的那個科目，整組只用它；沒有年度值就不算數 ——
    近四季的重建以年度為基礎。"""
    best, best_n = None, 0
    for name in ann:
        if not any(ann[name].get(p, {}).get(cik) for p in years):
            continue
        n = (sum(1 for p in years if ann[name].get(p, {}).get(cik)) +
             sum(1 for p in quarters if qtr[name].get(p, {}).get(cik)))
        if n > best_n:
            best, best_n = name, n
    return best


# ══════════════════════════════════════════════════════════
#  百分位（產業基準用）
# ══════════════════════════════════════════════════════════
def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    i = (len(sorted_vals) - 1) * p
    lo, hi = int(i), min(int(i) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)


def sector_stats(rows):
    """各產業當前 P/E、P/B、P/S、殖利率的 P20 / P50 / P80。

    台股版用的是「該股自己近 5 年的評價區間」，那是時間序列；美股版拿不到
    等量的歷史（要逐檔抓五年股價），所以改提供橫斷面的同業當前分布 ——
    兩者都是客觀統計，但意義不同，前端必須講清楚。
    """
    buckets = {}
    for r in rows:
        s = r.get("sec")
        if not s:
            continue
        b = buckets.setdefault(s, {"pe": [], "pb": [], "ps": [], "pfcf": [], "y": [], "n": 0})
        b["n"] += 1
        # 極端值會把分位數拉走：本益比 200 倍以上、殖利率 25% 以上多半是
        # 一次性損益或資料錯誤，統計時排除（個股頁仍照實顯示）
        if r.get("pe") and 0 < r["pe"] <= 200:
            b["pe"].append(r["pe"])
        if r.get("pb") and 0 < r["pb"] <= 50:
            b["pb"].append(r["pb"])
        if r.get("ps") and 0 < r["ps"] <= 50:
            b["ps"].append(r["ps"])
        if r.get("pfcf") and 0 < r["pfcf"] <= 200:
            b["pfcf"].append(r["pfcf"])
        if r.get("y") and 0 < r["y"] <= 25:
            b["y"].append(r["y"])
    out = {}
    for name, b in buckets.items():
        e = {"n": b["n"]}
        for k in ("pe", "pb", "ps", "pfcf", "y"):
            v = sorted(b[k])
            # 樣本太少的分位數沒有意義
            if len(v) >= 12:
                e[k] = [round(pct(v, q), 3) for q in (0.2, 0.5, 0.8)]
                e[k + "n"] = len(v)
        out[name] = e
    return out


# ══════════════════════════════════════════════════════════
#  主流程
# ══════════════════════════════════════════════════════════
def load_existing(name):
    """讀取上一次的結果，作為來源異常時的比對基準。"""
    try:
        with open(os.path.join(OUT_DIR, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_universe():
    """那斯達克選股器 × SEC 代號對照，取交集當作收錄範圍。"""
    print("== 取得全美掛牌收盤價（Nasdaq screener）==")
    j = fetch(SCREENER, ua=WEB_UA, referer="https://www.nasdaq.com/")
    rows = ((j or {}).get("data") or {}).get("rows") or []
    print("   螢幕器回傳 %d 檔" % len(rows))

    print("== 取得代號 → CIK 對照（SEC）==")
    t = fetch(TICKERS)
    tmap = {}
    for cik, name, ticker, ex in (t or {}).get("data", []):
        tmap[str(ticker).strip().upper()] = (cik, name, ex)
    print("   %d 個代號" % len(tmap))
    if not rows or not tmap:
        return [], None

    out, seen = [], set()
    for r in rows:
        sym = str(r.get("symbol", "")).strip().upper()
        # 那斯達克用 BRK/B 表示股別、ABR^D 表示特別股；SEC 用 BRK-B
        if "^" in sym:
            continue
        sym = sym.replace("/", "-")
        if not re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", sym) or sym in seen:
            continue
        name = str(r.get("name", "")).strip()
        if NOT_COMMON.search(name):
            continue
        hit = tmap.get(sym)
        if not hit:
            continue
        cik, sec_name, ex = hit
        if ex not in KEEP_EXCHANGES:
            continue
        price = num(r.get("lastsale"))
        if not price or price <= 0:
            continue
        seen.add(sym)
        # 「Apple Inc. Common Stock」→「Apple Inc.」，名稱後綴對搜尋沒有幫助
        short = re.sub(r"\s+(Common Stock|Class [A-Z]|Ordinary Shares|"
                       r"American Depositary Shares?)\b.*$", "", name).strip(" ,.")
        out.append({
            "c": sym, "n": short or name, "cik": cik,
            "m": ex, "p": round(price, 4),
            "mc": num(r.get("marketCap")) or None,   # 之後換算成百萬
            "sec": (r.get("sector") or "").strip() or None,
            "ind": (r.get("industry") or "").strip() or None,
            # 註冊在美國以外的公司多半以 20-F／IFRS 申報，SEC 的 XBRL 彙總表
            # 不涵蓋，前端要據此說明「查不到財報」的原因
            "co": (r.get("country") or "").strip() or None,
        })
    print("   收錄 %d 檔（交易所掛牌普通股 × 有 CIK）" % len(out))
    return out, rows


def trade_date():
    """選股器沒有帶資料日期，用單檔報價端點問一次。"""
    j = fetch(QUOTE_INFO % "AAPL", ua=WEB_UA, referer="https://www.nasdaq.com/")
    ts = (((j or {}).get("data") or {}).get("primaryData") or {}).get("lastTradeTimestamp")
    if not ts:
        return None
    m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})", str(ts))
    if not m:
        return None
    try:
        return datetime.strptime("%s %s %s" % m.groups(), "%b %d %Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def main():
    stocks, _ = load_universe()
    if not stocks:
        print("取不到股價或代號對照，保留既有檔案不覆蓋。", file=sys.stderr)
        return 1
    ciks = {s["cik"] for s in stocks}

    quarters = recent_quarters(8)
    years = ["CY%d" % (int(quarters[-1][2:6]) - i) for i in (2, 1, 0)]
    print("== SEC 財報期間 ==")
    print("   年度 %s" % " ".join(years))
    print("   季別 %s" % " ".join(quarters))

    print("== 每股盈餘（稀釋後）==")
    eps_a = series("EarningsPerShareDiluted", "USD-per-shares", [], years)
    eps_q = series("EarningsPerShareDiluted", "USD-per-shares", quarters, [])

    print("== 淨利 ==")
    ni_a = series("NetIncomeLoss", "USD", [], years)
    ni_q = series("NetIncomeLoss", "USD", quarters, [])

    print("== 營收（兩個科目，逐檔挑涵蓋較完整的）==")
    rev_a, rev_q = {}, {}
    for tag in ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"):
        print("   %s" % tag)
        rev_a[tag] = series(tag, "USD", [], years)
        rev_q[tag] = series(tag, "USD", quarters, [])

    # 自由現金流。台股版的第九種公式是「月營收動能法」—— 台灣規定每月 10 日前
    # 公布上月營收，比季報快約 35 天；美國沒有月營收制度，硬套只會得到與
    # 「年化 EPS」完全相同的數字（推導後會消掉），所以那一格改放美股拿得到、
    # 而且其他八種公式都看不到的東西：自由現金流。
    #
    #   自由現金流 = 營業活動現金流 − 資本支出
    #
    # 現金流量表在美國是以「年初至今累計」申報，frames 只建立 3 個月與 12 個月
    # 的期間，半年、九個月的累計值不在任何 frame 裡，因此近四季無法穩定重建 ——
    # 這裡只取「最近一個完整會計年度」，前端必須照實標明期間。
    print("== 營業活動現金流與資本支出（年度）==")
    ocf_a = series("NetCashProvidedByUsedInOperatingActivities", "USD", [], years)
    capex_a = series("PaymentsToAcquirePropertyPlantAndEquipment", "USD", [], years)

    print("== 股東權益（時點）==")
    equity = instant("StockholdersEquity", "USD", quarters[-4:])
    equity2 = instant(
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        "USD", quarters[-4:])

    # 每股現金股利有兩個常用科目，各家挑一個用（可口可樂、實現收益等
    # 大型配息股只申報 CashPaid，只抓 Declared 會漏掉一半以上）；
    # 兩者都沒有時，再用現金流量表的「支付普通股股利」除以股數推算。
    print("== 每股現金股利 ==")
    dps_a, dps_q = {}, {}
    for tag in ("CommonStockDividendsPerShareDeclared",
                "CommonStockDividendsPerShareCashPaid"):
        print("   %s" % tag)
        dps_a[tag] = series(tag, "USD-per-shares", [], years)
        dps_q[tag] = series(tag, "USD-per-shares", quarters, [])
    print("   PaymentsOfDividendsCommonStock（備援）")
    pay_a = series("PaymentsOfDividendsCommonStock", "USD", [], years)
    pay_q = series("PaymentsOfDividendsCommonStock", "USD", quarters, [])

    # ── 逐檔組裝 ──────────────────────────────────────────
    print("== 組裝 ==")
    fin, kept = {}, []
    for s in stocks:
        cik = s["cik"]
        p, mc = s["p"], s["mc"]
        # 股數由市值 ÷ 股價反推。這樣得到的是「以本股別計價的全公司股數」，
        # 雙重股權（BRK-A / BRK-B）兩邊都會換算成一致的口徑。
        sh = (mc / p) if (mc and mc > 0 and p) else None

        e = rebuild(cik, eps_a, eps_q, quarters)
        n = rebuild(cik, ni_a, ni_q, quarters)
        tag = pick_tag(cik, rev_a, rev_q, quarters, years)
        r = rebuild(cik, rev_a[tag], rev_q[tag], quarters) if tag else None
        dtag = pick_tag(cik, dps_a, dps_q, quarters, years)
        d = rebuild(cik, dps_a[dtag], dps_q[dtag], quarters) if dtag else None
        if not d:
            pd = rebuild(cik, pay_a, pay_q, quarters)
            if pd and sh and pd["ttm"]:
                d = dict(pd, ttm=pd["ttm"] / sh)

        # 自由現金流只取同一個會計年度的營業現金流與資本支出，年度不同就不算
        fcf = fcfl = None
        for yp in sorted(ocf_a.keys(), reverse=True):
            o = ocf_a[yp].get(cik)
            if not o:
                continue
            cx = capex_a.get(yp, {}).get(cik)
            if cx is None:
                break
            fcf, fcfl = o[0] - cx[0], yp
            break

        eq = equity.get(cik) or equity2.get(cik)
        s["bvps"] = round(eq[0] / sh, 4) if (eq and sh and eq[0] > 0) else None
        s["eqd"] = eq[1] if eq else None

        # 近四季每股盈餘。SEC 的 EPS 是公司自己申報的，雙重股權公司偶爾
        # 只標其中一個股別，與市值反推的股數對不起來；差距過大時改用
        # 淨利 ÷ 股數，兩者都沒有才留空。
        eps = e["ttm"] if e else None
        if eps and n and n["ttm"] and sh:
            alt = n["ttm"] / sh
            if alt and abs(eps) > 0 and not (0.5 <= abs(eps / alt) <= 2.0):
                eps, s["epsalt"] = round(alt, 4), True
        elif not eps and n and n["ttm"] and sh:
            eps, s["epsalt"] = round(n["ttm"] / sh, 4), True
        s["eps"] = round(eps, 4) if eps is not None else None

        # 金額一律換算成百萬美元再存：原始值是 12 位數整數，
        # 直接寫進 JSON 會讓檔案大將近一倍，而前端顯示時本來就要換算。
        mil = lambda v: round(v / 1e6, 2) if v is not None else None  # noqa: E731
        s["ni"] = mil(n["ttm"]) if n and n["ttm"] is not None else None
        s["rev"] = mil(r["ttm"]) if r and r["ttm"] is not None else None
        s["eq"] = mil(eq[0]) if eq else None
        s["sh"] = mil(sh) if sh else None

        # 每股現金股利：優先用近四季重建值，年度值作備援
        dps = d["ttm"] if d else None
        s["d"] = round(dps, 4) if (dps and dps > 0) else None

        # 每股指標（與台股版同一組定義，只是方向相反 —— 台股是由比率反推
        # 每股數字，這裡是由每股數字算出比率）
        # 比率一律由「已四捨五入後存進 JSON 的每股數字」算回來，不要用未捨入的
        # 中間值 —— 頁面上會把推導過程整列出來讓使用者核對，若比率是用更精確的
        # 數字算的，畫面上的算式自己對不起來（每股營收極小的公司差到 0.4%）。
        rev_raw = r["ttm"] if (r and r["ttm"] is not None) else None
        s["sps"] = round(rev_raw / sh, 4) if (rev_raw and sh and rev_raw > 0) else None
        s["fcf"] = round(fcf / 1e6, 2) if fcf is not None else None
        s["fcfps"] = round(fcf / sh, 4) if (fcf and sh and fcf > 0) else None
        s["fcfl"] = fcfl if fcf is not None else None

        s["pe"] = round(p / s["eps"], 3) if (s["eps"] and s["eps"] > 0) else None
        s["pb"] = round(p / s["bvps"], 3) if (s["bvps"] and s["bvps"] > 0) else None
        s["ps"] = round(p / s["sps"], 3) if s["sps"] else None
        s["pfcf"] = round(p / s["fcfps"], 3) if s["fcfps"] else None
        s["roe"] = round(s["ni"] / s["eq"] * 100, 2) if (s["ni"] and s["eq"] and s["eq"] > 0) else None
        s["y"] = round(s["d"] / p * 100, 3) if s["d"] else None
        s["fq"] = (e["ytdl"] if e and e["ytdl"] else (e["fyl"] if e else None))

        # 供前端做「年化」「成長率」「營收動能」的明細，另存一檔
        rec = {}
        if e:
            rec["e"] = {"fy": round(e["fy"], 4), "fyl": e["fyl"], "fye": e["fye"],
                        "ytd": round(e["ytd"], 4) if e["ytd"] is not None else None,
                        "n": e["ytdn"], "l": e["ytdl"], "x": 1 if e["exact"] else 0}
            prev = None
            for p2 in sorted(eps_a.keys(), reverse=True):
                if p2 < e["fyl"] and eps_a[p2].get(cik):
                    prev = eps_a[p2][cik][0]
                    break
            if prev is not None:
                rec["e"]["pfy"] = round(prev, 4)
        if r:
            rec["r"] = {"fy": round(r["fy"] / 1e6, 2), "fyl": r["fyl"],
                        "ytd": round(r["ytd"] / 1e6, 2) if r["ytd"] is not None else None,
                        "n": r["ytdn"], "l": r["ytdl"]}
        if rec:
            fin[s["c"]] = rec

        s["mc"] = round(mc / 1e6, 1) if mc else None
        s.pop("cik", None)
        if s.get("co") == "United States":
            s["co"] = None          # 預設就是美國，不必每檔都存
        kept.append(s)

    # 空值不必寫進 JSON，檔案小一半
    for s in kept:
        for k in [k for k, v in s.items() if v is None]:
            del s[k]

    kept.sort(key=lambda x: x["c"])

    # SEC 若整批失敗（維護、限流、改版），上面照樣會產出一份「有股價、
    # 沒有任何財報」的檔案，覆蓋掉昨天的好資料。這裡拿既有檔案比一下，
    # 財報涵蓋率掉超過一半就不覆蓋 —— 與台股版「一邊失敗就沿用上次」同理。
    with_eps = sum(1 for x in kept if x.get("eps"))
    old = load_existing("us.json")
    if old:
        prev = sum(1 for x in old.get("stocks", []) if x.get("eps"))
        if prev and with_eps < prev * 0.5:
            print("財報涵蓋率由 %d 檔掉到 %d 檔，判定為來源異常，"
                  "保留既有 data/us.json 不覆蓋。" % (prev, with_eps), file=sys.stderr)
            return 1

    td = trade_date()
    out = {
        "updated_at": datetime.now(NY).strftime("%Y-%m-%d %H:%M:%S-04:00"),
        "trade_date": td,
        "count": len(kept),
        "periods": {"quarters": quarters, "years": years},
        "source": ["SEC EDGAR XBRL frames API", "Nasdaq Stock Screener"],
        "sectors": sector_stats(kept),
        "stocks": kept,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, payload in (("us.json", out),
                          ("us_fin.json", {"updated_at": out["updated_at"], "fin": fin})):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        print("== 已寫入 %s（%.1f KB）==" % (path, os.path.getsize(path) / 1024))

    have = lambda k: sum(1 for s in kept if s.get(k))  # noqa: E731
    print("   收盤日 %s ／ %d 檔" % (td, len(kept)))
    print("   EPS %d ｜ 每股淨值 %d ｜ 營收 %d ｜ 股利 %d ｜ ROE %d ｜ 自由現金流 %d"
          % (have("eps"), have("bvps"), have("rev"), have("d"), have("roe"), have("fcfps")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
