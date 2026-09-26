/**
 * Guide — which of the four systems a walkthrough is shown for.
 *
 * Following differs by system in the details that matter: iPhone and iPad only
 * deliver push to a site on the Home Screen, a Mac can keep the blog in the Dock,
 * and each system draws its own notifications and permission prompts.
 *
 * iPadOS asks for desktop sites and reports itself as a Mac; its touch screen is
 * what gives it away. Chromium's client hints are read first where they exist.
 * Anything unrecognised (Linux, ChromeOS) is shown the Windows desktop, whose
 * browser behaves the same.
 */

import { isIOS } from "./dom.js";

export const PLATFORMS = ["windows", "macos", "ios", "android"];

export const PLATFORM_ICONS = {
  windows: "fa-brands fa-windows",
  macos: "fa-brands fa-apple",
  ios: "fa-solid fa-mobile-screen-button",
  android: "fa-brands fa-android",
};

export function detectPlatform() {
  const ua = navigator.userAgent || "";
  const hint = (navigator.userAgentData && navigator.userAgentData.platform) || "";
  if (isIOS()) return "ios";
  if (hint === "Android" || /Android/i.test(ua)) return "android";
  if (hint === "macOS" || /Macintosh|Mac OS X/.test(ua)) return "macos";
  return "windows";
}

export const isPhone = (platform) => platform === "ios" || platform === "android";
