# Redefine-X Theme — Developer Documentation

Detailed, source-accurate reference for **every element** of the `hexo-theme-redefine-x` theme: configuration options, EJS layouts, Hexo lifecycle scripts, custom Markdown tag plugins, front-end assets, and i18n.

> These docs describe the theme as it lives in this repository (`themes/redefine-x`). They are a developer/maintainer reference. The public, user-facing documentation site is separate: <https://redefine-x-docs.jason-yang.top/zh>.

Redefine-X is a customized fork of [`hexo-theme-redefine`](https://github.com/EvanNotFound/hexo-theme-redefine) by EvanNotFound. It targets **Hexo ≥ 5.0** (the host site runs Hexo 8) and **Node ≥ 12**, and is licensed GPL-3.0.

## How the docs are organized

| Doc | Covers | Source it documents |
|-----|--------|---------------------|
| [01 — Architecture](01-architecture.md) | How Hexo loads the theme, the dual-config system, the render lifecycle, asset compilation, CDN | whole theme |
| [02 — Configuration reference](02-configuration.md) | Every key in `_config.yml`, section by section | `_config.yml` |
| [03 — Layouts & templates](03-layouts.md) | Every EJS file: entry, page router, components, pages, utils | `layout/**` |
| [04 — Scripts (build engine)](04-scripts.md) | Every filter, helper, event, generator, and config exporter | `scripts/**` |
| [05 — Tag plugins (custom syntax)](05-tag-plugins.md) | `note`, `box`, `btn`, `btns`, `folding`, `tabs`, `exifimage`, … with usage | `scripts/modules/**` |
| [06 — Front-end assets](06-frontend-assets.md) | JS architecture (`main.js`, libs, plugins, tools, layouts) and CSS architecture (Stylus + Tailwind), fonts, images | `source/**` |
| [07 — Internationalization](07-i18n.md) | Language files and how translation resolution works | `languages/**` |
| [08 — Development & release](08-development.md) | Build/watch/release workflow, developer mode, version API | `package.json`, build scripts |

## Quick map of the theme

```
themes/redefine-x/
├── _config.yml              # Theme default config (template). The LIVE site config is
│                            #   <site-root>/_config.redefine-x.yml (Hexo alternate-config convention)
├── languages/               # i18n: en, zh-CN, zh-TW, ja, es, fr
├── layout/                  # EJS templates (server-rendered HTML)
│   ├── layout.ejs           #   <html> shell — entry point
│   ├── page.ejs / post.ejs / index.ejs / archive.ejs / category.ejs / tag.ejs / 404.ejs
│   ├── components/          #   header, footer, sidebar, comments, plugins, swup, scripts
│   ├── pages/               #   per-page-type partials (home, post, archive, masonry, friends, …)
│   └── utils/               #   reusable partials (paginator, side-tools, image-viewer, search)
├── scripts/                 # Hexo auto-loaded Node scripts (the build-time engine)
│   ├── filters/             #   after/before_post_render content transforms (priority-ordered)
│   ├── helpers/             #   EJS helper functions
│   ├── modules/             #   custom {% tag %} plugins (note, box, btn, tabs, …)
│   ├── events/              #   lifecycle hooks (clean, welcome, 404, workflow export)
│   ├── config-export.js     #   serializes config into window.config/theme for the browser
│   ├── data-handle.js       #   maps source/_data/*.yml into theme config
│   └── masonry-generator.js #   builds photo-album pages
├── source/                  # Front-end assets
│   ├── js/                  #   ES modules (build.js bundles → source/js/build/)
│   ├── css/                 #   Stylus (style.styl) + Tailwind (_tailwind.source.css)
│   ├── fonts/ images/ assets/ fontawesome/ webfonts/
├── workflows/               # GitHub Actions templates exported into the generated site
└── package.json             # Theme build/release scripts (Tailwind + terser + standard-version)
```

## The one thing to remember

**Editing `source/js/*.js` or `source/css/*` does nothing until you rebuild.** Layouts load the *compiled* output (`source/js/build/…`, `source/css/build/tailwind.css`). After any front-end change run, inside `themes/redefine-x`:

```sh
npm run build        # build:css (Tailwind) + build:js (terser)
```

See [08 — Development & release](08-development.md) for the full workflow.
