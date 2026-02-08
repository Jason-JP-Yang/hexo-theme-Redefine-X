'use strict';
const CleanCSS = require('clean-css');
const minimatch = require('minimatch');

hexo.extend.filter.register('after_generate', function() {
  const hexo = this;
  const config = hexo.theme.config.plugins?.minifier;

  // Return if disabled.
  if (!config || !config.cssOptimize) return;

  const route = hexo.route;
  const list = route.list();
  const exclude = ['*.min.css'];
  const log = hexo.log || console;

  // Filter CSS files
  const cssFiles = list.filter(path => {
      if (!path.endsWith('.css')) return false;
      // Check excludes
      for (let i = 0; i < exclude.length; i++) {
        if (minimatch(path, exclude[i], {matchBase: true})) return false;
      }
      return true;
  });

  return Promise.all(cssFiles.map(path => {
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
          const res = stream();
          if (typeof res === 'string') {
              processStr(res, path, resolve);
          } else if (res && typeof res.on === 'function') {
              res.on('data', chunk => str += chunk);
              res.on('end', () => processStr(str, path, resolve));
          } else {
              resolve(); 
          }
      } else {
          resolve();
      }
    });
  }));

  function processStr(str, path, resolve) {
    try {
        const options = {
            level: 2
        };
        const result = new CleanCSS(options).minify(str);

        if (result.warnings.length) {
            result.warnings.forEach(warning => log.warn(`[css-optimizer] Warning ${path}: ${warning}`));
        }
        
        if (result.errors.length) {
            result.errors.forEach(error => log.error(`[css-optimizer] Error ${path}: ${error}`));
        } else {
            const saved = ((str.length - result.styles.length) / str.length * 100).toFixed(2);
            log.info(`[css-optimizer] Optimized: ${path} [${saved}% saved]`);
            route.set(path, result.styles);
        }
    } catch (err) {
        log.warn(`[css-optimizer] Error processing ${path}: ${err}`);
    }
    resolve();
  }
});
