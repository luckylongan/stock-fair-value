#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 ETF 的淨值與收盤價，輸出 data/etf.json。

為什麼 ETF 要另外處理
--------------------
ETF 是一籃子證券，沒有財報，所以沒有 EPS、營收、淨利、ROE 與成長率 ——
個股那九種公式有七種對它完全不適用。剩下兩種也要重新理解：

  * 股價淨值比：個股的 P/B 是估值指標；ETF 的淨值就是持股市值總和，
    P/B 理論上恆等於 1，偏離 1 不叫便宜或貴，而是「折溢價」，
    屬於造市與流動性問題，用估值的邏輯解讀會完全會錯意。
  * 殖利率：配息型 ETF 適用，與個股同理。

因此 ETF 頁看的是另一組指標：折溢價率、殖利率、規模、流動性。

資料來源
--------
淨值 https://mis.twse.com.tw/stock/data/all_etf.txt
     證交所即時系統彙整各投信的預估淨值，需帶 Referer。
價格 https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL（上市）
     https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes（上櫃）

折溢價率 = (收盤價 − 淨值) ÷ 淨值 × 100%
"""

import json
import os
import re
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
TPE = timezone(timedelta(hours=8))

NAV_URL = "https://mis.twse.com.tw/stock/data/all_etf.txt"
NAV_REFERER = "https://mis.twse.com.tw/stock/etf.jsp"
TWSE_PX = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_PX = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"


def fetch_json(url, referer=None, retries=3, timeout=45):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    headers = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if referer:
        headers["Referer"] = referer
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception:  # noqa: BLE001
            time.sleep(2 + i * 3)
    print("  ! 取得失敗 %s" % url, file=sys.stderr)
    return None


def fnum(v):
    try:
        f = float(str(v).replace(",", "").strip())
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def is_etf(code):
    """ETF 代號一律以 00 開頭，後接 2~4 位數字，可能帶英文後綴。

    涵蓋 4 碼（0050、0056）、5 碼（00878）、6 碼（006208）與帶後綴者
    （00679B、00987A）。個股代號不會以 00 開頭，因此不會誤收。
    """
    return bool(re.fullmatch(r"00\d{2,4}[A-Z]?", code or ""))


# 代號後綴代表的類型 —— 不同類型的折溢價容忍度差很多
SUFFIX = {
    "B": ("債券", "投資國外債券，淨值受匯率與債市影響"),
    "L": ("槓桿", "單日正向倍數，長期持有有複利耗損"),
    "R": ("反向", "單日反向，長期持有有複利耗損"),
    "U": ("期貨", "期貨信託，有轉倉成本"),
    "A": ("主動", "主動式管理，非追蹤指數"),
    "C": ("多幣別", "以外幣計價之受益憑證"),
}


def classify(code, name):
    m = re.fullmatch(r"00\d{2,4}([A-Z])", code)
    if m and m.group(1) in SUFFIX:
        return SUFFIX[m.group(1)]
    if "反" in name:
        return SUFFIX["R"]
    if "正2" in name or "正向" in name:
        return SUFFIX["L"]
    return ("原型", "追蹤指數的原型 ETF")


def fetch_nav():
    """證交所即時系統的各投信預估淨值，依投信分組。"""
    j = fetch_json(NAV_URL, referer=NAV_REFERER)
    if not j:
        return {}
    # 欄位對應（實測比對 STOCK_DAY_ALL 確認）：
    #   a 代號　b 名稱　c 已發行單位數　d 單位數變動
    #   e 市價（與交易所收盤價完全一致）　f 前一日參考價　g 漲跌%
    #   h 預估淨值  ← 這欄才是淨值，不是 e
    out = {}
    for grp in j.get("a1") or []:
        for r in grp.get("msgArray") or []:
            code = str(r.get("a", "")).strip()
            nav = fnum(r.get("h"))          # 預估淨值
            if not code or not nav:
                continue
            out[code] = {
                "nav": round(nav, 4),
                "name": str(r.get("b", "")).strip(),
                "units": fnum(r.get("c")),   # 已發行受益權單位數
                "navd": str(r.get("i", "")).strip(),   # 淨值日期
                "issuer": (grp.get("refURL") or "").split("/")[2] if grp.get("refURL") else "",
            }
    return out


def fetch_prices():
    """上市 + 上櫃的 ETF 收盤價。"""
    px = {}
    d1 = fetch_json(TWSE_PX)
    for r in (d1 or []):
        code = str(r.get("Code", "")).strip()
        if not is_etf(code):
            continue
        c = fnum(r.get("ClosingPrice"))
        if c:
            px[code] = {"p": c, "m": "上市",
                        "name": str(r.get("Name", "")).strip(),
                        "vol": fnum(r.get("TradeVolume")) or 0}
    d2 = fetch_json(TPEX_PX)
    for r in (d2 or []):
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if not is_etf(code) or code in px:
            continue
        c = fnum(r.get("Close"))
        if c:
            px[code] = {"p": c, "m": "上櫃",
                        "name": str(r.get("CompanyName", "")).strip(),
                        "vol": fnum(r.get("TradingShares")) or 0}
    return px


def main():
    print("== 抓取 ETF 淨值 ==")
    nav = fetch_nav()
    print("   %d 檔有淨值" % len(nav))

    print("== 抓取 ETF 收盤價 ==")
    px = fetch_prices()
    print("   %d 檔有收盤價（上市 %d、上櫃 %d）" % (
        len(px), sum(1 for v in px.values() if v["m"] == "上市"),
        sum(1 for v in px.values() if v["m"] == "上櫃")))

    rows = []
    for code, p in px.items():
        n = nav.get(code)
        name = (n or {}).get("name") or p["name"]
        kind, kdesc = classify(code, name)
        rec = {
            "c": code, "n": p["name"] or name, "full": (n or {}).get("name", ""),
            "m": p["m"], "p": p["p"], "vol": p["vol"],
            "kind": kind, "kdesc": kdesc,
        }
        if n:
            rec["nav"] = n["nav"]
            rec["prem"] = round((p["p"] - n["nav"]) / n["nav"] * 100, 3)
            rec["navd"] = n["navd"]
            # 來源的 c 欄（發行單位數）單位無法確認：0050 換算出的規模與
            # 公開資訊差一個數量級，因此不做規模換算、也不對外顯示，
            # 以免呈現無法驗證的數字。只保留原值供日後查證。
            if n["units"]:
                rec["units_raw"] = n["units"]
        rows.append(rec)

    if not rows:
        print("沒有取得任何 ETF 資料，保留既有檔案不覆蓋。", file=sys.stderr)
        return 1

    rows.sort(key=lambda r: r["c"])
    withnav = [r for r in rows if "prem" in r]
    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "note": ("prem 為折溢價率 = (收盤價 − 預估淨值) ÷ 預估淨值 × 100%。"
                 "ETF 沒有財報，個股的本益比／ROE／營收類公式皆不適用；"
                 "淨值來自證交所即時系統彙整之各投信預估值，非官方收盤淨值。"
                 "units_raw 為來源提供的發行單位數，單位未經確認，未用於任何計算。"),
        "count": len(rows),
        "with_nav": len(withnav),
        "etfs": rows,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "etf.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔，其中 %d 檔有淨值，%.1f KB）==" % (
        path, len(rows), len(withnav), os.path.getsize(path) / 1024))

    if withnav:
        prem = sorted(r["prem"] for r in withnav)
        mid = prem[len(prem) // 2]
        print("   折溢價率：中位 %+.2f%%　溢價>1%% %d 檔　折價<-1%% %d 檔" % (
            mid, sum(1 for p in prem if p > 1), sum(1 for p in prem if p < -1)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
