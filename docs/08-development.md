# 08 — Development & Release

How to build, develop, and release the theme. Commands here run **inside `themes/redefine-x`** unless noted. The host site has its own commands (run at the site root) — see the repo's top-level `CLAUDE.md`.

## Prerequisites
- **Node ≥ 12** (theme), the site runs on **Hexo 8** / Node modern LTS.
- For AVIF image optimization: `sharp` (bundled in the site deps) or **FFmpeg** with `libaom-av1`/`libsvtav1` on `PATH` if you pick those encoders.
- Optional features pull optional deps (already in the site `package.json`): `exif-parser`, `@node-rs/jieba`, `hexo-generator-searchdb`, `hexo-wordcount`, `hexo-generator-feed`, `hexo-filter-mermaid-diagrams`.

## Theme build commands (`package.json`)

```sh
npm run build        # build:css + build:js — run after ANY source/ front-end change
npm run build:css    # Tailwind v4: source/css/tailwind.source.css → source/css/build/tailwind.css (minified)
npm run build:js     # terser: source/js/**/*.js → source/js/build/** (+ source maps)
npm run watch:css    # Tailwind in --watch during active styling
```

> **Stylus is not in these scripts.** `source/css/style.styl` (and its partials) is compiled by Hexo's `hexo-renderer-stylus` at site generate time — it updates automatically on `hexo server`/`hexo generate`. Only **Tailwind** and **JS** need the theme build.

### Typical dev loop
```sh
# terminal 1 (theme): keep Tailwind fresh while editing utility classes
cd themes/redefine-x && npm run watch:css

# after editing source/js/** :
cd themes/redefine-x && npm run build:js

# terminal 2 (site root): live preview (Stylus + EJS recompiled on the fly)
npm run server         # http://localhost:4000
```

For a clean production check from the site root:
```sh
hexo clean             # wipes db + public (keeps public/.git); keeps image cache
# or: hexo clean --include-minify   # also wipe source/build/ AVIF/SVG cache
npm run build          # hexo generate
```

## Developer mode
`developer.enable: true` in the theme config switches the theme to serve **uncompiled source** (for hacking on the raw JS/CSS without rebuilding). Turn it **off** for production — shipped sites must load the compiled `build/` output.

## Release workflow (standard-version)

The theme is an independently published npm package (`hexo-theme-redefine-x`). Versioning uses **standard-version** with config in `.versionrc.js`:

```sh
npm run release          # auto-bump from Conventional Commits
npm run release:patch    # force patch
npm run release:minor    # force minor
npm run release:major    # force major
npm run npm:publish      # npm run build && npm publish
```

- `.versionrc.js` defines Conventional-Commit sections (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `build`, `chore`, `ci`, `init`), an ASCII-banner release commit message, and **skips changelog generation** (`skip.changelog = true`). The `-s` flag in the scripts signs the release.
- The version is read in several places at runtime: `config-export.js` (`window.theme.version`), `welcome.js` / `main.js` banners, and the `cdn` URL template `${version}`.

> **Commit-message convention** (from `CONTRIBUTING.md`): `[section]: [brief info]`, e.g. `footer: optimize style`. PRs go to the **`dev`** branch upstream.

## Version & CDN awareness
On `hexo` startup, [`events/welcome.js`](04-scripts.md#welcomejs) queries `redefine-x-version.jason-yang.top/api/v2/info` to print current-vs-latest version and probe CDN availability (jsDelivr/unpkg/cdnjs/zstatic/npmmirror), stored in `hexo.locals.cdnTestStatus_*`. The `cdn` config block then rewrites asset URLs to the chosen provider using `${version}`/`${path}`. The version API itself is a separate service (the `themes/redefine-x-version-api` submodule).

## Where things get compiled (summary)

| Source | Tool | Output | Trigger |
|--------|------|--------|---------|
| `source/css/tailwind.source.css` | Tailwind v4 CLI | `source/css/build/tailwind.css` | `npm run build:css` |
| `source/js/**/*.js` (not `libs/`) | terser (`build.js`) | `source/js/build/**` | `npm run build:js` |
| `source/css/style.styl` (+partials) | hexo-renderer-stylus | in-memory → site CSS | `hexo generate`/`server` |
| Markdown posts | filters + EJS | `public/**` | `hexo generate` |
| Bitmaps → AVIF, SVG → SVGO | img-optimizer (sharp/ffmpeg/SVGO) | `<site>/source/build/` cache | `hexo generate` |

## Gotchas
- **Forgot to rebuild?** If a JS/Tailwind change doesn't show up, you skipped `npm run build` — the browser is still loading old `build/` output.
- **Stale optimized images?** Changing `imagesOptimize` options without `hexo clean --include-minify` reuses cached AVIFs.
- **swup re-init:** new front-end features must be initialized in `main.refresh()`, not just on `DOMContentLoaded`, or they break after the first SPA navigation. See [06](06-frontend-assets.md) / [01 §6](01-architecture.md#6-single-page-navigation-swup).
- **Two configs:** edit `<site-root>/_config.redefine-x.yml`, not the theme's `_config.yml`. See [02](02-configuration.md).
- **public/ is a submodule:** the deploy target. `events/clean.js` preserves its `.git` on `hexo clean`.

## Related repos (submodules)
| Submodule | Purpose |
|-----------|---------|
| `themes/redefine-x` | this theme (the working repo) |
| `themes/redefine-x-docs` | public documentation site source |
| `themes/redefine-x-version-api` | version/CDN info API behind `welcome.js` |
| `dev/giscus` | customized Giscus build for comments / masonry reactions |
| `dev/instant-notes-worker` | Cloudflare Worker for `home_banner.instant_notes` |
