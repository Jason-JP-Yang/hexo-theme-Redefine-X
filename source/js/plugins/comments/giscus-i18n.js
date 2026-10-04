/**
 * giscus's strings and dates, as its widget renders them: lib/i18n.tsx with
 * next-translate's plural and interpolation rules. The configured language's
 * strings come sealed in the page (scripts/helpers/giscus-helpers.js).
 */

const RTL = new Set(["ar", "fa", "he"]);
const FALLBACKS = { gsw: "de", "zh-Hans": "zh-CN", "zh-Hant": "zh-TW" };

function make(Ctor, lang, options) {
  try {
    return new Ctor(lang, options);
  } catch (e) {
    return new Ctor("en", options);
  }
}

// Chinese dates get a space between their parts, as giscus formats them.
function spaced(format, value, unit) {
  if (!format.resolvedOptions().locale.startsWith("zh")) return unit ? format.format(value, unit) : format.format(value);
  const parts = unit ? format.formatToParts(value, unit) : format.formatToParts(value);
  return parts.map((p) => p.value).join(" ");
}

export function createI18n(lang, strings, h) {
  const rules = make(Intl.PluralRules, lang);

  function pick(key, query) {
    const value = strings[key];
    if (value && typeof value === "object") {
      if (!query || typeof query.count !== "number") return key;
      if (query.count in value) return value[query.count];
      const category = rules.select(query.count);
      return category in value ? value[category] : key;
    }
    return typeof value === "string" ? value : key;
  }

  const t = (key, query) =>
    pick(key, query).replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name) => (query && name in query ? String(query[name]) : all));

  const defaults = {
    code: (text) => h("code", { dir: "ltr" }, text),
    em: (text) => h("em", null, text),
    strong: (text) => h("strong", null, text),
  };

  // "<a>Sign in</a> to add your reaction.", each tag drawn by `components`.
  function trans(key, components, query) {
    const text = t(key, query);
    const out = [];
    const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const draw = components[m[1]] || defaults[m[1]];
      out.push(draw ? draw(m[2]) : m[2]);
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  const full = make(Intl.DateTimeFormat, lang, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZoneName: "short",
  });
  const near = FALLBACKS[lang] ?? lang;
  const dayYear = make(Intl.DateTimeFormat, near, { day: "numeric", month: "short", year: "numeric" });
  const day = make(Intl.DateTimeFormat, near, { day: "numeric", month: "short" });
  const relative = make(Intl.RelativeTimeFormat, near, { localeMatcher: "best fit", numeric: "auto", style: "long" });

  const formatDate = (date) => full.format(new Date(date));

  function formatRelative(date) {
    const then = new Date(date);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (now.getUTCFullYear() - then.getUTCFullYear() > 0) return spaced(dayYear, then);
    if (days >= 30) return spaced(day, then);
    if (days > 0) return spaced(relative, -days, "day");
    if (hours > 0) return spaced(relative, -hours, "hour");
    if (minutes > 0) return spaced(relative, -minutes, "minute");
    return spaced(relative, -seconds, "second");
  }

  return { t, trans, formatDate, formatRelative, dir: RTL.has(lang) ? "rtl" : "ltr" };
}
