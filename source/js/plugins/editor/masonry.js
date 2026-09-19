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
  sheetLive,
  siteAddress,
} from "./picker.js";
import { PERCH_AT, releaseDocbar, watchDocbar, watchPerch } from "./chrome.js";
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
import { contentChanged, crossFade, enter, exit, flip, pop, reduced, toolbarIn } from "./motion.js";
import { initMasonry } from "../masonry.js";

const DATA = "source/_data/masonry.yml";
const AUTOSTASH_MS = 4000;
const DEPLOY_MS = 20000;
const POLL_MS = 6000;

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
 * One photograph, drawn exactly as the published gallery draws it.
 *
 * `masonry.ejs`'s own markup — `.masonry-item` around `.image-container` around
 * the article's `.img-preloader`, with the title and the description as the two
 * overlays — so what is on screen while the album is edited is the album, not a
 * preview of it. The compact-mode measuring pass and the image viewer are the
 * gallery's own and work on this unchanged.
 */
function buildTile(node) {
  const fields = imageFields(node);
  const tile = document.createElement("div");
  tile.className = "masonry-item ed-tile";
  tile.dataset.id = node.id;
  tile.draggable = true;
  tile.dataset.on = node.id === state.selected ? "1" : "0";

  const box = document.createElement("div");
  box.className = "image-container" + (fields.title && !fields.description ? " masonry-title-only" : "");

  const media = buildPreloader(siteOf(fields.image), fields.title || "", state.pending);
  // A click on the canvas SELECTS a photograph; the viewer is the toolbar's.
  media.setAttribute("data-no-viewer", "");
  box.appendChild(media);

  if (fields.title) {
    const label = document.createElement("div");
    label.className = "image-title";
    label.textContent = fields.title;
    box.appendChild(label);
  }
  if (fields.description) {
    const label = document.createElement("div");
    label.className = "image-description";
    label.textContent = fields.description;
    box.appendChild(label);
  }

  const badge = document.createElement("span");
  badge.className = "ed-tile-n";
  badge.textContent = String(indexOf(node.id) + 1);
  box.appendChild(badge);

  tile.appendChild(box);
  return tile;
}

function paintCanvas() {
  const container = state.container;
  container.innerHTML = "";
  for (const node of images()) container.appendChild(buildTile(node));
  if (!images().length) {
    const empty = document.createElement("p");
    empty.className = "ed-album-empty";
    empty.innerHTML = `<i class="fa-regular fa-images" aria-hidden="true"></i><span>${escapeHTML(
      t("album_empty", "No photographs yet. Add one from the toolbar.")
    )}</span>`;
    container.appendChild(empty);
  }
  observeImages();
  settleGallery();
  contentChanged();
}

/** Repaint one tile in place, so the pictures around it are never re-requested. */
function repaintTile(node) {
  const old = state.container.querySelector(`.ed-tile[data-id="${CSS.escape(node.id)}"]`);
  if (!old) return void paintCanvas();
  const next = buildTile(node);
  old.replaceWith(next);
  observeImages();
  settleGallery();
  contentChanged();
}

function renumber() {
  const tiles = state.container.querySelectorAll(".ed-tile .ed-tile-n");
  tiles.forEach((badge, i) => (badge.textContent = String(i + 1)));
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id || "";
  for (const tile of state.container.querySelectorAll(".ed-tile")) {
    tile.dataset.on = tile.dataset.id === state.selected ? "1" : "0";
  }
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

/** The gallery's own compact-overlay measuring pass, for tiles it never saw. */
function settleGallery() {
  try {
    initMasonry();
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
  return [
    {
      kind: "btn",
      act: "folder",
      icon: "fa-folder-open",
      label: "Open folder",
      tt: "open_folder",
      wide: true,
      disabled: off,
    },
    {
      kind: "btn",
      act: "props",
      icon: "fa-sliders",
      label: "Properties",
      tt: "properties",
      wide: true,
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
    { kind: "btn", act: "add", icon: "fa-image", label: "Add a picture", tt: "add_image", wide: true },
  ];
}

async function act(action, arg) {
  const node = selectedNode();
  if (action === "add") return void addImage();
  if (!node) return;

  if (action === "view") {
    return void openViewer(state.container.querySelector(`.ed-tile[data-id="${CSS.escape(node.id)}"]`));
  }
  if (action === "props") return void imageProps(node);

  if (action === "folder") {
    const picked = await pickImage(siteOf(imageFields(node).image));
    if (!picked) return;
    setImageField(node, "image", storedOf(picked.site));
    markDirty("image", node.id);
    repaintTile(node);
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
    markDirty("images", clone.id);
    paintCanvas();
    select(clone.id);
    return;
  }

  if (action === "delete") {
    const at = indexOf(node.id);
    const tile = state.container.querySelector(`.ed-tile[data-id="${CSS.escape(node.id)}"]`);
    dropFrom(images(), at, (tail) => (state.item.post = tail + state.item.post));
    markDirty("images", node.id);
    const next = images()[Math.min(at, images().length - 1)];
    state.selected = next ? next.id : "";
    if (tile && !reduced()) {
      await flip(Array.from(state.container.querySelectorAll(".ed-tile")), () => tile.remove());
    }
    paintCanvas();
    if (ui.toolbar) ui.toolbar.sync();
    return;
  }

  if (action === "move") {
    const delta = Number(arg) || 0;
    const at = indexOf(node.id);
    const to = at + delta;
    if (to < 0 || to >= images().length) return;
    const list = images();
    // The tails stay with their POSITIONS, not with the nodes: the blank line
    // after the last photograph closes the list, and carrying it along with a
    // photograph being moved up would open a gap in the middle of it.
    const tails = list.map((n) => n.tail);
    list.splice(to, 0, list.splice(at, 1)[0]);
    list.forEach((n, i) => (n.tail = tails[i]));
    markDirty("images", node.id);
    await flip(Array.from(state.container.querySelectorAll(".ed-tile")), () => paintCanvas());
    renumber();
    return;
  }
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

async function addImage() {
  const picked = await pickImage("");
  if (!picked) return;
  const node = makeImage(state.item.imageLead, state.item.eol, storedOf(picked.site));
  insertImage(node, state.selected ? indexOf(state.selected) + 1 : images().length);
  markDirty("images", node.id);
  paintCanvas();
  select(node.id);
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
function imageProps(node) {
  const held = sheetLive();
  if (held && held.id === node.id) return;
  if (held) held.close();

  const api = window.RedefineComponents;
  const labels = (api && api.EXIF_LABELS) || {};
  const id = node.id;

  openSheet(
    { t },
    {
      id,
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
          fields: keys.filter((k) => labels[k]).map((k) => ({ key: k, label: labels[k] })),
        })),
      ],
    }
  ).then((answer) => {
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
    repaintTile(live);
    if (ui.toolbar) ui.toolbar.refresh();
  });
}

/* ─── pictures ─────────────────────────────────────────────────────────────── */

async function pickImage(current) {
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
    { current }
  );
  if (state.stage.dirty) markDirty("assets", "");
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
 * snapshot is two short strings rather than a tree — small enough that sharing
 * structure between steps would cost more than it saved. Restoring re-parses the
 * text, which is exactly what a commit would have written, so a step can never
 * put the album into a state a save could not reproduce.
 *
 * Typing merges the way it does there: consecutive bursts naming the same field
 * collapse into the step already on top, and anything structural is a step of
 * its own.
 */
const LIMIT = 200;
const RUN_MS = 1500;
const LIVE = new Set(["text", "front", "props"]);

const history = (() => {
  let stack = [];
  let index = -1;
  let base = -1;
  let run = null;
  let revision = 0;
  let foldUntil = 0;
  let shut = false;

  function take() {
    return {
      item: emitItem(state.item),
      cat: state.cat ? state.cat.pre : "",
      catName: state.cat ? state.cat.openedName : "",
      pending: state.pending.slice(),
      moves: (state.stage ? state.stage.moves : []).map((m) => ({ from: m.from, to: m.to, noted: !!m.noted })),
      folders: state.stage ? Array.from(state.stage.folders) : [],
      sel: Math.max(0, indexOf(state.selected)),
    };
  }

  function digest(snap) {
    return [
      snap.item,
      snap.cat,
      snap.catName,
      snap.pending.map((a) => a.path).join(","),
      snap.moves.map((m) => `${m.from}>${m.to}`).join(","),
      snap.folders.join(","),
    ].join("");
  }

  function apply(snap) {
    shut = true;
    try {
      const rebuilt = parseItemBlock(snap.item, state.item.eol);
      rebuilt.id = state.item.id;
      state.item = rebuilt;
      if (state.cat) state.cat.pre = snap.cat;
      state.pending = snap.pending.slice();
      if (state.stage) {
        state.stage.moves.length = 0;
        for (const move of snap.moves) state.stage.moves.push({ ...move });
        state.stage.folders.clear();
        for (const path of snap.folders) state.stage.folders.add(path);
      }
      const at = images()[Math.min(snap.sel, images().length - 1)];
      state.selected = at ? at.id : "";
      paintCanvas();
      syncTitle();
      repaintCard();
      state.dirty = index !== base;
      syncHeader();
      if (ui.toolbar) ui.toolbar.sync();
    } finally {
      shut = false;
    }
  }

  function changed() {
    if (ui && ui.toolbar) ui.toolbar.history(api.can());
  }

  const api = {
    start(clean) {
      stack = [take()];
      index = 0;
      base = clean === false ? -1 : 0;
      run = null;
      revision = 0;
      foldUntil = 0;
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
    undo() {
      if (index <= 0) return;
      index -= 1;
      run = null;
      apply(stack[index]);
      changed();
    },
    redo() {
      if (index < 0 || index >= stack.length - 1) return;
      index += 1;
      run = null;
      apply(stack[index]);
      changed();
    },
    can() {
      return { undo: index > 0, redo: index >= 0 && index < stack.length - 1 };
    },
    mark: () => revision,
    fold() {
      if (index > 0) foldUntil = Date.now() + 2000;
    },
    dirtyState() {
      if (index < 0 || base < 0) return null;
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
      if (index >= 0) stack[index] = take();
      base = index;
      changed();
    },
    reset() {
      stack = [];
      index = -1;
      base = -1;
      run = null;
      changed();
    },
  };
  return api;
})();

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
    await loadManifest();
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
    onMove: moveToCategory,
    onNewCategory: newCategory,
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

  await crossFade(container, () => paintCanvas());
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

/** Move this album into another category that already exists. */
function moveToCategory(name) {
  const target = categories(state.doc).find(
    (node) => String(categoryFields(node).links_category || "") === name
  );
  if (!target || target === state.cat) return;

  const at = state.cat.items.indexOf(state.item);
  if (at >= 0) dropFrom(state.cat.items, at, (tail) => (state.cat.post = state.cat.post + tail));
  insertItem(target, state.item, target.items.length);
  state.cat = target;

  repaintCard();
  markDirty("front", "category");
}

async function newCategory() {
  const name = await askName(t("cat_new_title", "New category"), "");
  if (!name) return;
  const existing = categories(state.doc).find(
    (node) => String(categoryFields(node).links_category || "") === name
  );
  const target = existing || appendCategory(state.doc, makeCategory(state.doc.eol, name, true));

  const at = state.cat.items.indexOf(state.item);
  if (at >= 0) dropFrom(state.cat.items, at, (tail) => (state.cat.post = state.cat.post + tail));
  insertItem(target, state.item, target.items.length);
  state.cat = target;

  repaintCard();
  markDirty("front", "category");
}

/** A name, asked for in the dialogue every other question here uses. */
function askName(title, current) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ed-picker-mask";
    mask.innerHTML = `
      <section class="ed-prompt" role="dialog" aria-modal="true">
        <header class="ed-picker-bar">
          <span class="ed-picker-name"><i class="fa-solid fa-folder-plus" aria-hidden="true"></i>${escapeHTML(title)}</span>
          <span class="ed-picker-acts">
            <button type="button" data-act="close" title="${escapeHTML(t("close", "Close"))}"><i class="fa-solid fa-xmark"></i></button>
          </span>
        </header>
        <div class="ed-prompt-body">
          <label class="ed-f is-wide">
            <span class="ed-f-label">${escapeHTML(t("ask_name", "Name"))}</span>
            <input class="ed-f-input ed-ask-name" spellcheck="false" value="${escapeHTML(current || "")}">
          </label>
        </div>
        <footer class="ed-picker-foot ed-prompt-foot">
          <button type="button" class="ed-act" data-key="no"><span>${escapeHTML(t("cancel", "Cancel"))}</span></button>
          <button type="button" class="ed-act ed-act-primary" data-key="yes">
            <i class="fa-solid fa-check" aria-hidden="true"></i><span>${escapeHTML(t("apply", "Apply"))}</span>
          </button>
        </footer>
      </section>`;

    const input = mask.querySelector(".ed-ask-name");
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      mask.remove();
      document.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
      if (e.key === "Enter" && mask.contains(document.activeElement)) {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    };

    mask.addEventListener("click", (e) => {
      if (e.target === mask || e.target.closest('[data-act="close"]')) return finish(null);
      const answer = e.target.closest("[data-key]");
      if (!answer) return;
      finish(answer.dataset.key === "yes" ? input.value.trim() || null : null);
    });

    document.addEventListener("keydown", onKeyDown, true);
    document.body.appendChild(mask);
    pop(mask.querySelector(".ed-prompt"));
    input.focus();
    input.select();
  });
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
  state.container.addEventListener("dragover", onDragOver);
  state.container.addEventListener("drop", onDrop);
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
    state.container.removeEventListener("dragover", onDragOver);
    state.container.removeEventListener("drop", onDrop);
    state.container.removeEventListener("dragend", onDragEnd);
  }
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("click", onNavAway, true);
  window.removeEventListener("beforeunload", onLeave);
}

function onCanvasClick(e) {
  const tile = e.target.closest(".ed-tile");
  select(tile ? tile.dataset.id : "");
}

function onCanvasDouble(e) {
  const tile = e.target.closest(".ed-tile");
  if (!tile) return;
  e.preventDefault();
  const node = nodeOf(tile.dataset.id);
  if (node) imageProps(node);
}

/* ─── drag to reorder ──────────────────────────────────────────────────────── */

function onDragStart(e) {
  const tile = e.target.closest(".ed-tile");
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
}

function onDragOver(e) {
  if (!state.dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const tile = e.target.closest(".ed-tile");
  for (const node of state.container.querySelectorAll(".ed-tile")) {
    node.dataset.drop = node === tile && node.dataset.id !== state.dragId ? "1" : "0";
  }
}

async function onDrop(e) {
  if (!state.dragId) return;
  e.preventDefault();
  const tile = e.target.closest(".ed-tile");
  const from = indexOf(state.dragId);
  const to = tile ? indexOf(tile.dataset.id) : images().length - 1;
  onDragEnd();
  if (from < 0 || to < 0 || from === to) return;

  const list = images();
  const tails = list.map((n) => n.tail);
  list.splice(to, 0, list.splice(from, 1)[0]);
  list.forEach((n, i) => (n.tail = tails[i]));

  markDirty("images", state.selected || "");
  await flip(Array.from(state.container.querySelectorAll(".ed-tile")), () => paintCanvas());
  renumber();
}

function onDragEnd() {
  state.dragId = "";
  state.container.classList.remove("is-dragging");
  for (const node of state.container.querySelectorAll(".ed-tile")) {
    node.classList.remove("is-dragging");
    node.dataset.drop = "0";
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
