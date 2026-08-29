/* main hexo */

"use strict";

const url = require("url");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { version } = require("../package.json");

/**
 * Export theme config to js
 */
hexo.extend.helper.register("export_config", function () {
  let hexo_config = {
    hostname: new URL(this.config.url).hostname || this.config.url,
    root: this.config.root,
    language: this.config.language,
  };

  if (this.config.search) {
    hexo_config.path = this.config.search.path;
  }

  let theme_config = {
    articles: this.theme.articles,
    colors: this.theme.colors,
    global: this.theme.global,
    home_banner: this.theme.home_banner,
    plugins: this.theme.plugins,
    version: version,
    code_block: this.theme.code_block,
    navbar: this.theme.navbar,
    page_templates: this.theme.page_templates,
    home: this.theme.home,
    notifications: this.theme.notifications,
    // Carries developer.local_api_url, which tools/auth.js reads to point every
    // Worker call at `wrangler dev` while the site is served from localhost.
    developer: this.theme.developer,

    footerStart: this.theme.footer.start,
  };

  const languageDir = path.join(__dirname, "../languages");
  let file = fs
    .readdirSync(languageDir)
    .find((v) => v === `${this.config.language}.yml`);
  file = languageDir + "/" + (file ? file : "en.yml");
  let languageContent = fs.readFileSync(file, "utf8");
  try {
    languageContent = yaml.load(languageContent);
  } catch (e) {
    console.log(e);
  }

  // The notification panel is rendered entirely on the client, so its strings
  // have to travel with the config rather than through __() in a template.
  if (languageContent && languageContent["notifications"]) {
    theme_config.notifications_i18n = languageContent["notifications"];
  }
  // Same reason, one page further: the management console is rendered entirely
  // on the client from what the Worker returns.
  if (languageContent && languageContent["management"]) {
    theme_config.management_i18n = languageContent["management"];
  }

  let data_config = {
    masonry: false,
  };

  if (this.theme.masonry) {
    data_config.masonry = true;
  }

  return `<script id="hexo-configurations">
    window.config = ${JSON.stringify(hexo_config)};
    window.theme = ${JSON.stringify(theme_config)};
    window.lang_ago = ${JSON.stringify(languageContent["ago"])};
    window.data = ${JSON.stringify(data_config)};
  </script>`;
});
