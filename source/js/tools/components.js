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
   * renders what the author has WRITTEN — the same figure, the same card, the
   * same section and item classes — and leaves the automatic fields to the
   * build. What is on the canvas is the layout that will be published; what
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
  const NEWLINES = /\r?\n/;

  /** The image line and the exif-info comment the tag's body is made of. */
  function parseExifBody(content) {
    const text = String(content == null ? "" : content);
    const image = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    const info = {};

    const comment = text.match(/<!--\s*exif-info([\s\S]*?)-->/);
    if (comment) {
      for (const line of comment[1].split(NEWLINES)) {
        const pair = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
        if (pair && EXIF_LABELS[pair[1]]) info[pair[1]] = pair[2].trim();
      }
    }
    return { description: image ? image[1] : "", path: image ? image[2] : "", info };
  }

  /** The inverse: fields back into the tag's body. */
  function buildExifBody(fields) {
    const lines = [`![${fields.description || ""}](${fields.path || ""})`];
    const written = Object.keys(EXIF_LABELS).filter((key) => (fields.info || {})[key]);
    if (written.length) {
      lines.push("<!-- exif-info");
      for (const key of written) lines.push(`${key}: ${fields.info[key]}`);
      lines.push("-->");
    }
    return lines.join("\n");
  }

  function exifArgs(args) {
    const joined = (args || []).join(" ");
    const auto = joined.match(/auto-exif\s*:\s*(true|false)/i);
    return {
      title: joined.replace(/auto-exif\s*:\s*(true|false)/i, "").trim(),
      autoExif: auto ? auto[1].toLowerCase() === "true" : true,
    };
  }

  function exifImage(args, content, render, options) {
    const { title, autoExif } = exifArgs(args);
    const { description, path, info } = parseExifBody(content);
    const opts = options || {};
    const src = opts.resolve ? opts.resolve(path) : path;

    const hasInfo = Object.keys(info).length > 0;
    const alt = escapeText(description);

    // Simple mode: a caption, no card. What image-exif.js emits when there is
    // nothing to put in the card.
    if (!hasInfo) {
      const caption =
        (title ? `<strong class="image-exif-title">${escapeText(title)}</strong>` : "") +
        (title && description ? "<br>" : "") +
        (description ? escapeText(description) : "");
      return `
<figure class="image-caption image-exif-simple-container">
  <img src="${escapeText(src)}" alt="${alt}" class="image-exif-img" data-no-img-handle="true" />
  <figcaption>${caption}</figcaption>
</figure>`;
    }

    let sections = "";
    for (const [key, icon, fields] of EXIF_ORDER) {
      const items = fields.filter((f) => info[f]);
      if (!items.length) continue;
      sections +=
        `<div class="image-exif-section image-exif-${key}">` +
        `<div class="image-exif-section-title"><i class="fa-solid ${icon}"></i> ${SECTION_LABELS[key]}</div>` +
        `<div class="image-exif-items">` +
        items
          .map(
            (f) =>
              `<div class="image-exif-item"><span class="image-exif-label">${EXIF_LABELS[f]}</span>` +
              `<span class="image-exif-value">${escapeText(info[f])}</span></div>`
          )
          .join("") +
        `</div></div>`;
    }

    const header =
      `<div class="image-exif-header"><div class="image-exif-header-content">` +
      (title ? `<div class="image-exif-title">${escapeText(title)}</div>` : "") +
      (description ? `<div class="image-exif-description">${escapeText(description)}</div>` : "") +
      `</div><button class="image-exif-toggle-btn" aria-label="Toggle EXIF data">` +
      `<i class="fa-solid fa-chevron-down"></i></button></div>`;

    const layout = opts.float ? "image-exif-float" : "image-exif-block";
    const card = `<div class="image-exif-info-card">${header}<div class="image-exif-data">${sections}</div></div>`;

    return `
<figure class="image-exif-container ${layout}" data-no-img-handle="true" data-auto-exif="${autoExif}">
  <div class="image-exif-image-wrapper">
    <img src="${escapeText(src)}" alt="${alt}" class="image-exif-img" />
  </div>
  ${card}
</figure>`;
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
    EXIF_LABELS,
    splitArgs,
    splitIcon,
    boxColor,
    BOX_COLORS,
    SPEC,
    TAG_INDEX,
  };
});
