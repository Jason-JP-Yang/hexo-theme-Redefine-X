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
 * A sealed log, as HTML: escape sequences applied, everything else escaped.
 *
 * `\r` is line-overwrite on a terminal, and a spinner frame is not worth
 * replaying — the last write of a line wins, which is what a reader of the log
 * would have seen had they not looked away.
 */
export function renderANSI(text) {
  const src = String(text == null ? "" : text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r");
      return at < 0 ? line : line.slice(at + 1);
    })
    .join("\n");

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
  const out = [];
  let plain = "";

  const flush = () => {
    if (!plain) return;
    const tag = openTag(state);
    const body = escapeHTML(plain).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    out.push(tag ? `${tag}${body}</span>` : body);
    plain = "";
  };

  let i = 0;
  while (i < src.length) {
    if (src[i] !== ESC) {
      plain += src[i];
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
      if (match) {
        i += match[0].length;
        continue;
      }
      i += 2;
      continue;
    }

    i += rest[1] ? 2 : 1;
  }

  flush();
  return out.join("");
}
