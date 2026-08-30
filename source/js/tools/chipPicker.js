/**
 * The multi-identity chip field.
 *
 * Each committed token is checked against the Worker the moment it is entered
 * and carries its own state: resolving, resolved (rendered as the GitHub name
 * and numeric id), or unknown. A field holding an unknown chip reports itself as
 * unsettled, which is what lets a caller refuse to save a half-typed audience.
 *
 * Extracted from blog-management so the encrypted-post page can put the SAME
 * control above an article for its admin, rather than growing a second one that
 * drifts. Its two dependencies — the identity lookup and the translator — are
 * injected, because this file must not know which Worker or which page it is on.
 */

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

/** Derived, never stored: a GitHub avatar is addressable by numeric id alone. */
export function avatarOf(id) {
  return `https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}?s=64&v=4`;
}

export class Picker {
  /**
   * @param {object} options
   * @param {(raw:string)=>Promise<{ok:boolean,matched?:Array}>} options.lookup
   * @param {(key:string, fallback:string)=>string} options.t
   */
  constructor(key, host, { onCommit, placeholder, lookup, t }) {
    this.key = key;
    this.host = host;
    this.onCommit = onCommit || (() => {});
    this.lookup = lookup;
    this.t = t || ((k, fallback) => fallback);
    this.chips = [];
    this.busy = 0;

    host.className = "bm-picker";
    host.innerHTML = `<div class="bm-chips"><input class="bm-chip-input" type="text"
      spellcheck="false" autocomplete="off" placeholder="${escapeHTML(placeholder)}"></div>`;
    this.list = host.querySelector(".bm-chips");
    this.input = host.querySelector(".bm-chip-input");

    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "," || event.key === " ") {
        event.preventDefault();
        this.commit();
      } else if (event.key === "Backspace" && !this.input.value && this.chips.length) {
        this.remove(this.chips[this.chips.length - 1].raw);
      }
    });
    this.input.addEventListener("blur", () => this.commit());
    this.input.addEventListener("paste", (event) => {
      const text = (event.clipboardData || window.clipboardData).getData("text");
      if (!/[\s,]/.test(text)) return;
      event.preventDefault();
      text.split(/[\s,]+/).forEach((part) => this.add(part));
    });
    host.addEventListener("click", (event) => {
      const remove = event.target.closest(".bm-chip-x");
      if (remove) {
        this.remove(remove.dataset.raw);
        return;
      }
      if (!event.target.closest(".bm-chip")) this.input.focus();
    });
  }

  /** Resolved ids only — what an audience or a blocklist is actually made of. */
  get ids() {
    return this.chips.filter((c) => c.status === "ok").map((c) => c.id);
  }

  /** Resolved chips with their names, for a store that renders them back later. */
  get entries() {
    return this.chips
      .filter((c) => c.status === "ok")
      .map((c) => ({ id: c.id, login: c.login, name: c.name }));
  }

  get settled() {
    return this.busy === 0 && this.chips.every((c) => c.status === "ok");
  }

  set(entries) {
    this.chips = (entries || []).map((row) => ({
      raw: String(row.login || row.id),
      id: row.id,
      login: row.login || "",
      name: row.name || "",
      status: "ok",
    }));
    this.paint();
  }

  clear() {
    this.chips = [];
    this.paint();
  }

  commit() {
    const value = this.input.value.trim();
    this.input.value = "";
    if (value) this.add(value);
  }

  add(raw) {
    const value = String(raw).replace(/^@/, "").trim();
    if (!value) return;
    if (this.chips.some((c) => c.raw.toLowerCase() === value.toLowerCase())) return;

    this.chips.push({ raw: value, id: null, login: "", name: "", status: "checking" });
    this.paint();
    this.resolve(value);
  }

  remove(raw) {
    const before = this.chips.length;
    this.chips = this.chips.filter((c) => c.raw !== raw);
    if (this.chips.length === before) return;
    this.paint();
    this.onCommit(this);
  }

  async resolve(raw) {
    this.busy++;
    const result = await this.lookup(raw);
    this.busy--;

    const chip = this.chips.find((c) => c.raw === raw);
    if (!chip) return;

    const match = result && result.ok && (result.matched || [])[0];
    if (match) {
      chip.id = match.id;
      chip.login = match.login;
      chip.name = match.name || "";
      chip.status = "ok";
    } else {
      chip.status = result && result.ok ? "unknown" : "error";
    }
    this.paint();
    this.onCommit(this);
  }

  paint() {
    this.list.querySelectorAll(".bm-chip").forEach((el) => el.remove());
    const html = this.chips.map((chip) => this.chipHTML(chip)).join("");
    this.input.insertAdjacentHTML("beforebegin", html);
    this.host.classList.toggle("has-unknown", this.chips.some((c) => c.status !== "ok"));
  }

  chipHTML(chip) {
    const remove = this.t("remove", "Remove");
    if (chip.status === "checking") {
      return `<span class="bm-chip is-checking">
        <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
        <span class="bm-chip-name">${escapeHTML(chip.raw)}</span></span>`;
    }
    if (chip.status !== "ok") {
      const why =
        chip.status === "error"
          ? this.t("chip_error", "Lookup failed")
          : this.t("chip_unknown", "Not a known reader");
      return `<span class="bm-chip is-unknown" title="${escapeHTML(why)}">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span class="bm-chip-name">${escapeHTML(chip.raw)}</span>
        <button type="button" class="bm-chip-x" data-raw="${escapeHTML(chip.raw)}"
                aria-label="${escapeHTML(remove)}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
    }
    return `<span class="bm-chip is-ok">
      <img class="bm-chip-avatar" src="${avatarOf(chip.id)}" alt="" loading="lazy">
      <span class="bm-chip-name">${escapeHTML(chip.name || chip.login)}</span>
      <span class="bm-chip-id">#${escapeHTML(chip.id)}</span>
      <button type="button" class="bm-chip-x" data-raw="${escapeHTML(chip.raw)}"
              aria-label="${escapeHTML(remove)}">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
  }
}
