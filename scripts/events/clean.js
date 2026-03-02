const fs = require('fs'), path = require('path');
hexo.extend.console.register('clean', 'Clean public/db, preserve git', function (args) {
  const db = this.database.options.path, pub = this.public_dir;
  if (fs.existsSync(db)) fs.unlinkSync(db);
  if (fs.existsSync(pub)) fs.readdirSync(pub).forEach(f =>
    ['.git', '.gitignore'].includes(f) || fs.rmSync(path.join(pub, f), { recursive: true, force: true })
  );
  // Handle --include-minify: clean the image optimizer build cache
  if (args && args['include-minify']) {
    const buildDir = path.join(this.source_dir || '', 'build');
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
      this.log.info('[minifier] Cleaned build dir.');
    } catch (e) {
      this.log.warn('[minifier] Failed to clean build dir: ' + e.message);
    }
  } else {
    this.log.info('[minifier] Build cleanup skipped (use --include-minify).');
  }
});
