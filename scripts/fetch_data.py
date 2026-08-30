#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取當日台股（上市 + 上櫃）估價所需資料，輸出 data/latest.json。

資料來源（皆為官方公開 API）：
  上市 TWSE  https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d
             （證券代號/名稱/收盤價/殖利率/股利年度/本益比/股價淨值比/財報年季）
  上櫃 TPEx  https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis
             https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes

這支程式在 GitHub Actions（伺服器端）執行，所以不受瀏覽器 CORS 限制。
"""

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
TPE = timezone(timedelta(hours=8))  # 台北時間


def fetch_json(url, retries=3, timeout=45):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception as e:  # noqa: BLE001 - 網路來源，任何錯誤都重試
            last = e
            time.sleep(2 + i * 3)
    print("  ! 取得失敗 %s (%s)" % (url, last), file=sys.stderr)
    return None


def num(v):
    """把 API 回來的字串轉成 float；'-'、''、0 之類的無效值回 None。"""
    if v is None:
        return None
    s = str(v).replace(",", "").replace("%", "").strip()
    if s in ("", "-", "--", "N/A", "null"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f > 0 else None


def is_common_stock(code):
    """只留普通股（4 碼純數字），排除 ETF、權證、特別股、受益證券。"""
    return len(code) == 4 and code.isdigit()


def roc_to_iso(roc):
    """民國日期字串 1150811 -> 2026-08-11。"""
    s = str(roc).strip()
    try:
        if len(s) == 7:
            return "%04d-%s-%s" % (int(s[:3]) + 1911, s[3:5], s[5:7])
    except ValueError:
        pass
    return None


# --------------------------------------------------------------------------
# 上市（TWSE）
# --------------------------------------------------------------------------
def fetch_twse(max_back_days=12):
    """從今天往前找最近一個有資料的交易日。"""
    today = datetime.now(TPE).date()
    for back in range(max_back_days):
        d = today - timedelta(days=back)
        if d.weekday() >= 5:  # 週末直接跳過
            continue
        ds = d.strftime("%Y%m%d")
        url = ("https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d"
               "?date=%s&selectType=ALL&response=json" % ds)
        print("  · TWSE %s" % ds)
        j = fetch_json(url)
        if not j or j.get("stat") != "OK" or not j.get("data"):
            continue

        rows = []
        for r in j["data"]:
            # 欄位：證券代號 證券名稱 收盤價 殖利率(%) 股利年度 本益比 股價淨值比 財報年/季
            code = str(r[0]).strip()
            if not is_common_stock(code):
                continue
            price = num(r[2])
            if price is None:
                continue
            rows.append({
                "c": code,
                "n": str(r[1]).strip(),
                "m": "上市",
                "p": price,
                "y": num(r[3]),               # 現金殖利率 %
                "pe": num(r[5]),              # 本益比（近四季 EPS）
                "pb": num(r[6]),              # 股價淨值比（最近一季淨值）
                "dy": str(r[4]).strip(),      # 股利年度
                "fq": str(r[7]).strip() if len(r) > 7 else "",  # 財報年/季
            })
        if rows:
            return rows, d.strftime("%Y-%m-%d")
    return [], None


def fetch_twse_openapi():
    """備援：TWSE OpenAPI（更新較慢，但格式穩定）。"""
    bw = fetch_json("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL")
    dayall = fetch_json("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL")
    if not bw:
        return [], None
    prices = {}
    for r in (dayall or []):
        prices[str(r.get("Code", "")).strip()] = num(r.get("ClosingPrice"))

    rows, dt = [], None
    for r in bw:
        code = str(r.get("Code", "")).strip()
        if not is_common_stock(code):
            continue
        price = prices.get(code)
        if price is None:
            continue
        dt = dt or roc_to_iso(r.get("Date"))
        rows.append({
            "c": code,
            "n": str(r.get("Name", "")).strip(),
            "m": "上市",
            "p": price,
            "y": num(r.get("DividendYield")),
            "pe": num(r.get("PEratio")),
            "pb": num(r.get("PBratio")),
            "dy": "",
            "fq": "",
        })
    return rows, dt


# --------------------------------------------------------------------------
# 上櫃（TPEx）
# --------------------------------------------------------------------------
def fetch_tpex():
    pe = fetch_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis")
    # 用 tpex_mainboard_quotes（約 350 KB）而非 tpex_mainboard_daily_close_quotes
    #（約 3.8 MB，含上萬檔權證），兩者欄位相同但前者只有股票。
    qt = fetch_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes")
    if not pe:
        return [], None

    closes = {}
    for r in (qt or []):
        closes[str(r.get("SecuritiesCompanyCode", "")).strip()] = num(r.get("Close"))

    rows, dt = [], None
    for r in pe:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if not is_common_stock(code):
            continue
        price = closes.get(code)
        if price is None:
            continue
        dt = dt or roc_to_iso(r.get("Date"))
        rows.append({
            "c": code,
            "n": str(r.get("CompanyName", "")).strip(),
            "m": "上櫃",
            "p": price,
            "y": num(r.get("YieldRatio")),
            "pe": num(r.get("PriceEarningRatio")),
            "pb": num(r.get("PriceBookRatio")),
            "d": num(r.get("DividendPerShare")),  # 上櫃直接提供每股現金股利
            "dy": "",
            "fq": "",
        })
    return rows, dt


# --------------------------------------------------------------------------
# 在外流通股數與實收資本額（股本）
#
# 台股的交易所每天公布本益比與股價淨值比，估價本身用不到股數 —— 每股數字
# 直接除得出來。但「市值」與「股本」是理解一家公司規模的基本資訊，而且
# 台股習慣用股本大小分類個股（小型股、大型股），所以另外抓一次。
#
#   上市：t187ap03_L 直接給「已發行普通股數」，涵蓋率 100%。
#   上櫃：只給實收資本額與面額，股數 = 實收資本額 ÷ 面額。
#
# 面額不是每檔都 10 元 —— 2014 年放寬後有 5 元、1 元、0.5 元的個股，
# 外國企業（F 股）甚至以美元計價，所以一定要照實解析面額，不能寫死 10。
# --------------------------------------------------------------------------
TWSE_INFO = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
TPEX_INFO = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"


def parse_par(text):
    """'新台幣  10.0000元' -> 10.0；非新台幣計價回 None（換算需要匯率）。"""
    s = str(text or "").strip()
    if not s:
        return None
    if "新台幣" not in s and "NTD" not in s.upper():
        # 美元計價的 F 股，用面額換算股數會錯一個匯率
        if any(c.isalpha() or "\u4e00" <= c <= "\u9fff" for c in s.replace("元", "")):
            return None
    m = re.search(r"(\d+(?:\.\d+)?)", s.replace(",", ""))
    return float(m.group(1)) if m and float(m.group(1)) > 0 else None


def fetch_shares():
    """回傳 {代號: (在外流通股數, 實收資本額)}。"""
    out = {}
    tw = fetch_json(TWSE_INFO)
    for r in (tw or []):
        code = str(r.get("公司代號", "")).strip()
        if not is_common_stock(code):
            continue
        sh = num(r.get("已發行普通股數或TDR原股發行股數"))
        cap = num(r.get("實收資本額"))
        if sh:
            out[code] = (sh, cap)
    print("   上市 %d 檔（官方直接提供股數）" % len(out))

    tp = fetch_json(TPEX_INFO)
    n = 0
    for r in (tp or []):
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if not is_common_stock(code) or code in out:
            continue
        cap = num(r.get("Paidin.Capital.NTDollars"))
        par = parse_par(r.get("ParValueOfCommonStock"))
        if cap and par:
            out[code] = (cap / par, cap)
            n += 1
    print("   上櫃 %d 檔（實收資本額 ÷ 面額）" % n)
    return out


def enrich(rows):
    """由 收盤價 / 本益比 / 股價淨值比 / 殖利率 推算估價所需的每股財務數字。

      EPS(近四季) = 收盤價 / 本益比
      BVPS(每股淨值) = 收盤價 / 股價淨值比
      ROE(近四季)   = EPS / BVPS = 股價淨值比 / 本益比
      DPS(每股現金股利) = 收盤價 × 殖利率%

    股利一律以「收盤價 × 殖利率」推算，讓上市 / 上櫃口徑一致：上市本來就沒有
    DPS 欄位，而上櫃雖有 DividendPerShare，少數個股（如減資、除權息換算期間）
    會與自家的殖利率互相矛盾。官方 DPS 只在殖利率缺漏時作為備援。
    """
    for r in rows:
        p, pe, pb, y = r.get("p"), r.get("pe"), r.get("pb"), r.get("y")
        r["eps"] = round(p / pe, 4) if (p and pe) else None
        r["bvps"] = round(p / pb, 4) if (p and pb) else None
        r["roe"] = round(pb / pe * 100, 3) if (pe and pb) else None  # %
        official = r.get("d")
        r["d"] = round(p * y / 100, 4) if (p and y) else (
            round(official, 4) if official else None)
    return rows


def attach_shares(rows, shares):
    """把股數、股本與市值掛上去。金額一律以百萬元存，JSON 才不會被一堆
    12 位數的整數撐大。"""
    for r in rows:
        hit = shares.get(r["c"])
        if not hit:
            continue
        sh, cap = hit
        r["sh"] = round(sh / 1e6, 3)                       # 百萬股
        if cap:
            r["cap"] = round(cap / 1e6, 2)                 # 百萬元
        if r.get("p"):
            r["mc"] = round(r["p"] * sh / 1e6, 2)          # 百萬元
    return rows


def load_existing():
    """讀取上一次的結果，作為個別市場抓取失敗時的備援。"""
    path = os.path.join(OUT_DIR, "latest.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main():
    print("== 抓取上市（TWSE）==")
    twse, d1 = fetch_twse()
    if not twse:
        print("   主要來源失敗，改用 OpenAPI 備援")
        twse, d1 = fetch_twse_openapi()
    print("   %d 檔 / 資料日 %s" % (len(twse), d1))

    print("== 抓取上櫃（TPEx）==")
    tpex, d2 = fetch_tpex()
    print("   %d 檔 / 資料日 %s" % (len(tpex), d2))

    # 只有一邊失敗時沿用上次的資料，避免整個市場的股票從網站上消失
    old = load_existing() if (not twse or not tpex) else None
    if old:
        old_td = old.get("trade_date") or {}
        if not twse:
            twse = [s for s in old.get("stocks", []) if s.get("m") == "上市"]
            d1 = old_td.get("上市")
            print("   ! 上市抓取失敗，沿用 %s 的 %d 檔" % (d1, len(twse)), file=sys.stderr)
        if not tpex:
            tpex = [s for s in old.get("stocks", []) if s.get("m") == "上櫃"]
            d2 = old_td.get("上櫃")
            print("   ! 上櫃抓取失敗，沿用 %s 的 %d 檔" % (d2, len(tpex)), file=sys.stderr)

    print("== 抓取在外流通股數與股本 ==")
    shares = fetch_shares()

    rows = attach_shares(enrich(twse + tpex), shares)
    if not rows:
        print("兩個來源都失敗，保留既有 data/latest.json 不覆蓋。", file=sys.stderr)
        return 1

    rows.sort(key=lambda r: r["c"])
    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "trade_date": {"上市": d1, "上櫃": d2},
        "count": len(rows),
        "source": ["TWSE 台灣證券交易所", "TPEx 證券櫃檯買賣中心"],
        "stocks": rows,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔，%.1f KB）==" % (
        path, len(rows), os.path.getsize(path) / 1024))
    print("   有股數 %d 檔／有市值 %d 檔"
          % (sum(1 for r in rows if r.get("sh")), sum(1 for r in rows if r.get("mc"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
