"use strict";

const components = require("../../source/js/tools/components.js");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

const postTabs = (args, content) =>
  components.tabs(args, content, render, { warn: (m) => hexo.log.warn(m) });

hexo.extend.tag.register("tabs", postTabs, { ends: true });
hexo.extend.tag.register("subtabs", postTabs, { ends: true });
hexo.extend.tag.register("subsubtabs", postTabs, { ends: true });
