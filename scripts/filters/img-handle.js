hexo.extend.filter.register('after_post_render', function (data) {
    const theme = this.theme && this.theme.config ? this.theme.config : {};
    const articles = theme.articles || {};
    const style = articles.style || {};

    if (style.image_caption === false) return data;

    const class_name = 'image-caption';
    const enableFigureNumber = style.image_figure_number === true;

    if (data.layout === 'post' || data.layout === 'page' || data.layout === 'about') {
        let figureIndex = 0;
        
        // Use a more sophisticated approach to avoid processing images inside image-exif-container
        // Split content by image-exif-container blocks and only process images outside them
        // Also support image-exif-simple-container for simplified display
        const exifContainerRegex = /(<figure[^>]*class="[^"]*(?:image-exif-container|image-exif-simple-container)[^"]*"[^>]*>[\s\S]*?<\/figure>)/g;
        const parts = data.content.split(exifContainerRegex);
        
        data.content = parts.map((part, index) => {
            // Odd indices are the matched image-exif-container blocks
            if (index % 2 === 1) {
                if (enableFigureNumber) {
                    figureIndex += 1;
                    
                    // Case 1: Has existing title (support any tag, not just div)
                    if (part.includes('class="image-exif-title"')) {
                        return part.replace(
                            /(<[^>]*\bclass="[^"]*image-exif-title[^"]*"[^>]*>)(.*?)(<\/[^>]+>)/, 
                            `$1<strong>Figure ${figureIndex}.</strong> $2$3`
                        );
                    } 
                    // Case 2: No title, insert one (Standard EXIF mode)
                    else if (part.includes('class="image-exif-header-content"')) {
                        return part.replace(
                            /(<div class="image-exif-header-content">)/,
                            `$1<div class="image-exif-title">Figure ${figureIndex}</div>`
                        );
                    }
                    // Case 3: Simple container with only figcaption (Simple mode with only description)
                    else if (part.includes('image-exif-simple-container')) {
                        return part.replace(
                            /(<figcaption>)/,
                            `$1<strong>Figure ${figureIndex}.</strong> `
                        );
                    }
                }
                return part;
            }
            
            // Process images in non-container parts
            return part.replace(
                /(<img\b[^>]*>)/g,
                (fullMatch, imgTag) => {
                    // Skip images that are already inside a figure or have data-no-img-handle
                    if (/data-no-img-handle/i.test(imgTag)) {
                        return imgTag;
                    }
                    
                    // Skip images with class image-exif-img
                    if (/class="[^"]*image-exif-img[^"]*"/i.test(imgTag)) {
                        return imgTag;
                    }
                    
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
        }).join('');
    }

    return data;
}, 15);
