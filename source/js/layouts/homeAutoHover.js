export default function initHomeAutoHover() {
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
    { passive: true }
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      const related = event.relatedTarget;
      if (related && related.closest && related.closest(interactiveSelector)) return;
      setUserHover(false);
    },
    { passive: true }
  );

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  requestUpdate();
}
