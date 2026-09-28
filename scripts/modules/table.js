"use strict";

const components = require("../../source/js/tools/components.js");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

hexo.extend.tag.register("table", (args, content) => components.table(args, content, render), { ends: true });
