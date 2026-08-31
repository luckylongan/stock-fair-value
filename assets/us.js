/* 幾塊你要買？ —— 美股財務計算工具箱
 *
 * 定位與台股版完全一致：對公開財務數字做機械式的乘除運算並顯示結果。
 * 倍數、成長率、目標殖利率等假設一律由使用者設定，本站不替任何個股
 * 設定「應該」的價位，也不對計算結果作評價或給買賣建議。
 *
 * 與台股版的三個結構性差異（不是實作偷懶，是兩地公開制度不同）：
 *
 *   1. 每股數字的方向相反。台灣的交易所直接公布本益比、股價淨值比與
 *      殖利率，台股版是「由比率反推每股數字」；美國沒有這種官方統計，
 *      這裡是「由 SEC 財報的每股數字算出比率」。
 *   2. 沒有「該股近 5 年評價區間」，改用「同產業當前分布」。前者是
 *      時間序列、後者是橫斷面，意義不同，卡片上必須標清楚。
 *   3. 沒有月營收（美國不強制公布），那一格改放自由現金流。
 *
 * 資料：data/us.json、data/us_fin.json，由 scripts/fetch_us.py 每交易日更新。
 */
(() => {
  "use strict";

  // ── 狀態 ────────────────────────────────────────────────
  let STOCKS = [];        // 全市場個股
  let SECT = {};          // 產業 -> {pe:[P20,P50,P80], pb, ps, pfcf, y, n}
  let FIN = {};           // 代號 -> {e:{年度/累計每股盈餘}, r:{營收}}
  let INDEX = new Map();
  let current = null;
  let sugIdx = -1;
  let TRADE_DATE = "";

  const DEFAULTS = {
    useBands: true,
    peLo: 12, peMid: 20, peHi: 30,
    pbLo: 1, pbMid: 2.5, pbHi: 5,
    yHi: 4, yMid: 2.5, yLo: 1.5,
    r: 8, g: 2.5, mos: 25,
    psLo: 1, psMid: 2.5, psHi: 5,
    fcfLo: 15, fcfMid: 25, fcfHi: 40,
    pegLo: 0.75, pegMid: 1, pegHi: 1.5,
    gCap: 40,
    customEps: 0,
    grahamG: 5, grahamSpan: 2,
  };
  const OFF_KEY = "us_off_methods_v1";
  // 與台股版同理：股價營收比的合理倍數因產業而異極大，沒有通用預設值，
  // 預設不納入彙總，讓使用者依同業調好參數後自行勾選。
  const DEFAULT_OFF = ["ps"];
  let params = { ...DEFAULTS };
  let offMethods = new Set(DEFAULT_OFF);

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["q", "suggest", "clearBtn", "loading", "errorBox", "result", "empty", "methods",
   "sName", "sCode", "sMarket", "sSector", "sDate", "sPrice", "sEps", "sBvps", "sRoe",
   "sDps", "sPe", "sPb", "sPs", "sY", "sFq", "sFcfps", "sMc", "sSh",
   "tCheap", "tFair", "tRich", "gaugeMark",
   "gaugePrice", "gScaleL", "gScaleM", "gScaleR", "verdict", "dataDate", "dataCount",
   "themeBtn", "resetParams"].forEach((k) => (el[k] = $(k)));

  // 程式產生的文字（公式推導、不適用原因、彙總敘述）帶變數，沒辦法像 HTML
  // 那樣把兩份都寫死，所以各訊息在 MSG 裡寫成一個函式，兩種語言各一份。
  const L = () => (window.I18N ? window.I18N.lang : "zh");
  const M = () => MSG[L()] || MSG.zh;
  const pick = (zh, en) => (L() === "en" ? en : zh);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (v, d = 2) =>
    (v === null || v === undefined || !isFinite(v)) ? "—"
      : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const X = () => pick(" 倍", "x");                 // 倍數的單位
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
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
    if (a >= 1e6) return fmt(m / 1e6, 2) + " 兆";      // 1 兆 = 100 萬個百萬
    if (a >= 100) return fmt(m / 100, 1) + " 億";       // 1 億 = 100 個百萬
    return fmt(m, 1) + " 百萬";
  };
  /** 金額：英文前面要加 $，中文不用（單位字已經講清楚了） */
  const money = (m) => (m === null || m === undefined || !isFinite(m))
    ? "—" : pick(big(m), "$" + big(m));
  /** 股數：不是金額，不能掛幣別符號 */
  const shares = (m) => big(m);
  // 產業別取自那斯達克的分類，這裡只做顯示用的中譯
  const SECTOR_ZH = {
    "Technology": "科技", "Finance": "金融", "Health Care": "醫療保健",
    "Consumer Discretionary": "非必需消費", "Consumer Staples": "必需消費",
    "Industrials": "工業", "Real Estate": "不動產", "Energy": "能源",
    "Basic Materials": "原物料", "Telecommunications": "電信",
    "Utilities": "公用事業", "Miscellaneous": "其他",
  };
  const sectorZh = (k) => {
    if (!k) return pick("未分類", "Unclassified");
    return L() === "en" ? k : (SECTOR_ZH[k] ? SECTOR_ZH[k] + "（" + k + "）" : k);
  };
  const sectorShort = (k) => {
    if (!k) return pick("未分類", "Unclassified");
    return L() === "en" ? k : (SECTOR_ZH[k] || k);
  };
  /** "CY2026Q2" -> "2026Q2"；"CY2025" -> "2025 年度" / "FY2025" */
  const lbl = (p) => {
    if (!p) return "—";
    const m = /^CY(\d{4})(?:Q([1-4]))?$/.exec(p);
    if (!m) return p;
    return m[2] ? m[1] + "Q" + m[2] : pick(m[1] + " 年度", "FY" + m[1]);
  };

  // ═══════════════════════════════════════════════════════
  //  訊息字典
  //
  //  這些字串都帶變數，沒辦法像 HTML 那樣把中英兩份都寫死在原始碼裡靠 CSS 切，
  //  所以每則訊息寫成一個函式，兩種語言各一份，由 M() 依目前語言取用。
  //  兩份的參數順序刻意一致，改動時兩邊要一起改。
  // ═══════════════════════════════════════════════════════
  const MSG = {
    zh: {
      // 基準標籤
      tagSector: "同業當前", tagFixed: "固定倍數", tagYours: "你的參數", tagInputs: "參數",
      srcQuarters: (n) => `依 ${n} 季累計`,
      srcCustomEps: (e) => `EPS ${fmt(e)} 元（自訂）`,
      srcFcfps: (v) => `每股自由現金流 ${fmt(v)} 美元`,
      srcSps: (v) => `每股營收 ${fmt(v)} 美元`,
      srcPrevFy: "對比前一會計年度",
      srcEps: (e, src) => `EPS ${fmt(e)} 美元 · ${src}`,
      epsSrcCustom: "自訂", epsSrcAnnual: "季報年化", epsSrcTtm: "近四季",
      // 公式名稱
      names: {
        pefwd: ["本益比法", "年化 EPS"], pe: ["本益比法", "近四季"],
        peg: ["本益成長比", ""], fcf: ["自由現金流法", ""],
        graham: ["葛拉漢公式", ""], roe: ["ROE 法", ""],
        pb: ["股價淨值比法", ""], ps: ["股價營收比", ""], div: ["股利法", ""],
      },
      tagAnnualized: (p) => `年化 · ${p}`,
      tagCustomEps: "你輸入的 EPS",
      tagGrowth: (g) => `成長 ${fmt(g, 0)}%`,
      tagGraham: (g) => `g ${fmt(g, 1)}%`,
      tagCurrent: (v) => `目前 ${fmt(v)} 倍`,
      labelMultiple: (v) => `${fmt(v)} 倍`,
      labelPb: (v) => `P/B ${fmt(v)} 倍`,
      labelYield: (v) => `殖利率 ${fmt(v)}%`,
      labelPeg: (v) => `PEG ${fmt(v, 2)}`,
      labelG: (v) => `g ${fmt(v, 1)}%`,
      // 沒有財報
      noFinForeignFull: (n, co) =>
        `${n} 是在${co}註冊的外國公司，以美國存託憑證（ADR）形式掛牌，` +
        `依 20-F 用 <b>IFRS 及當地幣別</b>申報，不在 SEC 的 us-gaap 彙總表內。` +
        `要換算成美元的每股數字，還需要匯率與 ADR 兌換比例（1 單位 ADR 不等於 1 股原股），` +
        `這兩項沒有可靠的免費來源 —— 與其算出一個看起來合理卻是錯的數字，本站選擇不算。`,
      noFinForeignShort: (co) =>
        `外國發行人（${co}），依 IFRS 及當地幣別申報，SEC 的 us-gaap 彙總表沒有它的財報數字。詳見上方個股卡。`,
      noFinDomesticFull:
        "SEC 的 us-gaap 彙總表沒有這家公司的財報。常見原因：剛上市還沒送出第一份年報、" +
        "SPAC 或空殼公司、已下市清算，或公司重組後換了新的申報主體（舊主體的歷史財報" +
        "不會自動接到新的統一編號上）。",
      noFinDomesticShort:
        "SEC 的 us-gaap 彙總表沒有這家公司的財報（新上市、SPAC，或公司重組換了申報主體）。詳見上方個股卡。",
      noFinTail: "本頁只顯示查得到的部分（收盤價、市值、產業別），九種公式全部標示不適用。",
      // 個股卡 / 彙總 / 狀態
      closeOn: (d) => `收盤 ${d}`,
      dataDate: (d) => `資料日 ${d}`,
      count: (n) => `${n} 檔美股`,
      shares: "股",
      includeAria: "是否納入計算值彙總",
      colLo: "低", colMid: "中", colHi: "高",
      mgPeriod: "期間", mgGross: "毛利率", mgOper: "營業利益率",
      mgNote: "毛利率＝營業毛利 ÷ 營業收入；營業利益率＝營業利益 ÷ 營業收入。" +
              "金融保險業沒有可比的營收與毛利概念，因此不顯示。",
      mgTrend: (y0, v0, y1, v1, d) =>
        `營業利益率由 ${y0}的 <b>${fmt(v0, 1)}%</b> ${d < 0 ? "降至" : "升至"} ` +
        `${y1}的 <b>${fmt(v1, 1)}%</b>（${d < 0 ? "減少" : "增加"} ` +
        `<b>${fmt(Math.abs(d), 1)} 個百分點</b>）。` +
        `利潤率變動時，同樣的營收會對應到不同的每股盈餘 —— 上方以盈餘為基礎的公式全部會跟著移動。<br>`,
      scaleMin: "最小", scaleMid: "中位數", scaleMax: "最大",
      usedCount: (n) => `納入 ${n} 種公式`,
      noteTtm: (fyl, fy, fye, n, ytd, l, eps) =>
        `<b>近四季（TTM）是重建出來的。</b>XBRL 有個結構性缺口：公司的會計年度
         <b>第四季通常不會單獨標記</b>，年報只揭露全年數字，直接把四個日曆季相加
         大部分公司會少一季。所以本站改用會計年度重建 ——
         <b>${fyl}全年 ${fmt(fy)}</b>（截至 ${fye}）
         ＋ <b>該年度結束後 ${n} 季累計 ${fmt(ytd)}</b>（至 ${l}）
         − 去年同期 ＝ 近四季 <b>${fmt(eps)}</b> 美元。`,
      noteFyOnly: (fyl, fye, fy) =>
        `本檔最近一個完整會計年度是 <b>${fyl}</b>（截至 ${fye}），
         之後尚無更新的季報，因此「近四季」用的就是這份年報的全年數字
         <b>${fmt(fy)}</b> 美元，年化法不另外列出。`,
      noteInexact: (fyl) =>
        `<b>去年同期的季別資料不齊，無法完成扣減</b>，近四季暫以
         ${fyl}全年數字代替，會落後於最新一季的實績。`,
      noteEpsAlt:
        `本檔申報的每股盈餘與「市值 ÷ 股價」反推的股數對不起來（雙重股權的公司
         常只申報其中一個股別），因此 EPS 改用 <b>近四季淨利 ÷ 股數</b> 計算。`,
      sumSingle: "目前納入的公式只產生單一數值，無法做分佈統計，請直接看下方各公式的計算結果。",
      sumNone: "目前沒有任何公式可計算（多數公式需要獲利或股利為正），或所有公式都被取消勾選。",
      sumNoFin: "本檔沒有 SEC 財報資料，九種公式都無法計算，說明見上方。",
      verdict: (p, used, all, lo, hi, md, pct, sign, vs) =>
        `現價 <b>${fmt(p)}</b> 美元。目前納入 <b>${used}</b> 種公式、
         共 <b>${all}</b> 個計算值，範圍 <b>${fmt(lo)}</b> ～ <b>${fmt(hi)}</b> 美元，
         中位數 <b>${fmt(md)}</b> 美元。<br>
         現價高於其中 <b>${fmt(pct, 0)}%</b> 的計算值，
         與中位數相差 <b>${sign}${fmt(vs, 1)}%</b>。
         <span class="verdict-note">以上為敘述統計，計算值取決於你在「計算參數」中設定的倍數與假設，
         本站不對這些數值作任何評價，也不構成買賣建議。</span>`,
      verdictThin: (n, psHint) =>
        `<span class="verdict-thin">⚠︎ 目前只有 ${n} 種公式可計算，
         統計量等同單一模型的輸出，離散程度沒有參考意義。${psHint}</span>`,
      psHint: "本檔的<b>股價營收比</b>算得出來但預設未納入 —— 確認同業倍數後可勾選納入。",
      ratioNames: { pe: "本益比", pb: "股價淨值比", ps: "股價營收比", pfcf: "股價自由現金流比" },
      outlier: (above, price, edge, n, w) => {
        const dir = above ? "高於" : "低於";
        const edgeName = above ? "最大" : "最小";
        const head =
          `<span class="verdict-thin">ⓘ 現價 <b>${fmt(price)}</b> 美元${dir}<b>全部 ${n} 個</b>計算值` +
          `（${edgeName}值 <b>${fmt(edge)}</b>）。`;
        const why = w
          ? `落差主要來自<b>${w.name} ${fmt(w.cur)} 倍</b>，` +
            (above ? `是同業中位數 ${fmt(w.ref)} 倍的 <b>${fmt(w.k, 1)} 倍</b>。`
                   : `只有同業中位數 ${fmt(w.ref)} 倍的 <b>1/${fmt(w.k, 1)}</b>。`)
          : "";
        const tail =
          `這九種公式全部建立在<b>已實現的財務數字</b>上，市價若反映的是對未來的預期，` +
          `公式看不到，落差就會全部顯示在這裡。<br>` +
          `<b>這不代表資料有誤，也不代表哪一邊才是對的</b> —— ` +
          `計算值取決於你設定的倍數，市價取決於市場願意付多少。` +
          `想改用不同的基準，可到「計算參數」關掉同業當前分布，自行輸入倍數。</span>`;
        return head + why + tail;
      },
      noHit: (q) => `找不到「${q}」——請輸入美股代號或公司名稱（英文）`,
      loadFail: (m) =>
        `<b>讀不到美股資料</b>無法載入 <code>data/us.json</code>（${m}）。<br>
         若是在本機直接以檔案開啟網頁，瀏覽器會擋下讀取，請改用
         <code>python3 scripts/serve.py</code> 起一個本機伺服器再瀏覽。`,
      noFinTwLink: `<br><br>這檔的原股在台股掛牌，可以到<a href="index.html">計算版</a>直接用台股的資料查。`,
      // ── 公式卡的推導與不適用原因 ──
      f: {
        customEpsFormula: (e, l, m, h) =>
          `對應價 ＝ 你輸入的 EPS ${fmt(e)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)} 倍` +
          `<br><span class="formula-warn">※ 目前使用自訂 EPS，清空參數區的欄位即可改回依季報計算</span>`,
        fwdNoNewQuarter: (fyl, fye) =>
          `最近一個完整會計年度（${fyl}，截至 ${fye}）結束後，SEC 還沒有更新的季報可以年化。` +
          "這時「近四季」用的就是同一份年報，兩種算法會得到相同的數字，所以這裡不重複列出。",
        fwdLoss: (ytd, l) =>
          `本會計年度累計每股盈餘為 ${fmt(ytd)} 美元（截至 ${l}），虧損無法年化，此法不適用。`,
        fwdRisk: { 1: "只用一季實績推全年，外推成分最重，淡旺季或一次性損益會被放大四倍",
                   2: "以半年實績推全年，淡旺季影響仍需留意",
                   3: "已有前三季實績，外推誤差較小",
                   4: "已是全年實績，沒有外推" },
        fwdFormula: (ytd, n, eps, l, m, h, mult, risk) =>
          `年化 EPS ＝ 本年度累計 ${fmt(ytd)} ÷ ${n} 季 × 4 ＝ ${fmt(eps)} 美元<br>` +
          `對應價 ＝ ${fmt(eps)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)} 倍` +
          `<br><span class="formula-warn">※ 以 ${n} 季實績外推全年（×${mult}）：${risk}</span>`,
        peNoEps: "缺少近四季每股盈餘。",
        peLoss: (e) => `近四季每股盈餘為 ${fmt(e)} 美元（虧損），本益比法不適用。`,
        peRebuilt: (fyl, fy, ytd, eps) =>
          `近四季 EPS ＝ ${fyl}全年 ${fmt(fy)} ＋ 本年度累計 ${fmt(ytd)} − 去年同期 ＝ ${fmt(eps)} 美元`,
        peFromFy: (fyl, eps) => `近四季 EPS ＝ ${fyl}全年 ＝ ${fmt(eps)} 美元`,
        peAltNote: `<br><span class="formula-adj">↳ 本檔申報的每股盈餘與市值反推的股數對不起來（多見於雙重股權），改用 淨利 ÷ 股數 計算</span>`,
        peTail: (eps, l, m, h) => `<br>對應價 ＝ ${fmt(eps)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)} 倍`,
        pegNoEps: "缺少可用的每股盈餘（公司虧損），無法推估成長率。",
        pegNoPrev: (fyl) => `缺少 ${fyl} 之前一個會計年度的每股盈餘，無法計算成長率。`,
        pegPrevLoss: (p) => `前一個會計年度為虧損（每股 ${fmt(p)} 美元），由虧轉盈的成長率沒有意義，此法不適用。`,
        pegShrink: (e, p, g) =>
          `預估 EPS ${fmt(e)} 美元低於前一年度 ${fmt(p)} 美元（衰退 ${fmt(g, 1)}%），PEG 不適用於獲利衰退的公司。`,
        pegFormula: (e, src, p, gRaw, capped, cap, g, lo, mid, hi) =>
          `成長率 ＝ 預估 ${fmt(e)}（${src}） ÷ 前一年度 ${fmt(p)} − 1 ＝ ${fmt(gRaw, 1)}%` +
          (capped ? `<br><span class="formula-adj">↳ 超過上限，以 ${fmt(cap, 0)}% 計算</span>` : "") +
          `<br>對應本益比 ＝ 成長率 ${fmt(g, 1)} × 目標 PEG<br>` +
          `對應價 ＝ ${fmt(e)} × ${fmt(g, 1)} × ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}` +
          `<br><span class="formula-warn">※ 以單一年度成長率外推，景氣循環股容易在高峰期被高估</span>`,
        fcfNegative: (v, p) => `${p}自由現金流為 ${v}美元（為負），代表營業現金流不足以支應資本支出，此法不適用。`,
        fcfMissing: "缺少營業活動現金流或資本支出（金融業的現金流量表結構不同，多數銀行、保險公司沒有可比的資本支出科目）。",
        fcfFormula: (fcf, per, sh, fcfps, cur, lo, mid, hi) =>
          `自由現金流 ＝ 營業活動現金流 − 資本支出 ＝ ${fcf}美元（${per}）<br>` +
          `每股自由現金流 ＝ ${fcf} ÷ ${sh}股 ＝ ${fmt(fcfps)} 美元　目前 P/FCF ${fmt(cur)} 倍<br>` +
          `對應價 ＝ ${fmt(fcfps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 現金流量表在美國是以年初至今累計申報，半年與九個月的累計值不在 SEC 的期間彙總表內，` +
          `因此近四季無法穩定重建 —— 這裡取的是<b>${per}一整年</b>的數字，比其他公式舊。大幅擴廠或處分資產的年度會失真。</span>`,
        grahamNoEps: "缺少可用的每股盈餘（公司虧損），或你尚未在參數區輸入自訂 EPS。",
        grahamFormula: (g0, g1, g2, m0, m1, m2, eps) =>
          `葛拉漢公式　V ＝ EPS × (8.5 + 2g)<br>` +
          `代入 g ＝ ${fmt(g0, 1)} / ${fmt(g1, 1)} / ${fmt(g2, 1)}%　→　倍數 ${fmt(m0)} / ${fmt(m1)} / ${fmt(m2)}<br>` +
          `V ＝ ${fmt(eps)} × 各倍數` +
          `<br><span class="formula-warn">※ 8.5 為葛拉漢 1962 年提出的零成長基準本益比，成長率 g 完全由你設定；` +
          `此式未考慮利率環境，原著另有以 AAA 公司債殖利率調整的版本</span>`,
        roeNegEquity: "股東權益為負，無法計算每股淨值。",
        roeNoRoe: "缺少 ROE（需要近四季淨利與股東權益同時存在）。",
        roeGteR: "永續成長率 g 必須小於要求報酬率 r，模型無解，請調整參數。",
        roeLowRoe: (roe, g) => `ROE ${fmt(roe)}% 未高於永續成長率 g ${fmt(g, 1)}%，模型會得出負值或極低估值，不適用。`,
        roeBasis: (r, g, mos) => `r ${fmt(r, 1)}%　g ${fmt(g, 1)}%　安全邊際 ${fmt(mos, 0)}%`,
        roeFormula: (ni, eq, roe, g, r, pb, bvps, fair, mos) =>
          `ROE ＝ 近四季淨利 ${ni} ÷ 股東權益 ${eq} ＝ ${fmt(roe)}%<br>` +
          `模型 P/B ＝ (ROE ${fmt(roe)}% − g ${fmt(g, 1)}%) ÷ (r ${fmt(r, 1)}% − g ${fmt(g, 1)}%) ＝ ${fmt(pb)} 倍<br>` +
          `對應價 ＝ 每股淨值 ${fmt(bvps)} × ${fmt(pb)} ＝ ${fmt(fair)} 美元<br>` +
          `上下限 ＝ 對應價 × (1 ∓ 安全邊際 ${fmt(mos, 0)}%)` +
          `<br><span class="formula-warn">※ 美股大量實施庫藏股，買回的股份會直接沖減股東權益，長期買回的公司淨值偏低、` +
          `ROE 因而偏高（極端者股東權益為負），這個模型會給出很高的倍數</span>`,
        pbNegEquity: (eq) => `股東權益為 ${eq}美元（為負，多因長期實施庫藏股），無法計算每股淨值。`,
        pbFormula: (eq, sh, bvps, lo, mid, hi) =>
          `每股淨值 ＝ 股東權益 ${eq} ÷ ${sh}股 ＝ ${fmt(bvps)} 美元<br>` +
          `對應價 ＝ ${fmt(bvps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 帳面淨值不含自行發展的品牌、專利與軟體，輕資產公司的 P/B 天生就高；` +
          `美股的庫藏股也會壓低淨值</span>`,
        psNoRev: "缺少近四季營收（金融業多無可比的營收科目）。",
        psFormula: (rev, sh, sps, lo, mid, hi) =>
          `每股營收 ＝ 近四季營收 ${rev} ÷ ${sh}股 ＝ ${fmt(sps)} 美元<br>` +
          `對應價 ＝ ${fmt(sps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)} 倍` +
          `<br><span class="formula-warn">※ 合理倍數因產業而異極大（軟體常在 5~10 倍以上、通路與零售低於 1 倍）。` +
          `因為沒有一組通用預設值，本法<b>預設不納入彙總</b> —— 請先確認同業水準再勾選納入。` +
          `它完全不看獲利能力，營收高但長年虧損的公司會被高估。</span>`,
        divNone: "SEC 財報中查無近四季普通股現金股利。美國不少大型成長股完全不配息，改以庫藏股回饋股東，股利法對這類公司不適用。",
        divFormula: (d, y, yc, yf, yr) =>
          `每股現金股利 ＝ ${fmt(d)} 美元（近四季申報）　目前殖利率 ${fmt(y)}%<br>` +
          `對應價 ＝ ${fmt(d)} ÷ ${fmt(yc)}% / ${fmt(yf)}% / ${fmt(yr)}%<br>` +
          `（殖利率與價格成反比，殖利率越高對應的價格越低）` +
          `<br><span class="formula-warn">※ 美股多按季配息，這裡是 SEC 財報中申報的金額，不含特別股利與資本公積返還的差異；` +
          `美國對外國投資人的股利預扣稅為 30%，實收金額低於帳面殖利率</span>`,
      },
    },
    en: {
      tagSector: "Sector, now", tagFixed: "Fixed multiple", tagYours: "Your inputs", tagInputs: "Inputs",
      srcQuarters: (n) => `${n} quarter${n > 1 ? "s" : ""} year-to-date`,
      srcCustomEps: (e) => `EPS ${fmt(e)} (your figure)`,
      srcFcfps: (v) => `FCF/share $${fmt(v)}`,
      srcSps: (v) => `Revenue/share $${fmt(v)}`,
      srcPrevFy: "vs prior fiscal year",
      srcEps: (e, src) => `EPS $${fmt(e)} · ${src}`,
      epsSrcCustom: "your figure", epsSrcAnnual: "annualized from filings", epsSrcTtm: "trailing 12M",
      names: {
        pefwd: ["P/E method", "forward"], pe: ["P/E method", "trailing"],
        peg: ["PEG ratio", ""], fcf: ["Price / free cash flow", ""],
        graham: ["Graham formula", ""], roe: ["Return on equity", ""],
        pb: ["Price / book", ""], ps: ["Price / sales", ""], div: ["Dividend", ""],
      },
      tagAnnualized: (p) => `annualized · ${p}`,
      tagCustomEps: "your EPS",
      tagGrowth: (g) => `growth ${fmt(g, 0)}%`,
      tagGraham: (g) => `g ${fmt(g, 1)}%`,
      tagCurrent: (v) => `now ${fmt(v)}x`,
      labelMultiple: (v) => `${fmt(v)}x`,
      labelPb: (v) => `P/B ${fmt(v)}x`,
      labelYield: (v) => `yield ${fmt(v)}%`,
      labelPeg: (v) => `PEG ${fmt(v, 2)}`,
      labelG: (v) => `g ${fmt(v, 1)}%`,
      noFinForeignFull: (n, co) =>
        `${n} is incorporated in ${co} and lists as an American Depositary Receipt. It files on ` +
        `Form 20-F under <b>IFRS in its own currency</b>, so it is absent from the SEC's us-gaap ` +
        `frames. Converting to per-share figures in USD would also need an exchange rate and the ` +
        `ADR ratio (one ADR is not one ordinary share), and neither has a reliable free source — ` +
        `rather than produce a plausible-looking but wrong number, this site declines to compute one.`,
      noFinForeignShort: (co) =>
        `Foreign private issuer (${co}), filing under IFRS in local currency. The SEC's us-gaap frames hold no financials for it. See the stock card above.`,
      noFinDomesticFull:
        "The SEC's us-gaap frames hold no financials for this company. Usual reasons: recently " +
        "listed and yet to file a first annual report; a SPAC or shell company; delisted or " +
        "liquidating; or reorganised into a new filing entity (the old entity's history does not " +
        "carry over to the new CIK).",
      noFinDomesticShort:
        "The SEC's us-gaap frames hold no financials for this company (new listing, SPAC, or a reorganised filing entity). See the stock card above.",
      noFinTail: "This page shows only what is available (price, market cap, sector); all nine formulas report that they do not apply.",
      closeOn: (d) => `Close ${d}`,
      dataDate: (d) => `Data as of ${d}`,
      count: (n) => `${n} US stocks`,
      shares: "",
      includeAria: "Include in the summary",
      colLo: "Low", colMid: "Mid", colHi: "High",
      mgPeriod: "Period", mgGross: "Gross margin", mgOper: "Operating margin",
      mgNote: "Gross margin = gross profit ÷ revenue; operating margin = operating income ÷ revenue. " +
              "Financial and insurance companies have no comparable revenue or gross profit, so nothing is shown.",
      mgTrend: (y0, v0, y1, v1, d) =>
        `Operating margin ${d < 0 ? "fell" : "rose"} from <b>${fmt(v0, 1)}%</b> in ${y0} to ` +
        `<b>${fmt(v1, 1)}%</b> in ${y1} (${d < 0 ? "down" : "up"} ` +
        `<b>${fmt(Math.abs(d), 1)} percentage points</b>). ` +
        `When margin moves, the same revenue produces a different EPS — and every earnings-based ` +
        `formula above moves with it.<br>`,
      scaleMin: "Min", scaleMid: "Median", scaleMax: "Max",
      usedCount: (n) => `${n} formula${n === 1 ? "" : "s"} included`,
      noteTtm: (fyl, fy, fye, n, ytd, l, eps) =>
        `<b>Trailing twelve months is reconstructed.</b> XBRL has a structural gap: a company's
         <b>fiscal fourth quarter is usually not tagged separately</b>, because the annual report
         discloses only the full year. Add four calendar quarters together and most companies come
         up one quarter short. So this site rebuilds it from the fiscal year —
         <b>${fyl} full year ${fmt(fy)}</b> (ended ${fye})
         + <b>${n} quarter${n > 1 ? "s" : ""} since, totalling ${fmt(ytd)}</b> (through ${l})
         − the same period a year earlier = TTM <b>$${fmt(eps)}</b>.`,
      noteFyOnly: (fyl, fye, fy) =>
        `The latest complete fiscal year is <b>${fyl}</b> (ended ${fye}) and no newer quarter has
         been filed since, so "trailing twelve months" is that annual report's full-year figure of
         <b>$${fmt(fy)}</b>. The forward method is not listed separately.`,
      noteInexact: (fyl) =>
        `<b>The prior-year quarters are incomplete, so the subtraction could not be done.</b>
         Trailing twelve months falls back to the ${fyl} full-year figure, which lags the most
         recent quarter's actuals.`,
      noteEpsAlt:
        `This company's reported EPS does not reconcile with the share count implied by
         "market cap ÷ price" (dual-class companies often file for only one class), so EPS is
         computed as <b>TTM net income ÷ shares</b> instead.`,
      sumSingle: "The formulas currently included produce a single value, so there is no distribution to describe. Read the individual cards below.",
      sumNone: "No formula can be computed right now (most need positive earnings or a dividend), or every formula has been unticked.",
      sumNoFin: "There are no SEC financials for this stock, so none of the nine formulas can be computed — see the explanation above.",
      verdict: (p, used, all, lo, hi, md, pct, sign, vs) =>
        `Price <b>$${fmt(p)}</b>. <b>${used}</b> formula${used > 1 ? "s" : ""} included, producing
         <b>${all}</b> values ranging <b>$${fmt(lo)}</b> to <b>$${fmt(hi)}</b>, median
         <b>$${fmt(md)}</b>.<br>
         The current price is above <b>${fmt(pct, 0)}%</b> of those values and differs from the
         median by <b>${sign}${fmt(vs, 1)}%</b>.
         <span class="verdict-note">These are descriptive statistics. The values depend entirely on
         the multiples and assumptions you set under "Assumptions". This site does not evaluate
         them and gives no buy or sell advice.</span>`,
      verdictThin: (n, psHint) =>
        `<span class="verdict-thin">⚠︎ Only ${n} formula${n > 1 ? "s" : ""} can be computed right
         now, so these statistics amount to the output of a single model and the spread means
         nothing. ${psHint}</span>`,
      psHint: "<b>Price / sales</b> is computable for this stock but excluded by default — tick it in once you have checked the peer multiple.",
      ratioNames: { pe: "P/E", pb: "P/B", ps: "P/S", pfcf: "P/FCF" },
      outlier: (above, price, edge, n, w) => {
        const dir = above ? "above" : "below";
        const edgeName = above ? "highest" : "lowest";
        const head =
          `<span class="verdict-thin">ⓘ The current price of <b>$${fmt(price)}</b> is ${dir} ` +
          `<b>all ${n}</b> computed values (${edgeName}: <b>${fmt(edge)}</b>). `;
        const why = w
          ? `The gap comes mainly from <b>${w.name} at ${fmt(w.cur)}x</b>, ` +
            (above ? `which is <b>${fmt(w.k, 1)}×</b> the sector median of ${fmt(w.ref)}x. `
                   : `which is <b>1/${fmt(w.k, 1)}</b> of the sector median of ${fmt(w.ref)}x. `)
          : "";
        const tail =
          `All nine formulas are built on <b>realised financial figures</b>. If the market price ` +
          `reflects expectations about the future, the formulas cannot see that, and the whole ` +
          `difference shows up here.<br>` +
          `<b>This does not mean the data is wrong, nor that either side is right</b> — the computed ` +
          `values depend on the multiples you set, and the market price depends on what buyers will ` +
          `pay. To use a different basis, turn off the sector distribution under "Assumptions" and ` +
          `enter your own multiples.</span>`;
        return head + why + tail;
      },
      noHit: (q) => `No match for "${q}" — enter a US ticker or company name`,
      loadFail: (m) =>
        `<b>Could not load US market data</b> Failed to fetch <code>data/us.json</code> (${m}).<br>
         If you opened this page directly from the filesystem the browser will block the request;
         run <code>python3 scripts/serve.py</code> and browse through that instead.`,
      noFinTwLink: `<br><br>Its ordinary shares trade in Taipei — look up 2330 in the <a href="index.html">Calculator edition</a>.`,
      f: {
        customEpsFormula: (e, l, m, h) =>
          `Price = your EPS ${fmt(e)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)}x` +
          `<br><span class="formula-warn">※ Using your own EPS. Clear the field under Assumptions to go back to the filed figures.</span>`,
        fwdNoNewQuarter: (fyl, fye) =>
          `No quarter has been filed since the latest complete fiscal year (${fyl}, ended ${fye}), ` +
          "so there is nothing to annualize. The trailing method is using that same annual report, " +
          "so both would return an identical number — no point listing it twice.",
        fwdLoss: (ytd, l) =>
          `Year-to-date EPS is ${fmt(ytd)} (through ${l}) — a loss cannot be annualized, so this method does not apply.`,
        fwdRisk: { 1: "one quarter extrapolated to a full year — the most extrapolation of all; seasonality or one-off items get multiplied by four",
                   2: "half a year extrapolated to a full year; seasonality still matters",
                   3: "three quarters of actuals, so extrapolation error is small",
                   4: "a full year of actuals, no extrapolation" },
        fwdFormula: (ytd, n, eps, l, m, h, mult, risk) =>
          `Annualized EPS = year-to-date ${fmt(ytd)} ÷ ${n} quarters × 4 = $${fmt(eps)}<br>` +
          `Price = ${fmt(eps)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)}x` +
          `<br><span class="formula-warn">※ ${n} quarter${n > 1 ? "s" : ""} extrapolated to a full year (×${mult}): ${risk}</span>`,
        peNoEps: "No trailing twelve-month EPS available.",
        peLoss: (e) => `Trailing twelve-month EPS is ${fmt(e)} (a loss), so the P/E method does not apply.`,
        peRebuilt: (fyl, fy, ytd, eps) =>
          `TTM EPS = ${fyl} full year ${fmt(fy)} + year-to-date ${fmt(ytd)} − same period last year = $${fmt(eps)}`,
        peFromFy: (fyl, eps) => `TTM EPS = ${fyl} full year = $${fmt(eps)}`,
        peAltNote: `<br><span class="formula-adj">↳ Reported EPS does not reconcile with the share count implied by market cap (common with dual-class shares), so net income ÷ shares is used instead</span>`,
        peTail: (eps, l, m, h) => `<br>Price = ${fmt(eps)} × ${fmt(l)} / ${fmt(m)} / ${fmt(h)}x`,
        pegNoEps: "No usable EPS (the company is loss-making), so no growth rate can be estimated.",
        pegNoPrev: (fyl) => `No EPS for the fiscal year before ${fyl}, so growth cannot be computed.`,
        pegPrevLoss: (p) => `The prior fiscal year was a loss (${fmt(p)} per share); a loss-to-profit growth rate is meaningless, so this method does not apply.`,
        pegShrink: (e, p, g) =>
          `Estimated EPS ${fmt(e)} is below the prior year's ${fmt(p)} (down ${fmt(g, 1)}%). PEG does not apply to shrinking earnings.`,
        pegFormula: (e, src, p, gRaw, capped, cap, g, lo, mid, hi) =>
          `Growth = estimated ${fmt(e)} (${src}) ÷ prior year ${fmt(p)} − 1 = ${fmt(gRaw, 1)}%` +
          (capped ? `<br><span class="formula-adj">↳ Above the cap, computed at ${fmt(cap, 0)}%</span>` : "") +
          `<br>Implied P/E = growth ${fmt(g, 1)} × target PEG<br>` +
          `Price = ${fmt(e)} × ${fmt(g, 1)} × ${fmt(lo, 2)} / ${fmt(mid, 2)} / ${fmt(hi, 2)}` +
          `<br><span class="formula-warn">※ Extrapolated from a single year's growth; cyclicals are easily overvalued at the peak</span>`,
        fcfNegative: (v, p) => `${p} free cash flow was ${v} (negative) — operating cash flow did not cover capital expenditure, so this method does not apply.`,
        fcfMissing: "No operating cash flow or capital expenditure available (financial companies structure their cash flow statements differently; most banks and insurers have no comparable capex line).",
        fcfFormula: (fcf, per, sh, fcfps, cur, lo, mid, hi) =>
          `Free cash flow = operating cash flow − capital expenditure = ${fcf} (${per})<br>` +
          `FCF per share = ${fcf} ÷ ${sh} shares = $${fmt(fcfps)}　current P/FCF ${fmt(cur)}x<br>` +
          `Price = ${fmt(fcfps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ US cash flow statements are filed year-to-date, and six- and nine-month cumulative figures appear in no SEC period frame, ` +
          `so TTM cannot be reconstructed reliably — this uses <b>${per}</b> in full, which is older than the other formulas. A year with a major build-out or asset disposal will distort it.</span>`,
        grahamNoEps: "No usable EPS (the company is loss-making), and no custom EPS has been entered under Assumptions.",
        grahamFormula: (g0, g1, g2, m0, m1, m2, eps) =>
          `Graham formula　V = EPS × (8.5 + 2g)<br>` +
          `With g = ${fmt(g0, 1)} / ${fmt(g1, 1)} / ${fmt(g2, 1)}%　→　multiples ${fmt(m0)} / ${fmt(m1)} / ${fmt(m2)}<br>` +
          `V = ${fmt(eps)} × each multiple` +
          `<br><span class="formula-warn">※ 8.5 is Graham's 1962 base P/E for a no-growth company; g is entirely yours to set. ` +
          `The formula ignores the interest-rate environment — the original also has a version adjusted by AAA corporate bond yields.</span>`,
        roeNegEquity: "Shareholders' equity is negative, so book value per share cannot be computed.",
        roeNoRoe: "No ROE available (it needs both TTM net income and shareholders' equity).",
        roeGteR: "Perpetual growth g must be below the required return r, otherwise the model has no solution. Adjust the assumptions.",
        roeLowRoe: (roe, g) => `ROE ${fmt(roe)}% does not exceed perpetual growth g ${fmt(g, 1)}%, so the model returns a negative or near-zero value and does not apply.`,
        roeBasis: (r, g, mos) => `r ${fmt(r, 1)}%　g ${fmt(g, 1)}%　margin of safety ${fmt(mos, 0)}%`,
        roeFormula: (ni, eq, roe, g, r, pb, bvps, fair, mos) =>
          `ROE = TTM net income ${ni} ÷ shareholders' equity ${eq} = ${fmt(roe)}%<br>` +
          `Model P/B = (ROE ${fmt(roe)}% − g ${fmt(g, 1)}%) ÷ (r ${fmt(r, 1)}% − g ${fmt(g, 1)}%) = ${fmt(pb)}x<br>` +
          `Price = book value per share ${fmt(bvps)} × ${fmt(pb)} = $${fmt(fair)}<br>` +
          `Bounds = price × (1 ∓ margin of safety ${fmt(mos, 0)}%)` +
          `<br><span class="formula-warn">※ US companies buy back stock heavily, and repurchases are charged directly against shareholders' equity. ` +
          `Serial repurchasers carry a low book value and a correspondingly inflated ROE (in extreme cases equity is negative), so this model returns very high multiples.</span>`,
        pbNegEquity: (eq) => `Shareholders' equity is ${eq} (negative, usually from years of buybacks), so book value per share cannot be computed.`,
        pbFormula: (eq, sh, bvps, lo, mid, hi) =>
          `Book value per share = shareholders' equity ${eq} ÷ ${sh} shares = $${fmt(bvps)}<br>` +
          `Price = ${fmt(bvps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ Book value excludes internally developed brands, patents and software, so asset-light companies carry a naturally high P/B; ` +
          `US buybacks depress it further.</span>`,
        psNoRev: "No trailing twelve-month revenue available (most financial companies have no comparable revenue line).",
        psFormula: (rev, sh, sps, lo, mid, hi) =>
          `Revenue per share = TTM revenue ${rev} ÷ ${sh} shares = $${fmt(sps)}<br>` +
          `Price = ${fmt(sps)} × ${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}x` +
          `<br><span class="formula-warn">※ Reasonable multiples vary enormously by industry (software often above 5–10x, retail and distribution below 1x). ` +
          `With no universal default, this method is <b>excluded from the summary by default</b> — check the peer group before ticking it in. ` +
          `It ignores profitability entirely, so a company with high revenue and years of losses will be overvalued.</span>`,
        divNone: "No TTM common-stock cash dividend found in the SEC filings. Many large US growth companies pay no dividend at all, returning cash through buybacks instead, so this method does not apply to them.",
        divFormula: (d, y, yc, yf, yr) =>
          `Dividend per share = $${fmt(d)} (TTM, as filed)　current yield ${fmt(y)}%<br>` +
          `Price = ${fmt(d)} ÷ ${fmt(yc)}% / ${fmt(yf)}% / ${fmt(yr)}%<br>` +
          `(Yield moves inversely to price — the higher the yield, the lower the price)` +
          `<br><span class="formula-warn">※ US companies mostly pay quarterly. These are the amounts as filed with the SEC and do not separate special dividends or return of capital. ` +
          `The US withholds 30% of dividends paid to non-resident investors, so what you receive is below the headline yield.</span>`,
      },
    },
  };

  // ═══════════════════════════════════════════════════════
  //  倍數基準
  //
  //  台股版優先採用「該股自己近 5 年的 P20 / P50 / P80」—— 那是這一檔
  //  股票自己被市場交易出來的歷史紀錄。美股沒有等量的免費歷史資料
  //  （要逐檔抓五年股價），所以改用另一種同樣客觀、但意義不同的統計：
  //  **同產業所有個股「當前」的 P20 / P50 / P80**。
  //
  //  兩者的差別必須講清楚，不能混為一談：
  //    近 5 年區間 = 這檔股票自己的歷史（跨時間）
  //    同業分布   = 此刻整個產業的樣子（跨公司）
  //  後者會跟著整個產業一起漲跌，產業整體在高檔時，中位數也在高檔。
  // ═══════════════════════════════════════════════════════
  function usable(s, key) {
    if (!params.useBands) return null;
    const b = SECT[s.sec];
    return (b && b[key] && b[key].length === 3) ? b[key] : null;
  }
  function basisTag(band, txt, s, key) {
    if (!band) return `<span class="basis-tag">${M().tagFixed}</span>${txt}`;
    const n = (SECT[s.sec] || {})[key + "n"];
    const cnt = n ? " · " + n + pick(" 檔", n > 1 ? " stocks" : " stock") : "";
    return `<span class="basis-tag">${M().tagSector}</span>${txt}` +
           `<span class="basis-src">${sectorShort(s.sec)}${cnt}</span>`;
  }

  // 註冊地是那斯達克給的英文國名，這裡只翻常見的幾個，其餘照原文顯示
  const COUNTRY_ZH = {
    "Canada": "加拿大", "China": "中國", "Israel": "以色列", "Hong Kong": "香港",
    "Singapore": "新加坡", "United Kingdom": "英國", "Cayman Islands": "開曼群島",
    "Bermuda": "百慕達", "Greece": "希臘", "Switzerland": "瑞士",
    "Netherlands": "荷蘭", "Taiwan": "台灣", "Ireland": "愛爾蘭",
    "Australia": "澳洲", "Brazil": "巴西", "Japan": "日本", "Malaysia": "馬來西亞",
    "Luxembourg": "盧森堡", "Mexico": "墨西哥", "Germany": "德國",
    "Argentina": "阿根廷", "South Korea": "南韓", "France": "法國",
    "India": "印度", "Chile": "智利", "Denmark": "丹麥", "Italy": "義大利",
    "Sweden": "瑞典", "South Africa": "南非", "Spain": "西班牙",
    "Belgium": "比利時", "Macau": "澳門", "Panama": "巴拿馬",
    "United Arab Emirates": "阿聯", "Puerto Rico": "波多黎各",
  };
  const countryZh = (k) => COUNTRY_ZH[k] || k;

  /** 沒有財報時的原因。卡片上要短（同一段話重複九次沒人會讀），
   *  完整的說明放在個股卡的基準說明區，只講一次。 */
  function noFin(s, full) {
    const m = M();
    if (s.co) {
      const co = L() === "en" ? s.co : countryZh(s.co);
      return full ? m.noFinForeignFull(s.n, co) : m.noFinForeignShort(co);
    }
    return full ? m.noFinDomesticFull : m.noFinDomesticShort;
  }

  // ═══════════════════════════════════════════════════════
  //  計算公式
  //  每個公式回傳 {cheap, fair, rich, labels, basis, formula} 或 {na: 原因}
  //  cheap/fair/rich 只是「低／中／高參數」三組輸入對應的輸出，不含價值判斷。
  // ═══════════════════════════════════════════════════════

  /** 推估今年全年 EPS。
   *  使用者若在參數區填了自訂 EPS，一律以它為準 —— 預估值是假設，
   *  應該由使用者自己決定，網站算的只是預設起點。
   */
  function estimateAnnualEps(s) {
    if (params.customEps > 0) {
      return { eps: params.customEps, src: M().epsSrcCustom, custom: true };
    }
    const f = (FIN[s.c] || {}).e;
    if (f && f.n > 0 && f.ytd > 0) {
      return { eps: (f.ytd / f.n) * 4, src: M().epsSrcAnnual, f };
    }
    if (s.eps > 0) return { eps: s.eps, src: M().epsSrcTtm, f };
    return null;
  }

  /* 1. 本益比法（年化 EPS）—— 用本會計年度已公布的季報推估全年
   *
   *    SEC 的近四季 EPS 反映過去一整年；獲利正在成長或衰退的公司，
   *    近四季會落後現況。這裡改用會計年度至今的累計數年化：
   *
   *      年化 EPS = 本年度累計 EPS ÷ 已公布季數 × 4
   */
  function methodPeFwd(s) {
    const b0 = usable(s, "pe");
    const [l0, m0, h0] = b0 || [params.peLo, params.peMid, params.peHi];
    if (params.customEps > 0) {
      const e0 = params.customEps;
      return {
        cheap: e0 * l0, fair: e0 * m0, rich: e0 * h0,
        labels: [M().labelMultiple(l0), M().labelMultiple(m0), M().labelMultiple(h0)],
        tag: M().tagCustomEps,
        basis: basisTag(b0, `${fmt(l0)} / ${fmt(m0)} / ${fmt(h0)}${X()}`, s, "pe"),
        formula: M().f.customEpsFormula(e0, l0, m0, h0),
      };
    }
    const f = (FIN[s.c] || {}).e;
    if (!f) return { na: noFin(s) };
    if (!f.n) return { na: M().f.fwdNoNewQuarter(lbl(f.fyl), f.fye) };
    if (!(f.ytd > 0)) return { na: M().f.fwdLoss(f.ytd, lbl(f.l)) };
    const eps = (f.ytd / f.n) * 4;
    const mult = { 1: 4, 2: 2, 3: "4/3", 4: 1 }[f.n] || 4;
    const risk = M().f.fwdRisk[f.n] || M().f.fwdRisk[1];
    return {
      cheap: eps * l0, fair: eps * m0, rich: eps * h0,
      labels: [M().labelMultiple(l0), M().labelMultiple(m0), M().labelMultiple(h0)],
      tag: M().tagAnnualized(lbl(f.l)),
      basis: basisTag(b0, `${fmt(l0)} / ${fmt(m0)} / ${fmt(h0)}${X()}`, s, "pe") +
             `<span class="basis-src">${M().srcQuarters(f.n)}</span>`,
      formula: M().f.fwdFormula(f.ytd, f.n, eps, l0, m0, h0, mult, risk),
    };
  }

  /* 2. 本益比法（近四季 EPS）
   *
   *    近四季不是把四個日曆季相加 —— XBRL 有個結構性缺口：公司的會計年度
   *    第四季通常不會單獨標記，年報只揭露全年。所以後端改用會計年度重建：
   *      近四季 = 最近完整會計年度 + 該年度結束後的累計 − 去年同期累計
   */
  function methodPe(s) {
    if (!s.eps) return { na: (FIN[s.c] || {}).e ? M().f.peNoEps : noFin(s) };
    if (s.eps <= 0) return { na: M().f.peLoss(s.eps) };
    const b = usable(s, "pe");
    const [lo, mid, hi] = b || [params.peLo, params.peMid, params.peHi];
    const f = (FIN[s.c] || {}).e;
    return {
      cheap: s.eps * lo, fair: s.eps * mid, rich: s.eps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`, s, "pe"),
      cur: s.pe, ref: mid, ratio: "pe",
      formula:
        (f && f.n ? M().f.peRebuilt(lbl(f.fyl), f.fy, f.ytd, s.eps)
                  : M().f.peFromFy(lbl((f || {}).fyl), s.eps)) +
        (s.epsalt ? M().f.peAltNote : "") +
        M().f.peTail(s.eps, lo, mid, hi),
    };
  }

  /* 3. 本益成長比（PEG）—— 讓估值跟著成長性走
   *      對應價 = 預估 EPS × 成長率(%) × 你設定的目標 PEG
   */
  function methodPeg(s) {
    const f = (FIN[s.c] || {}).e;
    if (!f) return { na: noFin(s) };
    const est = estimateAnnualEps(s);
    if (!est) return { na: M().f.pegNoEps };
    if (f.pfy === undefined || f.pfy === null) return { na: M().f.pegNoPrev(lbl(f.fyl)) };
    if (f.pfy <= 0) return { na: M().f.pegPrevLoss(f.pfy) };
    const gRaw = (est.eps / f.pfy - 1) * 100;
    if (gRaw <= 0) return { na: M().f.pegShrink(est.eps, f.pfy, Math.abs(gRaw)) };
    const g = Math.min(gRaw, params.gCap);
    const capped = gRaw > params.gCap;
    return {
      cheap: est.eps * g * params.pegLo,
      fair: est.eps * g * params.pegMid,
      rich: est.eps * g * params.pegHi,
      labels: [M().labelPeg(params.pegLo), M().labelPeg(params.pegMid), M().labelPeg(params.pegHi)],
      tag: M().tagGrowth(g),
      basis: `<span class="basis-tag">${M().tagYours}</span>` +
             pick("目標 PEG ", "target PEG ") +
             `${fmt(params.pegLo, 2)} / ${fmt(params.pegMid, 2)} / ${fmt(params.pegHi, 2)}` +
             `<span class="basis-src">${M().srcPrevFy}</span>`,
      formula: M().f.pegFormula(est.eps, est.src, f.pfy, gRaw, capped, params.gCap, g,
                                params.pegLo, params.pegMid, params.pegHi),
    };
  }

  /* 4. 自由現金流法（P/FCF）
   *
   *    台股版這一格是「月營收動能法」—— 台灣規定每月 10 日前公布上月營收，
   *    比季報快約 35 天，所以它是最即時的基本面資料。美國沒有月營收制度，
   *    硬做出一個「季營收動能」，推導後會和上面的年化 EPS 完全相同
   *    （分子分母的季數會消掉），等於同一個數字算兩次。
   *
   *    所以這一格改放美股拿得到、而且其他八種公式都看不到的東西：
   *
   *      自由現金流 = 營業活動現金流 − 資本支出
   *      對應價     = 每股自由現金流 × 你設定的 P/FCF 倍數
   *
   *    盈餘含折舊攤銷與各種應計項目，現金流則是真的收到的錢。
   */
  function methodFcf(s) {
    if (!s.fcfps) {
      if (!FIN[s.c]) return { na: noFin(s) };
      if (s.fcf !== undefined && s.fcf <= 0) {
        return { na: M().f.fcfNegative(money(s.fcf), lbl(s.fcfl)) };
      }
      return { na: M().f.fcfMissing };
    }
    const b = usable(s, "pfcf");
    const [lo, mid, hi] = b || [params.fcfLo, params.fcfMid, params.fcfHi];
    return {
      cheap: s.fcfps * lo, fair: s.fcfps * mid, rich: s.fcfps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: `${lbl(s.fcfl)}`,
      cur: s.pfcf, ref: mid, ratio: "pfcf",
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`, s, "pfcf") +
             `<span class="basis-src">${M().srcFcfps(s.fcfps)}</span>`,
      formula: M().f.fcfFormula(money(s.fcf), lbl(s.fcfl), shares(s.sh), s.fcfps, s.pfcf, lo, mid, hi),
    };
  }

  /* 5. 葛拉漢公式（Benjamin Graham, 1962）　V = EPS × (8.5 + 2g) */
  function methodGraham(s) {
    const est = estimateAnnualEps(s);
    const eps = est ? est.eps : s.eps;
    if (!eps || eps <= 0) {
      return { na: FIN[s.c] ? M().f.grahamNoEps : noFin(s) };
    }
    const g = params.grahamG, span = params.grahamSpan;
    const gs = [g - span, g, g + span];
    // (8.5 + 2g) 在 g < −4.25 時會變成負數，夾住避免出現負價格
    const mult = gs.map((x) => Math.max(8.5 + 2 * x, 0.5));
    return {
      cheap: eps * mult[0], fair: eps * mult[1], rich: eps * mult[2],
      labels: gs.map((x) => M().labelG(x)),
      tag: M().tagGraham(g),
      basis: `<span class="basis-tag">${M().tagYours}</span>` +
             pick(`成長率 g ${fmt(g, 1)}%（±${fmt(span, 1)}%）`,
                  `growth g ${fmt(g, 1)}% (±${fmt(span, 1)}%)`) +
             `<span class="basis-src">${M().srcEps(eps, est ? est.src : M().epsSrcTtm)}</span>`,
      formula: M().f.grahamFormula(gs[0], g, gs[2], mult[0], mult[1], mult[2], eps),
    };
  }

  /* 6. ROE 法 —— 由高登成長模型推導出對應的股價淨值比
   *      P/B = (ROE − g) / (r − g)，再乘上每股淨值。
   */
  function methodRoe(s) {
    if (!s.bvps) return { na: s.eq ? M().f.roeNegEquity : noFin(s) };
    if (!s.roe) return { na: M().f.roeNoRoe };
    const r = params.r / 100, g = params.g / 100, roe = s.roe / 100;
    if (g >= r) return { na: M().f.roeGteR };
    if (roe <= g) return { na: M().f.roeLowRoe(s.roe, params.g) };
    const pbFair = (roe - g) / (r - g);
    const fair = s.bvps * pbFair, m = params.mos / 100;
    return {
      cheap: fair * (1 - m), fair, rich: fair * (1 + m),
      labels: [M().labelPb(pbFair * (1 - m)), M().labelPb(pbFair), M().labelPb(pbFair * (1 + m))],
      basis: `<span class="basis-tag">${M().tagYours}</span>${M().f.roeBasis(params.r, params.g, params.mos)}`,
      formula: M().f.roeFormula(money(s.ni), money(s.eq), s.roe, params.g, params.r,
                                pbFair, s.bvps, fair, params.mos),
    };
  }

  /* 7. 股價淨值比法 —— 每股淨值 × 你選定的 P/B 倍數 */
  function methodPb(s) {
    if (!s.bvps) {
      return { na: s.eq !== undefined ? M().f.pbNegEquity(money(s.eq)) : noFin(s) };
    }
    const b = usable(s, "pb");
    const [lo, mid, hi] = b || [params.pbLo, params.pbMid, params.pbHi];
    return {
      cheap: s.bvps * lo, fair: s.bvps * mid, rich: s.bvps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`, s, "pb"),
      cur: s.pb, ref: mid, ratio: "pb",
      formula: M().f.pbFormula(money(s.eq), shares(s.sh), s.bvps, lo, mid, hi),
    };
  }

  /* 8. 股價營收比（P/S）—— 營收恆為正，虧損公司也算得出來 */
  function methodPs(s) {
    if (!s.sps) return { na: FIN[s.c] ? M().f.psNoRev : noFin(s) };
    const b = usable(s, "ps");
    const [lo, mid, hi] = b || [params.psLo, params.psMid, params.psHi];
    return {
      cheap: s.sps * lo, fair: s.sps * mid, rich: s.sps * hi,
      labels: [M().labelMultiple(lo), M().labelMultiple(mid), M().labelMultiple(hi)],
      tag: M().tagCurrent(s.ps),
      cur: s.ps, ref: mid, ratio: "ps",
      basis: basisTag(b, `${fmt(lo)} / ${fmt(mid)} / ${fmt(hi)}${X()}`, s, "ps") +
             `<span class="basis-src">${M().srcSps(s.sps)}</span>`,
      formula: M().f.psFormula(money(s.rev), shares(s.sh), s.sps, lo, mid, hi),
    };
  }

  /* 9. 股利法 —— 每股現金股利 ÷ 你設定的目標殖利率
   *    殖利率與股價成反比，故最高的殖利率對應最低的價格。 */
  function methodDiv(s) {
    if (!s.d) return { na: FIN[s.c] ? M().f.divNone : noFin(s) };
    const b = usable(s, "y");
    // 歷史／同業區間為 [P20, P50, P80]；殖利率與價格成反比，取用時左右對調
    const yCheap = b ? b[2] : params.yHi;
    const yFair = b ? b[1] : params.yMid;
    const yRich = b ? b[0] : params.yLo;
    return {
      cheap: s.d / (yCheap / 100), fair: s.d / (yFair / 100), rich: s.d / (yRich / 100),
      labels: [M().labelYield(yCheap), M().labelYield(yFair), M().labelYield(yRich)],
      basis: basisTag(b, pick("殖利率 ", "yield ") +
                         `${fmt(yCheap)}% / ${fmt(yFair)}% / ${fmt(yRich)}%`, s, "y"),
      formula: M().f.divFormula(s.d, s.y, yCheap, yFair, yRich),
    };
  }

  // 依估價基礎分組：本益比家族 → 現金流 → 淨值類 → 營收類 → 股利類
  // 名稱與副標由字典提供（MSG.*.names）；en 欄是卡片右側那行固定的英文學名，
  // 中文介面下當作副標，英文介面下就是標題本身，所以只在中文介面顯示。
  const METHODS = [
    { id: "pefwd", en: "Forward P/E", fn: methodPeFwd },
    { id: "pe", en: "Trailing P/E", fn: methodPe },
    { id: "peg", en: "PEG Ratio", fn: methodPeg },
    { id: "fcf", en: "Price / Free Cash Flow", fn: methodFcf },
    { id: "graham", en: "Graham Formula", fn: methodGraham },
    { id: "roe", en: "Return on Equity", fn: methodRoe },
    { id: "pb", en: "P/B Ratio", fn: methodPb },
    { id: "ps", en: "P/S Ratio", fn: methodPs },
    { id: "div", en: "Dividend", fn: methodDiv },
  ];

  // ═══════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════
  function render() {
    if (!current) return;
    const s = current;

    el.sName.textContent = s.n;
    el.sCode.textContent = s.c;
    el.sMarket.textContent = s.m;
    el.sSector.textContent = sectorZh(s.sec);
    el.sSector.hidden = !s.sec;
    el.sDate.textContent = M().closeOn(TRADE_DATE || "—");
    el.sPrice.textContent = fmt(s.p);
    el.sEps.textContent = s.eps ? fmt(s.eps) : "—";
    el.sBvps.textContent = s.bvps ? fmt(s.bvps) : "—";
    el.sRoe.textContent = s.roe ? fmt(s.roe) + " %" : "—";
    el.sDps.textContent = s.d ? fmt(s.d) : "—";
    el.sPe.textContent = s.pe ? fmt(s.pe) + X() : "—";
    el.sPb.textContent = s.pb ? fmt(s.pb) + X() : "—";
    el.sPs.textContent = s.ps ? fmt(s.ps) + X() : "—";
    el.sY.textContent = s.y ? fmt(s.y) + " %" : "—";
    el.sFcfps.textContent = s.fcfps ? fmt(s.fcfps) : "—";
    el.sMc.textContent = s.mc ? money(s.mc) : "—";
    el.sSh.textContent = s.sh ? shares(s.sh) + M().shares : "—";
    el.sFq.textContent = lbl(s.fq);
    renderBasisNote(s);
    // s.mg 已經是 [[年度, 毛利率, 營業利益率], ...]，後端算好了
    renderMarginTable(s.mg);

    const results = {};
    el.methods.innerHTML = "";
    METHODS.forEach((m) => {
      const res = m.fn(s);
      results[m.id] = res;
      const on = !offMethods.has(m.id);
      const [name, subtitle] = M().names[m.id];
      const fallback = [M().colLo, M().colMid, M().colHi];
      const card = document.createElement("div");
      card.className = "method" + (res.na ? " na" : (on ? "" : " off"));
      card.innerHTML = `
        <div class="method-head">
          ${res.na ? "" :
            `<input type="checkbox" class="method-toggle" data-m="${m.id}" ${on ? "checked" : ""}
                    aria-label="${M().includeAria}">`}
          <h3>${name}${(res.tag || subtitle) ? `<span class="m-tag">${res.tag || subtitle}</span>` : ""}${L() === "en" ? "" : `<span class="m-en">${m.en}</span>`}</h3>
        </div>
        ${res.na
          ? `<p class="method-basis">—</p><p class="method-na">⚠︎ ${res.na}</p>`
          : `<p class="method-basis">${res.basis}</p>
             <div class="method-prices">
               <div class="mp lo"><span>${(res.labels || fallback)[0]}</span><strong>${fmt(res.cheap)}</strong></div>
               <div class="mp mid"><span>${(res.labels || fallback)[1]}</span><strong>${fmt(res.fair)}</strong></div>
               <div class="mp hi"><span>${(res.labels || fallback)[2]}</span><strong>${fmt(res.rich)}</strong></div>
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

  /** 個股卡上的資料基準說明：近四季是怎麼拼出來的，或為什麼沒有財報 */
  function renderBasisNote(s) {
    const box = $("basisNote");
    if (!box) return;
    const f = (FIN[s.c] || {}).e;
    if (!f) {
      box.innerHTML = `<span class="dn-ico">ⓘ</span><div>${noFin(s, true)}
        ${M().noFinTail}${s.co === "Taiwan" ? M().noFinTwLink : ""}</div>`;
      box.hidden = false;
      return;
    }
    const parts = [];
    if (f.n) {
      parts.push(M().noteTtm(lbl(f.fyl), f.fy, f.fye, f.n, f.ytd, lbl(f.l), s.eps));
    } else {
      parts.push(M().noteFyOnly(lbl(f.fyl), f.fye, f.fy));
    }
    if (!f.x) parts.push(M().noteInexact(lbl(f.fyl)));
    if (s.epsalt) parts.push(M().noteEpsAlt);
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

  /* 獲利品質：毛利率與營業利益率的走勢
   *
   * 刻意不做成第十二種公式，也不進彙總統計 —— 它不是估價指標，
   * 而是「各公式分母的那個盈餘，品質如何」。特斯拉是最好的例子：
   * 營收幾乎沒掉，但營業利益率一路壓縮，EPS 就是這樣掉下來的。
   *
   * rows: [[期間標籤, 毛利率, 營業利益率], ...]（百分比，可為 null）
   */
  function renderMarginTable(rows) {
    const box = $("marginBox");
    if (!box) return;
    if (!rows || !rows.length) { box.hidden = true; return; }
    const pct = (v) => (v === null || v === undefined || !isFinite(v))
      ? "—" : fmt(v, 1) + "%";
    $("mgHead").innerHTML =
      `<th>${M().mgPeriod}</th>` +
      rows.map((r, i) => `<th${i === rows.length - 1 ? ' class="now"' : ""}>${r[0]}</th>`).join("");
    const line = (label, idx) =>
      `<tr><td>${label}</td>` +
      rows.map((r, i) => `<td${i === rows.length - 1 ? ' class="now"' : ""}>${pct(r[idx])}</td>`).join("") +
      `</tr>`;
    $("mgBody").innerHTML = line(M().mgGross, 1) + line(M().mgOper, 2);

    // 只描述走勢，不評價。用第一個與最後一個都有值的點比較。
    const pts = rows.map((r) => r[2]).map((v, i) => [i, v]).filter(([, v]) => v != null);
    let note = M().mgNote;
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1];
      const diff = b[1] - a[1];
      if (Math.abs(diff) >= 1) {
        note = M().mgTrend(rows[a[0]][0], a[1], rows[b[0]][0], b[1], diff) + note;
      }
    }
    $("mgNote").innerHTML = note;
    box.hidden = false;
  }

  /* 現價落在所有計算值之外時的說明
   *
   * 這種情況（例如獲利大幅衰退但股價還在高檔）畫面上會出現一整排遠低於現價
   * 的數字，第一眼很像資料抓錯。與其讓使用者自己猜，直接把落差最大的那個
   * 比率指出來 —— 那就是所有公式一起偏低的同一個原因。
   *
   * 只陳述倍數關係，不說貴或便宜：計算值不必然是對的，市價也不必然是對的。
   */
  function outlierNote(s, all, results) {
    if (!all.length) return "";
    const lo = all[0], hi = all[all.length - 1];
    const above = s.p > hi, below = s.p < lo;
    if (!above && !below) return "";
    let worst = null;
    for (const m of METHODS) {
      const r = results[m.id];
      if (!r || r.na || !r.cur || !r.ref) continue;
      const k = above ? r.cur / r.ref : r.ref / r.cur;
      if (k > 1 && (!worst || k > worst.k)) {
        worst = { k, cur: r.cur, ref: r.ref, name: M().ratioNames[r.ratio] };
      }
    }
    return M().outlier(above, s.p, above ? hi : lo, all.length, worst);
  }

  /* 計算值彙總
   *
   * 只做敘述統計：把各公式在你設定的參數下算出的數值蒐集起來，report
   * 最小值、中位數、最大值，以及現價落在這些數值中的相對位置。
   * 不對任何一個數值賦予「便宜／合理／昂貴」之類的評價 —— 倍數與假設
   * 是你自己選的，結論也應該由你自己下。
   */
  function renderSummary(s, results) {
    const used = METHODS.filter((m) => !results[m.id].na && !offMethods.has(m.id))
                        .map((m) => results[m.id]);
    const all = used.flatMap((r) => [r.cheap, r.fair, r.rich])
                    .filter((v) => isFinite(v) && v > 0)
                    .sort((a, b) => a - b);

    const lo = all.length ? all[0] : null;
    const hi = all.length ? all[all.length - 1] : null;
    const md = median(all);

    el.tCheap.textContent = fmt(lo);
    el.tFair.textContent = fmt(md);
    el.tRich.textContent = fmt(hi);
    el.gScaleL.innerHTML = `<i>${M().scaleMin}</i> <b>${fmt(lo)}</b>`;
    el.gScaleM.innerHTML = `<i>${M().scaleMid}</i> <b>${fmt(md)}</b>`;
    el.gScaleR.innerHTML = `<i>${M().scaleMax}</i> <b>${fmt(hi)}</b>`;
    renderMiniBar([M().scaleMin, M().scaleMid, M().scaleMax],
                  [fmt(lo), fmt(md), fmt(hi)], M().usedCount(used.length));
    el.gaugePrice.textContent = fmt(s.p);

    if (!all.length || !(lo < hi)) {
      el.gaugeMark.style.left = "50%";
      el.verdict.className = "verdict";
      el.verdict.textContent = used.length ? M().sumSingle
        : (FIN[s.c] ? M().sumNone : M().sumNoFin);
      return;
    }

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
      outlierNote(s, all, results) +
      (used.length <= 2 ? M().verdictThin(used.length, psHint) : "");
  }

  // ═══════════════════════════════════════════════════════
  //  搜尋
  // ═══════════════════════════════════════════════════════
  function search(kw) {
    const raw = kw.trim();
    let out = rawSearch(raw);
    // 選定後搜尋框留著「AAPL Apple Inc.」，接著打字會變成搜不到的字串，
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
             (x.c.toLowerCase().startsWith(kw) || x.n.toLowerCase().includes(kw))).slice(0, 11)];
      if (code.startsWith(kw) || name.startsWith(kw)) starts.push(s);
      else if (name.includes(kw)) contains.push(s);
      if (starts.length > 30) break;
    }
    // 同樣是開頭吻合時，市值大的排前面 —— 美股代號重疊多，這樣比較好找
    starts.sort((a, b) => (b.mc || 0) - (a.mc || 0));
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
        <span class="s-meta">${s.m}　${fmt(s.p)}</span>
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
  async function boot() {
    try {
      const [us, fin] = await Promise.all([
        fetch("data/us.json?t=" + Date.now()).then((r) => {
          if (!r.ok) throw new Error("us.json " + r.status);
          return r.json();
        }),
        fetch("data/us_fin.json?t=" + Date.now()).then((r) => (r.ok ? r.json() : null))
                                                 .catch(() => null),
      ]);
      STOCKS = us.stocks;
      INDEX = new Map(STOCKS.map((s) => [s.c, s]));
      SECT = us.sectors || {};
      if (fin && fin.fin) FIN = fin.fin;
      TRADE_DATE = us.trade_date || "";
      el.dataDate.textContent = M().dataDate(TRADE_DATE || "—");
      el.dataCount.textContent = M().count(us.count || STOCKS.length);
      el.loading.hidden = true;

      const hash = decodeURIComponent(location.hash.replace("#", "")).trim().toUpperCase();
      if (hash && INDEX.has(hash)) select(hash);
    } catch (err) {
      el.loading.hidden = true;
      el.errorBox.hidden = false;
      el.errorBox.innerHTML = M().loadFail(err.message);
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
                 pFcfLo: "fcfLo", pFcfMid: "fcfMid", pFcfHi: "fcfHi",
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
    localStorage.setItem("us_params", JSON.stringify(params));
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
      localStorage.removeItem("us_params");
      if (current) render();
    });

    el.themeBtn.addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      localStorage.setItem("fv_theme", dark ? "light" : "dark");
    });
    // 語言一換，程式產生的文字全部要重來：頂列的資料日期、九張公式卡、彙總敘述
    document.addEventListener("langchange", () => {
      if (TRADE_DATE || STOCKS.length) {
        el.dataDate.textContent = M().dataDate(TRADE_DATE || "—");
        el.dataCount.textContent = M().count(STOCKS.length);
      }
      if (current) render();
    });
    addEventListener("hashchange", () => {
      const h = decodeURIComponent(location.hash.replace("#", "")).trim().toUpperCase();
      if (h && INDEX.has(h) && (!current || current.c !== h)) select(h);
    });
  }

  // ── 啟動 ────────────────────────────────────────────────
  initTheme();
  try {
    const saved = JSON.parse(localStorage.getItem("us_params") || "null");
    if (saved) params = { ...DEFAULTS, ...saved };
    const off = JSON.parse(localStorage.getItem(OFF_KEY) || "null");
    offMethods = new Set(off === null ? DEFAULT_OFF : off);
  } catch (_) { /* 忽略毀損的設定 */ }
  writeParams();
  bind();
  syncMiniBar = watchSummary();
  boot();
})();
