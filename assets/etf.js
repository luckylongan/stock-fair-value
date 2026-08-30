/* 幾塊你要買？ —— ETF 折溢價
 *
 * ETF 沒有財報，個股那些估價公式大多完全不適用，所以這頁不做估價，
 * 只呈現一件可以客觀計算的事：市價與預估淨值的差距（折溢價率）。
 *
 *   折溢價率 = (市價 − 預估淨值) ÷ 預估淨值 × 100%
 *
 * 資料：data/etf.json，由 scripts/fetch_etf.py 每交易日更新。
 */
(() => {
  "use strict";

  let ETFS = [];
  let INDEX = new Map();
  let current = null;
  let sugIdx = -1;
  let DATA_DATE = "", COUNT = 0;

  const $ = (id) => document.getElementById(id);
  const L = () => (window.I18N ? window.I18N.lang : "zh");
  const M = () => MSG[L()] || MSG.zh;
  const fmt = (v, d = 2) =>
    (v === null || v === undefined || !isFinite(v)) ? "—"
      : v.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };

  // 帶變數的訊息沒辦法像 HTML 那樣把兩份都寫死靠 CSS 切，各寫成一個函式。
  // 分類標籤是資料值，但只有固定幾種，顯示時轉語言。
  // ETF 名稱是投信登記的正式中文名、沒有官方英譯，一律維持原文。
  const KIND_EN = {
    "原型": "Plain", "債券": "Bond", "主動": "Active", "槓桿": "Leveraged",
    "反向": "Inverse", "期貨": "Futures", "多幣別": "Multi-currency",
  };
  const KDESC_EN = {
    "主動式管理，非追蹤指數": "actively managed, does not track an index",
    "追蹤指數的原型 ETF": "a plain index-tracking ETF",
    "單日正向倍數，長期持有有複利耗損": "a daily leveraged multiple; compounding decay makes it unsuitable for long holds",
    "單日反向，長期持有有複利耗損": "daily inverse; compounding decay makes it unsuitable for long holds",
    "期貨信託，有轉倉成本": "a futures trust, which carries roll costs",
    "投資國外債券，淨值受匯率與債市影響": "invests in overseas bonds; NAV moves with exchange rates and bond markets",
    "以外幣計價之受益憑證": "a beneficiary certificate denominated in a foreign currency",
  };
  const MARKET_EN = { "上市": "TWSE", "上櫃": "TPEx" };
  const kind = (k) => (L() === "en" ? (KIND_EN[k] || k) : k);
  const kdesc = (d) => (L() === "en" ? (KDESC_EN[d] || d) : d);
  const mkt = (m) => (L() === "en" ? (MARKET_EN[m] || m) : m);

  const MSG = {
    zh: {
      dataDate: (d) => `資料日 ${d}`,
      count: (n) => `${n} 檔 ETF`,
      noNav: "無淨值資料",
      premUp: "溢價（市價高於淨值）", premDown: "折價（市價低於淨值）", premFlat: "貼近淨值",
      noNavNote: `來源未提供這檔的預估淨值，因此無法計算折溢價。可到該投信官網查詢。`,
      near: "市價與淨值差距在 0.5% 以內，屬一般水準。",
      over: (p, per) => `市價比它持有的資產淨值<b>高 ${fmt(p)}%</b>，
             每投入 10,000 元約有 <b>${fmt(per, 0)} 元</b>買在淨值之上。`,
      under: (p, rest) => `市價比它持有的資產淨值<b>低 ${fmt(p)}%</b>，
             每投入 10,000 元約相當於用 <b>${fmt(rest, 0)} 元</b>買到 10,000 元的資產。`,
      kindNote: (kind, desc) => `<br><br><b>${kind}</b>：${desc}。`,
      tail: `<br><br>預估淨值由投信盤中估算、非官方收盤淨值；折溢價會隨造市與流動性變動，
        這個數字只描述當日狀態，不代表未來，也不構成買賣建議。`,
      boardSub: (n, md, over, under) =>
        `共 <b>${n}</b> 檔有淨值資料。折溢價率中位數 <b>${md}</b>，` +
        `其中溢價超過 1% 有 <b>${over}</b> 檔、折價超過 1% 有 <b>${under}</b> 檔。`,
      noHit: (q) => `找不到「${q}」——請輸入 ETF 代號或名稱`,
      loadFail: (m) => `<b>讀不到 ETF 資料</b>無法載入 <code>data/etf.json</code>（${m}）。
        若是在本機直接以檔案開啟網頁，請改用 <code>python3 scripts/serve.py</code> 再瀏覽。`,
    },
    en: {
      dataDate: (d) => `Data as of ${d}`,
      count: (n) => `${n} ETFs`,
      noNav: "no NAV data",
      premUp: "premium (price above NAV)", premDown: "discount (price below NAV)",
      premFlat: "in line with NAV",
      noNavNote: `The source does not publish an estimated NAV for this ETF, so no premium can be
        computed. Check the fund manager's own site.`,
      near: "Price and NAV are within 0.5% of each other — an ordinary level.",
      over: (p, per) => `The market price is <b>${fmt(p)}% above</b> the net asset value of what it
             holds. For every NT$10,000 invested, roughly <b>NT$${fmt(per, 0)}</b> is paid above NAV.`,
      under: (p, rest) => `The market price is <b>${fmt(p)}% below</b> the net asset value of what it
             holds. Every NT$10,000 invested buys roughly NT$10,000 of assets for about
             <b>NT$${fmt(rest, 0)}</b>.`,
      kindNote: (kind, desc) => `<br><br><b>${kind}</b>: ${desc}.`,
      tail: `<br><br>Estimated NAV is calculated intraday by the fund manager and is not the official
        closing NAV. Premiums move with market-making and liquidity, so this figure describes today
        only, says nothing about the future, and is not buy or sell advice.`,
      boardSub: (n, md, over, under) =>
        `<b>${n}</b> ETFs have NAV data. The median premium is <b>${md}</b>; ` +
        `<b>${over}</b> trade at a premium above 1% and <b>${under}</b> at a discount below −1%.`,
      noHit: (q) => `No match for "${q}" — enter an ETF code or name`,
      loadFail: (m) => `<b>Could not load ETF data</b> Failed to fetch <code>data/etf.json</code> (${m}).
        If you opened this page directly from the filesystem, run <code>python3 scripts/serve.py</code> and browse through that instead.`,
    },
  };

  // ── 個別 ETF ────────────────────────────────────────────
  function render() {
    const e = current;
    if (!e) return;
    $("eName").textContent = e.n;
    $("eCode").textContent = e.c;
    $("eMarket").textContent = mkt(e.m);
    $("eKind").textContent = kind(e.kind);
    $("eFull").textContent = e.full || "";
    $("eFull").hidden = !e.full;
    $("ePrice").textContent = fmt(e.p);

    const box = $("premNote");
    if (e.prem === undefined || e.nav === undefined) {
      $("ePrem").textContent = "—";
      $("ePremWord").textContent = M().noNav;
      $("eNav").textContent = $("eNav2").textContent = "—";
      box.className = "dilution-note";
      box.innerHTML = `<span class="dn-ico">ⓘ</span><div>${M().noNavNote}</div>`;
      box.hidden = false;
      return;
    }

    $("eNav").textContent = $("eNav2").textContent = fmt(e.nav);
    const p = e.prem;
    $("ePrem").textContent = (p >= 0 ? "+" : "−") + fmt(Math.abs(p)) + "%";
    $("ePrem").className = p > 0.05 ? "prem-up" : (p < -0.05 ? "prem-down" : "");
    $("ePremWord").textContent = p > 0.05 ? M().premUp
      : (p < -0.05 ? M().premDown : M().premFlat);

    // 說明文字：只描述這個數字的意思，不建議買賣
    const per10k = Math.abs(p) / 100 * 10000;
    let msg;
    if (Math.abs(p) < 0.5) msg = M().near;
    else if (p > 0) msg = M().over(p, per10k);
    else msg = M().under(Math.abs(p), 10000 - per10k);
    box.className = "dilution-note";
    box.innerHTML = `<span class="dn-ico">⚖︎</span><div>${msg}` +
      (e.kdesc ? M().kindNote(kind(e.kind), kdesc(e.kdesc)) : "") + M().tail + `</div>`;
    box.hidden = false;
  }

  function select(code) {
    const e = INDEX.get(code);
    if (!e) return;
    current = e;
    $("q").value = `${e.c} ${e.n}`;
    $("suggest").hidden = true;
    $("clearBtn").hidden = false;
    $("result").hidden = false;
    history.replaceState(null, "", "#" + code);
    render();
  }

  // ── 搜尋 ────────────────────────────────────────────────
  function search(kw) {
    const raw = kw.trim();
    let out = rawSearch(raw);
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
    for (const e of ETFS) {
      const c = e.c.toLowerCase(), n = e.n.toLowerCase();
      if (c === kw) return [e, ...ETFS.filter((x) => x !== e &&
             (x.c.toLowerCase().startsWith(kw) || x.n.includes(kw))).slice(0, 11)];
      if (c.startsWith(kw) || n.startsWith(kw)) starts.push(e);
      else if (n.includes(kw) || (e.full || "").includes(kw)) contains.push(e);
      if (starts.length > 30) break;
    }
    return [...starts, ...contains].slice(0, 12);
  }

  function showSuggest(list, kw) {
    sugIdx = -1;
    const box = $("suggest");
    if (!list.length) {
      const q = (kw || "").trim();
      if (!q) { box.hidden = true; return; }
      box.innerHTML = `<li class="no-hit">${M().noHit(q)}</li>`;
      box.hidden = false;
      return;
    }
    box.innerHTML = list.map((e) => `
      <li data-code="${e.c}">
        <span class="s-code">${e.c}</span>
        <span class="s-name">${e.n}</span>
        <span class="s-meta">${kind(e.kind)}　${e.prem === undefined ? "—" :
          (e.prem >= 0 ? "+" : "−") + fmt(Math.abs(e.prem)) + "%"}</span>
      </li>`).join("");
    box.hidden = false;
    box.querySelectorAll("li[data-code]").forEach((li) =>
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); select(li.dataset.code); }));
  }

  // ── 全市場分佈 ──────────────────────────────────────────
  function renderBoard() {
    const withNav = ETFS.filter((e) => e.prem !== undefined);
    if (!withNav.length) return;
    const prem = withNav.map((e) => e.prem);
    const md = median(prem);
    $("boardSub").innerHTML = M().boardSub(
      withNav.length,
      (md >= 0 ? "+" : "−") + fmt(Math.abs(md)) + "%",
      prem.filter((p) => p > 1).length,
      prem.filter((p) => p < -1).length);

    const sorted = [...withNav].sort((a, b) => b.prem - a.prem);
    const row = (e) => `<li>
        <a href="#${e.c}" data-code="${e.c}">
          <span class="bl-code">${e.c}</span>
          <span class="bl-name">${e.n}</span>
          <span class="bl-kind">${kind(e.kind)}</span>
          <span class="bl-prem ${e.prem >= 0 ? "up" : "down"}">${e.prem >= 0 ? "+" : "−"}${fmt(Math.abs(e.prem))}%</span>
        </a></li>`;
    $("topPrem").innerHTML = sorted.slice(0, 10).map(row).join("");
    $("topDisc").innerHTML = sorted.slice(-10).reverse().map(row).join("");

    document.querySelectorAll(".board-list a").forEach((a) =>
      a.addEventListener("click", (ev) => { ev.preventDefault(); select(a.dataset.code); }));
    $("board").hidden = false;
  }

  // ── 啟動 ────────────────────────────────────────────────
  async function boot() {
    try {
      const d = await fetch("data/etf.json?t=" + Date.now()).then((r) => {
        if (!r.ok) throw new Error("etf.json " + r.status);
        return r.json();
      });
      ETFS = d.etfs || [];
      INDEX = new Map(ETFS.map((e) => [e.c, e]));
      const navd = ETFS.find((e) => e.navd) || {};
      DATA_DATE = navd.navd
        ? navd.navd.slice(0, 4) + "-" + navd.navd.slice(4, 6) + "-" + navd.navd.slice(6)
        : (d.updated_at || "").slice(0, 10);
      COUNT = d.count;
      $("dataDate").textContent = M().dataDate(DATA_DATE);
      $("dataCount").textContent = M().count(COUNT);
      $("loading").hidden = true;
      renderBoard();

      const hash = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (hash && INDEX.has(hash)) select(hash);
    } catch (err) {
      $("loading").hidden = true;
      const box = $("errorBox");
      box.hidden = false;
      box.innerHTML = M().loadFail(err.message);
    }
  }

  function bind() {
    const q = $("q");
    q.addEventListener("input", () => {
      $("clearBtn").hidden = !q.value;
      showSuggest(search(q.value), q.value);
    });
    q.addEventListener("focus", () => {
      if (q.value) { q.select(); showSuggest(search(q.value), q.value); }
    });
    q.addEventListener("blur", () => setTimeout(() => ($("suggest").hidden = true), 120));
    q.addEventListener("keydown", (ev) => {
      const items = [...$("suggest").querySelectorAll("li[data-code]")];
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!items.length) return;
        ev.preventDefault();
        sugIdx = (sugIdx + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle("active", i === sugIdx));
        items[sugIdx].scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (items.length) select(items[Math.max(0, sugIdx)].dataset.code);
      } else if (ev.key === "Escape") {
        $("suggest").hidden = true;
      }
    });
    $("clearBtn").addEventListener("click", () => {
      q.value = ""; $("clearBtn").hidden = true; $("suggest").hidden = true; q.focus();
    });
    document.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => select(c.dataset.code)));
    $("themeBtn").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      localStorage.setItem("fv_theme", dark ? "light" : "dark");
    });
    // 語言一換，程式產生的文字要重來：頂列、折溢價說明、全市場那一句
    document.addEventListener("langchange", () => {
      if (DATA_DATE) $("dataDate").textContent = M().dataDate(DATA_DATE);
      if (COUNT) $("dataCount").textContent = M().count(COUNT);
      if (ETFS.length) renderBoard();
      if (current) render();
    });
    addEventListener("hashchange", () => {
      const h = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (h && INDEX.has(h) && (!current || current.c !== h)) select(h);
    });
  }

  // 主題與其他頁共用
  const saved = localStorage.getItem("fv_theme");
  document.documentElement.dataset.theme =
    (saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark" : "light";
  bind();
  boot();
})();
