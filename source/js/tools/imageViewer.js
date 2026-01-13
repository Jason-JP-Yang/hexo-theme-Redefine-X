export default function imageViewer() {
  const global = window.__REDEFINE_X_IMAGE_VIEWER__ || (window.__REDEFINE_X_IMAGE_VIEWER__ = {
    docBound: false, maskEl: null, stageEl: null, handlers: {}, api: null
  });

  const maskDom = document.querySelector(".image-viewer-container");
  const stage = maskDom?.querySelector(".image-viewer-stage");
  if (!maskDom || !stage) return;

  const VIEWABLE_IMG_SELECTOR = ".markdown-body img, .masonry-item img, #shuoshuo-content img";
  const OPEN_MS = 420, CLOSE_MS = 360, EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  // Viewer decoration styles (must match CSS .image-viewer-stage img)
  // padding: 2px creates the border effect that transitions during animation
  const VIEWER_DECORATION = { padding: "2px", backgroundColor: "var(--background-color)", boxShadow: "0 18px 60px rgba(0, 0, 0, 0.35)" };

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

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

  const isViewableImg = (img) => img && !img.closest(".image-viewer-container") && 
    img.complete && img.naturalWidth && !img.hasAttribute("data-no-viewer");

  const collectLoadedImages = () => Array.from(document.querySelectorAll(VIEWABLE_IMG_SELECTOR))
    .filter(node => node instanceof HTMLImageElement && isViewableImg(node));

  const state = {
    isOpen: false, isAnimating: false, currentIndex: -1, items: [], activeImg: null,
    placeholder: null, saved: null, scale: 1, translateX: 0, translateY: 0, isDragging: false,
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
   * Compute the target rect for the image in viewer (centered, fit within 92% viewport)
   * This calculates the border-box dimensions including padding (2px as per CSS)
   */
  const VIEWER_PADDING = 2; // Must match CSS .image-viewer-stage img padding
  const computeViewerRect = (img) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    // CSS max-width/max-height are 92vw/92vh for border-box (including padding)
    const maxW = vw * 0.92, maxH = vh * 0.92;
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
    return { left: (vw - width) / 2, top: (vh - height) / 2, width, height };
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
  const restoreOriginal = (img) => {
    if (!state.saved) return;
    if (state.saved.styleAttr == null) {
      img.removeAttribute("style");
    } else {
      img.setAttribute("style", state.saved.styleAttr);
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
    img.style.cssText = `
      position:fixed;
      left:${targetRect.left}px;
      top:${targetRect.top}px;
      width:${targetRect.width}px;
      height:${targetRect.height}px;
      border-radius:${borderRadius || "0"};
      box-sizing:border-box;
      padding:${decoration?.padding ?? "0"};
      background-color:${decoration?.backgroundColor ?? "transparent"};
      box-shadow:${decoration?.boxShadow ?? "none"};
      margin:0;
      max-width:none;
      max-height:none;
      z-index:${zIndex};
      pointer-events:none;
      transform-origin:top left;
      will-change:transform,opacity;
      transition:none;
      transform:translate(${dx}px, ${dy}px) scale(${sx}, ${sy});
      animation:none;
    `;
    img.classList.remove("img-preloader-loaded");
    container.appendChild(img);
  };

  /**
   * Animate the flight by removing the transform (going to target position).
   * Also transitions decoration properties.
   */
  const animateFlight = async (img, durationMs, toDecoration, toBorderRadius) => {
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
      const onEnd = e => e.target === img && e.propertyName === "transform" && finish();
      img.addEventListener("transitionend", onEnd);
      setTimeout(finish, durationMs + 80);
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
      props.push("borderRadius", "boxSizing", "padding", "backgroundColor", "boxShadow");
    }
    props.forEach(p => img.style[p] = "");
  };

  const onKeydown = e => {
    if (!state.isOpen) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") navigate(-1);
    else if (e.key === "ArrowRight") navigate(1);
  };

  async function open(img) {
    if (state.isOpen || state.isAnimating) return;
    state.isOpen = state.isAnimating = true;
    state.items = collectLoadedImages();
    state.currentIndex = state.items.indexOf(img);
    if (state.currentIndex < 0) { state.items = [img]; state.currentIndex = 0; }

    // Save original state BEFORE any DOM changes
    state.saved = saveOriginal(img);
    state.scale = 1; state.translateX = state.translateY = 0;
    state.pointers.clear(); state.pinchStart = null; state.isDragging = false;

    // Create placeholder that maintains the same responsive behavior as the original image
    state.placeholder = createPlaceholder(img, state.saved);
    img.before(state.placeholder);
    
    // Compute target rect in viewer (centered)
    const viewerRect = computeViewerRect(img);

    // Disable scroll and hide fixed elements
    document.documentElement.style.overflow = "hidden";
    state.fixedHidden = shouldHideFixedElements();
    if (state.fixedHidden) hideFixedElements();

    stage.innerHTML = "";
    maskDom.style.zIndex = "";
    maskDom.classList.add("active");

    // Open animation: fly from article position to viewer center
    // Use high z-index to be above image-viewer-container's backdrop-filter
    setFlightStyles(
      img,
      viewerRect,                    // target: viewer center
      state.saved.rect,              // from: article position (saved before DOM change)
      {                              // from decoration (article image has minimal decoration)
        padding: state.saved.padding,
        backgroundColor: state.saved.backgroundColor,
        boxShadow: state.saved.boxShadow
      },
      state.saved.borderRadius,      // from border-radius
      document.body,                 // container
      FLIGHT_Z_OPEN                  // z-index above container
    );

    await animateFlight(img, OPEN_MS, VIEWER_DECORATION, state.saved.borderRadius);
    
    // Now place image in stage. The CSS has "width: auto !important; height: auto !important"
    // but that's fine because we're clearing the fixed dimensions and letting CSS handle sizing.
    // The key is that the decorations (padding, background, box-shadow, border-radius) are 
    // already set by animateFlight and kept by clearFlightStyles(img, true).
    clearFlightStyles(img, true);
    stage.appendChild(img);
    
    // Set styles for stage display (these will work with the CSS)
    state.activeImg = img;
    img.style.cursor = "grab";
    img.style.touchAction = "none";
    img.style.width = "";  // Let CSS max-width/max-height handle sizing
    img.style.height = "";
    applyTransform();
    constrainVisible();

    state.isAnimating = false;
    document.addEventListener("keydown", onKeydown);
  }

  async function close() {
    if (!state.isOpen || state.isAnimating) return;
    if (!state.activeImg || !state.placeholder) return;

    state.isAnimating = true;
    document.removeEventListener("keydown", onKeydown);

    const img = state.activeImg, ph = state.placeholder;
    const cs = getComputedStyle(img);
    
    // Get the current visual rect of image in viewer (includes user's pan/zoom transform)
    const fromRect = img.getBoundingClientRect();
    
    // Get the current position of placeholder (where image should return to)
    const phRect = ph.getBoundingClientRect();
    const toRect = { left: phRect.left, top: phRect.top, width: phRect.width, height: phRect.height };

    // Calculate transform to animate FROM current position TO target position
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    const sx = fromRect.width / toRect.width;
    const sy = fromRect.height / toRect.height;

    const targetDecoration = {
      padding: state.saved?.padding ?? "0",
      backgroundColor: state.saved?.backgroundColor ?? "transparent",
      boxShadow: state.saved?.boxShadow ?? "none"
    };

    // Lower the blur mask BEFORE moving the image, so backdrop-filter never affects the image.
    // Keep mask above article but below navbar and image.
    maskDom.style.zIndex = String(MASK_Z_CLOSE);

    // CRITICAL: Set new styles in ONE operation to prevent flash
    // We set position:fixed with transform that places image at its CURRENT visual position
    // Then animate the transform to (0,0) scale(1,1) to reach target position
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
    
    // Move to body immediately after setting styles - no flash because transform is already set
    document.body.appendChild(img);
    
    // Clear stage after img is moved
    stage.innerHTML = "";

    // Start blur/background fade-out exactly when the flight transition starts.
    // CSS transition duration is 360ms, matching CLOSE_MS, so they end together.
    // Image stays ABOVE the blur layer (and below navbar) for the whole close.
    maskDom.classList.remove("active");

    // Animate flight back to article position
    await animateFlight(img, CLOSE_MS, targetDecoration, state.saved?.borderRadius);

    // Restore original styles BEFORE replacing placeholder
    clearFlightStyles(img, false);
    restoreOriginal(img);
    
    // Replace placeholder with the image (now img has correct styles, no flash)
    ph.replaceWith(img);

    // Re-enable scroll and show fixed elements after close animation completes
    document.documentElement.style.overflow = "";
    if (state.fixedHidden) {
      showFixedElements(300); // 300ms delay as requested
      state.fixedHidden = false;
    }

    state.activeImg = state.placeholder = state.saved = null;
    state.pointers.clear(); state.pinchStart = null;
    state.isOpen = state.isAnimating = false;

    // Restore mask stacking for next open
    maskDom.style.zIndex = "";
  }

  async function navigate(delta) {
    if (!state.isOpen || state.items.length <= 1 || state.isAnimating) return;
    const nextIndex = (state.currentIndex + delta + state.items.length) % state.items.length;
    const nextImg = state.items[nextIndex];
    if (!nextImg || !isViewableImg(nextImg)) return;
    state.currentIndex = nextIndex;
    await close(); await nextFrame(); await open(nextImg);
  }

  global.api = { open, close, isOpen: () => state.isOpen };

  if (!global.docBound) {
    global.handlers.onDocClick = e => {
      const api = global.api;
      if (!api || api.isOpen()) return;
      const t = e.target;
      if (!(t instanceof HTMLImageElement) || !t.matches(VIEWABLE_IMG_SELECTOR) || !isViewableImg(t)) return;
      api.open(t);
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
