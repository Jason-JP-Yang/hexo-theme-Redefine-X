import { requestImageBySrc, transformPreloaderToImage, loadedPreloaders } from "../layouts/lazyload.js";

export default function imageViewer() {
  const global = window.__REDEFINE_X_IMAGE_VIEWER__ || (window.__REDEFINE_X_IMAGE_VIEWER__ = {
    docBound: false, maskEl: null, stageEl: null, handlers: {}, api: null
  });

  const maskDom = document.querySelector(".image-viewer-container");
  const stage = maskDom?.querySelector(".image-viewer-stage");
  const switcher = maskDom?.querySelector(".image-viewer-switcher");
  const switcherPages = switcher?.querySelector(".image-viewer-switcher-pages");
  const switcherPrev = switcher?.querySelector(".image-viewer-switcher-btn.prev");
  const switcherNext = switcher?.querySelector(".image-viewer-switcher-btn.next");
  const switcherSidePrev = maskDom?.querySelector(".image-viewer-switcher-side.prev");
  const switcherSideNext = maskDom?.querySelector(".image-viewer-switcher-side.next");
  if (!maskDom || !stage || !switcher || !switcherPages || !switcherPrev || !switcherNext || !switcherSidePrev || !switcherSideNext) return;

  const VIEWABLE_IMG_SELECTOR = ".markdown-body img, .masonry-item img, #shuoshuo-content img";
  const VIEWABLE_ITEM_SELECTOR = ".markdown-body img, .markdown-body .img-preloader, .masonry-item img, .masonry-item .img-preloader, #shuoshuo-content img, #shuoshuo-content .img-preloader";
  const OPEN_MS = 420, CLOSE_MS = 360, EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const measureViewerFrame = () => {
    const probe = document.createElement("img");
    probe.alt = "";
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    probe.style.top = "-9999px";
    stage.appendChild(probe);
    const cs = getComputedStyle(probe);
    const frame = {
      padding: cs.padding,
      backgroundColor: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      borderRadius: cs.borderRadius
    };
    probe.remove();
    return frame;
  };

  const measureViewerPreloaderFrame = () => {
    const pre = document.createElement("div");
    pre.className = "img-preloader image-viewer-img-preloader";
    pre.style.position = "fixed";
    pre.style.left = "-9999px";
    pre.style.top = "-9999px";
    pre.style.width = "200px";
    pre.style.height = "120px";
    pre.innerHTML = `<div class="img-preloader-skeleton"></div>`;
    stage.appendChild(pre);
    const cs = getComputedStyle(pre);
    const frame = {
      padding: cs.padding,
      backgroundColor: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      borderRadius: cs.borderRadius
    };
    pre.remove();
    return frame;
  };

  const VIEWER_FRAME_IMG = measureViewerFrame();
  const VIEWER_FRAME_PRELOADER = measureViewerPreloaderFrame();
  const VIEWER_DECORATION = { padding: VIEWER_FRAME_IMG.padding, backgroundColor: VIEWER_FRAME_IMG.backgroundColor, boxShadow: VIEWER_FRAME_IMG.boxShadow };

  const nextFrame = () => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  /**
   * Hide fixed elements (side-tools, aplayer) during viewer open.
   * Show them after viewer close with a delay.
   */
  const FIXED_ELEMENTS_SELECTOR = ".right-side-tools-container, .aplayer.aplayer-fixed";
  let showFixedElementsTimer = null;
  const shouldHideFixedElements = () =>
    window.matchMedia && window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;

  const hideFixedElements = () => {
    if (showFixedElementsTimer) {
      clearTimeout(showFixedElementsTimer);
      showFixedElementsTimer = null;
    }
    document.querySelectorAll(FIXED_ELEMENTS_SELECTOR).forEach(el => {
      el.classList.add("hide");
    });
  };

  const showFixedElements = (delay = 300) => {
    showFixedElementsTimer = setTimeout(() => {
      document.querySelectorAll(FIXED_ELEMENTS_SELECTOR).forEach(el => {
        el.classList.remove("hide");
      });
      showFixedElementsTimer = null;
    }, delay);
  };

  const isViewableImg = (img) => img && !img.closest(".image-viewer-container") && !img.hasAttribute("data-no-viewer");
  const isViewablePreloader = (el) => el && !el.closest(".image-viewer-container") && el.classList.contains("img-preloader");

  const toAbsUrl = (src) => {
    try { return new URL(src, window.location.href).href; } catch { return String(src || ""); }
  };

  const getContextRoot = (node) => {
    if (!node) return document;
    const markdown = node.closest?.(".markdown-body");
    if (markdown) return markdown;
    const shuoshuo = node.closest?.("#shuoshuo-content");
    if (shuoshuo) return shuoshuo;
    const masonryItem = node.closest?.(".masonry-item");
    if (masonryItem) return masonryItem.parentElement || document;
    return document;
  };

  const collectItems = (root) => {
    const nodes = Array.from((root || document).querySelectorAll(VIEWABLE_ITEM_SELECTOR));
    const items = [];
    nodes.forEach((node) => {
      if (node instanceof HTMLImageElement) {
        if (!isViewableImg(node)) return;
        const src = node.dataset.originalSrc || node.currentSrc || node.src;
        items.push({
          kind: "img",
          node,
          src: String(src || ""),
          absSrc: toAbsUrl(src),
          alt: node.alt || "",
          width: node.naturalWidth || 0,
          height: node.naturalHeight || 0
        });
        return;
      }
      if (node instanceof HTMLElement && isViewablePreloader(node)) {
        if (node.classList.contains("img-preloader-error")) return;
        const src = node.dataset.src;
        if (!src) return;
        const w = Number(node.dataset.width || 0);
        const h = Number(node.dataset.height || 0);
        items.push({
          kind: "preloader",
          node,
          src: String(src),
          absSrc: toAbsUrl(src),
          alt: node.dataset.alt || "",
          width: Number.isFinite(w) ? w : 0,
          height: Number.isFinite(h) ? h : 0
        });
      }
    });
    return items;
  };

  const findItemIndexByNodeOrSrc = (items, node) => {
    const directIndex = items.findIndex(it => it.node === node);
    if (directIndex >= 0) return directIndex;
    if (node instanceof HTMLImageElement) {
      const src = node.dataset.originalSrc || node.currentSrc || node.src;
      const abs = toAbsUrl(src);
      return items.findIndex(it => it.absSrc === abs);
    }
    const pre = node?.closest?.(".img-preloader");
    if (pre instanceof HTMLElement) {
      const src = pre.dataset.src;
      const abs = toAbsUrl(src);
      return items.findIndex(it => it.absSrc === abs);
    }
    return -1;
  };

  const state = {
    isOpen: false, isAnimating: false, currentIndex: -1, items: [], contextRoot: null,
    activeImg: null, activeEl: null,
    articleOriginalNode: null, placeholder: null, saved: null,
    switcherShowTimer: null,
    scale: 1, translateX: 0, translateY: 0, isDragging: false,
    dragStartX: 0, dragStartY: 0, pointers: new Map(), pinchStart: null,
    fixedHidden: false
  };

  const applyTransform = () => state.activeImg && 
    (state.activeImg.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`);

  const constrainVisible = () => {
    if (!state.activeImg) return;
    const sr = stage.getBoundingClientRect(), ir = state.activeImg.getBoundingClientRect();
    const minW = ir.width * 0.1, minH = ir.height * 0.1;
    if (ir.right < sr.left + minW) state.translateX += sr.left + minW - ir.right;
    else if (ir.left > sr.right - minW) state.translateX += sr.right - minW - ir.left;
    if (ir.bottom < sr.top + minH) state.translateY += sr.top + minH - ir.bottom;
    else if (ir.top > sr.bottom - minH) state.translateY += sr.bottom - minH - ir.top;
    applyTransform();
  };

  /**
   * Compute the target rect for the image in viewer (centered, fit within stage rect)
   * This calculates the border-box dimensions including padding (2px as per CSS)
   */
  const VIEWER_PADDING = 2; // Must match CSS .image-viewer-stage img padding
  const getViewerContentRect = () => {
    const mr = maskDom.getBoundingClientRect();
    const cs = getComputedStyle(maskDom);
    const pl = parseFloat(cs.paddingLeft || "0") || 0;
    const pr = parseFloat(cs.paddingRight || "0") || 0;
    const pt = parseFloat(cs.paddingTop || "0") || 0;
    const pb = parseFloat(cs.paddingBottom || "0") || 0;
    return {
      left: mr.left + pl,
      top: mr.top + pt,
      width: Math.max(0, mr.width - pl - pr),
      height: Math.max(0, mr.height - pt - pb)
    };
  };
  const computeViewerRect = (img) => {
    const vr = getViewerContentRect();
    const maxW = vr.width, maxH = vr.height;
    // Calculate content area (excluding padding on both sides)
    const contentMaxW = maxW - VIEWER_PADDING * 2;
    const contentMaxH = maxH - VIEWER_PADDING * 2;
    const ar = (img.naturalWidth || 1) / (img.naturalHeight || 1);
    // Fit content within available space
    let contentW = contentMaxW, contentH = contentW / ar;
    if (contentH > contentMaxH) { contentH = contentMaxH; contentW = contentH * ar; }
    // Add padding back to get border-box dimensions
    const width = contentW + VIEWER_PADDING * 2;
    const height = contentH + VIEWER_PADDING * 2;
    return { left: vr.left + (vr.width - width) / 2, top: vr.top + (vr.height - height) / 2, width, height };
  };

  /**
   * Get the precise visual bounding rect of an image in the article.
   * This accounts for any CSS transforms, margins, borders, and padding.
   */
  const getArticleImgRect = (img) => {
    const rect = img.getBoundingClientRect();
    // getBoundingClientRect returns the border-box including CSS transforms
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  /**
   * Create a placeholder that exactly matches the image's layout footprint
   * to prevent any content shift when the image is removed from flow.
   * The placeholder uses aspect-ratio to maintain responsive behavior like the original img.
   */
  const createPlaceholder = (img, saved) => {
    const ph = document.createElement("span");
    ph.className = "image-viewer-placeholder";
    const cs = getComputedStyle(img);
    // Use aspect-ratio to maintain responsive sizing like the original img
    // This ensures placeholder resizes correctly if viewport changes
    const aspectRatio = (img.naturalWidth || 1) / (img.naturalHeight || 1);
    ph.style.cssText = `
      display:${cs.display};
      width:${cs.width};
      max-width:${cs.maxWidth};
      max-height:${cs.maxHeight};
      height:auto;
      aspect-ratio:${aspectRatio};
      margin:${cs.margin};
      padding:0;
      border:none;
      visibility:hidden;
      box-sizing:border-box;
    `;
    return ph;
  };

  /**
   * Save all original image state before any DOM manipulation.
   * This includes position, styles, and DOM location.
   */
  const saveOriginal = (img) => {
    const cs = getComputedStyle(img);
    const rect = getArticleImgRect(img);
    return {
      parent: img.parentNode,
      nextSibling: img.nextSibling,
      styleAttr: img.getAttribute("style"),
      // CSS properties to restore/animate
      borderRadius: cs.borderRadius,
      padding: cs.padding,
      backgroundColor: cs.backgroundColor,
      boxShadow: cs.boxShadow,
      // The exact visual rect at save time
      rect: rect
    };
  };

  /**
   * Restore original inline styles to the image.
   */
  const restoreOriginal = (img, savedOverride) => {
    const saved = savedOverride || state.saved;
    if (!saved) return;
    if (saved.styleAttr == null) {
      img.removeAttribute("style");
    } else {
      img.setAttribute("style", saved.styleAttr);
    }
    img.classList.remove("img-preloader-loaded");
    img.style.animation = "";
  };

  /**
   * Set up the image for flight animation with position:fixed.
   * 
   * @param {HTMLImageElement} img - The image element
   * @param {Object} targetRect - Where the image should end up (content dimensions)
   * @param {Object} fromRect - Where the image starts (content dimensions)
   * @param {Object} decoration - CSS decoration properties
   * @param {string} borderRadius - Border radius value
   * @param {HTMLElement} container - Container to append to
   * @param {number} zIndex - z-index value for layering control
   */
  // z-index for open animation: must be above image-viewer-container (z-index: 1008)
  // so the flying image is not affected by backdrop-filter blur
  const FLIGHT_Z_OPEN = 1009;
  // Close-layer order requirement:
  // navbar (1005) > flying image (1004) > blur mask (1003) > article
  // This keeps the image unblurred while staying under the navbar.
  const FLIGHT_Z_CLOSE = 1004;
  const MASK_Z_CLOSE = 1003;

  const setFlightStyles = (img, targetRect, fromRect, decoration, borderRadius, container, zIndex) => {
    // Calculate the transform to go from target position to from position
    // This allows us to animate from current to target by removing the transform
    const dx = fromRect.left - targetRect.left;
    const dy = fromRect.top - targetRect.top;
    const sx = fromRect.width / targetRect.width;
    const sy = fromRect.height / targetRect.height;
    
    // Build the initial style (at from position via transform)
    // IMPORTANT: When scaling (sx, sy), the border-radius/shadow/border will also be scaled visually.
    // However, since we are using transform scale, the actual CSS values should be the TARGET values.
    // The browser will visually scale them down to match the start state.
    // So we set the target border-radius/shadow here.
    
    img.style.cssText = `
      position:fixed;
      left:${targetRect.left}px;
      top:${targetRect.top}px;
      width:${targetRect.width}px;
      height:${targetRect.height}px;
      border-radius:${borderRadius || "0"};
      clip-path: inset(0 round ${borderRadius || "0"});
      -webkit-clip-path: inset(0 round ${borderRadius || "0"});
      box-sizing:border-box;
      overflow:hidden;
      padding:${decoration?.padding ?? "0"};
      background-color:${decoration?.backgroundColor ?? "transparent"};
      box-shadow:${decoration?.boxShadow ?? "none"};
      margin:0;
      max-width:none;
      max-height:none;
      z-index:${zIndex};
      pointer-events:none;
      transform-origin:top left;
      will-change:transform,opacity,border-radius,box-shadow,padding; 
      transition:none;
      transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});
      animation:none;
    `;
    img.classList.remove("img-preloader-loaded");
    container.appendChild(img);
    
    // Force a reflow to ensure initial state is applied before any transition
    void img.offsetWidth;
  };

  /**
   * Animate the flight by removing the transform (going to target position).
   * Also transitions decoration properties.
   */
  const animateFlight = async (img, durationMs, toDecoration, toBorderRadius) => {
    // Ensure we wait enough frames for the DOM to be stable
    await nextFrame();
    await nextFrame();
    
    img.style.transition = [
      `transform ${durationMs}ms ${EASE}`,
      `box-shadow ${durationMs}ms ${EASE}`,
      `background-color ${durationMs}ms ${EASE}`,
      `padding ${durationMs}ms ${EASE}`,
      `border-radius ${durationMs}ms ${EASE}`
    ].join(", ");
    
    // Animate to target (remove transform offset)
    img.style.transform = "translate(0, 0) scale(1, 1)";
    
    // Apply target decoration
    // Note: If toDecoration is same as initial setFlightStyles, this is a no-op but harmless.
    // The transition ensures if they differ, it animates.
    if (toDecoration) {
      if (toDecoration.padding != null) img.style.padding = toDecoration.padding;
      if (toDecoration.backgroundColor != null) img.style.backgroundColor = toDecoration.backgroundColor;
      if (toDecoration.boxShadow != null) img.style.boxShadow = toDecoration.boxShadow;
    }
    if (toBorderRadius != null) {
      img.style.borderRadius = toBorderRadius;
    }
    
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        img.removeEventListener("transitionend", onEnd);
        resolve();
      };
      // Listen for transform transition end as the primary trigger
      const onEnd = e => e.target === img && e.propertyName === "transform" && finish();
      img.addEventListener("transitionend", onEnd);
      // Fallback timeout in case transition is cancelled or doesn't fire
      setTimeout(finish, durationMs + 100);
    });
  };

  /**
   * Clear flight-related inline styles from the image.
   */
  const clearFlightStyles = (img, keepDecoration) => {
    const props = [
      "position", "left", "top", "width", "height", "margin",
      "maxWidth", "maxHeight", "zIndex", "pointerEvents", "transformOrigin",
      "willChange", "transition", "transform", "animation"
    ];
    if (!keepDecoration) {
      props.push("borderRadius", "clipPath", "webkitClipPath", "boxSizing", "padding", "backgroundColor", "boxShadow");
    }
    props.forEach(p => img.style[p] = "");
  };

  const computeViewerRectFromAspect = (aspectRatio) => {
    const vr = getViewerContentRect();
    const maxW = vr.width, maxH = vr.height;
    const contentMaxW = maxW - VIEWER_PADDING * 2;
    const contentMaxH = maxH - VIEWER_PADDING * 2;
    const ar = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
    let contentW = contentMaxW, contentH = contentW / ar;
    if (contentH > contentMaxH) { contentH = contentMaxH; contentW = contentH * ar; }
    const width = contentW + VIEWER_PADDING * 2;
    const height = contentH + VIEWER_PADDING * 2;
    return { left: vr.left + (vr.width - width) / 2, top: vr.top + (vr.height - height) / 2, width, height };
  };

  const getNodeAspectRatio = (node, item) => {
    if (item && item.width > 0 && item.height > 0) return item.width / item.height;
    if (node instanceof HTMLImageElement) {
      if (node.naturalWidth && node.naturalHeight) return node.naturalWidth / node.naturalHeight;
    }
    const rect = node?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) return rect.width / rect.height;
    return 1;
  };

  const createPlaceholderForNode = (node, aspectRatio) => {
    const ph = document.createElement("span");
    ph.className = "image-viewer-placeholder";
    const cs = getComputedStyle(node);
    ph.style.cssText = `
      display:${cs.display};
      width:${cs.width};
      max-width:${cs.maxWidth};
      max-height:${cs.maxHeight};
      height:auto;
      aspect-ratio:${aspectRatio};
      margin:${cs.margin};
      padding:0;
      border:none;
      visibility:hidden;
      box-sizing:border-box;
    `;
    return ph;
  };

  const createStagePreloader = (viewerRect, aspectRatio) => {
    const pre = document.createElement("div");
    pre.className = "img-preloader image-viewer-img-preloader";
    pre.dataset.src = "";
    pre.dataset.width = "0";
    pre.dataset.height = "0";
    pre.style.width = `${viewerRect.width}px`;
    pre.style.height = `${viewerRect.height}px`;
    pre.style.aspectRatio = `${aspectRatio}`;
    pre.style.maxWidth = "none";
    pre.style.maxHeight = "none";
    pre.innerHTML = `<div class="img-preloader-skeleton"></div>`;
    return pre;
  };

  const setViewerPreloaderError = (preloader, src = "") => {
    if (!(preloader instanceof HTMLElement)) return;
    preloader.classList.add("img-preloader-error");
    const skeleton = preloader.querySelector(".img-preloader-skeleton");
    if (!skeleton) return;
    skeleton.innerHTML = `
      <i class="fa-solid fa-circle-xmark img-preloader-error-icon"></i>
      <div class="img-preloader-error-text">
        <div class="error-message">Failed to load image</div>
        <div class="error-url">${src}</div>
      </div>
    `;
  };

  const waitForImageReady = (img) => new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth) return resolve(img);
    const onLoad = () => cleanup(resolve, img);
    const onErr = () => cleanup(reject, new Error("Image failed to load"));
    const cleanup = (fn, arg) => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onErr);
      fn(arg);
    };
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onErr);
  });

  const setFixedAtRect = (el, rect, zIndex) => {
    const cs = getComputedStyle(el);
    el.style.cssText = `
      position:fixed;
      left:${rect.left}px;
      top:${rect.top}px;
      width:${rect.width}px;
      height:${rect.height}px;
      border-radius:${cs.borderRadius};
      clip-path: inset(0 round ${cs.borderRadius});
      -webkit-clip-path: inset(0 round ${cs.borderRadius});
      box-sizing:border-box;
      overflow:hidden;
      padding:${cs.padding};
      background-color:${cs.backgroundColor};
      box-shadow:${cs.boxShadow};
      margin:0;
      max-width:none;
      max-height:none;
      z-index:${zIndex};
      pointer-events:none;
      transform-origin:center;
      will-change:transform,opacity;
      transition:none;
      transform:translate(0, 0) scale(1, 1);
      opacity:1;
      animation:none;
    `;
  };

  const setGenericFlightStyles = (el, targetRect, fromRect, zIndex) => {
    const dx = fromRect.left - targetRect.left;
    const dy = fromRect.top - targetRect.top;
    const sx = fromRect.width / targetRect.width;
    const sy = fromRect.height / targetRect.height;
    
    el.style.cssText = `
      position:fixed;
      left:${targetRect.left}px;
      top:${targetRect.top}px;
      width:${targetRect.width}px;
      height:${targetRect.height}px;
      margin:0;
      max-width:none;
      max-height:none;
      z-index:${zIndex};
      pointer-events:none;
      transform-origin:top left;
      will-change:transform,opacity;
      transition:none;
      transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});
      opacity:1;
      animation:none;
      box-sizing:border-box;
      overflow:hidden;
      padding:${VIEWER_FRAME_PRELOADER.padding};
      background-color:${VIEWER_FRAME_PRELOADER.backgroundColor};
      border-radius:${VIEWER_FRAME_PRELOADER.borderRadius};
      clip-path: inset(0 round ${VIEWER_FRAME_PRELOADER.borderRadius});
      -webkit-clip-path: inset(0 round ${VIEWER_FRAME_PRELOADER.borderRadius});
      box-shadow:${VIEWER_FRAME_PRELOADER.boxShadow};
    `;
    document.body.appendChild(el);
    void el.offsetWidth;
  };

  const animateGenericFlight = async (el, durationMs) => {
    await nextFrame();
    await nextFrame();
    el.style.transition = `transform ${durationMs}ms ${EASE}, opacity ${durationMs}ms ${EASE}`;
    el.style.transform = "translate(0, 0) scale(1, 1)";
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = e => e.target === el && e.propertyName === "transform" && finish();
      el.addEventListener("transitionend", onEnd);
      setTimeout(finish, durationMs + 80);
    });
  };

  const clearFixedStyles = (el) => {
    ["position", "left", "top", "width", "height", "margin", "maxWidth", "maxHeight", "zIndex", "pointerEvents", "transformOrigin", "willChange", "transition", "transform", "opacity", "animation", "boxSizing", "padding", "backgroundColor", "boxShadow", "borderRadius", "clipPath", "webkitClipPath"].forEach(p => {
      el.style[p] = "";
    });
  };

  const clearFixedStylesKeepStageSize = (el) => {
    ["position", "left", "top", "margin", "maxWidth", "maxHeight", "zIndex", "pointerEvents", "transformOrigin", "willChange", "transition", "transform", "opacity", "animation"].forEach(p => {
      el.style[p] = "";
    });
  };

  const onKeydown = e => {
    if (!state.isOpen) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") navigate(-1);
    else if (e.key === "ArrowRight") navigate(1);
  };

  const getLiveNodeForItem = (item) => {
    if (!state.contextRoot) return item.node;
    if (item.kind === "preloader") {
      const imgs = Array.from(state.contextRoot.querySelectorAll("img"));
      const imgFound = imgs.find(img => toAbsUrl(img.dataset.originalSrc || img.currentSrc || img.src) === item.absSrc);
      if (imgFound) return imgFound;
      const pres = Array.from(state.contextRoot.querySelectorAll(".img-preloader"));
      const found = pres.find(p => toAbsUrl(p.dataset.src) === item.absSrc);
      return found || item.node;
    }
    const imgs = Array.from(state.contextRoot.querySelectorAll("img"));
    const found = imgs.find(img => toAbsUrl(img.dataset.originalSrc || img.currentSrc || img.src) === item.absSrc);
    return found || item.node;
  };

  const updateSwitcher = () => {
    switcherPages.innerHTML = "";
    
    const totalPages = state.items.length;
    if (totalPages <= 1) {
      switcherPages.style.display = "none";
      return;
    }

    const switcherGap = parseFloat(getComputedStyle(switcher).gap || "0") || 0;
    const pagesGap = parseFloat(getComputedStyle(switcherPages).gap || "0") || 0;

    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const vw = document.documentElement.clientWidth || window.innerWidth;
    const maxContainerW = Math.floor(vw * 0.8);

    const prevVisible = isVisible(switcherPrev);
    const nextVisible = isVisible(switcherNext);
    const prevW = prevVisible ? switcherPrev.getBoundingClientRect().width : 0;
    const nextW = nextVisible ? switcherNext.getBoundingClientRect().width : 0;
    const gapCount = (prevVisible ? 1 : 0) + (nextVisible ? 1 : 0);
    const reservedW = prevW + nextW + gapCount * switcherGap;

    const availableW = Math.max(0, maxContainerW - reservedW);
    const itemW = 38;
    const maxSlots = Math.floor((availableW + pagesGap) / (itemW + pagesGap));

    if (maxSlots < 3) {
      switcherPages.style.display = "none";
      return;
    }
    switcherPages.style.display = "";

    const currentPage = state.currentIndex + 1;

    const tokens = buildPaginationTokens(totalPages, currentPage, maxSlots);
    tokens.forEach((t) => {
      if (t === "ellipsis") createEllipsis();
      else createSwitcherBtn(t - 1, t);
    });
    
    updateSwitcherActive();
  };

  const buildPaginationTokens = (totalPages, currentPage, maxSlots) => {
    if (totalPages <= maxSlots) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    if (maxSlots === 3) {
      let start = Math.max(1, Math.min(currentPage - 1, totalPages - 2));
      return [start, start + 1, start + 2];
    }

    if (maxSlots === 4) {
      if (currentPage <= 2) return [1, 2, 3, "ellipsis"];
      if (currentPage >= totalPages - 1) return ["ellipsis", totalPages - 2, totalPages - 1, totalPages];
      return ["ellipsis", currentPage - 1, currentPage, "ellipsis"];
    }

    if (maxSlots === 5) {
      if (currentPage <= 3) return [1, 2, 3, 4, "ellipsis"];
      if (currentPage >= totalPages - 2) return ["ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
      return ["ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis"];
    }

    const innerSlots = maxSlots - 2;

    if (currentPage <= innerSlots - 1) {
      const pages = Array.from({ length: innerSlots }, (_, i) => i + 1);
      return [...pages, "ellipsis", totalPages];
    }

    if (currentPage >= totalPages - (innerSlots - 2)) {
      const start = totalPages - innerSlots + 1;
      const pages = Array.from({ length: innerSlots }, (_, i) => start + i);
      return [1, "ellipsis", ...pages];
    }

    const windowSize = innerSlots - 2;
    let start = currentPage - Math.floor(windowSize / 2);
    let end = start + windowSize - 1;

    if (start < 2) {
      start = 2;
      end = start + windowSize - 1;
    }
    if (end > totalPages - 1) {
      end = totalPages - 1;
      start = end - windowSize + 1;
    }

    const mid = Array.from({ length: windowSize }, (_, i) => start + i);
    return [1, "ellipsis", ...mid, "ellipsis", totalPages];
  };
  
  const createSwitcherBtn = (idx, text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "image-viewer-switcher-page";
    btn.dataset.index = String(idx);
    btn.textContent = String(text);
    switcherPages.appendChild(btn);
  };
  
  const createEllipsis = () => {
    const el = document.createElement("div");
    el.className = "image-viewer-switcher-ellipsis";
    el.innerHTML = `
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    `;
    switcherPages.appendChild(el);
  };

  const updateSwitcherActive = () => {
    Array.from(switcherPages.children).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const idx = Number(node.dataset.index || "-1");
      node.classList.toggle("active", idx === state.currentIndex);
    });
    const activeBtn = switcherPages.querySelector(`.image-viewer-switcher-page[data-index="${state.currentIndex}"]`);
    activeBtn?.scrollIntoView?.({ block: "nearest", inline: "center" });
  };

  const hideSwitcher = () => {
    if (state.switcherShowTimer) {
      clearTimeout(state.switcherShowTimer);
      state.switcherShowTimer = null;
    }
    switcher.classList.remove("shown");
    switcherSidePrev.classList.remove("shown");
    switcherSideNext.classList.remove("shown");
  };

  const scheduleShowSwitcher = () => {
    if (state.switcherShowTimer) clearTimeout(state.switcherShowTimer);
    state.switcherShowTimer = setTimeout(() => {
      state.switcherShowTimer = null;
      if (!state.isOpen || state.isAnimating) return;
      switcher.classList.add("shown");
      switcherSidePrev.classList.add("shown");
      switcherSideNext.classList.add("shown");
    }, 300);
  };

  const mountLoadedImgToStage = (img) => {
    stage.innerHTML = "";
    img.classList.remove("img-preloader-loaded");
    img.style.animation = "";
    stage.appendChild(img);
    state.activeImg = img;
    state.activeEl = img;
    img.style.cursor = "grab";
    img.style.touchAction = "none";
    img.style.width = "";
    img.style.height = "";
    applyTransform();
    constrainVisible();
  };

  const mountPreloaderToStage = (pre) => {
    stage.innerHTML = "";
    stage.appendChild(pre);
    state.activeImg = null;
    state.activeEl = pre;
  };

  const openItemAtIndex = async (index, triggerNode) => {
    const item = state.items[index];
    if (!item) return;
    const liveNode = getLiveNodeForItem(item);
    const aspectRatio = getNodeAspectRatio(liveNode, item);
    const viewerRect = (liveNode instanceof HTMLImageElement && liveNode.naturalWidth && liveNode.naturalHeight)
      ? computeViewerRect(liveNode)
      : computeViewerRectFromAspect(aspectRatio);

    state.scale = 1; state.translateX = state.translateY = 0;
    state.pointers.clear(); state.pinchStart = null; state.isDragging = false;

    if (liveNode instanceof HTMLImageElement) {
      state.saved = saveOriginal(liveNode);
      state.articleOriginalNode = liveNode;
      state.placeholder = createPlaceholderForNode(liveNode, aspectRatio);
      liveNode.before(state.placeholder);

      setFlightStyles(
        liveNode,
        viewerRect,
        state.saved.rect,
        VIEWER_DECORATION,
        VIEWER_FRAME_IMG.borderRadius,
        document.body,
        FLIGHT_Z_OPEN
      );

      await animateFlight(liveNode, OPEN_MS, VIEWER_DECORATION, VIEWER_FRAME_IMG.borderRadius);
      clearFlightStyles(liveNode, true);

      if (liveNode.complete && liveNode.naturalWidth) {
        mountLoadedImgToStage(liveNode);
        return;
      }

      const pre = createStagePreloader(viewerRect, aspectRatio);
      mountPreloaderToStage(pre);
      liveNode.remove();

      waitForImageReady(liveNode).then(async () => {
        if (!state.isOpen) return;
        try { await liveNode.decode(); } catch {}
        await nextFrame();

        pre.remove();
        mountLoadedImgToStage(liveNode);
        liveNode.style.opacity = "0";
        await nextFrame();
        liveNode.style.transition = `opacity 220ms ${EASE}`;
        liveNode.style.opacity = "1";
      }).catch(() => {
        setViewerPreloaderError(pre, item.src);
      });
      return;
    }

    if (liveNode instanceof HTMLElement && liveNode.classList.contains("img-preloader")) {
      const savedRect = liveNode.getBoundingClientRect();
      state.articleOriginalNode = liveNode;
      state.saved = { rect: { left: savedRect.left, top: savedRect.top, width: savedRect.width, height: savedRect.height } };
      state.placeholder = createPlaceholderForNode(liveNode, aspectRatio);
      liveNode.replaceWith(state.placeholder);

      const flight = liveNode.cloneNode(true);
      flight.classList.add("image-viewer-img-preloader");
      flight.classList.remove("img-preloader-fade-out", "img-preloader-loaded", "img-preloader-error");
      flight.style.opacity = "1";
      flight.style.width = `${viewerRect.width}px`;
      flight.style.height = `${viewerRect.height}px`;
      flight.style.aspectRatio = `${aspectRatio}`;

      setGenericFlightStyles(flight, viewerRect, state.saved.rect, FLIGHT_Z_OPEN);
      await animateGenericFlight(flight, OPEN_MS);
      clearFixedStylesKeepStageSize(flight);
      mountPreloaderToStage(flight);

      requestImageBySrc(item.src, item.alt).then(async (loadedImg) => {
        if (!state.isOpen) return;

        try { await loadedImg.decode(); } catch {}

        const articleImg = loadedImg;
        transformPreloaderToImage(liveNode, articleImg);
        articleImg.classList.remove("img-preloader-fade-out");
        state.articleOriginalNode = articleImg;
        loadedPreloaders.add(liveNode);
        
        flight.remove();
        mountLoadedImgToStage(articleImg);
        articleImg.style.opacity = "0";
        await nextFrame();
        articleImg.style.transition = `opacity 220ms ${EASE}`;
        articleImg.style.opacity = "1";

      }).catch(() => {
        setViewerPreloaderError(flight, item.src);
      });
    }
  };

  async function open(node) {
    if (state.isOpen || state.isAnimating) return;
    state.isOpen = state.isAnimating = true;

    const clickNode = (node instanceof HTMLElement ? (node.closest(".img-preloader") || node) : null);
    state.contextRoot = getContextRoot(clickNode);
    state.items = collectItems(state.contextRoot);
    state.currentIndex = findItemIndexByNodeOrSrc(state.items, clickNode);
    if (state.currentIndex < 0) {
      state.isOpen = state.isAnimating = false;
      return;
    }

    // Prevent opening if the clicked node is an unloaded preloader
    // But allow if we are navigating (which is not this case, this is open())
    // Wait, requirement says "cannot be clicked to open", but "can be switched to".
    // open() is only called on click.
    if (clickNode instanceof HTMLElement && clickNode.classList.contains("img-preloader") && !clickNode.classList.contains("img-preloader-loaded")) {
       // Check if it's really unloaded (double check with lazyload status?)
       // The class check is reliable enough as lazyload adds it.
       // But wait, if we block it here, user can't open it.
       // Requirement: "没有加载完成成功渲染的照片不可以点击打开image-viewer"
       state.isOpen = state.isAnimating = false;
       return;
    }

    document.documentElement.style.overflow = "hidden";
    state.fixedHidden = shouldHideFixedElements();
    if (state.fixedHidden) hideFixedElements();

    stage.innerHTML = "";
    maskDom.style.zIndex = "";
    maskDom.classList.remove("switching");
    maskDom.classList.add("active");
    hideSwitcher();
    updateSwitcher();

    await openItemAtIndex(state.currentIndex, clickNode);

    state.isAnimating = false;
    document.addEventListener("keydown", onKeydown);
    if (!state.resizeHandler) {
      state.resizeHandler = () => {
        if (!state.isOpen) return;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          state.resizeTimer = null;
          updateSwitcher();
        }, 120);
      };
      window.addEventListener("resize", state.resizeHandler, { passive: true });
    }
    scheduleShowSwitcher();
  }

  async function close() {
    if (!state.isOpen || state.isAnimating) return;
    if (!state.activeEl || !state.placeholder) return;

    state.isAnimating = true;
    document.removeEventListener("keydown", onKeydown);
    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
      state.resizeHandler = null;
    }
    if (state.resizeTimer) {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = null;
    }
    hideSwitcher();
    maskDom.classList.remove("switching");

    const el = state.activeEl;
    const ph = state.placeholder;

    if (state.articleOriginalNode instanceof HTMLImageElement && el === state.articleOriginalNode) {
      const img = el;
      const cs = getComputedStyle(img);
      const fromRect = img.getBoundingClientRect();
      const phRect = ph.getBoundingClientRect();
      const toRect = { left: phRect.left, top: phRect.top, width: phRect.width, height: phRect.height };
      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      const sx = fromRect.width / toRect.width;
      const sy = fromRect.height / toRect.height;

      const targetDecoration = {
        padding: state.saved?.padding ?? "0",
        backgroundColor: state.saved?.backgroundColor ?? "transparent",
        boxShadow: state.saved?.boxShadow ?? "none"
      };

      maskDom.style.zIndex = String(MASK_Z_CLOSE);

      img.style.cssText = `
        position:fixed;
        left:${toRect.left}px;
        top:${toRect.top}px;
        width:${toRect.width}px;
        height:${toRect.height}px;
        border-radius:${cs.borderRadius};
        box-sizing:border-box;
        padding:${cs.padding};
        background-color:${cs.backgroundColor};
        box-shadow:${cs.boxShadow};
        margin:0;
        max-width:none;
        max-height:none;
        z-index:${FLIGHT_Z_CLOSE};
        pointer-events:none;
        transform-origin:top left;
        will-change:transform,opacity;
        transition:none;
        transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});
        animation:none;
      `;
      img.classList.remove("img-preloader-loaded");
      document.body.appendChild(img);
      stage.innerHTML = "";
      maskDom.classList.remove("active");

      await animateFlight(img, CLOSE_MS, targetDecoration, state.saved?.borderRadius);

      clearFlightStyles(img, false);
      restoreOriginal(img, state.saved);
      ph.replaceWith(img);
    } else {
      const fromRect = el.getBoundingClientRect();
      const phRect = ph.getBoundingClientRect();
      const toRect = { left: phRect.left, top: phRect.top, width: phRect.width, height: phRect.height };
      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      const sx = fromRect.width / toRect.width;
      const sy = fromRect.height / toRect.height;

      // If we are closing a preloader that hasn't finished loading (still preloader node),
      // we should just fade it out instead of scaling it back to the placeholder
      // because scaling back a "loading spinner" looks weird if it's different from the original placeholder.
      // However, if we want "fly back" effect for preloader too, we can keep it.
      // Requirement: "正确处理如果在loading状态退出，preloader重新出现时只需要fade in opacity change的效果，而不是放大弹出过于夸张"
      
      const isPreloader = el.classList.contains("image-viewer-img-preloader") || el.classList.contains("img-preloader");
      
      if (isPreloader) {
         // Just fade out the viewer element and fade in the original placeholder/preloader
         maskDom.classList.remove("active");
         
         // Animate opacity out
         el.style.transition = `opacity ${CLOSE_MS}ms ${EASE}`;
         el.style.opacity = "0";
         
         // Wait for animation
         await new Promise(resolve => setTimeout(resolve, CLOSE_MS));
         el.remove();
         
         if (state.articleOriginalNode instanceof HTMLElement) {
            const restoredNode = state.articleOriginalNode;
            ph.replaceWith(restoredNode);
            // Optional: fade in the original node
            restoredNode.style.opacity = "0";
            restoredNode.animate([
              { opacity: 0 },
              { opacity: 1 }
            ], { duration: 220, easing: "ease-out", fill: "forwards" });
            setTimeout(() => {
              if (!restoredNode.isConnected) return;
              restoredNode.style.opacity = "";
            }, 220);
         }
      } else {
          // Normal fly back for loaded images
          maskDom.style.zIndex = String(MASK_Z_CLOSE);
    
          const cs = getComputedStyle(el);
          el.style.cssText = `
            position:fixed;
            left:${toRect.left}px;
            top:${toRect.top}px;
            width:${toRect.width}px;
            height:${toRect.height}px;
            border-radius:${cs.borderRadius};
            box-sizing:border-box;
            padding:${cs.padding};
            background-color:${cs.backgroundColor};
            box-shadow:${cs.boxShadow};
            margin:0;
            max-width:none;
            max-height:none;
            z-index:${FLIGHT_Z_CLOSE};
            pointer-events:none;
            transform-origin:top left;
            will-change:transform,opacity;
            transition:none;
            transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});
            opacity:1;
            animation:none;
          `;
          document.body.appendChild(el);
          stage.innerHTML = "";
          maskDom.classList.remove("active");
    
          await nextFrame();
          await nextFrame();
          el.style.transition = `transform ${CLOSE_MS}ms ${EASE}, opacity ${CLOSE_MS}ms ${EASE}`;
          el.style.transform = "translate(0, 0) scale(1, 1)";
          await new Promise(resolve => setTimeout(resolve, CLOSE_MS + 80));
          el.remove();
    
          if (state.articleOriginalNode instanceof HTMLElement) {
            ph.replaceWith(state.articleOriginalNode);
          }
      }
    }

    document.documentElement.style.overflow = "";
    if (state.fixedHidden) {
      showFixedElements(300); // 300ms delay as requested
      state.fixedHidden = false;
    }

    state.activeImg = state.activeEl = null;
    state.articleOriginalNode = null;
    state.placeholder = null;
    state.saved = null;
    state.pointers.clear(); state.pinchStart = null;
    state.isOpen = state.isAnimating = false;

    maskDom.style.zIndex = "";
  }

  async function navigate(delta) {
    if (!state.isOpen || state.items.length <= 1 || state.isAnimating) return;
    const nextIndex = (state.currentIndex + delta + state.items.length) % state.items.length;
    await switchToIndex(nextIndex);
  }

  async function switchToIndex(targetIndex) {
    if (!state.isOpen || state.isAnimating) return;
    if (targetIndex === state.currentIndex) return;
    const nextItem = state.items[targetIndex];
    if (!nextItem) return;

    const direction = targetIndex > state.currentIndex ? -1 : 1;
    const SWITCH_MS = 420;
    const OVERLAP_MS = Math.round(SWITCH_MS / 2);

    state.isAnimating = true;
    hideSwitcher();
    maskDom.classList.add("switching");

    const outgoingEl = state.activeEl;
    const outgoingPlaceholder = state.placeholder;
    const outgoingOriginal = state.articleOriginalNode;
    const outgoingSaved = state.saved;
    const outgoingFromRect = outgoingEl.getBoundingClientRect();

    stage.innerHTML = "";
    if (outgoingEl instanceof HTMLImageElement) {
      setFlightStyles(
        outgoingEl,
        outgoingFromRect,
        outgoingFromRect,
        VIEWER_DECORATION,
        VIEWER_FRAME_IMG.borderRadius,
        document.body,
        FLIGHT_Z_OPEN
      );
    } else {
      setGenericFlightStyles(outgoingEl, outgoingFromRect, outgoingFromRect, FLIGHT_Z_OPEN);
    }

    const vw = window.innerWidth, vh = window.innerHeight;
    const currentCenterY = outgoingFromRect.top + outgoingFromRect.height / 2;
    const dy = (vh / 2) - currentCenterY;
    const exitX = direction < 0
      ? -(outgoingFromRect.left + outgoingFromRect.width + 40)
      : (vw - outgoingFromRect.left + 40);

    await nextFrame();
    await nextFrame();
    outgoingEl.style.transition = `transform ${SWITCH_MS}ms ${EASE}, opacity ${SWITCH_MS}ms ${EASE}`;
    outgoingEl.style.transform = `translate(${exitX}px, ${dy}px) scale(0.6, 0.6)`;
    outgoingEl.style.opacity = "0";

    setTimeout(async () => {
      if (!state.isOpen) return;
      state.currentIndex = targetIndex;
      updateSwitcher();

      const liveNode = getLiveNodeForItem(nextItem);
      const aspectRatio = getNodeAspectRatio(liveNode, nextItem);
      const viewerRect = (liveNode instanceof HTMLImageElement && liveNode.naturalWidth && liveNode.naturalHeight)
        ? computeViewerRect(liveNode)
        : computeViewerRectFromAspect(aspectRatio);

      state.scale = 1; state.translateX = state.translateY = 0;
      state.pointers.clear(); state.pinchStart = null; state.isDragging = false;

      let incomingEl;
      if (liveNode instanceof HTMLImageElement) {
        state.saved = saveOriginal(liveNode);
        state.articleOriginalNode = liveNode;
        state.placeholder = createPlaceholderForNode(liveNode, aspectRatio);
        liveNode.before(state.placeholder);
        incomingEl = liveNode;
        setFlightStyles(
          incomingEl,
          viewerRect,
          viewerRect,
          VIEWER_DECORATION,
          VIEWER_FRAME_IMG.borderRadius,
          document.body,
          FLIGHT_Z_OPEN
        );
        incomingEl.style.transform = direction < 0
          ? `translate(${vw - viewerRect.left + 40}px, 0px) scale(0.6, 0.6)`
          : `translate(${-(viewerRect.left + viewerRect.width + 40)}px, 0px) scale(0.6, 0.6)`;
        incomingEl.style.opacity = "0";
        await nextFrame();
        incomingEl.style.transition = `transform ${SWITCH_MS}ms ${EASE}, opacity ${SWITCH_MS}ms ${EASE}`;
        incomingEl.style.opacity = "1";
        incomingEl.style.transform = "translate(0, 0) scale(1, 1)";
        await new Promise(resolve => setTimeout(resolve, SWITCH_MS + 80));
        clearFlightStyles(incomingEl, true);
        mountLoadedImgToStage(incomingEl);

        if (!(incomingEl.complete && incomingEl.naturalWidth)) {
          const pre = createStagePreloader(viewerRect, aspectRatio);
          mountPreloaderToStage(pre);
          incomingEl.remove();
          waitForImageReady(incomingEl).then(async () => {
            if (!state.isOpen || state.currentIndex !== targetIndex) return;
            try { await incomingEl.decode(); } catch {}
            await nextFrame();
            pre.remove();
            mountLoadedImgToStage(incomingEl);
            incomingEl.style.opacity = "0";
            await nextFrame();
            incomingEl.style.transition = `opacity 220ms ${EASE}`;
            incomingEl.style.opacity = "1";
          }).catch(() => {
            setViewerPreloaderError(pre, nextItem.src);
          });
        }
      } else if (liveNode instanceof HTMLElement && liveNode.classList.contains("img-preloader")) {
        const savedRect = liveNode.getBoundingClientRect();
        state.articleOriginalNode = liveNode;
        state.saved = { rect: { left: savedRect.left, top: savedRect.top, width: savedRect.width, height: savedRect.height } };
        state.placeholder = createPlaceholderForNode(liveNode, aspectRatio);
        liveNode.replaceWith(state.placeholder);

        const incomingPre = createStagePreloader(viewerRect, aspectRatio);
        setGenericFlightStyles(incomingPre, viewerRect, viewerRect, FLIGHT_Z_OPEN);
        incomingPre.style.transform = direction < 0
          ? `translate(${vw - viewerRect.left + 40}px, 0px) scale(0.6, 0.6)`
          : `translate(${-(viewerRect.left + viewerRect.width + 40)}px, 0px) scale(0.6, 0.6)`;
        incomingPre.style.opacity = "0";
        await nextFrame();
        incomingPre.style.transition = `transform ${SWITCH_MS}ms ${EASE}, opacity ${SWITCH_MS}ms ${EASE}`;
        incomingPre.style.opacity = "1";
        incomingPre.style.transform = "translate(0, 0) scale(1, 1)";
        await new Promise(resolve => setTimeout(resolve, SWITCH_MS + 80));
        clearFixedStylesKeepStageSize(incomingPre);
        mountPreloaderToStage(incomingPre);

        requestImageBySrc(nextItem.src, nextItem.alt).then(async (loadedImg) => {
          if (!state.isOpen || state.currentIndex !== targetIndex) return;

          try { await loadedImg.decode(); } catch {}

          const articleImg = loadedImg;
          transformPreloaderToImage(liveNode, articleImg);
          articleImg.classList.remove("img-preloader-fade-out");
          state.articleOriginalNode = articleImg;
          loadedPreloaders.add(liveNode);
          incomingPre.remove();
          mountLoadedImgToStage(articleImg);
          articleImg.style.opacity = "0";
          await nextFrame();
          articleImg.style.transition = `opacity 220ms ${EASE}`;
          articleImg.style.opacity = "1";
        }).catch(() => {
          setViewerPreloaderError(incomingPre, nextItem.src);
        });
      }

      const anchor = state.placeholder;
      if (anchor) {
        const y = anchor.getBoundingClientRect().top + window.scrollY;
        const top = Math.max(0, y - window.innerHeight * 0.2);
        try { window.scrollTo({ top, behavior: "smooth" }); } catch { window.scrollTo(0, top); }
      }
    }, OVERLAP_MS);

    setTimeout(() => {
      if (outgoingOriginal instanceof HTMLImageElement) {
        clearFlightStyles(outgoingEl, false);
        restoreOriginal(outgoingOriginal, outgoingSaved);
        outgoingPlaceholder?.replaceWith(outgoingOriginal);
        outgoingOriginal.classList.add("image-viewer-article-fade-in");
        setTimeout(() => outgoingOriginal.classList.remove("image-viewer-article-fade-in"), 260);
      } else if (outgoingOriginal instanceof HTMLElement) {
        outgoingEl.remove();
        outgoingPlaceholder?.replaceWith(outgoingOriginal);
        outgoingOriginal.classList.add("image-viewer-article-fade-in");
        setTimeout(() => outgoingOriginal.classList.remove("image-viewer-article-fade-in"), 260);
      } else {
        outgoingEl.remove();
      }
    }, SWITCH_MS);

    await new Promise(resolve => setTimeout(resolve, SWITCH_MS + OVERLAP_MS + 120));
    maskDom.classList.remove("switching");
    state.isAnimating = false;
    scheduleShowSwitcher();
  }

  global.api = { open, close, isOpen: () => state.isOpen };

  switcherPrev.onclick = () => navigate(-1);
  switcherNext.onclick = () => navigate(1);
  switcherSidePrev.onclick = () => navigate(-1);
  switcherSideNext.onclick = () => navigate(1);
  switcherPages.onclick = (e) => {
    if (!state.isOpen || state.isAnimating) return;
    const btn = e.target?.closest?.(".image-viewer-switcher-page");
    if (!(btn instanceof HTMLElement)) return;
    const idx = Number(btn.dataset.index || "-1");
    if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) return;
    switchToIndex(idx);
  };

  if (!global.docBound) {
    global.handlers.onDocClick = e => {
      const api = global.api;
      if (!api || api.isOpen()) return;
      const t = e.target;
      if (t instanceof HTMLImageElement) {
        if (!t.matches(VIEWABLE_IMG_SELECTOR) || !isViewableImg(t)) return;
        api.open(t);
        return;
      }
      const pre = t?.closest?.(".img-preloader");
      if (!(pre instanceof HTMLElement) || !isViewablePreloader(pre)) return;
      if (!pre.closest(".markdown-body, .masonry-item, #shuoshuo-content")) return;
      api.open(pre);
    };
    document.addEventListener("click", global.handlers.onDocClick, true);
    global.docBound = true;
  }

  if (global.maskEl !== maskDom) {
    if (global.maskEl && global.handlers.onMaskClick) {
      global.maskEl.removeEventListener("click", global.handlers.onMaskClick, false);
    }
    global.handlers.onMaskClick = e => {
      if (!state.isOpen || state.isDragging) return;
      if (e.target === maskDom || e.target === stage) close();
    };
    maskDom.addEventListener("click", global.handlers.onMaskClick, false);
    global.maskEl = maskDom;
  }

  if (global.stageEl !== stage) {
    const oldStage = global.stageEl;
    if (oldStage) {
      ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(ev => {
        const handler = global.handlers[`on${ev}`];
        if (handler) oldStage.removeEventListener(ev, handler, false);
      });
    }

    global.handlers.onwheel = e => {
      if (!state.isOpen || !state.activeImg || e.target !== state.activeImg) return;
      e.preventDefault();
      const rect = state.activeImg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - rect.width / 2;
      const mouseY = e.clientY - rect.top - rect.height / 2;
      const oldScale = state.scale;
      state.scale = Math.max(0.5, Math.min(6, oldScale * (e.deltaY > 0 ? 0.9 : 1.1)));
      const ratio = state.scale / oldScale - 1;
      state.translateX -= mouseX * ratio; state.translateY -= mouseY * ratio;
      state.activeImg.style.transition = "none";
      applyTransform(); constrainVisible();
    };

    global.handlers.onpointerdown = e => {
      if (!state.isOpen || !state.activeImg || e.target !== state.activeImg) return;
      e.preventDefault();
      state.activeImg.setPointerCapture(e.pointerId);
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (state.pointers.size === 1) {
        state.dragStartX = e.clientX - state.translateX;
        state.dragStartY = e.clientY - state.translateY;
        state.activeImg.style.cursor = "grabbing";
        state.activeImg.style.transition = "none";
      }
    };

    global.handlers.onpointermove = e => {
      if (!state.isOpen || !state.activeImg || !state.pointers.has(e.pointerId)) return;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (state.pointers.size === 1) {
        state.translateX = e.clientX - state.dragStartX;
        state.translateY = e.clientY - state.dragStartY;
        state.isDragging = true;
        applyTransform(); constrainVisible();
        return;
      }

      if (state.pointers.size === 2) {
        const pts = Array.from(state.pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;

        if (!state.pinchStart) {
          state.pinchStart = { dist, midX, midY, scale: state.scale, tx: state.translateX, ty: state.translateY };
        }

        const s = Math.max(0.5, Math.min(6, state.pinchStart.scale * (dist / state.pinchStart.dist)));
        const ratio = s / state.scale;
        const rect = state.activeImg.getBoundingClientRect();
        const cx = midX - (rect.left + rect.width / 2), cy = midY - (rect.top + rect.height / 2);
        state.translateX -= cx * (ratio - 1); state.translateY -= cy * (ratio - 1);
        state.scale = s; state.isDragging = true;
        applyTransform(); constrainVisible();
      }
    };

    global.handlers.onpointerup = global.handlers.onpointercancel = e => {
      if (!state.isOpen || !state.activeImg) return;
      state.pointers.delete(e.pointerId);
      if (state.pointers.size === 0) {
        state.activeImg.style.cursor = "grab";
        state.pinchStart = null;
        constrainVisible();
        setTimeout(() => state.isDragging = false, 50);
      } else if (state.pointers.size === 1) {
        state.pinchStart = null;
        const p = Array.from(state.pointers.values())[0];
        state.dragStartX = p.x - state.translateX;
        state.dragStartY = p.y - state.translateY;
      }
    };

    ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(ev => {
      stage.addEventListener(ev, global.handlers[`on${ev}`], { passive: false });
    });

    global.stageEl = stage;
  }
}
