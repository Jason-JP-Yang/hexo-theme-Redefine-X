"use strict";

const components = require("../../source/js/tools/components.js");

const render = (text) => hexo.render.renderSync({ text, engine: "markdown" });

const postNote = (args, content) => components.note(args, content, render);

hexo.extend.tag.register("note", postNote, { ends: true });
hexo.extend.tag.register("notes", postNote, { ends: true });
hexo.extend.tag.register("subnote", postNote, { ends: true });
