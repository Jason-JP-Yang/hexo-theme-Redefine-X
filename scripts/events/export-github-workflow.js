const fs = require('fs');
const path = require('path');

hexo.extend.filter.register('after_generate', function () {
  // Masonry Reactions Cleanup Workflow
  const themeWorkflow = path.join(
    hexo.theme_dir,
    'workflows',
    'masonry-reactions-cleanup.yml'
  );
  // Static Site Deploy Workflow
  const themeDeployWorkflow = path.join(
    hexo.theme_dir,
    'workflows',
    'static-deploy.yml'
  );

  if (!fs.existsSync(themeWorkflow)) return;
  if (!fs.existsSync(themeDeployWorkflow)) return;

  const destDir = path.join(hexo.public_dir, '.github', 'workflows');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(themeWorkflow, path.join(destDir, 'masonry-reactions-cleanup.yml'));
  fs.copyFileSync(themeDeployWorkflow, path.join(destDir, 'static-deploy.yml'));
});
