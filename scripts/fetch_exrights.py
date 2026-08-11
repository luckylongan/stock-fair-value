#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""收集除權（無償配股）事件，輸出 data/exrights.json。

為什麼需要這支程式
------------------
交易所公布的本益比與股價淨值比，在除權當天是拿「已經稀釋的股價」除以
「還沒按新股本重算的每股盈餘／淨值」。實測（倫飛 2364、華友聯 1436、
豐藝 6189）都顯示除權日 PE 與 PB 隨股價同步跳空 20~30%，EPS 完全沒變。

本站由 收盤價 ÷ 本益比 反推 EPS，因此會拿到「未攤薄」的 EPS 與每股淨值，
造成本益比法、股價淨值比法、ROE 法的合理價一併高估，幅度約等於配股率。
失真會持續到下一次財報更新為止。

這支程式把配股事件記錄下來，前端就能對受影響的個股做攤薄修正並標示。

資料來源
--------
上市 TWT48U  除權除息預告表（含「無償配股率」，涵蓋約未來兩個月）
上市 TWT49U  除權息計算結果表（可查歷史，純「權」可由參考價精確反推配股率）
上櫃 tpex_exright_daily  當日除權除息結果（含每千股無償配股數）

TWT48U 只涵蓋未來一小段時間，所以本檔採「累積」方式：每天執行時把新事件
併入既有檔案，保留最近 400 天。
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
KEEP_DAYS = 400


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
    print("  ! 取得失敗 %s" % url, file=sys.stderr)
    return None


def fnum(v, default=0.0):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def roc_date(s):
    """115年08月10日 或 1150810 -> 2026-08-10"""
    s = str(s).strip()
    try:
        if "年" in s:
            y = int(s.split("年")[0]); m = s.split("年")[1].split("月")[0]; d = s.split("月")[1].replace("日", "")
            return "%04d-%02d-%02d" % (y + 1911, int(m), int(d))
        if len(s) == 7 and s.isdigit():
            return "%04d-%s-%s" % (int(s[:3]) + 1911, s[3:5], s[5:7])
    except (ValueError, IndexError):
        pass
    return None


def is_common(code):
    return len(code) == 4 and code.isdigit()


# --------------------------------------------------------------------------
def from_twse_forecast():
    """上市除權息預告表：直接提供「無償配股率」，最精確。"""
    j = fetch_json("https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json")
    if not j or j.get("stat") != "OK":
        return []
    out = []
    for r in j.get("data") or []:
        code = str(r[1]).strip()
        k = fnum(r[4])          # 無償配股率，已是比率（0.22 = 22%）
        if not is_common(code) or k <= 0:
            continue
        d = roc_date(r[0])
        if not d:
            continue
        out.append({"c": code, "d": d, "k": round(k, 6),
                    "cash": round(fnum(r[7]), 4), "src": "twse_forecast"})
    return out


def from_twse_results(months=4):
    """上市除權息結果表（可查歷史），補預告表涵蓋不到的過去。

    只有純「權」（當天不除息）能精確反推：參考價 = 前收盤價 ÷ (1 + 配股率)。
    「權息」當天同時發現金，兩個未知數無法由這張表分離，記為 k=None 只做提示。
    """
    today = datetime.now(TPE).date()
    start = (today - timedelta(days=months * 31)).strftime("%Y%m%d")
    j = fetch_json("https://www.twse.com.tw/rwd/zh/exRight/TWT49U"
                   "?startDate=%s&endDate=%s&response=json" % (start, today.strftime("%Y%m%d")))
    if not j or j.get("stat") != "OK":
        return []
    out = []
    for r in j.get("data") or []:
        code = str(r[1]).strip()
        typ = str(r[6]).strip()
        if not is_common(code) or "權" not in typ:
            continue          # 純除息不影響股本，不需要攤薄
        d = roc_date(r[0])
        if not d:
            continue
        p, ref = fnum(r[3]), fnum(r[4])
        if typ == "權" and p > 0 and ref > 0:
            k = p / ref - 1                      # 當天不除息，可精確反推
            if k > 0.0005:
                out.append({"c": code, "d": d, "k": round(k, 6),
                            "cash": 0.0, "src": "twse_result"})
        else:
            # 權息：知道有配股但算不出比率，前端只提示不做修正
            out.append({"c": code, "d": d, "k": None, "cash": None, "src": "twse_result_mixed"})
    return out


def from_tpex():
    """上櫃當日除權息結果表：用每千股無償配股數換算配股率。"""
    rows = fetch_json("https://www.tpex.org.tw/openapi/v1/tpex_exright_daily")
    if not rows:
        return []
    out = []
    for r in rows:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if not is_common(code):
            continue
        d = roc_date(r.get("Date"))
        if not d:
            continue
        # 每千股配發股數 / 1000 = 配股率；沒有這欄時退而用股票股利（元）÷ 10（面額）
        k = fnum(r.get("StockDivdendThousandShares")) / 1000.0
        if k <= 0:
            k = fnum(r.get("StockDividend")) / 10.0
        if k <= 0.0005:
            continue
        out.append({"c": code, "d": d, "k": round(k, 6),
                    "cash": round(fnum(r.get("CashDividend")), 4), "src": "tpex"})
    return out


# --------------------------------------------------------------------------
def load_existing():
    try:
        with open(os.path.join(OUT_DIR, "exrights.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main():
    print("== 上市除權息預告表（精確配股率）==")
    a = from_twse_forecast()
    print("   %d 筆配股事件" % len(a))

    print("== 上市除權息結果表（補歷史）==")
    b = from_twse_results()
    exact = [e for e in b if e["k"] is not None]
    print("   %d 筆（其中 %d 筆可精確反推，%d 筆為權息只做提示）"
          % (len(b), len(exact), len(b) - len(exact)))

    print("== 上櫃當日除權息 ==")
    c = from_tpex()
    print("   %d 筆配股事件" % len(c))

    # 合併：同一檔同一天只留一筆，精確來源優先（預告表 > 結果表 > 只提示）
    rank = {"twse_forecast": 3, "tpex": 3, "twse_result": 2, "twse_result_mixed": 1}
    merged = {}
    old = load_existing()
    for e in (old or {}).get("events_flat", []):
        merged[(e["c"], e["d"])] = e
    for e in a + b + c:
        key = (e["c"], e["d"])
        cur = merged.get(key)
        if cur is None or rank.get(e["src"], 0) > rank.get(cur.get("src"), 0):
            merged[key] = e

    cutoff = (datetime.now(TPE).date() - timedelta(days=KEEP_DAYS)).isoformat()
    flat = sorted((e for e in merged.values() if e["d"] >= cutoff),
                  key=lambda e: (e["c"], e["d"]))

    by_code = {}
    for e in flat:
        by_code.setdefault(e["c"], []).append(
            {"d": e["d"], "k": e["k"], "cash": e["cash"]})

    out = {
        "updated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S+08:00"),
        "keep_days": KEEP_DAYS,
        "note": ("無償配股（除權）事件。k 為配股率，k=null 代表該次為權息、"
                 "配股率無法由公開資料精確分離，前端只提示不做修正。"),
        "count": len(flat),
        "events": by_code,
        "events_flat": flat,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "exrights.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("== 已寫入 %s（%d 檔 / %d 筆事件，%.1f KB）==" % (
        path, len(by_code), len(flat), os.path.getsize(path) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
