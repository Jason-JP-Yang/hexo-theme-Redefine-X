/**
 * The custom-tag emitters, shared by the build and the editor.
 *
 * Every one of these used to live inside its own `scripts/modules/*.js`, which
 * was fine while Hexo was the only thing that rendered them. The editor renders
 * them too, and it renders them in a browser that cannot run Hexo — so a second
 * copy of the markup would have been the one thing guaranteed to drift, and it
 * would drift silently: a note that looks right while you write it and lands
 * with the wrong padding.
 *
 * So the markup lives here, once, and both sides call it. The only thing that
 * differs is how markdown inside a tag is rendered, which arrives as the
 * `render` argument — `hexo.render.renderSync` on one side, the editor's own
 * renderer on the other.
 *
 * UMD on purpose. The theme has no bundler; this is the same shape tools/auth.js
 * uses, and it is what lets one file be `require`d by a Hexo script and loaded
 * as a plain script by the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RedefineComponents = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const identity = (text) => String(text == null ? "" : text);

  /* ─── note ─────────────────────────────────────────────────────────────── */

  /**
   * Split `args` into style classes and a FontAwesome icon.
   *
   * Two `fa-` arguments mean style + icon (`fa-regular fa-bell`); one means the
   * icon alone, defaulting the style to `fa-solid`. Everything left over is a
   * class, which is how `{% note info fa-bell large %}` works.
   */
  function splitIcon(args, iconClass) {
    const rest = args.slice();
    const faArgs = [];
    const faIndices = [];

    rest.forEach((arg, index) => {
      if (arg && String(arg).startsWith("fa-")) {
        faArgs.push(arg);
        faIndices.push(index);
      }
    });

    let icon = "";
    if (faArgs.length === 2) {
      icon = `<i class="${iconClass} ${faArgs[0]} ${faArgs[1]}"></i>`;
      rest.splice(faIndices[1], 1);
      rest.splice(faIndices[0], 1);
    } else if (faArgs.length === 1) {
      icon = `<i class="${iconClass} fa-solid ${faArgs[0]}"></i>`;
      rest.splice(faIndices[0], 1);
    }

    return { icon, rest };
  }

  function note(args, content, render) {
    const md = render || identity;
    const input = (args && args.length ? args : ["default"]).slice();

    let classes = [];
    const remaining = input.slice();
    if (remaining.length) {
      classes.push(remaining[0]);
      remaining.shift();
    }

    const { icon, rest } = splitIcon(remaining, "note-icon");
    classes = classes.concat(rest);
    if (icon) classes.push("icon-padding");

    return `
  <div class="note p-4 mb-4 rounded-small markdown-body ${classes.join(" ")}">
    ${icon}${md(content)}
  </div>`;
  }

  function noteLarge(args, content, render) {
    const md = render || identity;
    const input = args && args.length ? args.slice() : ["default", "Warning"];
    const color = input[0];
    const { icon, rest } = splitIcon(input.slice(1), "notel-icon");
    const title = rest.join(" ") || "Note";

    return `
  <div class="note-large ${color}">
    <div class="notel-title rounded-t-lg p-3 font-bold text-lg flex flex-row gap-2 items-center">
      ${icon}${md(title)}
    </div>
    <div class="notel-content markdown-body">
      ${md(content)}
    </div>
  </div>`;
  }

  /* ─── box ──────────────────────────────────────────────────────────────── */

  const BOX_COLORS = [
    "default", "blue", "cyan", "teal", "green", "lime", "yellow", "amber",
    "orange", "red", "pink", "purple", "indigo", "gray", "slate",
  ];
  const BOX_COLOR_SET = new Set(BOX_COLORS);
  const MATHJAX_PLACEHOLDER = /<!--mathjax:\d+:(?:display|inline)-->/g;

  function escapeText(content) {
    return String(content)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function boxColor(raw) {
    if (!raw) return "default";
    const color = String(raw).trim().toLowerCase();
    if (BOX_COLOR_SET.has(color)) return color;
    if (color === "grey") return "gray";
    return "default";
  }

  /** Escape everything except the MathJax placeholders the filter already left. */
  function escapePreservingMath(content) {
    MATHJAX_PLACEHOLDER.lastIndex = 0;
    let result = "";
    let last = 0;
    let match;
    while ((match = MATHJAX_PLACEHOLDER.exec(content)) !== null) {
      result += escapeText(content.slice(last, match.index));
      result += match[0];
      last = match.index + match[0].length;
    }
    return result + escapeText(content.slice(last));
  }

  function box(args, content) {
    const color = boxColor(args && args[0]);
    const raw = String(content || "").trim();
    const text = escapePreservingMath(raw).replace(/\r?\n/g, "<br>");
    // A box holding a DISPLAY equation cannot be a span: the equation is a
    // block, and a block inside an inline element is not renderable.
    const display = /<!--mathjax:\d+:display-->/.test(raw);
    const tag = display ? "div" : "span";
    const cls = display
      ? `post-box post-box-${color} post-box-display`
      : `post-box post-box-${color}`;

    return `<${tag} class="${cls}" data-box-color="${color}">${text}</${tag}>`;
  }

  /* ─── folding ──────────────────────────────────────────────────────────── */

  /** `::` when present, otherwise `,`. Both are documented separators. */
  function splitArgs(args) {
    const joined = (args || []).join(" ");
    return joined.includes("::") ? joined.split("::") : joined.split(",");
  }

  function folding(args, content, render) {
    const md = render || identity;
    const [style, title = ""] = splitArgs(args).map((arg) => String(arg).trim());

    // Headings become paragraphs carrying the heading's class: a collapsed
    // block must not put entries into the page's table of contents.
    const body = md(content)
      .replace(/<(h[1-6])>/g, (_, tag) => `<p class='${tag}'>`)
      .replace(/<\/(h[1-6])>/g, () => "</p>");

    const styleAttr = style ? ` class="${style}"` : "";

    return `<details${styleAttr} data-header-exclude>
    <summary><i class="fa-solid fa-chevron-right"></i>${title} </summary>
    <div class='content markdown-body'>
      ${body}
    </div>
  </details>`;
  }

  /* ─── tabs ─────────────────────────────────────────────────────────────── */

  const TAB_BLOCK = /<!--\s*tab (.*?)\s*-->\n([\w\W\s\S]*?)<!--\s*endtab\s*-->/g;
  const APLAYER_TAG = /<div.*class="aplayer aplayer-tag-marker"(.|\n)*<\/script>/g;
  const FANCYBOX_TAG = /<div.*galleryFlag(.|\n)*<\/span><\/div><\/div>/g;

  function tabPanes(content) {
    TAB_BLOCK.lastIndex = 0;
    const out = [];
    let match;
    while ((match = TAB_BLOCK.exec(content)) !== null) {
      out.push({ caption: match[1], body: match[2] });
    }
    return out;
  }

  function tabs(args, content, render, options) {
    const md = render || identity;
    const opts = options || {};
    const [rawName, rawActive] = splitArgs(args);
    const name = String(rawName || "").trim();
    const active = Number(rawActive) || 0;

    if (!name && opts.warn) opts.warn("Tabs block must have unique name!");

    let nav = "";
    let panes = "";

    tabPanes(content).forEach((pane, index) => {
      const params = pane.caption.split("@");
      const caption = params[0] || "";
      const icon = params[1] || "";
      const href = (name + " " + (index + 1)).toLowerCase().split(" ").join("-");

      // Both markers are whole rendered elements a markdown pass would mangle,
      // so they step out of the way and come back after it.
      let body = pane.body;
      let aplayer = 0;
      let fancybox = 0;
      if (/class="aplayer aplayer-tag-marker"/g.test(body)) {
        APLAYER_TAG.lastIndex = 0;
        const found = APLAYER_TAG.exec(body);
        if (found) {
          aplayer = found[0];
          body = body.replace(APLAYER_TAG, "@aplayerTag@");
        }
      }
      if (/galleryFlag/g.test(body)) {
        FANCYBOX_TAG.lastIndex = 0;
        const found = FANCYBOX_TAG.exec(body);
        if (found) {
          fancybox = found[0];
          body = body.replace(FANCYBOX_TAG, "@fancyboxTag@");
        }
      }

      const rendered = String(md(body)).trim()
        .replace(/<pre><code>.*@aplayerTag@.*<\/code><\/pre>/, aplayer)
        .replace(/.*@fancyboxTag@.*/, fancybox);

      const isActive = (active > 0 && active === index + 1) || (active === 0 && index === 0)
        ? " active"
        : "";

      nav += `<li class="tab${isActive}"><a class="#${href}">${icon + caption.trim()}</a></li>`;
      panes += `<div class="tab-pane${isActive}" id="${href}">${rendered}</div>`;
    });

    const id = name.toLowerCase().split(" ").join("-");
    return `<div class="tabs" id="tab-${id}"><ul class="nav-tabs">${nav}</ul><div class="tab-content">${panes}</div></div>`;
  }

  /* ─── btn ──────────────────────────────────────────────────────────────── */

  /**
   * `class, text, url, icon` — with the shorter forms disambiguated the way the
   * documented syntax always has: three arguments whose last contains `fa-` are
   * text/url/icon, otherwise class/text/url.
   */
  function btn(args) {
    const parts = splitArgs(args);
    let cls = "";
    let text = "";
    let url = "";
    let icon = "";

    switch (parts.length) {
      case 4:
        [cls, text, url, icon] = parts;
        break;
      case 3:
        if (parts[2].includes("fa-")) [text, url, icon] = parts;
        else [cls, text, url] = parts;
        break;
      case 2:
        [text, url] = parts;
        break;
      case 1:
        [text] = parts;
        break;
    }

    cls = String(cls).trim();
    icon = String(icon).trim();
    text = String(text).trim();
    url = String(url).trim();

    const hrefAttr = url ? `href='${url}'` : "";
    if (icon) {
      return `<a class="button ${cls}" ${hrefAttr} title='${text}'><i class='${icon}'></i> ${text}</a>`;
    }
    return `<a class="button ${cls}" ${hrefAttr} title='${text}'>${text}</a>`;
  }

  /* ─── image with EXIF ──────────────────────────────────────────────────── */

  /**
   * `{% exifimage [title] [auto-exif:bool] %}` — the browser half.
   *
   * scripts/modules/image-exif.js is the build's, and it can do one thing this
   * cannot: open the file and read the camera data out of it. So the editor
   * renders what the author has WRITTEN — the build's figure, card, labels and
   * figure number, in the build's order — and leaves the automatic fields to
   * the build. What is on the canvas is the layout that will be published; what
   * fills it may still grow.
   */
  const EXIF_ORDER = [
    ["camera", "fa-camera", ["Make", "Model", "DateTimeOriginal"]],
    ["lens", "fa-circle-dot", ["LensModel", "FocalLength", "FocusMode"]],
    ["exposure", "fa-sun", ["ExposureTime", "Aperture", "ISOSpeedRatings", "ExposureProgram", "ExposureBias", "MeteringMode"]],
    ["other", "fa-circle-info", ["Flash", "WhiteBalance", "GPSLatitude", "GPSLongitude", "GPSAltitude"]],
  ];

  const EXIF_LABELS = {
    Make: "Make", Model: "Model", DateTimeOriginal: "Date Taken",
    LensModel: "Lens", FocalLength: "Focal Length", FocusMode: "Focus Mode",
    ExposureTime: "Shutter", Aperture: "Aperture", ISOSpeedRatings: "ISO",
    ExposureProgram: "Exposure Program", ExposureBias: "Exposure Compensation",
    MeteringMode: "Metering Mode", Flash: "Flash", WhiteBalance: "White Balance",
    GPSLatitude: "Latitude", GPSLongitude: "Longitude", GPSAltitude: "Altitude",
  };

  const SECTION_LABELS = { camera: "Camera", lens: "Lens", exposure: "Exposure", other: "Other" };
  // The keys `image_exif.field.*` is translated under, which is what the build prints.
  const FIELD_KEYS = {
    Make: "make", Model: "model", DateTimeOriginal: "datetime_original",
    LensModel: "lens_model", FocalLength: "focal_length", FocusMode: "focus_mode",
    ExposureTime: "exposure_time", Aperture: "aperture", ISOSpeedRatings: "iso",
    ExposureProgram: "exposure_program", ExposureBias: "exposure_bias",
    MeteringMode: "metering_mode", Flash: "flash", WhiteBalance: "white_balance",
    GPSLatitude: "gps_latitude", GPSLongitude: "gps_longitude", GPSAltitude: "gps_altitude",
  };
  const NEWLINES = /\r?\n/;

  // A path with a space or a bracket is written between angle brackets, the
  // markdown standard's spelling for it; the path itself never carries them.
  const linkDest = (path) => (/[\s()<>]/.test(path) ? "<" + path.replace(/[<>]/g, encodeURIComponent) + ">" : path);
  const linkPath = (dest) => (/^<.*>$/.test(dest) ? dest.slice(1, -1) : dest);

  /** The image line and the exif-info comment the tag's body is made of. */
  function parseExifBody(content) {
    const text = String(content == null ? "" : content);
    const image = text.match(/!\[([^\]]*)\]\((<[^<>\n]*>|[^)]+)\)/);
    const info = {};

    const comment = text.match(/<!--\s*exif-info([\s\S]*?)-->/);
    if (comment) {
      for (const line of comment[1].split(NEWLINES)) {
        const pair = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
        if (pair && EXIF_LABELS[pair[1]]) info[pair[1]] = pair[2].trim();
      }
    }
    return { description: image ? image[1] : "", path: image ? linkPath(image[2].trim()) : "", info };
  }

  /** The inverse: fields back into the tag's body. */
  function buildExifBody(fields) {
    const lines = [`![${fields.description || ""}](${linkDest(String(fields.path || ""))})`];
    const written = Object.keys(EXIF_LABELS).filter((key) => (fields.info || {})[key]);
    if (written.length) {
      lines.push("<!-- exif-info");
      for (const key of written) lines.push(`${key}: ${fields.info[key]}`);
      lines.push("-->");
    }
    return lines.join("\n");
  }

  const EXIF_FLAGS = /(?:^|\s)(?:auto-exif\s*:\s*(?:true|false)|size\s*:\s*\d+(?:\.\d+)?)(?=\s|$)/gi;

  function exifArgs(args) {
    const joined = (args || []).join(" ");
    const auto = joined.match(/auto-exif\s*:\s*(true|false)/i);
    const size = joined.match(/(?:^|\s)size\s*:\s*(\d+(?:\.\d+)?)(?=\s|$)/i);
    return {
      title: joined.replace(EXIF_FLAGS, " ").replace(/\s+/g, " ").trim(),
      autoExif: auto ? auto[1].toLowerCase() === "true" : true,
      size: size ? imageSize(size[1]) : 0,
    };
  }

  /**
   * A picture's size, 10–100: the share of its FRAME it is drawn at. 100, or
   * nothing, is the picture as every other one is drawn.
   *
   * The frame is `size × reference` wide and `size × max-height` tall, clipped
   * to the column the picture is in (see `.img-sized` in image-exif.styl). The
   * width half is absolute — the article's widest column — so shrinking a wide
   * picture narrows it on a desktop and leaves a phone, whose column is already
   * narrower than the frame, exactly as it was. The height half is a share of
   * the viewport, so a tall picture, which is height-bound everywhere, shrinks
   * on every screen alike. Inside a table cell the reference is the cell.
   */
  function imageSize(raw) {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n >= 10 && n < 100 ? n : 0;
  }

  /** The frame's inline custom properties, from the picture's own pixels. */
  function imageFrame(size, dims) {
    const out = [`--img-size:${size / 100}`];
    if (dims && dims.width > 0 && dims.height > 0) {
      out.push(`--img-ar:${(dims.width / dims.height).toFixed(5)}`, `--img-nat:${Math.round(dims.width)}px`);
    }
    return out.join(";");
  }

  /**
   * @param {object} options
   *   resolve(path)  the address the picture is fetched from
   *   float          `articles.style.image_caption === "float"`: the card sits
   *                  INSIDE the image wrapper, which is what the float CSS reads
   *   labels         the site's `image_exif` translations, as the build prints them
   *   figure         the figure number img-handle.js would prefix, or 0
   *   media          markup to stand in for the `<img>` (the lazy preloader)
   */
  function exifImage(args, content, render, options) {
    const { title, size } = exifArgs(args);
    const { description, path, info } = parseExifBody(content);
    const opts = options || {};
    const labels = opts.labels || {};
    const src = opts.resolve ? opts.resolve(path) : path;
    const n = Number(opts.figure) || 0;
    const sized = size ? ` img-sized" style="${imageFrame(size, opts.dims)}` : "";

    // `false` written into a field is how the build is told to leave it out.
    const shown = {};
    for (const key of Object.keys(info)) {
      if (String(info[key]).toLowerCase() !== "false") shown[key] = info[key];
    }
    const hasInfo = Object.keys(shown).length > 0;
    const alt = escapeText(description);
    const numbered = (text) => (n ? `<strong>Figure ${n}.</strong> ` : "") + text;

    if (!hasInfo) {
      // Nothing to say but its number is said the way img-handle.js says it for
      // a plain picture — no bold, no full stop — and nothing at all is no caption.
      const caption = title
        ? `<strong class="image-exif-title">${numbered(escapeText(title))}</strong>` +
          (description ? "<br>" + escapeText(description) : "")
        : description
          ? numbered(escapeText(description))
          : n
            ? `Figure ${n}`
            : "";
      const media = opts.media || `<img src="${escapeText(src)}" alt="${alt}" class="image-exif-img" data-no-img-handle="true" />`;
      return `
<figure class="image-caption image-exif-simple-container${sized}">
  ${media}
  ${caption ? `<figcaption>${caption}</figcaption>` : ""}
</figure>`;
    }

    const section = labels.section || {};
    const field = labels.field || {};
    let sections = "";
    for (const [key, icon, fields] of EXIF_ORDER) {
      const items = fields.filter((f) => shown[f]);
      if (!items.length) continue;
      sections +=
        `<div class="image-exif-section image-exif-${key}">` +
        `<div class="image-exif-section-title"><i class="fa-solid ${icon}"></i> ${escapeText(section[key] || SECTION_LABELS[key])}</div>` +
        `<div class="image-exif-items">` +
        items
          .map(
            (f) =>
              `<div class="image-exif-item"><span class="image-exif-label">${escapeText(field[FIELD_KEYS[f]] || EXIF_LABELS[f])}</span>` +
              `<span class="image-exif-value">${escapeText(shown[f])}</span></div>`
          )
          .join("") +
        `</div></div>`;
    }

    const toggle = escapeText((labels.ui && labels.ui.toggle) || "Toggle EXIF data");
    const heading = title
      ? `<div class="image-exif-title">${numbered(escapeText(title))}</div>`
      : n
        ? `<div class="image-exif-title">Figure ${n}</div>`
        : "";
    const header =
      `<div class="image-exif-header"><div class="image-exif-header-content">` +
      heading +
      (description ? `<div class="image-exif-description">${escapeText(description)}</div>` : "") +
      `</div><button class="image-exif-toggle-btn" aria-label="${toggle}">` +
      `<i class="fa-solid fa-chevron-down"></i></button></div>`;

    const card = `<div class="image-exif-info-card">${header}<div class="image-exif-data">${sections}</div></div>`;
    const media = opts.media || `<img src="${escapeText(src)}" alt="${alt}" class="image-exif-img" />`;
    const layout = opts.float ? "image-exif-float" : "image-exif-block";

    return `
<figure class="image-exif-container ${layout}${sized}" data-no-img-handle="true">
  <div class="image-exif-image-wrapper">
    ${media}
    ${opts.float ? card : ""}
  </div>
  ${opts.float ? "" : card}
</figure>`;
  }

  /* ─── table ────────────────────────────────────────────────────────────── */

  /**
   * `{% table %}` — the table a markdown table cannot be.
   *
   *   {% table head:1 band:1 cols:a,30,a size:80 %}
   *   <!-- row -->
   *   <!-- cell span:2x1 align:mc bg:blue border:thick,,thin/red, -->
   *   Any markdown: paragraphs, a list, a picture.
   *   <!-- cell -->
   *   …
   *   {% endtable %}
   *
   * Arguments: `head` header rows, `hcol:1` a header column, `band:1` banded
   * rows, `size` the table's width on the same frame a picture's size uses (a
   * share of the widest column, clipped to the column it is in) or `fit` for the
   * width of its content, and `cols` one entry per GRID column — `a` for a width
   * the content decides, a number for a fixed share of the table in percent.
   *
   * A cell: `span:COLSxROWS`, `align:` vertical t/m/b then horizontal l/c/r,
   * `bg:` a box colour, soft or `-solid`, and `border:` top,right,bottom,left,
   * each a line (thin medium thick dashed dotted double none) with an optional
   * `/colour`; empty is the table's own rule.
   *
   * Cells need not line up in columns. A cell resized on its own moves only its
   * own edge, which is written as a finer grid and wider spans in the rows it did
   * not touch — so what is published is still a plain `colgroup` and `colspan`
   * table, and the browser lays it out.
   */
  const TABLE_ALIGNS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];
  const TABLE_LINES = {
    thin: [1, "solid"],
    medium: [2, "solid"],
    thick: [3, "solid"],
    dashed: [1, "dashed"],
    dotted: [2, "dotted"],
    double: [3, "double"],
    none: [0, "hidden"],
  };
  const TABLE_SIDES = ["top", "right", "bottom", "left"];
  const TABLE_MARK = /^\s*<!--\s*(row|cell)(?:\s+([^>]*?))?\s*-->\s*$/;

  function tableLine(raw) {
    const [style, colour] = String(raw || "").trim().toLowerCase().split("/");
    if (!TABLE_LINES[style]) return "";
    if (!colour || style === "none") return style;
    return colour === "accent" || BOX_COLOR_SET.has(colour) ? style + "/" + colour : style;
  }

  function tableFill(raw) {
    const m = String(raw || "").trim().toLowerCase().match(/^([a-z]+)(-solid)?$/);
    return m && BOX_COLOR_SET.has(m[1]) ? m[1] + (m[2] || "") : "";
  }

  function tableCell(fields) {
    return Object.assign(
      { cs: 1, rs: 1, align: "", bg: "", border: ["", "", "", ""], body: "" },
      fields || {}
    );
  }

  function clampInt(raw, lo, hi) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
  }

  function tableCellAttrs(text) {
    const cell = tableCell();
    for (const token of String(text || "").trim().split(/\s+/)) {
      const at = token.indexOf(":");
      if (at < 1) continue;
      const key = token.slice(0, at).toLowerCase();
      const value = token.slice(at + 1);
      if (key === "span") {
        const m = value.match(/^(\d+)x(\d+)$/i);
        if (m) {
          cell.cs = clampInt(m[1], 1, 500);
          cell.rs = clampInt(m[2], 1, 5000);
        }
      } else if (key === "align") {
        if (TABLE_ALIGNS.includes(value.toLowerCase())) cell.align = value.toLowerCase();
      } else if (key === "bg") {
        cell.bg = tableFill(value);
      } else if (key === "border") {
        const sides = value.split(",");
        cell.border = [0, 1, 2, 3].map((i) => tableLine(sides[i]));
      }
    }
    return cell;
  }

  function tableArgs(args) {
    const out = { size: 0, head: 0, hcol: 0, band: false, cols: [] };
    const tokens = (Array.isArray(args) ? args.join(" ") : String(args || "")).trim().split(/\s+/);
    for (const token of tokens) {
      const at = token.indexOf(":");
      if (at < 1) continue;
      const key = token.slice(0, at).toLowerCase();
      const value = token.slice(at + 1).toLowerCase();
      if (key === "size") out.size = value === "fit" ? "fit" : imageSize(value);
      else if (key === "head") out.head = clampInt(value, 0, 50);
      else if (key === "hcol") out.hcol = clampInt(value, 0, 1);
      else if (key === "band") out.band = value === "1" || value === "true";
      else if (key === "cols") {
        out.cols = value.split(",").map((v) => {
          const n = parseFloat(v);
          return Number.isFinite(n) && n > 0 ? Math.min(100, n) : null;
        });
      }
    }
    return out;
  }

  /** The body's rows and cells, as written; `tableNormalize` makes them a grid. */
  function tableRows(content) {
    const lines = String(content == null ? "" : content).replace(/\r\n/g, "\n").split("\n");
    const rows = [];
    let row = null;
    let cell = null;
    let buf = [];

    const flush = () => {
      if (cell) {
        while (buf.length && !buf[0].trim()) buf.shift();
        while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
        cell.body = buf.join("\n");
      }
      buf = [];
    };

    for (const line of lines) {
      const m = line.match(TABLE_MARK);
      if (!m) {
        if (cell) buf.push(line);
        continue;
      }
      flush();
      if (m[1] === "row") {
        row = { cells: [] };
        rows.push(row);
        cell = null;
      } else {
        if (!row) {
          row = { cells: [] };
          rows.push(row);
        }
        cell = tableCellAttrs(m[2]);
        row.cells.push(cell);
      }
    }
    flush();
    return rows;
  }

  /**
   * Rows and spans, placed the way an HTML table places them.
   *
   * A span running into a slot somebody already owns, or off the last row, is
   * clipped; a hole is filled with an empty cell. Afterwards every slot has
   * exactly one owner and every owner is a rectangle, so `slots` IS the table
   * and every edit can be made on it and read back with `tableFromSlots`.
   */
  function tableNormalize(model) {
    const rows = model.rows && model.rows.length ? model.rows : [{ cells: [tableCell()] }];
    const slots = rows.map(() => []);

    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells) {
        while (slots[r][c]) c += 1;
        let cs = Math.max(1, cell.cs | 0 || 1);
        let rs = Math.max(1, Math.min(cell.rs | 0 || 1, rows.length - r));
        for (let x = 1; x < cs; x++) {
          if (slots[r][c + x]) {
            cs = x;
            break;
          }
        }
        for (let y = 1; y < rs; y++) {
          let free = true;
          for (let x = 0; x < cs; x++) if (slots[r + y][c + x]) free = false;
          if (!free) {
            rs = y;
            break;
          }
        }
        for (let y = 0; y < rs; y++) for (let x = 0; x < cs; x++) slots[r + y][c + x] = cell;
        c += cs;
      }
    });

    const width = Math.max(1, (model.cols || []).length, ...slots.map((line) => line.length));
    for (const line of slots) {
      for (let c = 0; c < width; c++) if (!line[c]) line[c] = tableCell();
    }
    return tableFromSlots(model, slots);
  }

  /**
   * The slot matrix back into rows of anchored cells, spans read off the
   * rectangle each cell covers. `model`'s own settings are kept; `cols` is
   * padded or cut to the grid.
   */
  function tableFromSlots(model, slots) {
    const width = slots.length ? slots[0].length : 0;
    const seen = new Set();
    const rows = slots.map(() => ({ cells: [] }));

    for (let r = 0; r < slots.length; r++) {
      for (let c = 0; c < width; c++) {
        const cell = slots[r][c];
        if (seen.has(cell)) continue;
        seen.add(cell);
        let cs = 1;
        while (c + cs < width && slots[r][c + cs] === cell) cs += 1;
        let rs = 1;
        while (r + rs < slots.length && slots[r + rs][c] === cell) rs += 1;
        Object.assign(cell, { r, c, cs, rs });
        if (!Array.isArray(cell.border)) cell.border = ["", "", "", ""];
        rows[r].cells.push(cell);
      }
    }

    const cols = (model.cols || []).slice(0, width);
    while (cols.length < width) cols.push(null);

    return {
      size: model.size || 0,
      head: Math.min(model.head | 0, slots.length),
      hcol: model.hcol ? 1 : 0,
      band: !!model.band,
      cols,
      rows,
      slots,
    };
  }

  function tableModel(args, content) {
    return tableNormalize(Object.assign(tableArgs(args), { rows: tableRows(content) }));
  }

  const shareText = (w) => String(Math.round(w * 10) / 10);

  function tableArgsText(model) {
    const out = [];
    if (model.size === "fit") out.push("size:fit");
    else if (imageSize(model.size)) out.push("size:" + imageSize(model.size));
    if (model.head) out.push("head:" + model.head);
    if (model.hcol) out.push("hcol:1");
    if (model.band) out.push("band:1");
    if (model.cols.some((w) => w != null)) {
      out.push("cols:" + model.cols.map((w) => (w == null ? "a" : shareText(w))).join(","));
    }
    return out.join(" ");
  }

  function tableBodyText(model) {
    const lines = [];
    for (const row of model.rows) {
      lines.push("<!-- row -->");
      for (const cell of row.cells) {
        const attrs = [];
        if (cell.cs > 1 || cell.rs > 1) attrs.push(`span:${cell.cs}x${cell.rs}`);
        if (cell.align) attrs.push("align:" + cell.align);
        if (cell.bg) attrs.push("bg:" + cell.bg);
        if (cell.border.some(Boolean)) attrs.push("border:" + cell.border.join(","));
        lines.push("<!-- cell" + (attrs.length ? " " + attrs.join(" ") : "") + " -->");
        if (cell.body) lines.push(cell.body);
      }
    }
    return lines.join("\n");
  }

  function lineColour(colour) {
    if (!colour) return "var(--table-rule-strong)";
    return colour === "accent" ? "var(--primary-color)" : `var(--tc-${colour})`;
  }

  /** One line as a CSS border value; `hidden` wins every collapsed conflict. */
  function lineCSS(token) {
    if (!token) return "";
    const [style, colour] = token.split("/");
    const [width, kind] = TABLE_LINES[style];
    if (kind === "hidden") return "hidden";
    return `${width}px ${kind} ${lineColour(colour)}`;
  }

  /** The cells across one side of `cell`, each once. */
  function tableFacing(model, cell, side) {
    const { slots } = model;
    const out = new Set();
    if (side === 0 && cell.r > 0) for (let x = 0; x < cell.cs; x++) out.add(slots[cell.r - 1][cell.c + x]);
    if (side === 2 && cell.r + cell.rs < slots.length) for (let x = 0; x < cell.cs; x++) out.add(slots[cell.r + cell.rs][cell.c + x]);
    if (side === 3 && cell.c > 0) for (let y = 0; y < cell.rs; y++) out.add(slots[cell.r + y][cell.c - 1]);
    if (side === 1 && cell.c + cell.cs < model.cols.length) for (let y = 0; y < cell.rs; y++) out.add(slots[cell.r + y][cell.c + cell.cs]);
    return Array.from(out);
  }

  /**
   * Which outer sides the FRAME draws in a colour of its own: a side whose every
   * cell asks for the same line. Anything less uniform is drawn by the cells,
   * inside the frame's default rule.
   */
  function tableFrame(model) {
    const frame = ["", "", "", ""];
    const H = model.slots.length;
    const W = model.cols.length;
    const along = [
      (cell) => cell.r === 0,
      (cell) => cell.c + cell.cs >= W,
      (cell) => cell.r + cell.rs >= H,
      (cell) => cell.c === 0,
    ];
    const cells = model.rows.flatMap((row) => row.cells);
    for (let side = 0; side < 4; side++) {
      const edge = cells.filter(along[side]);
      const first = edge.length ? edge[0].border[side] : "";
      if (first && edge.every((cell) => cell.border[side] === first)) frame[side] = first;
    }
    return frame;
  }

  /** The container's classes and inline custom properties. */
  function tableShell(model) {
    const cls = ["table-container", "rich-table"];
    const style = [];
    if (model.band) cls.push("is-banded");
    if (model.size === "fit") cls.push("is-fit");
    else if (imageSize(model.size)) {
      cls.push("is-sized");
      style.push(`--table-size:${imageSize(model.size) / 100}`);
    }
    const frame = tableFrame(model);
    frame.forEach((token, side) => {
      if (!token) return;
      const css = lineCSS(token);
      style.push(`--tf-${"trbl"[side]}:${css === "hidden" ? "0 none" : css}`);
    });
    return { cls, style, frame };
  }

  /**
   * One cell's element, class list and inline borders — shared by the build's
   * HTML and the editor's DOM so the two cannot describe a cell differently.
   *
   * Borders collapse, and a collapsed conflict between two lines of the same
   * width goes to the STYLE that ranks higher — so a dotted line set on one cell
   * would lose to its neighbour's plain default rule. A side left at the default
   * therefore stands down (`none`) wherever a cell across it has set a line.
   */
  function tableCellView(model, cell, frame) {
    const H = model.slots.length;
    const W = model.cols.length;
    const header = cell.r < model.head || (model.hcol && cell.c === 0);
    const cls = [];
    if (cell.align) cls.push("ta-" + cell.align);
    if (cell.bg) cls.push("bg-" + cell.bg);
    const edges = [cell.r === 0, cell.c + cell.cs >= W, cell.r + cell.rs >= H, cell.c === 0];
    edges.forEach((on, side) => on && cls.push("e-" + "trbl"[side]));

    const style = [];
    for (let side = 0; side < 4; side++) {
      const own = cell.border[side];
      const prop = "border-" + TABLE_SIDES[side];
      if (edges[side]) {
        if (own && !(frame && frame[side])) style.push(`${prop}:${lineCSS(own)}`);
        continue;
      }
      if (own) style.push(`${prop}:${lineCSS(own)}`);
      else if (tableFacing(model, cell, side).some((other) => other.border[(side + 2) % 4])) {
        style.push(`${prop}-style:none`);
      }
    }

    return {
      tag: header ? "th" : "td",
      colspan: cell.cs,
      rowspan: cell.rs,
      scope: header ? (cell.r < model.head ? "col" : "row") : "",
      cls,
      style: style.join(";"),
    };
  }

  /** A heading in a cell is set like one without joining the contents. */
  function cellHTML(html) {
    return String(html == null ? "" : html)
      .replace(/<(h[1-6])(\s[^>]*)?>/g, (_, tag) => `<p class='${tag}'>`)
      .replace(/<\/h[1-6]>/g, "</p>");
  }

  /**
   * The table's HTML. `args` may be the tag's own argument list or a model the
   * caller already holds; `options.cell(cell)` replaces a cell's contents.
   */
  function table(args, content, render, options) {
    const md = render || identity;
    const opts = options || {};
    const model = args && args.slots ? args : tableModel(args, content);
    const shell = tableShell(model);

    const cols = model.cols
      .map((w) => (w == null ? "<col>" : `<col style="width:${shareText(w)}%">`))
      .join("");

    let head = "";
    let body = "";
    model.rows.forEach((row, r) => {
      const cells = row.cells
        .map((cell) => {
          const v = tableCellView(model, cell, shell.frame);
          const attrs =
            (v.cls.length ? ` class="${v.cls.join(" ")}"` : "") +
            (v.colspan > 1 ? ` colspan="${v.colspan}"` : "") +
            (v.rowspan > 1 ? ` rowspan="${v.rowspan}"` : "") +
            (v.scope ? ` scope="${v.scope}"` : "") +
            (v.style ? ` style="${v.style}"` : "");
          const inner = opts.cell ? opts.cell(cell) : cellHTML(md(cell.body));
          return `<${v.tag}${attrs}>${inner}</${v.tag}>`;
        })
        .join("");
      if (r < model.head) head += `<tr>${cells}</tr>`;
      else body += `<tr>${cells}</tr>`;
    });

    return (
      `<div class="${shell.cls.join(" ")}" data-table${shell.style.length ? ` style="${shell.style.join(";")}"` : ""}>` +
      `<div class="table-scroll"><table><colgroup>${cols}</colgroup>` +
      (head ? `<thead>${head}</thead>` : "") +
      `<tbody>${body}</tbody></table></div></div>`
    );
  }

  /* ─── the editor's view of all this ────────────────────────────────────── */

  /**
   * What the editor needs to build a control for each component: the tag names
   * it answers to, whether it wraps a body, and the arguments it takes. Kept
   * beside the emitters so a new component is described in one place.
   */
  const SPEC = {
    note: {
      tags: ["note", "notes", "subnote"],
      ends: true,
      body: "blocks",
      fields: [
        { key: "color", type: "color", options: ["default", "info", "success", "warning", "danger", "primary"] },
        { key: "icon", type: "icon" },
      ],
    },
    noteLarge: {
      tags: ["noteL", "notel", "notelarge", "notel-large", "notes-large", "subwarning"],
      ends: true,
      body: "blocks",
      fields: [
        { key: "color", type: "color", options: ["default", "info", "success", "warning", "danger", "primary"] },
        { key: "icon", type: "icon" },
        { key: "title", type: "text" },
      ],
    },
    box: {
      tags: ["box"],
      ends: true,
      body: "text",
      fields: [{ key: "color", type: "color", options: BOX_COLORS }],
    },
    folding: {
      tags: ["folding"],
      ends: true,
      body: "blocks",
      separator: "::",
      fields: [
        { key: "style", type: "text" },
        { key: "title", type: "text" },
      ],
    },
    tabs: {
      tags: ["tabs", "subtabs", "subsubtabs"],
      ends: true,
      body: "panes",
      separator: "::",
      fields: [
        { key: "name", type: "text" },
        { key: "active", type: "number" },
      ],
    },
    exifImage: {
      tags: ["exifimage"],
      ends: true,
      body: "image",
      fields: [
        { key: "title", type: "text" },
        { key: "autoExif", type: "toggle" },
      ],
    },
    table: {
      tags: ["table"],
      ends: true,
      body: "cells",
    },
    btn: {
      tags: ["btn", "button"],
      ends: false,
      separator: "::",
      fields: [
        { key: "class", type: "text" },
        { key: "text", type: "text" },
        { key: "url", type: "text" },
        { key: "icon", type: "icon" },
      ],
    },
  };

  /** Every tag name any component answers to, lowercased. */
  const TAG_INDEX = (function () {
    const index = new Map();
    for (const [name, spec] of Object.entries(SPEC)) {
      for (const tag of spec.tags) index.set(tag.toLowerCase(), name);
    }
    return index;
  })();

  return {
    note,
    noteLarge,
    box,
    folding,
    tabs,
    btn,
    exifImage,
    exifArgs,
    parseExifBody,
    buildExifBody,
    imageSize,
    imageFrame,
    table,
    tableModel,
    tableNormalize,
    tableFromSlots,
    tableArgsText,
    tableBodyText,
    tableShell,
    tableCellView,
    tableCell,
    tableLine,
    cellHTML,
    TABLE_ALIGNS,
    TABLE_LINES,
    EXIF_LABELS,
    splitArgs,
    splitIcon,
    boxColor,
    BOX_COLORS,
    SPEC,
    TAG_INDEX,
  };
});
