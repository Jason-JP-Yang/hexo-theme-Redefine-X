"use strict";

/**
 * The `backend:` block, resolved into what is actually switched on.
 *
 * Every consumer — templates, generators, filters and the page config — reads
 * this rather than the raw keys, so a feature is either on everywhere or off
 * everywhere. Three rules live here and nowhere else:
 *
 *   - Nothing exists without a Worker URL, and nothing exists unless comments
 *     run on giscus: every sign-in in the theme is the giscus session.
 *   - Blog Management and the editor need encryption. The console is sealed
 *     under the admin key, and a draft IS an encrypted post.
 *   - An editor provider is on when every one of its fields is filled.
 */

const REPO = /^[^/\s]+\/[^/\s]+$/;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function group(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function providers(editor) {
  const out = [];
  const gitea = group(editor.gitea);
  const github = group(editor.github);

  if (text(gitea.api_url) && REPO.test(text(gitea.repo)) && text(gitea.branch)) {
    out.push({
      id: "gitea",
      api_url: text(gitea.api_url).replace(/\/+$/, ""),
      repo: text(gitea.repo),
      branch: text(gitea.branch),
    });
  }
  if (REPO.test(text(github.repo)) && text(github.branch)) {
    out.push({ id: "github", repo: text(github.repo), branch: text(github.branch) });
  }
  return out;
}

function resolve(theme) {
  const config = theme || {};
  const raw = group(config.backend);
  const comment = group(config.comment);

  const apiUrl = text(raw.api_url).replace(/\/+$/, "");
  const on = comment.enable === true && comment.system === "giscus" && !!apiUrl;

  const encryption = group(raw.encryption);
  const notifications = group(raw.notifications);
  const analytics = group(raw.analytics);
  const host = text(analytics.host).replace(/\/+$/, "");
  const websiteId = text(analytics.website_id);

  const sealed = on && encryption.enable === true;
  const editors = sealed ? providers(group(raw.online_editor)) : [];

  return {
    enable: on,
    api_url: apiUrl,
    mode: text(raw.mode) || "production",
    local_api_url: text(raw.local_api_url),
    management: sealed,
    encryption: {
      enable: sealed,
      prefix: text(encryption.prefix) || "/v",
    },
    notifications: {
      enable: on && notifications.enable === true,
      vapid_public_key: text(notifications.vapid_public_key),
      changelog: notifications.changelog !== false,
      changelog_limit: Number(notifications.changelog_limit) || 30,
      topics: text(notifications.topics) || "posts",
    },
    analytics: {
      enable: on && analytics.enable === true && !!host && !!websiteId,
      host,
      website_id: websiteId,
      performance: analytics.performance !== false,
      recorder: analytics.recorder !== false,
      pulse: analytics.pulse !== false,
      events: analytics.events !== false,
    },
    online_editor: {
      enable: editors.length > 0,
      providers: editors,
    },
  };
}

/** What the page may carry. Repository coordinates are sealed under the admin key instead. */
function forPage(theme) {
  const resolved = resolve(theme);
  return Object.assign({}, resolved, { online_editor: { enable: resolved.online_editor.enable } });
}

module.exports = { resolve, forPage };
