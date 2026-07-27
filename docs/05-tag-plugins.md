# 05 — Tag Plugins (custom Markdown syntax)

Redefine-X registers custom Hexo `{% tag %}` plugins in `scripts/modules/`. Use them inside any post/page Markdown. Tags with `{ ends: true }` require a matching closing tag.

Quick index:

| Tag(s) | Closing? | Purpose |
|--------|----------|---------|
| `note`, `notes`, `subnote` | yes | Inline callout/admonition |
| `noteL`, `notel`, `notelarge`, `notel-large`, `notes-large`, `subwarning` | yes | Large titled callout card |
| `box` | yes | Colored inline highlight span (math-aware) |
| `btn`, `button` | no | Single button/link |
| `btns`, `buttons` (+ `cell`) | yes | Button group container |
| `folding` | yes | Collapsible `<details>` section |
| `tabs`, `subtabs`, `subsubtabs` | yes | Tabbed content |
| `exifimage` | yes | Photo with EXIF info card |

Styling for all of these lives in `source/css/layout/_modules/` (see [06](06-frontend-assets.md)).

---

## note / notes / subnote

Inline callout. **Source:** `modules/note.js`.

```
{% note <color> [fa-<style>] [fa-<icon>] [extra-classes…] %}
Markdown **content** here.
{% endnote %}
```

- **First arg** = main class (typically a preset color, e.g. `blue`, `red`, `green`, `default`). Defaults to `default` if omitted.
- **FontAwesome icons** are auto-detected from `fa-`-prefixed args:
  - one `fa-` arg → treated as the icon, style defaults to `fa-solid`;
  - two `fa-` args → first is the *style*, second is the *icon*.
- Any remaining args become extra CSS classes. When an icon is present, an `icon-padding` class is added.
- Content is rendered as Markdown.

**Examples**
```
{% note blue fa-circle-info %}
A simple info note with an icon.
{% endnote %}

{% note red fa-regular fa-triangle-exclamation extra-class %}
Danger note, regular-style icon, plus a custom class.
{% endnote %}
```
`notes` and `subnote` are aliases (identical behavior; `subnote` is handy when nesting inside another tag).

---

## noteL (large note)

Titled callout **card** with a header bar. **Source:** `modules/note-large.js`.

```
{% noteL <color> [fa-<style>] [fa-<icon>] <Title words…> %}
Card body in **Markdown**.
{% endnoteL %}
```

- **First arg** = color class.
- Icon detection works like `note` (one or two `fa-` args), but the icon class is `notel-icon`.
- **Everything left after removing color/icon is the title** (rendered as Markdown; defaults to `Note`).

**Example**
```
{% noteL amber fa-solid fa-lightbulb Pro Tip %}
The title bar reads "Pro Tip"; this is the body.
{% endnoteL %}
```
Aliases: `notel`, `notelarge`, `notel-large`, `notes-large`, `subwarning`.

---

## box

Colored inline **highlight** span, math-safe. **Source:** `modules/box.js` (+ the [`box-syntax`](04-scripts.md#box-syntaxjs) sugar converter).

```
{% box <color> %}highlighted text{% endbox %}
```

- **Color** must be one of the presets, else falls back to `default`:
  `default, blue, cyan, teal, green, lime, yellow, amber, orange, red, pink, purple, indigo, gray, slate` (`grey` → `gray`).
- Renders as a `<span class="post-box post-box-<color>">`. If the content contains **display math**, it upgrades to a `<div … post-box-display>` so block equations lay out correctly.
- Content is HTML-escaped (newlines → `<br>`) **except** MathJax placeholders, which are preserved — so you can wrap inline math.

**Convenience syntax** (auto-converted before render): `${$ box red $}important${$ endbox $}` — useful when writing inside environments where `{% %}` is awkward, or flush against math delimiters.

---

## btn / button (single button)

Standalone link styled as a button. **Source:** `modules/btn.js`. No closing tag. Args are split by `::` **or** `,`.

```
{% btn [class],[text],[url],[fa-icon] %}
```

Argument count is interpreted flexibly:
- **4 args:** `class, text, url, icon`
- **3 args:** if the 3rd contains `fa-` → `text, url, icon`; otherwise `class, text, url`
- **2 args:** `text, url`
- **1 arg:** `text` only

**Examples**
```
{% btn Download,/files/app.zip %}
{% btn primary,GitHub,https://github.com/...,fa-brands fa-github %}
{% btn Visit::https://example.com::fa-solid fa-link %}
```
`button` is an alias.

---

## btns / buttons + cell (button group)

A container holding multiple `cell` buttons. **Source:** `modules/btns.js`.

```
{% btns <container-classes…> %}
{% cell text,url[,icon-or-image] %}
{% cell text,url,fa-solid fa-star %}
{% endbtns %}
```

- `btns` wraps children in `<div class="btns …">`; the args are extra container classes (e.g. for grid/column layouts).
- `cell` (no closing tag) builds one `<a class="button">`. Third arg: if it contains `fa-` it's an icon; otherwise it's treated as an **image URL** (falls back to `default.image` from config).
- Args split by `::` or `,`.
`buttons` is an alias for `btns`.

---

## folding

Collapsible section using native `<details>`. **Source:** `modules/folding.js`. Args split by `::` or `,`.

```
{% folding [style],<Summary title> %}
Hidden **Markdown** content.
{% endfolding %}
```

- **First arg** (optional) = a CSS class/style for the `<details>` (e.g. a color).
- **Second arg** = the summary/title text.
- Headings inside are downgraded to styled `<p class="hN">` so they don't pollute the page TOC, and the block carries `data-header-exclude`.

**Example**
```
{% folding blue,Click to expand %}
## This heading won't appear in the TOC
Some details…
{% endfolding %}
```

---

## tabs / subtabs / subsubtabs

Tabbed content. **Source:** `modules/tabs.js`. Each tab is delimited by HTML comments.

```
{% tabs UniqueName,[activeIndex] %}
<!-- tab Caption@fa-solid fa-icon -->
Markdown for tab 1
<!-- endtab -->
<!-- tab Second -->
Markdown for tab 2
<!-- endtab -->
{% endtabs %}
```

- **First arg** = a **unique** name (used to build tab IDs; a warning is logged if missing).
- **Second arg** (optional) = 1-based index of the initially active tab (default: first).
- Inside each `<!-- tab … -->` block, the caption may include an icon after `@` (e.g. `Caption@fa-solid fa-star`).
- Special handling preserves embedded **APlayer** and **Fancybox** gallery markup through the Markdown re-render.
- `subtabs` / `subsubtabs` are aliases for nesting tabs inside tabs.

---

## exifimage

A single image rendered with an EXIF metadata card. **Source:** `modules/image-exif.js`. Requires the optional `exif-parser` dependency for auto-reading (already in the site's `package.json`).

```
{% exifimage [Title] [auto-exif:true|false] %}
![Description](path/to/image.jpg)
<!-- exif-info
Make: Sony
Model: A7 IV
LensModel: FE 50mm F1.4
ExposureTime: 1/250
Aperture: 1.8
ISOSpeedRatings: 100
FocalLength: 50mm
DateTimeOriginal: 2024-01-01 12:00
GPSLatitude:
GPSLongitude:
-->
{% endexifimage %}
```

Rules and behavior:
- The block must contain **exactly one** Markdown image and **at most one** `<!-- exif-info -->` comment (validation throws otherwise).
- **`auto-exif`** (default `true`): when on, the build reads EXIF directly from the local image file (path resolved against `source/`, the theme `source/`, and the post's folder). Set a field to `false` in the comment to suppress it.
- **Custom values win** over auto-read values. Recognized fields map many camera-brand aliases (e.g. `FNumber`→Aperture, `ISO`→ISOSpeedRatings) and are formatted for display (`f/1.8`, `1/250s`, `ISO 100`, `50mm`, GPS → DMS, exposure program/metering/white-balance/flash → localized labels via the `image_exif.*` i18n keys).
- Layout follows `articles.style.image_caption`: `float` → overlay card on the image; otherwise a block card below. Output carries `data-no-img-handle` so [`img-handle`](04-scripts.md#img-handlejs) skips it.
- **Simple mode**: if no EXIF data is present but a title/description exists, renders a plain captioned `<figure>`.

> Tag name is intentionally `exifimage` (not `image`) to avoid clashing with Nunjucks/Hexo built-ins.

---

## Authoring a new tag plugin

1. Create `scripts/modules/<name>.js`.
2. Register: `hexo.extend.tag.register('<name>', fn, { ends: true|false })`. With `ends:true`, `fn(args, content)`; otherwise `fn(args)`.
3. Render nested Markdown via `hexo.render.renderSync({ text, engine: 'markdown' })`.
4. Add styles under `source/css/layout/_modules/<name>.styl` and import them; rebuild.
5. If the tag needs the `::`-or-`,` dual delimiter convention, copy the `parseArgs` pattern from `btn.js`/`tabs.js`.
