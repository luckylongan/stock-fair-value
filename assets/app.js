/* 幾塊你要買？ —— 台股財務計算工具箱
 *
 * 定位：對公開財務數字做機械式的乘除運算並顯示結果。
 * 倍數、成長率、目標殖利率等假設一律由使用者設定，本站不替任何個股
 * 設定「應該」的價位，也不對計算結果作評價或給買賣建議。
 *
 * 資料：證交所／櫃買中心／公開資訊觀測站之公開資料，每交易日更新。
 */
(() => {
  "use strict";

  // 兩個版本共用這份程式碼，只有呈現層不同，公式與資料完全一致：
  //   calc（index.html）= 財務計算工具箱，中性用語、不作評價
  //   pro （pro.html）  = 專業版，紅綠配色、位階與進場條件判定
  // 這樣公式只維護一處，不會兩版改到不一致。
  const MODE = document.body.dataset.mode === "pro" ? "pro" : "calc";
  const isPro = MODE === "pro";

  // ── 狀態 ────────────────────────────────────────────────
  let STOCKS = [];        // 全市場個股
  let BANDS = {};         // 代號 -> {pe:[P20,P50,P80], pb:[...], y:[...]}
  let EXRIGHTS = {};      // 代號 -> [{d:除權日, k:配股率, cash:現金股利}]
  let QUARTERLY = {};     // 代號 -> {y, q, cum:累計EPS, rev:累計營收, ni:累計淨利}
  let QHISTORY = {};      // 代號 -> {"114/4":{e,r,n}, ...} 逐期財報，供算成長率
  let REVENUE = {};       // 代號 -> {ym, mo:已過月數, cum:累計營收, yoy}
  let CASHFLOW = {};      // 代號 -> {y, q, ocf:年初至今累計營業現金流（百萬元）}
  let INDEX = new Map();  // 代號 -> 個股
  let current = null;     // 目前選定的個股
  let sugIdx = -1;        // 建議清單游標

  const DEFAULTS = {
    useBands: true,
    peLo: 10, peMid: 15, peHi: 20,
    pbLo: 0.8, pbMid: 1.2, pbHi: 1.8,
    yHi: 6.25, yMid: 5, yLo: 3.125,
    r: 8, g: 2, mos: 25,
    psLo: 0.6, psMid: 1.2, psHi: 2.5,
    ocfLo: 8, ocfMid: 15, ocfHi: 25,
    pegLo: 0.75, pegMid: 1, pegHi: 1.5,
    gCap: 40,
    customEps: 0,        // >0 時覆寫所有預估型 EPS，0 = 用網站算的
    grahamG: 5, grahamSpan: 2,
  };
  // 加了新方法就換 key：舊的儲存值不含新方法，沿用會讓預設關閉的項目被誤開
  const OFF_KEY = "fv_off_methods_v3";
  // 股價營收比的合理倍數因產業而異極大（軟體 5~10 倍、通路 <0.5 倍），
  // 用一組固定預設值套全市場只會污染綜合中位數，所以預設不納入，
  // 讓使用者依同業調好參數後自行勾選 —— 對虧損股它仍是少數可用的方法之一。
  const DEFAULT_OFF = ["ps"];
  let params = { ...DEFAULTS };
  let offMethods = new Set(DEFAULT_OFF);

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["q", "suggest", "clearBtn", "loading", "errorBox", "result", "empty", "methods",
   "sName", "sCode", "sMarket", "sDate", "sPrice", "sEps", "sBvps", "sRoe", "sDps",
   "sPe", "sPb", "sY", "sFq", "sMc", "sSh", "sCap", "sNi",
   "tCheap", "tFair", "tRich", "gaugeMark", "gaugePrice",
   "gScaleL", "gScaleM", "gScaleR", "verdict", "dataDate", "dataCount",
   "refreshBtn", "themeBtn", "resetParams", "pUseBands"].forEach((k) => (el[k] = $(k)));

  // ── 小工具 ──────────────────────────────────────────────
  // 帶變數的訊息沒辦法像 HTML 那樣把中英兩份都寫死靠 CSS 切，
  // 每則寫成一個函式，兩種語言各一份，由 M() 依目前語言取用。
  const L = () => (window.I18N ? window.I18N.lang : "zh");
  const M = () => MSG[L()] || MSG.zh;
  const pick = (zh, en) => (L() === "en" ? en : zh);
  const X = () => pick(" 倍", "x");          // 倍數單位
  const nt = (v, d = 2) => pick(fmt(v, d) + " 元", "NT$" + fmt(v, d));
  /** 大數字（原始值的單位是百萬）換成看得懂的級距。中文用億／兆，英文用 B／T ——
   *  兩邊的進位不一樣（億是 1e8、billion 是 1e9），不能只換單位字。 */
  const big = (m) => {
    if (m === null || m === undefined || !isFinite(m)) return "—";
    const a = Math.abs(m);
    if (L() === "en") {
      if (a >= 1e6) return fmt(m / 1e6, 2) + "T";
      if (a >= 1e3) return fmt(m / 1e3, 1) + "B";
      return fmt(m, 1) + "M";
    }
    if (a >= 1e6) return fmt(m / 1e6, 2) + " 兆";       // 1 兆 = 100 萬個百萬
    if (a >= 100) return fmt(m / 100, 1) + " 億";        // 1 億 = 100 個百萬
    return fmt(m, 1) + " 百萬";
  };
  const money = (m) => (m === null || m === undefined || !isFinite(m))
    ? "—" : pick(big(m), "NT$" + big(m));

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
  //  訊息字典（台股個股兩版共用）
  // ═══════════════════════════════════════════════════════
  const MSG = {
    zh: {
      tagBands: "近 5 年區間", tagFixed: "固定倍數", tagYours: "你的參數", tagInputs: "參數",
      names: {
        pefwd: ["本益比法", "年化 EPS"], pe: ["本益比法", "近四季"],
        peg: ["本益成長比", ""], rev: ["月營收動能法", ""],
        graham: ["葛拉漢公式", "成長版"], gnum: ["葛拉漢數字", "上限版"],
        ocf: ["股價營業現金流比", ""], roe: ["ROE 法", ""],
        pb: ["股價淨值比法", ""], ps: ["股價營收比", ""], div: ["股利法", ""],
      },
      proCols: ["便宜價", "合理價", "昂貴價"],
      colLo: "低", colMid: "中", colHi: "高",
      labelMultiple: (v) => `${fmt(v)} 倍`,
      labelPb: (v) => `P/B ${fmt(v)} 倍`,
      labelYield: (v) => `殖利率 ${fmt(v)}%`,
      labelPeg: (v) => `PEG ${fmt(v, 2)}`,
      labelProduct: (v) => `乘積 ${fmt(v, 1)}`,
      tagCeiling: "不含成長假設",
      srcOcf: (v) => `每股營業現金流 ${fmt(v)} 元`,
      gnBasis: (pe, pb) =>
        `本益比 ${fmt(pe[0])} / ${fmt(pe[1])} / ${fmt(pe[2])}　×　` +
        `股價淨值比 ${fmt(pb[0])} / ${fmt(pb[1])} / ${fmt(pb[2])}`,
      labelG: (v) => `g ${fmt(v, 1)}%`,
      tagCustomEps: "你輸入的 EPS",
      tagAnnualized: (y, q) => `年化 · ${y}Q${q}`,
      tagRevenue: (ym) => `營收 · ${ym}`,
      tagGrowth: (g) => `成長 ${fmt(g, 0)}%`,
      tagGraham: (g) => `g ${fmt(g, 1)}%`,
      tagCurrent: (v) => `目前 ${fmt(v)} 倍`,
      srcCustomEps: (e) => `EPS ${fmt(e)} 元（自訂）`,
      srcQuarter: (y, q) => `依 ${y}Q${q} 季報`,
      srcMonth: (ym) => `依 ${ym} 月營收`,
      srcPrevYear: (y) => `對比 ${y} 年度`,
      srcSps: (v) => `每股營收 ${fmt(v)} 元`,
      srcEps: (e, src) => `EPS ${fmt(e)} 元 · ${src}`,
      epsSrcCustom: "自訂", epsSrcRevenue: "月營收推估",
      epsSrcQuarter: "季報年化", epsSrcTtm: "近四季 EPS",
      shares: "股",
      dataDate: (d) => `資料日 ${d}`,
      dataDateNone: "資料日 —",
      count: (n) => `${n} 檔上市櫃個股`,
      closeOn: (d) => `收盤 ${d}`,
      includeAria: "是否納入綜合評估",
      scaleMin: "最小", scaleMid: "中位數", scaleMax: "最大",
      usedCount: (n) => `納入 ${n} 種公式`,
      scaleCheap: "便宜", scaleFair: "合理", scaleRich: "昂貴",
      pricePrefix: "現價",
      noHit: (q) => `找不到「${q}」——請輸入股票代號或公司名稱`,
      // 個股卡 / 彙總 / 狀態
      market: { "上市": "上市", "上櫃": "上櫃" },
      dilutionMain: (list, factor, rawEps, eps, rawBvps, bvps) =>
        `本檔於 ${list}。交易所公布的本益比與股價淨值比在除權後，是用已稀釋的股價
         除以尚未按新股本重算的每股盈餘，因此本站已把 EPS 與每股淨值除以
         <b>${fmt(factor, 4)}</b> 還原成攤薄後的數字
         （EPS ${fmt(rawEps)} → <b>${fmt(eps)}</b>，
         每股淨值 ${fmt(rawBvps)} → <b>${fmt(bvps)}</b>）。`,
      dilutionEvent: (d, k) => `<b>${d}</b> 配股 <b>${fmt(k * 100, 1)}%</b>`,
      dilutionUnknown: (dates) =>
        `另有 ${dates} 的<b>權息</b>（同日配股又配息），
         公開資料無法把配股率與現金股利分離，<b>這部分未修正</b>，
         實際對應價可能再低一些。`,
      dilutionApprox: "上櫃來源未提供財報基準季，此處以近 150 天內是否除權作近似判斷。",
      proNoRank: "各公式結果差異過大或參數異常，無法整合出位階，請看下方個別公式。",
      proNone: "目前沒有任何公式可計算（多半是虧損且不配息），或所有公式都被取消勾選。",
      proHeadCheap: (p, cheap, gap) =>
        `現價 <b>${fmt(p)}</b> 元已<b>低於便宜價 ${fmt(cheap)}</b> 元 (低 ${fmt(gap, 1)}%)`,
      proHeadNearby: (p, higher, vs) =>
        `現價 <b>${fmt(p)}</b> 元位於便宜價與合理價之間，${higher ? "高" : "低"}於合理價 ${fmt(vs, 1)}%`,
      proHeadFair: (p, vs) =>
        `現價 <b>${fmt(p)}</b> 元位於合理價與昂貴價之間，高於合理價 ${fmt(vs, 1)}%`,
      proHeadRich: (p, rich, vs) =>
        `現價 <b>${fmt(p)}</b> 元已<b>高於昂貴價 ${fmt(rich)}</b> 元，高於合理價 ${fmt(vs, 1)}%`,
      proActEnter: "<b>符合進場條件</b>　依上述規則，現價落在「進場區」。",
      proActNear: (cheap, diff, gap) =>
        `<b>接近進場</b>　距便宜價 ${fmt(cheap)} 元還差 <b>${fmt(diff)} 元（${fmt(gap, 1)}%）</b>。`,
      proActHigh: (cheap, diff, gap) =>
        `<b>偏高</b>　距便宜價 ${fmt(cheap)} 元還差 <b>${fmt(diff)} 元（${fmt(gap, 1)}%）</b>。`,
      proActHot: (cheap, diff, gap) =>
        `<b>過熱</b>　距便宜價 ${fmt(cheap)} 元還差 <b>${fmt(diff)} 元（${fmt(gap, 1)}%）</b>。`,
      proThin: (n) =>
        `<span class="verdict-thin">⚠︎ 目前只有 ${n} 種公式可計算，
         三個價位等同單一模型的輸出，位階判定沒有參考意義。</span>`,
      proNote: (n) =>
        `<span class="verdict-note">位階由 ${n} 種公式各欄的中位數比對而得，
         門檻即上方三個價位，改「計算參數」就會改變。這是機械式的規則判定，
         不預測股價、不考慮產業前景與個人財務狀況，<b>不構成投資建議</b>。</span>`,
      sumSingle: "目前納入的公式只產生單一數值，無法做分佈統計，請直接看下方各公式的計算結果。",
      sumNone: "目前沒有任何公式可計算（多數公式需要獲利或股利為正），或所有公式都被取消勾選。",
      verdict: (p, used, all, lo, hi, md, pct, sign, vs) =>
        `現價 <b>${fmt(p)}</b> 元。目前納入 <b>${used}</b> 種公式、
         共 <b>${all}</b> 個計算值，範圍 <b>${fmt(lo)}</b> ～ <b>${fmt(hi)}</b> 元，
         中位數 <b>${fmt(md)}</b> 元。<br>
         現價高於其中 <b>${fmt(pct, 0)}%</b> 的計算值，
         與中位數相差 <b>${sign}${fmt(vs, 1)}%</b>。
         <span class="verdict-note">以上為敘述統計，計算值取決於你在「計算參數」中設定的倍數與假設，
         本站不對這些數值作任何評價，也不構成買賣建議。</span>`,
      verdictThin: (n, psHint) =>
        `<span class="verdict-thin">⚠︎ 目前只有 ${n} 種公式可計算（多數需要獲利為正），
         統計量等同單一模型的輸出，離散程度沒有參考意義。${psHint}</span>`,
      psHint: "本檔的<b>股價營收比</b>算得出來但預設未納入 —— 依同業設定倍數後可勾選納入。",
      loadFailTitle: "讀不到股價資料",
      loadFail: (m) =>
        `無法載入 <code>data/latest.json</code>（${m}）。<br>
         若是在本機直接以檔案開啟網頁，瀏覽器會擋下讀取，請改用
         <code>python3 -m http.server</code> 起一個本機伺服器再瀏覽。`,
      refreshFailTitle: "即時更新失敗",
      refreshFail:
        `瀏覽器受同源政策限制無法直接連線交易所，本站改走公共 CORS 代理，
         而代理此刻沒有回應。<br>頁面仍在使用每日自動更新的資料，功能不受影響。`,
      upToDateTitle: "已是最新資料",
      upToDateSome: (total, failed, newest, n) =>
        `重新抓取了${total}，${failed}原本就已經是 ${newest}
         的收盤資料，不需要更新。全站 ${n} 檔都是最新的。`,
      upToDateAll: (total, newest) => `已更新 ${total}，資料日 ${newest}。`,
      staleTitle: (stale) => `${stale}沒有更新到`,
      staleBody: (total, newest, stale, dates) =>
        `已重新抓取${total}（${newest}）；<b>${stale}</b>的代理連線失敗，
         仍顯示每日排程抓到的 ${dates} 資料。這些數字本身是正確的，只是日期較舊。`,
      marketCount: (m, n) => `${m} ${n} 檔`,
      listSep: "、",
      f: {
        ocfNoData: "尚無現金流量表資料（公司申報進度不一，本站每日累積），此法暫不適用。",
        ocfNoShares: "缺少在外流通股數，無法換算每股營業現金流。",
        ocfNegative: (y, q, v) =>
          `${y}Q${q} 累計營業活動現金流為 ${fmt(v / 100, 1)} 億元（非正值），` +
          "代表本業收到的現金不足以支應營運，此法不適用。金融保險業的現金流量表" +
          "結構不同，出現負值屬常態，不宜據此解讀。",
        ocfFormula: (y, q, cum, annual, sh, ps, cur, lo, mid, hi) =>
          `年化營業現金流 ＝ ${y}Q${q} 累計 ${fmt(cum / 100, 1)} 億 ÷ ${q} 季 × 4 ＝ ${fmt(annual / 100, 1)} 億<br>` +
          `每股營業現金流 ＝ ${fmt(annual / 100, 1)} 億 ÷ ${fmt(sh / 100, 1)} 億股 ＝ ${fmt(ps)} 元　` +
          `目前 ${fmt(cur)} 倍<br>` +
          `對應價 ＝ ${fmt(ps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 這是<b>營業</b>現金流，還沒扣資本支出 —— 公開資訊觀測站的彙總` +
          `現金流量表只有三大活動的合計，沒有資本支出欄位，所以台股算不出美股頁那種自由現金流。` +
          `重資本支出的產業（半導體、電信、航運）實際能自由運用的錢會比這裡少很多。<br>` +
          `另外現金流受營運資金波動影響很大，用半年推全年容易失真（存貨、應收帳款的季節性），` +
          `建議搭配多年趨勢一起看。</span>`,
        gnNoEps: "近四季每股盈餘為負或無資料，葛拉漢數字需要正的盈餘。",
        gnNoBvps: "缺少每股淨值資料，葛拉漢數字需要盈餘與淨值兩者。",
        gnFormula: (pe, pb, prod, eps, bvps, vals) =>
          `葛拉漢數字 ＝ √(目標本益比 × 目標股價淨值比 × EPS × 每股淨值)<br>` +
          `乘積 ＝ ${fmt(pe[0])}×${fmt(pb[0])} / ${fmt(pe[1])}×${fmt(pb[1])} / ${fmt(pe[2])}×${fmt(pb[2])}` +
          `　＝ ${fmt(prod[0], 1)} / ${fmt(prod[1], 1)} / ${fmt(prod[2], 1)}<br>` +
          `代入 EPS ${fmt(eps)} × 每股淨值 ${fmt(bvps)} 開根號 ＝ ` +
          `${fmt(vals[0])} / ${fmt(vals[1])} / ${fmt(vals[2])} 元` +
          `<br><span class="formula-warn">※ <b>這和上面的葛拉漢公式是兩回事。</b>` +
          `公式 V ＝ EPS × (8.5 + 2g) 是<b>估值</b>，吃你輸入的成長率，g 給多少答案就差多少；` +
          `這個數字是<b>上限</b>，完全不含成長假設，只是把「本益比」與「股價淨值比」兩個條件` +
          `同時套上去，算出兩者都不超標的最高價格。<br>` +
          `葛拉漢原始的門檻是本益比 15 × 股價淨值比 1.5 ＝ 22.5；這裡直接沿用你在參數區設定的` +
          `倍數配對相乘，把那兩個數字設成 15 與 1.5 就會回到原始版本。` +
          `它對輕資產、高成長公司天生嚴苛（淨值低），不適合單獨使用。</span>`,
        dilutionAdj: (list, factor) =>
          `<br><span class="formula-adj">↳ 已依 ${list} 攤薄（÷ ${fmt(factor, 4)}）</span>`,
        dilutionItem: (d, k) => `${d} 配股 ${fmt(k * 100, 1)}%`,
        roeNoBvps: "缺少每股淨值資料（無股價淨值比），無法估算。",
        roeNoRoe: "缺少 ROE（需要本益比與股價淨值比同時存在），多因公司虧損。",
        roeGteR: "永續成長率 g 必須小於要求報酬率 r，模型無解，請調整參數。",
        roeLow: (roe, g) => `ROE ${fmt(roe)}% 未高於永續成長率 g ${fmt(g, 1)}%，模型會得出負值或極低估值，不適用。`,
        roeBasis: (r, g, mos) => `r ${fmt(r, 1)}%　g ${fmt(g, 1)}%　安全邊際 ${fmt(mos, 0)}%`,
        roeFormula: (roe, g, r, pb, rawBvps, bvps, diluted, fair, mos) =>
          `模型 P/B ＝ (ROE ${fmt(roe)}% − g ${fmt(g, 1)}%) ÷ (r ${fmt(r, 1)}% − g ${fmt(g, 1)}%) ＝ ${fmt(pb)} 倍` +
          (diluted ? `<br>每股淨值 ${fmt(rawBvps)} 依配股攤薄 → ${fmt(bvps)} 元` : "") +
          `<br>對應價 ＝ 每股淨值 ${fmt(bvps)} × ${fmt(pb)} ＝ ${fmt(fair)} 元<br>` +
          `上下限 ＝ 對應價 × (1 ∓ 安全邊際 ${fmt(mos, 0)}%)`,
        pbNoData: "來源未提供股價淨值比，無法推算每股淨值。",
        pbFormula: (p, pbr, raw, note, bvps, lo, mid, hi) =>
          `每股淨值 ＝ 收盤價 ${fmt(p)} ÷ 股價淨值比 ${fmt(pbr)} ＝ ${fmt(raw)} 元` + note +
          `<br>對應價 ＝ ${fmt(bvps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`,
        divNone: "近一年無現金股利（或殖利率為 0），股利法不適用。",
        divFormula: (p, y, d, yc, yf, yr) =>
          `每股現金股利 ＝ 收盤價 ${fmt(p)} × 殖利率 ${fmt(y)}% ＝ ${fmt(d)} 元<br>` +
          `對應價 ＝ ${fmt(d)} ÷ ${fmt(yc)}% / ${fmt(yf)}% / ${fmt(yr)}%<br>` +
          `（殖利率與價格成反比，殖利率越高對應的價格越低）`,
        customEpsFormula: (e, lo, mid, hi) =>
          `對應價 ＝ 你輸入的 EPS ${fmt(e)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 目前使用自訂 EPS，清空參數區的欄位即可改回依季報計算</span>`,
        fwdNoQuarter: "尚無季報資料（公司申報進度不一，本站每日累積），此法暫不適用。",
        fwdLoss: (y, q, cum) =>
          `最新季報（${y}Q${q}）累計每股盈餘為 ${fmt(cum)} 元，虧損無法年化，此法不適用。`,
        fwdRisk: { 1: "只用一季實績推全年，外推成分最重，淡旺季或一次性損益會被放大四倍",
                   2: "以半年實績推全年，淡旺季影響仍需留意",
                   3: "已有前三季實績，外推誤差較小",
                   4: "已是全年實績，沒有外推" },
        fwdFormula: (y, q, cum, raw, dil, eps, lo, mid, hi, mult, risk) =>
          `年化 EPS ＝ ${y}Q${q} 累計 ${fmt(cum)} ÷ ${q} 季 × 4 ＝ ${fmt(raw)} 元` +
          (dil > 1 ? `<br><span class="formula-adj">↳ 再依配股攤薄 ÷ ${fmt(dil, 4)} ＝ ${fmt(eps)} 元</span>` : "") +
          `<br>對應價 ＝ ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 以 ${q} 季實績外推全年（×${mult}）：${risk}</span>`,
        revNoTable: "月營收彙總表未收錄本檔（金融保險業沒有可比的營收概念）。",
        revNoQuarter: "缺少季報營收，無法推算每一元營收對應的獲利。",
        revLoss: (y, q) => `最新季報（${y}Q${q}）累計仍為虧損，無法用營收推估獲利。`,
        revNotPositive: "推估結果非正值，此法不適用。",
        revTrend: (yoy) => `，累計營收年增 <b>${fmt(yoy, 1)}%</b>`,
        revFormula: (cum, mo, annual, trend, y, q, qeps, qrev, raw, dil, eps, lo, mid, hi) =>
          `推估年營收 ＝ 累計 ${fmt(cum, 1)} 億 ÷ ${mo} 月 × 12 ＝ ${fmt(annual, 1)} 億${trend}<br>` +
          `每元營收獲利 ＝ ${y}Q${q} EPS ${fmt(qeps)} ÷ 營收 ${fmt(qrev, 1)} 億<br>` +
          `推估年 EPS ＝ ${fmt(annual, 1)} 億 × 該比率 ＝ ${fmt(raw)} 元` +
          (dil > 1 ? `<br><span class="formula-adj">↳ 再依配股攤薄 ÷ ${fmt(dil, 4)} ＝ ${fmt(eps)} 元</span>` : "") +
          `<br>對應價 ＝ ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 假設今年淨利率與季報一致；毛利率若明顯變動會失準</span>`,
        pegNoData: "缺少季報資料或今年累計為虧損，無法推估成長率。",
        pegNoPrev: (y) => `缺少 ${y} 年度全年每股盈餘，無法計算成長率（本站每日累積歷年財報）。`,
        pegPrevLoss: (y, p) => `${y} 年度為虧損（每股 ${fmt(p)} 元），由虧轉盈的成長率沒有意義，此法不適用。`,
        pegShrink: (e, p, g) =>
          `預估今年 EPS ${fmt(e)} 元低於去年 ${fmt(p)} 元（衰退 ${fmt(g, 1)}%），PEG 不適用於獲利衰退的公司。`,
        pegBasis: (lo, mid, hi) => `目標 PEG ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}`,
        pegFormula: (e, y, p, gRaw, capped, cap, g, lo, mid, hi) =>
          `成長率 ＝ 預估今年 ${fmt(e)} ÷ ${y} 年 ${fmt(p)} − 1 ＝ ${fmt(gRaw, 1)}%` +
          (capped ? `<br><span class="formula-adj">↳ 超過上限，以 ${fmt(cap, 0)}% 計算</span>` : "") +
          `<br>對應本益比 ＝ 成長率 ${fmt(g, 1)} × 目標 PEG<br>` +
          `對應價 ＝ ${fmt(e)} × ${fmt(g, 1)} × ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}` +
          `<br><span class="formula-warn">※ 以單一年度成長率外推，景氣循環股容易高估</span>`,
        psNoTable: "月營收彙總表未收錄本檔（金融保險業沒有可比的營收概念）。",
        psNoQuarter: "缺少季報營收或淨利，無法反推每股營收。",
        psBadSign: "季報每股盈餘與淨利符號不一致，資料異常，此法略過。",
        psNotPositive: "推估每股營收非正值。",
        psFormula: (annual, y, q, qeps, qni, sps, cur, lo, mid, hi) =>
          `每股營收 ＝ 推估年營收 ${fmt(annual, 1)} 億 × (${y}Q${q} EPS ${fmt(qeps)} ÷ 淨利 ${fmt(qni, 1)} 億)<br>` +
          `　　　　　＝ ${fmt(sps)} 元　目前股價營收比 ${fmt(cur)} 倍<br>` +
          `對應價 ＝ ${fmt(sps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 合理倍數因產業而異極大（軟體可達 5~10 倍、通路常低於 0.5 倍）。` +
          `因為沒有一組通用預設值，本法<b>預設不納入綜合評估</b> —— 請先依同業水準` +
          `調整上方參數，再勾選納入。它的價值在於營收恆為正，虧損公司也估得出來。</span>`,
        grahamNoEps: "缺少可用的每股盈餘（公司虧損），或你尚未在參數區輸入自訂 EPS。",
        grahamBasis: (g, span) => `成長率 g ${fmt(g, 1)}%（±${fmt(span, 1)}%）`,
        grahamFormula: (g0, g1, g2, m0, m1, m2, eps) =>
          `葛拉漢公式　V ＝ EPS × (8.5 + 2g)<br>` +
          `代入 g ＝ ${fmt(g0, 1)} / ${fmt(g1, 1)} / ${fmt(g2, 1)}%　→　倍數 ${fmt(m0)} / ${fmt(m1)} / ${fmt(m2)}<br>` +
          `V ＝ ${fmt(eps)} × 各倍數` +
          `<br><span class="formula-warn">※ 8.5 為葛拉漢 1962 年提出的零成長基準本益比，成長率 g 完全由你設定；` +
          `此式未考慮利率環境，原著另有以公司債殖利率調整的版本</span>`,
        peNoData: "來源未提供本益比（通常代表近四季為虧損），本益比法不適用。",
        peFormula: (p, pe, raw, note, eps, lo, mid, hi) =>
          `近四季 EPS ＝ 收盤價 ${fmt(p)} ÷ 本益比 ${fmt(pe)} ＝ ${fmt(raw)} 元` + note +
          `<br>對應價 ＝ ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍`,
      },
    },
    en: {
      tagBands: "5-year range", tagFixed: "Fixed multiple", tagYours: "Your inputs", tagInputs: "Inputs",
      names: {
        pefwd: ["P/E method", "forward"], pe: ["P/E method", "trailing"],
        peg: ["PEG ratio", ""], rev: ["Monthly revenue momentum", ""],
        graham: ["Graham formula", "growth"], gnum: ["Graham Number", "ceiling"],
        ocf: ["Price / operating cash flow", ""], roe: ["Return on equity", ""],
        pb: ["Price / book", ""], ps: ["Price / sales", ""], div: ["Dividend", ""],
      },
      proCols: ["Cheap", "Fair", "Expensive"],
      colLo: "Low", colMid: "Mid", colHi: "High",
      labelMultiple: (v) => `${fmt(v)}x`,
      labelPb: (v) => `P/B ${fmt(v)}x`,
      labelYield: (v) => `yield ${fmt(v)}%`,
      labelPeg: (v) => `PEG ${fmt(v, 2)}`,
      labelProduct: (v) => `product ${fmt(v, 1)}`,
      tagCeiling: "no growth assumption",
      srcOcf: (v) => `operating cash flow/share NT$${fmt(v)}`,
      gnBasis: (pe, pb) =>
        `P/E ${fmt(pe[0])} / ${fmt(pe[1])} / ${fmt(pe[2])}　×　` +
        `P/B ${fmt(pb[0])} / ${fmt(pb[1])} / ${fmt(pb[2])}`,
      labelG: (v) => `g ${fmt(v, 1)}%`,
      tagCustomEps: "your EPS",
      tagAnnualized: (y, q) => `annualized · ${y}Q${q}`,
      tagRevenue: (ym) => `revenue · ${ym}`,
      tagGrowth: (g) => `growth ${fmt(g, 0)}%`,
      tagGraham: (g) => `g ${fmt(g, 1)}%`,
      tagCurrent: (v) => `now ${fmt(v)}x`,
      srcCustomEps: (e) => `EPS ${fmt(e)} (your figure)`,
      srcQuarter: (y, q) => `from ${y}Q${q} filing`,
      srcMonth: (ym) => `from ${ym} revenue`,
      srcPrevYear: (y) => `vs FY${y}`,
      srcSps: (v) => `revenue/share NT$${fmt(v)}`,
      srcEps: (e, src) => `EPS NT$${fmt(e)} · ${src}`,
      epsSrcCustom: "your figure", epsSrcRevenue: "from monthly revenue",
      epsSrcQuarter: "annualized from filings", epsSrcTtm: "trailing 12M EPS",
      shares: "",
      dataDate: (d) => `Data as of ${d}`,
      dataDateNone: "Data as of —",
      count: (n) => `${n} TWSE / TPEx stocks`,
      closeOn: (d) => `close ${d}`,
      includeAria: "Include in the summary",
      scaleMin: "Min", scaleMid: "Median", scaleMax: "Max",
      usedCount: (n) => `${n} formula${n === 1 ? "" : "s"} included`,
      scaleCheap: "Cheap", scaleFair: "Fair", scaleRich: "Expensive",
      pricePrefix: "Price",
      noHit: (q) => `No match for "${q}" — enter a ticker or company name`,
      market: { "上市": "TWSE", "上櫃": "TPEx" },
      dilutionMain: (list, factor, rawEps, eps, rawBvps, bvps) =>
        `This stock had ${list}. After a stock dividend the exchange computes P/E and P/B from the
         <b>already-diluted price</b> divided by EPS that has <b>not</b> been restated for the new
         share count, so this site divides EPS and book value per share by <b>${fmt(factor, 4)}</b>
         to restore the diluted figures
         (EPS ${fmt(rawEps)} → <b>${fmt(eps)}</b>,
         book value per share ${fmt(rawBvps)} → <b>${fmt(bvps)}</b>).`,
      dilutionEvent: (d, k) => `a <b>${fmt(k * 100, 1)}%</b> stock dividend on <b>${d}</b>`,
      dilutionUnknown: (dates) =>
        `There was also a <b>combined stock and cash dividend</b> on ${dates}. Public data cannot
         separate the stock-dividend ratio from the cash portion, so <b>that part is not
         corrected</b> and the true figures may be slightly lower.`,
      dilutionApprox: "The TPEx source does not publish a fiscal reference quarter, so this uses a 150-day look-back as an approximation.",
      proNoRank: "The formulas disagree too widely, or the assumptions are out of range, so no position can be derived. Read the individual cards below.",
      proNone: "No formula can be computed right now (usually a loss-making, non-paying company), or every formula has been unticked.",
      proHeadCheap: (p, cheap, gap) =>
        `At <b>NT$${fmt(p)}</b> the price is <b>below the cheap price of NT$${fmt(cheap)}</b> (by ${fmt(gap, 1)}%)`,
      proHeadNearby: (p, higher, vs) =>
        `At <b>NT$${fmt(p)}</b> the price sits between the cheap and fair prices, ${higher ? "above" : "below"} fair by ${fmt(vs, 1)}%`,
      proHeadFair: (p, vs) =>
        `At <b>NT$${fmt(p)}</b> the price sits between the fair and expensive prices, above fair by ${fmt(vs, 1)}%`,
      proHeadRich: (p, rich, vs) =>
        `At <b>NT$${fmt(p)}</b> the price is <b>above the expensive price of NT$${fmt(rich)}</b>, and above fair by ${fmt(vs, 1)}%`,
      proActEnter: "<b>Meets the entry condition.</b>　By the rule above, the price falls in the entry zone.",
      proActNear: (cheap, diff, gap) =>
        `<b>Approaching entry.</b>　Still <b>NT$${fmt(diff)} (${fmt(gap, 1)}%)</b> above the cheap price of NT$${fmt(cheap)}.`,
      proActHigh: (cheap, diff, gap) =>
        `<b>On the high side.</b>　Still <b>NT$${fmt(diff)} (${fmt(gap, 1)}%)</b> above the cheap price of NT$${fmt(cheap)}.`,
      proActHot: (cheap, diff, gap) =>
        `<b>Overheated.</b>　Still <b>NT$${fmt(diff)} (${fmt(gap, 1)}%)</b> above the cheap price of NT$${fmt(cheap)}.`,
      proThin: (n) =>
        `<span class="verdict-thin">⚠︎ Only ${n} formula${n > 1 ? "s" : ""} can be computed right now,
         so the three prices amount to the output of a single model and the position reading means nothing.</span>`,
      proNote: (n) =>
        `<span class="verdict-note">The position comes from comparing the median of each column across
         ${n} formulas; the thresholds are the three prices above and change with your assumptions.
         This is a mechanical rule, not a forecast — it does not predict prices and takes no account
         of industry outlook or your personal finances. <b>It is not investment advice.</b></span>`,
      sumSingle: "The formulas currently included produce a single value, so there is no distribution to describe. Read the individual cards below.",
      sumNone: "No formula can be computed right now (most need positive earnings or a dividend), or every formula has been unticked.",
      verdict: (p, used, all, lo, hi, md, pct, sign, vs) =>
        `Price <b>NT$${fmt(p)}</b>. <b>${used}</b> formula${used > 1 ? "s" : ""} included, producing
         <b>${all}</b> values ranging <b>NT$${fmt(lo)}</b> to <b>NT$${fmt(hi)}</b>, median
         <b>NT$${fmt(md)}</b>.<br>
         The current price is above <b>${fmt(pct, 0)}%</b> of those values and differs from the
         median by <b>${sign}${fmt(vs, 1)}%</b>.
         <span class="verdict-note">These are descriptive statistics. The values depend entirely on
         the multiples and assumptions you set under "Assumptions". This site does not evaluate them
         and gives no buy or sell advice.</span>`,
      verdictThin: (n, psHint) =>
        `<span class="verdict-thin">⚠︎ Only ${n} formula${n > 1 ? "s" : ""} can be computed right now
         (most need positive earnings), so these statistics amount to the output of a single model and
         the spread means nothing. ${psHint}</span>`,
      psHint: "<b>Price / sales</b> is computable for this stock but excluded by default — set the multiples to the peer level, then tick it in.",
      loadFailTitle: "Could not load price data",
      loadFail: (m) =>
        `Failed to fetch <code>data/latest.json</code> (${m}).<br>
         If you opened this page directly from the filesystem the browser will block the request;
         run <code>python3 -m http.server</code> and browse through that instead.`,
      refreshFailTitle: "Live update failed",
      refreshFail:
        `The browser's same-origin policy blocks direct calls to the exchanges, so this site routes
         through a public CORS proxy — and the proxy is not responding right now.<br>
         The page is still using the daily scheduled data; nothing else is affected.`,
      upToDateTitle: "Already up to date",
      upToDateSome: (total, failed, newest, n) =>
        `Re-fetched ${total}. ${failed} was already on the ${newest} close and needed no update.
         All ${n} stocks are current.`,
      upToDateAll: (total, newest) => `Updated ${total}. Data as of ${newest}.`,
      staleTitle: (stale) => `${stale} was not updated`,
      staleBody: (total, newest, stale, dates) =>
        `Re-fetched ${total} (${newest}); the proxy connection for <b>${stale}</b> failed, so it still
         shows the ${dates} data from the daily schedule. Those figures are correct, just older.`,
      marketCount: (m, n) => `${m} ${n}`,
      listSep: ", ",
      f: {
        ocfNoData: "No cash flow statement yet (companies file on different schedules; this site accumulates them daily), so this method does not apply for now.",
        ocfNoShares: "No share count available, so operating cash flow per share cannot be computed.",
        ocfNegative: (y, q, v) =>
          `${y}Q${q} cumulative operating cash flow was NT$${fmt(v, 0)}M (not positive), meaning the ` +
          "core business did not generate enough cash to fund operations, so this method does not apply. " +
          "Financial and insurance companies structure their cash flow statements differently and " +
          "negative values are normal for them — do not read anything into it.",
        ocfFormula: (y, q, cum, annual, sh, ps, cur, lo, mid, hi) =>
          `Annualized operating cash flow = ${y}Q${q} cumulative NT$${fmt(cum, 0)}M ÷ ${q} quarters × 4 = NT$${fmt(annual, 0)}M<br>` +
          `Operating cash flow per share = ${fmt(annual, 0)}M ÷ ${fmt(sh, 0)}M shares = NT$${fmt(ps)}　` +
          `currently ${fmt(cur)}x<br>` +
          `Price = ${fmt(ps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ This is <b>operating</b> cash flow, before capital expenditure. ` +
          `The MOPS aggregate cash flow statement carries only the three activity totals and no capex line, ` +
          `so Taiwan cannot produce the free cash flow the US edition uses. Capital-intensive industries ` +
          `(semiconductors, telecom, shipping) keep far less than this figure suggests.<br>` +
          `Operating cash flow also swings with working capital, so annualizing from half a year is easily ` +
          `distorted by seasonal inventory and receivables. Read it alongside a multi-year trend.</span>`,
        gnNoEps: "Trailing twelve-month EPS is negative or unavailable; the Graham Number needs positive earnings.",
        gnNoBvps: "No book value per share available; the Graham Number needs both earnings and book value.",
        gnFormula: (pe, pb, prod, eps, bvps, vals) =>
          `Graham Number = √(target P/E × target P/B × EPS × book value per share)<br>` +
          `Product = ${fmt(pe[0])}×${fmt(pb[0])} / ${fmt(pe[1])}×${fmt(pb[1])} / ${fmt(pe[2])}×${fmt(pb[2])}` +
          `　= ${fmt(prod[0], 1)} / ${fmt(prod[1], 1)} / ${fmt(prod[2], 1)}<br>` +
          `With EPS ${fmt(eps)} × book value ${fmt(bvps)}, the square root gives ` +
          `NT$${fmt(vals[0])} / ${fmt(vals[1])} / ${fmt(vals[2])}` +
          `<br><span class="formula-warn">※ <b>This is not the Graham formula above.</b> ` +
          `That one, V = EPS × (8.5 + 2g), is a <b>valuation</b> driven by the growth rate you enter — ` +
          `change g and the answer changes with it. This one is a <b>ceiling</b> with no growth assumption ` +
          `at all: it applies the P/E and P/B limits simultaneously and returns the highest price at which ` +
          `neither is breached.<br>` +
          `Graham's original thresholds were P/E 15 × P/B 1.5 = 22.5; this uses the multiples you set under ` +
          `Assumptions, paired and multiplied — set those two to 15 and 1.5 to get the original. ` +
          `It is inherently harsh on asset-light, high-growth companies (low book value), so do not use it alone.</span>`,
        dilutionAdj: (list, factor) =>
          `<br><span class="formula-adj">↳ Diluted for ${list} (÷ ${fmt(factor, 4)})</span>`,
        dilutionItem: (d, k) => `${d} stock dividend ${fmt(k * 100, 1)}%`,
        roeNoBvps: "No book value per share available (no P/B figure), so this cannot be estimated.",
        roeNoRoe: "No ROE available (it needs both P/E and P/B, which usually means the company is loss-making).",
        roeGteR: "Perpetual growth g must be below the required return r, otherwise the model has no solution. Adjust the assumptions.",
        roeLow: (roe, g) => `ROE ${fmt(roe)}% does not exceed perpetual growth g ${fmt(g, 1)}%, so the model returns a negative or near-zero value and does not apply.`,
        roeBasis: (r, g, mos) => `r ${fmt(r, 1)}%　g ${fmt(g, 1)}%　margin of safety ${fmt(mos, 0)}%`,
        roeFormula: (roe, g, r, pb, rawBvps, bvps, diluted, fair, mos) =>
          `Model P/B = (ROE ${fmt(roe)}% − g ${fmt(g, 1)}%) ÷ (r ${fmt(r, 1)}% − g ${fmt(g, 1)}%) = ${fmt(pb)}x` +
          (diluted ? `<br>Book value per share ${fmt(rawBvps)} diluted by the stock dividend → NT$${fmt(bvps)}` : "") +
          `<br>Price = book value per share ${fmt(bvps)} × ${fmt(pb)} = NT$${fmt(fair)}<br>` +
          `Bounds = price × (1 ∓ margin of safety ${fmt(mos, 0)}%)`,
        pbNoData: "The source does not publish a P/B ratio, so book value per share cannot be derived.",
        pbFormula: (p, pbr, raw, note, bvps, lo, mid, hi) =>
          `Book value per share = close ${fmt(p)} ÷ P/B ${fmt(pbr)} = NT$${fmt(raw)}` + note +
          `<br>Price = ${fmt(bvps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x`,
        divNone: "No cash dividend in the past year (or the yield is 0), so the dividend method does not apply.",
        divFormula: (p, y, d, yc, yf, yr) =>
          `Dividend per share = close ${fmt(p)} × yield ${fmt(y)}% = NT$${fmt(d)}<br>` +
          `Price = ${fmt(d)} ÷ ${fmt(yc)}% / ${fmt(yf)}% / ${fmt(yr)}%<br>` +
          `(Yield moves inversely to price — the higher the yield, the lower the price)`,
        customEpsFormula: (e, lo, mid, hi) =>
          `Price = your EPS ${fmt(e)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ Using your own EPS. Clear the field under Assumptions to go back to the filed figures.</span>`,
        fwdNoQuarter: "No quarterly filing yet (companies file on different schedules; this site accumulates them daily), so this method does not apply for now.",
        fwdLoss: (y, q, cum) =>
          `Cumulative EPS in the latest filing (${y}Q${q}) is ${fmt(cum)} — a loss cannot be annualized, so this method does not apply.`,
        fwdRisk: { 1: "one quarter extrapolated to a full year — the most extrapolation of all; seasonality or one-off items get multiplied by four",
                   2: "half a year extrapolated to a full year; seasonality still matters",
                   3: "three quarters of actuals, so extrapolation error is small",
                   4: "a full year of actuals, no extrapolation" },
        fwdFormula: (y, q, cum, raw, dil, eps, lo, mid, hi, mult, risk) =>
          `Annualized EPS = ${y}Q${q} cumulative ${fmt(cum)} ÷ ${q} quarters × 4 = NT$${fmt(raw)}` +
          (dil > 1 ? `<br><span class="formula-adj">↳ Then diluted for the stock dividend ÷ ${fmt(dil, 4)} = NT$${fmt(eps)}</span>` : "") +
          `<br>Price = ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ ${q} quarter${q > 1 ? "s" : ""} extrapolated to a full year (×${mult}): ${risk}</span>`,
        revNoTable: "This stock is not in the monthly revenue tables (financial and insurance companies have no comparable revenue concept).",
        revNoQuarter: "No quarterly revenue, so earnings per dollar of revenue cannot be derived.",
        revLoss: (y, q) => `The latest filing (${y}Q${q}) is still cumulatively loss-making, so earnings cannot be estimated from revenue.`,
        revNotPositive: "The estimate is not positive, so this method does not apply.",
        revTrend: (yoy) => `, cumulative revenue up <b>${fmt(yoy, 1)}%</b> year on year`,
        revFormula: (cum, mo, annual, trend, y, q, qeps, qrev, raw, dil, eps, lo, mid, hi) =>
          `Estimated annual revenue = cumulative ${fmt(cum / 100, 2)}bn ÷ ${mo} months × 12 = NT$${fmt(annual / 100, 2)}bn${trend}<br>` +
          `EPS per dollar of revenue = ${y}Q${q} EPS ${fmt(qeps)} ÷ revenue NT$${fmt(qrev / 100, 2)}bn<br>` +
          `Estimated annual EPS = ${fmt(annual / 100, 2)}bn × that ratio = NT$${fmt(raw)}` +
          (dil > 1 ? `<br><span class="formula-adj">↳ Then diluted for the stock dividend ÷ ${fmt(dil, 4)} = NT$${fmt(eps)}</span>` : "") +
          `<br>Price = ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ Assumes this year's net margin matches the quarterly filing; a material change in gross margin will throw it off</span>`,
        pegNoData: "No quarterly data, or this year is cumulatively loss-making, so growth cannot be estimated.",
        pegNoPrev: (y) => `No full-year EPS for ${y}, so growth cannot be computed (this site accumulates prior-year filings daily).`,
        pegPrevLoss: (y, p) => `${y} was a loss (${fmt(p)} per share); a loss-to-profit growth rate is meaningless, so this method does not apply.`,
        pegShrink: (e, p, g) =>
          `Estimated EPS of ${fmt(e)} this year is below last year's ${fmt(p)} (down ${fmt(g, 1)}%). PEG does not apply to shrinking earnings.`,
        pegBasis: (lo, mid, hi) => `target PEG ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}`,
        pegFormula: (e, y, p, gRaw, capped, cap, g, lo, mid, hi) =>
          `Growth = estimated ${fmt(e)} ÷ ${y} actual ${fmt(p)} − 1 = ${fmt(gRaw, 1)}%` +
          (capped ? `<br><span class="formula-adj">↳ Above the cap, computed at ${fmt(cap, 0)}%</span>` : "") +
          `<br>Implied P/E = growth ${fmt(g, 1)} × target PEG<br>` +
          `Price = ${fmt(e)} × ${fmt(g, 1)} × ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}` +
          `<br><span class="formula-warn">※ Extrapolated from a single year's growth; cyclicals are easily overvalued</span>`,
        psNoTable: "This stock is not in the monthly revenue tables (financial and insurance companies have no comparable revenue concept).",
        psNoQuarter: "No quarterly revenue or net income, so revenue per share cannot be derived.",
        psBadSign: "Quarterly EPS and net income have inconsistent signs — the data looks wrong, so this method is skipped.",
        psNotPositive: "Estimated revenue per share is not positive.",
        psFormula: (annual, y, q, qeps, qni, sps, cur, lo, mid, hi) =>
          `Revenue per share = estimated annual revenue NT$${fmt(annual / 100, 2)}bn × (${y}Q${q} EPS ${fmt(qeps)} ÷ net income NT$${fmt(qni / 100, 2)}bn)<br>` +
          `　　　　　= NT$${fmt(sps)}　current P/S ${fmt(cur)}x<br>` +
          `Price = ${fmt(sps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ Reasonable multiples vary enormously by industry (software can reach 5–10x, distribution is often below 0.5x). ` +
          `With no universal default, this method is <b>excluded from the summary by default</b> — adjust the multiples above to the peer level, ` +
          `then tick it in. Its value is that revenue is always positive, so even loss-making companies can be valued.</span>`,
        grahamNoEps: "No usable EPS (the company is loss-making), and no custom EPS has been entered under Assumptions.",
        grahamBasis: (g, span) => `growth g ${fmt(g, 1)}% (±${fmt(span, 1)}%)`,
        grahamFormula: (g0, g1, g2, m0, m1, m2, eps) =>
          `Graham formula　V = EPS × (8.5 + 2g)<br>` +
          `With g = ${fmt(g0, 1)} / ${fmt(g1, 1)} / ${fmt(g2, 1)}%　→　multiples ${fmt(m0)} / ${fmt(m1)} / ${fmt(m2)}<br>` +
          `V = ${fmt(eps)} × each multiple` +
          `<br><span class="formula-warn">※ 8.5 is Graham's 1962 base P/E for a no-growth company; g is entirely yours to set. ` +
          `The formula ignores the interest-rate environment — the original also has a version adjusted by corporate bond yields.</span>`,
        peNoData: "The source publishes no P/E (usually meaning the trailing four quarters were a loss), so the P/E method does not apply.",
        peFormula: (p, pe, raw, note, eps, lo, mid, hi) =>
          `TTM EPS = close ${fmt(p)} ÷ P/E ${fmt(pe)} = NT$${fmt(raw)}` + note +
          `<br>Price = ${fmt(eps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x`,
      },
    },
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

  /** 算出某檔股票在指定財報基準日之後、累積至今的配股攤薄倍數。 */
  function dilutionSince(code, cut, approx) {
    const evs = EXRIGHTS[code];
    if (!evs || !evs.length || !cut) return null;
    const today = todayISO();
    // 只算「已經除權、且晚於財報基準日」的事件；未來的除權還沒影響股價
    const after = evs.filter((e) => e.d > cut && e.d <= today);
    if (!after.length) return null;

    const known = after.filter((e) => e.k != null && e.k > 0);
    const unknown = after.filter((e) => e.k == null);
    const factor = known.reduce((a, e) => a * (1 + e.k), 1);
    if (factor <= 1 && !unknown.length) return null;
    return { factor, known, unknown, approx: !!approx };
  }

  function dilutionOf(s) {
    const fe = fiscalEnd(s.fq);
    // 沒有財報季資訊時（上櫃），用 150 天回看當作近似
    const cut = fe ||
      new Date(Date.now() + 8 * 3600e3 - 150 * 86400e3).toISOString().slice(0, 10);
    return dilutionSince(s.c, cut, !fe);
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
    const list = a.known.map((e) => M().f.dilutionItem(e.d, e.k)).join(pick("、", ", "));
    return M().f.dilutionAdj(list, a.factor);
  }

  // ═══════════════════════════════════════════════════════
  //  計算公式
  //  每個公式回傳 {cheap, fair, rich, labels, basis, formula} 或 {na: "無法計算的原因"}
  //  cheap/fair/rich 只是「低／中／高參數」三組輸入對應的輸出，不含價值判斷。
  // ═══════════════════════════════════════════════════════

  /* 1. ROE 法 —— 由高登成長模型推導出對應的股價淨值比
   *    P/B = (ROE − g) / (r − g)，再乘上每股淨值。
   *    上下限由使用者設定的安全邊際決定。 */
  function methodRoe(s) {
    if (!s.bvps) return { na: M().f.roeNoBvps };
    if (!s.roe) return { na: M().f.roeNoRoe };
    const r = params.r / 100, g = params.g / 100, roe = s.roe / 100;
    if (g >= r) return { na: M().f.roeGteR };
    if (roe <= g) return { na: M().f.roeLow(s.roe, params.g) };
    const pbFair = (roe - g) / (r - g);
    const fair = s.bvps * pbFair, m = params.mos / 100;
    return {
      cheap: fair * (1 - m), fair, rich: fair * (1 + m),
      labels: [M().labelPb(pbFair * (1 - m)), M().labelPb(pbFair), M().labelPb(pbFair * (1 + m))],
      basis: `<span class="basis-tag">${M().tagYours}</span>${M().f.roeBasis(params.r, params.g, params.mos)}`,
      formula: M().f.roeFormula(s.roe, params.g, params.r, pbFair, s._rawBvps, s.bvps,
                                !!(s._adj && s._adj.factor > 1), fair, params.mos),
    };
  }

  /* 2. 股價淨值比法 —— 每股淨值 × 你選定的 P/B 倍數 */
  function methodPb(s) {
    if (!s.bvps) return { na: M().f.pbNoData };
    const b = usable(s, "pb");
    const [lo, mid, hi] = b || [params.pbLo, params.pbMid, params.pbHi];
    return {
      cheap: s.bvps * lo, fair: s.bvps * mid, rich: s.bvps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`),
      formula: M().f.pbFormula(s.p, s.pb, s._rawBvps || s.bvps, dilutionNote(s), s.bvps, lo, mid, hi),
    };
  }

  /* 3. 股利法 —— 每股現金股利 ÷ 你設定的目標殖利率
   *    殖利率與股價成反比，故最高的殖利率對應最低的價格。 */
  function methodDiv(s) {
    if (!s.d) return { na: M().f.divNone };
    const b = usable(s, "y");
    // 歷史區間為 [P20, P50, P80]；殖利率與價格成反比，故取用時左右對調
    const yCheap = b ? b[2] : params.yHi;
    const yFair = b ? b[1] : params.yMid;
    const yRich = b ? b[0] : params.yLo;
    return {
      cheap: s.d / (yCheap / 100), fair: s.d / (yFair / 100), rich: s.d / (yRich / 100),
      labels: [M().labelYield(yCheap), M().labelYield(yFair), M().labelYield(yRich)],
      basis: basisTag(b, pick("殖利率 ", "yield ") + `${fmt(yCheap)}% / ${fmt(yFair)}% / ${fmt(yRich)}%`),
      formula: M().f.divFormula(s.p, s.y, s.d, yCheap, yFair, yRich),
    };
  }

  /* 0. 本益比法（年化 EPS）—— 用最新一期季報推估全年獲利
   *
   *    交易所的本益比是拿「近四季 EPS」算的，反映過去一整年；獲利正在
   *    成長或衰退的公司，近四季會落後現況。這裡改用最新一期季報的
   *    當年度累計 EPS 年化：
   *
   *      年化 EPS = 當年度累計 EPS ÷ 季別 × 4
   *
   *    Q1 ×4、Q2 ×2、Q3 ×4/3、Q4 ×1。季數越少，外推的成分越重。
   */
  function methodPeFwd(s) {
    if (params.customEps > 0) {
      const b0 = usable(s, "pe");
      const [l0, m0, h0] = b0 || [params.peLo, params.peMid, params.peHi];
      const e0 = params.customEps;
      return {
        cheap: e0 * l0, fair: e0 * m0, rich: e0 * h0,
        labels: [M().labelMultiple(l0), M().labelMultiple(m0), M().labelMultiple(h0)],
        tag: M().tagCustomEps,
        basis: basisTag(b0, `${fmt(l0)} / ${fmt(m0)} / ${fmt(h0)}${X()}`) +
               `<span class="basis-src">${M().srcCustomEps(e0)}</span>`,
        formula: M().f.customEpsFormula(e0, l0, m0, h0),
      };
    }
    const f = QUARTERLY[s.c];
    if (!f) return { na: M().f.fwdNoQuarter };
    if (!(f.cum > 0)) return { na: M().f.fwdLoss(f.y, f.q, f.cum) };
    const raw = (f.cum / f.q) * 4;

    // 季報的每股盈餘同樣不會反映季末之後才發生的配股，比照做攤薄
    const adj = dilutionSince(s.c, fiscalEnd(`${f.y}/${f.q}`), false);
    const dil = adj && adj.factor > 1 ? adj.factor : 1;
    const eps = raw / dil;

    const b = usable(s, "pe");
    const [lo, mid, hi] = b || [params.peLo, params.peMid, params.peHi];
    const mult = { 1: 4, 2: 2, 3: "4/3", 4: 1 }[f.q];
    const risk = M().f.fwdRisk[f.q];
    return {
      cheap: eps * lo, fair: eps * mid, rich: eps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: M().tagAnnualized(f.y, f.q),
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`) +
             `<span class="basis-src">${M().srcQuarter(f.y, f.q)}</span>`,
      formula: M().f.fwdFormula(f.y, f.q, f.cum, raw, dil, eps, lo, mid, hi, mult, risk),
    };
  }

  /** 推估今年全年 EPS。
   *  使用者若在參數區填了自訂 EPS，一律以它為準 —— 這是刻意的：
   *  預估值是假設，應該由使用者自己決定，網站算的只是預設起點。
   */
  function estimateAnnualEps(s) {
    if (params.customEps > 0) {
      return { eps: params.customEps, raw: params.customEps, dil: 1,
               src: M().epsSrcCustom, custom: true };
    }
    const f = QUARTERLY[s.c], r = REVENUE[s.c];
    if (!f || !(f.cum > 0)) return null;
    let raw, src;
    if (r && f.rev > 0) {
      raw = (r.cum / r.mo) * 12 * (f.cum / f.rev);
      src = "rev";              // 內部代號，顯示時再依語言轉成文字
    } else {
      raw = (f.cum / f.q) * 4;
      src = "qtr";
    }
    if (!(raw > 0)) return null;
    const adj = dilutionSince(s.c, fiscalEnd(`${f.y}/${f.q}`), false);
    const dil = adj && adj.factor > 1 ? adj.factor : 1;
    return { eps: raw / dil, raw, dil, src, f, r };
  }

  /* 1b. 月營收動能法 —— 用每月營收推估全年獲利
   *
   *     台股每月 10 日前公布上月營收，比季報快約 35 天。用當年累計營收
   *     年化成全年營收，再乘上季報反推的「每一元營收貢獻多少 EPS」：
   *
   *       推估年營收 = 累計營收 ÷ 已過月數 × 12
   *       推估年 EPS = 推估年營收 × (季報累計 EPS ÷ 季報累計營收)
   *
   *     括號那項隱含了稅率與業外損益的平均水準，也免去查股數的麻煩。
   */
  function methodRevenue(s) {
    const r = REVENUE[s.c], f = QUARTERLY[s.c];
    if (!r) return { na: M().f.revNoTable };
    if (!f || !(f.rev > 0)) return { na: M().f.revNoQuarter };
    if (!(f.cum > 0)) return { na: M().f.revLoss(f.y, f.q) };
    const est = estimateAnnualEps(s);
    if (!est) return { na: M().f.revNotPositive };

    const annualRev = (r.cum / r.mo) * 12;
    const b = usable(s, "pe");
    const [lo, mid, hi] = b || [params.peLo, params.peMid, params.peHi];
    const ym = r.ym.slice(0, 3) + "/" + r.ym.slice(3);
    const trend = r.yoy == null ? "" : M().f.revTrend(r.yoy);
    return {
      cheap: est.eps * lo, fair: est.eps * mid, rich: est.eps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: M().tagRevenue(ym),
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`) +
             `<span class="basis-src">${M().srcMonth(ym)}</span>`,
      formula: M().f.revFormula(r.cum / 1e6, r.mo, annualRev / 1e6, trend, f.y, f.q,
                                f.cum, f.rev / 1e6, est.raw, est.dil, est.eps, lo, mid, hi),
    };
  }

  /* 1c. PEG 本益成長比 —— 讓估值跟著成長性走
   *
   *     同樣 20 倍本益比，年成長 5% 與 30% 的公司價值天差地遠。
   *     PEG = 本益比 ÷ 盈餘成長率(%)，一般以 1 為合理：
   *
   *       對應價 = 預估 EPS × 成長率(%) × 你設定的目標 PEG
   */
  function methodPeg(s) {
    const f = QUARTERLY[s.c];
    const est = estimateAnnualEps(s);
    if (!est) return { na: M().f.pegNoData };

    const h = QHISTORY[s.c] || {};
    const key = `${f.y - 1}/4`;
    const prev = h[key] && h[key].e;
    if (!prev) return { na: M().f.pegNoPrev(f.y - 1) };
    if (prev <= 0) return { na: M().f.pegPrevLoss(f.y - 1, prev) };
    const gRaw = (est.eps / prev - 1) * 100;
    if (gRaw <= 0) return { na: M().f.pegShrink(est.eps, prev, Math.abs(gRaw)) };
    // 成長率設上限，避免基期過低時算出離譜的目標本益比
    const g = Math.min(gRaw, params.gCap);
    const capped = gRaw > params.gCap;
    return {
      cheap: est.eps * g * params.pegLo,
      fair: est.eps * g * params.pegMid,
      rich: est.eps * g * params.pegHi,
      labels: [M().labelPeg(params.pegLo), M().labelPeg(params.pegMid), M().labelPeg(params.pegHi)],
      tag: M().tagGrowth(g),
      basis: `<span class="basis-tag">${M().tagInputs}</span>` +
             M().f.pegBasis(params.pegLo, params.pegMid, params.pegHi) +
             `<span class="basis-src">${M().srcPrevYear(f.y - 1)}</span>`,
      formula: M().f.pegFormula(est.eps, f.y - 1, prev, gRaw, capped, params.gCap, g,
                                params.pegLo, params.pegMid, params.pegHi),
    };
  }

  /* 3b. 股價營收比（P/S）—— 虧損公司也算得出來
   *
   *     營收恆為正，所以獲利尚未轉正的成長股仍可估價。
   *     每股營收由季報反推：EPS ÷ 淨利 = 1 ÷ 股數，故
   *
   *       每股營收 = 年營收 × (季報 EPS ÷ 季報淨利)
   */
  function methodPs(s) {
    const r = REVENUE[s.c], f = QUARTERLY[s.c];
    if (!r) return { na: M().f.psNoTable };
    if (!f || !(f.rev > 0) || !f.ni) return { na: M().f.psNoQuarter };
    const perShare = f.cum / f.ni;        // = 1 / 股數，虧損時分子分母同號仍為正
    if (!(perShare > 0)) return { na: M().f.psBadSign };
    const annualRev = (r.cum / r.mo) * 12;
    const sps = annualRev * perShare;
    if (!(sps > 0)) return { na: M().f.psNotPositive };

    const [lo, mid, hi] = [params.psLo, params.psMid, params.psHi];
    const cur = s.p / sps;
    return {
      cheap: sps * lo, fair: sps * mid, rich: sps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: M().tagCurrent(cur),
      basis: `<span class="basis-tag">${M().tagFixed}</span>${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}` +
             `<span class="basis-src">${M().srcSps(sps)}</span>`,
      formula: M().f.psFormula(annualRev / 1e6, f.y, f.q, f.cum, f.ni / 1e6, sps, cur, lo, mid, hi),
    };
  }

  /* 3d. 葛拉漢公式（Benjamin Graham, 1962）
   *
   *     出自《The Intelligent Investor》修訂版所載的簡化算式：
   *
   *       V = EPS × (8.5 + 2g)
   *
   *     8.5 是葛拉漢當年觀察到「零成長公司」的基準本益比，g 為預期
   *     年成長率（%）。本站不替任何個股設定 g —— 它完全由你在參數區
   *     輸入，卡片同時列出 g ± 敏感度區間，讓你看假設變動的影響。
   */
  function methodGraham(s) {
    const est = estimateAnnualEps(s);
    const eps = est ? est.eps : s.eps;
    if (!eps || eps <= 0) return { na: M().f.grahamNoEps };
    const g = params.grahamG, span = params.grahamSpan;
    const gs = [g - span, g, g + span];
    // (8.5 + 2g) 在 g < −4.25 時會變成負數，夾住避免出現負價格
    const mult = gs.map((x) => Math.max(8.5 + 2 * x, 0.5));
    const src = est ? (est.custom ? M().tagCustomEps
                                  : (est.src === "rev" ? M().epsSrcRevenue : M().epsSrcQuarter))
                    : M().epsSrcTtm;
    return {
      cheap: eps * mult[0], fair: eps * mult[1], rich: eps * mult[2],
      labels: gs.map((x) => M().labelG(x)),
      tag: M().tagGraham(g),
      basis: `<span class="basis-tag">${M().tagYours}</span>${M().f.grahamBasis(g, span)}` +
             `<span class="basis-src">${M().srcEps(eps, src)}</span>`,
      formula: M().f.grahamFormula(gs[0], g, gs[2], mult[0], mult[1], mult[2], eps),
    };
  }

  /* 3e. 股價營業現金流比（P/OCF）
   *
   *     站上其他公式全部建立在盈餘、淨值、營收、股利上，沒有一個看現金。
   *     盈餘含折舊攤銷與各種應計項目，可以在不動用現金的情況下被調整；
   *     營業活動現金流是真的收進來的錢。
   *
   *       年化營業現金流 = 年初至今累計 ÷ 已公布季數 × 4
   *       每股營業現金流 = 年化營業現金流 ÷ 在外流通股數
   *       對應價         = 每股營業現金流 × 你設定的 P/OCF 倍數
   *
   *     美股頁用的是自由現金流（再扣資本支出），台股做不到 —— 公開資訊
   *     觀測站的彙總現金流量表只有三大活動的合計，沒有資本支出欄位。
   */
  function methodPocf(s) {
    const c = CASHFLOW[s.c];
    if (!c) return { na: M().f.ocfNoData };
    if (!s.sh) return { na: M().f.ocfNoShares };
    if (!(c.ocf > 0)) return { na: M().f.ocfNegative(c.y, c.q, c.ocf) };
    const annual = (c.ocf / c.q) * 4;        // 百萬元
    const ps = annual / s.sh;                // 每股（sh 也是百萬股，直接相除）
    if (!(ps > 0)) return { na: M().f.ocfNegative(c.y, c.q, c.ocf) };
    const [lo, mid, hi] = [params.ocfLo, params.ocfMid, params.ocfHi];
    const cur = s.p / ps;
    return {
      cheap: ps * lo, fair: ps * mid, rich: ps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: M().tagCurrent(cur),
      basis: `<span class="basis-tag">${M().tagFixed}</span>${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}` +
             `<span class="basis-src">${M().srcOcf(ps)}</span>`,
      formula: M().f.ocfFormula(c.y, c.q, c.ocf, annual, s.sh, ps, cur, lo, mid, hi),
    };
  }

  /* 3f. 葛拉漢數字（Graham Number）
   *
   *     和上面的葛拉漢公式是**兩個不同的東西**，卡片與說明都要講清楚：
   *
   *       葛拉漢公式  V = EPS × (8.5 + 2g)
   *         → 估值，吃你輸入的成長率 g，g 給多少答案就差多少。
   *       葛拉漢數字  V = √(目標本益比 × 目標股價淨值比 × EPS × 每股淨值)
   *         → 上限，不含任何成長假設，只把「本益比」與「股價淨值比」兩個
   *           條件同時套上去，算出兩者都不超標的最高價格。
   *
   *     葛拉漢原始的門檻是本益比 15 與股價淨值比 1.5，乘積 22.5；這裡改成
   *     直接沿用你在參數區設定的三組本益比與股價淨值比，配對相乘 ——
   *     設成 15 與 1.5 就會回到原始的 22.5。
   */
  function methodGrahamNum(s) {
    if (!s.eps || s.eps <= 0) return { na: M().f.gnNoEps };
    if (!s.bvps || s.bvps <= 0) return { na: M().f.gnNoBvps };
    const pe = usable(s, "pe") || [params.peLo, params.peMid, params.peHi];
    const pb = usable(s, "pb") || [params.pbLo, params.pbMid, params.pbHi];
    const vals = [0, 1, 2].map((i) => Math.sqrt(pe[i] * pb[i] * s.eps * s.bvps));
    const prod = [0, 1, 2].map((i) => pe[i] * pb[i]);
    return {
      cheap: vals[0], fair: vals[1], rich: vals[2],
      labels: prod.map((v) => M().labelProduct(v)),
      tag: M().tagCeiling,
      basis: basisTag(usable(s, "pe") && usable(s, "pb"),
                      M().gnBasis(pe, pb)),
      formula: M().f.gnFormula(pe, pb, prod, s.eps, s.bvps, vals),
    };
  }

  /* 4. 本益比法 —— 近四季 EPS × 你選定的本益比倍數 */
  function methodPe(s) {
    if (!s.eps) return { na: M().f.peNoData };
    const b = usable(s, "pe");
    const [lo, mid, hi] = b || [params.peLo, params.peMid, params.peHi];
    return {
      cheap: s.eps * lo, fair: s.eps * mid, rich: s.eps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`),
      formula: M().f.peFormula(s.p, s.pe, s._rawEps || s.eps, dilutionNote(s), s.eps, lo, mid, hi),
    };
  }

  /** 取得可用的歷史區間；關閉開關或無資料時回傳 null（改用固定參數）。 */
  function usable(s, key) {
    if (!params.useBands) return null;
    const b = BANDS[s.c];
    return (b && b[key] && b[key].length === 3) ? b[key] : null;
  }
  function basisTag(band, txt) {
    return `<span class="basis-tag">${band ? M().tagBands : M().tagFixed}</span>${txt}`;
  }

  // 依估價基礎分組：本益比家族 → 淨值類 → 營收類 → 股利類
  /** 專業版顯示價位名稱，計算版顯示參數本身（如「15.94 倍」）。 */
  function colLabel(res, i) {
    if (isPro) return M().proCols[i];
    return (res.labels || [M().colLo, M().colMid, M().colHi])[i];
  }

  // 名稱與副標由字典提供（MSG.*.names）；en 欄是卡片右側那行固定的英文學名，
  // 中文介面下當副標，英文介面下就是標題本身，所以只在中文介面顯示。
  const METHODS = [
    { id: "pefwd", en: "Forward P/E", fn: methodPeFwd },
    { id: "pe", en: "Trailing P/E", fn: methodPe },
    { id: "peg", en: "PEG Ratio", fn: methodPeg },
    { id: "rev", en: "Revenue Momentum", fn: methodRevenue },
    { id: "graham", en: "Graham Formula", fn: methodGraham },
    { id: "gnum", en: "Graham Number", fn: methodGrahamNum },
    { id: "ocf", en: "Price / Operating Cash Flow", fn: methodPocf },
    { id: "roe", en: "Return on Equity", fn: methodRoe },
    { id: "pb", en: "P/B Ratio", fn: methodPb },
    { id: "ps", en: "P/S Ratio", fn: methodPs },
    { id: "div", en: "Dividend", fn: methodDiv },
  ];
  /** 市場別（上市／上櫃）是資料值，顯示時才轉語言 */
  const mkt = (m) => (M().market[m] || m);

  // ═══════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════
  function render() {
    if (!current) return;
    const s = effective(current);   // 套用除權配股攤薄後的數字

    el.sName.textContent = s.n;
    el.sCode.textContent = s.c;
    el.sMarket.textContent = mkt(s.m);
    el.sDate.textContent = M().closeOn(s._date || "—");
    el.sPrice.textContent = fmt(s.p);
    el.sEps.textContent = s.eps ? nt(s.eps) : "—";
    el.sBvps.textContent = s.bvps ? nt(s.bvps) : "—";
    renderDilution(s);
    el.sRoe.textContent = s.roe ? fmt(s.roe) + " %" : "—";
    el.sDps.textContent = s.d ? nt(s.d) : "—";
    el.sPe.textContent = s.pe ? fmt(s.pe) + X() : "—";
    el.sPb.textContent = s.pb ? fmt(s.pb) + X() : "—";
    // 股數與股本是另外抓的公司基本資料，估價公式用不到，純粹給規模感
    if (el.sMc) el.sMc.textContent = s.mc ? money(s.mc) : "—";
    if (el.sSh) el.sSh.textContent = s.sh ? big(s.sh) + M().shares : "—";
    if (el.sCap) el.sCap.textContent = s.cap ? money(s.cap) : "—";
    if (el.sNi) {
      // 近四季淨利 ＝ 近四季 EPS × 在外流通股數（sh 的單位是百萬股）
      const ni = (s.eps && s.sh) ? s.eps * s.sh : null;
      el.sNi.textContent = ni ? money(ni) : "—";
    }
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
                    aria-label="${M().includeAria}">`}
          <h3>${M().names[m.id][0]}${(res.tag || M().names[m.id][1]) ? `<span class="m-tag">${res.tag || M().names[m.id][1]}</span>` : ""}${L() === "en" ? "" : `<span class="m-en">${m.en}</span>`}</h3>
        </div>
        ${res.na
          ? `<p class="method-basis">—</p><p class="method-na">⚠︎ ${res.na}</p>`
          : `<p class="method-basis">${res.basis}</p>
             <div class="method-prices">
               <div class="mp lo"><span>${colLabel(res, 0)}</span><strong>${fmt(res.cheap)}</strong></div>
               <div class="mp mid"><span>${colLabel(res, 1)}</span><strong>${fmt(res.fair)}</strong></div>
               <div class="mp hi"><span>${colLabel(res, 2)}</span><strong>${fmt(res.rich)}</strong></div>
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
      const list = a.known.map((e) => M().dilutionEvent(e.d, e.k)).join(M().listSep);
      parts.push(M().dilutionMain(list, a.factor, s._rawEps, s.eps, s._rawBvps, s.bvps));
    }
    if (a.unknown.length) {
      parts.push(M().dilutionUnknown(a.unknown.map((e) => e.d).join(M().listSep)));
    }
    if (a.approx) parts.push(M().dilutionApprox);
    box.innerHTML = `<span class="dn-ico">⚖︎</span><div>${parts.join("<br><br>")}</div>`;
    box.hidden = false;
  }


  /* 迷你彙總列
   *
   * 彙總卡在頁面上方，九張公式卡從它下方一千多 px 才開始，所以使用者捲到
   * 卡片去勾選時，彙總早就滾出畫面 —— 數字有重算，只是看不到，看起來就像
   * 「勾了沒反應」。這條列在彙總卡不可見時貼在頂列下方，並在數字變動時閃一下。
   */
  let mbPrev = "";
  let syncMiniBar = null;   // watchSummary() 回傳的重算函式
  function renderMiniBar(labels, values, count) {
    const bar = $("miniBar");
    if (!bar) return;
    ["mbL1", "mbL2", "mbL3"].forEach((id, i) => { const n = $(id); if (n) n.textContent = labels[i]; });
    ["mbV1", "mbV2", "mbV3"].forEach((id, i) => { const n = $(id); if (n) n.textContent = values[i]; });
    const c = $("mbCount");
    if (c) c.textContent = count;
    const key = values.join("|") + "|" + count;
    if (mbPrev && mbPrev !== key) {
      bar.classList.remove("bump");
      void bar.offsetWidth;          // 重跑動畫
      bar.classList.add("bump");
    }
    mbPrev = key;
    if (syncMiniBar) syncMiniBar();
  }

  /** 彙總卡捲出畫面才顯示迷你列 —— 兩個同時看得到時它只是重複資訊。
   *
   *  用捲動事件而不是 IntersectionObserver：後者在某些內嵌／離螢幕的瀏覽器
   *  環境裡不會觸發（實測完全不發 callback），而這個判斷失效的話迷你列就
   *  永遠不出現，等於整個功能沒了。getBoundingClientRect 是同步且確定的。
   */
  function watchSummary() {
    const bar = $("miniBar");
    const card = document.querySelector(".summary");
    if (!bar || !card) return;
    const update = () => {
      // 彙總卡整個捲到頂列上方時才顯示；結果區沒開時不顯示
      const res = $("result");
      if (res && res.hidden) { bar.classList.remove("show"); return; }
      bar.classList.toggle("show", card.getBoundingClientRect().bottom < 70);
    };
    // 直接在 scroll 裡算，不做 rAF 節流：瀏覽器本來就把 scroll 併到每幀一次，
    // 而一次 getBoundingClientRect 的成本可以忽略。用「旗標 + rAF」節流反而有
    // 風險 —— rAF 在背景分頁或某些內嵌環境不跑，旗標會卡在 true，之後就再也
    // 不更新了。
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update, { passive: true });
    document.addEventListener("langchange", update);
    update();
    return update;
  }

  /* 專業版的彙總
   *
   * 三個價位分別取各公式「便宜／合理／昂貴」三欄的中位數（中位數比平均數
   * 不容易被單一極端值拉走）。進場判定是一條寫死的規則，不是預測：
   *
   *   現價 <  便宜價            → 進場區
   *   便宜價 ≤ 現價 < 合理價     → 接近進場
   *   合理價 ≤ 現價 < 昂貴價     → 偏高
   *   現價 ≥  昂貴價            → 過熱
   *
   * 規則與門檻都直接顯示在畫面上，使用者可以自行改參數改變門檻。
   */
  function renderSummaryPro(s, results, used) {
    const cheap = median(used.map((r) => r.cheap));
    const fair = median(used.map((r) => r.fair));
    const rich = median(used.map((r) => r.rich));

    el.tCheap.textContent = fmt(cheap);
    el.tFair.textContent = fmt(fair);
    el.tRich.textContent = fmt(rich);
    el.gScaleL.innerHTML = `<i>${M().scaleCheap}</i> <b>${fmt(cheap)}</b>`;
    el.gScaleM.innerHTML = `<i>${M().scaleFair}</i> <b>${fmt(fair)}</b>`;
    el.gScaleR.innerHTML = `<i>${M().scaleRich}</i> <b>${fmt(rich)}</b>`;
    renderMiniBar([M().scaleCheap, M().scaleFair, M().scaleRich],
                  [fmt(cheap), fmt(fair), fmt(rich)], M().usedCount(used.length));
    el.gaugePrice.textContent = fmt(s.p);

    if (cheap === null || !(cheap < rich)) {
      el.gaugeMark.style.left = "50%";
      el.verdict.className = "verdict";
      el.verdict.textContent = used.length ? M().proNoRank : M().proNone;
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

    const gapToCheap = (s.p / cheap - 1) * 100;   // 距離便宜價還有多少 %
    const vsFair = (s.p / fair - 1) * 100;
    const diff = Math.abs(s.p - cheap);

    let cls, head, action;
    const gap = Math.abs(gapToCheap), vs = Math.abs(vsFair);
    if (s.p < cheap) {
      cls = "is-cheap";
      head = M().proHeadCheap(s.p, cheap, gap);
      action = M().proActEnter;
    } else if (s.p < fair) {
      cls = "is-nearby";
      head = M().proHeadNearby(s.p, vsFair >= 0, vs);
      action = M().proActNear(cheap, diff, gap);
    } else if (s.p < rich) {
      cls = "is-fair";
      head = M().proHeadFair(s.p, vs);
      action = M().proActHigh(cheap, diff, gap);
    } else {
      cls = "is-rich";
      head = M().proHeadRich(s.p, rich, vs);
      action = M().proActHot(cheap, diff, gap);
    }

    el.verdict.className = "verdict " + cls;
    el.verdict.innerHTML =
      `${head}${pick("。", ".")}<br>${action}` + M().proNote(used.length) +
      (used.length <= 2 ? M().proThin(used.length) : "");
  }

  /* 計算值彙總
   *
   * 這一區只做敘述統計：把各公式在你設定的參數下算出的數值蒐集起來，
   * report 最小值、中位數、最大值，以及現價落在這些數值中的相對位置。
   * 不對任何一個數值賦予「便宜／合理／昂貴」之類的評價，也不推論
   * 該不該買賣 —— 倍數與假設是你自己選的，結論也應該由你自己下。
   */
  function renderSummary(s, results) {
    const used = METHODS.filter((m) => !results[m.id].na && !offMethods.has(m.id))
                        .map((m) => results[m.id]);
    if (isPro) return renderSummaryPro(s, results, used);
    // 每個方法在三組參數下各產生一個數值，全部攤平後做統計
    const all = used.flatMap((r) => [r.cheap, r.fair, r.rich])
                    .filter((v) => isFinite(v) && v > 0)
                    .sort((a, b) => a - b);

    const lo = all.length ? all[0] : null;
    const hi = all.length ? all[all.length - 1] : null;
    const md = median(all);

    el.tCheap.textContent = fmt(lo);
    el.tFair.textContent = fmt(md);
    el.tRich.textContent = fmt(hi);
    // <i> 內的文字在窄螢幕會被 CSS 隱藏，只留數字避免三個刻度擠在一起
    el.gScaleL.innerHTML = `<i>${M().scaleMin}</i> <b>${fmt(lo)}</b>`;
    el.gScaleM.innerHTML = `<i>${M().scaleMid}</i> <b>${fmt(md)}</b>`;
    el.gScaleR.innerHTML = `<i>${M().scaleMax}</i> <b>${fmt(hi)}</b>`;
    renderMiniBar([M().scaleMin, M().scaleMid, M().scaleMax],
                  [fmt(lo), fmt(md), fmt(hi)], M().usedCount(used.length));
    el.gaugePrice.textContent = fmt(s.p);

    if (!all.length || !(lo < hi)) {
      el.gaugeMark.style.left = "50%";
      el.verdict.className = "verdict";
      el.verdict.textContent = used.length ? M().sumSingle : M().sumNone;
      return;
    }

    // 現價在最小～最大之間的線性位置，純粹是刻度定位，不含評價
    const pos = clamp(((s.p - lo) / (hi - lo)) * 100, 2, 98);
    el.gaugeMark.style.left = pos.toFixed(1) + "%";

    const below = all.filter((v) => v < s.p).length;
    const pctBelow = (below / all.length) * 100;
    const vsMd = (s.p / md - 1) * 100;

    el.verdict.className = "verdict";
    const psHint = (results.ps && !results.ps.na && offMethods.has("ps")) ? M().psHint : "";
    el.verdict.innerHTML =
      M().verdict(s.p, used.length, all.length, lo, hi, md, pctBelow,
                  vsMd >= 0 ? "+" : "−", Math.abs(vsMd)) +
      (used.length <= 2 ? M().verdictThin(used.length, psHint) : "");
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
        `<li class="no-hit">${M().noHit(q)}</li>`;
      el.suggest.hidden = false;
      return;
    }
    el.suggest.innerHTML = list.map((s) => `
      <li data-code="${s.c}">
        <span class="s-code">${s.c}</span>
        <span class="s-name">${s.n}</span>
        <span class="s-meta">${mkt(s.m)}　${fmt(s.p)}</span>
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
  let LAST_DATE = "";    // 兩市場中較新的那個資料日，切語言時要重新顯示

  function ingest(payload) {
    STOCKS = payload.stocks;
    INDEX = new Map(STOCKS.map((s) => [s.c, s]));
    TRADE_DATE = payload.trade_date || {};
    STOCKS.forEach((s) => (s._date = TRADE_DATE[s.m] || payload.updated_at || ""));
    const dates = [...new Set(Object.values(TRADE_DATE).filter(Boolean))].sort();
    LAST_DATE = dates.length ? dates[dates.length - 1] : "";
    el.dataDate.textContent = LAST_DATE ? M().dataDate(LAST_DATE) : M().dataDateNone;
    el.dataCount.textContent = M().count(payload.count || STOCKS.length);
  }

  async function boot() {
    try {
      const [latest, bands, exr, qtr, rv, cf] = await Promise.all([
        fetch("data/latest.json?t=" + Date.now()).then((r) => {
          if (!r.ok) throw new Error("latest.json " + r.status);
          return r.json();
        }),
        fetch("data/bands.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                .catch(() => null),
        fetch("data/exrights.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                   .catch(() => null),
        fetch("data/quarterly.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                    .catch(() => null),
        fetch("data/revenue.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                  .catch(() => null),
        fetch("data/cashflow.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                   .catch(() => null),
      ]);
      ingest(latest);
      if (bands && bands.bands) BANDS = bands.bands;
      if (exr && exr.events) EXRIGHTS = exr.events;
      if (qtr && qtr.eps) QUARTERLY = qtr.eps;
      if (qtr && qtr.history) QHISTORY = qtr.history;
      if (rv && rv.rev) REVENUE = rv.rev;
      if (cf && cf.cf) CASHFLOW = cf.cf;
      el.loading.hidden = true;

      const hash = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (hash && INDEX.has(hash)) select(hash);
    } catch (err) {
      el.loading.hidden = true;
      showError(M().loadFailTitle, M().loadFail(err.message));
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
      showError(M().refreshFailTitle, M().refreshFail);
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
    const sep = M().listSep;
    const total = done.map((m) =>
      M().marketCount(mkt(m), m === "上市" ? twseRows.length : tpexRows.length)).join(sep);

    if (!stale.length) {
      showNote("ok", M().upToDateTitle,
        failed.length
          ? M().upToDateSome(total, failed.map(mkt).join(sep), newest, STOCKS.length)
          : M().upToDateAll(total, newest));
    } else {
      showNote("warn", M().staleTitle(stale.map(mkt).join(sep)),
        M().staleBody(total, newest, stale.map(mkt).join(sep),
                      stale.map((m) => TRADE_DATE[m]).join(sep)));
    }
  }

  // ═══════════════════════════════════════════════════════
  //  參數 / 主題 / 事件
  // ═══════════════════════════════════════════════════════
  const PIDS = { pUseBands: "useBands", pPeLo: "peLo", pPeMid: "peMid", pPeHi: "peHi",
                 pPbLo: "pbLo", pPbMid: "pbMid", pPbHi: "pbHi",
                 pYHi: "yHi", pYMid: "yMid", pYLo: "yLo",
                 pR: "r", pG: "g", pMos: "mos",
                 pPsLo: "psLo", pPsMid: "psMid", pPsHi: "psHi",
                 pOcfLo: "ocfLo", pOcfMid: "ocfMid", pOcfHi: "ocfHi",
                 pPegLo: "pegLo", pPegMid: "pegMid", pPegHi: "pegHi", pGCap: "gCap",
                 pGrahamG: "grahamG", pGrahamSpan: "grahamSpan", pCustomEps: "customEps" };

  function readParams() {
    for (const [id, key] of Object.entries(PIDS)) {
      const node = $(id);
      if (!node) continue;
      if (node.type === "checkbox") {
        params[key] = node.checked;
      } else if (node.value.trim() === "") {
        // 自訂 EPS 是選填的，清空代表「改回自動計算」；其他欄位留空則忽略
        if (key === "customEps") params[key] = 0;
      } else {
        const v = parseFloat(node.value);
        if (isFinite(v) && (v > 0 || key === "grahamG")) params[key] = v;
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
      else if (key === "customEps") node.value = params[key] > 0 ? params[key] : "";
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
    // 語言一換，程式產生的文字全部要重來：頂列、九張公式卡、彙總敘述
    document.addEventListener("langchange", () => {
      if (LAST_DATE || STOCKS.length) {
        el.dataDate.textContent = LAST_DATE ? M().dataDate(LAST_DATE) : M().dataDateNone;
        el.dataCount.textContent = M().count(STOCKS.length);
      }
      if (current) render();
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
    const off = JSON.parse(localStorage.getItem(OFF_KEY) || "null");
    offMethods = new Set(off === null ? DEFAULT_OFF : off);
  } catch (_) { /* 忽略毀損的設定 */ }
  writeParams();
  bind();
  syncMiniBar = watchSummary();
  boot();
})();
