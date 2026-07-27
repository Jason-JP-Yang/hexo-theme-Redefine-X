# 04 — Scripts (the build engine)

Everything under `scripts/` is auto-loaded by Hexo at generation time and registers behavior on the global `hexo` object: **filters** (content transforms), **helpers** (EJS functions), **generators**, **console commands**, and **events**. Custom `{% tag %}` plugins live in `scripts/modules/` and have their own doc: [05 — Tag plugins](05-tag-plugins.md).

> Filter ordering recap: lower **priority number runs first**. The pipeline overview is in [01 — Architecture §3](01-architecture.md#3-render-lifecycle--filter-ordering).

---

## `scripts/filters/` — content pipeline

### `mathjax-render.js`
Server-side **TeX → SVG** using MathJax v4, in two phases:
- **Phase 1** (`before_post_render`, p5): scans raw Markdown for `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, extracts the TeX, and swaps each for an HTML comment placeholder (`<!--mathjax:N:inline|display-->`) **before** the Markdown renderer can mangle `_`, `\\`, `|`, etc.
- **Phase 2** (`after_post_render`, p5): replaces placeholders with rendered SVG via `tex2svgPromise()` and injects the SVG stylesheet once.

Loads a broad TeX package set (`ams`, `physics`, `mathtools`, `cancel`, `color`, `braket`, …). Honors `plugins.mathjax`: `enable`, `every_page` (vs per-post `mathjax: true`), `single_dollars`, `tags`, `cjk_width`, `normal_width`. A singleton promise caches the MathJax instance across the whole build.

### `box-syntax.js`
`before_post_render` (p3). Sugar converter: rewrites `${$ box <args> $}` / `${$ endbox $}` into real `{% box %}…{% endbox %}` tag calls. Deliberately preserves a leading `$` so it can sit flush against a math delimiter (`$x^{-1}${$ endbox $}`) without unbalancing MathJax. Pairs with the [`box` tag plugin](05-tag-plugins.md#box).

### `img-handle.js`
`after_post_render` (p15). Wraps content `<img>` in `<figure class="image-caption">` with a `<figcaption>` derived from the image `alt`. Honors `articles.style.image_caption` (`false`/`float`/`block`) and `image_figure_number` (prepends "Figure N."). Carefully **skips** images inside `image-exif-container`/`image-exif-simple-container` and any `<img data-no-img-handle>`. Maintains a per-post figure counter.

### `link-handle.js`
`after_post_render`. Finds pure `<a href>` tags whose host differs from `config.url` and marks them external (open in new tab, external-link icon when `articles.style.link_icon`). Internal/anchor links are left untouched.

### `lazyload-handle.js`
`after_post_render`. Transforms `<img>` into `<div class="img-preloader">` containers with known width/height (read at build time via `image-size`, including remote images with caps: 12 MB / 8 s / 3 redirects, cached). The runtime [`layouts/lazyload.js`](06-frontend-assets.md) progressively swaps in the real image. Active when `articles.lazyload` is on.

### `img-optimizer.js`
`after_post_render` + asset processing. Transcodes bitmaps (JPEG/PNG/WEBP/GIF, incl. animated) to **AVIF** and optionally minifies SVG via SVGO. A `ConfigManager` reads `plugins.minifier.imagesOptimize` and maps the unified `quality (0–100)` / `effort (0–10)` to encoder-specific params for three encoders:
- `sharp` (default, no animated-GIF support),
- ffmpeg `libaom-av1`,
- ffmpeg `libsvtav1` (no alpha/animated → auto-falls back to libaom-av1).

Downsizes anything above `IMG_MAX_PIXELS`. Concurrency = CPU-1 for sharp, CPU/2 for ffmpeg. **Output is cached in `<site>/source/build/`** — clear with `hexo clean --include-minify` after changing options.

### `delete-mask-handle.js`
`after_post_render` (p0). When `articles.style.delete_mask: true`, adds `class="mask"` to `<del>` elements so struck-through text is hidden until hover (spoiler effect).

### `encrypt.js`
`after_post_render`. Password-protects posts that have `password:` in front matter. AES-CBC with PBKDF2 (131071 iterations, 32-byte salt, 16-byte IV); embeds a known prefix tag so wrong passwords can be detected client-side. Front-end decryption is handled by [`plugins/hbe.js`](06-frontend-assets.md) with styling from `source/assets/hbe.style.css`. Configurable messages (abstract, prompt, wrong-password/hash) live in the filter's `defaultConfig`. The default theme template (`scripts/filters/lib/hbe.default.js`) provides the HBE markup.

### `html-optimizer.js` · `css-optimizer.js` · `js-optimizer.js`
`after_post_render`/asset filters that minify final HTML, CSS, and inline JS when `plugins.minifier.htmlOptimize` / `cssOptimize` / `jsOptimize` are on (html-minifier-terser, clean-css, terser).

### `stylus-handle.js`
Customizes the Stylus render pipeline (`hexo-renderer-stylus`) — injects theme variables/functions so `source/css/style.styl` can use config-derived values.

### `table-handle.js`
Currently **disabled** (entire file is commented out). Was intended to wrap `<table>` in a scrollable `.table-container`. Note for maintainers: table scroll-wrapping is not active.

### `lib/hbe.default.js`
Support data/markup for `encrypt.js` (Hexo Blog Encrypt default theme). Not a standalone filter.

---

## `scripts/helpers/` — EJS helpers

Registered with `hexo.extend.helper.register`; callable inside any `.ejs` template.

### `page-helpers.js`
The page router. Exposes:
- `getAllPageData()` → the full `pageData` table.
- `getPageData(page)` → the matching entry (built-in `is_home/is_archive/is_post/is_category/is_tag` take precedence, then type/title match).
- `getPagePartialPath(page)` → the partial path `page.ejs` renders.
- `getPageTitle(page)` → resolved title with i18n fallback.

See the routing table in [03 — Layouts](03-layouts.md#the-page-router-getpagepartialpath).

### `theme-helpers.js`
Misc template helpers + a couple of filters. Notably:
- `isHomePagePagination(pagePath, route)` — detects paginated home pages.
- `createNewArchivePosts(posts)` — groups posts by year for the archive page.
- A code-block `after_post_render` filter that wraps each `<figure class="highlight LANG">` in `<div class="code-container" data-rel="Lang">` (this is what shows the language label + enables the copy button).

### `meta-helpers.js`
Generates `<head>` metadata: `<title>`, description, keywords, canonical, Open Graph / Twitter cards from `global.open_graph` and page data.

### `recommendation-helpers.js`
Builds the "recommended reading" list (`articles.recommendation`) using `@node-rs/jieba` to tokenize titles/content and score related posts. Respects `limit`, `mobile_limit`, `skip_dirs`, `placeholder`.

### `waline-helpers.js`
Helpers for wiring the Waline comment widget (serverUrl, locale, reaction, recaptcha/turnstile keys) from `comment.config.waline`.

---

## `scripts/modules/` — custom tag plugins
`note`, `note-large`, `box`, `btn`, `btns`, `folding`, `tabs`, `image-exif`. Full authoring guide: **[05 — Tag plugins](05-tag-plugins.md)**.

---

## `scripts/events/` — lifecycle hooks

### `clean.js`
**Overrides** Hexo's `clean` console command. Deletes `db.json` and clears `public/` **but preserves `public/.git` and `public/.gitignore`** (because `public/` is the deploy submodule). The image-optimizer cache in `source/build/` is **only** removed when you pass `--include-minify`:
```sh
hexo clean                  # clears db + public (keeps public/.git), keeps image cache
hexo clean --include-minify # also wipes source/build/ optimized-image cache
```

### `welcome.js`
On `ready`: fetches `redefine-x-version.jason-yang.top/api/v2/info` (3 s timeout), prints the ASCII banner with current vs latest version, warns if outdated, and records CDN availability into `hexo.locals` (`cdnTestStatus_jsdelivr` etc.) for the `cdn` feature.

### `404.js`
Registers/handles the 404 page generation.

### `export-github-workflow.js`
On `after_generate`: copies `themes/redefine-x/workflows/masonry-reactions-cleanup.yml` into the generated site at `public/.github/workflows/`, so the deployed repo carries the scheduled cleanup Action for masonry reactions.

---

## `scripts/config-export.js`
Registers the `export_config` helper used by `head.ejs`. Serializes site essentials (`hostname`, `root`, `language`, search `path`) and a curated subset of theme config (`articles`, `colors`, `global`, `home_banner`, `plugins`, `navbar`, `page_templates`, `home`, `footer.start`, `version`) plus the active language's relative-time strings and a `data.masonry` flag into `window.config` / `window.theme` / `window.lang_ago` / `window.data`. This is the **server-config → browser** bridge consumed by `source/js/main.js` and friends. See [01 §4](01-architecture.md#4-config--browser-bridge).

## `scripts/data-handle.js`
On `generateBefore`: merges `source/_data/*.yml` into `hexo.theme.config` — full config override (`_config`/`redefine`/`_redefine`), plus `links`, `essays`/`shuoshuo`, `masonry`/`gallery`/`photos`, and `bookmarks`/`tools`. This is how the friends/essays/masonry/bookmarks pages get their data.

## `scripts/masonry-generator.js` & `masonry-reactions.js`

### `masonry-generator.js`
Generates the waterfall photo-album pages. Reads album definitions (`_data/masonry.yml`), resolves images under `source/masonry/<album>/`, reads per-image EXIF (optional `exif-parser`), localizes labels via the `languages/` files, and emits album + collection pages (output under `source/build/masonry/`). It also wires the `masonry` flag exported to `window.data`.

### `masonry-reactions.js`
Backs the per-photo "reactions" feature using **Giscus discussions** as storage. Requires the Giscus `proxy` (CORS Worker) and `author_pat` from `comment.config.giscus`. The companion scheduled GitHub Action (`workflows/masonry-reactions-cleanup.yml`, exported by `export-github-workflow.js`) prunes stale reaction discussions. Client side: `source/js/plugins/masonry-reactions*.js`.

---

## Cheat sheet: where behavior lives

| You want to change… | Look at |
|---|---|
| Order of an HTML transform | the filter's priority number in `scripts/filters/*` |
| Math rendering | `filters/mathjax-render.js` + `plugins.mathjax` config |
| Image figures/captions | `filters/img-handle.js` + `articles.style.image_*` |
| AVIF/SVG compression | `filters/img-optimizer.js` + `plugins.minifier.imagesOptimize` |
| Which partial renders a page | `helpers/page-helpers.js` `pageData` |
| Config available to browser JS | `config-export.js` |
| Friends/essays/masonry/bookmarks data | `data-handle.js` + `source/_data/*.yml` |
| The `clean` command behavior | `events/clean.js` |
