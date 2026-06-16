# 02 — Configuration Reference

Complete reference for every key in the theme config. Remember the [dual-config rule](01-architecture.md#2-the-dual-config-system-important): edit `<site-root>/_config.redefine-x.yml` for the live site; `themes/redefine-x/_config.yml` is the default template.

Each top-level block below carries a `Docs:` link to the matching public docs page. Types and defaults reflect the shipped `_config.yml`.

---

## `info` — Basic information
```yaml
info:
  title:    Theme Redefine-X        # Site title
  subtitle: Redefine Your Hexo...   # Site subtitle
  author:   Jason-JP-Yang           # Author name
  url:      https://blog.jason-yang.top
```

## `defaults` — Site images
```yaml
defaults:
  favicon: /images/redefine-favicon.svg  # Browser tab icon
  logo:                                  # Navbar logo (empty → text title)
  avatar: /images/redefine-avatar.svg    # Sidebar avatar
```

## `colors`
```yaml
colors:
  primary: "#A31F34"     # Theme accent color (links, highlights)
  secondary:             # Reserved (TBD)
  default_mode: light    # Initial mode: light | dark (overridden by prefers-color-scheme)
```

## `global` — Site customization
```yaml
global:
  fonts:                        # Custom web fonts; each has enable/family/url
    chinese: { enable, family, url }
    english: { enable, family, url }
    title:   { enable, family, url }   # navbar + sidebar titles
  content_max_width: 1000px     # Article column width
  sidebar_width: 210px
  hover:                        # Interaction effects
    shadow: true                #   drop shadow on hover
    scale: true                 #   scale-up on hover
    auto_hover: true            #   auto-trigger hover anim when element enters viewport
  scroll_progress:
    bar: true                   # top reading-progress bar
    percentage: true            # numeric percentage
  website_counter:              # vercount.one visitor stats
    url: https://www.vercount.one/js
    enable: true
    site_pv: true               # site page views
    site_uv: true               # site unique visitors
    post_pv: true               # per-post page views
  single_page: true             # swup SPA navigation (false → full reloads)
  preloader:
    enable: false
    custom_message:             # empty → show site title
  side_tools:
    gear_rotation: true         # spin the settings gear icon
    auto_expand: false          # expand the side-tools list on load
  open_graph:
    enable: true
    image: /images/redefine-og.avif   # default og:image
    description: ...
  google_analytics:
    enable: false
    id:                         # GA Measurement ID
```

## `fontawesome` — Font Awesome Pro v6.2.1
Enable extra icon styles (each is a separate webfont, off by default to save bandwidth):
```yaml
fontawesome:
  thin: false
  light: false
  duotone: false
  sharp_solid: false
```
Solid/Regular/Brands are always available. Icons are referenced as `fa-<style> fa-<name>` throughout config and tag plugins.

## `home_banner` — Home hero
```yaml
home_banner:
  enable: true
  style: fixed                  # fixed (parallax-ish) | static
  image:
    light: /images/...-light.avif
    dark:  /images/...-dark.avif
  title: Theme Redefine
  subtitle:
    text: []                    # typed.js rotating lines (array of strings)
    hitokoto:                   # pull random quote from hitokoto API
      enable: false
      show_author: false
      api: https://v1.hitokoto.cn
    typing_speed: 100           # ms (all four below are typed.js timings)
    backing_speed: 80
    starting_delay: 500
    backing_delay: 1500
    loop: true
    smart_backspace: true
  text_color: { light: "#fff", dark: "#d1d1b6" }
  text_style: { title_size: 2.8rem, subtitle_size: 1.5rem, line_height: 1.2 }
  custom_font: { enable, family, url }
  social_links:
    enable: false
    style: default              # default | reverse | center
    links: { github, instagram, zhihu, twitter, email, ... }   # url per key
    qrs:   { weixin, ... }      # QR-drawer image url per key
  instant_notes:                # Instagram-"Notes"-style bubbles on the banner
    enable: false
    api_url:                    # Cloudflare Worker endpoint (see workflows/backend-worker)
    avatar: /images/redefine-avatar.svg
```

## `navbar`
```yaml
navbar:
  auto_hide: false              # hide navbar on scroll-down
  color:
    left: "#f78736"             # gradient left
    right: "#367df7"            # gradient right
    transparency: 35            # 10–99 (%)
  width: { home: 1200px, pages: 1000px }
  links:                        # ordered menu; each entry:
    Home:
      path: /
      icon: fa-regular fa-house # optional
    # An entry may use `submenus:` (a map of label → url) instead of `path` for dropdowns.
  search:                       # local search (needs hexo-generator-searchdb)
    enable: false
    preload: true               # fetch search index on page load
```

## `home` — Home article list & sidebar
```yaml
home:
  sidebar:
    enable: true
    position: left              # left | right
    first_item: menu            # menu | info
    announcement:               # text shown in sidebar
    show_on_mobile: true        # show nav in mobile sheet menu
    links: { Label: { path, icon }, ... }
  article_date_format: auto     # auto | relative | a moment.js format string
  excerpt_length: 200           # chars in card excerpt
  categories: { enable: true, limit: 3 }
  tags:       { enable: true, limit: 3 }
```

## `articles` — Post rendering
```yaml
articles:
  style:
    font_size: 16px
    line_height: 1.5
    image_border_radius: 14px
    image_caption: block        # false | float | block  (caption from img alt)
    image_figure_number: false  # prepend "Figure N." (needs image_caption on)
    image_max_height: 80svh
    link_icon: true             # external-link icon
    delete_mask: false          # render <del> as hover-to-reveal spoiler
    title_alignment: left       # left | center
    headings_top_spacing: { h1: 3.2rem, h2: 2.4rem, ... h6: 1.3rem }
  word_count:                   # needs hexo-wordcount
    enable: true
    count: true                 # show word count
    min2read: true              # show reading time
  author_label:
    enable: true
    auto: false                 # auto Lv1/Lv2… labels
    list: []
  code_block:
    copy: true                  # copy button
    style: mac                  # mac | simple
    highlight_theme:
      light: github             # github | atom-one-light | default
      dark: vs2015              # github-dark | monokai-sublime | vs2015 | night-owl |
                                #   atom-one-dark | nord | tokyo-night-dark | a11y-dark | agate
    font: { enable, family, url }
  toc:
    enable: true
    max_depth: 3
    number: false               # auto-number headings in TOC
    expand: true
    init_open: true
  copyright:
    enable: true
    default: cc_by_nc_sa        # cc_by_nc_sa | cc_by_nd | cc_by_nc | cc_by_sa | cc_by |
                                #   all_rights_reserved | public_domain
  lazyload: true                # progressive image loading (strongly recommended)
  lazyload_preload: false       # idle-preload off-screen images (only if lazyload)
  pangu_js: false               # auto CJK/Latin spacing
  recommendation:               # related posts (needs @node-rs/jieba)
    enable: false
    title: 推荐阅读
    limit: 3
    mobile_limit: 2
    placeholder: images/...avif
    skip_dirs: []
```

## `comment`
```yaml
comment:
  enable: true
  system: waline                # waline | gitalk | twikoo | giscus
  config:
    waline:  { serverUrl, lang, emoji[], recaptchaV3Key, turnstileKey, reaction }
    gitalk:  { clientID, clientSecret, repo, owner, proxy }
    twikoo:  { version, server_url, region }
    giscus:  { repo, repo_id, category, category_id, mapping, strict,
               reactions_enabled, emit_metadata, lang, input_position, loading,
               proxy, author_pat }
```
**Giscus + masonry reactions**: the masonry photo-album "reactions" feature reuses Giscus and requires `proxy` (a CORS proxy Worker) and `author_pat` (a GitHub PAT with read/write to the discussions repo). See [04 — masonry-reactions](04-scripts.md#masonry-reactionsjs). Avoid `mapping: og:title` when swup/PJAX is on (og:title isn't updated on virtual navigation).

## `footer`
```yaml
footer:
  runtime: true                 # site uptime counter
  icon: '<i class="fa-solid fa-heart fa-beat" ...></i>'
  start: 2022/8/17 11:45:14     # YYYY/MM/DD HH:mm:ss — uptime origin
  statistics: true              # total posts / total words
  customize:                    # free-form footer message
  icp: { enable: false, number, url }   # China ICP filing
```

## `inject` — Custom HTML
```yaml
inject:
  enable: false
  head: [ '<...>', ... ]        # appended to <head>
  footer: [ '<...>', ... ]      # appended before </body>
```

## `plugins`
```yaml
plugins:
  minifier:
    imagesOptimize:             # bitmap → AVIF, see 04 — img-optimizer
      AVIF_COMPRESS: true       # convert JPEG/JPG/PNG/WEBP/GIF (incl. animated)
      encoder: sharp            # sharp | libaom-av1 | libsvtav1  (ffmpeg for the latter two)
      quality: 65               # 0 (smallest) – 100 (best)
      effort: 5                 # 0 (fastest) – 10 (best compression)
      IMG_MAX_PIXELS: 2073600   # downscale cap (~1920×1080)
      SVGO_COMPRESS: true       # minify SVG via SVGO
      EXCLUDE: []               # globs to skip
    jsOptimize: true
    htmlOptimize: true
    cssOptimize: true
  feed:    { enable: false }    # RSS (needs hexo-generator-feed)
  aplayer:                      # audio player (DIYgod/APlayer)
    enable: false
    type: fixed                 # fixed | mini
    audios: [ { name, artist, url, cover, lrc }, ... ]
  mermaid: { enable: false, version: "11.4.1" }   # diagrams
  mathjax:                      # server-side TeX → SVG (see 04 — mathjax-render)
    enable: true
    every_page: false           # true → all pages; false → only front-matter mathjax: true
    single_dollars: true        # allow $…$ inline delimiters
    tags: "ams"                 # none | ams | all  (equation numbering)
    cjk_width: 0.9              # 0.0–1.0
    normal_width: 0.6           # 0.0–1.0
```

> **Cache caveat:** AVIF/SVGO output is cached under `<site>/source/build/`. After changing any `imagesOptimize` option, clear it with `hexo clean --include-minify` or stale optimized images will be reused.

## `page_templates`
```yaml
page_templates:
  friends_column: 2             # friends-link grid columns
  tags_style: blur              # blur | cloud
```

## `cdn`
```yaml
cdn:
  enable: false
  provider: jsdelivr            # jsdelivr | unpkg | cdnjs | zstatic | npmmirror | custom
  custom_url:                   # for provider: custom — must end at theme's source/ root,
                                #   e.g. https://cdn.x.com/hexo-theme-redefine/${version}/source/${path}
```

## `developer`
```yaml
developer:
  enable: false                 # serve uncompiled source for theme hacking (see 08)
```

## Per-post front matter (not theme config, but related)

Defined by the site's `scaffolds/post.md`. Keys the theme reacts to:

| Key | Effect |
|-----|--------|
| `cover` / `thumbnail` | Card / banner image |
| `excerpt` | Overrides auto excerpt |
| `sticky` | Pin to top of home list (higher = higher) |
| `password` | Encrypt the post (see [encrypt.js](04-scripts.md#encryptjs)) |
| `mathjax: true` | Force-enable MathJax when `every_page: false` |
| `categories`, `tags` | Standard Hexo taxonomy |
