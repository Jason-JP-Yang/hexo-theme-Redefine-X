'use strict';

const UglifyJS = require('uglify-js');
const minimatch = require('minimatch');

hexo.extend.filter.register('after_generate', function() {
  const hexo = this;
  const minifierConfig = hexo.theme.config.plugins?.minifier;

  // Return if disabled.
  if (!minifierConfig || !minifierConfig.jsOptimize) return;

  const route = hexo.route;
  const list = route.list();
  const exclude = ['*.min.js'];
  const log = hexo.log || console;

  // Filter JS files
  const jsFiles = list.filter(path => {
      if (!path.endsWith('.js')) return false;
      // Check excludes
      for (let i = 0; i < exclude.length; i++) {
        if (minimatch(path, exclude[i], {matchBase: true})) return false;
      }
      return true;
  });

  return Promise.all(jsFiles.map(path => {
    return new Promise((resolve, reject) => {
      const stream = route.get(path);
      let str = '';
      // Handle different stream types or string
      if (typeof stream === 'string') {
          str = stream;
          processStr(str, path, resolve);
      } else if (stream && typeof stream.on === 'function') {
          stream.on('data', chunk => str += chunk);
          stream.on('end', () => processStr(str, path, resolve));
      } else if (typeof stream === 'function') {
          // It might be a function returning a stream or data
          const res = stream();
          if (typeof res === 'string') {
              processStr(res, path, resolve);
          } else if (res && typeof res.on === 'function') {
              res.on('data', chunk => str += chunk);
              res.on('end', () => processStr(str, path, resolve));
          } else {
              resolve(); // Unknown format
          }
      } else {
          resolve();
      }
    });
  }));

  function processStr(str, path, resolve) {
    const minifyOptions = {
        mangle: true,
        compress: {},
        output: {}
    };
    
    try {
        const result = UglifyJS.minify(str, minifyOptions);
        if (result.code) {
            const saved = ((str.length - result.code.length) / str.length * 100).toFixed(2);
            log.info(`[minifier] Optimized: ${path} [${saved}% saved]`);
            route.set(path, result.code);
        } else if (result.error) {
            log.warn(`[minifier] Cannot minify ${path}: ${result.error}`);
        }
    } catch (err) {
        log.warn(`[minifier] Error processing ${path}: ${err.message}`);
    }
    resolve();
  }
});
