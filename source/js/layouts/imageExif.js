/**
 * Image EXIF Info Card - Runtime Handler
 * 
 * Handles responsive layout detection for image-exif containers:
 * 1. Detects if side-by-side layout has enough horizontal space
 * 2. Detects if float overlay card would exceed image height
 * 3. Adds fallback classes when needed
 */

(function() {
  'use strict';

  /**
   * Check if float mode card would overflow the image
   */
  function checkFloatOverflow(container) {
    if (!container.classList.contains('image-exif-float')) return;

    const imageWrapper = container.querySelector('.image-exif-image-wrapper');
    const infoCard = container.querySelector('.image-exif-info-card');
    
    if (!imageWrapper || !infoCard) return;

    // Get image element (could be img or img-preloader)
    const img = imageWrapper.querySelector('img.image-exif-img');
    const preloader = imageWrapper.querySelector('.img-preloader');
    
    let imageHeight = 0;
    
    if (img && img.complete && img.naturalHeight > 0) {
      imageHeight = img.offsetHeight || img.clientHeight;
    } else if (preloader) {
      imageHeight = preloader.offsetHeight || preloader.clientHeight;
    }

    // If image height is 0, wait for load
    if (imageHeight === 0) return;

    // Use clone to measure dimensions without affecting current DOM state (prevents flickering)
    // Clone the info card
    const clone = infoCard.cloneNode(true);
    
    // Clean up clone class and styles for measurement
    clone.classList.remove('expanded');
    
    // Explicitly set styles to match the float mode CSS exactly
    // This is crucial for accurate measurement
    Object.assign(clone.style, {
        display: 'block',
        visibility: 'hidden',
        position: 'absolute',
        top: '0',
        left: '0',
        width: 'max-content', // Allow it to expand naturally first
        maxWidth: '60%',      // But constrain by the same limit as CSS
        height: 'auto',
        maxHeight: 'none',
        overflow: 'visible',  // Allow full expansion
        boxSizing: 'border-box',
        padding: '0.65rem',   // Match CSS padding
        background: 'transparent', // Avoid visual artifacts
        zIndex: '-9999'
    });
    
    // We need to force the data section to be visible in the clone to measure full height
    const cloneData = clone.querySelector('.image-exif-data');
    if (cloneData) {
      Object.assign(cloneData.style, {
          display: 'grid',
          height: 'auto',
          opacity: '1',
          marginTop: '0.6rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.6rem'
      });
    }
    
    // Hide toggle button in clone
    const cloneBtn = clone.querySelector('.image-exif-toggle-btn');
    if (cloneBtn) {
      cloneBtn.style.display = 'none';
    }

    // Append to container to get correct inherited styles (font-size, etc)
    // Important: Append to the image wrapper so it shares the same width context
    imageWrapper.appendChild(clone);
    
    const cardHeight = clone.offsetHeight;
    const scrollHeight = clone.scrollHeight;
    
    // Use the larger of offsetHeight or scrollHeight to be safe
    const finalCardHeight = Math.max(cardHeight, scrollHeight);
    
    imageWrapper.removeChild(clone);

    // Account for padding (12px top + 12px bottom from positioning)
    const availableHeight = imageHeight - 24;
    
    // // Debug logging
    // console.log('[ImageEXIF Debug]', {
    //     imgSrc: img ? img.src.split('/').pop() : 'unknown',
    //     imageHeight,
    //     availableHeight,
    //     measuredHeight: finalCardHeight,
    //     isOverflow: finalCardHeight > availableHeight - 2,
    //     details: {
    //         cardOffset: cardHeight,
    //         cardScroll: scrollHeight
    //     }
    // });

    // If card would exceed available height (minus minimal buffer), add fallback class
    // Reduced buffer from 10px to 2px to be less aggressive about falling back
    if (finalCardHeight > availableHeight - 2) {
      if (!container.classList.contains('image-exif-overflow-fallback')) {
        container.classList.add('image-exif-overflow-fallback');
        // Clear any inline styles that might have been set
        infoCard.style.display = '';
        infoCard.style.visibility = '';
        infoCard.style.opacity = '';
      }
    } else {
      if (container.classList.contains('image-exif-overflow-fallback')) {
        // Prevent transition flashing when switching back to float
        infoCard.style.transition = 'none';
        container.classList.remove('image-exif-overflow-fallback');
        // Force reflow to apply no-transition
        infoCard.offsetHeight;
        // Restore transition
        infoCard.style.transition = '';
      }
    }
  }

  /**
   * Handle toggle button click
   */
  function handleToggle(btn) {
    const card = btn.closest('.image-exif-info-card');
    if (!card) return;
    
    const dataContainer = card.querySelector('.image-exif-data');
    if (!dataContainer) return;
    
    const isExpanded = card.classList.contains('expanded');
    
    if (isExpanded) {
      // Collapse
      // 1. Set explicit height to current scrollHeight (start state)
      dataContainer.style.height = dataContainer.scrollHeight + 'px';
      
      // 2. Force reflow to register start state
      dataContainer.offsetHeight;
      
      // 3. Remove class and animate to 0
      card.classList.remove('expanded');
      dataContainer.style.height = '0';
    } else {
      // Expand
      // 1. Ensure start state is explicitly 0
      dataContainer.style.height = '0px';
      
      // 2. Force reflow to register start state
      dataContainer.offsetHeight;
      
      // 3. Add class (for opacity/margin transitions)
      card.classList.add('expanded');
      
      // 4. Set target height to trigger transition
      dataContainer.style.height = dataContainer.scrollHeight + 'px';
      
      // 5. Clear height after transition to allow auto resizing
      dataContainer.addEventListener('transitionend', function() {
        if (card.classList.contains('expanded')) {
          dataContainer.style.height = 'auto';
        }
      }, { once: true });
    }
  }

  /**
   * Initialize all image-exif containers
   */
  function initImageExif() {
    const containers = document.querySelectorAll('.image-exif-container');
    
    containers.forEach(container => {
      // Setup toggle buttons
      const toggleBtns = container.querySelectorAll('.image-exif-toggle-btn');
      toggleBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent bubbling
          handleToggle(btn);
        });
      });

      // Check float overflow
      checkFloatOverflow(container);

      // Listen for image load to re-check
      const images = container.querySelectorAll('img.image-exif-img');
      images.forEach(img => {
        if (!img.complete) {
          img.addEventListener('load', () => {
            checkFloatOverflow(container);
          });
        }
      });

      // Listen for lazyload completion
      const imageWrapper = container.querySelector('.image-exif-image-wrapper');
      if (imageWrapper && imageWrapper.querySelector('.img-preloader')) {
        // Create a mutation observer to detect when img replaces preloader
        const observer = new MutationObserver((mutations) => {
          mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
              if (node.tagName === 'IMG') {
                if (node.complete) {
                  checkFloatOverflow(container);
                } else {
                  node.addEventListener('load', () => {
                    checkFloatOverflow(container);
                  });
                }
              }
            });
          });
        });
        
        observer.observe(imageWrapper, { childList: true });
      }
    });
  }

  /**
   * Re-check on resize
   */
  function handleResize() {
    const containers = document.querySelectorAll('.image-exif-container.image-exif-float');
    containers.forEach(container => {
      checkFloatOverflow(container);
    });
  }

  // Debounce resize handler
  let resizeTimeout;
  let isChecking = false; // Lock to prevent concurrent checks
  
  function debouncedResize() {
    if (isChecking) return;
    
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (isChecking) return;
      isChecking = true;
      requestAnimationFrame(() => {
        handleResize();
        isChecking = false;
      });
    }, 150);
  }

  // Initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageExif);
  } else {
    initImageExif();
  }

  // Re-initialize on page changes (for SPA/PJAX)
  document.addEventListener('swup:contentReplaced', initImageExif);
  document.addEventListener('pjax:complete', initImageExif);

  // Handle resize
  window.addEventListener('resize', debouncedResize);
  
  // Handle sidebar toggle
  const toggleBar = document.querySelector(".page-aside-toggle");
  if (toggleBar) {
    toggleBar.addEventListener("click", () => {
      // Wait for transition to finish or check periodically
      setTimeout(handleResize, 300); // Standard transition time
    });
  }
})();
