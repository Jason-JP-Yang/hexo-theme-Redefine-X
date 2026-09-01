"use strict";

const components = require("../../source/js/tools/components.js");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

const postNoteLarge = (args, content) => components.noteLarge(args, content, render);

hexo.extend.tag.register("noteL", postNoteLarge, { ends: true });
hexo.extend.tag.register("notel", postNoteLarge, { ends: true });
hexo.extend.tag.register("notelarge", postNoteLarge, { ends: true });
hexo.extend.tag.register("notel-large", postNoteLarge, { ends: true });
hexo.extend.tag.register("notes-large", postNoteLarge, { ends: true });
hexo.extend.tag.register("subwarning", postNoteLarge, { ends: true });
