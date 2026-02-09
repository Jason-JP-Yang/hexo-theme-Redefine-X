hexo.extend.generator.register('masonry_pages', function(locals) {
  const masonryData = locals.data.masonry;
  if (!masonryData) return [];

  // Extract custom title if present
  let collectionTitle = 'Masonry Collection 瀑布流相册合集';
  const configItem = masonryData.find(item => item.title && !item.links_category);
  if (configItem) {
    collectionTitle = configItem.title;
  }

  // Filter out the config item to get only categories
  const categories = masonryData.filter(item => item.links_category);

  const pages = [];

  // 1. Prepare data for the collection page (Links style)
  const collectionData = categories.map(category => {
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
      title: collectionTitle,
      masonry_items: collectionData,
      layout: 'page',
      comment: false
    },
    layout: 'page'
  });

  // 3. Generate Individual Masonry Pages
  categories.forEach(category => {
    category.list.forEach(item => {
        if (item.images && item.images.length > 0) {
            const pageTitle = item['page-title'] || item.name;
            pages.push({
                path: `masonry/${pageTitle}/index.html`,
                data: {
                    type: 'masonry',
                    title: item['page-title'] || item.name,
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
