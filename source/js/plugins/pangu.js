function initPanguJS() {
  // Add space between Chinese and English
  pangu.spacingElementByClassName("markdown-body");

  pangu.autoSpacingPage();
}

document.addEventListener("DOMContentLoaded", initPanguJS);

try {
  swup.hooks.on("page:view", initPanguJS);
} catch (e) {}

// Content decrypted into a page that is already open never reaches Swup's
// `page:view`; plugins/vault.js announces it here instead.
window.addEventListener("redefine:content-injected", initPanguJS);
