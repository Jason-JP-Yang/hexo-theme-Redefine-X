/**
 * The album card — the front-matter card, over an album instead of a post.
 *
 * Same object as `frontmatter.js` in every way that shows: the same `.ed-f`
 * rows, the same `.np-switch`, the same asset picker, the same "Other" group
 * for keys this card does not model. The five row templates are IMPORTED from
 * that file rather than copied, so the two cards cannot drift apart.
 *
 * ── Two documents, one card ─────────────────────────────────────────────────
 *
 * An album is an entry in `list:` under a category, and the category carries
 * settings of its own. Both are edited here, because from the author's side
 * they are one thing: "this album, and where it lives".
 *
 * Which category that is, is ONE field. A select for "belongs to" beside a text
 * box for "the category's name" was two controls that looked like they
 * disagreed, and neither said what the other would do. It is the picture
 * browser's search box instead — type, see what matches, pick one — and a name
 * nothing matches is a NEW category, said out loud on the row before it is
 * committed.
 *
 * Writing goes through `setItemField` / `setCategoryField`, which edit the YAML
 * TEXT a line at a time — so an unmodelled key, a comment or an odd bit of
 * spacing survives a save exactly as `setFrontMatterKey` keeps them for a post.
 */

import { escapeHTML } from "./markdown.js";
import { rowArea, rowAsset, rowText, rowToggle } from "./frontmatter.js";
import {
  albumTitle,
  categories,
  categoryFields,
  isTrue,
  itemFields,
  setCategoryField,
  setItemField,
} from "./masonry-yaml.js";

// What the album entry can usefully be told. Mirrors the template at the top of
// source/_data/masonry.yml, which is the documentation these keys already have.
export const ALBUM_FIELDS = [
  { key: "name", type: "text", group: "album", label: "Name", wide: true },
  { key: "page-title", type: "text", group: "album", label: "Page title" },
  { key: "link", type: "text", group: "album", label: "Link" },
  { key: "description", type: "area", group: "album", label: "Description", wide: true },

  { key: "avatar", type: "asset", group: "look", label: "Avatar" },
  { key: "thumbnail", type: "asset", group: "look", label: "Thumbnail" },

  { key: "auto-exif", type: "toggle", group: "flags", label: "Read EXIF at build time", on: false },
  { key: "vault", type: "toggle", group: "flags", label: "Encrypted", on: false },
];

const BY_KEY = new Map(ALBUM_FIELDS.map((f) => [f.key, f]));

// Written by a button, not typed: `draft` and `supersedes` are what Save draft
// and Publish mean, and `images` is the canvas. `contributor` is a record of who
// saved the album, written by the save — a field would let anyone with the
// editor open put a name on work that is not theirs, or take one off.
const HIDDEN = new Set(["images", "draft", "supersedes", "contributor"]);

const CATEGORY_FIELDS = [
  { key: "has_thumbnail", type: "toggle", group: "cat", label: "Cards show a thumbnail", on: false },
];

const GROUPS = [
  { id: "album", label: "" },
  { id: "look", label: "Appearance" },
  { id: "cat", label: "Category" },
  { id: "flags", label: "Behaviour" },
];

const MENU_MAX = 8;

function isOn(value, field) {
  if (value === undefined) return field.on === true;
  const s = String(value).trim();
  if (!s) return field.on === true;
  return isTrue(s);
}

/**
 * The one row shape this card adds: the picture browser's search field, over
 * category names. Same markup and the same classes, so the only two search
 * boxes in this editor behave alike.
 */
function rowCombo(value, label, t) {
  // A div, not a label: a label holding buttons hands every press on the menu
  // back to the input as a focus, which is the one thing a menu must not do.
  return `<div class="ed-f is-wide ed-f-combo" data-key="links_category">
    <span class="ed-f-label">${label}</span>
    <span class="ed-pick-field">
      <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
      <input class="ed-pick-input" data-combo spellcheck="false" autocomplete="off"
        value="${escapeHTML(value)}" placeholder="${escapeHTML(t("cat_find", "Search, or type a new name"))}">
      <span class="ed-f-tag" data-combo-tag></span>
      <span class="ed-pick-menu" data-combo-menu hidden></span>
    </span>
  </div>`;
}

/**
 * @param {object} model  { doc, item, cat } — the nodes this card edits in place
 * @param {object} ctx    { t, onChange, onCategory, pickImage, bindImage }
 */
export function createAlbumCard(model, ctx) {
  const el = document.createElement("section");
  el.className = "ed-front ed-album";

  const t = ctx.t;
  // Which keys each document already spells out, so a toggle that agrees with
  // its default stays absent unless it was written before.
  let present = new Set();
  let catPresent = new Set();
  let known = [];

  function resync() {
    present = new Set(Object.keys(itemFields(model.item)));
    catPresent = new Set(Object.keys(categoryFields(model.cat)));
  }

  function renderRow(field, values) {
    const label = escapeHTML(t("f_" + field.key.replace(/-/g, "_"), field.label));
    const value = values[field.key];
    if (field.type === "toggle") return rowToggle(field, isOn(value, field), label);
    if (field.type === "area") return rowArea(field, value || "", label);
    if (field.type === "asset") return rowAsset(field, value || "", label);
    return rowText(field, value == null ? "" : value, label);
  }

  function paint() {
    const fields = itemFields(model.item);
    const cat = categoryFields(model.cat);
    const here = String(cat.links_category || "");

    known = categories(model.doc)
      .map((node) => String(categoryFields(node).links_category || ""))
      .filter(Boolean);
    if (!known.includes(here) && here) known.unshift(here);

    const body = GROUPS.map((group) => {
      let rows = "";
      if (group.id === "cat") {
        rows += rowCombo(here, escapeHTML(t("f_category", "Category")), t);
        rows += CATEGORY_FIELDS.map((f) => renderRow(f, cat)).join("");
      } else {
        rows = ALBUM_FIELDS.filter((f) => f.group === group.id)
          .map((f) => renderRow(f, fields))
          .join("");
      }
      return `<div class="ed-front-group" data-group="${group.id}">
        ${group.label ? `<h3 class="ed-front-legend">${escapeHTML(t("g_" + group.id, group.label))}</h3>` : ""}
        <div class="ed-front-grid">${rows}</div>
      </div>`;
    }).join("");

    const rest = Object.keys(fields).filter((key) => !BY_KEY.has(key) && !HIDDEN.has(key));
    const other = rest
      .map(
        (key) =>
          `<label class="ed-f is-wide" data-key="${escapeHTML(key)}">
            <span class="ed-f-label">${escapeHTML(key)}<i class="fa-solid fa-asterisk ed-f-extra" title="${escapeHTML(
              t("extra_key", "not a theme key")
            )}"></i></span>
            <input class="ed-f-input" data-key="${escapeHTML(key)}" data-kind="text"
              value="${escapeHTML(fields[key] || "")}" spellcheck="false">
          </label>`
      )
      .join("");

    el.innerHTML =
      body +
      (other
        ? `<div class="ed-front-group">
             <h3 class="ed-front-legend">${escapeHTML(t("g_other", "Other"))}</h3>
             <div class="ed-front-grid">${other}</div>
           </div>`
        : "");

    for (const node of el.querySelectorAll("[data-thumb]")) paintThumb(node);
    paintTag();
    resync();
  }

  function paintThumb(node) {
    const key = node.dataset.thumb;
    const input = el.querySelector(`input[data-key="${CSS.escape(key)}"]`);
    const src = input ? input.value.trim() : "";
    if (!src) {
      node.innerHTML = `<i class="fa-regular fa-image" aria-hidden="true"></i>`;
      return;
    }
    node.innerHTML = `<img alt="">`;
    ctx.bindImage(node.querySelector("img"), src);
  }

  /* ─── the category box ───────────────────────────────────────────────── */

  const comboInput = () => el.querySelector("[data-combo]");
  const comboMenu = () => el.querySelector("[data-combo-menu]");

  function matches(query) {
    const q = query.trim().toLowerCase();
    const rows = q ? known.filter((name) => name.toLowerCase().includes(q)) : known.slice();
    return rows.slice(0, MENU_MAX);
  }

  /** Whether what is typed names a category that exists — the row says which. */
  function paintTag() {
    const input = comboInput();
    const tag = el.querySelector("[data-combo-tag]");
    if (!input || !tag) return;
    const value = input.value.trim();
    const held = known.some((name) => name === value);
    tag.textContent = !value ? "" : held ? t("cat_here", "Existing") : t("cat_make", "New");
    tag.dataset.kind = !value ? "" : held ? "held" : "new";
  }

  function paintMenu() {
    const menu = comboMenu();
    const input = comboInput();
    if (!menu || !input) return;
    const rows = matches(input.value);
    menu.innerHTML = rows.length
      ? rows
          .map(
            (name) =>
              `<button type="button" class="ed-pick-hit" data-cat="${escapeHTML(name)}">
                 <i class="fa-solid fa-folder" aria-hidden="true"></i>
                 <span class="ed-pick-hit-name">${escapeHTML(name)}</span>
               </button>`
          )
          .join("")
      : `<span class="ed-pick-blank">${escapeHTML(t("cat_none", "No category matches, so this makes a new one"))}</span>`;
    menu.hidden = false;
  }

  function closeMenu() {
    const menu = comboMenu();
    if (menu) menu.hidden = true;
  }

  /** Commit what is in the box: an existing category, or a new one by that name. */
  function commitCategory(value) {
    closeMenu();
    const wanted = String(value == null ? (comboInput() || {}).value : value).trim();
    const here = String(categoryFields(model.cat).links_category || "");
    const input = comboInput();
    if (!wanted) {
      if (input) input.value = here;
      return void paintTag();
    }
    if (input) input.value = wanted;
    paintTag();
    if (wanted !== here) ctx.onCategory(wanted);
  }

  /* ─── the single place a value reaches the file ──────────────────────── */

  function write(key, value) {
    const was = albumTitle(itemFields(model.item));
    setItemField(model.item, key, value === "" ? null : value);
    if (value === null || value === "") present.delete(key);
    else present.add(key);

    // `link` is what the collection card points at, and the generator derives it
    // from the page title anyway — so a link that still named the old title is
    // dead data the moment the album is renamed. Rewritten only while it agrees
    // with the derivation, which is what makes a hand-written one stay.
    if (key === "name" || key === "page-title") {
      const now = albumTitle(itemFields(model.item));
      const link = String(itemFields(model.item).link || "");
      if (now && (!link || link === derivedLink(was))) {
        setItemField(model.item, "link", derivedLink(now));
        set("link", derivedLink(now));
      }
    }
    ctx.onChange("album", key, value);
  }

  function derivedLink(title) {
    return title ? `/masonry/${title}` : "";
  }

  function writeToggle(field, on, scope) {
    const bare = on === (field.on === true);
    const held = scope === "cat" ? catPresent : present;
    if (bare && !held.has(field.key)) return;
    if (scope === "cat") {
      setCategoryField(model.cat, field.key, String(on));
      catPresent.add(field.key);
      ctx.onChange("category", field.key, String(on));
    } else {
      write(field.key, String(on));
    }
  }

  el.addEventListener("input", (e) => {
    if (e.target.closest("[data-combo]")) {
      paintMenu();
      return void paintTag();
    }
    const input = e.target.closest("[data-key][data-kind]");
    if (!input) return;
    const key = input.dataset.key;

    if (input.dataset.kind === "asset") {
      write(key, input.value.trim());
      const thumb = el.querySelector(`[data-thumb="${CSS.escape(key)}"]`);
      if (thumb) paintThumb(thumb);
      return;
    }
    write(key, input.value);
  });

  el.addEventListener("focusin", (e) => {
    if (e.target.closest("[data-combo]")) paintMenu();
  });

  el.addEventListener("keydown", (e) => {
    if (!e.target.closest("[data-combo]")) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitCategory();
      e.target.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.value = String(categoryFields(model.cat).links_category || "");
      closeMenu();
      paintTag();
    }
  });

  // A pointer leaving the box commits it; the menu's own buttons are pressed on
  // `mousedown`, so a click on one is not a blur that throws the choice away.
  el.addEventListener(
    "blur",
    (e) => {
      if (e.target.closest("[data-combo]")) setTimeout(() => commitCategory(), 0);
    },
    true
  );

  el.addEventListener("mousedown", (e) => {
    const hit = e.target.closest("[data-cat]");
    if (!hit) return;
    e.preventDefault();
    commitCategory(hit.dataset.cat);
  });

  el.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      e.preventDefault();
      const key = toggle.dataset.toggle;
      const field = BY_KEY.get(key) || CATEGORY_FIELDS.find((f) => f.key === key);
      if (!field) return;
      const on = !toggle.classList.contains("is-on");
      toggle.classList.toggle("is-on", on);
      toggle.setAttribute("aria-checked", on ? "true" : "false");
      return void writeToggle(field, on, key === "has_thumbnail" ? "cat" : "album");
    }

    const pick = e.target.closest("[data-pick]");
    if (!pick) return;
    e.preventDefault();
    const chosen = await ctx.pickImage();
    if (!chosen) return;
    const input = el.querySelector(`input[data-key="${CSS.escape(pick.dataset.pick)}"]`);
    input.value = chosen.site;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  /** One field, written from outside — the album's name is shown twice. */
  function set(key, value) {
    const input = el.querySelector(`input[data-key="${CSS.escape(key)}"], textarea[data-key="${CSS.escape(key)}"]`);
    if (input && input !== document.activeElement) input.value = value == null ? "" : value;
  }

  paint();
  return { el, paint, set, resync };
}
