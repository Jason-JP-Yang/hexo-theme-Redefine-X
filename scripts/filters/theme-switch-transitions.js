'use strict';

/**
 * Every colour transition follows `--tg`.
 *
 * A light/dark switch lands its scheme in one style pass with `--tg: 0s` and
 * `--tgd: 0s` (tools/lightDarkSwitch.js). A colour transition that does not read
 * them starts on that pass for every element it matches — the editor's blocks,
 * gutters and buttons alone were hundreds — and keeps the main thread busy for
 * the whole wave. Rather than ask every rule to remember the variables, the
 * rendered stylesheet is rewritten: each colour entry of a transition takes its
 * duration from `var(--tg, <own>)` and its delay from `var(--tgd, <own>)`, and an
 * `all` entry is followed by colour entries that do. Outside a switch both fall
 * back to the rule's own values, so nothing else changes.
 */

const COLOUR = new Set([
  'color', 'background', 'background-color', 'border', 'border-color',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-block-color', 'border-inline-color', 'outline', 'outline-color',
  'box-shadow', 'text-shadow', 'fill', 'stroke', 'text-decoration', 'text-decoration-color',
  'caret-color', 'column-rule-color', 'accent-color',
  '-webkit-text-fill-color', '-webkit-text-stroke-color',
]);
// What `all` is followed by: the longhands a scheme actually changes.
const FOR_ALL = [
  'color', 'background-color', 'border-color', 'outline-color', 'box-shadow',
  'text-shadow', 'text-decoration-color', 'fill', 'stroke', 'caret-color',
];
const EASING = /^(ease|linear|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(|steps\(|linear\()/;
const TIME = /^(-?[\d.]+m?s|var\()/;
const LONGHAND = {
  'transition-property': 'property',
  'transition-duration': 'duration',
  'transition-timing-function': 'easing',
  'transition-delay': 'delay',
  'transition-behavior': 'behavior',
};

// Split on a separator that is not inside parentheses.
function split(value, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseEntry(entry) {
  const e = { property: 'all', duration: '0s', easing: 'ease', delay: '0s', behavior: 'normal' };
  let times = 0;
  for (const token of split(entry, ' ')) {
    if (TIME.test(token)) {
      if (times++ === 0) e.duration = token;
      else e.delay = token;
    } else if (EASING.test(token)) e.easing = token;
    else if (token === 'allow-discrete' || token === 'normal') e.behavior = token;
    else e.property = token;
  }
  return e;
}

const zero = (t) => /^-?0+(\.0+)?m?s?$/.test(t);
const tg = (t) => (zero(t) || t.includes('--tg') ? t : `var(--tg, ${t})`);
const tgd = (t) => (zero(t) || t.includes('--tgd') ? t : `var(--tgd, ${t})`);

// The block's transition, as the cascade inside it leaves it.
function effective(decls) {
  let lists = null;
  for (const d of decls) {
    if (d.name === 'transition') {
      const entries = split(d.value, ',').map(parseEntry);
      lists = {
        property: entries.map((e) => e.property),
        duration: entries.map((e) => e.duration),
        easing: entries.map((e) => e.easing),
        delay: entries.map((e) => e.delay),
        behavior: entries.map((e) => e.behavior),
      };
    } else {
      lists = lists || { property: ['all'], duration: ['0s'], easing: ['ease'], delay: ['0s'], behavior: ['normal'] };
      lists[LONGHAND[d.name]] = split(d.value, ',');
    }
  }
  const n = lists.property.length;
  const at = (list, i) => list[i % list.length];
  return Array.from({ length: n }, (_, i) => ({
    property: lists.property[i],
    duration: at(lists.duration, i),
    easing: at(lists.easing, i),
    delay: at(lists.delay, i),
    behavior: at(lists.behavior, i),
  }));
}

function rewrite(entries) {
  const out = [];
  let changed = false;
  for (const e of entries) {
    const p = e.property.toLowerCase();
    if (COLOUR.has(p)) {
      const next = { ...e, duration: tg(e.duration), delay: tgd(e.delay) };
      changed = changed || next.duration !== e.duration || next.delay !== e.delay;
      out.push(next);
    } else if (p === 'all' && !zero(e.duration) && !e.duration.includes('--tg')) {
      out.push(e);
      for (const c of FOR_ALL) out.push({ ...e, property: c, duration: tg(e.duration), delay: tgd(e.delay) });
      changed = true;
    } else {
      out.push(e);
    }
  }
  return changed ? out : null;
}

const longhands = (entries) =>
  [
    `transition-property: ${entries.map((e) => e.property).join(', ')}`,
    `transition-duration: ${entries.map((e) => e.duration).join(', ')}`,
    `transition-timing-function: ${entries.map((e) => e.easing).join(', ')}`,
    `transition-delay: ${entries.map((e) => e.delay).join(', ')}`,
    ...(entries.some((e) => e.behavior !== 'normal')
      ? [`transition-behavior: ${entries.map((e) => e.behavior).join(', ')}`]
      : []),
  ].join(';\n  ');

function processBlock(body) {
  if (!body.includes('transition')) return body;
  const parts = body.split(';');
  const decls = [];
  parts.forEach((part, index) => {
    const m = /^\s*(transition(?:-property|-duration|-timing-function|-delay|-behavior)?)\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (m) decls.push({ index, name: m[1], value: m[2] });
  });
  if (!decls.length) return body;
  // Left alone: anything the cascade inside the block cannot be read from.
  if (decls.some((d) => /!important|\binherit\b|\binitial\b|\bunset\b|\brevert\b|\bnone\b/i.test(d.value))) return body;

  const next = rewrite(effective(decls));
  if (!next) return body;

  const first = decls[0].index;
  const drop = new Set(decls.map((d) => d.index));
  return parts
    .map((part, i) => {
      if (i === first) return part.replace(/^(\s*)[\s\S]*$/, `$1${longhands(next)}`);
      return drop.has(i) ? null : part;
    })
    .filter((part) => part !== null)
    .join(';');
}

function routeColourTransitions(css) {
  // Innermost blocks only: rule bodies, never an @media or @supports wrapper.
  return css.replace(/\{([^{}]*)\}/g, (all, body) => `{${processBlock(body)}}`);
}

hexo.extend.filter.register('after_render:css', (css) => routeColourTransitions(css));

module.exports = { routeColourTransitions };
