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

/** The collaborators the site is configured with: id, display name, avatar. */
function roster() {
  const backend = (window.theme && window.theme.backend) || {};
  return Array.isArray(backend.collaborators) ? backend.collaborators : [];
}

/**
 * Resolve a typed value against the configured collaborators ONLY.
 *
 * The editor list is for collaborators and nobody else — a GitHub account that
 * is not on the roster cannot be given write access however the request is
 * made — so this lookup answers from the page's own configuration and needs no
 * request at all. Matches the numeric id, or the display name.
 */
export async function rosterLookup(raw) {
  const value = String(raw || "").replace(/^[@#]/, "").trim().toLowerCase();
  const hit = roster().find(
    (row) => String(row.id) === value || String(row.name || "").toLowerCase() === value
  );
  return { ok: true, matched: hit ? [{ id: Number(hit.id), login: "", name: hit.name || "" }] : [] };
}

// id -> Promise<{login, name}>, for the life of the page. GitHub's public user
// endpoint is rate-limited per address, so each identity is asked for once.
const named = new Map();

/**
 * The GitHub login and display name behind a numeric id.
 *
 * A stored identity is an id and, at best, the login it was typed in as. For
 * anybody first entered by number that login WAS the number, so a reloaded
 * chip had nothing to call them. The roster answers for collaborators; GitHub's
 * public API answers for everybody else, straight from the browser, with no
 * credential and no Worker round trip.
 */
function nameOf(id) {
  const key = String(id);
  if (named.has(key)) return named.get(key);

  const job = (async () => {
    const mate = roster().find((row) => String(row.id) === key);
    let login = "";
    let name = mate ? String(mate.name || "") : "";
    try {
      const res = await fetch(`https://api.github.com/user/${encodeURIComponent(key)}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const user = await res.json();
        login = String(user.login || "");
        name = name || String(user.name || "");
      }
    } catch (e) {
      /* offline or rate-limited: the roster name, or the id, is what shows */
    }
    return { login, name };
  })();

  named.set(key, job);
  return job;
}

const digitsOnly = (value) => /^\d+$/.test(String(value || ""));

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

  /**
   * Put stored identities back. Accepts `{id, login, name}` rows or bare ids —
   * an editor list is stored as ids alone — and fills in whatever is missing
   * afterwards, so the chips appear at once and gain their names as they arrive.
   */
  set(entries) {
    this.chips = (entries || [])
      .map((row) => (row && typeof row === "object" ? row : { id: row }))
      .filter((row) => row.id != null && row.id !== "")
      .map((row) => {
        const login = digitsOnly(row.login) ? "" : String(row.login || "");
        return {
          raw: String(row.id),
          id: Number(row.id),
          login,
          name: String(row.name || ""),
          status: "ok",
        };
      });
    this.paint();
    this.fillNames(this.chips);
  }

  /** Ask for the names a chip does not carry, then repaint once they are in. */
  fillNames(chips) {
    const missing = chips.filter((chip) => chip.status === "ok" && (!chip.login || !chip.name));
    if (!missing.length) return;
    Promise.all(
      missing.map(async (chip) => {
        const found = await nameOf(chip.id);
        if (!chip.login && found.login) chip.login = found.login;
        if (!chip.name && found.name) chip.name = found.name;
      })
    ).then(() => this.paint());
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
      chip.id = Number(match.id);
      chip.login = digitsOnly(match.login) ? "" : String(match.login || "");
      chip.name = String(match.name || "");
      chip.status = "ok";
    } else {
      chip.status = result && result.ok ? "unknown" : "error";
    }
    this.paint();
    this.onCommit(this);
    if (match) this.fillNames([chip]);
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
    // Name first, then the login when it says something the name does not, then
    // the id — the one field every chip is guaranteed to have.
    const label = chip.name || chip.login;
    const handle = chip.login && chip.login !== chip.name ? `@${chip.login}` : "";
    return `<span class="bm-chip is-ok" title="${escapeHTML([label, handle, "#" + chip.id].filter(Boolean).join(" "))}">
      <img class="bm-chip-avatar" src="${avatarOf(chip.id)}" alt="" loading="lazy">
      ${label ? `<span class="bm-chip-name">${escapeHTML(label)}</span>` : ""}
      ${handle && chip.name ? `<span class="bm-chip-id">${escapeHTML(handle)}</span>` : ""}
      <span class="bm-chip-id">#${escapeHTML(chip.id)}</span>
      <button type="button" class="bm-chip-x" data-raw="${escapeHTML(chip.raw)}"
              aria-label="${escapeHTML(remove)}">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
  }
}
