/**
 * The contents rail, while the article is being written.
 *
 * The published rail is rendered by Hexo's `toc()` helper from the article's
 * HTML, and it anchors on the heading ids that helper minted. Edit mode replaces
 * the article with editor blocks, so every one of those anchors stops resolving:
 * `layouts/toc.js` measured a list of nulls, put every heading at infinity, and
 * the rail sat there highlighting nothing and scrolling to nowhere.
 *
 * So the editor keeps it. The same markup the helper emits — `ol.nav`, nested
 * `ol.nav-child`, `li.nav-item.nav-level-N`, `a.nav-link > span.nav-text` — is
 * built from the heading blocks on the canvas, in document order, including the
 * ones inside a note or a tab pane. Anchors are the block elements' own ids, so
 * clicking an entry is an ordinary in-page jump; `refreshTOC` then re-measures.
 *
 * Rebuilt on every structural change and, debounced, on every keystroke in a
 * heading — a contents list that does not follow the heading you are currently
 * typing is worse than none, because it is confidently wrong.
 */

import { refreshTOC } from "../../layouts/toc.js";

const ANCHOR = "ed-h-";
const SETTLE_MS = 220;

let timer = 0;

function config() {
  const toc = (window.theme && window.theme.articles && window.theme.articles.toc) || {};
  return {
    depth: Math.min(6, Math.max(1, Number(toc.max_depth) || 6)),
    numbered: toc.number !== false,
  };
}

/** Every heading on the canvas, in the order the reader meets them. */
function headings(canvas) {
  const out = [];
  for (const el of canvas.querySelectorAll('.ed-block[data-type="heading"]')) {
    const node = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (!node) continue;
    const text = node.textContent.replace(/​/g, "").trim();
    if (!text) continue;
    if (!el.id) el.id = ANCHOR + (el.dataset.id || Math.random().toString(36).slice(2));
    out.push({ level: Number(node.tagName.slice(1)) || 2, text, id: el.id });
  }
  return out;
}

/**
 * The helper's own shape, which is a tree: a deeper heading opens `ol.nav-child`
 * INSIDE the `li` before it. Flattening it would style correctly and collapse
 * wrongly, since the rail's indentation and its active-parent rules both read
 * the nesting rather than the level class.
 */
function build(items, depth) {
  const root = document.createElement("ol");
  root.className = "nav";

  // One open `li` per level, so a heading knows which item to nest inside.
  const open = [];
  let list = root;

  for (const item of items) {
    if (item.level > depth) continue;

    while (open.length && open[open.length - 1].level >= item.level) open.pop();

    const parent = open[open.length - 1];
    if (parent) {
      if (!parent.kids) {
        parent.kids = document.createElement("ol");
        parent.kids.className = "nav-child";
        parent.li.appendChild(parent.kids);
      }
      list = parent.kids;
    } else {
      list = root;
    }

    const li = document.createElement("li");
    li.className = "nav-item nav-level-" + item.level;
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = "#" + item.id;
    const span = document.createElement("span");
    span.className = "nav-text";
    span.textContent = item.text;
    link.appendChild(span);
    li.appendChild(link);
    list.appendChild(li);

    open.push({ level: item.level, li, kids: null });
  }

  return root;
}

/** Rebuild the rail from the canvas. Cheap enough to call on any change. */
export function paintTOC(canvas) {
  const host = document.querySelector(".post-toc-wrap .post-toc");
  if (!host || !canvas) return;

  const { depth } = config();
  const next = build(headings(canvas), depth);

  const old = host.querySelector("ol.nav");
  // The list is the only thing replaced: the title and the post's name above it
  // belong to the page, not to this.
  if (old) old.replaceWith(next);
  else host.appendChild(next);

  refreshTOC();
}

/** Coalesce a burst of keystrokes into one rebuild. */
export function scheduleTOC(canvas) {
  clearTimeout(timer);
  timer = setTimeout(() => paintTOC(canvas), SETTLE_MS);
}

/* ─── giving it back ───────────────────────────────────────────────────────── */

/**
 * The published list, kept aside for the length of the session.
 *
 * Leaving edit mode puts the article back exactly as it was — the same nodes,
 * not a re-render — so the rail has to go back the same way. Rebuilding it from
 * the restored article would work and would also mint different ids from the
 * ones the anchors in that article already use.
 */
let held = null;

export function holdTOC(canvas) {
  const host = document.querySelector(".post-toc-wrap .post-toc");
  held = host ? host.querySelector("ol.nav") : null;
  paintTOC(canvas);
}

export function releaseTOC() {
  clearTimeout(timer);
  timer = 0;

  const host = document.querySelector(".post-toc-wrap .post-toc");
  if (host) {
    const now = host.querySelector("ol.nav");
    if (held && now) now.replaceWith(held);
    else if (held) host.appendChild(held);
    else if (now) now.remove();
  }
  held = null;
  refreshTOC();
}
