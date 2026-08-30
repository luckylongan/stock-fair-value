/* 幾塊你要買？ —— 中英切換
 *
 * 四頁共用。設計上刻意分成兩條路，因為靜態文字與程式產生的文字性質不同：
 *
 *   1. HTML 裡的靜態文字 —— 中英兩份都寫在原始碼裡，用 CSS 決定顯示哪一份。
 *      · 短標籤：<span data-en="Close">收盤價</span>　（省得為一個詞複製節點）
 *      · 長段落：<p class="i18n-zh">中文…</p><p class="i18n-en">English…</p>
 *      · 屬性　：data-ph-en / data-title-en / data-aria-en
 *      翻譯就放在原文旁邊，改中文時看得到英文還沒跟上，不容易長期失同步。
 *
 *   2. 程式產生的文字（公式推導、不適用原因、彙總敘述）—— 那些字串帶變數，
 *      沒辦法預先寫死。各頁的 script 自己維護一份 MSG 字典，透過 msg() 取用。
 *
 * 語言存在 localStorage，四頁共用同一個鍵，切換後跳到別頁不會被打回中文。
 */
(() => {
  "use strict";

  const KEY = "fv_lang";
  const root = document.documentElement;

  /** 沒設定過的話看瀏覽器語言：中文環境給中文，其餘一律英文。 */
  function initial() {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
    return /^zh\b/i.test(navigator.language || "") ? "zh" : "en";
  }

  let lang = initial();

  /** 屬性類的翻譯：第一次切換前先把中文原值收好，才切得回來。 */
  const ATTRS = [["data-ph-en", "placeholder"],
                 ["data-title-en", "title"],
                 ["data-aria-en", "aria-label"]];

  function applyAttrs() {
    for (const [dataAttr, target] of ATTRS) {
      document.querySelectorAll("[" + dataAttr + "]").forEach((el) => {
        const stash = "zh" + target.replace(/-/g, "");
        if (el.dataset[stash] === undefined) el.dataset[stash] = el.getAttribute(target) || "";
        el.setAttribute(target, lang === "en" ? el.getAttribute(dataAttr) : el.dataset[stash]);
      });
    }
  }

  /** data-en 的短標籤：同樣先收好中文原文再換。 */
  function applyText() {
    document.querySelectorAll("[data-en]").forEach((el) => {
      if (el.dataset.zhText === undefined) el.dataset.zhText = el.innerHTML;
      el.innerHTML = lang === "en" ? el.dataset.en : el.dataset.zhText;
    });
  }

  /** <title> 與 meta description 也要跟著換 —— 分頁標題是中文、內容是英文很怪，
   *  而且搜尋引擎抓到的是哪一份要看它先讀到什麼。 */
  function applyMeta() {
    const t = document.querySelector("title[data-en]");
    if (t) {
      if (t.dataset.zhText === undefined) t.dataset.zhText = t.textContent;
      t.textContent = lang === "en" ? t.dataset.en : t.dataset.zhText;
    }
    const d = document.querySelector('meta[name="description"][data-en]');
    if (d) {
      if (d.dataset.zhText === undefined) d.dataset.zhText = d.getAttribute("content") || "";
      d.setAttribute("content", lang === "en" ? d.dataset.en : d.dataset.zhText);
    }
  }

  function apply() {
    root.dataset.lang = lang;
    root.setAttribute("lang", lang === "en" ? "en" : "zh-Hant");
    applyAttrs();
    applyText();
    applyMeta();
    const btn = document.getElementById("langBtn");
    // 按鈕顯示「切過去會變成什麼」，不是「現在是什麼」
    if (btn) {
      btn.textContent = lang === "en" ? "中文" : "EN";
      btn.title = lang === "en" ? "切換為中文" : "Switch to English";
    }
    document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
  }

  // 對外的極小介面，各頁 script 用這兩個就夠
  window.I18N = {
    get lang() { return lang; },
    /** 從一份 {zh:{...}, en:{...}} 字典取出目前語言那一份 */
    msg(dict) { return dict[lang] || dict.zh; },
    /** 依語言挑一個值，給零星的一兩處用 */
    pick(zh, en) { return lang === "en" ? en : zh; },
  };

  // 先套一次語言再讓頁面 script 跑，避免畫面閃一下中文又換成英文
  root.dataset.lang = lang;
  root.setAttribute("lang", lang === "en" ? "en" : "zh-Hant");

  document.addEventListener("DOMContentLoaded", () => {
    apply();
    const btn = document.getElementById("langBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        lang = lang === "en" ? "zh" : "en";
        localStorage.setItem(KEY, lang);
        apply();
      });
    }
  });
})();
