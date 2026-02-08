hexo.extend.generator.register('masonry_pages', function(locals) {
  const masonryData = locals.data.masonry;
  if (!masonryData) return [];

  const pages = [];

  // 1. Prepare data for the collection page (Links style)
  const collectionData = masonryData.map(category => {
    return {
      ...category,
      list: category.list.map(item => {
        const pageTitle = item['page-title'] || item.name;
        return {
          ...item,
          link: `/masonry/${pageTitle}/`
        };
      })
    };
  });

  // 2. Generate the Collection Page
  pages.push({
    path: 'masonry/links/index.html',
    data: {
      type: 'masonry-links',
      title: '相册列表',
      masonry_items: collectionData,
      layout: 'page',
      comment: false
    },
    layout: 'page'
  });

  // 3. Generate Individual Masonry Pages
  masonryData.forEach(category => {
    category.list.forEach(item => {
        if (item.images && item.images.length > 0) {
            const pageTitle = item['page-title'] || item.name;
            pages.push({
                path: `masonry/${pageTitle}/index.html`,
                data: {
                    type: 'masonry',
                    title: item.name,
                    images: item.images,
                    content: '',
                    layout: 'page',
                    comment: false
                },
                layout: 'page'
            });
        }
    });
  });

  return pages;
});
