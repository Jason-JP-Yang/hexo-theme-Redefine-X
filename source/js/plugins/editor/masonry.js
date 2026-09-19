/**
 * The masonry editor.
 *
 * ── It is the same editor ───────────────────────────────────────────────────
 *
 * Everything here that could be shared IS shared: the document bar, the album
 * card's rows, the picture browser, the property sheet, the prompt, the staged
 * tidy-up, the backend chip, the publish rail, the credentials, the motion
 * constants and the toolbar are the post editor's own objects. What is new is
 * only what an album genuinely is and an article is not — a list of photographs
 * in one shared YAML file, with a category above it.
 *
 * Editing happens ON the album page, exactly as it happens on the article:
 * `/masonry/<title>/` for a public one, `/v/<slug>/` for a sealed one, and
 * `/blog-management/masonry/` is this same editor over an empty gallery for an
 * album that does not exist yet.
 *
 * ── One row of controls ─────────────────────────────────────────────────────
 *
 * The toolbar is `createToolbar`'s `simple` face. An album has no selection to
 * format and no block to become something else, so three of the post editor's
 * four tabs could never apply — and a tab strip where two tabs are dead is
 * chrome that only says "this is not for you". What is left is the two steps and
 * the minimise button, then everything you can do to the photograph you have
 * picked, with "add a picture" last.
 *
 * ── What a draft is ─────────────────────────────────────────────────────────
 *
 * The post model, translated. A draft is a SECOND entry in masonry.yml carrying
 * `draft: true` and `supersedes: <the published album's page title>`; the
 * published entry is left exactly as it was, so readers go on seeing the
 * published album — encrypted or not — while the draft is withheld from the
 * public build entirely and only an admin holds its key. Publishing writes the
 * draft's content back over the published entry and deletes the draft, in one
 * commit, so the two can never both be live and neither can be missing.
 *
 * An album that has never been published is a draft with no `supersedes`, which
 * is what Blog Management calls Unpublished — the same sentence it says about an
 * article.
 */

import { escapeHTML } from "./markdown.js";
import { createToolbar } from "./toolbar.js";
import { createAlbumCard } from "./masonry-card.js";
import {
  albumTitle,
  appendCategory,
  categories,
  categoryFields,
  dropFrom,
  emitItem,
  emitMasonry,
  findAlbum,
  findCategory,
  imageFields,
  insertItem,
  isTrue,
  itemFields,
  makeCategory,
  makeImage,
  makeItem,
  parseItemBlock,
  parseMasonry,
  readKeys,
  setImageField,
  setItemField,
} from "./masonry-yaml.js";
import {
  closeDialogs,
  createStage,
  noteCommitted,
  openAsk,
  openPicker,
  openSheet,
  pickerLive,
  sheetLive,
  siteAddress,
} from "./picker.js";
import { PERCH_AT, releaseDocbar, watchDocbar, watchPerch } from "./chrome.js";
import { filedPath, movedId, uploadPath } from "./history.js";
import { loadComponents } from "./render.js";
import { spotClear, spotElement } from "./spotlight.js";
import { anchored, headroom, readable, travelTo, useChrome } from "./travel.js";
import {
  bindImage,
  buildPreloader,
  loadManifest,
  naturalSize,
  registerRewind,
  repoURL,
  setVaultAssets,
  siteRoot,
} from "./assets.js";
import initLazyLoad, {
  forceLoadAllPreloaders,
  registerSrcFallback,
  registerSrcResolver,
} from "../../layouts/lazyload.js";
import { assetURL, vaultPrefix } from "../../tools/vaultCrypto.js";
import * as session from "./session.js";
import * as repo from "./repo.js";
import * as credentials from "./credentials.js";
import {
  EASE,
  contentChanged,
  createEdgeScroll,
  crossFade,
  enter,
  exit,
  pop,
  reduced,
  setDragImage,
  toolbarIn,
} from "./motion.js";
import { checkMasonryOverflow } from "../masonry.js";

const DATA = "source/_data/masonry.yml";
const AUTOSTASH_MS = 4000;
const DEPLOY_MS = 20000;
const POLL_MS = 6000;
// The article's own step duration, so a photograph sliding into its new column
// travels at the same speed a paragraph does.
const STEP_MS = 380;
// Separator for the comparison keys below: a control character, because what is
// being joined is the author's own text.
const UNIT = String.fromCharCode(1);

/**
 * The masonry.yml key each EXIF field is written under.
 *
 * The labels, the grouping and the order are `components.js`'s — the same table
 * the published EXIF card is printed from — and only the spelling differs, because
 * masonry.yml names these fields in camelCase where the tag names them in EXIF's
 * own capitals. A second list of seventeen field names would drift the first time
 * one of them was renamed.
 */
const EXIF_YML = {
  Make: "make",
  Model: "model",
  DateTimeOriginal: "dateTimeOriginal",
  LensModel: "lensModel",
  FocalLength: "focalLength",
  FocusMode: "focusMode",
  ExposureTime: "exposureTime",
  Aperture: "aperture",
  ISOSpeedRatings: "ISOSpeedRatings",
  ExposureProgram: "exposureProgram",
  ExposureBias: "exposureBias",
  MeteringMode: "meteringMode",
  Flash: "flash",
  WhiteBalance: "whiteBalance",
  GPSLatitude: "GPSLatitude",
  GPSLongitude: "GPSLongitude",
  GPSAltitude: "GPSAltitude",
};

const EXIF_GROUPS = [
  ["g_camera", "Camera", ["Make", "Model", "DateTimeOriginal"]],
  ["g_lens", "Lens", ["LensModel", "FocalLength", "FocusMode"]],
  ["g_exposure", "Exposure", ["ExposureTime", "Aperture", "ISOSpeedRatings", "ExposureProgram", "ExposureBias", "MeteringMode"]],
  ["g_other", "Other", ["Flash", "WhiteBalance", "GPSLatitude", "GPSLongitude", "GPSAltitude"]],
];

/** masonry.yml's spelling back to the sheet's, so a step can name a field. */
const YML_EXIF = Object.fromEntries(Object.entries(EXIF_YML).map(([exif, key]) => [key, exif]));

/** Every field the property sheet owns, in the order it prints them. */
const PROP_KEYS = ["title", "description", "auto-exif", ...Object.values(EXIF_YML)];

const STAGES = [
  { key: "committed", icon: "fa-code-commit", label: "Committed" },
  { key: "building", icon: "fa-hammer", label: "Building" },
  { key: "pushed", icon: "fa-upload", label: "Artifact pushed" },
  { key: "deployed", icon: "fa-globe", label: "Deployed" },
];

const BACKEND_ICON = { gitea: "fa-solid fa-server", github: "fa-brands fa-github" };

/* ─── state ────────────────────────────────────────────────────────────────── */

function blank() {
  return {
    on: false,
    host: null,
    container: null,
    titleHost: null,
    snapshot: [],
    put: [],
    doc: null,
    cat: null,
    item: null,
    // What the file called this album when it was read. A save re-reads the file
    // and finds the album by THIS, never by the name since typed into the card.
    opened: { title: "", draft: false, category: "" },
    grant: null,
    stashGrant: null,
    fresh: false,
    selected: "",
    pending: [],
    stage: null,
    dirty: false,
    saving: false,
    leaving: false,
    minimized: false,
    vaultChoice: undefined,
    stashTimer: null,
    perchOff: null,
    barSize: null,
    progressTimer: null,
    dragId: "",
    dropAt: "",
  };
}

const state = blank();
let ui = null;
let strings = null;
// The object the album card was handed. Mutated, never replaced — see activate.
let cardModel = null;

/** Point the card at whatever the album and its category now are, and redraw. */
function repaintCard() {
  if (!ui || !ui.card || !cardModel) return;
  cardModel.doc = state.doc;
  cardModel.item = state.item;
  cardModel.cat = state.cat;
  ui.card.paint();
}

function t(key, fallback) {
  return (strings && strings[key]) || fallback;
}

async function loadStrings() {
  if (strings) return strings;
  try {
    const res = await fetch(`${siteRoot()}/blog-management/editor-i18n.json`, { cache: "force-cache" });
    strings = res.ok ? await res.json() : {};
  } catch (err) {
    strings = {};
  }
  return strings;
}

function reset() {
  Object.assign(state, blank());
}

/* ─── addresses ────────────────────────────────────────────────────────────── */

/**
 * The two spellings of one photograph.
 *
 * masonry.yml names an album's own pictures RELATIVE to `source/masonry/`, and
 * anything else by its absolute site path — the rule `masonry.ejs`'s
 * `buildImagePath` applies, and the rule the vault generator's route collection
 * applies with it. So a picture chosen out of `source/masonry/` is stored short
 * and one chosen out of `source/images/` is stored long, and both resolve here.
 */
function siteOf(stored) {
  const value = String(stored || "").trim();
  if (!value) return "";
  if (/^(https?:|\/\/|\/|data:|blob:)/i.test(value)) return value;
  return "/masonry/" + value;
}

function storedOf(site) {
  const value = String(site || "").trim();
  return value.startsWith("/masonry/") ? value.slice("/masonry/".length) : value;
}

/* ─── the page in front of us ──────────────────────────────────────────────── */

function findContainer() {
  return document.querySelector("#masonry-container");
}

function findHost() {
  const container = findContainer();
  return container ? container.closest(".page-template-container") || container.parentElement : null;
}

/* ─── chrome ───────────────────────────────────────────────────────────────── */

function buildDocbar() {
  const bar = document.createElement("div");
  bar.className = "ed-docbar ed-docbar-album";
  bar.innerHTML = `
    <div class="ed-docbar-id">
      <i class="fa-solid fa-images" aria-hidden="true"></i>
      <code class="ed-docbar-path"></code>
      <span class="ed-tag ed-tag-vault" hidden><i class="fa-solid fa-lock-keyhole"></i>${escapeHTML(t("encrypted", "Encrypted"))}</span>
      <span class="ed-tag ed-tag-draft" hidden><i class="fa-solid fa-pen-nib"></i>${escapeHTML(t("draft", "Draft"))}</span>
    </div>
    <div class="ed-docbar-actions">
      <button type="button" class="ed-act ed-backend" hidden></button>
      <span class="ed-dot" data-state="clean" title=""></span>
      <button type="button" class="ed-act ed-save" disabled>
        <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i><span>${escapeHTML(t("save", "Save draft"))}</span>
      </button>
      <button type="button" class="ed-act ed-act-primary ed-publish">
        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i><span>${escapeHTML(t("publish", "Publish"))}</span>
      </button>
      <button type="button" class="ed-act ed-close" title="${escapeHTML(t("close", "Stop editing"))}">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </div>
    <div class="ed-progress" hidden></div>
    <div class="ed-notice" hidden></div>`;
  return bar;
}

function pathLabel() {
  if (!state.item) return DATA;
  const title = albumTitle(itemFields(state.item));
  return title ? `${DATA} · ${title}` : DATA;
}

function syncHeader() {
  if (!ui || !state.item) return;
  ui.path.textContent = pathLabel();
  ui.vaultTag.hidden = !isTrue(itemFields(state.item).vault);
  ui.draftTag.hidden = !state.opened.draft && !state.fresh;
  ui.save.disabled = !state.dirty || state.saving;
  ui.publish.disabled = state.saving;
  ui.dot.dataset.state = state.saving ? "busy" : state.dirty ? "dirty" : "clean";
  ui.dot.title = state.saving
    ? t("saving", "Saving")
    : state.dirty
      ? t("unsaved", "Unsaved changes")
      : t("saved_clean", "Everything is committed");
}

function notice(kind, text) {
  if (!ui) return;
  if (!text) {
    ui.notice.hidden = true;
    return;
  }
  const icon =
    kind === "error" ? "fa-circle-exclamation" : kind === "warn" ? "fa-triangle-exclamation" : "fa-circle-info";
  ui.notice.hidden = false;
  ui.notice.dataset.kind = kind;
  ui.notice.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHTML(text)}</span>`;
  pop(ui.notice);
}

/** Minimise, for the width where a soft keyboard would otherwise take the bars. */
function chromeHidden() {
  return document.documentElement.dataset.edChrome === "min";
}

function toggleChrome() {
  state.minimized = !chromeHidden();
  document.documentElement.dataset.edChrome = state.minimized ? "min" : "";
  if (ui && ui.toolbar) ui.toolbar.chrome(state.minimized);
  if (!state.minimized && ui && ui.toolbar) {
    ui.toolbar.el.dataset.perch = window.scrollY > PERCH_AT ? "show" : "hide";
  }
}

/* ─── the album title, edited where it is printed ──────────────────────────── */

/**
 * The gallery's `<h1>`, made editable.
 *
 * It prints `page-title || name`, so that is the key it writes: editing the
 * heading of an album whose page title is set must change the page title, and
 * editing one that has none must change the name. Anything else would be a
 * heading that says one thing and saves another.
 */
function titleKey() {
  return itemFields(state.item)["page-title"] ? "page-title" : "name";
}

/** Wired once. Repainting it is `syncTitle`, which touches only the text. */
function wireTitle() {
  if (!state.titleHost) return;
  state.titleHost.classList.add("ed-title");
  state.titleHost.setAttribute("contenteditable", "true");
  state.titleHost.setAttribute("spellcheck", "false");
  state.titleHost.dataset.placeholder = t("untitled", "Untitled");
  syncTitle();

  state.titleHost.addEventListener("input", () => {
    const key = titleKey();
    const value = state.titleHost.textContent.trim();
    setItemField(state.item, key, value || null);
    if (ui.card) ui.card.set(key, value);
    markDirty("text", "title");
    ui.path.textContent = pathLabel();
  });
}

function syncTitle() {
  if (!state.titleHost || state.titleHost === document.activeElement) return;
  state.titleHost.textContent = albumTitle(itemFields(state.item));
}

/* ─── the canvas ───────────────────────────────────────────────────────────── */

function images() {
  return state.item ? state.item.images : [];
}

function nodeOf(id) {
  return images().find((node) => node.id === id) || null;
}

function indexOf(id) {
  return images().findIndex((node) => node.id === id);
}

function selectedNode() {
  return state.selected ? nodeOf(state.selected) : null;
}

function hasExif(node) {
  const fields = imageFields(node);
  return Object.keys(EXIF_YML).some((key) => fields[EXIF_YML[key]]);
}

/**
 * What a tile DRAWS, in one string.
 *
 * Everything else a photograph carries — seventeen EXIF fields — changes what
 * the published page prints in its card and nothing about the tile, so a tile
 * whose signature has not moved is a tile that must not be rebuilt.
 */
function tileSig(node) {
  const fields = imageFields(node);
  return [fields.image || "", fields.title || "", fields.description || ""].join(UNIT);
}

function tiles() {
  return Array.from(state.container.querySelectorAll(":scope > .ed-tile"));
}

function tileOf(id) {
  if (!id || !state.container) return null;
  return state.container.querySelector(`:scope > .ed-tile[data-id="${CSS.escape(id)}"]`);
}

/**
 * One photograph, drawn exactly as the published gallery draws it.
 *
 * `masonry.ejs`'s own markup — `.masonry-item` around `.image-container` around
 * the article's `.img-preloader`, with the title and the description as the two
 * overlays — so what is on screen while the album is edited is the album, not a
 * preview of it. The compact-mode measuring pass and the image viewer are the
 * gallery's own and work on this unchanged.
 *
 * The one thing added is the article's own gutter: the `+` that inserts a
 * photograph in front of this one and the handle a drag starts from. Same two
 * buttons, same classes, same behaviour as every block in a post — but drawn
 * OVER the picture rather than in a margin, because a masonry column has no
 * margin to put them in and anything that took width would change the layout
 * being edited into one that is not the layout being published.
 */
function buildTile(node) {
  const tile = document.createElement("div");
  tile.className = "masonry-item ed-tile";
  tile.dataset.id = node.id;
  tile.dataset.on = "0";

  const rail = document.createElement("div");
  rail.className = "ed-gutter ed-tile-rail";
  rail.innerHTML = `
    <button type="button" class="ed-gutter-btn ed-add" title="${escapeHTML(
      t("insert_before_image", "Add a picture here")
    )}" tabindex="-1"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
    <button type="button" class="ed-gutter-btn ed-handle" title="${escapeHTML(
      t("drag", "Drag to reorder")
    )}" draggable="true" tabindex="-1"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></button>`;
  tile.appendChild(rail);

  const box = document.createElement("div");
  box.className = "image-container";
  tile.appendChild(box);

  patchTile(tile, node);
  return tile;
}

/** The one overlay, made to say `text` — or taken away when there is none. */
function setOverlay(box, cls, text) {
  let el = box.querySelector(":scope > ." + cls);
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = cls;
    box.appendChild(el);
  }
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Bring one tile up to date IN PLACE.
 *
 * The picture element is kept unless the address itself changed, which is the
 * whole point: a caption edited, a photograph moved, a step undone — none of
 * those may hand the browser a new `<img>`, because a new `<img>` is a fresh
 * request, a skeleton over a picture that had already arrived, and a column
 * whose heights collapse and come back. That was the flicker.
 */
function patchTile(tile, node) {
  const fields = imageFields(node);
  const box = tile.querySelector(":scope > .image-container");
  if (!box) return false;

  // Toggled, never assigned: `masonry-compact` and `auto-hover` are put there by
  // the gallery's own passes, and rewriting the whole list takes them off under
  // the pass that had just decided them.
  box.classList.toggle("masonry-title-only", !!(fields.title && !fields.description));

  const want = siteOf(fields.image);
  const media = box.querySelector(".img-preloader, img");
  if (!media || tile.dataset.src !== want) {
    const fresh = buildPreloader(want, fields.title || "", state.pending);
    // A click on the canvas SELECTS a photograph; the viewer is the toolbar's.
    fresh.setAttribute("data-no-viewer", "");
    if (media) media.replaceWith(fresh);
    else box.insertBefore(fresh, box.firstChild);
  } else if (media.tagName === "IMG") {
    media.alt = fields.title || "";
  } else {
    media.dataset.alt = fields.title || "";
  }
  tile.dataset.src = want;

  setOverlay(box, "image-title", fields.title || "");
  setOverlay(box, "image-description", fields.description || "");
  tile.dataset.sig = tileSig(node);
  return true;
}

/**
 * An album with nothing in it.
 *
 * Centred on the whole measure rather than dropped into the first column — the
 * container is a multi-column box, so a placeholder left in the flow sits in a
 * quarter of the page and reads as a photograph that failed to load. The button
 * is the docbar's own primary action, and it does exactly what the toolbar's
 * add does, because at this point it is the only thing there is to do.
 */
function buildEmpty() {
  const empty = document.createElement("div");
  empty.className = "ed-album-empty";
  empty.innerHTML =
    `<i class="fa-regular fa-images" aria-hidden="true"></i>` +
    `<span>${escapeHTML(t("album_empty", "No photographs yet."))}</span>` +
    `<button type="button" class="ed-act ed-act-primary ed-album-add">
       <i class="fa-solid fa-image" aria-hidden="true"></i><span>${escapeHTML(
         t("add_image", "Add a picture")
       )}</span>
     </button>`;
  return empty;
}

/**
 * The canvas, made to MATCH the album — never rebuilt from it.
 *
 * `reconcile` in the post editor, over photographs: a tile whose signature is
 * unchanged keeps its element and may only move; one that says something else
 * is patched; one that is gone is removed. Emptying the container and drawing
 * every tile again was four lines and it cost a full re-layout of the columns
 * and a fresh request for every picture on every edit — an album flashing white
 * each time a caption was typed into.
 *
 * Synchronous, and it must stay that way: a FLIP is measure, mutate, measure,
 * with no frame between them.
 */
function syncTiles() {
  const container = state.container;
  const held = new Map();
  for (const el of tiles()) held.set(el.dataset.id, el);

  // The gallery the page arrived with. It is kept in `state.snapshot` to be put
  // back on close, and until the first reconcile it is still IN the container —
  // so without this every photograph was drawn twice, once as the published
  // tile nothing could edit and once as the editable one.
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType !== 1) node.remove();
    else if (!node.classList.contains("ed-tile") && !node.classList.contains("ed-album-empty")) node.remove();
  }

  const rows = [];
  for (const node of images()) {
    let el = held.get(node.id);
    if (el) {
      held.delete(node.id);
      if (el.dataset.sig !== tileSig(node)) patchTile(el, node);
    } else {
      el = buildTile(node);
    }
    el.dataset.on = node.id === state.selected ? "1" : "0";
    rows.push(el);
  }
  for (const el of held.values()) el.remove();

  // Placed from the end, so a tile already standing where it belongs is never
  // touched — and moving one out of the tree and back in would take its picture
  // with it.
  let anchor = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const el = rows[i];
    if (el.parentNode !== container || el.nextSibling !== anchor) container.insertBefore(el, anchor);
    anchor = el;
  }

  const empty = container.querySelector(":scope > .ed-album-empty");
  if (rows.length && empty) empty.remove();
  if (!rows.length && !empty) container.appendChild(buildEmpty());
  // One column while there is nothing in it, so the placeholder has the whole
  // measure to be centred on.
  container.classList.toggle("ed-album-blank", !rows.length);

  settleGallery();
}

/**
 * One FLIP over every tile: what moved travels from where it was, what arrived
 * grows into place, and the page is held still by `anchor` while the columns
 * re-flow above it.
 */
async function flipTiles(mutate, anchor) {
  if (reduced()) {
    mutate();
    return;
  }

  const was = new Map();
  for (const el of tiles()) was.set(el, el.getBoundingClientRect());
  const top = anchor && anchor.isConnected ? anchor.getBoundingClientRect().top : null;

  mutate();

  // Removing one photograph re-balances EVERY column, so a tile can travel from
  // the bottom of the page to the top. Correcting for that is what threw the
  // viewport to the top of the album: the pin is only honest while the anchor
  // moved a little, and past that the honest answer is to leave the page where
  // the author left it and let the FLIP show what moved.
  if (top != null && anchor.isConnected) {
    const drift = anchor.getBoundingClientRect().top - top;
    if (Math.abs(drift) > 0.5 && Math.abs(drift) < window.innerHeight * 0.6) window.scrollBy(0, drift);
  }

  const runs = [];
  for (const el of tiles()) {
    const from = was.get(el);
    const now = el.getBoundingClientRect();
    if (!from) {
      runs.push(
        el.animate([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }], {
          duration: Math.round(STEP_MS * 0.7),
          easing: EASE,
        })
      );
      continue;
    }
    const dx = from.left - now.left;
    const dy = from.top - now.top;
    if (!dx && !dy) continue;
    runs.push(
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: STEP_MS,
        easing: EASE,
      })
    );
  }
  await Promise.all(runs.map((run) => run.finished.catch(() => {})));
}

/** Reconcile, with the travel. `anchor` is what the page is held still by. */
async function paintCanvas(animate, anchor) {
  if (animate === false) syncTiles();
  else await flipTiles(() => syncTiles(), anchor || steadyTile());
  observeImages();
  contentChanged();
}

/**
 * What the reader is looking at, when the change itself has nothing to offer.
 *
 * The first tile still on screen. Without it, a photograph restored above the
 * fold slides everything the author was looking at down by its height.
 */
function steadyTile(skip) {
  const top = headroom();
  for (const el of tiles()) {
    if (skip && el === skip) continue;
    if (el.getBoundingClientRect().bottom > top + 1) return el;
  }
  return null;
}

/**
 * A photograph leaving, in two beats.
 *
 * It goes first, where it stands and while nothing else has moved; the gap then
 * closes and everything travels into it. Running the two together — the tile
 * fading over a page that was already re-flowing around it — is two motions
 * with no relationship, which is what read as a jolt rather than a deletion.
 */
const GONE_MS = 190;

async function dropTile(id, mutate, keep) {
  const el = tileOf(id);
  if (!el || reduced()) {
    mutate();
    return void (await paintCanvas(false));
  }

  el.style.pointerEvents = "none";
  await el
    .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.92)" }], {
      duration: GONE_MS,
      easing: "ease-in",
      fill: "forwards",
    })
    .finished.catch(() => {});
  if (!state.on) return;

  // The photograph that takes its place, which is standing where the author is
  // already looking. Any other tile is somewhere the columns may throw it.
  const anchor = (keep && tileOf(keep)) || steadyTile(el);
  await flipTiles(() => {
    el.remove();
    mutate();
    syncTiles();
  }, anchor);

  observeImages();
  contentChanged();
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id || "";
  for (const tile of tiles()) tile.dataset.on = tile.dataset.id === state.selected ? "1" : "0";
  if (ui && ui.toolbar) ui.toolbar.sync();
}

let observePass = 0;

function observeImages() {
  if (observePass) return;
  observePass = requestAnimationFrame(() => {
    observePass = 0;
    const articles = (window.theme && window.theme.articles) || {};
    if (articles.lazyload !== true) return void forceLoadAllPreloaders();
    initLazyLoad({ preload: articles.lazyload_preload === true });
  });
}

/**
 * The gallery's own compact-overlay measuring pass, for tiles it never saw.
 *
 * The pass itself, not `initMasonry` — that one also registers a `resize`
 * listener, and calling it after every edit left one listener per keystroke.
 */
function settleGallery() {
  if (!state.container) return;
  try {
    checkMasonryOverflow(state.container);
  } catch (err) {
    /* one dead subsystem must not take the album down with it */
  }
}

function openViewer(tile) {
  const viewer = window.__REDEFINE_X_IMAGE_VIEWER__;
  const node = tile && tile.querySelector(".img-preloader, img");
  if (!node || !viewer || !viewer.api) return;
  const marked = Array.from(state.container.querySelectorAll("[data-no-viewer]"));
  for (const el of marked) el.removeAttribute("data-no-viewer");
  try {
    viewer.api.open(node);
  } finally {
    for (const el of marked) el.setAttribute("data-no-viewer", "");
  }
}

/* ─── the toolbar's one row ────────────────────────────────────────────────── */

function toolbarItems() {
  const node = selectedNode();
  const off = !node;
  // Icons only. The row carries the two steps, the minimise button and eight
  // controls, and it has to be ONE row at a phone's width — three of these
  // wearing their labels is two rows everywhere below a desktop.
  return [
    {
      kind: "btn",
      act: "folder",
      icon: "fa-folder-open",
      label: "Open folder",
      tt: "open_folder",
      disabled: off,
    },
    {
      kind: "btn",
      act: "props",
      icon: "fa-sliders",
      label: "Properties",
      tt: "properties",
      disabled: off,
      on: !!node && hasExif(node),
    },
    { kind: "btn", act: "view", icon: "fa-expand", label: "Open viewer", tt: "open_viewer", disabled: off },
    { kind: "sep" },
    { kind: "btn", act: "move", arg: "-1", icon: "fa-arrow-up", label: "Move up", tt: "move_up", disabled: off },
    { kind: "btn", act: "move", arg: "1", icon: "fa-arrow-down", label: "Move down", tt: "move_down", disabled: off },
    { kind: "btn", act: "duplicate", icon: "fa-clone", label: "Duplicate", tt: "duplicate", disabled: off },
    { kind: "btn", act: "delete", icon: "fa-trash", label: "Remove", tt: "remove_block", disabled: off },
    // Last, and to the right of Remove: adding is the one thing here that does
    // not need a photograph picked first, so it is the one control that never
    // greys out — and it is where the eye ends up after deleting one.
    { kind: "btn", act: "add", icon: "fa-image", label: "Add a picture", tt: "add_image" },
  ];
}

async function act(action, arg) {
  const node = selectedNode();
  if (action === "add") return void addImage();
  if (!node) return;

  if (action === "view") return void openViewer(tileOf(node.id));
  if (action === "props") return void imageProps(node);

  if (action === "folder") {
    const picked = await pickImage(siteOf(imageFields(node).image));
    if (!picked) return;
    setImageField(node, "image", storedOf(picked.site));
    markDirty("image", node.id);
    await paintCanvas(true, tileOf(node.id));
    if (ui.toolbar) ui.toolbar.refresh();
    return;
  }

  if (action === "duplicate") {
    // Through the TEXT, not through a copy of the fields this editor models: a
    // duplicate has to carry the keys it does not model as faithfully as the
    // ones it does.
    const clone = makeImage(node.lead, node.eol, "");
    clone.body = node.body;
    insertImage(clone, indexOf(node.id) + 1);
    state.selected = clone.id;
    markDirty("images", clone.id);
    await paintCanvas(true, tileOf(node.id));
    if (ui.toolbar) ui.toolbar.sync();
    return;
  }

  if (action === "delete") {
    const at = indexOf(node.id);
    const next = images()[at + 1] || images()[at - 1];
    state.selected = next ? next.id : "";
    await dropTile(
      node.id,
      () => {
        dropFrom(images(), at, (tail) => (state.item.post = tail + state.item.post));
        markDirty("images", node.id);
      },
      state.selected
    );
    if (ui.toolbar) ui.toolbar.sync();
    return;
  }

  if (action === "move") {
    const delta = Number(arg) || 0;
    const at = indexOf(node.id);
    return void (await moveImage(at, at + delta));
  }
}

/**
 * Put the photograph at `from` in at `to`, and let everything travel.
 *
 * The tails stay with their POSITIONS, not with the nodes: the blank line after
 * the last photograph closes the list, and carrying it along with a photograph
 * being moved up would open a gap in the middle of it.
 */
async function moveImage(from, to) {
  const list = images();
  if (from < 0 || from >= list.length) return;
  const index = Math.max(0, Math.min(to, list.length - 1));
  if (index === from) return;

  const node = list[from];
  const tails = list.map((n) => n.tail);
  list.splice(index, 0, list.splice(from, 1)[0]);
  list.forEach((n, i) => (n.tail = tails[i]));

  markDirty("images", node.id);
  await paintCanvas(true, tileOf(node.id));
}

/**
 * Put a photograph into the list, keeping the blank line that CLOSES it where it
 * is. A tail belongs to a position, not to a node: carrying it along with the
 * photograph it happened to follow opens a gap in the middle of the list and
 * leaves the end of it flush against whatever comes next.
 */
function insertImage(node, at) {
  const list = images();
  const index = Math.max(0, Math.min(at == null ? list.length : at, list.length));
  const last = list[list.length - 1];
  node.tail = index >= list.length && last ? last.tail : "";
  if (index >= list.length && last) last.tail = "";
  list.splice(index, 0, node);
  return node;
}

/**
 * @param {number} [at]  where it goes. A `+` on a tile says "in front of this
 *                       one"; the toolbar's button says "after the one picked",
 *                       which is where the eye already is.
 */
async function addImage(at) {
  const anchor = at == null ? null : tileOf((images()[at] || {}).id);
  const picked = await pickImage("");
  if (!picked || !state.on) return;
  const node = makeImage(state.item.imageLead, state.item.eol, storedOf(picked.site));
  insertImage(node, at == null ? (state.selected ? indexOf(state.selected) + 1 : images().length) : at);
  state.selected = node.id;
  markDirty("images", node.id);
  await paintCanvas(true, anchor && anchor.isConnected ? anchor : undefined);
  if (ui && ui.toolbar) ui.toolbar.sync();
}

/* ─── the property sheet ───────────────────────────────────────────────────── */

function propsOf(node) {
  const fields = imageFields(node);
  const out = { title: fields.title || "", description: fields.description || "" };
  out["auto-exif"] = isTrue(fields["auto-exif"]);
  for (const key of Object.keys(EXIF_YML)) out[key] = fields[EXIF_YML[key]] || "";
  return out;
}

/**
 * Everything one photograph can be told about itself.
 *
 * The same sheet the article's pictures open, over masonry.yml's spelling of the
 * same seventeen fields — so the caption, the description and the camera data
 * are asked for in one place on this site rather than two that look alike.
 */
function imageProps(node, quiet) {
  const held = sheetLive();
  if (held && held.id === node.id) return held;
  if (held) held.close();

  // `components.js` carries the labels the published EXIF card is printed with.
  // It is fetched when the editor opens; a field whose label has not arrived is
  // still drawn, under its own name, because a sheet missing fourteen of its
  // seventeen fields is worse than one with a plain label on them.
  const api = window.RedefineComponents;
  const labels = (api && api.EXIF_LABELS) || {};
  const id = node.id;

  openSheet(
    { t },
    {
      id,
      quiet,
      title: t("properties", "Picture properties"),
      values: propsOf(node),
      groups: [
        {
          label: t("g_caption", "Caption"),
          fields: [
            { key: "title", label: t("f_title", "Title"), wide: true },
            { key: "description", label: t("f_description", "Description"), wide: true },
            {
              kind: "note",
              text: t(
                "exif_note",
                "With this on, the build reads the camera data out of the picture file, so those values appear on the published page and not here. Any field filled in below replaces the one read from the file."
              ),
            },
            { key: "auto-exif", label: t("auto_exif", "Read EXIF at build time"), kind: "toggle" },
          ],
        },
        ...EXIF_GROUPS.map(([key, label, keys]) => ({
          label: t(key, label),
          fields: keys.map((k) => ({ key: k, label: labels[k] || k })),
        })),
      ],
    }
  ).then(async (answer) => {
    if (!answer || !state.on) return;
    const live = nodeOf(id);
    if (!live) return;

    setImageField(live, "title", answer.title || null);
    setImageField(live, "description", answer.description || null);
    // A switch that is OFF is the album's own default, so it is written only to
    // say something the album does not already say.
    setImageField(live, "auto-exif", answer["auto-exif"] ? "true" : null);
    for (const [exif, key] of Object.entries(EXIF_YML)) {
      setImageField(live, key, answer[exif] ? answer[exif] : null);
    }

    markDirty("props", id);
    // The picture itself is untouched, so only the overlays are rewritten and
    // the column heights travel to whatever the caption made them.
    await paintCanvas(true, tileOf(id));
    if (ui && ui.toolbar) ui.toolbar.refresh();
  });

  return sheetLive();
}

function closeSheet() {
  const held = sheetLive();
  if (held) held.close();
}

/* ─── pictures ─────────────────────────────────────────────────────────────── */

async function pickImage(current, browse) {
  const had = state.pending.length;
  const opened = history.mark();
  const picked = await openPicker(
    {
      t,
      stage: state.stage,
      pending: state.pending,
      upload: stageImage,
      onStageChange: (path) => markDirty("assets", path),
      naturalSize: (src) => naturalSize(src, state.pending),
      bindImage: (img, src) => bindImage(img, src, state.pending),
    },
    { current, browse }
  );
  // Tidying is a change to the album even when nothing was chosen: the renames
  // travel in this album's commit. `browse` is the browser opened BY a step, on
  // its way to somewhere else, and nothing it shows is a decision.
  if (!browse && state.stage.dirty) markDirty("assets", "");
  if (!picked) return null;
  if (history.mark() !== opened && state.pending.length === had) history.fold();

  const staged = state.pending.find((a) => state.stage.resolve(a.path) === picked.path);
  return staged || { path: picked.path, site: picked.site };
}

/**
 * Read a file off disk and queue it for the next commit.
 *
 * An album's photographs belong beside the album's other photographs, so a file
 * added while editing one lands in that album's own folder rather than in the
 * post editor's `source/images/posts/`.
 */
async function stageImage(file, dir) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let path = await repo.assetPath(file.name, bytes);
  const home = dir || defaultFolder();
  if (home) path = String(home).replace(/\/+$/, "") + "/" + path.split("/").pop();

  const existing = state.pending.find((a) => a.path === path);
  if (existing) return existing;

  const url = URL.createObjectURL(file);
  const asset = { path, site: "/" + path.replace(/^source\//, ""), bytes, url, name: file.name };

  const size = await new Promise((done) => {
    const probe = new Image();
    probe.onload = () => done({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => done(null);
    probe.src = url;
  });
  if (size && size.width) Object.assign(asset, size);

  state.pending.push(asset);
  markDirty("assets", asset.path);
  return asset;
}

/** Where this album already keeps its pictures, or a folder named after it. */
function defaultFolder() {
  for (const node of images()) {
    const stored = String(imageFields(node).image || "");
    if (!stored || stored.startsWith("/")) continue;
    const cut = stored.lastIndexOf("/");
    if (cut > 0) return "source/masonry/" + stored.slice(0, cut);
  }
  const title = albumTitle(itemFields(state.item));
  return title ? "source/masonry/" + title : "source/masonry";
}

/** An address the album now uses, mapped back to where the bytes still are. */
function liveAddress(src) {
  const value = String(src || "");
  if (!state.stage || !state.stage.moves.length || !value.startsWith("/")) return value;
  return siteAddress(state.stage.origin("source" + value));
}

/** The staged renames, applied to this album's own image paths. */
function applyStagedMoves() {
  if (!state.stage || !state.stage.dirty) return;
  const fresh = state.stage.moves.filter((move) => !move.noted);
  for (const node of images()) {
    const stored = String(imageFields(node).image || "");
    if (!stored) continue;
    let site = siteOf(stored);
    for (const move of fresh) {
      const from = siteAddress(move.from);
      if (site === from) site = siteAddress(move.to);
    }
    const next = storedOf(site);
    if (next !== stored) setImageField(node, "image", next);
  }
  for (const key of ["avatar", "thumbnail"]) {
    const value = String(itemFields(state.item)[key] || "");
    if (!value) continue;
    let site = value;
    for (const move of fresh) {
      if (site === siteAddress(move.from)) site = siteAddress(move.to);
    }
    if (site !== value) setItemField(state.item, key, site);
  }
}

/* ─── stepping back and forward ────────────────────────────────────────────── */

/**
 * Undo and redo, as whole-album snapshots.
 *
 * The same bargain history.js makes for a post, at the scale an album needs: the
 * document here is one `list:` entry and a handful of category keys, so a
 * snapshot is a few short strings rather than a tree — small enough that sharing
 * structure between steps would cost more than it saved. What is stored is the
 * text `emitItem` would have written, so a step can never put the album into a
 * state a save could not reproduce.
 *
 * Typing merges the way it does there: consecutive bursts naming the same field
 * collapse into the step already on top, and anything structural is a step of
 * its own.
 *
 * ── A step is a journey ─────────────────────────────────────────────────────
 *
 * The same four moves a post's step makes, for the same reason: a change that
 * lands somewhere the author is not looking is a change they watched do nothing.
 * `decide` says where and how, `goToStep` gets there — opening the picture
 * browser or the property sheet when that is where the work happened — the
 * canvas then travels, and `spotlight` lights the place once it has settled.
 * Presses are counted rather than dropped, so the buttons can be hammered.
 */
const LIMIT = 200;
const RUN_MS = 1500;
const LIVE = new Set(["text", "front", "props"]);

/** A photograph's keys, read back from a snapshot's copy of its text. */
function rowFields(row) {
  return readKeys(row.body, row.lead.length);
}

/** The first property two versions of one photograph disagree on. */
function propsField(a, b) {
  const x = rowFields(a);
  const y = rowFields(b);
  for (const key of PROP_KEYS) {
    if ((x[key] || "") !== (y[key] || "")) return YML_EXIF[key] || key;
  }
  return "";
}

/** The first album key two versions of the album's own block disagree on. */
function frontField(a, b) {
  const x = readKeys(a.pre, a.lead.length);
  const y = readKeys(b.pre, b.lead.length);
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if ((x[key] || "") !== (y[key] || "")) return key;
  }
  return "";
}

/**
 * What a step is about, and what shape it has.
 *
 * The picture browser is read first: renaming a picture and then choosing it is
 * one step, and naming the photograph would take the author to a tile whose
 * address changed for a reason they could not see.
 */
function decide(from, to, cause) {
  const filed = filedPath(from, to);
  if (filed) return { kind: "asset", path: filed.path, was: filed.was };

  const now = new Map(from.imgs.map((row) => [row.id, row]));
  const want = new Map(to.imgs.map((row) => [row.id, row]));
  const named = cause && cause.target ? String(cause.target) : "";

  // What the author actually DID, taken from the edit that made the step. Two
  // orderings of one list cannot say which photograph was the one dragged.
  if (cause && cause.kind === "images" && named && want.has(named) && now.has(named)) {
    return { kind: "image", id: named, how: "move" };
  }
  if (cause && cause.kind === "props" && want.has(named) && now.has(named)) {
    const key = propsField(now.get(named), want.get(named));
    if (key) return { kind: "props", id: named, key };
  }
  if (cause && cause.kind === "assets") {
    const added = uploadPath(from, to);
    if (added) return { kind: "asset", path: added, was: added };
  }

  for (const row of to.imgs) {
    const here = now.get(row.id);
    if (here && here.body !== row.body) return { kind: "image", id: row.id, how: "edit" };
  }
  for (const row of to.imgs) if (!now.has(row.id)) return { kind: "image", id: row.id, how: "add" };

  // One left. There is nothing left to light, so the GAP it left is marked
  // instead: lighting a neighbour would say the neighbour had changed.
  for (let i = 0; i < from.imgs.length; i++) {
    if (want.has(from.imgs[i].id)) continue;
    let above = "";
    for (let j = i - 1; j >= 0; j--) {
      if (want.has(from.imgs[j].id)) {
        above = from.imgs[j].id;
        break;
      }
    }
    let below = "";
    for (let j = i + 1; j < from.imgs.length; j++) {
      if (want.has(from.imgs[j].id)) {
        below = from.imgs[j].id;
        break;
      }
    }
    return { kind: "seam", above, below };
  }

  const moved = movedId(from.imgs, to.imgs);
  if (moved) return { kind: "image", id: moved, how: "move" };

  if (from.pre !== to.pre) {
    const key = frontField(from, to);
    return key === "name" || key === "page-title" ? { kind: "title", key } : { kind: "front", key };
  }
  if (from.cat !== to.cat) return { kind: "front", key: "links_category" };

  const path = uploadPath(from, to);
  if (path) return { kind: "asset", path, was: path };
  return { kind: "canvas" };
}

const history = (() => {
  let stack = [];
  let index = -1;
  let base = -1;
  let run = null;
  let revision = 0;
  let foldUntil = 0;
  let shut = false;
  let queue = 0;
  let running = false;

  /**
   * Every photograph's own id, kept beside its text.
   *
   * Re-parsing the album as one block was correct and unusable: every node came
   * back with a fresh id, so the canvas could not recognise a single tile,
   * rebuilt all of them, and every step cost a full re-layout of the columns and
   * a new request for every picture in the album.
   */
  function take() {
    const item = state.item;
    return {
      lead: item.lead,
      eol: item.eol,
      imageLead: item.imageLead,
      pre: item.pre,
      imagesLine: item.imagesLine,
      post: item.post,
      tail: item.tail,
      imgs: item.images.map((n) => ({ id: n.id, lead: n.lead, body: n.body, tail: n.tail, eol: n.eol })),
      cat: state.cat ? state.cat.pre : "",
      catName: state.cat ? state.cat.openedName : "",
      pending: state.pending.slice(),
      moves: (state.stage ? state.stage.moves : []).map((m) => ({ from: m.from, to: m.to, noted: !!m.noted })),
      folders: state.stage ? Array.from(state.stage.folders) : [],
      sel: state.selected,
    };
  }

  function digest(snap) {
    return [
      snap.pre,
      snap.imagesLine,
      snap.post,
      snap.tail,
      snap.imgs.map((r) => r.id + UNIT + r.lead + UNIT + r.body + UNIT + r.tail).join(UNIT),
      snap.cat,
      snap.catName,
      snap.pending.map((a) => a.path).join(","),
      snap.moves.map((m) => `${m.from}>${m.to}`).join(","),
      snap.folders.join(","),
    ].join("");
  }

  /** The model only. What is on screen is reconciled against it afterwards. */
  function restore(snap) {
    const item = state.item;
    item.lead = snap.lead;
    item.eol = snap.eol;
    item.imageLead = snap.imageLead;
    item.pre = snap.pre;
    item.imagesLine = snap.imagesLine;
    item.post = snap.post;
    item.tail = snap.tail;
    item.images = snap.imgs.map((r) => ({ id: r.id, lead: r.lead, body: r.body, tail: r.tail, eol: r.eol }));

    if (state.cat) state.cat.pre = snap.cat;
    state.pending = snap.pending.slice();
    if (state.stage) {
      state.stage.moves.length = 0;
      for (const move of snap.moves) state.stage.moves.push({ ...move });
      state.stage.folders.clear();
      for (const path of snap.folders) state.stage.folders.add(path);
    }
    state.selected = item.images.some((n) => n.id === snap.sel) ? snap.sel : "";
  }

  /** One step, landed: travel, reconcile, light. */
  async function land(snap, target, quick) {
    if (!state.on || !ui) return;
    const chrome = ui;

    // One. Get to where it happened, and WAIT for it: a canvas rearranged while
    // the viewport is still travelling is a FLIP measured in two places.
    await goToStep(target, quick);
    if (!state.on || ui !== chrome) return;

    // Two. The page is held still by the tile the step is about, because that is
    // the one thing being looked at and everything else may move around it.
    const anchor = (target.id ? tileOf(target.id) : null) || steadyTile();
    const wasPre = state.item.pre;
    const wasCat = state.cat ? state.cat.pre : "";
    restore(snap);
    if (quick) await anchored(anchor, () => syncTiles());
    else await flipTiles(() => syncTiles(), anchor);
    if (!state.on || ui !== chrome) return;

    syncTitle();
    // Only when the album's own keys moved: the card is rebuilt from its
    // markup, and rebuilding it under a field being typed into takes the caret
    // out of that field.
    if (wasPre !== state.item.pre || wasCat !== (state.cat ? state.cat.pre : "")) repaintCard();
    syncHeader();
    observeImages();
    contentChanged();
    if (ui.toolbar) ui.toolbar.sync();

    // Three. Light the place, now that the album has stopped moving.
    await spotlight(target, quick);
  }

  function changed() {
    if (ui && ui.toolbar) ui.toolbar.history(api.can());
    const want = api.dirtyState();
    if (want !== null && state.on && state.dirty !== want) {
      state.dirty = want;
      syncHeader();
    }
  }

  /**
   * Work the queue down.
   *
   * A step takes a few hundred milliseconds to animate and the buttons can be
   * hammered, so presses are COUNTED rather than dropped and every step but the
   * last is applied without its animation. The alternative was an editor that
   * ignores four presses out of five and then arrives somewhere unexpected.
   */
  async function pump() {
    running = true;
    try {
      while (queue !== 0) {
        const dir = queue > 0 ? 1 : -1;
        const to = index + dir;
        if (to < 0 || to >= stack.length) {
          queue = 0;
          break;
        }
        queue -= dir;

        // Undoing takes back the edit that made the step we are ON; redoing
        // re-applies the one that made the step we are going TO.
        const cause = dir < 0 ? stack[index].by : stack[to].by;
        const target = decide(stack[index], stack[to], cause);
        shut = true;
        try {
          await land(stack[to], target, queue !== 0);
          index = to;
        } finally {
          shut = false;
          run = null;
        }
        changed();
      }
    } finally {
      running = false;
    }
    return true;
  }

  function drive(dir) {
    foldUntil = 0;
    if (index < 0 || state.saving) return Promise.resolve(false);
    queue += dir;
    if (running) return Promise.resolve(true);
    return pump();
  }

  const api = {
    start(clean) {
      stack = [take()];
      index = 0;
      base = clean === false ? -1 : 0;
      run = null;
      revision = 0;
      foldUntil = 0;
      queue = 0;
      running = false;
      shut = false;
      changed();
    },
    record(kind, target) {
      if (shut || index < 0) return;
      const snap = take();
      if (digest(stack[index]) === digest(snap)) return;

      const now = Date.now();
      const folding = foldUntil > now;
      const merge =
        index > 0 &&
        (folding ||
          (run && LIVE.has(kind) && run.kind === kind && run.target === target && now - run.at < RUN_MS));
      foldUntil = 0;

      // What made this step, kept with it. `decide` reads it back when the shape
      // of the change cannot say on its own what the author acted on.
      snap.by = { kind: kind || "text", target: target == null ? "" : String(target) };

      if (merge) {
        stack[index] = snap;
      } else {
        stack.length = index + 1;
        stack.push(snap);
        if (stack.length > LIMIT) {
          stack.shift();
          base = base > 0 ? base - 1 : -1;
        }
        index = stack.length - 1;
        revision += 1;
      }
      run = { kind, target, at: now };
      changed();
    },
    undo: () => drive(-1),
    redo: () => drive(1),
    can() {
      return { undo: index + queue > 0, redo: index >= 0 && index + queue < stack.length - 1 };
    },
    mark: () => revision,
    fold() {
      if (index > 0) foldUntil = Date.now() + 2000;
    },
    dirtyState() {
      if (index < 0 || base < 0 || !stack[index] || !stack[base]) return null;
      return digest(stack[index]) !== digest(stack[base]);
    },
    /**
     * The commit landed. Every step still on the stack describes a document
     * whose pictures are already in the repository, so stepping back through one
     * must not queue those bytes again nor re-ask for a rename the build has been
     * told about — and the step on top is replaced by what was actually
     * committed, which is what makes it the one there is nothing to save against.
     */
    settle() {
      for (const snap of stack) {
        snap.pending = [];
        snap.moves = snap.moves.map((m) => ({ ...m, noted: true }));
      }
      if (index >= 0) {
        const by = stack[index].by;
        stack[index] = take();
        stack[index].by = by;
      }
      base = index;
      changed();
    },
    reset() {
      stack = [];
      index = -1;
      base = -1;
      run = null;
      queue = 0;
      running = false;
      spotClear();
      changed();
    },
  };
  return api;
})();

/* ─── getting to where a step happened ─────────────────────────────────────── */

function closeBrowser() {
  const held = pickerLive();
  if (held) held.close();
}

/**
 * The picture browser, standing on the file this step is about.
 *
 * Not awaited as a dialogue — it stays up until the author closes it — but its
 * tree IS awaited, because a step that lands before the folders have been read
 * would rebuild them from a stage that is about to be replaced.
 */
async function openBrowserAt(path) {
  let held = pickerLive();
  if (!held) {
    pickImage(path ? siteAddress(path) : "", true).catch(() => {});
    held = pickerLive();
  }
  if (held && held.ready) await held.ready;
  // Already open, on something else: walk it to the file this step is about
  // before the step lands, so what changes is a name and not the whole panel.
  if (held && path) held.goto(path);
}

/**
 * Get to where the step happens, before it happens.
 *
 * A step that lands behind a closed dialogue is a step the author watched do
 * nothing. A run of presses skips all of it: five reveals in a row is five
 * animations nobody asked for.
 */
async function goToStep(target, quick) {
  // The browser opens on the name the file has RIGHT NOW — `target.path` is
  // where the step is about to put it — so a rename is visible AS a rename.
  if (target.kind === "asset") {
    closeSheet();
    return void (await openBrowserAt(target.was || target.path));
  }
  closeBrowser();

  // The picture first, then its sheet, then the field, so what changes is a
  // value the author is already looking at.
  if (target.kind === "props") {
    const tile = tileOf(target.id);
    const node = nodeOf(target.id);
    if (!tile || !node) return void closeSheet();
    if (!quick && !readable(tile)) await travelTo(tile);
    const held = imageProps(node, true);
    if (held) await held.reveal(target.key, !quick);
    return;
  }

  closeSheet();
  if (quick) return;

  if (target.kind === "image" || target.kind === "seam") {
    const tile = tileOf(target.id || target.below || target.above);
    if (tile && !readable(tile)) await travelTo(tile);
    return;
  }
  const el = fieldNode(target);
  if (el && !readable(el)) await travelTo(el);
}

const KEY_NAME = /^[A-Za-z_][\w-]*$/;

/** The one element an album-level step is about, as it stands right now. */
function fieldNode(target) {
  if (target.kind === "title") return state.titleHost;
  if (target.kind !== "front" || !ui || !ui.card) return null;
  const row = KEY_NAME.test(target.key || "") ? ui.card.el.querySelector(`[data-key="${target.key}"]`) : null;
  return row || ui.card.el;
}

/**
 * Light what the step actually did, once the canvas has stopped moving.
 *
 * Four shapes, because four things want four different marks: a photograph that
 * arrived or moved wants the tile; one whose caption changed wants the tile too,
 * since the caption is drawn ON it; one that LEFT has nothing to light and gets
 * the gap it left; and an album key gets the row it lives in.
 */
async function spotlight(target, quick) {
  if (target.kind === "props") {
    const held = sheetLive();
    const node = nodeOf(target.id);
    if (!held || !node || held.id !== target.id) return;
    held.set(propsOf(node));
    return void held.flash(target.key);
  }

  if (target.kind === "asset") {
    const held = pickerLive();
    if (!held) return;
    // Rebuilt from the stage as it NOW stands: the tree was drawn before the
    // step, under the names the step has just taken away.
    held.goto(target.path);
    return void held.flash(target.path);
  }

  // A photograph left. The article marks the gap between the two that remain,
  // but a gap in a multi-column gallery is not a place: the two survivors may be
  // in different columns, so the bar between them is drawn across the page at a
  // height nothing happened at. The one that MOVED INTO the gap is the place.
  if (target.kind === "seam") {
    const tile = tileOf(target.below) || tileOf(target.above);
    if (!tile) return;
    await travelTo(tile, quick);
    return void spotElement(tile, "move");
  }

  if (target.kind === "image") {
    const tile = tileOf(target.id);
    if (!tile) return;
    await travelTo(tile, quick);
    // No strip to trim: the gutter is drawn OVER the photograph here rather
    // than in a margin beside it, so the whole tile is the change.
    return void spotElement(tile, target.how === "move" ? "move" : "block");
  }

  const el = fieldNode(target);
  if (!el) return;
  await travelTo(el, quick);
  spotElement(el, "field");
}

/* ─── dirty ────────────────────────────────────────────────────────────────── */

function markDirty(kind, target) {
  history.record(kind || "text", target == null ? "" : String(target));
  const settled = history.dirtyState();
  state.dirty = settled === null ? true : settled;
  syncHeader();

  clearTimeout(state.stashTimer);
  state.stashTimer = setTimeout(() => {
    session.stashText(stashKey(), emitItem(state.item), state.stashGrant);
  }, AUTOSTASH_MS);
}

/**
 * Where local recovery is filed.
 *
 * By the album's page title rather than by a file name: masonry.yml holds every
 * album on the site, so keying the stash on the file would give one crash net
 * for all of them and the last album edited would silently overwrite the rest.
 */
function stashKey() {
  const title = state.item ? albumTitle(itemFields(state.item)) : "";
  return `${DATA}#${state.opened.title || title || "new"}`;
}

/* ─── activate ─────────────────────────────────────────────────────────────── */

async function activate(container) {
  if (state.on) return;
  state.on = true;

  const host = findHost();
  if (!host) {
    state.on = false;
    return;
  }

  state.host = host;
  state.container = container;
  state.titleHost = host.querySelector(".page-title-header");
  state.snapshot = Array.from(container.childNodes);
  state.stage = createStage();
  state.fresh = container.dataset.albumNew === "1";

  host.classList.add("is-editing", "ed-album-host");
  document.documentElement.classList.add("blog-editing");

  ui = { bar: buildDocbar() };
  host.insertBefore(ui.bar, host.firstChild);
  Object.assign(ui, {
    path: ui.bar.querySelector(".ed-docbar-path"),
    vaultTag: ui.bar.querySelector(".ed-tag-vault"),
    draftTag: ui.bar.querySelector(".ed-tag-draft"),
    dot: ui.bar.querySelector(".ed-dot"),
    backend: ui.bar.querySelector(".ed-backend"),
    save: ui.bar.querySelector(".ed-save"),
    publish: ui.bar.querySelector(".ed-publish"),
    close: ui.bar.querySelector(".ed-close"),
    progress: ui.bar.querySelector(".ed-progress"),
    notice: ui.bar.querySelector(".ed-notice"),
  });
  state.barSize = watchDocbar(ui.bar);
  // What `travel.js` measures the readable band against.
  useChrome(() => ({
    bar: ui && ui.bar,
    toolbar: ui && ui.toolbar && ui.toolbar.el,
    hidden: chromeHidden(),
  }));

  ui.close.addEventListener("click", () => deactivate());
  watchNavigation();
  ui.path.textContent = t("opening", "Opening");
  enter(ui.bar);

  credentials.hold();

  let opened = null;
  try {
    opened = await repo.open(true);
  } catch (err) {
    notice(
      "error",
      err.message === "forbidden"
        ? t("denied", "This page is for the blog's administrator.")
        : t("unreachable", "Could not reach the backend.")
    );
    ui.path.textContent = "";
    const gate = host.querySelector(".ed-gate");
    if (gate) gate.remove();
    return;
  }

  const gate = host.querySelector(".ed-gate");
  if (gate) gate.remove();
  settleBackend(opened);

  try {
    // The manifest sizes the pictures; `components.js` carries the EXIF labels
    // the property sheet is printed with. Neither is fatal, and the sheet draws
    // its fields either way.
    await Promise.all([loadManifest(), loadComponents().catch(() => null)]);
    // False means the page is going somewhere else — the draft standing in front
    // of this album — and nothing more should be built on top of a page that is
    // about to be replaced.
    if (!(await openAlbum(container))) return;
  } catch (err) {
    notice("error", err.message);
    ui.path.textContent = "";
    return;
  }

  registerSrcResolver((node) => assetURL(node.getAttribute("data-vault-asset")));
  registerSrcFallback((node) => repoURL(node.dataset.edSrc || "", state.pending));
  registerRewind(liveAddress);

  // The card holds this object, so every later change to which album or which
  // category is being edited is a MUTATION of it. Handing the card a new object
  // would leave it painting the one it was built with, silently.
  cardModel = { doc: state.doc, item: state.item, cat: state.cat };
  ui.card = createAlbumCard(cardModel, {
    t,
    onChange: onCardChange,
    onCategory: setCategory,
    pickImage: () => pickImage(""),
    bindImage: (img, src) => bindImage(img, src, state.pending),
  });
  host.insertBefore(ui.card.el, container);

  ui.toolbar = createToolbar({
    t,
    simple: true,
    items: toolbarItems,
    view: () => null,
    richRoot: () => null,
    onAct: (action, arg) => act(action, arg),
    onStep: (dir) => (dir === "redo" ? history.redo() : history.undo()),
    onChrome: () => toggleChrome(),
    ask: () => Promise.resolve(null),
  });
  document.body.appendChild(ui.toolbar.el);

  await crossFade(container, () => paintCanvas(false));
  wireTitle();
  enter(ui.card.el);
  syncHeader();
  wire();

  history.start(!state.dirty);
  ui.toolbar.sync();

  ui.toolbar.el.dataset.perch = "show";
  await toolbarIn(ui.toolbar.el);
  state.perchOff = watchPerch(ui.toolbar.el, chromeHidden);

  if (state.fresh && state.titleHost) state.titleHost.focus();
}

/**
 * Find this album in the file, or start a new one.
 *
 * A published album that already HAS a draft is edited on the DRAFT, never here
 * — the same rule the post editor applies, for the same reason: two entries for
 * one album is a way to edit the copy nobody is looking at. The draft has a page
 * of its own at the vault prefix, so the answer is to go there.
 */
async function openAlbum(container) {
  const file = await repo.read(DATA);
  if (!file) throw new Error(`${DATA} is not in the repository`);

  state.doc = parseMasonry(file.text);

  const albums = await session.listAlbums().catch(() => []);
  state.stashGrant = (await session.adminGrant().catch(() => null)) || null;

  if (state.fresh) {
    const first = categories(state.doc)[0];
    state.cat = first || appendCategory(state.doc, makeCategory(state.doc.eol, t("cat_first", "Albums"), true));
    state.item = makeItem(state.cat.itemLead, state.doc.eol, { name: "", description: "" });
    state.opened = { title: "", draft: true, category: state.cat.openedName };
    await offerRecovery();
    return true;
  }

  const gate = document.querySelector(".vault-gate[data-vault-slug]");
  const slug = gate ? gate.dataset.vaultSlug : "";
  const here = String(container.dataset.albumTitle || "").trim();
  const mine = slug ? albums.find((row) => row.slug === slug) : null;
  const title = (mine && mine.title) || here;
  if (!title) throw new Error(t("no_album", "This album is not in the repository you can write to."));

  const onDraft = !!(mine && mine.draft);

  // A draft standing in front of this album is what readers are NOT being shown
  // and what the author means by "edit". It lives at its own vault page.
  if (!onDraft) {
    const draft = albums.find((row) => row.draft && row.supersedes === title);
    if (draft) {
      state.dirty = false;
      ui.path.textContent = t("opening", "Opening");
      location.href = `${siteRoot()}${vaultPrefix()}/${draft.slug}/#edit`;
      return false;
    }
  }

  const found = findAlbum(state.doc, title, onDraft ? "draft" : "published");
  if (!found) throw new Error(`${title} is not in ${DATA}`);

  state.cat = found.cat;
  state.item = found.item;
  state.opened = { title, draft: onDraft, category: found.cat.openedName };
  state.grant = mine || null;

  if (mine) setVaultAssets(mine.grant, mine.assets, mine.sizes);
  else setVaultAssets(null, null, null);

  if (onDraft) notice("info", t("editing_draft_album", "You are editing the draft that stands in front of this album."));

  await offerRecovery();
  return true;
}

/** The crash net, offered rather than applied. */
async function offerRecovery() {
  const cached = await session.recoverText(stashKey(), state.stashGrant).catch(() => null);
  if (!cached || cached.source === emitItem(state.item)) return;

  const answer = await openAsk(
    { t },
    {
      icon: "fa-clock-rotate-left",
      title: t("recover_title", "Unsaved local copy"),
      message: t("recover_album", "There is a copy of this album that was never committed."),
      note: new Date(cached.at).toLocaleString(),
      actions: [
        { key: "no", label: t("recover_drop", "Open what is committed") },
        { key: "yes", label: t("recover_use", "Restore it"), icon: "fa-rotate-left", kind: "primary" },
      ],
    }
  );
  if (answer !== "yes") return;

  const rebuilt = parseItemBlock(cached.source, state.doc.eol);
  rebuilt.id = state.item.id;
  state.item = rebuilt;
  state.dirty = true;
}

/* ─── the card's three kinds of change ─────────────────────────────────────── */

function onCardChange(scope, key, value) {
  if (key === "vault") state.vaultChoice = value;
  if (key === "name" || key === "page-title") {
    if (state.titleHost && state.titleHost !== document.activeElement) {
      state.titleHost.textContent = albumTitle(itemFields(state.item));
    }
    ui.path.textContent = pathLabel();
  }
  markDirty(scope === "category" ? "front" : "text", `${scope}:${key}`);
}

/**
 * Put this album in the category called `name` — making it if nothing is.
 *
 * One act, because from the card's side there is one question. A name that
 * matches moves the album; a name that does not is a new category appended to
 * the file with this album as its first entry.
 */
function setCategory(name) {
  const wanted = String(name || "").trim();
  if (!wanted || wanted === String(categoryFields(state.cat).links_category || "")) return;

  const target =
    categories(state.doc).find((node) => String(categoryFields(node).links_category || "") === wanted) ||
    appendCategory(state.doc, makeCategory(state.doc.eol, wanted, true));
  if (target === state.cat) return;

  const at = state.cat.items.indexOf(state.item);
  if (at >= 0) dropFrom(state.cat.items, at, (tail) => (state.cat.post = state.cat.post + tail));
  insertItem(target, state.item, target.items.length);
  state.cat = target;

  repaintCard();
  markDirty("front", "category");
}

/* ─── save ─────────────────────────────────────────────────────────────────── */

/**
 * Should the PUBLISHED album be encrypted?
 *
 * The switch when it was operated; otherwise whatever the album already said.
 * Unlike a post's, an album's `vault:` is never machinery — a draft is withheld
 * because it is a draft — so there is nothing to untangle here.
 */
function publishEncrypted(fields) {
  if (state.vaultChoice !== undefined && state.vaultChoice !== null) return isTrue(state.vaultChoice);
  return isTrue(fields.vault);
}

/**
 * One commit, built against the file as it is RIGHT NOW.
 *
 * The album was read minutes ago and masonry.yml holds every album on the site,
 * so the version in hand is not what a commit may be built from: another album
 * may have been added, renamed or withdrawn in between. The save re-reads the
 * file, finds this album in it by the name it had when it was opened, and
 * replaces that one entry — so a concurrent change to any other album survives,
 * and a change to THIS one is caught by the blob sha and refused rather than
 * silently overwritten.
 */
/** Append, taking over the blank line that used to close the list. */
function appendAlbum(cat, node) {
  const last = cat.items[cat.items.length - 1];
  node.tail = last ? last.tail : "";
  if (last) last.tail = "";
  return insertItem(cat, node, cat.items.length);
}

/** Put `node` in at `index` and take the entry that was there out. */
function replaceAlbum(cat, index, node) {
  node.tail = "";
  insertItem(cat, node, index);
  dropFrom(cat.items, index + 1, (tail) => (cat.post += tail));
  return node;
}

/** Slot a new entry in directly after `index`, keeping the list's own closer. */
function insertAfterAlbum(cat, index, node) {
  const before = cat.items[index];
  node.tail = before ? before.tail : "";
  if (before) before.tail = "";
  return insertItem(cat, node, index + 1);
}

async function buildCommit(mode) {
  const file = await repo.read(DATA);
  if (!file) throw new Error(`${DATA} is not in the repository`);

  const fresh = parseMasonry(file.text);
  const fields = itemFields(state.item);
  const title = albumTitle(fields);
  if (!title) throw new Error(t("need_album_title", "Give the album a name before saving it."));

  // ── the category ──────────────────────────────────────────────────────────
  // Located by the name it had when the file was READ, then given this card's
  // own keys wholesale: `pre` holds the category's settings and nothing else, so
  // copying it renames the category and sets `has_thumbnail` in one move without
  // touching a single album under it.
  let cat = state.cat.openedName ? findCategory(fresh, state.cat.openedName) : null;
  if (!cat) {
    cat = appendCategory(fresh, makeCategory(fresh.eol, categoryFields(state.cat).links_category || title, true));
  }
  cat.pre = state.cat.pre;

  const origin = state.opened.title
    ? findAlbum(fresh, state.opened.title, state.opened.draft ? "draft" : "published")
    : null;
  if (state.opened.title && !origin) {
    throw Object.assign(
      new Error(t("album_gone", "This album is no longer in masonry.yml — it may have been renamed or withdrawn.")),
      { kind: "conflict" }
    );
  }

  /**
   * The album as the canvas has it, plus the flags this save means. Round-tripped
   * through the parser so what lands in the file is exactly what was on screen.
   */
  const shaped = (extra) => {
    const node = parseItemBlock(emitItem(state.item), fresh.eol);
    for (const [key, value] of Object.entries(extra)) setItemField(node, key, value);
    return node;
  };

  const publishing = mode === "publish";
  let message = "";
  let forked = false;

  if (publishing) {
    const node = shaped({
      draft: null,
      supersedes: null,
      vault: publishEncrypted(fields) ? "true" : null,
    });

    // A draft standing in front of a published album writes back OVER it and
    // then removes itself, in this one commit — so the two are never both live
    // and never both missing. Anything else simply becomes published where it is.
    const shadowed = state.opened.draft ? String(fields.supersedes || "") : "";
    const live = shadowed ? findAlbum(fresh, shadowed, "published") : null;

    if (live) {
      replaceAlbum(live.cat, live.index, node);
      const draft = findAlbum(fresh, state.opened.title, "draft");
      if (draft) dropFrom(draft.cat.items, draft.index, (tail) => (draft.cat.post += tail));
    } else if (origin) {
      if (origin.cat === cat) replaceAlbum(cat, origin.index, node);
      else {
        dropFrom(origin.cat.items, origin.index, (tail) => (origin.cat.post += tail));
        appendAlbum(cat, node);
      }
    } else {
      appendAlbum(cat, node);
    }
    message = `Publish album: ${title}`;
  } else if (state.opened.draft && origin) {
    const node = shaped({ draft: "true", supersedes: fields.supersedes || null });
    if (origin.cat === cat) replaceAlbum(cat, origin.index, node);
    else {
      dropFrom(origin.cat.items, origin.index, (tail) => (origin.cat.post += tail));
      appendAlbum(cat, node);
    }
    message = `Draft album: ${title}`;
  } else if (origin) {
    // Editing a PUBLISHED album for the first time: it forks. The published
    // entry is left exactly as it is, so readers go on seeing that album —
    // encrypted or not, with its own key and its own audience untouched.
    const node = shaped({ draft: "true", supersedes: state.opened.title });
    if (origin.cat === cat) insertAfterAlbum(cat, origin.index, node);
    else appendAlbum(cat, node);
    // Noted, not applied: the open document only becomes the draft once the
    // commit that created it has landed. Writing `supersedes` here would leave
    // it on an album that is still the published one if the commit failed.
    forked = true;
    message = `Draft album: ${title}`;
  } else {
    appendAlbum(cat, shaped({ draft: "true" }));
    message = `Draft album: ${title}`;
  }

  const files = state.pending.map((asset) => ({
    operation: "create",
    path: state.stage.resolve(asset.path),
    content: repo.toBase64(asset.bytes),
  }));
  files.push({
    operation: "update",
    path: DATA,
    sha: file.sha,
    content: repo.toBase64(emitMasonry(fresh)),
  });

  return { files, message, title, published: publishing, forked };
}

async function doSave(mode) {
  if (!state.item || state.saving) return;

  state.saving = true;
  syncHeader();
  notice(null, "");

  try {
    applyStagedMoves();
    const plan = await buildCommit(mode);
    const result = await repo.commit(plan.files, plan.message);

    noteCommitted(state.pending, state.stage);
    for (const asset of state.pending) URL.revokeObjectURL(asset.url);
    state.pending = [];
    state.stage.settle();

    // What the album IS changes when it is saved: a new one becomes an entry, a
    // published one gains a draft in front of it, a draft becomes the published
    // album. Written BEFORE the history settles, so the step this commit is
    // clean against is the document as it now stands — otherwise stepping back
    // once would quietly take the shadow link off a draft that needs it.
    if (plan.forked) setItemField(state.item, "supersedes", state.opened.title);
    else if (plan.published) setItemField(state.item, "supersedes", null);

    history.settle();
    state.dirty = false;
    await dropStash();

    state.cat.openedName = categoryFields(state.cat).links_category || state.cat.openedName;
    state.opened = { title: plan.title, draft: !plan.published, category: state.cat.openedName };

    syncHeader();
    notice("info", `${t("saved", "Saved")} ${result.short || ""}`.trim());

    if (findContainer() && findContainer().dataset.albumNew === "1") {
      state.dirty = false;
      setTimeout(() => location.replace(`${siteRoot()}/masonry/links/`), 1200);
      return;
    }

    startProgress(result);
    if (plan.published) window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    if (err && err.kind === "conflict") {
      notice("error", t("conflict_album", "masonry.yml changed in the repository. Your work is safe here — reload to see what landed, then re-apply."));
    } else {
      notice("error", (err && err.message) || t("offline", "The Worker did not answer."));
    }
  } finally {
    state.saving = false;
    syncHeader();
  }
}

async function dropStash() {
  try {
    await session.dropStash(stashKey());
  } catch (err) {
    /* the crash net going missing is not a failure worth reporting */
  }
}

/* ─── which backend takes the commits ──────────────────────────────────────── */

function paintBackend() {
  if (!ui || !ui.backend) return;
  const rows = repo.backends();
  const id = repo.activeId();
  if (!id || rows.length < 2) {
    ui.backend.hidden = true;
    return;
  }
  const now = rows.find((row) => row.id === id);
  const other = rows.find((row) => row.id !== id);
  ui.backend.hidden = false;
  ui.backend.dataset.backend = id;
  ui.backend.innerHTML =
    `<i class="${BACKEND_ICON[id] || BACKEND_ICON.gitea}" aria-hidden="true"></i>` +
    `<span>${escapeHTML((now && now.label) || id)}</span>`;
  ui.backend.title = other ? `${t("backend_switch", "Build on")} ${other.label || other.id}` : "";
}

function settleBackend(opened) {
  paintBackend();
  if (!opened) return;
  if (opened.diverged) {
    return void notice("warn", t("backend_diverged", "The two repositories have diverged — each has commits the other does not. This session commits to the one shown."));
  }
  if (!opened.behind) return;

  notice("info", t("backend_catchup", "Bringing the preferred repository up to date…"));
  repo.catchUp(opened.behind).then((caught) => {
    if (!state.on) return;
    if (!caught) return void notice("warn", t("backend_behind", "The preferred repository is still behind; this session commits to the other one."));
    if (state.dirty || state.saving) return;
    repo.adopt(opened.behind.id);
    paintBackend();
    notice("info", t("backend_caught_up", "Up to date."));
  });
}

async function switchBackend() {
  const other = repo.backends().find((row) => row.id !== repo.activeId());
  if (!other) return;
  ui.backend.disabled = true;
  try {
    await repo.use(other.id);
    paintBackend();
  } catch (err) {
    notice("error", t("unreachable", "Could not reach the backend."));
  } finally {
    ui.backend.disabled = false;
  }
}

/* ─── the publish rail ─────────────────────────────────────────────────────── */

function startProgress(result) {
  clearInterval(state.progressTimer);
  ui.progress.hidden = false;
  ui.progress.innerHTML =
    STAGES.map(
      (stage, i) =>
        `<span class="ed-stage" data-key="${stage.key}" data-state="${i === 0 ? "done" : "wait"}">
           <i class="fa-solid ${stage.icon}" aria-hidden="true"></i>${escapeHTML(t("s_" + stage.key, stage.label))}
         </span>`
    ).join("") + `<a class="ed-stage-link" target="_blank" rel="noopener" hidden>${escapeHTML(t("view_run", "View run"))}</a>`;
  pop(ui.progress);

  const link = ui.progress.querySelector(".ed-stage-link");
  const mark = (key, value) => {
    const node = ui.progress.querySelector(`[data-key="${key}"]`);
    if (node && node.dataset.state !== value) {
      node.dataset.state = value;
      pop(node);
    }
  };

  let ticks = 0;
  state.progressTimer = setInterval(async () => {
    if ((ticks += 1) > 100) return clearInterval(state.progressTimer);

    const status = await repo.commitStatus(result.sha);
    if (!status || !status.count) return;
    if (status.url) {
      link.href = status.url;
      link.hidden = false;
    }
    if (status.state === "pending") return void mark("building", "live");

    if (status.state === "success") {
      clearInterval(state.progressTimer);
      mark("building", "done");
      mark("pushed", "done");
      mark("deployed", "live");
      setTimeout(() => {
        mark("deployed", "done");
        land();
      }, DEPLOY_MS);
    } else if (status.state === "failure" || status.state === "error") {
      clearInterval(state.progressTimer);
      mark("building", "fail");
      notice("error", t("build_failed_album", "The build failed. The album is committed; nothing published has changed."));
    }
  }, POLL_MS);
}

function land() {
  if (!state.on || state.dirty || state.saving) return;
  notice("info", t("deployed_reload", "Published. Loading the page as readers see it…"));
  state.dirty = false;
  setTimeout(() => window.location.reload(), 1200);
}

/* ─── leaving ──────────────────────────────────────────────────────────────── */

async function confirmLeave() {
  if (!state.dirty || state.leaving) return true;
  state.leaving = true;
  try {
    const answer = await openAsk(
      { t },
      {
        icon: "fa-triangle-exclamation",
        title: t("close", "Stop editing"),
        message: t("discard_album", "This album has changes that are not committed yet."),
        note: pathLabel(),
        enter: "cancel",
        actions: [
          { key: "cancel", label: t("cancel", "Cancel") },
          { key: "quit", label: t("quit", "Leave without saving") },
          { key: "save", label: t("save", "Save draft"), icon: "fa-cloud-arrow-up", kind: "primary" },
        ],
      }
    );
    if (answer === "cancel" || answer == null) return false;
    if (answer === "save") {
      await doSave("draft");
      return !state.dirty;
    }
    return true;
  } finally {
    state.leaving = false;
  }
}

async function deactivate() {
  if (!state.on) return;
  if (!(await confirmLeave())) return;
  await teardown(true);
}

/** Put the page back exactly as it was found. */
async function teardown(restore) {
  if (!state.on) return;
  state.on = false;

  clearTimeout(state.stashTimer);
  clearInterval(state.progressTimer);
  unwire();
  closeDialogs();
  spotClear();
  useChrome(null);
  if (state.perchOff) state.perchOff();
  releaseDocbar(state.barSize);

  if (ui) {
    if (ui.toolbar) ui.toolbar.el.remove();
    if (ui.card) ui.card.el.remove();
    if (ui.bar) await exit(ui.bar).then(() => ui.bar.remove());
  }

  if (state.titleHost) {
    state.titleHost.removeAttribute("contenteditable");
    state.titleHost.removeAttribute("spellcheck");
    state.titleHost.classList.remove("ed-title");
    delete state.titleHost.dataset.placeholder;
  }

  if (restore && state.container) {
    state.container.innerHTML = "";
    for (const node of state.snapshot) state.container.appendChild(node);
    settleGallery();
    observeImages();
  }

  for (const asset of state.pending) URL.revokeObjectURL(asset.url);
  if (state.host) state.host.classList.remove("is-editing", "ed-album-host");
  document.documentElement.classList.remove("blog-editing");
  document.documentElement.dataset.edChrome = "";

  registerRewind(null);
  setVaultAssets(null, null, null);
  history.reset();
  credentials.release();

  ui = null;
  reset();
  contentChanged();
}

/* ─── wiring ───────────────────────────────────────────────────────────────── */

let swupOff = [];

function watchNavigation() {
  if (swupOff.length) return;
  try {
    swupOff.push(
      swup.hooks.on("visit:start", (visit) => {
        if (!state.on) return;
        if (state.dirty) return;
        teardown(false);
      })
    );
  } catch (err) {
    /* no swup: every navigation is a full load, and `beforeunload` covers it */
  }
}

function wire() {
  ui.backend.addEventListener("click", () => switchBackend());
  ui.save.addEventListener("click", () => doSave("draft"));
  ui.publish.addEventListener("click", async () => {
    const answer = await openAsk(
      { t },
      {
        icon: "fa-paper-plane",
        title: t("publish", "Publish"),
        message: state.opened.draft
          ? t("publish_album_draft", "Publish this draft over the album it replaces?")
          : t("publish_album", "Commit this straight to the published album?"),
        note: pathLabel(),
        actions: [
          { key: "no", label: t("cancel", "Cancel") },
          { key: "go", label: t("publish", "Publish"), icon: "fa-paper-plane", kind: "primary" },
        ],
      }
    );
    if (answer === "go") doSave("publish");
  });

  state.container.addEventListener("click", onCanvasClick);
  state.container.addEventListener("dblclick", onCanvasDouble);
  state.container.addEventListener("dragstart", onDragStart);
  state.container.addEventListener("dragend", onDragEnd);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onNavAway, true);
  window.addEventListener("beforeunload", onLeave);
}

function unwire() {
  for (const off of swupOff.splice(0)) {
    try {
      off();
    } catch (err) {
      /* already gone with the hooks it belonged to */
    }
  }
  if (state.container) {
    state.container.removeEventListener("click", onCanvasClick);
    state.container.removeEventListener("dblclick", onCanvasDouble);
    state.container.removeEventListener("dragstart", onDragStart);
    state.container.removeEventListener("dragend", onDragEnd);
  }
  dragOff();
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("click", onNavAway, true);
  window.removeEventListener("beforeunload", onLeave);
}

function onCanvasClick(e) {
  if (e.target.closest(".ed-album-add")) {
    e.preventDefault();
    return void addImage();
  }
  const add = e.target.closest(".ed-tile .ed-add");
  if (add) {
    e.preventDefault();
    const tile = add.closest(".ed-tile");
    return void addImage(indexOf(tile.dataset.id));
  }
  if (e.target.closest(".ed-tile .ed-handle")) return;
  const tile = e.target.closest(".ed-tile");
  select(tile ? tile.dataset.id : "");
}

function onCanvasDouble(e) {
  const tile = e.target.closest(".ed-tile");
  if (!tile || e.target.closest(".ed-gutter")) return;
  e.preventDefault();
  const node = nodeOf(tile.dataset.id);
  if (node) imageProps(node);
}

/* ─── drag to reorder ──────────────────────────────────────────────────────── */

/**
 * A drag starts from the HANDLE, never from the picture.
 *
 * The same rule the article follows: a tile you can pick up anywhere is a tile
 * you pick up by accident every time you mean to select it, and on a touch
 * screen it is a gallery that cannot be scrolled. The handle is the one thing
 * here that is `draggable`.
 */
function onDragStart(e) {
  const handle = e.target.closest && e.target.closest(".ed-handle");
  const tile = handle && handle.closest(".ed-tile");
  if (!tile) return;

  state.dragId = tile.dataset.id;
  state.container.classList.add("is-dragging");
  tile.classList.add("is-dragging");
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tile.dataset.id);
  } catch (err) {
    /* Safari refuses the custom type; the id is held in state anyway */
  }
  // The tile, not the handle: a 26px square is not something you can aim.
  setDragImage(e, tile);

  // On the DOCUMENT, so a pointer that wanders into the page margin or over the
  // document bar is still holding a photograph. Bound only for the drag.
  document.addEventListener("dragover", onDocDragOver);
  document.addEventListener("drop", onDocDrop);
}

function dragOff() {
  document.removeEventListener("dragover", onDocDragOver);
  document.removeEventListener("drop", onDocDrop);
  if (edge) edge.stop();
}

/**
 * Where a dropped photograph would land, as a POSITION IN THE LIST.
 *
 * The nearest tile to the pointer, and then which half of it the pointer is in
 * — a masonry column is a column, so "above this one" and "below it" are the
 * only two answers a tile can give, and a line drawn on its edge says exactly
 * which. Distance is measured to the RECTANGLE rather than to its centre, so a
 * pointer inside a tall tile always chooses that tile.
 */
function dropAt(x, y) {
  let best = null;
  for (const el of tiles()) {
    if (el.dataset.id === state.dragId) continue;
    const rect = el.getBoundingClientRect();
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const gap = Math.hypot(dx, dy);
    if (!best || gap < best.gap) best = { gap, el, rect };
  }
  if (!best) return null;
  return { el: best.el, side: y > (best.rect.top + best.rect.bottom) / 2 ? "after" : "before" };
}

/**
 * Paint the insertion line, and ONLY when it moves.
 *
 * Clearing every tile's `data-drop` on each `dragover` tore the pseudo-element
 * down and built it again several times a second, which restarted its entrance
 * animation each time — the flicker was the indicator being recreated.
 */
function paintDrop(target) {
  const key = target ? target.el.dataset.id + ":" + target.side : "";
  if (key === state.dropAt) return;
  state.dropAt = key;
  for (const el of tiles()) {
    const want = target && el === target.el ? target.side : "";
    if (el.dataset.drop !== want) el.dataset.drop = want;
  }
}

let edge = null;

function onDocDragOver(e) {
  if (!state.dragId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (!edge) edge = createEdgeScroll(null);
  edge.track(e.clientY);
  paintDrop(dropAt(e.clientX, e.clientY));
}

async function onDocDrop(e) {
  const dragId = state.dragId;
  if (!dragId) return;
  e.preventDefault();

  const target = dropAt(e.clientX, e.clientY);
  onDragEnd();
  if (!target) return;

  const from = indexOf(dragId);
  const to = indexOf(target.el.dataset.id);
  if (from < 0 || to < 0) return;
  // The slot counts the photograph being carried while it is still in the list,
  // so taking it out of an earlier position shifts every later one down.
  let at = to + (target.side === "after" ? 1 : 0);
  if (from < at) at -= 1;
  await moveImage(from, at);
}

function onDragEnd() {
  state.dragId = "";
  state.dropAt = "";
  dragOff();
  if (!state.container) return;
  state.container.classList.remove("is-dragging");
  for (const el of state.container.querySelectorAll(".ed-tile")) {
    el.classList.remove("is-dragging");
    el.dataset.drop = "";
  }
}

/* ─── keys and leaving ─────────────────────────────────────────────────────── */

function typing() {
  const node = document.activeElement;
  return !!(node && node.closest && node.closest(".ed-ask, .ed-pick-field, .ed-pick-row, .ed-sheet .ed-f-input, .ed-front"));
}

function onKey(e) {
  if (!state.on) return;

  // A dialogue owns Escape while it is open, and so does a field being typed
  // into — closing the whole album because somebody wanted to abandon a value
  // is the opposite of what the key means there.
  if (e.key === "Escape") {
    if (document.querySelector(".ed-picker-mask, .ed-ask")) return;
    if (typing() || isTitle()) return void document.activeElement.blur();
    e.preventDefault();
    return void deactivate();
  }

  if (!e.metaKey && !e.ctrlKey) {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected && !typing() && !isTitle()) {
      e.preventDefault();
      act("delete");
    }
    return;
  }

  if (e.key === "s") {
    e.preventDefault();
    return void doSave("draft");
  }

  const step = e.key === "z" || e.key === "Z" ? (e.shiftKey ? "redo" : "undo") : e.key === "y" || e.key === "Y" ? "redo" : "";
  if (!step || typing()) return;
  e.preventDefault();
  e.stopPropagation();
  if (state.saving) return;
  if (step === "redo") history.redo();
  else history.undo();
}

function isTitle() {
  return !!(state.titleHost && document.activeElement === state.titleHost);
}

function onLeave(e) {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
}

function onNavAway(e) {
  if (!state.on || !state.dirty || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const link = e.target.closest && e.target.closest("a[href]");
  if (!link) return;
  const target = link.getAttribute("target");
  if (target && target !== "_self") return;
  if (link.closest(".ed-docbar, .ed-front, .ed-toolbar, .ed-picker-mask")) return;

  const href = link.href;
  if (!href || !/^https?:/i.test(href)) return;
  if (href.replace(/#.*$/, "") === location.href.replace(/#.*$/, "")) return;

  e.preventDefault();
  e.stopPropagation();
  confirmLeave().then((go) => {
    if (!go) return;
    state.dirty = false;
    window.location.href = href;
  });
}

/* ─── boot ─────────────────────────────────────────────────────────────────── */

let pencils = [];

/** An encrypted album mounts its gallery only after it decrypts. */
function waitForContainer(deadline) {
  const container = findContainer();
  if (container || Date.now() > deadline) return Promise.resolve(container);
  return new Promise((resolve) => setTimeout(() => resolve(waitForContainer(deadline)), 120));
}

async function openHere() {
  const [container] = await Promise.all([waitForContainer(Date.now() + 6000), loadStrings()]);
  if (container) await activate(container);
}

function onPencil(e) {
  e.preventDefault();
  openHere();
}

export async function initMasonryEditor() {
  teardownMasonryEditor();

  const container = findContainer();
  if (container && container.dataset.albumNew === "1") return void openHere();

  pencils = Array.from(document.querySelectorAll(".tool-edit-album"));
  for (const node of pencils) node.addEventListener("click", onPencil);

  if (location.hash === "#edit") openHere();
}

export function teardownMasonryEditor() {
  for (const node of pencils) node.removeEventListener("click", onPencil);
  pencils = [];
  if (state.on) teardown(false);
}
