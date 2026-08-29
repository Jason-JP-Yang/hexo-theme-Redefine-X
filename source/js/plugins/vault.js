import { runFlip, cardsInViewport, primeForFlipIn, animateHeight } from "../layouts/homePagination.js";
import initAutoHover, { syncHomeAutoHover } from "../layouts/autoHover.js";
import initBentoFit, { syncBentoFit } from "../layouts/bentoFit.js";
import initTileSpotlight from "../layouts/tileSpotlight.js";
import initCoverParallax, { syncCoverParallax } from "../layouts/coverParallax.js";
import initLazyLoad from "../layouts/lazyload.js";
import { initTOC } from "../layouts/toc.js";
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
  fetchSealed,
  vaultPrefix,
  siteRoot,
  variantPath,
  variantKey,
  revealAssets,
  dropAssetCache,
} from "../tools/vaultCrypto.js";

/**
 * Redefine-X — encrypted posts, reader side.
 *
 * The public build contains no trace of an encrypted post. One request to the
 * Worker returns the keys this identity may use; everything after that is a
 * plain CDN fetch of an opaque blob plus local AES-GCM.
 *
 * Keys live in this module's closure and nowhere else — no localStorage, no
 * sessionStorage, no service worker cache — and are imported non-extractable.
 * Closing the tab revokes them; so does signing out, which also tears the
 * decrypted content back out of the page.
 */

const SIGNOUT_REDIRECT_MS = 5000;

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
        map.set(post.id, { id: post.id, slug: post.slug, raw, key: await importAesKey(raw) });
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

/* ─── the post page ────────────────────────────────────────────────────────── */

function setGate(gate, phase) {
  gate.dataset.vaultState = phase;
  gate.querySelector(".vault-gate-card").hidden = phase !== "probing";
  gate.querySelector(".vault-gate-notfound").hidden = phase !== "denied";
  gate.querySelector(".vault-signout").hidden = phase !== "signed-out";
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
    await revealAssets(host, entry.raw);
    if (isAdmin) mountAudienceEditor(host, entry);

    setGate(gate, "open");
    rehydrate(host);

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

/** Everything the theme wires on a real post page, for content that arrived late. */
function rehydrate(root) {
  const theme = window.theme || {};
  try {
    if (theme.articles?.code_block?.copy === true) initCopyCode();
    if (theme.articles?.lazyload === true) {
      initLazyLoad({ preload: theme.articles.lazyload_preload === true });
    }
    if (theme.articles?.toc?.enable === true) initTOC();
    initMathJaxScroll();
    initNotoAnim();
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([root]);
  } catch (e) {
    /* one dead subsystem must not take the article down with it */
  }
}

/** The management console's chip field, above the article, for an admin. */
async function mountAudienceEditor(host, entry) {
  const container = host.querySelector(".article-content") || host.querySelector(".article-content-container");
  if (!container || container.dataset.vaultAdmin === "1") return;
  container.dataset.vaultAdmin = "1";

  const box = document.createElement("div");
  box.className = "vault-admin";
  box.innerHTML = `
    <label class="vault-admin-label">
      <i class="fa-regular fa-user-lock" aria-hidden="true"></i>
      <span>${i18n("audience", "Who can read this")}</span>
      <span class="vault-admin-state" role="status"></span>
    </label>
    <div class="vault-admin-picker"></div>`;
  container.insertBefore(box, container.firstChild);

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

/**
 * Signing out while an encrypted post is open. The plaintext is already in the
 * DOM, so it is removed rather than hidden, and the page says why instead of
 * silently becoming a 404 under the reader.
 */
function lockPost(gate) {
  const host = gate.querySelector(".vault-article-host");
  host.innerHTML = "";
  setGate(gate, "signed-out");
  document.documentElement.classList.add("vault-locked");

  const count = gate.querySelector(".vault-signout-count");
  let left = Math.round(SIGNOUT_REDIRECT_MS / 1000);
  const tick = () => {
    if (count) count.textContent = left > 0 ? `(${left})` : "";
    if (left-- <= 0) {
      clearInterval(timer);
      location.href = siteRoot() + "/";
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  settle();
}

/* ─── listings ─────────────────────────────────────────────────────────────── */

async function cardFor(entry) {
  const sealed = await fetchSealed(`${vaultPrefix()}/${entry.slug}/c.html`);
  if (!sealed) return null;
  const holder = document.createElement("div");
  holder.innerHTML = (await openText(entry.key, sealed)).trim();
  const node = holder.firstElementChild;
  if (node) await revealAssets(node, entry.raw);
  return node;
}

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
  if (!cards.length) return Array.from(map.entries());
  const dates = cards
    .filter((card) => !card.querySelector(".home-article-sticky-badge"))
    .map(dateOf)
    .filter((d) => !isNaN(d));
  if (!dates.length) return [];
  const oldest = Math.min.apply(null, dates);
  const newest = Math.max.apply(null, dates);

  return Array.from(map.entries()).filter(([, entry]) => {
    const when = entry.date;
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
  return JSON.parse(await openText(await variantKey(page, keys), sealed));
}

async function unlockHome(map) {
  const list = document.querySelector(".home-article-list");
  if (!list || !map || !map.size || list.dataset.vaultApplied === "1") return;

  const root = document.querySelector(".home-pagination");
  const page = Number(list.dataset.page) || 1;
  const total = Number(root && root.dataset.total) || 1;

  await hydrateDates(map);
  const mine = postsForThisPage(map, Array.from(list.querySelectorAll(".home-article-item")), page, page >= total);
  if (!mine.length) return;

  const plan = await variantFor(page, mine);
  if (!plan) return;

  const cards = mine.filter(([, e]) => e.card).map(([id, e]) => ({ id, node: e.card }));
  if (!cards.length) return;

  list.dataset.vaultApplied = "1";

  const animate = !prefersReducedMotion() && cardsInViewport(list).length > 0;
  const outgoing = animate ? cardsInViewport(list) : [];
  if (outgoing.length) await runFlip(outgoing, "out");

  applyPlan(list, plan, cards);

  list.classList.add("is-flipping");
  resettleGrid();
  refreshHomeRelativeTime();

  let entering = [];
  if (animate) {
    entering = cardsInViewport(list);
    entering.forEach((card) => primeForFlipIn(card));
  }
  if (entering.length) await runFlip(entering, "in");
  entering.forEach((card) => card.classList.add("has-entered"));
  list.classList.remove("is-flipping");
  settle();
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
 * The arrangement is applied, never computed. Every tile — public ones included
 * — takes the tier, placement and split classes the build solved for this exact
 * set of posts. The previous state is snapshotted first so signing out can put
 * the public grid back without a reload.
 */
function applyPlan(list, plan, cards) {
  const byId = new Map(cards.map((c) => [c.id, c.node]));
  const nodes = new Map();

  for (const item of list.querySelectorAll(".home-article-item")) {
    const link = item.querySelector(".home-article-title a");
    if (link) nodes.set(normalizePath(new URL(link.href, location.href).pathname), item);
  }

  homeSnapshot = {
    list,
    lgRows: list.dataset.lgRows,
    mdRows: list.dataset.mdRows,
    children: Array.from(list.children),
    tiles: Array.from(list.querySelectorAll(".home-article-item"), (el) => ({
      el,
      className: el.className,
      style: el.getAttribute("style") || "",
    })),
  };

  const ordered = [];
  for (const id of plan.order || []) {
    const node = byId.get(id) || nodes.get(normalizePath(id));
    if (!node) continue;
    const tile = plan.tiles[id];
    if (tile) {
      node.className = node.className.replace(/\btier-[a-z]+\b/g, "").trim();
      node.classList.add("tier-" + tile.tier);
      node.classList.remove("lg-split", "md-split", "cover-right");
      for (const cls of String(tile.classes || "").trim().split(/\s+/)) {
        if (cls) node.classList.add(cls);
      }
      for (const decl of String(tile.style || "").split(";")) {
        const [prop, value] = decl.split(":");
        if (prop && value) node.style.setProperty(prop.trim(), value.trim());
      }
    }
    ordered.push(node);
  }

  const features = Array.from(list.querySelectorAll(".home-feature-tile"));
  list.replaceChildren(...features, ...ordered);
  if (plan.lgRows) list.dataset.lgRows = String(plan.lgRows);
  if (plan.mdRows) list.dataset.mdRows = String(plan.mdRows);
}

/** Put the public grid back, exactly as the build shipped it. */
function revertHome() {
  const snap = homeSnapshot;
  homeSnapshot = null;
  if (!snap || !snap.list.isConnected) return;

  for (const t of snap.tiles) {
    t.el.className = t.className;
    if (t.style) t.el.setAttribute("style", t.style);
    else t.el.removeAttribute("style");
  }
  snap.list.replaceChildren(...snap.children);
  if (snap.lgRows) snap.list.dataset.lgRows = snap.lgRows;
  if (snap.mdRows) snap.list.dataset.mdRows = snap.mdRows;
  delete snap.list.dataset.vaultApplied;

  resettleGrid();
  settle();
}

const LIST_SELECTORS = [".article-list", ".archive-list", ".category-post-list", ".tag-post-list"];

async function unlockLists(map) {
  if (!map || !map.size) return;
  const list = LIST_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
  if (!list || list.dataset.vaultApplied === "1") return;

  await hydrateDates(map);
  const items = Array.from(list.children).filter((n) => n.nodeType === 1);
  const inserts = [];

  for (const entry of map.values()) {
    if (isNaN(entry.date) || !entry.card) continue;
    const node = entry.card.cloneNode(true);
    node.classList.add("is-vault", "vault-inserted");
    await revealAssets(node, entry.raw);
    inserts.push({ node, when: entry.date });
  }
  if (!inserts.length) return;

  list.dataset.vaultApplied = "1";
  await animateHeight(list, () => {
    for (const { node, when } of inserts) {
      const before = items.find((item) => {
        const d = dateOf(item);
        return !isNaN(d) && d < when;
      });
      list.insertBefore(node, before || null);
      node.animate(
        [
          { opacity: 0, transform: "translateY(16px) scale(0.985)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 460, delay: 60, easing: "cubic-bezier(0.16, 0.84, 0.28, 1)", fill: "backwards" }
      );
    }
  });
  settle();
}

function revertLists() {
  const list = LIST_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
  if (!list || list.dataset.vaultApplied !== "1") return;
  list.querySelectorAll(".vault-inserted").forEach((n) => n.remove());
  delete list.dataset.vaultApplied;
  settle();
}

/** The card blob is the only place an encrypted post's date exists publicly. */
async function hydrateDates(map) {
  await Promise.all(
    Array.from(map.values(), async (entry) => {
      if (entry.date !== undefined) return;
      entry.date = NaN;
      const node = await cardFor(entry);
      if (node) {
        entry.card = node;
        entry.date = dateOf(node);
      }
    })
  );
}

/* ─── plumbing ─────────────────────────────────────────────────────────────── */

function normalizePath(value) {
  const root = siteRoot();
  let path = String(value);
  if (root && path.startsWith(root)) path = path.slice(root.length);
  return decodeURI(path).replace(/^\/+|\/+$/g, "");
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
function onSignOut() {
  grants = null;
  grantsPromise = null;
  isAdmin = false;
  dropAssetCache();

  const gate = document.querySelector(".vault-gate");
  if (gate && gate.dataset.vaultState === "open") return void lockPost(gate);
  revertHome();
  revertLists();
}

let wired = false;

export default async function initVault() {
  if (!window.crypto?.subtle) return;
  if (!window.theme?.backend?.vault_enable) return;

  if (!wired) {
    wired = true;
    window.addEventListener("blog:auth-change", async () => {
      const session = window.blogAuth && (await window.blogAuth.getSession());
      if (!session || !session.token) onSignOut();
      else {
        grants = null;
        grantsPromise = null;
        initVault();
      }
    });
  }

  const gate = document.querySelector(".vault-gate");
  if (gate) return void unlockPost(gate);

  const map = await loadGrants(false);
  if (!map || !map.size) return;

  await unlockHome(map);
  await unlockLists(map);
}
