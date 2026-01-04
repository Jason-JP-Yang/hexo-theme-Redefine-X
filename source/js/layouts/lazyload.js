/**
 * Redefine-X Image Preloader - Runtime Phase
 *
 * This module handles image loading with:
 * - IntersectionObserver for viewport detection
 * - XMLHttpRequest for same-origin images
 * - Fallback to img element for cross-origin images
 * - Smooth transition from placeholder to loaded image
 */

const initializedPreloaders = new WeakSet();
let observer = null;

/**
 * Check if URL is cross-origin
 */
function isCrossOrigin(url) {
  try {
    const imgUrl = new URL(url, window.location.href);
    return imgUrl.origin !== window.location.origin;
  } catch {
    return true;
  }
}

/**
 * Load image using img element (works for all origins)
 * @param {string} src - Image URL
 * @returns {Promise<string>} - Resolves with the src when loaded
 */
function loadImageDirect(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(src);
    img.onerror = () => {
      // Retry without crossOrigin for servers that don't support CORS
      const img2 = new Image();
      img2.onload = () => resolve(src);
      img2.onerror = () => reject(new Error("Failed to load image"));
      img2.src = src;
    };
    img.src = src;
  });
}

/**
 * Load same-origin image using XMLHttpRequest and return blob URL
 * @param {string} src - Image URL
 * @returns {Promise<string>} - Resolves with blob URL
 */
function loadImageXHR(src) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", src, true);
    xhr.responseType = "blob";

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blobUrl = URL.createObjectURL(xhr.response);
        resolve(blobUrl);
      } else {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Timeout"));
    xhr.timeout = 30000;
    xhr.send();
  });
}

/**
 * Process a single preloader element
 * @param {HTMLElement} preloader - The .img-preloader div element
 */
async function processPreloader(preloader) {
  if (preloader.dataset.loading === "true" || preloader.dataset.loaded === "true") {
    return;
  }

  preloader.dataset.loading = "true";

  const src = preloader.dataset.src;
  const alt = preloader.dataset.alt || "";
  const width = preloader.dataset.width;
  const height = preloader.dataset.height;
  const crossOrigin = isCrossOrigin(src);

  try {
    // Use XHR for same-origin (blob URL), direct load for cross-origin
    const imageSrc = crossOrigin ? await loadImageDirect(src) : await loadImageXHR(src);

    const img = document.createElement("img");
    img.src = imageSrc;
    img.alt = alt;
    // Store both original URL and current src (blob or original)
    img.dataset.originalSrc = src;
    img.dataset.blobSrc = imageSrc;
    if (width) img.width = parseInt(width, 10);
    if (height) img.height = parseInt(height, 10);

    const originalClasses = Array.from(preloader.classList).filter(
      (cls) => !cls.startsWith("img-preloader")
    );
    if (originalClasses.length > 0) {
      img.className = originalClasses.join(" ");
    }

    img.classList.add("img-preloader-loaded");
    preloader.dataset.loaded = "true";
    preloader.classList.add("img-preloader-fade-out");

    setTimeout(() => {
      if (preloader.parentNode) {
        preloader.parentNode.replaceChild(img, preloader);
      }
      setTimeout(() => URL.revokeObjectURL(imageSrc), 1000);
    }, 200);
  } catch (error) {
    console.error("[img-preloader] Failed:", src, error);

    preloader.classList.add("img-preloader-error");
    const skeleton = preloader.querySelector(".img-preloader-skeleton");
    if (skeleton) {
      skeleton.innerHTML = `
        <i class="fa-solid fa-circle-xmark img-preloader-error-icon"></i>
        <div class="img-preloader-error-text">
          <div class="error-message">Failed to load image</div>
          <div class="error-url">${src}</div>
        </div>
      `;
    }
    preloader.dataset.loading = "false";
  }
}

/**
 * Create IntersectionObserver for lazy loading
 */
function createObserver() {
  if (observer) {
    return observer;
  }

  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const preloader = entry.target;
          observer.unobserve(preloader);
          processPreloader(preloader);
        }
      });
    },
    {
      rootMargin: "50px 0px", // Start loading 50px before entering viewport
      threshold: 0.01,
    }
  );

  return observer;
}

/**
 * Initialize lazy loading for all img-preloader elements
 */
export default function initLazyLoad() {
  const preloaders = document.querySelectorAll(".img-preloader");

  if (preloaders.length === 0) {
    return;
  }

  const obs = createObserver();

  preloaders.forEach((preloader) => {
    // Skip already initialized or loaded preloaders
    if (initializedPreloaders.has(preloader) || preloader.dataset.loaded === "true") {
      return;
    }

    initializedPreloaders.add(preloader);
    obs.observe(preloader);
  });
}

/**
 * Force load all visible preloaders (useful for encrypted content reveal)
 */
export function forceLoadAllPreloaders() {
  const preloaders = document.querySelectorAll(".img-preloader");
  preloaders.forEach((preloader) => {
    if (preloader.dataset.loaded !== "true" && preloader.dataset.loading !== "true") {
      processPreloader(preloader);
    }
  });
}
