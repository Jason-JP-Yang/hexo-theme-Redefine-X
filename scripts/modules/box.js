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

function postBox(args, content) {
  const color = normalizeColor(args[0]);
  const escaped = escapeText((content || "").trim());
  const textOnlyContent = escaped.replace(/\r?\n/g, "<br>");

  return `<span class="post-box post-box-${color}" data-box-color="${color}">${textOnlyContent}</span>`;
}

hexo.extend.tag.register("box", postBox, { ends: true });