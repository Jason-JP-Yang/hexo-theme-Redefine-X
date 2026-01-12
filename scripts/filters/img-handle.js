hexo.extend.filter.register('after_post_render', function (data) {
    const theme = this.theme && this.theme.config ? this.theme.config : {};
    const articles = theme.articles || {};
    const style = articles.style || {};

    if (style.image_caption === false) return data;

    const class_name = 'image-caption';
    const enableFigureNumber = style.image_figure_number === true;

    if (data.layout === 'post' || data.layout === 'page' || data.layout === 'about') {
        let figureIndex = 0;
        data.content = data.content.replace(
            /(<img\b[^>]*>)/g,
            (fullMatch, imgTag) => {
                figureIndex += 1;

                // extract alt if exists
                const altMatch = imgTag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
                const altText = altMatch ? (altMatch[1] || altMatch[2] || altMatch[3] || '') : null;

                // If no alt and numbering disabled, skip wrapping
                if (!altText && !enableFigureNumber) {
                    return imgTag;
                }

                // Build caption text
                let captionText = '';
                if (enableFigureNumber) {
                    if (altText) {
                        captionText = `<strong>Figure ${figureIndex}.</strong> ${altText}`;
                    } else {
                        // No alt: show plain 'Figure n' (not bold)
                        captionText = `Figure ${figureIndex}`;
                    }
                } else {
                    captionText = altText || '';
                }

                return `<figure class="${class_name}">${imgTag}<figcaption>${captionText}</figcaption></figure>`;
            },
        );
    }

    return data;
});