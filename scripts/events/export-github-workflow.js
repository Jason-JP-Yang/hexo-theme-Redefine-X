const fs = require('fs');
const path = require('path');

hexo.extend.filter.register('after_generate', function () {
  const themeWorkflow = path.join(
    hexo.theme_dir,
    'workflows',
    'masonry-reactions-cleanup.yml'
  );

  if (!fs.existsSync(themeWorkflow)) return;

  const destDir = path.join(hexo.public_dir, '.github', 'workflows');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(themeWorkflow, path.join(destDir, 'masonry-reactions-cleanup.yml'));
});
