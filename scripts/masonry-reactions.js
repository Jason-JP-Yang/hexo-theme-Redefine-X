"use strict";

/**
 * Masonry reactions — the albums' GitHub Discussions, reconciled with masonry.yml.
 *
 * One discussion per public album (`[masonry-reactions] masonry/<title>/`), one
 * comment per photograph; the hearts on those comments are the album's likes.
 * The page reads them through giscus's own app token and each visitor hearts
 * with their own, so neither touches this build's budget. Everything here goes
 * through ONE personal token, and GitHub caps that at 80 content creations a
 * minute and 500 an hour, scores every mutation at 5 points against a secondary
 * limit, and kills any request that runs past 10 seconds. So:
 *
 *   nothing     an album whose desired state matches what source/build/
 *               .reactions.json says was last reconciled costs no request at
 *               all. Each album is re-verified once a week regardless, so a
 *               comment deleted by hand on GitHub heals.
 *   serial      one small request at a time, never aliased: a batch multiplies
 *               the points of one request and is what runs into the timeout.
 *   paced       at least a second between mutations, `retry-after` honoured on a
 *               secondary limit, and a per-run creation budget — what is left
 *               over is picked up by the next build.
 *   kept        a comment records the photograph's path AND its fingerprint (the
 *               source file's content hash from source/build/.images.json, the
 *               same whether the published copy is an AVIF or sealed). Matching
 *               either one — the path also without its extension — updates the
 *               comment in place, so a moved, renamed or replaced photograph keeps
 *               its hearts; a renamed album has its discussion retitled.
 *
 * A comment's body carries a digest of what it should say, so an update is sent
 * only when the content really changed, whatever GitHub did to the markup.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const secrets = require("./lib/secrets");
const { BuildIndex } = require("./lib/build-index");

const API = "https://api.github.com/graphql";
const PREFIX = "[masonry-reactions] ";
const STATE = ".reactions.json";
const GAP_MS = 1000;
const CREATE_BUDGET = 400;
const VERIFY_DAYS = 7;
const PAGE = 50;
const TIMEOUT_MS = 30000;

/** A limit was hit: stop this run, keep what is done, let the next build continue. */
class Halt extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TAG = "[masonry-reactions]";

// What the sync is doing right now, for the build's heartbeat while it waits.
let doing = "";
const progress = () => doing;
const digestOf = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
const stripExt = (p) => String(p || "").replace(/\.[^./]+$/, "");

/* ────────── transport ────────── */

function client(pat, log) {
  let lastMutation = 0;
  let created = 0;
  const stats = { requests: 0, mutations: 0, remaining: "" };

  async function call(query, variables, mutation) {
    for (let attempt = 0; ; attempt++) {
      if (mutation) {
        const wait = lastMutation + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }

      let res;
      let json = null;
      stats.requests += 1;
      if (mutation) stats.mutations += 1;
      try {
        res = await fetch(API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pat}`,
            "Content-Type": "application/json",
            "User-Agent": "hexo-masonry-reactions",
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        json = await res.json().catch(() => null);
      } catch (err) {
        // A mutation that timed out may still have landed; it is never resent,
        // and the next build's read decides what happened.
        if (mutation) {
          log.warn(`${TAG} A write got no answer (${err.message}); not resent - the next build checks whether it landed.`);
          throw err;
        }
        if (attempt >= 2) throw err;
        log.warn(`${TAG} Read failed (${err.message}); retrying in ${2 * (attempt + 1)}s...`);
        await sleep(2000 * (attempt + 1));
        continue;
      } finally {
        if (mutation) lastMutation = Date.now();
      }

      stats.remaining = res.headers.get("x-ratelimit-remaining") || stats.remaining;
      const errors = (json && json.errors) || [];
      const limited =
        res.status === 403 ||
        res.status === 429 ||
        errors.some((e) => e.type === "RATE_LIMITED" || /rate limit|abuse|too quickly/i.test(e.message || ""));
      if (limited) {
        if (res.headers.get("x-ratelimit-remaining") === "0") throw new Halt("primary rate limit exhausted");
        if (attempt >= 2) throw new Halt("secondary rate limit");
        const after = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = after > 0 ? after : 60;
        log.warn(`${TAG} GitHub rate limit (HTTP ${res.status}); waiting ${wait}s before retrying...`);
        doing = `waiting ${wait}s for GitHub's rate limit`;
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok || !json) {
        if (!mutation && res.status >= 500 && attempt < 2) {
          log.warn(`${TAG} GitHub answered HTTP ${res.status}; retrying in ${2 * (attempt + 1)}s...`);
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
      return json.data;
    }
  }

  /** A content creation, counted against this run's budget. */
  async function create(query, variables) {
    if (created >= CREATE_BUDGET) throw new Halt(`creation budget of ${CREATE_BUDGET} reached`);
    created += 1;
    return call(query, variables, true);
  }

  return { query: (q, v) => call(q, v, false), mutate: (q, v) => call(q, v, true), create, stats };
}

/* ────────── reads ────────── */

async function listDiscussions(api, repo, categoryId) {
  const [owner, name] = repo.split("/");
  const out = [];
  let after = null;
  for (;;) {
    const data = await api.query(
      `query($o:String!,$n:String!,$cat:ID!,$c:String){repository(owner:$o,name:$n){
        discussions(first:${PAGE},categoryId:$cat,after:$c){pageInfo{hasNextPage endCursor} nodes{id number title body locked}}}}`,
      { o: owner, n: name, cat: categoryId, c: after }
    );
    const conn = data && data.repository && data.repository.discussions;
    if (!conn) break;
    for (const d of conn.nodes || []) if (String(d.title || "").startsWith(PREFIX)) out.push(d);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function listComments(api, repo, number) {
  const [owner, name] = repo.split("/");
  const out = [];
  let after = null;
  for (;;) {
    const data = await api.query(
      `query($o:String!,$n:String!,$num:Int!,$c:String){repository(owner:$o,name:$n){discussion(number:$num){
        comments(first:${PAGE},after:$c){pageInfo{hasNextPage endCursor} nodes{id body reactions(content:HEART){totalCount}}}}}}`,
      { o: owner, n: name, num: number, c: after }
    );
    const conn = data && data.repository && data.repository.discussion && data.repository.discussion.comments;
    if (!conn) break;
    for (const c of conn.nodes || []) out.push(readComment(c));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/* ────────── markers ────────── */

function readComment(c) {
  const body = String(c.body || "");
  const path = body.match(/`masonry-image:(.+?)`/);
  const fp = body.match(/`masonry-hash:([0-9a-f]+)`/);
  const digest = body.match(/<!-- masonry-digest:([0-9a-f]+) -->/);
  return {
    id: c.id,
    hearts: (c.reactions && c.reactions.totalCount) || 0,
    path: path ? path[1].trim() : "",
    fp: fp ? fp[1] : "",
    digest: digest ? digest[1] : "",
  };
}

function sealBody(text) {
  return `${text}\n\n<!-- masonry-digest:${digestOf(text)} -->`;
}

function bodyDigest(body) {
  const m = String(body || "").match(/<!-- masonry-digest:([0-9a-f]+) -->/);
  return m ? m[1] : "";
}

/* ────────── content ────────── */

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildImageUrl(siteUrl, id, avif) {
  const BITMAP = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const ext = path.extname(id).toLowerCase();
  let p = "masonry/" + id;
  if (id.startsWith("/")) p = id.slice(1);
  if (avif && BITMAP.includes(ext)) {
    const base = path.posix.basename(p, path.posix.extname(p));
    const dir = path.posix.dirname(p);
    p = "build/" + (dir === "." ? "" : dir + "/") + base + ".avif";
  }
  return siteUrl + "/" + encodeURI(p);
}

const EXIF_DEFS = [
  ["make", "Camera"],
  ["model", "Model"],
  ["lensModel", "Lens"],
  ["focalLength", "Focal Length"],
  ["aperture", "Aperture"],
  ["exposureTime", "Shutter"],
  ["ISOSpeedRatings", "ISO"],
  ["exposureProgram", "Exposure Program"],
  ["exposureBias", "Exposure Comp."],
  ["meteringMode", "Metering"],
  ["flash", "Flash"],
  ["whiteBalance", "White Balance"],
  ["focusMode", "Focus Mode"],
  ["dateTimeOriginal", "Date Taken"],
  ["GPSLatitude", "Latitude"],
  ["GPSLongitude", "Longitude"],
  ["GPSAltitude", "Altitude"],
];

function discussionBody(ctx) {
  const url = ctx.siteUrl + "/" + encodeURI(ctx.pagePath);
  return sealBody(
    [
      "# " + ctx.pageTitle,
      "",
      `Hey there! This is the reactions tracker for **[${ctx.pageTitle}](${url})**.`,
      "",
      `This gallery has **${ctx.imageCount}** photos. Each comment below represents one photo.`,
      "",
      "If you see something you like, leave a :heart: **heart reaction** on its comment " +
        `and it'll show up as a like on the [gallery page](${url}). ` +
        "You can also click the heart button directly on the gallery!",
      "",
      "> [!TIP]",
      "> Only :heart: heart reactions are counted as likes. " +
        "Other emoji reactions, upvotes, or discussion votes won't be tracked.",
      "",
      "> [!WARNING]",
      "> Comments left directly in this discussion will be cleaned up periodically. " +
        `Please leave your feedback at the bottom of the [gallery page](${url}) ` +
        "so it will be preserved.",
      "",
      "---",
      "",
      `**${ctx.blogTitle}** by ${ctx.blogAuthor} | [${ctx.siteUrl}](${ctx.siteUrl})`,
      "",
      "*Powered by [hexo-theme-redefine-x](https://github.com/EvanNotFound/hexo-theme-redefine) masonry reactions*",
    ].join("\n")
  );
}

function commentBody(img, fp, ctx) {
  const id = img.image;
  const title = img.title || "";
  const desc = img.description || "";
  const alt = escapeHtml(title || id);
  const pageUrl = ctx.siteUrl + "/" + encodeURI(ctx.pagePath);
  const imgUrl = buildImageUrl(ctx.siteUrl, id, ctx.avifEnabled);
  const exif = EXIF_DEFS.filter(([key]) => img[key] != null && String(img[key]).trim()).map(([key, label]) => ({
    label,
    value: String(img[key]).trim(),
  }));

  const L = [
    `Love this shot? Head over to [${ctx.pageTitle}](${pageUrl}) and drop a heart, or react with :heart: right here!`,
    "",
  ];
  if (title || desc || exif.length) {
    L.push('<table align="center" style="margin: 0 auto; width: auto;">');
    L.push("  <tr>");
    L.push(`    <td align="center" style="padding-right: 12px;"><img src="${imgUrl}" alt="${alt}" width="400" /></td>`);
    L.push('    <td valign="top" style="white-space: nowrap;">');
    if (title) L.push(`      <div><b>Title:</b> ${escapeHtml(title)}</div>`);
    if (desc) L.push(`      <div><b>Description:</b> ${escapeHtml(desc)}</div>`);
    for (const f of exif) L.push(`      <div><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</div>`);
    L.push("    </td>");
    L.push("  </tr>");
    L.push("</table>");
  } else {
    L.push(`<p align="center"><img src="${imgUrl}" alt="${alt}" width="400" /></p>`);
  }
  L.push("");
  // The path first: the page's client reads the first `masonry-image:` span.
  L.push("`masonry-image:" + id + "`" + (fp ? " `masonry-hash:" + fp + "`" : ""));
  return sealBody(L.join("\n"));
}

/* ────────── what should exist ────────── */

/** The source file's content hash, from the image index's fast path where it can. */
function fingerprinter(sourceDir) {
  const index = new BuildIndex(path.join(sourceDir, "build"), ".images.json");
  return (stored) => {
    const value = String(stored || "").split(/[?#]/)[0];
    if (!value || /^(https?:)?\/\//i.test(value)) return "";
    let rel;
    try {
      rel = decodeURIComponent(value);
    } catch {
      rel = value;
    }
    rel = rel.startsWith("/") ? rel.slice(1) : "masonry/" + rel;
    return index.hashOf(rel, path.join(sourceDir, rel)) || "";
  };
}

function collect(masonry, base, fingerprint, log) {
  const albums = new Map();
  const sealed = new Set();
  let photos = 0;
  for (const cat of masonry.filter((c) => c && c.links_category)) {
    for (const item of cat.list || []) {
      if (!item || !item.images || !item.images.length) continue;
      const title = item["page-title"] || item.name;
      const pagePath = `masonry/${title}/`;
      // A draft is not public, and it may share its title with the album it
      // stands in front of — that album's entry carries the page.
      if (item.draft === true) continue;
      if (item.vault === true) {
        sealed.add(pagePath);
        continue;
      }
      if (albums.has(pagePath)) {
        log.warn(`${TAG} Two public albums are published at ${pagePath}; only the first is tracked`);
        continue;
      }

      const ctx = Object.assign({ pageTitle: title, pagePath, imageCount: item.images.length }, base);
      const seen = new Set();
      const images = [];
      for (const img of item.images) {
        if (!img || !img.image || seen.has(img.image)) continue;
        seen.add(img.image);
        photos += 1;
        const fp = fingerprint(img.image);
        const body = commentBody(img, fp, ctx);
        images.push({ path: img.image, fp, body, digest: bodyDigest(body) });
      }
      const body = discussionBody(ctx);
      const digest = digestOf(
        JSON.stringify([bodyDigest(body), images.map((img) => [img.path, img.fp, img.digest])])
      );
      albums.set(pagePath, { pagePath, title: PREFIX + pagePath, body, images, digest });
    }
  }
  return { albums, sealed, photos };
}

/* ────────── the reconcile state ────────── */

function loadState(file, where) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && parsed.version === 1 && parsed.where === where && parsed.albums) return parsed;
  } catch {
    /* absent or unreadable: every album is checked once */
  }
  return { version: 1, where, albums: {} };
}

/** One album per line, sorted, so the commit that carries it reads as a diff. */
function saveState(file, state) {
  const keys = Object.keys(state.albums).sort();
  const rows = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(state.albums[key])}`);
  const text =
    `{\n  "version": 1,\n  "where": ${JSON.stringify(state.where)},\n  "albums": {` +
    (rows.length ? `\n${rows.join(",\n")}\n  ` : "") +
    `}\n}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text, "utf8");
  } catch {
    /* the next build simply checks again */
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function stale(entry) {
  const at = Date.parse(entry.checked || "");
  return !at || Date.now() - at > VERIFY_DAYS * 86400000;
}

/** What a comment or a photograph is matched by. */
const keysOf = (images) => images.map((img) => img.fp || stripExt(img.path));

/* ────────── matching ────────── */

/**
 * Pair photographs with comments. Path and fingerprint both, then fingerprint
 * alone (moved), then path alone — also without the extension — (replaced or
 * re-encoded). Among duplicates the comment with the most hearts wins.
 */
function match(images, comments) {
  const pairs = new Map();
  const taken = new Set();
  const passes = [
    (c, img) => c.path === img.path && !!img.fp && c.fp === img.fp,
    (c, img) => !!img.fp && c.fp === img.fp,
    (c, img) => !!c.path && (c.path === img.path || stripExt(c.path) === stripExt(img.path)),
  ];
  for (const test of passes) {
    for (const img of images) {
      if (pairs.has(img)) continue;
      let best = null;
      for (const c of comments) {
        if (taken.has(c) || !test(c, img)) continue;
        if (!best || c.hearts > best.hearts) best = c;
      }
      if (!best) continue;
      pairs.set(img, best);
      taken.add(best);
    }
  }
  return { pairs, orphans: comments.filter((c) => !taken.has(c)) };
}

/* ────────── one album ────────── */

const Q = {
  createDiscussion: `mutation($i:CreateDiscussionInput!){createDiscussion(input:$i){discussion{id number}}}`,
  updateDiscussion: `mutation($i:UpdateDiscussionInput!){updateDiscussion(input:$i){discussion{id}}}`,
  deleteDiscussion: `mutation($i:DeleteDiscussionInput!){deleteDiscussion(input:$i){clientMutationId}}`,
  unlock: `mutation($i:UnlockLockableInput!){unlockLockable(input:$i){unlockedRecord{locked}}}`,
  addComment: `mutation($i:AddDiscussionCommentInput!){addDiscussionComment(input:$i){comment{id}}}`,
  updateComment: `mutation($i:UpdateDiscussionCommentInput!){updateDiscussionComment(input:$i){comment{id}}}`,
  deleteComment: `mutation($i:DeleteDiscussionCommentInput!){deleteDiscussionComment(input:$i){clientMutationId}}`,
};

/**
 * The discussion an album that has none by its title used to have: one left by
 * a renamed album, recognised by the photographs it tracks. Read from the state
 * file where it can be; a discussion the state does not know costs one read.
 */
async function adopt(api, repo, album, orphans, state, read, log) {
  const mine = new Set(keysOf(album.images));
  let best = null;
  for (const disc of orphans) {
    const known = state.albums[disc.title.slice(PREFIX.length)];
    if (!(known && known.keys) && !read.has(disc.id)) {
      doing = `checking whether ${disc.title.slice(PREFIX.length)} was renamed to ${album.pagePath}`;
      log.info(`${TAG}   reading ${disc.title.slice(PREFIX.length)} (an album no longer published) to see if it was renamed`);
      read.set(disc.id, keysOf(await listComments(api, repo, disc.number)));
    }
    const keys = known && known.keys ? known.keys : read.get(disc.id);
    const overlap = keys.filter((key) => key && mine.has(key)).length;
    if (overlap && (!best || overlap > best.overlap)) best = { disc, overlap };
  }
  if (!best) return null;
  log.info(`${TAG} ${best.disc.title.slice(PREFIX.length)} → ${album.pagePath} (album renamed; hearts kept)`);
  await api.mutate(Q.updateDiscussion, { i: { discussionId: best.disc.id, title: album.title, body: album.body } });
  delete state.albums[best.disc.title.slice(PREFIX.length)];
  best.disc.title = album.title;
  best.disc.body = album.body;
  return best.disc;
}

async function reconcile(api, ids, album, disc, log) {
  let comments = [];
  if (!disc) {
    log.info(`${TAG}   creating the discussion`);
    const data = await api.create(Q.createDiscussion, {
      i: { repositoryId: ids.repoId, categoryId: ids.catId, title: album.title, body: album.body },
    });
    disc = Object.assign({ title: album.title, body: album.body, locked: false }, data.createDiscussion.discussion);
  } else {
    if (disc.locked) {
      log.info(`${TAG}   unlocking the discussion`);
      await api.mutate(Q.unlock, { i: { lockableId: disc.id } });
    }
    if (bodyDigest(disc.body) !== bodyDigest(album.body)) {
      log.info(`${TAG}   updating the discussion text`);
      await api.mutate(Q.updateDiscussion, { i: { discussionId: disc.id, body: album.body } });
    }
    doing = `reading the comments of ${album.pagePath}`;
    comments = await listComments(api, ids.repo, disc.number);
  }

  const { pairs, orphans } = match(album.images, comments);
  const updates = album.images.filter((img) => pairs.has(img) && pairs.get(img).digest !== img.digest);
  const adds = album.images.filter((img) => !pairs.has(img));
  const writes = updates.length + adds.length + orphans.length;
  log.info(
    `${TAG}   ${comments.length} comment(s) on GitHub, ${album.images.length} photo(s): ` +
      `${album.images.length - adds.length - updates.length} up to date, ${updates.length} to update, ` +
      `${adds.length} to add, ${orphans.length} to remove` +
      (writes > 5 ? ` (~${Math.ceil((writes * GAP_MS) / 1000)}s at one write a second)` : "")
  );

  let n = 0;
  const step = (verb, what) => {
    n += 1;
    doing = `${album.pagePath}: ${verb} ${n}/${writes}`;
    log.info(`${TAG}   ${verb} ${n}/${writes}: ${what}`);
  };
  for (const img of updates) {
    step("update", img.path);
    await api.mutate(Q.updateComment, { i: { commentId: pairs.get(img).id, body: img.body } });
  }
  for (const img of adds) {
    step("add", img.path);
    await api.create(Q.addComment, { i: { discussionId: disc.id, body: img.body } });
  }
  // Last: whatever went wrong above, nothing with hearts on it was removed first.
  for (const c of orphans) {
    step("remove", c.path ? `${c.path} (${c.hearts} heart(s))` : "a comment with no photo marker");
    await api.mutate(Q.deleteComment, { i: { id: c.id } });
  }
  return disc;
}

/* ────────── entry point ────────── */

/**
 * Called from scripts/events/build-pipeline.js at `before_generate`, for
 * `hexo generate` only — locally and on the runner alike, wherever
 * GISCUS_AUTHOR_PAT is set. The caller does not wait for it there: it runs
 * beside the render and is awaited at `after_generate`.
 *
 * @param {object} ctx  { theme, config, masonry, sourceDir, log }
 */
async function sync({ theme, config, masonry, sourceDir, log }) {
  const g = theme && theme.comment && theme.comment.config && theme.comment.config.giscus;
  if (!g) return;

  const { repo, repo_id: repoId, category_id: catId } = g;
  const pat = secrets.env("GISCUS_AUTHOR_PAT");
  const proxy = String((theme.backend && theme.backend.api_url) || "").replace(/\/+$/, "");
  if (!pat || !repo || !repoId || !catId || !proxy) {
    log.info(
      pat
        ? "[masonry-reactions] Skipping: incomplete giscus/backend config"
        : "[masonry-reactions] Skipping: GISCUS_AUTHOR_PAT is not set"
    );
    return;
  }
  if (!theme.comment.enable) return void log.info("[masonry-reactions] Skipping: comments disabled");
  if (!masonry) return;

  const siteUrl = (config.url || "").replace(/\/+$/, "");
  const base = {
    siteUrl,
    blogTitle: (theme.info && theme.info.title) || config.title || "Blog",
    blogAuthor: (theme.info && theme.info.author) || config.author || "",
    avifEnabled:
      !theme.plugins ||
      !theme.plugins.minifier ||
      !theme.plugins.minifier.imagesOptimize ||
      theme.plugins.minifier.imagesOptimize.AVIF_COMPRESS !== false,
  };

  const started = Date.now();
  doing = "fingerprinting photos";
  log.info(`${TAG} Fingerprinting photos...`);
  const { albums, sealed, photos } = collect(masonry, base, fingerprinter(sourceDir), log);
  log.info(`${TAG} ${photos} photo(s) in ${albums.size} public album(s) fingerprinted in ${Date.now() - started}ms.`);
  const file = path.join(sourceDir, "build", STATE);
  const state = loadState(file, `${repo}#${catId}`);

  const why = new Map();
  for (const album of albums.values()) {
    const entry = state.albums[album.pagePath];
    if (!entry) why.set(album, "not reconciled yet");
    else if (entry.digest !== album.digest) why.set(album, "changed");
    else if (stale(entry)) why.set(album, `weekly re-check (last ${entry.checked})`);
  }
  const due = Array.from(why.keys());
  const purge = Array.from(sealed).filter((pagePath) => state.albums[pagePath]);
  if (!due.length && !purge.length) {
    doing = "";
    log.info(`${TAG} ${albums.size} album(s) up to date - no requests.`);
    return;
  }
  log.info(
    `${TAG} ${due.length} album(s) to reconcile, ${albums.size - due.length} up to date` +
      (sealed.size ? `, ${sealed.size} encrypted` : "") +
      ". Runs beside the render; the build waits for it at the end."
  );

  const api = client(pat, log);
  const ids = { repo, repoId, catId };
  let done = 0;
  try {
    doing = "listing the discussions";
    log.info(`${TAG} Listing the reactions discussions...`);
    const discs = await listDiscussions(api, repo, catId);
    log.info(`${TAG} ${discs.length} reactions discussion(s) on GitHub.`);
    const byTitle = new Map(discs.map((d) => [d.title, d]));
    // What an orphan discussion tracks, read once per run however many new
    // albums ask.
    const read = new Map();

    // An album that is encrypted now: its public discussion carries the title,
    // every photograph's address and the like counts, so it goes.
    for (const pagePath of sealed) {
      const disc = byTitle.get(PREFIX + pagePath);
      if (!disc) {
        delete state.albums[pagePath];
        continue;
      }
      log.warn(`${TAG} Encrypted album — deleting public discussion: ${pagePath}`);
      await api.mutate(Q.deleteDiscussion, { i: { id: disc.id } });
      byTitle.delete(disc.title);
      delete state.albums[pagePath];
    }

    const orphans = () =>
      Array.from(byTitle.values()).filter((d) => {
        const pagePath = d.title.slice(PREFIX.length);
        return !albums.has(pagePath) && !sealed.has(pagePath);
      });

    for (const [i, album] of due.entries()) {
      log.info(`${TAG} (${i + 1}/${due.length}) ${album.pagePath} - ${why.get(album)}`);
      doing = `album ${i + 1}/${due.length}: ${album.pagePath}`;
      try {
        let disc = byTitle.get(album.title) || null;
        if (!disc) {
          disc = await adopt(api, repo, album, orphans(), state, read, log);
          if (disc) byTitle.set(album.title, disc);
        }
        disc = await reconcile(api, ids, album, disc, log);
        byTitle.set(album.title, disc);
        state.albums[album.pagePath] = {
          digest: album.digest,
          number: disc.number,
          checked: today(),
          keys: keysOf(album.images),
        };
        done += 1;
      } catch (err) {
        if (err instanceof Halt) throw err;
        log.warn(`${TAG} ${album.pagePath}: ${err.message} — retried next build`);
      }
    }
  } catch (err) {
    if (!(err instanceof Halt)) throw err;
    log.warn(`${TAG} Stopped: ${err.message}. The next build continues from here.`);
  } finally {
    saveState(file, state);
    doing = "";
  }
  log.info(
    `${TAG} ${done}/${due.length} album(s) reconciled in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${api.stats.requests} request(s), ${api.stats.mutations} write(s)` +
      (api.stats.remaining ? `, ${api.stats.remaining} points left this hour` : "") +
      ")."
  );
}

module.exports = { sync, progress };
