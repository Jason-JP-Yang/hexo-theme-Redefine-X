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
 *   - A collaborator is on when every one of THEIR fields is filled.
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

/**
 * The collaborator roster, and the rule that an incomplete entry is not one.
 *
 * All five fields or nothing: the id is what a post's `contributor:` names, the
 * name and avatar are what the page prints, and the username and email are what
 * a commit is signed with. A half-filled entry would render a nameless face on
 * an article or sign a commit with an empty address, so it is dropped here
 * rather than guessed at anywhere downstream.
 *
 * Access is decided by the Worker's COLLABORATORS, never by this list. The two
 * carry the same ids on purpose: this file cannot authorize anything, and the
 * Worker has no business holding a display name.
 */
function collaborators(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = text(row.id);
    const username = text(row.username);
    const email = text(row.email);
    const name = text(row.name);
    const avatar = text(row.avatar);
    if (!id || !username || !email || !name || !avatar) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, username, email, name, avatar });
  }

  // Sorted by id, so the order a page renders them in cannot depend on how the
  // config happened to be typed — the same reason taxonomy is sorted.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
    collaborators: collaborators(raw.collaborators),
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

/**
 * What the page may carry. Repository coordinates are sealed under the admin key
 * instead — and so is the half of a collaborator's entry that is not already on
 * screen. The name and avatar are printed in the markup of every post they
 * contributed to; their login and email are the identity a commit is signed
 * with, and they travel with the editor's own sealed blob (`o.bin`) rather than
 * with every page the site serves.
 */
function forPage(theme) {
  const resolved = resolve(theme);
  return Object.assign({}, resolved, {
    online_editor: { enable: resolved.online_editor.enable },
    collaborators: resolved.collaborators.map((row) => ({
      id: row.id,
      name: row.name,
      avatar: row.avatar,
    })),
  });
}

module.exports = { resolve, forPage };
