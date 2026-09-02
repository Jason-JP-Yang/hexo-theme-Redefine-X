/**
 * The front matter card.
 *
 * ── Every key, or the ones you cannot see are the ones you lose ─────────────
 *
 * `FIELDS` is the complete set of front-matter keys this theme reads, checked
 * against the layouts and the generators rather than against the scaffold. A
 * key that exists in the file but is not modelled here is still shown — as a
 * plain text row under "Other" — so nothing a post carries is ever invisible,
 * and nothing is ever silently dropped.
 *
 * Writing goes through `setFrontMatterKey`, which edits the front matter TEXT
 * in place: unmodelled keys, comments, key order and blank lines survive a save
 * untouched. There is deliberately no raw-YAML editor. Two editors over one
 * string cannot both be authoritative, and the one that lost the race used to
 * take the other's edits with it.
 *
 * ── Toggles ─────────────────────────────────────────────────────────────────
 *
 * Booleans in Hexo front matter are three-valued in practice: `comment: false`
 * disables comments and ABSENT means enabled, while `hidden: true` hides and
 * absent means visible. So each toggle carries its default, and a key absent
 * from the file stays absent while it agrees with that default. A key already
 * written stays written. Saving therefore never adds a line that says nothing.
 *
 * The switch is `.np-switch`, the notification centre's own — same markup,
 * same stylesheet, so there is one switch in this theme rather than two that
 * drift.
 */

import { escapeHTML, parseFrontMatter, setFrontMatterKey } from "./markdown.js";

export const FIELDS = [
  { key: "title", type: "text", group: "head", label: "Title", wide: true },
  { key: "date", type: "datetime", group: "head", label: "Date" },
  { key: "updated", type: "datetime", group: "head", label: "Updated" },

  { key: "cover", type: "asset", group: "look", label: "Cover" },
  { key: "thumbnail", type: "asset", group: "look", label: "Thumbnail" },
  { key: "banner", type: "asset", group: "look", label: "Banner" },
  { key: "excerpt", type: "area", group: "look", label: "Excerpt", wide: true },
  { key: "description", type: "text", group: "look", label: "Description", wide: true },

  { key: "categories", type: "list", group: "tax", label: "Categories" },
  { key: "tags", type: "list", group: "tax", label: "Tags" },
  { key: "sticky", type: "number", group: "tax", label: "Pin weight" },

  { key: "mathjax", type: "toggle", group: "flags", label: "MathJax", on: false },
  { key: "comment", type: "toggle", group: "flags", label: "Comments", on: true },
  { key: "copyright", type: "toggle", group: "flags", label: "Copyright notice", on: true },
  { key: "notify", type: "toggle", group: "flags", label: "Notify followers", on: true },
  { key: "published", type: "toggle", group: "flags", label: "Published", on: true },
  { key: "hidden", type: "toggle", group: "flags", label: "Hide from listings", on: false },

  { key: "vault", type: "toggle", group: "vault", label: "Encrypted", on: false },
  { key: "draft", type: "toggle", group: "vault", label: "Draft", on: false },
  { key: "supersedes", type: "text", group: "vault", label: "Supersedes", wide: true },

  { key: "author", type: "text", group: "more", label: "Author" },
  { key: "avatar", type: "asset", group: "more", label: "Avatar" },
  { key: "license", type: "text", group: "more", label: "License" },
  { key: "expires", type: "datetime", group: "more", label: "Expires" },
  { key: "keywords", type: "list", group: "more", label: "Keywords" },
  { key: "robots", type: "text", group: "more", label: "Robots" },
  { key: "canonical_path", type: "text", group: "more", label: "Canonical path" },
  { key: "og_image", type: "asset", group: "more", label: "OG image" },
  { key: "og_description", type: "text", group: "more", label: "OG description", wide: true },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

// Hexo writes these itself, or the vault generator does. Showing them would
// invite editing a value the next build overwrites.
const DERIVED = new Set([
  "layout", "type", "template", "partial", "vault_kind", "vault_slug",
  "masonry_items", "masonryReactions", "permalink", "_content",
]);

const GROUPS = [
  { id: "head", label: "" },
  { id: "look", label: "Appearance" },
  { id: "tax", label: "Taxonomy" },
  { id: "flags", label: "Behaviour" },
  { id: "vault", label: "Vault" },
];

/* ─── value coercion ───────────────────────────────────────────────────────── */

const TRUE = /^(true|yes|on|1)$/i;

function isOn(value, field) {
  if (value === undefined) return field.on === true;
  const s = String(value).trim();
  if (!s) return field.on === true;
  return TRUE.test(s);
}

/** `2026-07-31 15:30:00` ⇄ the value a datetime-local input wants. */
function toInputDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}`;
}

/** Back to Hexo's shape. Seconds are kept at :00 rather than invented. */
function fromInputDate(value) {
  const m = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:00` : "";
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const s = String(value == null ? "" : value).trim();
  return s ? [s] : [];
}

/* ─── rows ─────────────────────────────────────────────────────────────────── */

function rowText(field, value, label, type) {
  return `<label class="ed-f ${field.wide ? "is-wide" : ""}" data-key="${field.key}">
    <span class="ed-f-label">${label}</span>
    <input class="ed-f-input" type="${type || "text"}" data-key="${field.key}" data-kind="${field.type}"
      value="${escapeHTML(value)}" spellcheck="false">
  </label>`;
}

function rowArea(field, value, label) {
  return `<label class="ed-f is-wide" data-key="${field.key}">
    <span class="ed-f-label">${label}</span>
    <textarea class="ed-f-input" rows="2" data-key="${field.key}" data-kind="area">${escapeHTML(value)}</textarea>
  </label>`;
}

function rowAsset(field, value, label) {
  return `<div class="ed-f ed-f-asset" data-key="${field.key}">
    <span class="ed-f-label">${label}</span>
    <span class="ed-f-assetrow">
      <span class="ed-f-thumb" data-thumb="${field.key}"></span>
      <input class="ed-f-input" data-key="${field.key}" data-kind="asset" value="${escapeHTML(value)}" spellcheck="false">
      <button type="button" class="ed-f-pick" data-pick="${field.key}" title="${escapeHTML(label)}">
        <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
      </button>
    </span>
  </div>`;
}

function rowList(field, value, label) {
  const chips = asList(value)
    .map(
      (item, i) =>
        `<span class="ed-chipv" data-i="${i}">${escapeHTML(item)}<button type="button" class="ed-chipv-x" data-drop="${i}" tabindex="-1"><i class="fa-solid fa-xmark"></i></button></span>`
    )
    .join("");
  return `<div class="ed-f ed-f-list" data-key="${field.key}">
    <span class="ed-f-label">${label}</span>
    <span class="ed-f-chips" data-chips="${field.key}">${chips}<input class="ed-f-chipadd" data-add="${field.key}" spellcheck="false" placeholder="+"></span>
  </div>`;
}

function rowToggle(field, on, label) {
  return `<div class="np-row ed-f-toggle" data-key="${field.key}">
    <span class="np-row-main"><span class="np-row-label">${label}</span></span>
    <button type="button" class="np-switch${on ? " is-on" : ""}" role="switch"
      aria-checked="${on ? "true" : "false"}" data-toggle="${field.key}" aria-label="${label}">
      <span class="np-switch-knob"><i class="fa-solid fa-circle-notch fa-spin"></i></span>
    </button>
  </div>`;
}

function renderRow(field, front, t) {
  const label = escapeHTML(t("f_" + field.key, field.label));
  const value = front[field.key];

  if (field.type === "toggle") return rowToggle(field, isOn(value, field), label);
  if (field.type === "area") return rowArea(field, value || "", label);
  if (field.type === "asset") return rowAsset(field, value || "", label);
  if (field.type === "list") return rowList(field, value, label);
  if (field.type === "datetime") return rowText(field, toInputDate(value), label, "datetime-local");
  if (field.type === "number") return rowText(field, value || "", label, "number");
  return rowText(field, value == null ? "" : value, label);
}

/* ─── the card ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} doc  the open document; `doc.front` is edited in place
 * @param {object} ctx  { t, onChange, pickImage, resolveAsset }
 */
export function createFrontCard(doc, ctx) {
  const el = document.createElement("section");
  el.className = "ed-front";

  const t = ctx.t;
  // Which keys the file already spells out. A toggle that agrees with its
  // default is written only if it was written before.
  const present = new Set(Object.keys(parseFrontMatter(doc.front)));

  function extras(front) {
    return Object.keys(front).filter((key) => !BY_KEY.has(key) && !DERIVED.has(key));
  }

  function paint() {
    const front = parseFrontMatter(doc.front);
    const rest = extras(front);

    const body = GROUPS.map((group) => {
      const rows = FIELDS.filter((f) => f.group === group.id)
        .map((f) => renderRow(f, front, t))
        .join("");
      return `<div class="ed-front-group" data-group="${group.id}">
        ${group.label ? `<h3 class="ed-front-legend">${escapeHTML(t("g_" + group.id, group.label))}</h3>` : ""}
        <div class="ed-front-grid">${rows}</div>
      </div>`;
    }).join("");

    const more =
      FIELDS.filter((f) => f.group === "more").map((f) => renderRow(f, front, t)).join("") +
      rest
        .map(
          (key) =>
            `<label class="ed-f is-wide" data-key="${key}">
              <span class="ed-f-label">${escapeHTML(key)}<i class="fa-solid fa-asterisk ed-f-extra" title="${escapeHTML(t("extra_key", "not a theme key"))}"></i></span>
              <input class="ed-f-input" data-key="${escapeHTML(key)}" data-kind="text"
                value="${escapeHTML(Array.isArray(front[key]) ? front[key].join(", ") : front[key] || "")}" spellcheck="false">
            </label>`
        )
        .join("");

    el.innerHTML = `
      ${body}
      <details class="ed-front-more">
        <summary><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>${escapeHTML(t("g_more", "Metadata & SEO"))}</summary>
        <div class="ed-front-grid">${more}</div>
      </details>`;

    for (const node of el.querySelectorAll("[data-thumb]")) paintThumb(node);
  }

  function paintThumb(node) {
    const key = node.dataset.thumb;
    const input = el.querySelector(`input[data-key="${key}"]`);
    const src = input ? input.value.trim() : "";
    node.innerHTML = src
      ? `<img src="${escapeHTML(ctx.resolveAsset(src))}" alt="">`
      : `<i class="fa-regular fa-image" aria-hidden="true"></i>`;
  }

  /** The single place a value reaches the file. */
  function write(key, value) {
    doc.front = setFrontMatterKey(doc.front, key, value);
    doc.frontDirty = true;
    if (value === null) present.delete(key);
    else present.add(key);
    ctx.onChange(key, value);
  }

  function writeToggle(field, on) {
    const bare = on === (field.on === true);
    if (bare && !present.has(field.key)) return;
    write(field.key, String(on));
  }

  function readList(key) {
    return Array.from(el.querySelectorAll(`[data-chips="${key}"] .ed-chipv`)).map((chip) =>
      chip.firstChild ? chip.firstChild.textContent : ""
    );
  }

  el.addEventListener("input", (e) => {
    const input = e.target.closest("[data-key][data-kind]");
    if (!input) return;
    const key = input.dataset.key;
    const kind = input.dataset.kind;

    if (kind === "datetime") return void write(key, fromInputDate(input.value));
    if (kind === "asset") {
      write(key, input.value.trim());
      const thumb = el.querySelector(`[data-thumb="${key}"]`);
      if (thumb) paintThumb(thumb);
      return;
    }
    write(key, input.value);
  });

  el.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      e.preventDefault();
      const field = BY_KEY.get(toggle.dataset.toggle);
      const on = !toggle.classList.contains("is-on");
      toggle.classList.toggle("is-on", on);
      toggle.setAttribute("aria-checked", on ? "true" : "false");
      return void writeToggle(field, on);
    }

    const drop = e.target.closest("[data-drop]");
    if (drop) {
      e.preventDefault();
      const host = drop.closest("[data-chips]");
      drop.closest(".ed-chipv").remove();
      return void write(host.dataset.chips, readList(host.dataset.chips));
    }

    const pick = e.target.closest("[data-pick]");
    if (!pick) return;
    e.preventDefault();
    const chosen = await ctx.pickImage();
    if (!chosen) return;
    const input = el.querySelector(`input[data-key="${pick.dataset.pick}"]`);
    input.value = chosen.site;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  el.addEventListener("keydown", (e) => {
    const add = e.target.closest("[data-add]");
    if (!add) return;

    const key = add.dataset.add;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const text = add.value.trim();
      if (!text) return;
      const chip = document.createElement("span");
      chip.className = "ed-chipv";
      chip.textContent = text;
      chip.insertAdjacentHTML("beforeend", `<button type="button" class="ed-chipv-x" data-drop="x" tabindex="-1"><i class="fa-solid fa-xmark"></i></button>`);
      add.before(chip);
      add.value = "";
      return void write(key, readList(key));
    }
    if (e.key === "Backspace" && !add.value) {
      const last = add.previousElementSibling;
      if (!last) return;
      e.preventDefault();
      last.remove();
      write(key, readList(key));
    }
  });

  paint();
  return { el, paint };
}
