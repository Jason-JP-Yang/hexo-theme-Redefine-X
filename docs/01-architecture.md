# 01 — Architecture

How the theme is loaded, configured, rendered, and shipped. Read this first; the other docs drill into each layer.

## 1. How Hexo loads the theme

The site's `_config.yml` sets `theme: redefine-x`, so Hexo loads everything under `themes/redefine-x/`. Three subtrees are auto-discovered:

- **`layout/`** — EJS templates. Hexo renders a post/page by matching its `layout` property to a top-level `.ejs` file (`post.ejs`, `page.ejs`, `index.ejs`, `archive.ejs`, `category.ejs`, `tag.ejs`, `tags.ejs`, `404.ejs`). See [03 — Layouts](03-layouts.md).
- **`scripts/`** — Node.js files executed once at generation time. They register **filters**, **helpers**, **generators**, **console commands**, and **tag plugins** on the global `hexo` object. See [04 — Scripts](04-scripts.md) and [05 — Tag plugins](05-tag-plugins.md).
- **`source/`** — static assets (JS, CSS, fonts, images) copied into the generated site, after the theme's own Stylus/Tailwind/terser compilation.

## 2. The dual-config system (important)

There are **two** `_config.yml`-style files and they are not the same thing:

| File | Role |
|------|------|
| `themes/redefine-x/_config.yml` | The **default template** shipped with the theme. Treat it as documentation/defaults. |
| `<site-root>/_config.redefine-x.yml` | The **live, effective config** for this site. |

This is Hexo's *alternate theme config* convention: a root-level file named `_config.<theme>.yml` overrides the theme's own `_config.yml`. Because the theme directory is `redefine-x`, the active file is `_config.redefine-x.yml`. **Change site behavior there**, not in the theme.

At runtime the merged result is available in templates as `theme.*` and in scripts as `hexo.theme.config.*`. Full key-by-key reference: [02 — Configuration](02-configuration.md).

### Data-file overrides

`scripts/data-handle.js` runs on `generateBefore` and folds `source/_data/*.yml` into `hexo.theme.config`:

- `_data/_config.yml` / `redefine.yml` → replaces the whole theme config (alternative to the root file).
- `_data/links.yml` → `theme.config.links` (friends page).
- `_data/essays.yml` (a.k.a. `essay`/`shuoshuo`) → `theme.config.essays`.
- `_data/masonry.yml` (a.k.a. `gallery`/`photos`) → `theme.config.masonry`.
- `_data/bookmarks.yml` (a.k.a. `tools`) → `theme.config.bookmarks`.

## 3. Render lifecycle & filter ordering

Most of the theme's "magic" is Hexo **filters** registered in `scripts/filters/`. Two hook phases matter, and **priority numbers decide order** (lower runs first):

```
before_post_render   (raw Markdown, before the Markdown renderer)
  ├─ mathjax-render   p5   extract $…$ / $$…$$ → placeholder comments (protect from Markdown)
  └─ box-syntax       p3   rewrite ${$ box $} sugar → {% box %} tag calls

  ──► Markdown renderer + {% tag %} plugins run here ──►

after_post_render    (rendered HTML)
  ├─ delete-mask-handle  p0   wrap <del> in spoiler mask (if enabled)
  ├─ img-handle          p15  wrap <img> in <figure> + figcaption / figure numbers
  ├─ mathjax-render      p5   replace placeholders with server-rendered SVG
  ├─ link-handle              mark external links (new tab + icon)
  ├─ lazyload-handle          convert <img> → progressive <div class="img-preloader">
  ├─ img-optimizer            transcode bitmaps → AVIF, SVGs → SVGO (build-time)
  ├─ encrypt                  AES-CBC encrypt posts with front-matter `password`
  └─ html/css/js-optimizer    minify final output
```

Because math is delimiter-sensitive, `mathjax-render` deliberately runs **before** Markdown (phase 1, extract to placeholders) and **after** (phase 2, render SVG) — see [04 — Scripts](04-scripts.md#mathjax-renderjs).

## 4. Config → browser bridge

`scripts/config-export.js` registers the `export_config` helper. The `<head>` calls it to emit:

```js
window.config = { hostname, root, language, path }   // site essentials
window.theme  = { articles, colors, global, home_banner, plugins, navbar, ... , version }
window.lang_ago = { ... }                            // relative-time strings
window.data   = { masonry: true|false }
```

Front-end modules read these globals to decide what to initialize (e.g. `main.js` checks `theme.navbar.search.enable` before booting local search). This is how server-side YAML config reaches client JS.

## 5. Front-end asset compilation

The browser never loads raw `source/` files directly — it loads compiled output:

- **JavaScript**: `source/js/build.js` (run via `npm run build:js`) terser-minifies every `source/js/**/*.js` into `source/js/build/**`, preserving class/function names and emitting source maps. Vendored `source/js/libs/**` are copied verbatim (not minified). Layouts reference `source/js/build/...`.
- **CSS (Tailwind)**: `npm run build:css` compiles `source/css/_tailwind.source.css` → `source/css/build/tailwind.css` (minified). `head.ejs` links `css/build/tailwind.css`.
- **CSS (Stylus)**: `source/css/style.styl` (and its `@import`ed partials) is compiled by Hexo's `hexo-renderer-stylus` at generate time; `scripts/filters/stylus-handle.js` customizes that pipeline. Stylus is the bulk of the theme's styling; Tailwind utility classes are used inside layouts.

So a theme front-end change is a **two-step** process: edit `source/...`, then `npm run build` inside the theme. Stylus changes are picked up by `hexo generate`/`hexo server` automatically, but Tailwind and JS changes require the theme build. See [06 — Front-end assets](06-frontend-assets.md).

## 6. Single-page navigation (swup)

When `global.single_page` is on (default), `components/swup.ejs` loads [swup](https://swup.js.org/) for SPA-style page transitions (similar to PJAX). Critically, `main.js` re-runs `main.refresh()` on every `swup` `page:view` event, because a swup navigation does **not** fire `DOMContentLoaded` again — every interactive feature must be re-initialized per virtual page load. Keep this in mind when adding front-end features.

## 7. CDN & version awareness

- `events/welcome.js` pings `https://redefine-x-version.jason-yang.top/api/v2/info` on `ready`, prints the ASCII banner with current/latest version, warns if outdated, and probes which CDNs (jsDelivr, unpkg, cdnjs, zstatic, npmmirror) currently host this version. Results are stored in `hexo.locals` as `cdnTestStatus_*`.
- The `cdn` config block (see [02](02-configuration.md#cdn)) switches asset URLs between local and a CDN provider, using the `${version}`/`${path}` URL template.

## 8. Build pipeline summary

```
Author writes Markdown (+ {% tags %})  →  before_post_render filters  →  Markdown render
   →  after_post_render filters (images, math SVG, links, lazyload, AVIF, encrypt, minify)
   →  EJS layout render (config bridged to window.*)  →  static HTML in public/
   →  (front-end) compiled JS/CSS from source/*/build/ hydrate the page, swup handles nav
```
