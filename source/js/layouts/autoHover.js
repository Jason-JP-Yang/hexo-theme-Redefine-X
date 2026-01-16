export default function initAutoHover() {
  initHomeArticleAutoHover();
  initArticleMediaAutoHover();
}

function initHomeArticleAutoHover() {
  const list = document.querySelector(".home-article-list");
  if (!list || list.dataset.autoHoverInit === "1") return;
  list.dataset.autoHoverInit = "1";

  const items = Array.from(list.querySelectorAll(".home-article-item"));
  if (!items.length) return;

  let activeItem = null;
  let ticking = false;
  let userHoveringInteractive = false;

  const interactiveSelector =
    "a,button,input,textarea,select,summary,[role='button'],[tabindex]:not([tabindex='-1']),.home-article-item";

  const isListInView = () => {
    const rect = list.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  };

  const update = () => {
    ticking = false;
    if (!isListInView() || userHoveringInteractive) {
      if (activeItem) activeItem.classList.remove("auto-hover");
      activeItem = null;
      return;
    }

    const center = window.innerHeight / 2;
    let closest = null;
    let closestDist = Infinity;

    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      const dist = Math.abs(rect.top + rect.height / 2 - center);
      if (dist < closestDist) {
        closestDist = dist;
        closest = item;
      }
    }

    if (closest !== activeItem) {
      if (activeItem) activeItem.classList.remove("auto-hover");
      if (closest) closest.classList.add("auto-hover");
      activeItem = closest;
    }
  };

  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  const setUserHover = (state) => {
    if (userHoveringInteractive === state) return;
    userHoveringInteractive = state;
    if (state && activeItem) {
      activeItem.classList.remove("auto-hover");
      activeItem = null;
    }
    requestUpdate();
  };

  document.addEventListener(
    "pointerover",
    (event) => {
      if (event.target && event.target.closest(interactiveSelector)) {
        setUserHover(true);
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      const related = event.relatedTarget;
      if (related && related.closest && related.closest(interactiveSelector)) return;
      setUserHover(false);
    },
    { passive: true },
  );

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  requestUpdate();
}

function initArticleMediaAutoHover() {
  const root = document.documentElement;
  if (root.dataset.articleMediaAutoHoverGlobalInit !== "1") {
    root.dataset.articleMediaAutoHoverGlobalInit = "1";
    installGlobalListeners();
  }
  refreshCandidates();
  requestUpdate();
}

const state = {
  candidates: [],
  active: null,
  ticking: false,
  hoveringInteractive: false,
  suspendUntil: 0,
  resumeTimer: null,
};

const interactiveSelector =
  "a,button,input,textarea,select,summary,[role='button'],[tabindex]:not([tabindex='-1']),.page-aside-toggle,.right-bottom-tools,.right-bottom-tools *,.post-toc,.post-toc *,.navbar,.navbar *";

function refreshCandidates() {
  const candidates = [];

  const captionFigures = document.querySelectorAll("figure.image-caption");
  captionFigures.forEach((figure) => {
    // img-handle.js structure: <figure class="image-caption"><img ...><figcaption>...</figcaption></figure>
    // lazyload.js replaces <img ...> with <div class="img-preloader">...</div> initially
    // So we need to look for either.
    const img = figure.querySelector("img, .img-preloader");
    if (!img) return;
    
    // Check if it's already an EXIF container (avoid duplicates if structure overlaps)
    if (figure.classList.contains("image-exif-container")) return;

    candidates.push({ type: "caption", element: figure, img });
  });

  const exifFloat = document.querySelectorAll(
    ".image-exif-container.image-exif-float:not(.image-exif-overflow-fallback)",
  );
  exifFloat.forEach((container) => {
    // Similarly, look for preloader or img
    const img = container.querySelector("img.image-exif-img, .img-preloader");
    if (!img) return;
    candidates.push({ type: "exif-float", element: container, img });
  });

  state.candidates = candidates;
  if (state.active && !state.candidates.some((c) => c.element === state.active.element)) {
    clearActive();
  }
}

function setActive(candidate) {
  if (state.active && state.active.element === candidate.element) return;
  clearActive();
  candidate.element.classList.add("auto-hover");
  state.active = candidate;
}

function clearActive() {
  if (!state.active) return;
  state.active.element.classList.remove("auto-hover");
  state.active = null;
}

function shouldSuspend() {
  return state.hoveringInteractive || Date.now() < state.suspendUntil;
}

function isInCenterBand(imgRect, viewportHeight) {
  const centerY = viewportHeight / 2;
  const bandHalf = viewportHeight * 0.15;
  const imgCenter = imgRect.top + imgRect.height / 2;
  return Math.abs(imgCenter - centerY) <= bandHalf;
}

function update() {
  state.ticking = false;

  if (!state.candidates.length) {
    return;
  }

  // Check suspend state
  if (shouldSuspend()) {
    // Check if we can early resume (80% out of viewport)
    const vh = window.innerHeight;
    let anyFarAway = false;
    
    // Only check the active item or best candidate if no active
    // But logically, if suspended, we just want to know if user scrolled FAR away
    // Simplification: if ANY candidate is currently active (conceptually) but hidden due to suspend,
    // we check if that candidate is now far away.
    // Actually, simpler: if user scrolls significantly, we can probably resume?
    // Requirement: "image has at least 80% moved out of screen" -> recover.
    
    // We need to track which image WAS active or IS target
    // Since we cleared active, we don't know easily.
    // Let's iterate all candidates. If ALL visible candidates are far from center, or if the "would be active" is far...
    
    // Better interpretation: If the image that WAS clicked (causing suspend) moves 80% out of screen.
    // But we don't track clicked image.
    // Let's implement generic: If the "would be active" image is < 20% visible? No that means we select nothing.
    
    // Let's track last interacted image if possible?
    // Alternative: If the "best" candidate is barely visible, we resume?
    
    // Let's stick to strict requirement: "image has at least 80% moved out of screen"
    // This implies we need to know WHICH image.
    // Let's assume it refers to the currently best candidate.
    
    // Re-calculate best candidate even if suspended
     // const vh = window.innerHeight; // Already declared in outer scope
     const center = vh / 2;
     let best = null;
     let bestDist = Infinity;
    
    for (const c of state.candidates) {
      const rect = c.img.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= vh) continue;
      const dist = Math.abs(rect.top + rect.height / 2 - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    
    if (best) {
      // Check if this best image is 80% out of screen?
      // "recover" means resume auto-hover.
      // If it is 80% out of screen, it wouldn't be "active" anyway (center band is 30%).
      // So if it moves out of center band, we naturally switch active or clear active.
      
      // Maybe requirement means: if I click image, wait 10s. BUT if I scroll it out of view immediately, cancel the 10s wait.
      // So if the "clicked" image is no longer in view?
      
      // Let's implement: If NO candidate is in the center band, we can resume (because nothing will be shown anyway).
      // AND if we re-enter center band, we want it to show.
      
      // Wait, if I click, it hides. If I scroll away and back, it should show?
      // Yes, "recover".
      
      // So: If the best candidate changes? Or if best candidate moves significantly?
      // Let's try: If the best candidate is NOT in center band, we clear suspend.
      
      const rect = best.img.getBoundingClientRect();
      // 80% out of screen means only 20% visible?
      // Or 80% distance from center?
      // "at least 80% moved out of screen" -> visible height < 20% of total height?
      
      const visibleHeight = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
      const isAlmostOut = visibleHeight < rect.height * 0.2;
      
      if (isAlmostOut) {
        state.suspendUntil = 0; // Resume immediately
        // Continue to normal update logic
      } else {
        clearActive();
        return;
      }
    } else {
      // No visible images, safe to resume
      state.suspendUntil = 0;
    }
  }

  const vh = window.innerHeight;
  const center = vh / 2;

  let best = null;
  let bestDist = Infinity;

  for (const c of state.candidates) {
    // Check if image is still connected (lazyload might have replaced it)
    if (!c.img.isConnected) {
      const newImg = c.element.querySelector("img, .img-preloader");
      if (newImg) c.img = newImg;
      else continue; // Should not happen usually, but skip if no img
    }

    const rect = c.img.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= vh) continue;
    if (!isInCenterBand(rect, vh)) continue;

    const dist = Math.abs(rect.top + rect.height / 2 - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }

  if (!best) {
    clearActive();
    return;
  }

  setActive(best);
}

function requestUpdate() {
  if (state.ticking) return;
  state.ticking = true;
  requestAnimationFrame(update);
}

function installGlobalListeners() {
  document.addEventListener(
    "pointerover",
    (event) => {
      const target = event.target;
      if (!target || !target.closest) return;

      if (state.active && target.closest(".auto-hover")) return;

      if (target.closest(interactiveSelector)) {
        state.hoveringInteractive = true;
        clearActive();
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      const related = event.relatedTarget;
      if (related && related.closest && related.closest(interactiveSelector)) return;
      state.hoveringInteractive = false;
      requestUpdate();
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      
      // Check if clicking on an image that is part of our candidates
      let clickedImage = false;
      if (target) {
        for (const c of state.candidates) {
          if (c.element.contains(target)) {
            clickedImage = true;
            break;
          }
        }
      }

      // If clicking image, long suspend. Else short suspend.
      const suspendTime = clickedImage ? 10000 : 1500;
      
      state.suspendUntil = Date.now() + suspendTime;
      state.hoveringInteractive = false;
      clearActive();
      
      if (state.resumeTimer) clearTimeout(state.resumeTimer);
      state.resumeTimer = setTimeout(() => {
        requestUpdate();
      }, suspendTime);
    },
    { passive: true },
  );

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", () => {
    refreshCandidates();
    requestUpdate();
  });

  try {
    swup.hooks.on("page:view", () => {
      refreshCandidates();
      requestUpdate();
    });
  } catch (e) {}
}

