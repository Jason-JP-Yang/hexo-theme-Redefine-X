/* main hexo */

"use strict";

const url = require("url");
const { version } = require("../../package.json");
const themeVersion = version;

hexo.extend.helper.register("isHomePagePagination", function (pagePath, route) {
  if (pagePath.length > 5 && route === "/") {
    return pagePath.slice(0, 5) === "page/";
  }

  return false;
});

/* code block language display */
hexo.extend.filter.register("after_post_render", function (data) {
  // Only process if not already processed
  if (data._processedHighlight) return data;
  
  // Updated pattern to include numbers and other special characters
  const pattern = /<figure class="highlight ([^"]+)">([\s\S]*?)<\/figure>/g;
  data.content = data.content.replace(pattern, function (match, p1, p2) {
    // If already has code-container anywhere in the match, return unchanged
    if (match.includes('code-container')) {
      return match;
    }

    let language = p1 || "code";
    if (language === "plain") {
      language = "code";
    }

    return '<div class="code-container" data-rel="' +
      language.charAt(0).toUpperCase() +
      language.slice(1) +
      '">' +
      match.replace(
        '<figure class="highlight ',
        '<figure class="iseeu highlight '
      ) +
      "</div>";
  });

  // Mark as processed
  data._processedHighlight = true;
  return data;
});

hexo.extend.helper.register("createNewArchivePosts", function (posts) {
  const postList = [],
    postYearList = [];
  posts.forEach((post) => postYearList.push(post.date.year()));
  Array.from(new Set(postYearList)).forEach((year) => {
    postList.push({
      year: year,
      postList: [],
    });
  });
  postList.sort((a, b) => b.year - a.year);
  postList.forEach((item) => {
    posts.forEach(
      (post) => item.year === post.date.year() && item.postList.push(post),
    );
  });
  postList.forEach((item) =>
    item.postList.sort((a, b) => b.date.unix() - a.date.unix()),
  );
  return postList;
});

hexo.extend.helper.register(
  "getAuthorLabel",
  function (postCount, isAuto, labelList) {
    let level = Math.floor(Math.log2(postCount));
    level = level < 2 ? 1 : level - 1;

    if (isAuto === false && Array.isArray(labelList) && labelList.length > 0) {
      return level > labelList.length
        ? labelList[labelList.length - 1]
        : labelList[level - 1];
    } else {
      return `Lv${level}`;
    }
  },
);

hexo.extend.helper.register("getPostUrl", function (rootUrl, path) {
  if (rootUrl) {
    let { href } = new URL(rootUrl);
    if (href.substring(href.length - 1) !== "/") {
      href = href + "/";
    }
    return href + path;
  } else {
    return path;
  }
});

hexo.extend.helper.register("renderJS", function (path, options = {}) {
  const _js = hexo.extend.helper.get("js").bind(hexo);
  const { module = false, async = false, swupReload = false } = options;

  if (Array.isArray(path)) {
    path = path.map((p) => "js/build/" + p);
  } else {
    path = "js/build/" + path;
  }

  const cdnProviders = {
    jsdelivr:
      "https://cdn.jsdelivr.net/npm/hexo-theme-redefine-x@:version/source/:path",
    unpkg: "https://unpkg.com/hexo-theme-redefine-x@:version/source/:path",
    cdnjs:
      "https://cdnjs.cloudflare.com/ajax/libs/hexo-theme-redefine-x/:version/source/:path",
    zstatic:
      "https://s4.zstatic.net/ajax/libs/hexo-theme-redefine-x/:version/source/:path",
    npmmirror:
      "https://registry.npmmirror.com/hexo-theme-redefine-x/:version/files/source/:path",
    custom: this.theme.cdn.custom_url,
  };

  const cdnPathHandle = (path) => {
    const cdnBase =
      cdnProviders[this.theme.cdn.provider] || cdnProviders.jsdelivr;
    let scriptTag;

    const typeAttr = module ? 'type="module"' : "";
    // const asyncAttr = async ? "async" : "";
    const swupAttr = swupReload ? "data-swup-reload-script" : "";

    if (this.theme.cdn.enable) {
      if (this.theme.cdn.provider === "custom") {
        const customUrl = cdnBase
          .replace(":version", themeVersion)
          .replace(":path", path);
        scriptTag = `<script ${typeAttr} src="${
          this.theme.cdn.enable ? customUrl : _js({ src: path })
        }" ${swupAttr}></script>`;
      } else {
        scriptTag = `<script ${typeAttr} src="${cdnBase
          .replace(":version", themeVersion)
          .replace(":path", path)}" ${swupAttr}></script>`;
      }
    } else {
      scriptTag = _js({
        src: path,
        type: module ? "module" : undefined,
        "data-swup-reload-script": swupReload ? "" : undefined,
        // async: async,
      });
    }

    return scriptTag;
  };

  let renderedScripts = "";

  if (Array.isArray(path)) {
    renderedScripts = path.map(cdnPathHandle).join("");
  } else {
    renderedScripts = cdnPathHandle(path);
  }

  return renderedScripts;
});

hexo.extend.helper.register("renderCSS", function (path) {
  const _css = hexo.extend.helper.get("css").bind(hexo);

  const cdnProviders = {
    jsdelivr:
      "https://cdn.jsdelivr.net/npm/hexo-theme-redefine-x@:version/source/:path",
    unpkg: "https://unpkg.com/hexo-theme-redefine-x@:version/source/:path",
    cdnjs:
      "https://cdnjs.cloudflare.com/ajax/libs/hexo-theme-redefine-x/:version/source/:path",
    zstatic:
      "https://s4.zstatic.net/ajax/libs/hexo-theme-redefine-x/:version/source/:path",
    npmmirror:
      "https://registry.npmmirror.com/hexo-theme-redefine-x/:version/files/source/:path",
    custom: this.theme.cdn.custom_url,
  };

  const cdnPathHandle = (path) => {
    const cdnBase =
      cdnProviders[this.theme.cdn.provider] || cdnProviders.jsdelivr;
    let cssLink;

    if (this.theme.cdn.enable) {
      if (this.theme.cdn.provider === "custom") {
        const customUrl = cdnBase
          .replace(":version", themeVersion)
          .replace(":path", path);
        cssLink = `<link rel="stylesheet" href="${customUrl}">`;
      } else {
        cssLink = `<link rel="stylesheet" href="${cdnBase
          .replace(":version", themeVersion)
          .replace(":path", path)}">`;
      }
    } else {
      cssLink = _css(path);
    }

    return cssLink;
  };

  if (Array.isArray(path)) {
    return path.map(cdnPathHandle).join("");
  } else {
    return cdnPathHandle(path);
  }
});

hexo.extend.helper.register("getThemeVersion", function () {
  return themeVersion;
});

hexo.extend.helper.register("checkDeprecation", function (condition, id, message) {
  if (condition) {
    // Use Set to ensure each warning is only logged once per Hexo process
    if (!global.deprecationWarnings) {
      global.deprecationWarnings = new Set();
    }
    
    if (!global.deprecationWarnings.has(id)) {
      hexo.log.warn(`${message}`);
      global.deprecationWarnings.add(id);
    }
    return true;
  }
  return false;
});

/** The build clock as a Date, for templates. See scripts/lib/build-clock.js. */
hexo.extend.helper.register("buildDate", function () {
  return require("../lib/build-clock").date();
});

/** `backend:` as it is actually switched on — see scripts/lib/backend.js. */
hexo.extend.helper.register("backend_config", function () {
  return require("../lib/backend").resolve(this.theme || hexo.theme.config);
});

/**
 * `contributor:` as a list of ids, however it was spelled.
 *
 * Front matter gives a YAML list, masonry.yml gives one comma-separated scalar
 * (its writer only emits scalars), and a single id may arrive bare. All three
 * mean the same thing, and the id is compared as TEXT — it is a GitHub numeric
 * id, which YAML would otherwise hand over as a number here and a string there.
 */
function contributorIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    for (const part of String(item == null ? "" : item).split(",")) {
      const id = part.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** The roster, by id — resolved once per build. */
let roster = null;

function rosterOf(theme) {
  if (!roster) {
    roster = new Map();
    for (const row of require("../lib/backend").resolve(theme).collaborators) {
      roster.set(row.id, row);
    }
  }
  return roster;
}

/**
 * Who, besides the site author, worked on this post or album.
 *
 * An id with no complete roster entry renders NOTHING — a contributor whose
 * config was half-filled is a nameless face beside the author, and a blank chip
 * says less than no chip at all. Publicly this emits only a name and an avatar;
 * see scripts/lib/backend.js for why the rest stays sealed.
 */
hexo.extend.helper.register("contributorsOf", function (item) {
  const known = rosterOf(this.theme || hexo.theme.config);
  if (!known.size || !item) return [];
  return contributorIds(item.contributor)
    .map((id) => known.get(id))
    .filter(Boolean);
});

/**
 * What each collaborator has actually contributed to, counted off the posts.
 *
 * Posts, and the tags and categories those posts carry — the same three numbers
 * the site card already shows for the blog as a whole, so the card can page
 * between them without a second vocabulary. A collaborator with nothing to their
 * name is left out entirely rather than shown as three zeroes.
 *
 * Counted from `locals.posts`, which the vault filter has already withheld from,
 * so a contribution that exists only on an encrypted or draft post is not
 * announced on the home page.
 */
let contributions = null;

hexo.extend.helper.register("collaboratorContributions", function () {
  if (contributions) return contributions;

  const known = rosterOf(this.theme || hexo.theme.config);
  const tally = new Map();
  for (const row of known.values()) {
    tally.set(row.id, { ...row, posts: 0, tags: new Set(), categories: new Set() });
  }

  if (tally.size) {
    this.site.posts.forEach((post) => {
      for (const id of contributorIds(post.contributor)) {
        const row = tally.get(id);
        if (!row) continue;
        row.posts += 1;
        // Guarded: the vault filter empties a withheld post's taxonomy in
        // place, and a post whose tags were taken away has none to read.
        if (post.tags) post.tags.forEach((tag) => row.tags.add(tag.name));
        if (post.categories) post.categories.forEach((c) => row.categories.add(c.name));
      }
    });
  }

  contributions = [...tally.values()]
    .filter((row) => row.posts > 0)
    .map((row) => ({ ...row, tags: row.tags.size, categories: row.categories.size }));
  return contributions;
});

/**
 * The activity card's numbers, for the page to carry.
 *
 * `source/_data/analytics.json` is the whole archive and grows forever; the page
 * gets only the tail a calendar could draw, as a start date and a dense run of
 * counts. Returns "" when there is nothing stored — which is also what decides
 * whether the card is placed at all.
 */
let pulseJSON = null;

hexo.extend.helper.register("pulseSeries", function () {
  if (pulseJSON !== null) return pulseJSON;
  const { sealed } = require("../lib/analytics-archive");
  const data = hexo.locals.get("data") || {};
  const out = sealed(data.analytics);
  pulseJSON = out ? JSON.stringify(out) : "";
  return pulseJSON;
});

hexo.extend.helper.register("configOptions", function (obj, indent = '  ') {
  if (!obj || typeof obj !== 'object') return '';
  
  return Object.entries(obj)
    .filter(([key, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${indent}${key}: '${value}',`;
      }
      return `${indent}${key}: ${value},`;
    })
    .join('\n');
});
