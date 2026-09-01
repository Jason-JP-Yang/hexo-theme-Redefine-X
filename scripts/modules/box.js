"use strict";

const components = require("../../source/js/tools/components.js");

hexo.extend.tag.register("box", components.box, { ends: true });
