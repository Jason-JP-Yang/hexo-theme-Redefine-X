if (theme.plugins.mermaid.enable === true) {
  try {
    swup.hooks.on("page:view", () => {
      mermaid.initialize();
    });
  } catch (e) {}

  // Content decrypted into a page that is already open never reaches Swup's
  // `page:view`; plugins/vault.js announces it here instead.
  window.addEventListener("redefine:content-injected", () => mermaid.initialize());
}
