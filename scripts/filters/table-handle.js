"use strict";

/**
 * A markdown table, in the frame `{% table %}` is published in.
 *
 * The frame is what lets a table that is too full for its column scroll inside
 * itself with the site's fades instead of pushing the page sideways — see
 * layouts/tableFit.js — so a table written in plain markdown gets it too. A
 * code listing is also a `<table>` (line numbers beside the code) and is left
 * alone, as is anything already inside a frame.
 */
hexo.extend.filter.register("after_post_render", function (data) {
  if (!data.content || data.content.indexOf("<table") < 0) return data;

  data.content = data.content.replace(/<table>([\s\S]*?)<\/table>/g, (match, inner, at, all) => {
    if (/class="(?:gutter|code)"/.test(inner)) return match;
    if (/<div class="table-scroll">\s*$/.test(all.slice(Math.max(0, at - 40), at))) return match;
    return `<div class="table-container" data-table><div class="table-scroll">${match}</div></div>`;
  });
  return data;
});
