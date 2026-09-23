/**
 * ANSI colour for the sealed build log.
 *
 * The runner captures its build with `FORCE_COLOR=1`, so what gets sealed is a
 * terminal transcript: every line begins with SGR escapes (`ESC [ 3 2 m`), and
 * printed raw they read as `[32m` noise around the words that matter. What the
 * panel wants is the colour, not the spelling — so this turns the escape
 * sequences back into spans and drops every other control sequence on the way.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It is not a terminal. Cursor moves, erase-line, OSC titles and the like are
 * removed rather than interpreted: the log is re-read as flat text, and a line
 * that was written over is kept once (the `\r` handling below) rather than
 * replayed. The basic sixteen colours become CLASSES so the theme decides what
 * they look like in either scheme; the 256-colour cube and truecolour are exact
 * values, so they travel as inline styles.
 */

const ESC = "\u001b";

export function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

/** The xterm 256-colour cube: 16-231, then the greyscale ramp above it. */
function paletteHex(index) {
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const r = Math.floor((index - 16) / 36) % 6;
    const g = Math.floor((index - 16) / 6) % 6;
    const b = (index - 16) % 6;
    const hex = (v) => v.toString(16).padStart(2, "0");
    return `#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`;
  }
  const level = 8 + (index - 232) * 10;
  const hex = level.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

/**
 * One SGR parameter list, applied to `state`.
 *
 * `38`/`48` is a multi-part sequence (`38;5;n` or `38;2;r;g;b`), so this reads
 * ahead and reports how many parameters it consumed.
 *
 * @returns {number} extra parameters consumed beyond the current one
 */
function applySGR(params, state) {
  const code = params[0];
  const consumed = { extra: 0 };

  if (code === 0) {
    state.fg = null;
    state.bg = null;
    state.bold = false;
    state.dim = false;
    state.italic = false;
    state.underline = false;
    state.strike = false;
    state.inverse = false;
  } else if (code === 1) state.bold = true;
  else if (code === 2) state.dim = true;
  else if (code === 3) state.italic = true;
  else if (code === 4) state.underline = true;
  else if (code === 7) state.inverse = true;
  else if (code === 9) state.strike = true;
  else if (code === 22) {
    state.bold = false;
    state.dim = false;
  } else if (code === 23) state.italic = false;
  else if (code === 24) state.underline = false;
  else if (code === 27) state.inverse = false;
  else if (code === 29) state.strike = false;
  else if (code >= 30 && code <= 37) state.fg = { cls: `a-${code - 30}` };
  else if (code === 39) state.fg = null;
  else if (code >= 40 && code <= 47) state.bg = { cls: `a-bg-${code - 40}` };
  else if (code === 49) state.bg = null;
  else if (code >= 90 && code <= 97) state.fg = { cls: `a-${code - 90 + 8}` };
  else if (code >= 100 && code <= 107) state.bg = { cls: `a-bg-${code - 100 + 8}` };
  else if (code === 38 || code === 48) {
    const target = code === 38 ? "fg" : "bg";
    const kind = params[1];
    if (kind === 5 && params.length >= 3) {
      const index = Number(params[2]);
      state[target] =
        Number.isFinite(index) && index >= 16 ? { style: `${target === "fg" ? "color" : "background-color"}:${paletteHex(index)}` } : { cls: `${target === "fg" ? "a-" : "a-bg-"}${index}` };
      consumed.extra = 2;
    } else if (kind === 2 && params.length >= 5) {
      const hex = (v) => Number(v || 0).toString(16).padStart(2, "0");
      const value = `#${hex(params[2])}${hex(params[3])}${hex(params[4])}`;
      state[target] = { style: `${target === "fg" ? "color" : "background-color"}:${value}` };
      consumed.extra = 4;
    }
  }
  // Anything else — blink, font selection, an unknown vendor code — is ignored
  // rather than passed through: the browser has no such state.

  return consumed.extra;
}

function openTag(state) {
  const classes = [];
  const styles = [];
  if (state.fg) (state.fg.cls ? classes : styles).push(state.fg.cls || state.fg.style);
  if (state.bg) (state.bg.cls ? classes : styles).push(state.bg.cls || state.bg.style);
  if (state.bold) classes.push("a-b");
  if (state.dim) classes.push("a-dim");
  if (state.italic) classes.push("a-i");
  if (state.underline) classes.push("a-u");
  if (state.strike) classes.push("a-s");
  if (state.inverse) classes.push("a-inv");
  if (!classes.length && !styles.length) return "";
  const attrs = [];
  if (classes.length) attrs.push(`class="${classes.join(" ")}"`);
  if (styles.length) attrs.push(`style="${styles.join(";")}"`);
  return `<span ${attrs.join(" ")}>`;
}

/**
 * One line of the transcript as HTML, with the colour state carried in from the
 * line before and closed at the end of this one — so a line can be hidden, or
 * lifted out into a block of its own, without taking a dangling span with it.
 */
function renderLine(src, state) {
  const out = [];
  let plain = "";
  let text = "";

  const flush = () => {
    if (!text) return;
    const tag = openTag(state);
    const body = escapeHTML(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    out.push(tag ? `${tag}${body}</span>` : body);
    plain += text;
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    if (src[i] !== ESC) {
      text += src[i];
      i++;
      continue;
    }

    flush();
    const rest = src.slice(i);

    if (rest[1] === "[") {
      const match = /^\u001b\[([0-9;:?]*)([@-~])/.exec(rest);
      if (!match) {
        i += 1;
        continue;
      }
      if (match[2] === "m") {
        const params = match[1]
          .replace(/[:?]/g, ";")
          .split(";")
          .map((v) => Number(v || "0"))
          .filter((v) => Number.isFinite(v));
        for (let p = 0; p < params.length; p++) {
          p += applySGR(params.slice(p), state);
        }
      }
      i += match[0].length;
      continue;
    }

    if (rest[1] === "]") {
      const match = /^\u001b\][^\u0007]*(?:\u0007|\u001b\\)/.exec(rest);
      i += match ? match[0].length : 2;
      continue;
    }

    i += rest[1] ? 2 : 1;
  }

  flush();
  return { html: out.join(""), plain };
}

/**
 * The transcript as lines. `\r` is line-overwrite on a terminal, and a spinner
 * frame is not worth replaying — the last write of a line wins, which is what a
 * reader of the log would have seen had they not looked away.
 */
function ansiLines(text) {
  const state = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
  return String(text == null ? "" : text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => renderLine(line.slice(line.lastIndexOf("\r") + 1), state));
}

/* ─── levels ─────────────────────────────────────────────────────────────────
 *
 * Hexo prints `INFO `, `WARN `, `ERROR`, `FATAL`, `DEBUG` or `TRACE` at the head
 * of every entry (after a timestamp under --debug), and a message that spans
 * lines — a stack, the theme's banner — carries no label on its continuation
 * lines. So a line either OPENS an entry or belongs to the one before it. npm's
 * own warnings and errors, Node's process warnings and a bare thrown error open
 * entries too; anything before the first label is plain output.
 */
const OPENERS = [
  [/^(?:\d\d:\d\d:\d\d\.\d{3} )?(?:TRACE|DEBUG)\b/, "debug"],
  [/^(?:\d\d:\d\d:\d\d\.\d{3} )?INFO\b/, "info"],
  [/^(?:\d\d:\d\d:\d\d\.\d{3} )?WARN\b/, "warn"],
  [/^(?:\d\d:\d\d:\d\d\.\d{3} )?ERROR\b/, "error"],
  [/^(?:\d\d:\d\d:\d\d\.\d{3} )?FATAL\b/, "fatal"],
  [/^npm (?:warn|WARN)\b/, "warn"],
  [/^npm (?:error|ERR!)/, "error"],
  [/^\(node:\d+\) \w*Warning\b/, "warn"],
  [/^(?:[A-Z]\w*)?Error\b.*:/, "error"],
  [/^> /, "other"],
];

function opens(plain) {
  for (const [pattern, level] of OPENERS) if (pattern.test(plain)) return level;
  return "";
}

// The theme's banner (scripts/events/welcome.js): a ruled box around block art.
const RULE = /^\s*\+={20,}\+\s*$/;
const ART = /[█╗╝║═╔╚]/;

function bannerEnd(lines, from) {
  if (!RULE.test(lines[from].plain)) return -1;
  for (let j = from + 1; j < Math.min(lines.length, from + 16); j++) {
    if (!RULE.test(lines[j].plain)) continue;
    return lines.slice(from + 1, j).some((line) => ART.test(line.plain)) ? j : -1;
  }
  return -1;
}

/**
 * A sealed log as entries: `{ level, html }` each, and a count per level.
 *
 * Every entry's lines end in a newline INSIDE the entry, so an entry hidden by
 * the level filter takes its line breaks with it. The banner is lifted out into
 * `.bm-log-logo`, a block the console sizes to fit — which is why no newline is
 * written next to it: a block already breaks the line.
 */
export function parseLog(text) {
  const lines = ansiLines(text);
  const entries = [];
  const counts = {};
  let entry = null;

  const start = (level) => {
    entry = { level, parts: [] };
    entries.push(entry);
    counts[level] = (counts[level] || 0) + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const end = bannerEnd(lines, i);
    if (end > 0) {
      if (!entry) start("info");
      const rows = lines.slice(i, end + 1).map((line) => line.plain.replace(/\s+$/, ""));
      const indent = Math.min(...rows.map((row) => row.match(/^ */)[0].length));
      entry.parts.push(
        `<span class="bm-log-logo"><span class="bm-log-logo-art">${escapeHTML(
          rows.map((row) => row.slice(indent)).join("\n")
        )}</span></span>`
      );
      i = end;
      continue;
    }

    const level = opens(lines[i].plain);
    if (level || !entry) start(level || "other");
    entry.parts.push(lines[i].html + "\n");
  }

  // The file's own trailing newline is not a line anybody wrote.
  const last = entries[entries.length - 1];
  if (last && last.parts[last.parts.length - 1] === "\n") {
    last.parts.pop();
    if (!last.parts.length) {
      entries.pop();
      counts[last.level] -= 1;
    }
  }

  return {
    entries: entries.map((row) => ({ level: row.level, html: row.parts.join("") })),
    counts,
  };
}
