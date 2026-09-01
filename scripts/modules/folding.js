"use strict";

const components = require("../../source/js/tools/components.js");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

hexo.extend.tag.register(
  "folding",
  (args, content) => components.folding(args, content, render),
  { ends: true }
);
