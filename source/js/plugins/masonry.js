export function initMasonry() {
  var loadingPlaceholder = document.querySelector(".loading-placeholder");
  var masonryContainer = document.querySelector("#masonry-container");
  if (!loadingPlaceholder || !masonryContainer) return;

  loadingPlaceholder.style.display = "block";
  masonryContainer.style.display = "none";

  // Get both regular images and preloader divs
  var images = document.querySelectorAll(
    "#masonry-container .masonry-item img",
  );
  var preloaders = document.querySelectorAll(
    "#masonry-container .masonry-item .img-preloader",
  );
  
  var totalCount = images.length + preloaders.length;
  var loadedCount = 0;

  function onItemReady() {
    loadedCount++;
    if (loadedCount === totalCount) {
      initializeMasonryLayout();
    }
  }

  // Handle regular images
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if (img.complete) {
      onItemReady();
    } else {
      img.addEventListener("load", onItemReady);
      img.addEventListener("error", onItemReady); // Also count errors to prevent blocking
    }
  }

  // Handle preloaders - force load them and wait
  if (preloaders.length > 0) {
    import("../layouts/lazyload.js").then((module) => {
      preloaders.forEach((preloader) => {
        // If already loaded, count it
        if (preloader.dataset.loaded === "true" || preloader.tagName === "IMG") {
          onItemReady();
        } else {
          // Set up observer for when it gets replaced with an image
          const observer = new MutationObserver((mutations, obs) => {
            mutations.forEach((mutation) => {
              mutation.addedNodes.forEach((node) => {
                if (node.tagName === "IMG") {
                  if (node.complete) {
                    onItemReady();
                  } else {
                    node.addEventListener("load", onItemReady);
                    node.addEventListener("error", onItemReady);
                  }
                  obs.disconnect();
                }
              });
            });
          });
          
          observer.observe(preloader.parentNode, { childList: true });
          
          // Force trigger the preloader to load
          if (module.forceLoadAllPreloaders) {
            module.forceLoadAllPreloaders();
          }
        }
      });
    }).catch(() => {
      // Fallback: just count all preloaders as ready
      preloaders.forEach(() => onItemReady());
    });
  }

  // Handle case where there are no items
  if (totalCount === 0) {
    initializeMasonryLayout();
  } else if (loadedCount === totalCount) {
    initializeMasonryLayout();
  }

  function initializeMasonryLayout() {
    loadingPlaceholder.style.opacity = 0;
    setTimeout(() => {
      loadingPlaceholder.style.display = "none";
      masonryContainer.style.display = "block";
      var screenWidth = window.innerWidth;
      var baseWidth;
      if (screenWidth >= 768) {
        baseWidth = 255;
      } else {
        baseWidth = 150;
      }
      var masonry = new MiniMasonry({
        baseWidth: baseWidth,
        container: masonryContainer,
        gutterX: 10,
        gutterY: 10,
        surroundingGutter: false,
      });
      masonry.layout();
      masonryContainer.style.opacity = 1;
    }, 100);
  }
}

if (data.masonry) {
  try {
    swup.hooks.on("page:view", initMasonry);
  } catch (e) {}

  document.addEventListener("DOMContentLoaded", initMasonry);
}
