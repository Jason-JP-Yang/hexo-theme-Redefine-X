/**
 * Guide — what this browser has already been told, and the guide's strings.
 *
 * "Understood" is the only state that outlives a visit, and it lives in
 * localStorage alone: it is about one reader on one device, so it never reaches
 * the backend. A tip that was shown and left unanswered is only remembered for
 * this document's lifetime — a Swup navigation keeps it, a reload forgets it, so
 * it returns on the next visit until the reader presses Understand.
 */

const KEY = "redefine-x-guide";

let state = null;
const shown = new Set();

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && raw.v === 1 && raw.done && typeof raw.done === "object") state = raw;
  } catch {}
  if (!state) state = { v: 1, done: {}, tours: {} };
  if (!state.tours) state.tours = {};
  return state;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

// Another tab pressing Understand counts here too.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) state = null;
});

export const isDone = (key) => !!load().done[key];

export function markDone(key) {
  load().done[key] = 1;
  save();
}

export const doneCount = () => Object.keys(load().done).length;

export const tourSeen = (id) => !!load().tours[id];

export function markTour(id) {
  load().tours[id] = 1;
  save();
}

export const wasShown = (id) => shown.has(id);
export const markShown = (id) => shown.add(id);

export function resetAll() {
  state = { v: 1, done: {}, tours: {} };
  shown.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// ─── strings ─────────────────────────────────────────────────
// Fetched the first time something is about to be said, not inlined into every
// page's config: a reader who has understood every tip never downloads them.
let strings = null;
let loading = null;

export function loadStrings() {
  if (strings) return Promise.resolve(strings);
  if (!loading) {
    const root = String((window.config && window.config.root) || "/").replace(/\/?$/, "/");
    loading = fetch(`${root}guide-i18n.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((s) => {
        strings = s && typeof s === "object" ? s : {};
        // A failed fetch is retried on the next attempt rather than cached empty.
        if (!Object.keys(strings).length) {
          loading = null;
          const empty = strings;
          strings = null;
          return empty;
        }
        return strings;
      });
  }
  return loading;
}

export function t(path, fallback = "") {
  let v = strings;
  for (const k of path.split(".")) v = v && typeof v === "object" ? v[k] : undefined;
  return typeof v === "string" ? v : fallback;
}

/** `t()` with `{name}` placeholders filled in. Values are escaped. */
export function tf(path, values) {
  return t(path).replace(/\{(\w+)\}/g, (m, k) => (k in values ? escapeHTML(values[k]) : m));
}

export function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
