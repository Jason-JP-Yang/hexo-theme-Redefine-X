# 03 — Layouts & Templates

Every EJS file under `layout/`. The theme uses a **router pattern**: the top-level layouts are thin shells, and a `page-helpers.js` lookup table picks which partial actually renders the body.

## Render entry chain

```
layout.ejs                      # <html> shell: <head>, <body>, scripts, aplayer
  └─ (Hexo picks one of:)
       index.ejs / post.ejs / archive.ejs / category.ejs / tag.ejs / tags.ejs / 404.ejs
          └─ all delegate to →  page.ejs
                                  └─ getPagePartialPath(page) → pages/<type>/<partial>.ejs
```

### `layout.ejs` — root shell
The only real `<html>` document. Includes `components/header/head`, renders `body`, then `components/scripts`, and conditionally `components/plugins/aplayer` when `theme.plugins.aplayer.enable`.

### Thin top-level layouts
`index.ejs`, `post.ejs`, `archive.ejs`, `category.ejs`, `tag.ejs`, `tags.ejs`, `404.ejs` are each ~one line — they forward to `page.ejs`. Hexo selects them by a page's `layout`/type, but the actual content choice happens in `page.ejs`.

### `page.ejs` — the body composer
Orchestrates the visible page:
1. `components/header/progress-bar` (reading progress).
2. Optional `components/header/preloader`.
3. `<main id="swup">` — the swup-replaced container.
4. **Home banner logic:** on the home page's first page shows `pages/home/home-banner`; on paginated home pages with `home_banner.style: fixed` shows `pages/home/home-background` instead.
5. `components/header/navbar`.
6. Home sidebar (left or right per `home.sidebar.position`).
7. **`partial(getPagePartialPath(page))`** — the routed body (see below).
8. `components/footer/footer`.
9. On posts: `pages/post/post-tools` (floating tools).
10. `utils/side-tools` (settings/theme/scroll), `utils/image-viewer`, and `utils/local-search` (if search enabled).
11. `components/swup` when `global.single_page !== false`.

## The page router (`getPagePartialPath`)

Defined in [`scripts/helpers/page-helpers.js`](04-scripts.md#page-helpersjs). A `pageData` table maps page **types/titles** → a **partial** and a **layout** mode (`raw` = no extra container, `default` = wrapped). Summary:

| Page type | Matched by `type` / `title` | Partial | Layout |
|-----------|------------------------------|---------|--------|
| home | `home` / "home","首页" | `pages/home/home-content` | raw |
| archive | `archive` / "archive","归档" | `pages/archive/archive` | raw |
| post | `post` / "post","文章" | `pages/post/article-content` | raw |
| categories index | `categories` | `pages/category/categories` | default |
| category detail | (built-in `is_category`) | `pages/category/category-detail` | default |
| tags index | `tags` | `pages/tag/tags` | default |
| tag detail | (built-in `is_tag`) | `pages/tag/tag-detail` | default |
| 404 | `404`/`notfound` | `pages/notfound/notfound` | raw |
| friends | `links`/`link` / "friends",… | `pages/friends/friends-link` | default |
| masonry collection | `masonry-links` | `pages/masonry/masonry-collection` | default |
| shuoshuo (essays) | `essays`/`essay`/`shuoshuo` | `pages/shuoshuo/essays` | default |
| masonry gallery | `masonry`/`gallery`/`photos`/… | `pages/masonry/masonry` | default |
| bookmarks | `bookmarks`/`tools` | `pages/bookmarks/bookmarks` | raw |
| fallback | any custom page | `pages/page-template` | default |

To create a custom page type, add a `source/<name>/index.md` with `type: <one of the above>` in its front matter.

## `components/` — shared chrome

### `header/`
- **`head.ejs`** — `<head>`: meta (via `meta-helpers`), favicon, OG tags, fonts, Font Awesome, the Tailwind build (`css(' css/build/tailwind.css')` / `renderCSS(...)` for CDN), the Stylus `style.css`, and the `export_config` config bridge. The central place asset URLs are resolved (local vs CDN).
- **`navbar.ejs`** — top navigation from `navbar.links`, supports dropdown `submenus`, optional search trigger, logo/title.
- **`preloader.ejs`** — full-screen loader (when `global.preloader.enable`).
- **`progress-bar.ejs`** — top scroll-progress bar element.

### `sidebar/`
- **`author.ejs`** — author block (avatar + name + label).
- **`avatar.ejs`** — avatar image with hover effect.
- **`statistics.ejs`** — post/word/visitor counters.

### `comments/`
One dispatcher + four backends. `comment.ejs` picks the partial by `comment.system`:
- `waline.ejs`, `gitalk.ejs`, `twikoo.ejs`, `giscus.ejs`.

### `plugins/`
- **`aplayer.ejs`** — APlayer audio widget (when enabled), reads `plugins.aplayer.audios`.

### Top-level components
- **`scripts.ejs`** — emits the compiled JS via `renderJS` (from `source/js/build/...` plus vendored `libs/`). A core set always loads (`tools/imageViewer`, `utils`, `main`, `layouts/navbarShrink`, `tools/scrollTopBottom`, `tools/lightDarkSwitch`, `layouts/categoryList`); the rest are **conditional** on theme config (search, code copy, lazyload, runtime/odometer, typed subtitle, mermaid, masonry + reactions, TOC/tabs, pangu, bookmarks, instant-notes). Scripts that must re-run after SPA navigation are emitted with `swupReload: true`; ES modules with `module: true`.
- **`swup.ejs`** — initializes swup + its plugins (preload, progress, scroll, scripts) for SPA navigation.

### `footer/`
- **`footer.ejs`** — uptime, statistics, custom message, ICP, powered-by line. Reads the whole `footer` config block.

## `pages/` — per-type bodies

### `home/`
- **`home-content.ejs`** — home wrapper, composes banner/sidebar/article list/notes.
- **`home-banner.ejs`** — hero (title, typed subtitle, social links, instant-notes mount).
- **`home-background.ejs`** — fixed banner backdrop reused on paginated home pages.
- **`home-article.ejs`** — a single post card (cover, title, excerpt, meta, categories/tags) honoring `home.*` limits.
- **`home-content` + `home-sidebar.ejs`** — the home sidebar (menu/info/announcement/links).
- **`home-notes.ejs`** — instant-notes section markup.

### `post/`
- **`article-content.ejs`** — the post body container; renders content, then info/copyright/toc/tools.
- **`article-info.ejs`** — title, date, word count, reading time, author label.
- **`article-copyright.ejs`** — license block per `articles.copyright`.
- **`post-tools.ejs`** — floating share/scroll/toc tools shown on posts.
- **`toc.ejs`** — table of contents (depth/number/expand per `articles.toc`).

### `archive/` · `category/` · `tag/`
- **`archive/archive.ejs`** — year-grouped post timeline (uses `createNewArchivePosts` helper).
- **`category/categories.ejs`** — all categories index; **`category-detail.ejs`** — posts in one category.
- **`tag/tags.ejs`** — tag cloud/blur index (`page_templates.tags_style`); **`tag-detail.ejs`** — posts for one tag.

### Special pages
- **`friends/friends-link.ejs`** — friend-links grid (`page_templates.friends_column`, data from `_data/links.yml`).
- **`masonry/masonry.ejs`** — a single waterfall photo album; **`masonry-collection.ejs`** — index of albums. Backed by `masonry-generator.js` + `_data/masonry.yml`.
- **`shuoshuo/essays.ejs`** — micro-blog / "shuoshuo" stream from `_data/essays.yml`.
- **`bookmarks/bookmarks.ejs`** — bookmarks/tools page from `_data/bookmarks.yml`.
- **`notfound/notfound.ejs`** — 404 body.
- **`page-template.ejs`** — generic fallback for any custom Markdown page.

## `utils/` — reusable partials
- **`paginator.ejs`** — prev/next + numbered pagination (uses `isHomePagePagination` helper).
- **`posts-list.ejs`** — generic post list used by several pages.
- **`side-tools.ejs`** — right-side floating toolbar: light/dark toggle, font-size, width, scroll-to-top/bottom, settings gear.
- **`image-viewer.ejs`** — lightbox overlay markup (driven by `tools/imageViewer.js`).
- **`local-search.ejs`** — search modal (driven by `tools/localSearch.js`, needs searchdb).

## Adding/overriding a template

- New page type → add an entry to `pageData` in `page-helpers.js` and a partial under `pages/`.
- New chrome → add a partial under `components/` and `partial(...)` it from `page.ejs` or `layout.ejs`.
- Anything referencing config should read `theme.*`; anything needing per-page info reads `page.*`. Helpers (`__`, `getPagePartialPath`, `export_config`, …) come from `scripts/helpers/` — see [04 — Scripts](04-scripts.md).
