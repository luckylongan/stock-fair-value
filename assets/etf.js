/* 幾塊你要買？ —— ETF 折溢價
 *
 * ETF 沒有財報，個股那九種估價公式有七種完全不適用，所以這頁不做估價，
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

  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 2) =>
    (v === null || v === undefined || !isFinite(v)) ? "—"
      : v.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };

  // ── 個別 ETF ────────────────────────────────────────────
  function render() {
    const e = current;
    if (!e) return;
    $("eName").textContent = e.n;
    $("eCode").textContent = e.c;
    $("eMarket").textContent = e.m;
    $("eKind").textContent = e.kind;
    $("eFull").textContent = e.full || "";
    $("eFull").hidden = !e.full;
    $("ePrice").textContent = fmt(e.p);

    const box = $("premNote");
    if (e.prem === undefined || e.nav === undefined) {
      $("ePrem").textContent = "—";
      $("ePremWord").textContent = "無淨值資料";
      $("eNav").textContent = $("eNav2").textContent = "—";
      box.className = "dilution-note";
      box.innerHTML = `<span class="dn-ico">ⓘ</span><div>來源未提供這檔的預估淨值，
        因此無法計算折溢價。可到該投信官網查詢。</div>`;
      box.hidden = false;
      return;
    }

    $("eNav").textContent = $("eNav2").textContent = fmt(e.nav);
    const p = e.prem;
    $("ePrem").textContent = (p >= 0 ? "+" : "−") + fmt(Math.abs(p)) + "%";
    $("ePrem").className = p > 0.05 ? "prem-up" : (p < -0.05 ? "prem-down" : "");
    $("ePremWord").textContent = p > 0.05 ? "溢價（市價高於淨值）"
      : (p < -0.05 ? "折價（市價低於淨值）" : "貼近淨值");

    // 說明文字：只描述這個數字的意思，不建議買賣
    const per10k = Math.abs(p) / 100 * 10000;
    let msg;
    if (Math.abs(p) < 0.5) {
      msg = `市價與淨值差距在 0.5% 以內，屬一般水準。`;
    } else if (p > 0) {
      msg = `市價比它持有的資產淨值<b>高 ${fmt(p)}%</b>，
             每投入 10,000 元約有 <b>${fmt(per10k, 0)} 元</b>買在淨值之上。`;
    } else {
      msg = `市價比它持有的資產淨值<b>低 ${fmt(Math.abs(p))}%</b>，
             每投入 10,000 元約相當於用 <b>${fmt(10000 - per10k, 0)} 元</b>買到 10,000 元的資產。`;
    }
    box.className = "dilution-note";
    box.innerHTML = `<span class="dn-ico">⚖︎</span><div>${msg}
      ${e.kdesc ? `<br><br><b>${e.kind}</b>：${e.kdesc}。` : ""}
      <br><br>預估淨值由投信盤中估算、非官方收盤淨值；折溢價會隨造市與流動性變動，
      這個數字只描述當日狀態，不代表未來，也不構成買賣建議。</div>`;
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
      box.innerHTML = `<li class="no-hit">找不到「${q}」——請輸入 ETF 代號或名稱</li>`;
      box.hidden = false;
      return;
    }
    box.innerHTML = list.map((e) => `
      <li data-code="${e.c}">
        <span class="s-code">${e.c}</span>
        <span class="s-name">${e.n}</span>
        <span class="s-meta">${e.kind}　${e.prem === undefined ? "—" :
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
    $("bCount").textContent = withNav.length;
    const md = median(prem);
    $("bMedian").textContent = (md >= 0 ? "+" : "−") + fmt(Math.abs(md)) + "%";
    $("bOver").textContent = prem.filter((p) => p > 1).length;
    $("bUnder").textContent = prem.filter((p) => p < -1).length;

    const sorted = [...withNav].sort((a, b) => b.prem - a.prem);
    const row = (e) => `<li>
        <a href="#${e.c}" data-code="${e.c}">
          <span class="bl-code">${e.c}</span>
          <span class="bl-name">${e.n}</span>
          <span class="bl-kind">${e.kind}</span>
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
      $("dataDate").textContent = "資料日 " + (navd.navd
        ? navd.navd.slice(0, 4) + "-" + navd.navd.slice(4, 6) + "-" + navd.navd.slice(6)
        : (d.updated_at || "").slice(0, 10));
      $("dataCount").textContent = `${d.count} 檔 ETF`;
      $("loading").hidden = true;
      renderBoard();

      const hash = decodeURIComponent(location.hash.replace("#", "")).trim();
      if (hash && INDEX.has(hash)) select(hash);
    } catch (err) {
      $("loading").hidden = true;
      const box = $("errorBox");
      box.hidden = false;
      box.innerHTML = `<b>讀不到 ETF 資料</b>無法載入 <code>data/etf.json</code>（${err.message}）。
        若是在本機直接以檔案開啟網頁，請改用 <code>python3 scripts/serve.py</code> 再瀏覽。`;
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
