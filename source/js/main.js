/* main function */
import initUtils from "./utils.js";
import initTyped from "./plugins/typed.js";
import initModeToggle from "./tools/lightDarkSwitch.js";
import initScrollTopBottom from "./tools/scrollTopBottom.js";
import initLocalSearch from "./tools/localSearch.js";
import initCopyCode from "./tools/codeBlock.js";
import initBookmarkNav from "./layouts/bookmarkNav.js";
import initLazyLoad from "./layouts/lazyload.js";
import initAutoHover from "./layouts/autoHover.js";

export const main = {
  themeInfo: {
    theme: `Redefine v${theme.version}`,
    author: "Jason-JP-Yang",
    repository: "https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X",
  },
  localStorageKey: "REDEFINE-X-STATUS",
  styleStatus: {
    isExpandPageWidth: false,
    isDark: theme.colors.default_mode && theme.colors.default_mode === "dark",
    fontSizeLevel: 0,
    isOpenPageAside: true,
  },
  printThemeInfo: () => {
    console.log(`
+=====================================================================================+
|                                                                                     |
|      ██████╗ ███████╗██████╗ ███████╗███████╗██╗███╗   ██╗███████╗   ██╗  ██╗       |
|      ██╔══██╗██╔════╝██╔══██╗██╔════╝██╔════╝██║████╗  ██║██╔════╝   ╚██╗██╔╝       |
|      ██████╔╝█████╗  ██║  ██║█████╗  █████╗  ██║██╔██╗ ██║█████╗█████╗╚███╔╝        |
|      ██╔══██╗██╔══╝  ██║  ██║██╔══╝  ██╔══╝  ██║██║╚██╗██║██╔══╝╚════╝██╔██╗        |
|      ██║  ██║███████╗██████╔╝███████╗██║     ██║██║ ╚████║███████╗   ██╔╝ ██╗       |
|      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝  ╚═╝       |
|                                                                                     |
|                 https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X              |
+=====================================================================================+
    `); // console log message
  },
  setStyleStatus: () => {
    localStorage.setItem(
      main.localStorageKey,
      JSON.stringify(main.styleStatus),
    );
  },
  getStyleStatus: () => {
    let temp = localStorage.getItem(main.localStorageKey);
    if (temp) {
      temp = JSON.parse(temp);
      for (let key in main.styleStatus) {
        main.styleStatus[key] = temp[key];
      }
      return temp;
    } else {
      return null;
    }
  },
  refresh: () => {
    initUtils();
    initModeToggle();
    initScrollTopBottom();
    initBookmarkNav();
    
    if (
      theme.home_banner.subtitle.text.length !== 0 &&
      location.pathname === config.root
    ) {
      initTyped("subtitle");
    }

    if (theme.navbar.search.enable === true) {
      initLocalSearch();
    }

    if (theme.articles.code_block.copy === true) {
      initCopyCode();
    }

    if (theme.articles.lazyload === true) {
      initLazyLoad({
        preload: theme.articles.lazyload_preload === true
      });
    }

    initAutoHover();
  },
};

export function initMain() {
  main.printThemeInfo();
  main.refresh();
}

document.addEventListener("DOMContentLoaded", initMain);

try {
  swup.hooks.on("page:view", () => {
    main.refresh();
  });
} catch (e) {}
