"use strict";

const PRESET_COLORS = new Set([
  "default",
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "amber",
  "orange",
  "red",
  "pink",
  "purple",
  "indigo",
  "gray",
  "slate",
]);

const MATHJAX_PLACEHOLDER_REGEX = /<!--mathjax:\d+:(?:display|inline)-->/g;

function escapeText(content) {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeColor(rawColor) {
  if (!rawColor) return "default";

  const color = String(rawColor).trim().toLowerCase();
  if (PRESET_COLORS.has(color)) return color;

  // Common alias for convenience while still enforcing preset colors.
  if (color === "grey") return "gray";

  return "default";
}

function escapeTextPreservingMathjax(content) {
  MATHJAX_PLACEHOLDER_REGEX.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = MATHJAX_PLACEHOLDER_REGEX.exec(content)) !== null) {
    result += escapeText(content.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  result += escapeText(content.slice(lastIndex));
  return result;
}

function hasDisplayMathPlaceholder(content) {
  return /<!--mathjax:\d+:display-->/.test(content);
}

function postBox(args, content) {
  const color = normalizeColor(args[0]);
  const rawContent = (content || "").trim();
  const escaped = escapeTextPreservingMathjax(rawContent);
  const textOnlyContent = escaped.replace(/\r?\n/g, "<br>");
  const hasDisplayMath = hasDisplayMathPlaceholder(rawContent);
  const tagName = hasDisplayMath ? "div" : "span";
  const boxClass = hasDisplayMath
    ? `post-box post-box-${color} post-box-display`
    : `post-box post-box-${color}`;

  return `<${tagName} class="${boxClass}" data-box-color="${color}">${textOnlyContent}</${tagName}>`;
}

hexo.extend.tag.register("box", postBox, { ends: true });