/* 合理股價估算器
 * 四種估價法：ROE 法、股價淨值比法、股利法、本益比法
 * 資料：data/latest.json（每日由 GitHub Actions 更新）＋ data/bands.json（近 5 年評價區間）
 */
(() => {
  "use strict";

  // ── 狀態 ────────────────────────────────────────────────
  let STOCKS = [];        // 全市場個股
  let BANDS = {};         // 代號 -> {pe:[P20,P50,P80], pb:[...], y:[...]}
  let EXRIGHTS = {};      // 代號 -> [{d:除權日, k:配股率, cash:現金股利}]
  let INDEX = new Map();  // 代號 -> 個股
  let current = null;     // 目前選定的個股
  let sugIdx = -1;        // 建議清單游標

  const DEFAULTS = {
    useBands: true,
    peLo: 10, peMid: 15, peHi: 20,
    pbLo: 0.8, pbMid: 1.2, pbHi: 1.8,
    yHi: 6.25, yMid: 5, yLo: 3.125,
    r: 8, g: 2, mos: 25,
  };
  const OFF_KEY = "fv_off_methods";
  let params = { ...DEFAULTS };
  let offMethods = new Set();

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["q", "suggest", "clearBtn", "loading", "errorBox", "result", "empty", "methods",
   "sName", "sCode", "sMarket", "sDate", "sPrice", "sEps", "sBvps", "sRoe", "sDps",
   "sPe", "sPb", "sY", "sFq", "tCheap", "tFair", "tRich", "gaugeMark", "gaugePrice",
   "gScaleL", "gScaleM", "gScaleR", "verdict", "dataDate", "dataCount",
   "refreshBtn", "themeBtn", "resetParams", "pUseBands"].forEach((k) => (el[k] = $(k)));

  // ── 小工具 ──────────────────────────────────────────────
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (v, d = 2) =>
    (v === null || v === undefined || !isFinite(v)) ? "—"
      : v.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };

  // ═══════════════════════════════════════════════════════
  //  除權（無償配股）攤薄修正
  //
  //  交易所在除權當天，是拿「已稀釋的股價」除以「還沒按新股本重算的
  //  每股盈餘／淨值」，所以本站反推出來的 EPS 與每股淨值會是未攤薄的值，
  //  直接拿去估價會高估，幅度約等於配股率。這裡依配股率把它除回來。
  //
  //  判斷準則：除權日晚於目前財報基準季的季末，代表該季財報的每股數字
  //  還沒反映新股本。上櫃來源沒有財報季欄位，改以近 150 天內除權近似。
  // ═══════════════════════════════════════════════════════
  const todayISO = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  /** "115/2" -> "2026-06-30"（民國年 / 季 → 該季季末） */
  function fiscalEnd(fq) {
    const m = /^(\d{2,3})\/([1-4])$/.exec((fq || "").trim());
    if (!m) return null;
    return (+m[1] + 1911) + "-" + ["03-31", "06-30", "09-30", "12-31"][+m[2] - 1];
  }

  function dilutionOf(s) {
    const evs = EXRIGHTS[s.c];
    if (!evs || !evs.length) return null;
    const today = todayISO();
    // 沒有財報季資訊時（上櫃），用 150 天回看當作近似
    const cut = fiscalEnd(s.fq) ||
      new Date(Date.now() + 8 * 3600e3 - 150 * 86400e3).toISOString().slice(0, 10);

    // 只算「已經除權、且晚於財報基準日」的事件；未來的除權還沒影響股價
    const after = evs.filter((e) => e.d > cut && e.d <= today);
    if (!after.length) return null;

    const known = after.filter((e) => e.k != null && e.k > 0);
    const unknown = after.filter((e) => e.k == null);
    const factor = known.reduce((a, e) => a * (1 + e.k), 1);
    if (factor <= 1 && !unknown.length) return null;
    return { factor, known, unknown, approx: !fiscalEnd(s.fq) };
  }

  /** 回傳套用攤薄後的個股副本；ROE 是比值，不受攤薄影響。 */
  function effective(s) {
    const adj = dilutionOf(s);
    if (!adj || adj.factor <= 1) return Object.assign({}, s, { _adj: adj });
    return Object.assign({}, s, {
      eps: s.eps ? s.eps / adj.factor : s.eps,
      bvps: s.bvps ? s.bvps / adj.factor : s.bvps,
      _adj: adj,
      _rawEps: s.eps, _rawBvps: s.bvps,
    });
  }

  /** 給估價公式用的小註解，說明數字被攤薄過 */
  function dilutionNote(s) {
    const a = s._adj;
    if (!a || a.factor <= 1) return "";
    const list = a.known.map((e) => `${e.d} 配股 ${fmt(e.k * 100, 1)}%`).join("、");
    return `<br><span class="formula-adj">↳ 已依 ${list} 攤薄（÷ ${fmt(a.factor, 4)}）</span>`;
  }

  // ═══════════════════════════════════════════════════════
  //  四種估價法
  //  每個方法回傳 {cheap, fair, rich, basis, formula} 或 {na: "不適用原因"}
  // ═══════════════════════════════════════════════════════

  /* 1. ROE 法 —— 由高登成長模型推導出合理股價淨值比
   *    合理 P/B = (ROE − g) / (r − g)，再乘上每股淨值。
   *    便宜 / 昂貴價以安全邊際上下調整。 */
  function methodRoe(s) {
    if (!s.bvps) return { na: "缺少每股淨值資料（無股價淨值比），無法估算。" };
    if (!s.roe) return { na: "缺少 ROE（需要本益比與股價淨值比同時存在），多因公司虧損。" };
    const r = params.r / 100, g = params.g / 100, roe = s.roe / 100;
    if (g >= r) return { na: "永續成長率 g 必須小於要求報酬率 r，模型無解，請調整參數。" };
    if (roe <= g) {
      return { na: `ROE ${fmt(s.roe)}% 未高於永續成長率 g ${fmt(params.g, 1)}%，` +
                   "模型會得出負值或極低估值，不適用。" };
    }
    const pbFair = (roe - g) / (r - g);
    const fair = s.bvps * pbFair, m = params.mos / 100;
    return {
      cheap: fair * (1 - m), fair, rich: fair * (1 + m),
      basis: `<span class="basis-tag">參數</span>r ${fmt(params.r, 1)}%　g ${fmt(params.g, 1)}%　安全邊際 ${fmt(params.mos, 0)}%`,
      formula:
        `合理 P/B ＝ (ROE ${fmt(s.roe)}% − g ${fmt(params.g, 1)}%) ÷ (r ${fmt(params.r, 1)}% − g ${fmt(params.g, 1)}%) ＝ ${fmt(pbFair)} 倍` +
        (s._adj && s._adj.factor > 1
          ? `<br>每股淨值 ${fmt(s._rawBvps)} 依配股攤薄 → ${fmt(s.bvps)} 元` : "") +
        `<br>合理價 ＝ 每股淨值 ${fmt(s.bvps)} × ${fmt(pbFair)} ＝ ${fmt(fair)} 元<br>` +
        `便宜 / 昂貴價 ＝ 合理價 × (1 ∓ ${fmt(params.mos, 0)}%)`,
    };
  }

  /* 2. 股價淨值比法 —— 每股淨值 × 合理 P/B 倍數 */
  function methodPb(s) {
    if (!s.bvps) return { na: "來源未提供股價淨值比，無法推算每股淨值。" };
    const b = usable(s, "pb");
    const [lo, mid, hi] = b || [params.pbLo, params.pbMid, params.pbHi];
    return {
      cheap: s.bvps * lo, fair: s.bvps * mid, rich: s.bvps * hi,
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`),
      formula:
        `每股淨值 ＝ 收盤價 ${fmt(s.p)} ÷ 股價淨值比 ${fmt(s.pb)} ＝ ${fmt(s._rawBvps || s.bvps)} 元` +
        dilutionNote(s) +
        `<br>各價位 ＝ ${fmt(s.bvps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`,
    };
  }

  /* 3. 股利法 —— 每股現金股利 ÷ 目標殖利率
   *    殖利率越高＝股價越便宜，所以便宜價用最高的殖利率去除。 */
  function methodDiv(s) {
    if (!s.d) return { na: "近一年無現金股利（或殖利率為 0），股利法不適用。" };
    const b = usable(s, "y");
    // 歷史區間為 [P20, P50, P80]；殖利率高對應便宜價，故取用時左右對調
    const yCheap = b ? b[2] : params.yHi;
    const yFair = b ? b[1] : params.yMid;
    const yRich = b ? b[0] : params.yLo;
    return {
      cheap: s.d / (yCheap / 100), fair: s.d / (yFair / 100), rich: s.d / (yRich / 100),
      basis: basisTag(b, `殖利率 ${fmt(yCheap)}% / ${fmt(yFair)}% / ${fmt(yRich)}%`),
      formula:
        `每股現金股利 ＝ 收盤價 ${fmt(s.p)} × 殖利率 ${fmt(s.y)}% ＝ ${fmt(s.d)} 元<br>` +
        `便宜價 ＝ ${fmt(s.d)} ÷ ${fmt(yCheap)}%（殖利率越高股價越便宜）<br>` +
        `合理 / 昂貴價 ＝ ${fmt(s.d)} ÷ ${fmt(yFair)}% / ${fmt(yRich)}%`,
    };
  }

  /* 4. 本益比法 —— 近四季 EPS × 合理本益比 */
  function methodPe(s) {
    if (!s.eps) return { na: "來源未提供本益比（通常代表近四季為虧損），本益比法不適用。" };
    const b = usable(s, "pe");
    const [lo, mid, hi] = b || [params.peLo, params.peMid, params.peHi];
    return {
      cheap: s.eps * lo, fair: s.eps * mid, rich: s.eps * hi,
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`),
      formula:
        `近四季 EPS ＝ 收盤價 ${fmt(s.p)} ÷ 本益比 ${fmt(s.pe)} ＝ ${fmt(s._rawEps || s.eps)} 元` +
        dilutionNote(s) +
        `<br>各價位 ＝ ${fmt(s.eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`,
    };
  }

  /** 取得可用的歷史區間；關閉開關或無資料時回傳 null（改用固定參數）。 */
  function usable(s, key) {
    if (!params.useBands) return null;
    const b = BANDS[s.c];
    return (b && b[key] && b[key].length === 3) ? b[key] : null;
  }
  function basisTag(band, txt) {
    return band
      ? `<span class="basis-tag">近 5 年區間</span>${txt}`
      : `<span class="basis-tag">固定倍數</span>${txt}`;
  }

  const METHODS = [
    { id: "roe", name: "ROE 法", en: "Return on Equity", fn: methodRoe },
    { id: "pb", name: "股價淨值比法", en: "P/B Ratio", fn: methodPb },
    { id: "div", name: "股利法", en: "Dividend", fn: methodDiv },
    { id: "pe", name: "本益比法", en: "P/E Ratio", fn: methodPe },
  ];

  // ═══════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════
  function render() {
    if (!current) return;
    const s = effective(current);   // 套用除權配股攤薄後的數字

    el.sName.textContent = s.n;
    el.sCode.textContent = s.c;
    el.sMarket.textContent = s.m;
    el.sDate.textContent = "收盤 " + (s._date || "—");
    el.sPrice.textContent = fmt(s.p);
    el.sEps.textContent = s.eps ? fmt(s.eps) + " 元" : "—";
    el.sBvps.textContent = s.bvps ? fmt(s.bvps) + " 元" : "—";
    renderDilution(s);
    el.sRoe.textContent = s.roe ? fmt(s.roe) + " %" : "—";
    el.sDps.textContent = s.d ? fmt(s.d) + " 元" : "—";
    el.sPe.textContent = s.pe ? fmt(s.pe) + " 倍" : "—";
    el.sPb.textContent = s.pb ? fmt(s.pb) + " 倍" : "—";
    el.sY.textContent = s.y ? fmt(s.y) + " %" : "—";
    el.sFq.textContent = s.fq || "—";

    // 四張方法卡
    const results = {};
    el.methods.innerHTML = "";
    METHODS.forEach((m) => {
      const res = m.fn(s);
      results[m.id] = res;
      const on = !offMethods.has(m.id);
      const card = document.createElement("div");
      card.className = "method" + (res.na ? " na" : (on ? "" : " off"));
      card.innerHTML = `
        <div class="method-head">
          ${res.na ? "" :
            `<input type="checkbox" class="method-toggle" data-m="${m.id}" ${on ? "checked" : ""}
                    aria-label="是否納入綜合評估">`}
          <h3>${m.name}<span class="m-en">${m.en}</span></h3>
        </div>
        ${res.na
          ? `<p class="method-basis">—</p><p class="method-na">⚠︎ ${res.na}</p>`
          : `<p class="method-basis">${res.basis}</p>
             <div class="method-prices">
               <div class="mp cheap"><span>便宜價</span><strong>${fmt(res.cheap)}</strong></div>
               <div class="mp fair"><span>合理價</span><strong>${fmt(res.fair)}</strong></div>
               <div class="mp rich"><span>昂貴價</span><strong>${fmt(res.rich)}</strong></div>
             </div>
             <p class="method-formula">${res.formula}</p>`}
      `;
      el.methods.appendChild(card);
    });

    el.methods.querySelectorAll(".method-toggle").forEach((cb) => {
      cb.addEventListener("change", () => {
        cb.checked ? offMethods.delete(cb.dataset.m) : offMethods.add(cb.dataset.m);
        localStorage.setItem(OFF_KEY, JSON.stringify([...offMethods]));
        render();
      });
    });

    renderSummary(s, results);
  }

  /** 個股卡上的除權配股提示 */
  function renderDilution(s) {
    const box = $("dilutionNote");
    if (!box) return;
    const a = s._adj;
    if (!a) { box.hidden = true; return; }

    const parts = [];
    if (a.factor > 1) {
      const list = a.known.map((e) =>
        `<b>${e.d}</b> 配股 <b>${fmt(e.k * 100, 1)}%</b>`).join("、");
      parts.push(
        `本檔於 ${list}。交易所公布的本益比與股價淨值比在除權後，是用已稀釋的股價
         除以尚未按新股本重算的每股盈餘，因此本站已把 EPS 與每股淨值除以
         <b>${fmt(a.factor, 4)}</b> 還原成攤薄後的數字
         （EPS ${fmt(s._rawEps)} → <b>${fmt(s.eps)}</b>，
         每股淨值 ${fmt(s._rawBvps)} → <b>${fmt(s.bvps)}</b>）。`);
    }
    if (a.unknown.length) {
      parts.push(
        `另有 ${a.unknown.map((e) => e.d).join("、")} 的<b>權息</b>（同日配股又配息），
         公開資料無法把配股率與現金股利分離，<b>這部分未修正</b>，
         實際合理價可能再低一些。`);
    }
    if (a.approx) {
      parts.push(`上櫃來源未提供財報基準季，此處以近 150 天內是否除權作近似判斷。`);
    }
    box.innerHTML = `<span class="dn-ico">⚖︎</span><div>${parts.join("<br><br>")}</div>`;
    box.hidden = false;
  }

  function renderSummary(s, results) {
    const used = METHODS.filter((m) => !results[m.id].na && !offMethods.has(m.id))
                        .map((m) => results[m.id]);
    const cheap = median(used.map((r) => r.cheap));
    const fair = median(used.map((r) => r.fair));
    const rich = median(used.map((r) => r.rich));

    el.tCheap.textContent = fmt(cheap);
    el.tFair.textContent = fmt(fair);
    el.tRich.textContent = fmt(rich);
    // <i> 內的文字在窄螢幕會被 CSS 隱藏，只留數字避免三個刻度擠在一起
    el.gScaleL.innerHTML = "<i>便宜</i> <b>" + fmt(cheap) + "</b>";
    el.gScaleM.innerHTML = "<i>合理</i> <b>" + fmt(fair) + "</b>";
    el.gScaleR.innerHTML = "<i>昂貴</i> <b>" + fmt(rich) + "</b>";
    el.gaugePrice.textContent = fmt(s.p);

    if (cheap === null || !(cheap < rich)) {
      el.gaugeMark.style.left = "50%";
      el.verdict.className = "verdict";
      el.verdict.textContent = used.length
        ? "各方法估值差異過大或參數異常，無法整合出位階，請參考個別方法。"
        : "目前沒有任何可用的估價法（可能是虧損且不配息），或所有方法都被取消勾選。";
      return;
    }

    // 位階尺標：便宜段 0–25%、合理段 25–75%（合理價落在 50%）、昂貴段 75–100%
    const map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
    let pos;
    if (s.p <= cheap)      pos = clamp(map(s.p, cheap * 0.6, cheap, 2, 25), 2, 25);
    else if (s.p <= fair)  pos = map(s.p, cheap, fair, 25, 50);
    else if (s.p <= rich)  pos = map(s.p, fair, rich, 50, 75);
    else                   pos = clamp(map(s.p, rich, rich * 1.6, 75, 98), 75, 98);
    el.gaugeMark.style.left = pos.toFixed(1) + "%";

    const gap = (s.p / fair - 1) * 100;
    const vs = gap >= 0 ? `高於合理價 ${fmt(Math.abs(gap), 1)}%`
                        : `低於合理價 ${fmt(Math.abs(gap), 1)}%`;
    let cls, txt;
    if (s.p < cheap) {
      cls = "is-cheap";
      txt = `現價 <b>${fmt(s.p)}</b> 元<b>低於便宜價 ${fmt(cheap)}</b> 元，${vs}，在四法整合的區間中屬於<b>便宜</b>位階。`;
    } else if (s.p < fair) {
      cls = "is-cheap";
      txt = `現價 <b>${fmt(s.p)}</b> 元位於便宜價與合理價之間，${vs}，屬<b>合理偏低</b>位階。`;
    } else if (s.p < rich) {
      cls = "is-fair";
      txt = `現價 <b>${fmt(s.p)}</b> 元位於合理價與昂貴價之間，${vs}，屬<b>合理偏高</b>位階。`;
    } else {
      cls = "is-rich";
      txt = `現價 <b>${fmt(s.p)}</b> 元<b>高於昂貴價 ${fmt(rich)}</b> 元，${vs}，屬<b>昂貴</b>位階。`;
    }
    el.verdict.className = "verdict " + cls;
    el.verdict.innerHTML = txt + `<br><span style="opacity:.8;font-size:12.5px">
      綜合 ${used.length} 種估價法的中位數計算；不同方法適用的公司類型不同，數字僅供比較參考。</span>`;
  }

  // ═══════════════════════════════════════════════════════
  //  搜尋
  // ═══════════════════════════════════════════════════════
  function search(kw) {
    const raw = kw.trim();
    let out = rawSearch(raw);
    // 選定股票後搜尋框會留著「2330 台積電」，使用者接著打字就變成搜不到的字串。
    // 這時改用其中任一段重新尋找，讓輸入不會卡住。
    if (!out.length && /\s/.test(raw)) {
      for (const part of raw.split(/\s+/)) {
        out = rawSearch(part);
        if (out.length) break;
      }
    }
    return out;
  }

  function rawSearch(kw) {
    kw = kw.trim().toLowerCase();
    if (!kw) return [];
    const starts = [], contains = [];
    for (const s of STOCKS) {
      const code = s.c.toLowerCase(), name = s.n.toLowerCase();
      if (code === kw) return [s, ...STOCKS.filter((x) => x !== s &&
             (x.c.startsWith(kw) || x.n.includes(kw))).slice(0, 11)];
      if (code.startsWith(kw) || name.startsWith(kw)) starts.push(s);
      else if (name.includes(kw)) contains.push(s);
      if (starts.length > 30) break;
    }
    return [...starts, ...contains].slice(0, 12);
  }

  function showSuggest(list, kw) {
    sugIdx = -1;
    if (!list.length) {
      const q = (kw || "").trim();
      if (!q) { el.suggest.hidden = true; return; }
      el.suggest.innerHTML =
        `<li class="no-hit">找不到「${q}」——請輸入股票代號或公司名稱</li>`;
      el.suggest.hidden = false;
      return;
    }
    el.suggest.innerHTML = list.map((s) => `
      <li data-code="${s.c}">
        <span class="s-code">${s.c}</span>
        <span class="s-name">${s.n}</span>
        <span class="s-meta">${s.m}　${fmt(s.p)} 元</span>
      </li>`).join("");
    el.suggest.hidden = false;
    el.suggest.querySelectorAll("li[data-code]").forEach((li) =>
      li.addEventListener("mousedown", (e) => { e.preventDefault(); select(li.dataset.code); }));
  }

  function select(code) {
    const s = INDEX.get(code);
    if (!s) return;
    current = s;
    el.q.value = `${s.c} ${s.n}`;
    el.suggest.hidden = true;
    el.clearBtn.hidden = false;
    el.empty.hidden = true;
    el.result.hidden = false;
    history.replaceState(null, "", "#" + code);
    render();
    if (window.scrollY > 220) el.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ═══════════════════════════════════════════════════════
  //  資料載入
  // ═══════════════════════════════════════════════════════
  let TRADE_DATE = {};   // { 上市: "YYYY-MM-DD", 上櫃: "YYYY-MM-DD" }

  function ingest(payload) {
    STOCKS = payload.stocks;
    INDEX = new Map(STOCKS.map((s) => [s.c, s]));
    TRADE_DATE = payload.trade_date || {};
    STOCKS.forEach((s) => (s._date = TRADE_DATE[s.m] || payload.updated_at || ""));
    const dates = [...new Set(Object.values(TRADE_DATE).filter(Boolean))].sort();
    el.dataDate.textContent = dates.length
      ? "資料日 " + dates[dates.length - 1] : "資料日 —";
    el.dataCount.textContent = `${payload.count || STOCKS.length} 檔上市櫃個股`;
  }

  async function boot() {
    try {
      const [latest, bands, exr] = await Promise.all([
        fetch("data/latest.json?t=" + Date.now()).then((r) => {
          if (!r.ok) throw new Error("latest.json " + r.status);
          return r.json();
        }),
        fetch("data/bands.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                .catch(() => null),
        fetch("data/exrights.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                   .catch(() => null),
      ]);
      ingest(latest);
      if (bands && bands.bands) BANDS = bands.bands;
      if (exr && exr.events) EXRIGHTS = exr.events;
      el.loading.hidden = true;

      const hash = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (hash && INDEX.has(hash)) select(hash);
    } catch (err) {
      el.loading.hidden = true;
      showError("讀不到股價資料",
        `無法載入 <code>data/latest.json</code>（${err.message}）。<br>
         若是在本機直接以檔案開啟網頁，瀏覽器會擋下讀取，請改用
         <code>python3 -m http.server</code> 起一個本機伺服器再瀏覽。`);
    }
  }

  let noteTimer = null;
  /** kind: "error"（紅）／"warn"（黃）／"ok"（綠，數秒後自動收起） */
  function showNote(kind, title, html) {
    clearTimeout(noteTimer);
    el.errorBox.hidden = false;
    el.errorBox.className = "state-msg state-" + kind;
    el.errorBox.innerHTML = `<b>${title}</b>${html}`;
    if (kind === "ok") noteTimer = setTimeout(() => (el.errorBox.hidden = true), 8000);
  }
  const showError = (title, html) => showNote("error", title, html);

  // ── 直接向交易所抓當日最新資料（走 CORS 代理）─────────────
  const PROXIES = [
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  ];

  async function viaProxy(url) {
    for (const p of PROXIES) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(p(url), { signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) return await r.json();
      } catch (_) { /* 換下一個代理 */ }
    }
    return null;
  }

  const num = (v) => {
    const f = parseFloat(String(v).replace(/,/g, ""));
    return isFinite(f) && f > 0 ? f : null;
  };
  const isCommon = (c) => /^\d{4}$/.test(c);

  async function refresh() {
    const btn = el.refreshBtn;
    btn.disabled = true; btn.classList.add("busy");
    el.errorBox.hidden = true;
    const twseRows = [], tpexRows = [];
    let twseDate = null, tpexDate = null;

    // 上市：往前找最近有資料的交易日
    for (let back = 0; back < 6 && !twseDate; back++) {
      const d = new Date(Date.now() + 8 * 3600e3 - back * 86400e3);
      const ds = d.toISOString().slice(0, 10).replace(/-/g, "");
      const j = await viaProxy(
        `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${ds}&selectType=ALL&response=json`);
      if (!j || j.stat !== "OK" || !j.data) continue;
      twseDate = ds.slice(0, 4) + "-" + ds.slice(4, 6) + "-" + ds.slice(6);
      j.data.forEach((r) => {
        const c = String(r[0]).trim(), p = num(r[2]);
        if (!isCommon(c) || !p) return;
        twseRows.push({ c, n: String(r[1]).trim(), m: "上市", p,
                        y: num(r[3]), pe: num(r[5]), pb: num(r[6]), fq: String(r[7] || "") });
      });
    }

    // 上櫃（用 tpex_mainboard_quotes，比 daily_close_quotes 小十倍）
    const [pe, qt] = await Promise.all([
      viaProxy("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis"),
      viaProxy("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"),
    ]);
    if (pe && qt) {
      const close = new Map(qt.map((r) => [String(r.SecuritiesCompanyCode).trim(), num(r.Close)]));
      pe.forEach((r) => {
        const c = String(r.SecuritiesCompanyCode).trim(), p = close.get(c);
        if (!isCommon(c) || !p) return;
        const roc = String(r.Date);
        if (!tpexDate && roc.length === 7) {
          tpexDate = (+roc.slice(0, 3) + 1911) + "-" + roc.slice(3, 5) + "-" + roc.slice(5);
        }
        tpexRows.push({ c, n: String(r.CompanyName).trim(), m: "上櫃", p,
                        y: num(r.YieldRatio), pe: num(r.PriceEarningRatio),
                        pb: num(r.PriceBookRatio), fq: "" });
      });
    }

    btn.disabled = false; btn.classList.remove("busy");

    if (!twseRows.length && !tpexRows.length) {
      showError("即時更新失敗",
        `瀏覽器受同源政策限制無法直接連線交易所，本站改走公共 CORS 代理，
         而代理此刻沒有回應。<br>頁面仍在使用每日自動更新的資料，功能不受影響。`);
      return;
    }

    // 只替換抓成功的市場，另一個市場沿用原本每日更新的資料，
    // 否則使用者手上正在看的個股會突然從清單中消失。
    const kept = STOCKS.filter((s) =>
      (s.m === "上市" && !twseRows.length) || (s.m === "上櫃" && !tpexRows.length));
    const fresh = [...twseRows, ...tpexRows];

    // 補算每股數字，與後端腳本同一套公式
    fresh.forEach((s) => {
      s.eps = s.pe ? +(s.p / s.pe).toFixed(4) : null;
      s.bvps = s.pb ? +(s.p / s.pb).toFixed(4) : null;
      s.roe = (s.pe && s.pb) ? +((s.pb / s.pe) * 100).toFixed(3) : null;
      s.d = s.y ? +((s.p * s.y) / 100).toFixed(4) : null;
    });

    const rows = [...kept, ...fresh].sort((a, b) => a.c.localeCompare(b.c));
    ingest({
      stocks: rows, count: rows.length,
      trade_date: {
        上市: twseRows.length ? twseDate : TRADE_DATE["上市"],
        上櫃: tpexRows.length ? tpexDate : TRADE_DATE["上櫃"],
      },
      updated_at: new Date().toLocaleString("zh-TW"),
    });
    if (current) { current = INDEX.get(current.c) || current; render(); }

    const done = [], failed = [];
    (twseRows.length ? done : failed).push("上市");
    (tpexRows.length ? done : failed).push("上櫃");

    // 沒抓到的市場，如果日期已經跟這次抓到的交易日一致，就沒有任何資料落後，
    // 不需要拿警告去嚇人——那只是「本來就已經是最新的，不必更新」。
    const newest = [twseDate, tpexDate].filter(Boolean).sort().pop();
    const stale = failed.filter((m) => TRADE_DATE[m] && newest && TRADE_DATE[m] < newest);
    const total = done.map((m) => `${m} ${m === "上市" ? twseRows.length : tpexRows.length} 檔`);

    if (!stale.length) {
      showNote("ok", "已是最新資料",
        failed.length
          ? `重新抓取了${total.join("、")}，${failed.join("、")}原本就已經是 ${newest}
             的收盤資料，不需要更新。全站 ${STOCKS.length} 檔都是最新的。`
          : `已更新 ${total.join("、")}，資料日 ${newest}。`);
    } else {
      showNote("warn", `${stale.join("、")}沒有更新到`,
        `已重新抓取${total.join("、")}（${newest}）；<b>${stale.join("、")}</b>的代理連線失敗，
         仍顯示每日排程抓到的 ${stale.map((m) => TRADE_DATE[m]).join("、")} 資料。
         這些數字本身是正確的，只是日期較舊。`);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  參數 / 主題 / 事件
  // ═══════════════════════════════════════════════════════
  const PIDS = { pUseBands: "useBands", pPeLo: "peLo", pPeMid: "peMid", pPeHi: "peHi",
                 pPbLo: "pbLo", pPbMid: "pbMid", pPbHi: "pbHi",
                 pYHi: "yHi", pYMid: "yMid", pYLo: "yLo",
                 pR: "r", pG: "g", pMos: "mos" };

  function readParams() {
    for (const [id, key] of Object.entries(PIDS)) {
      const node = $(id);
      if (!node) continue;
      if (node.type === "checkbox") params[key] = node.checked;
      else {
        const v = parseFloat(node.value);
        if (isFinite(v) && v > 0) params[key] = v;
      }
    }
    localStorage.setItem("fv_params", JSON.stringify(params));
    if (current) render();
  }
  function writeParams() {
    for (const [id, key] of Object.entries(PIDS)) {
      const node = $(id);
      if (!node) continue;
      if (node.type === "checkbox") node.checked = params[key];
      else node.value = params[key];
    }
  }

  function initTheme() {
    const saved = localStorage.getItem("fv_theme");
    const dark = saved ? saved === "dark"
                       : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  function bind() {
    el.q.addEventListener("input", () => {
      el.clearBtn.hidden = !el.q.value;
      showSuggest(search(el.q.value), el.q.value);
    });
    // 聚焦時整串選起來，下一次打字直接覆蓋掉上次選定的「代號 名稱」
    el.q.addEventListener("focus", () => {
      if (el.q.value) { el.q.select(); showSuggest(search(el.q.value), el.q.value); }
    });
    el.q.addEventListener("blur", () => setTimeout(() => (el.suggest.hidden = true), 120));
    el.q.addEventListener("keydown", (e) => {
      const items = [...el.suggest.querySelectorAll("li[data-code]")];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        sugIdx = (sugIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle("active", i === sugIdx));
        items[sugIdx].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items.length) select(items[Math.max(0, sugIdx)].dataset.code);
      } else if (e.key === "Escape") {
        el.suggest.hidden = true;
      }
    });
    el.clearBtn.addEventListener("click", () => {
      el.q.value = ""; el.clearBtn.hidden = true; el.suggest.hidden = true; el.q.focus();
    });
    document.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => select(c.dataset.code)));

    Object.keys(PIDS).forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener("change", readParams);
    });
    el.resetParams.addEventListener("click", () => {
      params = { ...DEFAULTS };
      writeParams();
      localStorage.removeItem("fv_params");
      if (current) render();
    });

    el.refreshBtn.addEventListener("click", refresh);
    el.themeBtn.addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      localStorage.setItem("fv_theme", dark ? "light" : "dark");
    });
    addEventListener("hashchange", () => {
      const h = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (h && INDEX.has(h) && (!current || current.c !== h)) select(h);
    });
  }

  // ── 啟動 ────────────────────────────────────────────────
  initTheme();
  try {
    const saved = JSON.parse(localStorage.getItem("fv_params") || "null");
    if (saved) params = { ...DEFAULTS, ...saved };
    const off = JSON.parse(localStorage.getItem(OFF_KEY) || "[]");
    offMethods = new Set(off);
  } catch (_) { /* 忽略毀損的設定 */ }
  writeParams();
  bind();
  boot();
})();
