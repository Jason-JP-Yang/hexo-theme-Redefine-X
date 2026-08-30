import { runFlip, primeForFlipIn, animateHeight, setHomeVaultHook } from "../layouts/homePagination.js";
import initAutoHover, { syncHomeAutoHover } from "../layouts/autoHover.js";
import initBentoFit, { syncBentoFit } from "../layouts/bentoFit.js";
import initTileSpotlight from "../layouts/tileSpotlight.js";
import initCoverParallax, { syncCoverParallax } from "../layouts/coverParallax.js";
import initLazyLoad, { registerSrcResolver } from "../layouts/lazyload.js";
import { initTOC } from "../layouts/toc.js";
import { initMasonry } from "../plugins/masonry.js";
import imageViewer from "../tools/imageViewer.js";
import initCopyCode from "../tools/codeBlock.js";
import initMathJaxScroll from "../plugins/mathjax-scroll.js";
import { initNotoAnim } from "../plugins/noto-anim.js";
import { invalidateMetrics, requestScrollPass } from "../tools/scrollScheduler.js";
import { Picker } from "../tools/chipPicker.js";
import { refreshHomeRelativeTime } from "../utils.js";
import {
  b64urlToBytes,
  importAesKey,
  openText,
  openJSON,
  fetchSealed,
  vaultPrefix,
  siteRoot,
  variantPath,
  variantKey,
  taxHash,
  revealAssets,
  assetURL,
  dropAssetCache,
} from "../tools/vaultCrypto.js";

// Encrypted images ride the ordinary lazyload observer: it asks for a source
// when the image is about to be seen, and this is where the ciphertext is
// fetched and opened. Registered at module scope so it is in place before the
// first preloader can intersect.
registerSrcResolver((node) => assetURL(node.getAttribute("data-vault-asset")));

/**
 * Redefine-X — encrypted posts, reader side.
 *
 * The public build contains no trace of an encrypted post: not its body, not its
 * images, not its title, and not the tags or categories it is filed under. One
 * request to the Worker returns the keys this identity may use; everything after
 * that is a plain CDN fetch of an opaque blob plus local AES-GCM.
 *
 * Keys live in this module's closure and nowhere else — no localStorage, no
 * sessionStorage, no service worker cache — and are imported non-extractable.
 * Closing the tab revokes them; so does signing out, which also tears the
 * decrypted content back out of the page.
 *
 * ── What is pre-solved and what is not ──────────────────────────────────────
 *
 * The home grid is a constraint solve, so its arrangement is sealed at build
 * time, one per subset of readable posts (scripts/vault-generator.js). Every
 * OTHER listing — archive, tag page, category page, the tag cloud, the category
 * tree — has markup that is a pure function of the post's metadata, so it is
 * built HERE from the same record the home card came in, against the same
 * structure the theme's own templates emit.
 */

const INSERTED = "data-vault-inserted";

let grants = null;
let grantsPromise = null;
let lastIdentity = null;
let isAdmin = false;

// What the home grid looked like before a plan was applied, so signing out can
// put it back without a reload.
let homeSnapshot = null;

function i18n(key, fallback) {
  const table = (window.theme && window.theme.vault_i18n) || {};
  return table[key] || fallback;
}

async function callWorker(path, options) {
  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return null;
  const res = await fetch(base + path, {
    method: (options && options.method) || "GET",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.ok ? res.json().catch(() => ({})) : null;
}

/* ─── grants ───────────────────────────────────────────────────────────────── */

async function loadGrants(force) {
  if (!window.blogAuth) return null;

  const session = await window.blogAuth.getSession();
  const identity = session ? String(session.id) : null;
  if (identity !== lastIdentity) {
    grants = null;
    grantsPromise = null;
    lastIdentity = identity;
  }
  if (!session || !session.token) return null;
  if (!force && grants) return grants;
  if (!force && grantsPromise) return grantsPromise;

  const base = window.blogAuth.resolveApiBase();
  if (!base) return null;

  grantsPromise = fetch(base + "/api/vault/keys", {
    method: "POST",
    headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
    body: "{}",
  })
    .then((res) => (res.ok ? res.json() : null))
    .then(async (data) => {
      if (!data || !Array.isArray(data.posts)) return null;
      const map = new Map();
      for (const post of data.posts) {
        const raw = b64urlToBytes(post.key);
        // Re-use the record already in hand for an id whose key has not moved:
        // it carries the decrypted card and metadata, and re-fetching them on
        // every navigation is a request per post for nothing.
        const previous = grants && grants.get(post.id);
        map.set(post.id, {
          id: post.id,
          slug: post.slug,
          raw,
          key: await importAesKey(raw),
          meta: previous && previous.slug === post.slug ? previous.meta : undefined,
          card: previous && previous.slug === post.slug ? previous.card : null,
        });
      }
      isAdmin = !!data.admin;
      grants = map;
      return map;
    })
    .catch(() => null)
    .then((result) => {
      grantsPromise = null;
      return result;
    });

  return grantsPromise;
}

/**
 * The card blob is the only place an encrypted post's title, date and taxonomy
 * exist outside the Worker's key row. One fetch per post serves every listing on
 * the site.
 */
async function hydrateMeta(map) {
  await Promise.all(
    Array.from(map.values(), async (entry) => {
      if (entry.meta !== undefined) return;
      entry.meta = null;
      try {
        const sealed = await fetchSealed(`${vaultPrefix()}/${entry.slug}/c.bin`);
        if (!sealed) return;
        const record = await openJSON(entry.key, sealed);
        entry.meta = record.meta || null;
        const holder = document.createElement("div");
        holder.innerHTML = String(record.card || "").trim();
        entry.card = holder.firstElementChild;
        if (entry.card) await revealAssets(entry.card, entry.raw);
      } catch (e) {
        /* a post whose record will not open stays invisible rather than broken */
      }
    })
  );
}

/** Granted POSTS that carry metadata, newest first. Albums share the keyring and
 *  the same blob layout, but belong to no post listing. */
function readable(map) {
  return Array.from(map.values())
    .filter((entry) => entry.meta && entry.meta.kind !== "album" && entry.meta.date)
    .sort((a, b) => Date.parse(b.meta.date) - Date.parse(a.meta.date));
}

/** Granted masonry albums, in the order the Worker returned them. */
function readableAlbums(map) {
  return Array.from(map.values()).filter((entry) => entry.meta && entry.meta.kind === "album");
}

/* ─── the post page ────────────────────────────────────────────────────────── */

function setGate(gate, phase) {
  gate.dataset.vaultState = phase;
  gate.querySelector(".vault-gate-probe").hidden = phase !== "probing";
  gate.querySelector(".vault-gate-notfound").hidden = phase !== "denied";
}

/** Plaintext is in the DOM and the session is gone: leave. `replace`, so Back
 *  cannot return to the decrypted page. */
function leavePage() {
  location.replace(siteRoot() + "/");
}

/**
 * Opening the post re-asks the Worker rather than trusting the list already in
 * hand: this is the moment worth a live authorization, and it costs one request
 * and one primary-key row.
 */
async function unlockPost(gate) {
  const slug = gate.dataset.vaultSlug;
  if (!slug) return;

  setGate(gate, "probing");

  const map = await loadGrants(true);
  const entry = map && Array.from(map.values()).find((g) => g.slug === slug);
  if (!entry) {
    setGate(gate, "denied");
    settle();
    return;
  }

  try {
    const sealed = await fetchSealed(`${vaultPrefix()}/${slug}/b.bin`);
    if (!sealed) throw new Error("body missing");

    const host = gate.querySelector(".vault-article-host");
    host.innerHTML = await openText(entry.key, sealed);
    // Binds every sealed image and resolves only what the lazy pipeline cannot
    // drive. The rest arrive as they are scrolled to, so an album of two hundred
    // photographs opens as fast as one of two.
    await revealAssets(host, entry.raw);

    const isAlbum = gate.dataset.vaultKind === "masonry";
    if (isAdmin && !isAlbum) mountAudienceEditor(host, entry);

    setGate(gate, "open");
    if (isAlbum) rehydrateAlbum(host);
    else rehydrate(host);

    host.animate(
      [
        { opacity: 0, transform: "translateY(14px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 460, easing: "cubic-bezier(0.16, 0.84, 0.28, 1)", fill: "backwards" }
    );
    settle();
  } catch (e) {
    setGate(gate, "denied");
  }
}

/**
 * Everything the theme wires on a real post page, for content that arrived late.
 *
 * Each subsystem is isolated. They used to share one try block, and the table of
 * contents throwing on a page with no tools rail took the three that ran after
 * it — MathJax scrolling, animated emoji, and the typeset pass — down with it.
 *
 * The classic scripts (EXIF cards, error books, tabs, pangu) self-initialise on
 * Swup's `page:view`, which never fires for content mounted inside a page that
 * is already open, so they are told directly.
 */
function rehydrate(root) {
  const theme = window.theme || {};
  const step = (fn) => {
    try {
      fn();
    } catch (e) {
      /* one dead subsystem must not take the article down with it */
    }
  };

  step(() => theme.articles?.code_block?.copy === true && initCopyCode());
  step(
    () =>
      theme.articles?.lazyload === true &&
      initLazyLoad({ preload: theme.articles.lazyload_preload === true })
  );
  step(() => theme.articles?.toc?.enable === true && initTOC());
  step(() => initMathJaxScroll());
  step(() => initNotoAnim());
  step(() => window.MathJax?.typesetPromise && window.MathJax.typesetPromise([root]));
  step(() => window.dispatchEvent(new CustomEvent("redefine:content-injected", { detail: { root } })));
  step(() => window.dispatchEvent(new CustomEvent("redefine:content-resized")));
}

/** The same, for a decrypted masonry album: columns, overflow check, EXIF cards
 *  and the viewer, none of which the post pipeline wires. */
function rehydrateAlbum(root) {
  const theme = window.theme || {};
  const step = (fn) => {
    try {
      fn();
    } catch (e) {
      /* one dead subsystem must not take the album down with it */
    }
  };

  step(() => initMasonry());
  step(
    () =>
      theme.articles?.lazyload === true &&
      initLazyLoad({ preload: theme.articles.lazyload_preload === true })
  );
  // The scroll-triggered captions. Its observer is wired once per page view,
  // which for a gallery mounted inside an already-open page has been and gone.
  step(() => initAutoHover());
  step(() => imageViewer());
  step(() => window.dispatchEvent(new CustomEvent("redefine:content-injected", { detail: { root } })));
  step(() => window.dispatchEvent(new CustomEvent("redefine:content-resized")));
}

/** The management console's chip field, above the article, for an admin. */
async function mountAudienceEditor(host, entry) {
  // OUTSIDE `.article-content`. Inside it the field is inside `.markdown-body`,
  // whose `img` rule — display:block, width:auto, a 1rem margin and a zoom
  // cursor — outranks the chip avatar's own size and turns every reader in the
  // audience into a full-width centred photograph.
  const container = host.querySelector(".article-content-container");
  const anchor = host.querySelector(".article-content");
  if (!container || container.dataset.vaultAdmin === "1") return;
  container.dataset.vaultAdmin = "1";

  // The article's inset is a utility on `.article-content`, not a width on the
  // container, so a box beside it has to carry the same one or it runs to the edge.
  const wrap = document.createElement("div");
  wrap.className = "vault-admin-wrap px-2 sm:px-6 md:px-8";

  const box = document.createElement("div");
  box.className = "vault-admin";
  box.innerHTML = `
    <label class="vault-admin-label">
      <i class="fa-regular fa-user-lock" aria-hidden="true"></i>
      <span>${i18n("audience", "Who can read this")}</span>
      <span class="vault-admin-state" role="status"></span>
    </label>
    <div class="vault-admin-picker"></div>`;
  wrap.appendChild(box);
  container.insertBefore(wrap, anchor || container.firstChild);

  const flag = box.querySelector(".vault-admin-state");
  const picker = new Picker(entry.id, box.querySelector(".vault-admin-picker"), {
    placeholder: i18n("placeholder", "GitHub login or numeric id, then Enter"),
    t: i18n,
    lookup: async (raw) => {
      const data = await callWorker("/api/admin/lookup", { method: "POST", body: { ids: [raw] } });
      return { ok: !!data, matched: (data && data.matched) || [] };
    },
    onCommit: async (p) => {
      if (!p.settled) return void (flag.innerHTML = "");
      flag.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>`;
      const data = await callWorker(`/api/admin/vault/${encodeURIComponent(entry.id)}/audience`, {
        method: "PUT",
        body: { audience: p.entries },
      });
      flag.innerHTML = data
        ? `<i class="fa-solid fa-check" aria-hidden="true"></i>`
        : `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>`;
      if (data) setTimeout(() => (flag.innerHTML = ""), 1800);
    },
  });

  const listing = await callWorker("/api/admin/vault?offset=0");
  const row = listing && (listing.posts || []).find((r) => r.id === entry.id);
  if (row) picker.set(row.audience || []);
}

/* ─── the home grid ────────────────────────────────────────────────────────── */

function dateOf(node) {
  const el = node.querySelector(".home-article-date[data-date], time[datetime]");
  return el ? Date.parse(el.dataset.date || el.getAttribute("datetime")) : NaN;
}

/**
 * Which granted posts belong on the page currently rendered. The build assigns
 * an encrypted post to the page whose date range contains it; the same rule is
 * applied here from the dates already in the DOM, so no published index of
 * encrypted posts is needed.
 *
 * Sticky cards are excluded from the range exactly as the build excludes them:
 * they are pinned to the front regardless of date.
 */
function postsForThisPage(map, cards, page, isLastPage) {
  const all = Array.from(map.entries()).filter(([, entry]) => entry.meta && entry.meta.date);
  if (!cards.length) return all;

  const dates = cards
    .filter((card) => !card.querySelector(".home-article-sticky-badge"))
    .map(dateOf)
    .filter((d) => !isNaN(d));
  if (!dates.length) return [];
  const oldest = Math.min.apply(null, dates);
  const newest = Math.max.apply(null, dates);

  return all.filter(([, entry]) => {
    const when = Date.parse(entry.meta.date);
    if (isNaN(when)) return false;
    if (page === 1 && when >= oldest) return true;
    if (isLastPage && when <= newest) return true;
    return when >= oldest && when <= newest;
  });
}

async function variantFor(page, entries) {
  const keys = entries.map(([, e]) => e.raw);
  const sealed = await fetchSealed(`${vaultPrefix()}/g/${await variantPath(page, keys)}.bin`);
  if (!sealed) return null;
  return openJSON(await variantKey(page, keys), sealed);
}

/**
 * Resolve the arrangement for one home list and return the function that applies
 * it — deliberately split, because the paginator has to do the fetching while
 * the previous page is still on screen and the applying while the incoming list
 * is still off-document. An `await` between the two would give the browser a
 * paint in which the new cards are flat, visible and about to be flipped.
 *
 * `source` is the list the page numbers and dates are read from; it may be an
 * inert parsed document.
 */
async function prepareHome(map, source) {
  if (!map || !map.size) return null;

  const root = document.querySelector(".home-pagination");
  const page = Number(source.dataset.page) || 1;
  const total = Number(root && root.dataset.total) || 1;

  await hydrateMeta(map);
  const mine = postsForThisPage(
    map,
    Array.from(source.querySelectorAll(".home-article-item")),
    page,
    page >= total
  );
  if (!mine.length) return null;

  const plan = await variantFor(page, mine);
  if (!plan) return null;

  const cards = mine.filter(([, e]) => e.card).map(([id, e]) => ({ id, node: e.card }));
  if (!cards.length) return null;

  return (list) => applyPlan(list, plan, cards);
}

/** Every tile in a grid, in DOM order. */
function tilesOf(list) {
  return Array.from(list.querySelectorAll(".home-article-item, .home-feature-tile"));
}

/**
 * Turn the whole grid over — every tile, not just the ones on screen. `runFlip`
 * leaves its end state applied (`fill: both`), and the viewport set was measured
 * twice, so a tile that left the first set and did not join the second stayed
 * pinned edge-on at opacity 0: a card that simply disappears.
 */
async function flipGrid(list, mutate) {
  const animate = !prefersReducedMotion();
  if (animate) await runFlip(tilesOf(list), "out");

  mutate();

  list.classList.add("is-flipping");
  resettleGrid();
  refreshHomeRelativeTime();

  const entering = animate ? tilesOf(list) : [];
  entering.forEach((card) => primeForFlipIn(card));
  if (entering.length) await runFlip(entering, "in");
  entering.forEach((card) => card.classList.add("has-entered"));
  list.classList.remove("is-flipping");
  settle();
}

/**
 * One reflow at a time, queued rather than dropped: a sign-out that gave up
 * because a sign-in was still animating would leave the decrypted cards up.
 */
let homeQueue = Promise.resolve();

function queueHome(task) {
  homeQueue = homeQueue.then(task, task).catch(() => {});
  return homeQueue;
}

async function unlockHome(map) {
  const list = document.querySelector(".home-article-list");
  if (!list || list.dataset.vaultApplied === "1") return;

  const apply = await prepareHome(map, list);
  if (!apply) return;

  return queueHome(async () => {
    // Re-checked inside the queue: whatever ran ahead may have applied or
    // reverted this very list.
    if (!list.isConnected || list.dataset.vaultApplied === "1") return;
    await flipGrid(list, () => apply(list));
  });
}

function resettleGrid() {
  initBentoFit();
  syncBentoFit();
  initCoverParallax();
  syncCoverParallax();
  initAutoHover();
  syncHomeAutoHover();
  initTileSpotlight();
}

/**
 * The arrangement is applied, never computed. Every tile — the site cards and
 * the public posts included — takes the placement the build solved for this
 * exact set of posts.
 *
 * The site cards matter as much as the posts: they are laid out by the same
 * solve, so a different post set moves them. Leaving them on the public plan's
 * rows put them on top of tiles that had moved underneath, which is what made
 * cards disappear.
 */
function applyPlan(list, plan, cards) {
  const byId = new Map(cards.map((c) => [c.id, c.node]));
  const nodes = new Map();
  const items = Array.from(list.querySelectorAll(".home-article-item"));

  for (const item of items) {
    const link = item.querySelector(".home-article-title a");
    if (link) nodes.set(normalizePath(new URL(link.href, location.href).pathname), item);
  }

  // Taken on every pass, including the paginator's: what it captures is the
  // public arrangement of the list about to be shown, which is exactly what
  // signing out has to put back.
  homeSnapshot = {
    list,
    lgRows: list.dataset.lgRows,
    mdRows: list.dataset.mdRows,
    children: Array.from(list.children),
    tiles: Array.from(list.querySelectorAll(".home-article-item, .home-feature-tile"), (el) => ({
      el,
      className: el.className,
      style: el.getAttribute("style") || "",
    })),
  };

  const placed = new Set();
  const ordered = [];
  for (const id of plan.order || []) {
    const node = byId.get(id) || nodes.get(normalizePath(id));
    // A repeated id, or two ids resolving to one node, would hand the same node
    // to replaceChildren twice — which moves it rather than copying it, and
    // silently drops it from the first position.
    if (!node || placed.has(node)) continue;
    placeTile(node, plan.tiles[id]);
    placed.add(node);
    ordered.push(node);
  }

  // A tile the plan does not name is a tile the build and the browser disagree
  // about. It keeps its own geometry and stays on the page: dropping it is how a
  // card silently vanished.
  const orphans = items.filter((item) => !placed.has(item));

  const features = Array.from(list.querySelectorAll(".home-feature-tile"));
  features.forEach((node, i) => placeTile(node, (plan.features || [])[i]));

  list.replaceChildren(...features, ...ordered, ...orphans);
  if (plan.lgRows) list.dataset.lgRows = String(plan.lgRows);
  if (plan.mdRows) list.dataset.mdRows = String(plan.mdRows);
  list.dataset.vaultApplied = "1";
  renumber(list);
}

function placeTile(node, tile) {
  // A decrypted card is one long-lived node moved between grids, so it can
  // arrive still carrying a finished flip's end state: edge-on and invisible.
  if (typeof node.getAnimations === "function") {
    node.getAnimations().forEach((animation) => animation.cancel());
  }
  node.style.willChange = "";
  node.style.backfaceVisibility = "";
  node.style.transform = "";
  node.style.opacity = "";
  node.style.filter = "";

  if (!tile) return;
  if (tile.tier) {
    node.className = node.className.replace(/\btier-[a-z]+\b/g, "").trim();
    node.classList.add("tier-" + tile.tier);
  }
  node.classList.remove("lg-split", "md-split", "cover-right");
  for (const cls of String(tile.classes || "").trim().split(/\s+/)) {
    if (cls) node.classList.add(cls);
  }
  for (const decl of String(tile.style || "").split(";")) {
    const [prop, value] = decl.split(":");
    if (prop && value) node.style.setProperty(prop.trim(), value.trim());
  }
}

/**
 * The running numeral is the tile's position on the page, and the page just
 * gained a tile. The build renders an encrypted card with no number at all,
 * because which one it should carry depends on who is reading.
 */
function renumber(list) {
  const badges = Array.from(list.querySelectorAll(".home-article-index"));
  const first = badges
    .map((el) => Number(el.textContent.trim()))
    .filter((n) => n > 0)
    .sort((a, b) => a - b)[0];
  const base = first || 1;
  badges.forEach((el, i) => (el.textContent = String(base + i)));
}

/**
 * Put the public grid back, exactly as the build shipped it — and turn it over
 * to get there. Arriving is a page turn; leaving is the same page turn.
 */
function revertHome() {
  return queueHome(async () => {
    // Read inside the queue: an unlock still waiting its turn has not taken its
    // snapshot yet, and this has to undo the state that actually lands.
    const snap = homeSnapshot;
    homeSnapshot = null;
    if (!snap || !snap.list.isConnected) return;

    await flipGrid(snap.list, () => {
      for (const t of snap.tiles) {
        t.el.className = t.className;
        if (t.style) t.el.setAttribute("style", t.style);
        else t.el.removeAttribute("style");
      }
      snap.list.replaceChildren(...snap.children);
      if (snap.lgRows) snap.list.dataset.lgRows = snap.lgRows;
      if (snap.mdRows) snap.list.dataset.mdRows = snap.mdRows;
      delete snap.list.dataset.vaultApplied;
      renumber(snap.list);
      // The decrypted covers have left the page, so the blob URLs holding them
      // can go with them.
      dropAssetCache();
    });
  });
}

/* ─── archive, tag and category listings ───────────────────────────────────── */
//
// All three render through utils/posts-list.ejs, so all three are built here
// against that one structure: a section per year, an `<li>` per calendar day,
// and an `<a>` per post inside it. Nothing about it depends on who is reading,
// which is exactly why none of it is pre-generated.

const pad = (n) => String(n).padStart(2, "0");

function dayKey(date) {
  return pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function linkFor(meta) {
  const a = document.createElement("a");
  a.className = "block w-fit vault-archive-link";
  a.href = meta.href;
  a.setAttribute(INSERTED, "1");
  a.innerHTML =
    `<span class="article-title my-0.5 text-2xl">` +
    `<i class="fa-regular fa-lock-keyhole vault-archive-lock" aria-hidden="true" title="${escapeAttr(
      i18n("authorized", "Encrypted")
    )}"></i>` +
    `<span class="vault-archive-title"></span></span>`;
  a.querySelector(".vault-archive-title").textContent = meta.title;
  return a;
}

function dayItem(key) {
  const li = document.createElement("li");
  li.className =
    "article-item space-y-2 px-6 pt-10 pb-2 text-xl relative border-l-2 border-border-color";
  li.setAttribute("date-is", key);
  li.setAttribute(INSERTED, "1");
  return li;
}

function yearSection(year) {
  const section = document.createElement("section");
  section.className = "archive-item mb-spacing-unit last:mb-0";
  section.setAttribute(INSERTED, "1");
  section.innerHTML =
    `<div class="archive-item-header flex flex-row items-center mb-2">` +
    `<span class="archive-year font-semibold text-3xl mr-2">${year}</span>` +
    `<span class="archive-year-post-count text-xs md:text-sm font-bold rounded-small ` +
    `bg-third-background-color py-[2px] px-[10px] border border-border-color">0</span></div>` +
    `<ul class="article-list pl-0 md:pl-8 text-lg leading-[1.5]"></ul>`;
  return section;
}

/** The day an existing `<li>` stands for, as a timestamp. */
function itemTime(li, year) {
  const key = li.getAttribute("date-is") || "";
  const [month, day] = key.split("-").map(Number);
  return month && day ? new Date(year, month - 1, day).getTime() : NaN;
}

function bumpCount(el, by) {
  if (!el) return;
  if (el.dataset.vaultBase === undefined) el.dataset.vaultBase = el.textContent.trim();
  el.textContent = String(Number(el.textContent.trim() || 0) + by);
}

/** Insert one post into the archive structure rooted at `container`. */
function insertArchivePost(container, meta) {
  const when = new Date(meta.date);
  const year = when.getFullYear();
  const key = dayKey(when);

  let section = Array.from(container.querySelectorAll(".archive-item")).find(
    (s) => Number(s.querySelector(".archive-year")?.textContent.trim()) === year
  );

  if (!section) {
    section = yearSection(year);
    const after = Array.from(container.querySelectorAll(".archive-item")).find(
      (s) => Number(s.querySelector(".archive-year")?.textContent.trim()) < year
    );
    container.insertBefore(section, after || null);
  }

  const list = section.querySelector(".article-list");
  let item = Array.from(list.children).find((li) => li.getAttribute("date-is") === key);

  if (!item) {
    item = dayItem(key);
    const after = Array.from(list.children).find((li) => itemTime(li, year) < when.getTime());
    list.insertBefore(item, after || null);
  }

  item.appendChild(linkFor(meta));
  bumpCount(section.querySelector(".archive-year-post-count"), 1);
}

const ARCHIVE_ROOTS = [".archive-container", ".tag-post-list", ".category-post-list"];

/**
 * Which granted posts belong on THIS listing. The archive takes everything; a
 * tag or category page takes what its own URL names, matched against the paths
 * in the decrypted metadata rather than against the heading, so a renamed
 * heading or a translated one cannot mis-file a post.
 */
function postsForListing(entries, root) {
  if (root.classList.contains("archive-container")) return entries;

  const here = normalizePath(location.pathname);
  const field = root.classList.contains("tag-post-list") ? "tags" : "categories";
  return entries.filter((entry) =>
    (entry.meta[field] || []).some((t) => normalizePath(t.path) === here)
  );
}

async function unlockArchiveLike(map) {
  const root = ARCHIVE_ROOTS.map((s) => document.querySelector(s)).find(Boolean);
  if (!root || root.dataset.vaultApplied === "1") return;

  const container = root.querySelector(".archive-list-container");
  if (!container) return;

  const mine = postsForListing(readable(map), root);
  if (!mine.length) return;

  root.dataset.vaultApplied = "1";
  await animateHeight(root, () => {
    for (const entry of mine) insertArchivePost(container, entry.meta);
  });

  for (const node of container.querySelectorAll(`.vault-archive-link[${INSERTED}]`)) {
    node.animate(
      [
        { opacity: 0, transform: "translateY(14px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 420, delay: 40, easing: "cubic-bezier(0.16, 0.84, 0.28, 1)", fill: "backwards" }
    );
  }
  settle();
}

/* ─── the tag cloud and the category tree ──────────────────────────────────── */

/**
 * Every distinct tag (or category) across the readable posts, with its count.
 *
 * `href` came sealed with the metadata: a taxonomy the post shares with a public
 * one keeps its ordinary page, and one that exists only inside encrypted posts —
 * which therefore has no page, because publishing one would disclose its name to
 * anyone who guessed the URL — points at the taxonomy gate, named by a hash in a
 * fragment no server ever sees.
 */
function taxonomyOf(entries, field) {
  const out = new Map();
  for (const entry of entries) {
    for (const item of entry.meta[field] || []) {
      const row = out.get(item.path) || { ...item, count: 0 };
      row.count++;
      out.set(item.path, row);
    }
  }
  return out;
}

function findTaxLink(scope, path) {
  const target = normalizePath(path);
  return Array.from(scope.querySelectorAll("a[href]")).find(
    (a) => normalizePath(new URL(a.href, location.href).pathname) === target
  );
}

async function unlockTagCloud(map) {
  const scope = document.querySelector(".tagcloud-content");
  if (!scope || scope.dataset.vaultApplied === "1") return;

  const rows = taxonomyOf(readable(map), "tags");
  if (!rows.size) return;
  scope.dataset.vaultApplied = "1";

  const list = scope.querySelector(".tag-list");
  for (const row of rows.values()) {
    const link = findTaxLink(scope, row.path);
    if (link) {
      if (link.hasAttribute("data-weight")) bumpAttr(link, "data-weight", row.count);
      continue;
    }

    const a = document.createElement("a");
    a.className = "vault-tax-link";
    a.href = row.href;
    a.setAttribute("data-weight", String(row.count));
    a.innerHTML = `<i class="fa-solid fa-hashtag"></i><i class="fa-regular fa-lock-keyhole vault-tax-lock" aria-hidden="true"></i>`;
    a.appendChild(document.createTextNode(row.name));

    // `blur` style wraps every chip in a list item; `cloud` style lays the
    // anchors out directly. Both are the theme's own markup for a tag.
    const node = list ? document.createElement("li") : a;
    if (list) {
      node.appendChild(a);
      list.appendChild(node);
    } else {
      scope.appendChild(node);
    }
    node.setAttribute(INSERTED, "1");
    reveal(node);
  }
  settle();
}

async function unlockCategoryTree(map) {
  const scope = document.querySelector(".category-list-content");
  if (!scope || scope.dataset.vaultApplied === "1") return;

  const rows = taxonomyOf(readable(map), "categories");
  if (!rows.size) return;
  scope.dataset.vaultApplied = "1";

  // Shallowest first, so a parent that is itself new exists by the time its
  // child looks for the list to go in.
  const ordered = Array.from(rows.values()).sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  );

  for (const row of ordered) {
    const link = findTaxLink(scope, row.path);
    if (link) {
      bumpCount(link.parentElement.querySelector(":scope > .all-category-list-count"), row.count);
      continue;
    }

    const parentLink = row.parent ? findTaxLink(scope, row.parent) : null;
    let host = scope.querySelector(".all-category-list");
    if (parentLink) {
      const parentItem = parentLink.parentElement;
      host = parentItem.querySelector(".all-category-list-child");
      if (!host) {
        host = document.createElement("ul");
        host.className = "all-category-list-child";
        parentItem.appendChild(host);
      }
    }
    if (!host) continue;

    const li = document.createElement("li");
    li.className = "all-category-list-item";
    li.setAttribute(INSERTED, "1");
    const a = document.createElement("a");
    a.className = "all-category-list-link vault-tax-link";
    a.href = row.href;
    a.innerHTML = `<i class="fa-regular fa-lock-keyhole vault-tax-lock" aria-hidden="true"></i>`;
    a.appendChild(document.createTextNode(row.name));
    const count = document.createElement("span");
    count.className = "all-category-list-count";
    count.textContent = String(row.count);
    li.append(a, count);
    host.appendChild(li);
    reveal(li);
  }
  settle();
}

function bumpAttr(el, attr, by) {
  const base = el.getAttribute("data-vault-base-" + attr);
  if (base === null) el.setAttribute("data-vault-base-" + attr, el.getAttribute(attr) || "0");
  el.setAttribute(attr, String(Number(el.getAttribute(attr) || 0) + by));
}

/* ─── the album collection ─────────────────────────────────────────────────── */

/**
 * Put the decrypted albums back on the collection page, in their own places.
 *
 * The card is the one the build rendered from the theme's own
 * masonry-collection-card partial, so a decrypted album is not a lookalike of a
 * public one — it is the same markup, thumbnail, avatar and all.
 *
 * Where each one goes travels sealed with it, as a slot counting PUBLIC siblings
 * only (`pos` within a category, `catPos` between categories). That number is
 * the same for every reader, which is what lets it be decided at build time
 * without publishing so much as a gap in the sequence; `index`/`catIndex` order
 * the encrypted entries against each other when several claim one slot.
 *
 * Both levels are therefore filled BACK TO FRONT: everything already inserted
 * sits at a slot at or after the one being claimed, so it ends up after it.
 */
async function unlockMasonry(map) {
  const root = document.querySelector(".friends-link-container");
  if (!root || root.dataset.vaultApplied === "1") return;

  const groups = albumGroups(map);
  if (!groups.length) return;
  root.dataset.vaultApplied = "1";

  await animateHeight(root, () => {
    for (let g = groups.length - 1; g >= 0; g--) {
      const group = groups[g];
      const list = albumList(root, group);
      for (let i = group.items.length - 1; i >= 0; i--) {
        const entry = group.items[i];
        entry.card.setAttribute(INSERTED, "1");
        list.insertBefore(entry.card, list.children[entry.meta.pos || 0] || null);
        reveal(entry.card);
      }
    }
  });
  settle();
}

/** The readable albums by category, each group's cards in build order and the
 *  groups themselves in the order their headings appear on the page. */
function albumGroups(map) {
  const byName = new Map();
  for (const entry of readableAlbums(map)) {
    if (!entry.card) continue;
    const name = entry.meta.category || "";
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
  }

  return Array.from(byName, ([name, items]) => {
    items.sort((a, b) => (a.meta.index || 0) - (b.meta.index || 0));
    return {
      name,
      items,
      pos: items[0].meta.catPos || 0,
      index: items[0].meta.catIndex || 0,
      thumbs: !!items[0].meta.thumbs,
    };
  }).sort((a, b) => a.pos - b.pos || a.index - b.index);
}

/**
 * The list a category's albums belong in. A category whose albums are ALL
 * encrypted has no heading in the public build — publishing one would name it —
 * so its heading and list are built here, at the slot it would have occupied.
 */
function albumList(root, group) {
  const existing = root.querySelector(`ul[data-masonry-category="${cssEscape(group.name)}"]`);
  if (existing) return existing;

  const heading = document.createElement("div");
  heading.className = "mt-2 mb-4";
  heading.setAttribute("data-masonry-heading", group.name);
  heading.setAttribute(INSERTED, "1");
  heading.innerHTML = `<h2 class="text-2xl font-bold"></h2>`;
  heading.firstElementChild.textContent = group.name;

  const list = document.createElement("ul");
  list.className = group.thumbs
    ? "grid mb-6 w-full gap-4 grid-cols-2"
    : "grid mb-6 w-full gap-4 grid-cols-2 sm:grid-cols-3";
  list.setAttribute("data-masonry-category", group.name);
  list.setAttribute("data-masonry-thumbs", String(group.thumbs));
  list.setAttribute(INSERTED, "1");

  // A heading inserted by an earlier pass carries the same attribute, which is
  // what keeps the back-to-front walk landing on the right one.
  const anchor =
    root.querySelectorAll("[data-masonry-heading]")[group.pos] || root.querySelector(".clear");
  root.insertBefore(heading, anchor || null);
  root.insertBefore(list, anchor || null);
  return list;
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

/* ─── the taxonomy gate ────────────────────────────────────────────────────── */

async function unlockListingGate(gate) {
  // Re-entered on every hash change, so the previous taxonomy's list has to go
  // before the probing card is put back over the top of it.
  const host = gate.querySelector(".vault-listing-host");
  host.innerHTML = "";
  setGate(gate, "probing");

  // Forced only on the way in. A hash change is the reader moving between two
  // taxonomies they were already authorized for a moment ago.
  const map = await loadGrants(!grants);
  if (!map || !map.size) {
    setGate(gate, "denied");
    return void settle();
  }

  await hydrateMeta(map);
  const entries = readable(map);
  const hash = String(location.hash || "").replace(/^#/, "");
  const [, kind, wanted] = /^(t|c)=([0-9a-f]{16})$/.exec(hash) || [];

  let name = "";
  let matched = [];
  if (kind) {
    const field = kind === "t" ? "tags" : "categories";
    const seen = new Map();
    for (const entry of entries) {
      for (const item of entry.meta[field] || []) {
        if (!seen.has(item.name)) seen.set(item.name, await taxHash(kind === "t" ? "tag" : "category", item.name));
      }
    }
    for (const [candidate, digest] of seen) {
      if (digest === wanted) name = candidate;
    }
    matched = name
      ? entries.filter((entry) => (entry.meta[field] || []).some((i) => i.name === name))
      : [];
  }

  if (!kind || !name) {
    setGate(gate, "denied");
    return void settle();
  }

  host.innerHTML =
    `<div class="vault-listing-head">` +
    `<span class="vault-listing-kind"></span>` +
    `<h1 class="vault-listing-name"><i class="fa-regular fa-lock-keyhole"></i><span></span></h1>` +
    `</div><div class="archive-container"><div class="archive-list-container"></div></div>`;

  host.querySelector(".vault-listing-kind").textContent =
    kind === "t"
      ? i18n("list_tag", "Encrypted posts tagged")
      : i18n("list_category", "Encrypted posts in");
  host.querySelector(".vault-listing-name span").textContent = name;

  const container = host.querySelector(".archive-list-container");
  if (matched.length) {
    for (const entry of matched) insertArchivePost(container, entry.meta);
  } else {
    container.innerHTML = `<p class="vault-listing-empty"></p>`;
    container.firstElementChild.textContent = i18n(
      "list_empty",
      "No encrypted post here is readable by this identity."
    );
  }

  setGate(gate, "open");
  reveal(host);
  settle();
}

/* ─── reverting ────────────────────────────────────────────────────────────── */

function revertListings() {
  document.querySelectorAll(`[${INSERTED}]`).forEach((node) => node.remove());

  document.querySelectorAll("[data-vault-base]").forEach((el) => {
    el.textContent = el.dataset.vaultBase;
    delete el.dataset.vaultBase;
  });
  document.querySelectorAll("[data-vault-base-data-weight]").forEach((el) => {
    el.setAttribute("data-weight", el.getAttribute("data-vault-base-data-weight"));
    el.removeAttribute("data-vault-base-data-weight");
  });
  document.querySelectorAll("[data-vault-applied]").forEach((el) => {
    if (!el.classList.contains("home-article-list")) delete el.dataset.vaultApplied;
  });
  settle();
}

/* ─── plumbing ─────────────────────────────────────────────────────────────── */

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function reveal(node) {
  if (prefersReducedMotion()) return;
  node.animate(
    [
      { opacity: 0, transform: "translateY(12px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 420, easing: "cubic-bezier(0.16, 0.84, 0.28, 1)", fill: "backwards" }
  );
}

function normalizePath(value) {
  const root = siteRoot();
  let path = String(value);
  if (root && path.startsWith(root)) path = path.slice(root.length);
  try {
    path = decodeURI(path);
  } catch (e) {
    /* a malformed escape is not a path we can match anyway */
  }
  return path.replace(/^\/+|\/+$/g, "");
}

function settle() {
  invalidateMetrics();
  requestScrollPass();
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

/** Signing out must take the plaintext back out of the page, everywhere. */
async function onSignOut() {
  grants = null;
  grantsPromise = null;
  isAdmin = false;

  // A decrypted article or listing is a page this browser is no longer entitled
  // to be on. There is nothing to unwind: leave.
  const gate = document.querySelector(".vault-gate");
  if (gate && gate.dataset.vaultState === "open") return void leavePage();

  await revertHome();
  revertListings();
  dropAssetCache();
}

let wired = false;

export default async function initVault() {
  if (!window.crypto?.subtle) return;
  if (!window.theme?.backend?.vault_enable) return;

  if (!wired) {
    wired = true;
    window.addEventListener("blog:auth-change", async () => {
      const session = window.blogAuth && (await window.blogAuth.getSession());
      if (!session || !session.token) return void onSignOut();
      // A refreshed token for the reader already on the page changes nothing;
      // re-applying would flash the grid for no reason. A DIFFERENT reader may
      // read a different set of posts, so the public page goes back first.
      if (String(session.id) === lastIdentity) return;
      revertHome();
      revertListings();
      grants = null;
      grantsPromise = null;
      initVault();
    });

    // Turning a home page swaps the whole list for one rendered from the public
    // build, which has no encrypted card in it. The paginator hands the list
    // over before it is inserted, so the reflow happens inside the page turn
    // rather than as a second, visible one after it.
    setHomeVaultHook(async (source) => {
      const map = await loadGrants(false);
      return map && map.size ? prepareHome(map, source) : null;
    });

    window.addEventListener("hashchange", () => {
      const gate = document.querySelector("[data-vault-listing]");
      if (gate) unlockListingGate(gate);
    });
  }

  const listing = document.querySelector("[data-vault-listing]");
  if (listing) return void unlockListingGate(listing);

  const gate = document.querySelector(".vault-gate");
  if (gate) return void unlockPost(gate);

  const map = await loadGrants(false);
  if (!map || !map.size) return;

  await hydrateMeta(map);
  await unlockHome(map);
  await unlockArchiveLike(map);
  await unlockTagCloud(map);
  await unlockCategoryTree(map);
  await unlockMasonry(map);
}
