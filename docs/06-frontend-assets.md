# 06 — Front-end Assets

Everything under `source/`: client JavaScript, styles (Stylus + Tailwind), fonts, images, and vendored libraries. Reminder: the browser loads **compiled** output — edit `source/…`, then `npm run build` (see [08](08-development.md)).

---

## JavaScript (`source/js/`)

### Module system & entry point
ES modules bundled/minified by `build.js` into `source/js/build/`. The entry is **`main.js`**, which:
- defines the global `main` object (theme info, `localStorageKey: "REDEFINE-X-STATUS"`, and persisted `styleStatus`: width-expanded, dark mode, font-size level, aside open);
- `initMain()` runs on `DOMContentLoaded` **and** re-runs `main.refresh()` on every swup `page:view` (SPA navigation does not re-fire `DOMContentLoaded`);
- `refresh()` conditionally boots features based on `window.theme` config: typed subtitle (home only), local search (`navbar.search.enable`), code copy (`articles.code_block.copy`), lazyload (`articles.lazyload`, with `preload` option), auto-hover, MathJax scroll, and instant-notes (home only, if enabled).

`styleStatus` is persisted to `localStorage` so user toggles (dark mode, font size, page width, sidebar) survive reloads and navigations.

### `js/build.js`
Build script (run by `npm run build:js`, **not** shipped to browser). Terser-minifies every `source/js/**/*.js` (except `libs/`, `build/`, and itself) into `source/js/build/`, keeping class/function names, emitting per-file source maps, copying `libs/**` verbatim, with concurrency 4. See [`source/js/build.js`](../source/js/build.js).

### `js/utils.js`
Shared helpers initialized first in `refresh()` (DOM utilities, event helpers, common behaviors used across modules).

### `js/tools/` — UI tools
| File | Responsibility |
|------|----------------|
| `lightDarkSwitch.js` | Light/dark toggle; writes `styleStatus.isDark`; respects `prefers-color-scheme` |
| `scrollTopBottom.js` | Scroll-to-top/bottom buttons |
| `localSearch.js` | Local search modal (consumes `hexo-generator-searchdb` index) |
| `codeBlock.js` | Code-block copy button + language label interactions |
| `imageViewer.js` | Lightbox for article images (drives `utils/image-viewer.ejs`) |
| `runtime.js` | Footer "site running time" counter (`footer.runtime` + `start`) |
| `tocToggle.js` | Open/close the table of contents |

### `js/layouts/` — layout behaviors
| File | Responsibility |
|------|----------------|
| `autoHover.js` | Triggers hover animations when elements enter the viewport (`global.hover.auto_hover`) |
| `lazyload.js` | Progressive image loading; swaps `img-preloader` placeholders (from [`lazyload-handle`](04-scripts.md#lazyload-handlejs)) for real images; optional idle preloading |
| `navbarShrink.js` | Auto-hide/shrink navbar on scroll (`navbar.auto_hide`) |
| `toc.js` | TOC scroll-spy / active-heading highlight |
| `categoryList.js` | Expand/collapse category tree |
| `bookmarkNav.js` | Bookmarks-page navigation |
| `essays.js` | Shuoshuo/essays interactions |
| `imageExif.js` | Toggle the EXIF info card (drives [`exifimage`](05-tag-plugins.md#exifimage)) |

### `js/plugins/` — optional integrations
| File | Responsibility |
|------|----------------|
| `typed.js` | Typed.js home-banner subtitle animation |
| `mathjax.js`, `mathjax-scroll.js` | MathJax client glue + keep equations positioned during scroll/nav |
| `mermaid.js` | Mermaid diagram rendering |
| `aplayer.js` | APlayer audio player init |
| `pangu.js` | CJK/Latin auto-spacing (`articles.pangu_js`) |
| `tabs.js` | Tab switching for the [`tabs`](05-tag-plugins.md#tabs--subtabs--subsubtabs) plugin |
| `hbe.js` | Hexo Blog Encrypt client — decrypts [password posts](04-scripts.md#encryptjs) |
| `instantNotes.js` | Instagram-Notes-style banner bubbles (fetches `home_banner.instant_notes.api_url`) |
| `giscus-client.js` / `.source.js` | Giscus comment client (`.source.js` is the editable source; `.js` is built) |
| `masonry.js` | Waterfall photo-album layout |
| `masonry-reactions.js` / `.source.js` / `masonry-reactions-client.min.js` | Per-photo reactions via Giscus discussions |

> Pattern: files paired as `*.source.js` + `*.min.js`/`*.js` mean the `.source.js` is hand-edited and the other is generated. Edit the source, then rebuild.

### `js/libs/` — vendored third-party (copied, not minified)
swup + plugins (`Swup`, `SwupPreloadPlugin`, `SwupProgressPlugin`, `SwupScriptsPlugin`, `SwupScrollPlugin`, `SwupSlideTheme`), `pjax.min.js`, `Typed`, `anime`, `mermaid`, `moment` (+locales), `odometer` (counters), `pangu`, `APlayer`, `waline`. Update these deliberately — they're checked in.

---

## CSS (`source/css/`)

Two styling systems coexist:
- **Stylus** — the bulk of the theme. Entry `style.styl` `@import`s everything below; compiled by Hexo's `hexo-renderer-stylus` at generate time (customized by [`stylus-handle.js`](04-scripts.md#stylus-handlejs)). Stylus changes are picked up automatically by `hexo server`/`generate`.
- **Tailwind v4** — `tailwind.source.css` compiled by `npm run build:css` → `css/build/tailwind.css`. Utility classes are used directly inside `.ejs` layouts. Tailwind changes require the theme build.

### `css/common/` — foundations
| File | Role |
|------|------|
| `variables.styl` | Stylus variables (spacing, radii, breakpoints) |
| `colors.styl` | Color palette |
| `theme.styl`, `redefine-theme.styl` | Theme tokens / light-dark theming |
| `basic.styl` | Element resets/base styles |
| `markdown.styl` | Article body (`.markdown-body`) typography |
| `animated.styl` | Reusable animations |
| `codeblock/` | Code styling: `code-block.styl`, `code-theme.styl`, `highlight.styl`, and `hljs-themes/{light,dark}/*.styl` — one file per highlight.js theme selectable via `articles.code_block.highlight_theme` |

### `css/layout/` — page & component styles
- **Top-level page styles:** `home-content.styl`, `home-sidebar.styl`, `article-content.styl`, `archive-content.styl`, `category-content.styl`, `category-list.styl`, `tag-content.styl`, `bookmarks.styl`, `page.styl`, `mathjax.styl`, `animations.styl`.
- **`_partials/`** — chrome/components: `navbar`, `footer`, `home-banner`, `home-notes`, `toc`, `paginator`, `side-tools`, `post-tools`, `progress-bar`, `local-search`, `image-viewer`, `tagcloud`, `404`, `article-meta-info`, `article-copyright-info`, `archive-list`, `page-template`, and `comments/{comment,waline,gitalk,twikoo}`.
- **`_modules/`** — styles for the [tag plugins](05-tag-plugins.md): `notes`, `box`, `buttons`, `folding`, `tabs`, `image-exif`, `aplayer`.

> Naming: `_`-prefixed folders/files are partials meant to be `@import`ed, not compiled standalone.

---

## Other assets
- **`source/fonts/`** — bundled variable fonts with their `@font-face` CSS: **Geist** (UI), **GeistMono** (code), **Chillax** (display/titles).
- **`source/assets/`** — `hbe.style.css` (encrypted-post UI), `odometer-theme-minimal.css` (counters).
- **`source/images/`** — theme defaults: `redefine-favicon.svg`, `redefine-avatar.svg`, `redefine-logo.{svg,avif}`, `redefine-og.avif`, home-banner `wallhaven-…-{light,dark}.avif`, `bookmark-placeholder.svg`.
- **`source/fontawesome/`, `source/webfonts/`** — Font Awesome Pro v6.2.1 styles, gated by the [`fontawesome`](02-configuration.md#fontawesome--font-awesome-pro-v621) config.

## Adding a front-end feature (checklist)
1. Add a module under `source/js/{tools,layouts,plugins}/` and `import` + init it from `main.js` (inside `refresh()` so it survives swup navigation).
2. Gate it on a `window.theme.*` config flag where appropriate (export the flag via [`config-export.js`](04-scripts.md#scriptsconfig-exportjs) if it's new).
3. Add styles under `source/css/layout/...` (Stylus) or use Tailwind classes in the template.
4. **Rebuild:** `npm run build` in `themes/redefine-x`, then `hexo clean && hexo g -d` (or `hexo server`) at the site root.
