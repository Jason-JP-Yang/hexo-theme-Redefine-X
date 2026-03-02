'use strict';
const htmlminifier = require('html-minifier-terser').minify;
const minimatch = require('minimatch');

async function OptimizeHTML(str, data) {
  const hexo = this;
  const config = hexo.theme.config.plugins?.minifier;

  // Return if disabled.
  if (!config || !config.htmlOptimize) return str;

  const path = data.path;
  // Default exclude
  const exclude = []; 
  
  if (path && exclude.length) {
    for (let i = 0, len = exclude.length; i < len; i++) {
      if (minimatch(path, exclude[i], {matchBase: true})) return str;
    }
  }

  const log = hexo.log || console;
  let result = str;
  
  // Default options
  const options = {
    collapseWhitespace: true,
    removeComments: true,
    removeCommentsFromCDATA: true,
    collapseBooleanAttributes: true,
    removeEmptyAttributes: true,
    minifyJS: true,
    minifyCSS: true,
    ignoreCustomComments: [/^\s*more/]
  };

  try {
    result = await htmlminifier(str, options);
    const optimized = typeof result === 'string' ? result : str;
    const saved = str.length === 0 ? 0 : ((str.length - optimized.length) / str.length * 100).toFixed(2);
    log.info(`[html-optimizer] Optimized: ${path} [${saved}% saved]`);
    return optimized;
  } catch (e) {
    log.warn(`[html-optimizer] Error processing ${path}: ${e}`);
    return str;
  }
}

hexo.extend.filter.register('after_render:html', OptimizeHTML);
