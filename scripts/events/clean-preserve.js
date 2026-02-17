const fs = require('fs'), path = require('path');
hexo.extend.console.register('clean', 'Clean public/db, preserve git', function() {
  const db = this.database.options.path, pub = this.public_dir;
  if (fs.existsSync(db)) fs.unlinkSync(db);
  if (fs.existsSync(pub)) fs.readdirSync(pub).forEach(f => 
    ['.git', '.gitignore'].includes(f) || fs.rmSync(path.join(pub, f), { recursive: true, force: true })
  );
});
