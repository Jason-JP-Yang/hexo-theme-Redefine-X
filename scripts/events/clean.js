const fs = require('fs'), path = require('path');
// The image-optimizer cache is NOT touched here. Rebuilding every AVIF costs
// minutes of CPU, and a clean runs before most builds — it is `npm run
// clean:avif` (bin/clean-avif.js), asked for on purpose or not at all.
hexo.extend.console.register('clean', 'Clean public/db, preserve git', function () {
  const db = this.database.options.path, pub = this.public_dir;
  if (fs.existsSync(db)) fs.unlinkSync(db);
  if (fs.existsSync(pub)) fs.readdirSync(pub).forEach(f =>
    ['.git', '.gitignore'].includes(f) || fs.rmSync(path.join(pub, f), { recursive: true, force: true })
  );
});
