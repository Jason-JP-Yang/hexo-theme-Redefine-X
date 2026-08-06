/* utils function */
import { navbarShrink } from "./layouts/navbarShrink.js";
import { getTOC } from "./layouts/toc.js";
import { main } from "./main.js";
import imageViewer from "./tools/imageViewer.js";
import { onScroll, requestScrollPass } from "./tools/scrollScheduler.js";

export const navigationState = {
  isNavigating: false,
};

// initUtils() re-runs on every Swup page:view. The scroll subscription must NOT:
// it is registered exactly once and reads the latest utils object through this
// slot. Before, every navigation added two more permanent window listeners that
// nothing ever removed, so the per-frame scroll cost grew for the whole session.
let activeUtils = null;

/**
 * Re-stamp the "x minutes ago" labels on the home article list.
 *
 * Client-side pagination swaps the card list without re-running initUtils(),
 * and freshly fetched cards carry the server-rendered absolute date. Exposed so
 * layouts/homePagination.js can refresh just this, instead of re-initialising
 * every utility (which would restart the banner typing animation).
 */
export function refreshHomeRelativeTime() {
  if (activeUtils) activeUtils.relativeTimeInHome();
}
let scrollWired = false;

export default function initUtils() {
  const utils = {
    html_root_dom: document.querySelector("html"),
    pageContainer_dom: document.querySelector(".page-container"),
    pageTop_dom: document.querySelector(".main-content-header"),
    homeBanner_dom: document.querySelector(".home-banner-container"),
    homeBannerBackground_dom: document.querySelector(".home-banner-background"),
    scrollProgressBar_dom: document.querySelector(".scroll-progress-bar"),
    pjaxProgressBar_dom: document.querySelector(".pjax-progress-bar"),
    backToTopButton_dom: document.querySelector(".tool-scroll-to-top"),
    toolsList: document.querySelector(".hidden-tools-list"),
    toggleButton: document.querySelector(".toggle-tools-list"),

    innerHeight: window.innerHeight,
    pjaxProgressBarTimer: null,
    prevScrollValue: 0,
    fontSizeLevel: 0,
    triggerViewHeight: 0.5 * window.innerHeight,

    isHasScrollProgressBar: theme.global.scroll_progress.bar === true,
    isHasScrollPercent: theme.global.scroll_progress.percentage === true,

    // Scroll Style — WRITE phase only. Every geometry value it needs comes from
    // the shared scheduler's per-frame metrics bag, so this no longer forces a
    // layout (it used to read documentElement.scrollHeight on every event, after
    // the previous handler had already dirtied the layout).
    updateScrollStyle(m) {
      const scrollTop = m.scrollY;
      const percent = this.calculatePercentage(scrollTop, m.docH, m.viewportH);

      this.updateScrollProgressBar(percent);
      this.updateScrollPercent(percent);
      this.updatePageTopVisibility(scrollTop, m.viewportH);

      this.prevScrollValue = scrollTop;
    },

    // Every writer below is guarded against re-writing a value that is already
    // on the element. During Swup's animated scroll-to-top these ran ~60×/s and
    // most frames produced an identical value — each redundant write still cost
    // a style recalc and a repaint.
    _lastBarWidth: null,
    _lastBarVisibility: null,
    updateScrollProgressBar(percent) {
      if (!this.isHasScrollProgressBar || !this.scrollProgressBar_dom) return;
      const width = `${percent.toFixed(3)}%`;
      const visibility = percent === 0 ? "hidden" : "visible";

      if (visibility !== this._lastBarVisibility) {
        this._lastBarVisibility = visibility;
        this.scrollProgressBar_dom.style.visibility = visibility;
      }
      if (width !== this._lastBarWidth) {
        this._lastBarWidth = width;
        this.scrollProgressBar_dom.style.width = width;
      }
    },

    _percentDom: null,
    _lastPercentText: null,
    updateScrollPercent(percent) {
      if (!this.isHasScrollPercent || !this.backToTopButton_dom) return;
      if (!this._percentDom || !this._percentDom.isConnected) {
        this._percentDom = this.backToTopButton_dom.querySelector(".percent");
        this._lastPercentText = null;
      }
      const showButton = percent !== 0 && percent !== undefined;

      this.backToTopButton_dom.classList.toggle("show", showButton);
      const text = percent.toFixed(0);
      if (this._percentDom && text !== this._lastPercentText) {
        this._lastPercentText = text;
        this._percentDom.textContent = text;
      }
    },

    updatePageTopVisibility(scrollTop, clientHeight) {
      if (!this.pageTop_dom) return;
      if (theme.navbar.auto_hide) {
        const prevScrollValue = this.prevScrollValue;
        const hidePageTop =
          prevScrollValue > clientHeight && scrollTop > prevScrollValue;

        this.pageTop_dom.classList.toggle("hide", hidePageTop);
      } else {
        this.pageTop_dom.classList.remove("hide");
      }
    },

    calculatePercentage(scrollTop, scrollHeight, clientHeight) {
      let percentageValue = Math.round(
        (scrollTop / (scrollHeight - clientHeight)) * 100,
      );
      if (
        isNaN(percentageValue) ||
        percentageValue < 0 ||
        !isFinite(percentageValue)
      ) {
        percentageValue = 0;
      } else if (percentageValue > 100) {
        percentageValue = 100;
      }
      return percentageValue;
    },

    // Subscribe to the shared scroll pass. Registered ONCE for the session (see
    // `scrollWired` below); later initUtils() calls only swap `activeUtils`, so
    // navigating never multiplies the per-frame work.
    registerWindowScroll() {
      if (scrollWired) return;
      scrollWired = true;

      onScroll(
        // READ phase — the TOC's active index is pure arithmetic against cached
        // heading offsets, so nothing here touches the DOM or forces layout.
        (m) => {
          const u = activeUtils;
          if (u) u.readTOCScroll(m);
        },
        // WRITE phase — everything that mutates the page, in one batch, after
        // every subscriber has finished measuring.
        (m) => {
          const u = activeUtils;
          if (!u) return;
          u.updateScrollStyle(m);
          u.updateNavbarShrink(m);
          u.updateAutoHideTools(m);
          u.updateHomeBannerBlur(m);
          u.writeTOCScroll();
        },
        "utils/scrollStyle",
      );
    },

    // The TOC used to call initTOC() — a FULL re-initialisation, including a
    // localStorage read + JSON.parse and layout-class toggles on the whole page
    // container — TWICE on every scroll event. Now the controller is built once
    // per navigation (see toc.js) and the scroll pass only asks it which heading
    // is active.
    _tocIndex: -1,
    readTOCScroll(m) {
      this._tocIndex = -1;
      if (!theme.articles.toc.enable) return;
      const toc = getTOC();
      if (!toc) return;
      this._tocIndex = toc.computeActiveIndex(m.scrollY);
    },

    writeTOCScroll() {
      if (this._tocIndex < 0) return;
      const toc = getTOC();
      if (toc) toc.activateTOCLink(this._tocIndex);
    },

    // Only the cheap part (a scrollTop comparison + one body class) belongs in
    // the scroll pass. navbarShrink.init() re-queried the navbar, re-measured
    // its height AND registered another scroll listener — from inside a scroll
    // handler. That is the unbounded listener growth; it is gone.
    updateNavbarShrink(m) {
      if (!navigationState.isNavigating) {
        navbarShrink.shrink(m.scrollY);
      }
    },

    debounce(func, delay) {
      let timer;
      return function () {
        clearTimeout(timer);
        timer = setTimeout(() => func.apply(this, arguments), delay);
      };
    },

    // The blur only ever toggles between 0px and 15px, but the old code wrote
    // `filter` on the full-viewport banner background on every (debounced)
    // scroll event. Re-applying an identical filter still re-rasterises a
    // viewport-sized blurred layer — brutal on mobile. Write only on change.
    //
    // The guard is on the ELEMENT, not on `location.pathname`. The background
    // only exists on home listings in the first place, and client-side
    // pagination now moves the URL to /page/N/ while staying in the same
    // document — a path comparison stopped matching there, so the blur was
    // frozen at whatever it was when the page turned and never cleared again on
    // the way back up to the banner.
    _lastBannerBlur: null,
    updateHomeBannerBlur(m) {
      if (!this.homeBannerBackground_dom) return;
      if (theme.home_banner.style !== "fixed") return;

      const blurValue = m.scrollY >= this.triggerViewHeight ? 15 : 0;
      if (blurValue === this._lastBannerBlur) return;
      this._lastBannerBlur = blurValue;

      const filter = `blur(${blurValue}px)`;
      this.homeBannerBackground_dom.style.filter = filter;
      this.homeBannerBackground_dom.style.webkitFilter = filter;
    },

    // `document.body.scrollHeight` forced a synchronous layout on every scroll
    // event; it now comes from the scheduler's cached metrics. The node lookups
    // are cached too, and the class is only touched when the state flips.
    _toolList: null,
    _aplayer: null,
    _lastToolsHidden: null,
    updateAutoHideTools(m) {
      if (!this._toolList || !this._toolList.length) {
        this._toolList = document.getElementsByClassName(
          "right-side-tools-container",
        );
        this._lastToolsHidden = null;
      }
      if (!this._aplayer || !this._aplayer.isConnected) {
        this._aplayer = document.getElementById("aplayer");
      }

      const y = m.scrollY;
      let hidden;
      if (y <= 100) {
        // Preserved quirk: at the very top the tools only hide on the home page.
        if (location.pathname !== config.root) return;
        hidden = true;
      } else if (y + m.viewportH >= m.bodyH - 20) {
        hidden = true;
      } else {
        hidden = false;
      }

      if (hidden === this._lastToolsHidden) return;
      this._lastToolsHidden = hidden;

      for (let i = 0; i < this._toolList.length; i++) {
        this._toolList[i].classList.toggle("hide", hidden);
      }
      if (this._aplayer) this._aplayer.classList.toggle("hide", hidden);
    },

    toggleToolsList() {
      // Auto expand tools list if configured
      if (theme.global.side_tools && theme.global.side_tools.auto_expand) {
        this.toolsList.classList.add("show");
      }
      
      this.toggleButton.addEventListener("click", () => {
        this.toolsList.classList.toggle("show");
      });
    },

    fontAdjPlus_dom: document.querySelector(".tool-font-adjust-plus"),
    fontAdMinus_dom: document.querySelector(".tool-font-adjust-minus"),
    globalFontSizeAdjust() {
      const htmlRoot = this.html_root_dom;
      const fontAdjustPlus = this.fontAdjPlus_dom;
      const fontAdjustMinus = this.fontAdMinus_dom;

      const fontSize = document.defaultView.getComputedStyle(
        document.body,
      ).fontSize;
      const baseFontSize = parseFloat(fontSize);

      let fontSizeLevel = 0;
      const styleStatus = main.getStyleStatus();
      if (styleStatus) {
        fontSizeLevel = styleStatus.fontSizeLevel;
        setFontSize(fontSizeLevel);
      }

      function setFontSize(level) {
        const fontSize = baseFontSize * (1 + level * 0.05);
        htmlRoot.style.fontSize = `${fontSize}px`;
        main.styleStatus.fontSizeLevel = level;
        main.setStyleStatus();
      }

      function increaseFontSize() {
        fontSizeLevel = Math.min(fontSizeLevel + 1, 5);
        setFontSize(fontSizeLevel);
      }

      function decreaseFontSize() {
        fontSizeLevel = Math.max(fontSizeLevel - 1, 0);
        setFontSize(fontSizeLevel);
      }

      fontAdjustPlus.addEventListener("click", increaseFontSize);
      fontAdjustMinus.addEventListener("click", decreaseFontSize);
    },
    // go comment anchor
    goComment() {
      this.goComment_dom = document.querySelector(".go-comment");
      if (this.goComment_dom) {
        this.goComment_dom.addEventListener("click", () => {
          const target = document.querySelector("#comment-anchor");
          if (target) {
            const offset = target.getBoundingClientRect().top + window.scrollY;
            window.scrollTo({
              top: offset,
              behavior: "smooth",
            });
          }
        });
      }
    },

    // scroll to main content (home banner button)
    bindScrollToMain() {
      const scrollButton = document.querySelector(
        ".home-banner-scroll-to-main",
      );
      if (scrollButton) {
        scrollButton.addEventListener("click", () => {
          const target = document.querySelector(".main-content-container");
          if (target) {
            target.scrollIntoView({ behavior: "smooth" });
          }
        });
      }
    },

    // get dom element height
    getElementHeight(selectors) {
      const dom = document.querySelector(selectors);
      return dom ? dom.getBoundingClientRect().height : 0;
    },

    // init first screen height
    inithomeBannerHeight() {
      this.homeBanner_dom &&
        (this.homeBanner_dom.style.height = this.innerHeight + "px");
    },

    // init page height handle
    initPageHeightHandle() {
      if (this.homeBanner_dom) return;
      const temp_h1 = this.getElementHeight(".main-content-header");
      const temp_h2 = this.getElementHeight(".main-content-body");
      const temp_h3 = this.getElementHeight(".main-content-footer");
      const allDomHeight = temp_h1 + temp_h2 + temp_h3;
      const innerHeight = window.innerHeight;
      const pb_dom = document.querySelector(".main-content-footer");
      if (allDomHeight < innerHeight) {
        const marginTopValue = Math.floor(innerHeight - allDomHeight);
        if (marginTopValue > 0) {
          pb_dom.style.marginTop = `${marginTopValue - 2}px`;
        }
      }
    },

    // set how long ago language
    setHowLongAgoLanguage(p1, p2) {
      return p2.replace(/%s/g, p1);
    },

    getHowLongAgo(timestamp) {
      const l = lang_ago;

      const __Y = Math.floor(timestamp / (60 * 60 * 24 * 30) / 12);
      const __M = Math.floor(timestamp / (60 * 60 * 24 * 30));
      const __W = Math.floor(timestamp / (60 * 60 * 24) / 7);
      const __d = Math.floor(timestamp / (60 * 60 * 24));
      const __h = Math.floor((timestamp / (60 * 60)) % 24);
      const __m = Math.floor((timestamp / 60) % 60);
      const __s = Math.floor(timestamp % 60);

      if (__Y > 0) {
        return this.setHowLongAgoLanguage(__Y, l.year);
      } else if (__M > 0) {
        return this.setHowLongAgoLanguage(__M, l.month);
      } else if (__W > 0) {
        return this.setHowLongAgoLanguage(__W, l.week);
      } else if (__d > 0) {
        return this.setHowLongAgoLanguage(__d, l.day);
      } else if (__h > 0) {
        return this.setHowLongAgoLanguage(__h, l.hour);
      } else if (__m > 0) {
        return this.setHowLongAgoLanguage(__m, l.minute);
      } else if (__s > 0) {
        return this.setHowLongAgoLanguage(__s, l.second);
      }
    },

    relativeTimeInHome() {
      const post = document.querySelectorAll(
        ".home-article-meta-info .home-article-date",
      );
      const df = theme.home.article_date_format;
      if (df === "relative") {
        post &&
          post.forEach((v) => {
            const nowDate = Date.now();
            const postDate = new Date(
              v.dataset.date.split(" GMT")[0],
            ).getTime();
            // Plain text — innerHTML made the browser parse HTML once per
            // article card on every home-page navigation for no reason.
            v.textContent = this.getHowLongAgo(
              Math.floor((nowDate - postDate) / 1000),
            );
          });
      } else if (df === "auto") {
        post &&
          post.forEach((v) => {
            const nowDate = Date.now();
            const postDate = new Date(
              v.dataset.date.split(" GMT")[0],
            ).getTime();
            const finalDays = Math.floor(
              (nowDate - postDate) / (60 * 60 * 24 * 1000),
            );
            if (finalDays < 7) {
              v.textContent = this.getHowLongAgo(
                Math.floor((nowDate - postDate) / 1000),
              );
            }
          });
      }
    },
  };

  // Publish this navigation's utils to the (single, permanent) scroll
  // subscription before anything reads it.
  activeUtils = utils;

  // init scroll
  utils.registerWindowScroll();

  // Resync everything against the current scroll position for the new page.
  requestScrollPass();

  // toggle show tools list
  utils.toggleToolsList();

  // main font adjust
  utils.globalFontSizeAdjust();

  // go comment
  utils.goComment();

  // scroll to main content (home banner button)
  utils.bindScrollToMain();

  // init page height handle
  utils.initPageHeightHandle();

  // init first screen height
  utils.inithomeBannerHeight();

  // set how long ago in home article block
  utils.relativeTimeInHome();

  // image viewer handle
  imageViewer();
}
