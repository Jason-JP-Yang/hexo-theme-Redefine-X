"use strict";

/**
 * Masonry Reactions — Build-time script
 *
 * Creates one GitHub Discussion per masonry gallery page, with one comment per
 * image, to track heart reactions via giscus. All reaction data is fetched
 * live by the frontend client; this script only manages the structure.
 *
 * Idempotency: second run with unchanged data → zero API mutations.
 * Content matching: substring-based checks, immune to GitHub HTML reformatting.
 */

const https = require("https");
const path = require("path");

const PREFIX = "[masonry-reactions] ";
let rlRemaining = null;
let stopped = false;

/* ────────── GraphQL transport ────────── */

async function gql(pat, query, vars = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      'User-Agent': 'hexo-masonry-reactions',
    },
    body: JSON.stringify({ query, variables: vars }),
  });

  const json = await response.json();
  const rem = response.headers.get('x-ratelimit-remaining');
  if (rem !== null) rlRemaining = parseInt(rem, 10);

  return { json, headers: Object.fromEntries(response.headers) };
}

/**
 * Execute a mutation with 0.8 s throttle, rate-limit guard, and up to 3 retries.
 */
async function mutate(pat, query, vars, log, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (stopped) throw new Error("Stopped");
    if (rlRemaining !== null && rlRemaining <= 0) {
      stopped = true;
      log.error("[masonry-reactions] Rate limit exhausted.");
      throw new Error("Rate limit exhausted");
    }

    await new Promise((r) => setTimeout(r, 800));

    let res;
    try {
      res = await gql(pat, query, vars);
    } catch (err) {
      if (attempt < 2) {
        log.warn(`[masonry-reactions] Retry ${label}: ${err.message}`);
        continue;
      }
      throw err;
    }

    if (rlRemaining !== null && rlRemaining <= 0) {
      stopped = true;
      throw new Error("Rate limit exhausted");
    }

    if (res.json.errors) {
      const secondary = res.json.errors.some((e) =>
        /too quickly|abuse|secondary rate/i.test(e.message || "")
      );
      if (secondary && attempt < 2) {
        const wait =
          parseInt(res.headers["retry-after"] || "0", 10) || (attempt + 1) * 5;
        log.warn(
          `[masonry-reactions] Secondary rate limit (${label}), wait ${wait}s`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(`${label}: ${JSON.stringify(res.json.errors)}`);
    }

    return res.json;
  }
}

/* ────────── API wrappers ────────── */

/**
 * Fetch ALL discussions in a category via repository.discussions(categoryId:).
 * Returns { pagePath → discussion }.
 */
async function fetchDiscussions(pat, repo, categoryId) {
  const [owner, name] = repo.split("/");
  const map = {};
  let cursor = null;

  while (true) {
    const { json } = await gql(
      pat,
      `query($o:String!,$n:String!,$cat:ID!,$c:String) {
        repository(owner:$o, name:$n) {
          discussions(first:100, categoryId:$cat, after:$c) {
            pageInfo { hasNextPage endCursor }
            nodes { id number title body locked }
          }
        }
      }`,
      { o: owner, n: name, cat: categoryId, c: cursor }
    );
    const conn = json?.data?.repository?.discussions;
    if (!conn?.nodes) break;
    for (const d of conn.nodes) {
      if (d.title?.startsWith(PREFIX)) map[d.title.slice(PREFIX.length)] = d;
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return map;
}

/**
 * Fetch ALL comments of one discussion (paginated). Returns [{ id, body }].
 */
async function fetchComments(pat, repo, number) {
  const [owner, name] = repo.split("/");
  const all = [];
  let cursor = null;

  while (true) {
    const { json } = await gql(
      pat,
      `query($o:String!,$n:String!,$num:Int!,$c:String) {
        repository(owner:$o, name:$n) {
          discussion(number:$num) {
            comments(first:100, after:$c) {
              pageInfo { hasNextPage endCursor }
              nodes { id body }
            }
          }
        }
      }`,
      { o: owner, n: name, num: number, c: cursor }
    );
    const c = json?.data?.repository?.discussion?.comments;
    if (!c?.nodes) break;
    all.push(...c.nodes);
    if (!c.pageInfo?.hasNextPage) break;
    cursor = c.pageInfo.endCursor;
  }

  return all;
}

async function apiCreateDiscussion(pat, repoId, catId, title, body, log) {
  const r = await mutate(
    pat,
    `mutation($i:CreateDiscussionInput!) {
      createDiscussion(input:$i) { discussion { id number } }
    }`,
    { i: { repositoryId: repoId, categoryId: catId, title, body } },
    log,
    "create discussion"
  );
  return r?.data?.createDiscussion?.discussion;
}

async function apiAddComment(pat, discussionId, body, log) {
  return mutate(
    pat,
    `mutation($i:AddDiscussionCommentInput!) {
      addDiscussionComment(input:$i) { comment { id } }
    }`,
    { i: { discussionId, body } },
    log,
    "add comment"
  );
}

async function apiUpdateComment(pat, commentId, body, log) {
  return mutate(
    pat,
    `mutation($id:ID!,$b:String!) {
      updateDiscussionComment(input:{commentId:$id, body:$b}) { comment { id } }
    }`,
    { id: commentId, b: body },
    log,
    "update comment"
  );
}

async function apiUpdateDiscussion(pat, id, body, log) {
  return mutate(
    pat,
    `mutation($i:UpdateDiscussionInput!) {
      updateDiscussion(input:$i) { discussion { id } }
    }`,
    { i: { discussionId: id, body } },
    log,
    "update discussion"
  );
}

async function apiUnlock(pat, id, log) {
  return mutate(
    pat,
    `mutation($i:UnlockLockableInput!) {
      unlockLockable(input:$i) { unlockedRecord { locked } }
    }`,
    { i: { lockableId: id } },
    log,
    "unlock"
  );
}

async function apiDeleteComment(pat, id, log) {
  return mutate(
    pat,
    `mutation($i:DeleteDiscussionCommentInput!) {
      deleteDiscussionComment(input:$i) { clientMutationId }
    }`,
    { i: { id } },
    log,
    "delete comment"
  );
}

/* ────────── Content helpers ────────── */

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildImageUrl(siteUrl, id, avif) {
  const BITMAP = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const ext = path.extname(id).toLowerCase();
  let p = "masonry/" + id;
  if (avif && BITMAP.includes(ext)) {
    const base = path.posix.basename(id, ext);
    const dir = path.posix.dirname(id);
    p =
      "build/" +
      (dir === "." ? "masonry" : "masonry/" + dir) +
      "/" +
      base +
      ".avif";
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

function getExifFields(img) {
  const out = [];
  for (const [key, label] of EXIF_DEFS) {
    const v = img[key];
    if (v != null && String(v).trim())
      out.push({ label, value: String(v).trim() });
  }
  return out;
}

function buildDiscussionBody(ctx) {
  const url = ctx.siteUrl + "/" + encodeURI(ctx.pagePath);
  return [
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
  ].join("\n");
}

function buildCommentBody(img, ctx) {
  const id = img.image;
  const title = img.title || "";
  const desc = img.description || "";
  const alt = escapeHtml(title || id);
  const pageUrl = ctx.siteUrl + "/" + encodeURI(ctx.pagePath);
  const imgUrl = buildImageUrl(ctx.siteUrl, id, ctx.avifEnabled);
  const exif = getExifFields(img);
  const hasMeta = !!title || !!desc || exif.length > 0;

  const L = [
    `Love this shot? Head over to [${ctx.pageTitle}](${pageUrl}) and drop a heart, or react with :heart: right here!`,
    "",
  ];

  if (hasMeta) {
    L.push('<table align="center" style="margin: 0 auto; width: auto;">');
    L.push("  <tr>");
    L.push(
      `    <td align="center" style="padding-right: 12px;"><img src="${imgUrl}" alt="${alt}" width="400" /></td>`
    );
    L.push('    <td valign="top" style="white-space: nowrap;">');
    if (title)
      L.push(`      <div><b>Title:</b> ${escapeHtml(title)}</div>`);
    if (desc)
      L.push(`      <div><b>Description:</b> ${escapeHtml(desc)}</div>`);
    for (const f of exif)
      L.push(
        `      <div><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</div>`
      );
    L.push("    </td>");
    L.push("  </tr>");
    L.push("</table>");
  } else {
    L.push(
      `<p align="center"><img src="${imgUrl}" alt="${alt}" width="400" /></p>`
    );
  }

  L.push("");
  L.push("`masonry-image:" + id + "`");
  return L.join("\n");
}

/* ────────── Matching ────────── */

/**
 * Extract image ID from comment body (current backtick format only).
 */
function parseImageId(body) {
  const m = body?.match(/`masonry-image:(.+?)`/);
  return m ? m[1].trim() : null;
}

/**
 * Does the comment need a content update?
 *
 * Checks key data substrings present in the raw body — immune to any HTML
 * attribute reordering GitHub might apply. Also counts metadata rows to
 * detect removed fields.
 */
function commentNeedsUpdate(body, img, ctx) {
  // Image URL must be current
  const url = buildImageUrl(ctx.siteUrl, img.image, ctx.avifEnabled);
  if (!body.includes(url)) return true;

  const title = img.title || "";
  const desc = img.description || "";
  const exif = getExifFields(img);
  const hasMeta = !!title || !!desc || exif.length > 0;

  // Layout type must match
  if (hasMeta && !body.includes("<table")) return true;
  if (!hasMeta && !body.includes("<p")) return true;

  // Each metadata value must appear in its labeled context
  if (title && !body.includes("Title:</b> " + escapeHtml(title))) return true;
  if (desc && !body.includes("Description:</b> " + escapeHtml(desc)))
    return true;
  for (const f of exif) {
    if (
      !body.includes(escapeHtml(f.label) + ":</b> " + escapeHtml(f.value))
    )
      return true;
  }

  // Metadata row count must match (detects removed fields)
  if (hasMeta) {
    const expected = (title ? 1 : 0) + (desc ? 1 : 0) + exif.length;
    const actual = (body.match(/<div><b>/g) || []).length;
    if (actual !== expected) return true;
  }

  return false;
}

/**
 * Does the discussion description need updating?
 */
function discussionNeedsUpdate(body, ctx) {
  if (!body) return true;
  if (!body.includes(ctx.pageTitle)) return true;
  if (!body.includes("**" + ctx.imageCount + "** photos")) return true;
  if (!body.includes(ctx.blogTitle)) return true;
  if (ctx.blogAuthor && !body.includes(ctx.blogAuthor)) return true;
  return false;
}

/* ────────── Per-page processing ────────── */

/**
 * Process one masonry page: ensure discussion + comments exist and match.
 *
 * 1. Create discussion if missing → add all comments → done
 * 2. Unlock if locked; update description if needed
 * 3. Fetch all comments
 * 4. Keep first valid match per image; mark rest for delete
 * 5. Mark outdated-content comments for update
 * 6. Apply: deletes → updates → creates
 */
async function processPage(
  pat, repo, repoId, catId,
  pagePath, images, disc, log, ctx
) {
  try {
    if (stopped) return false;

    const imgMap = {};
    for (const img of images) if (img.image) imgMap[img.image] = img;
    const expectedIds = new Set(Object.keys(imgMap));

    /* 1. Create discussion if it doesn't exist */
    if (!disc) {
      log.info(`[masonry-reactions] Creating discussion: ${pagePath}`);
      disc = await apiCreateDiscussion(
        pat, repoId, catId, PREFIX + pagePath, buildDiscussionBody(ctx), log
      );
      if (!disc) {
        log.error(`[masonry-reactions] Failed to create discussion: ${pagePath}`);
        return false;
      }
      for (const img of images) {
        if (stopped) break;
        await apiAddComment(pat, disc.id, buildCommentBody(img, ctx), log);
      }
      return !stopped;
    }

    /* 2. Unlock + update description */
    if (disc.locked) await apiUnlock(pat, disc.id, log);
    if (discussionNeedsUpdate(disc.body, ctx)) {
      log.info(`[masonry-reactions] Updating description: ${pagePath}`);
      await apiUpdateDiscussion(pat, disc.id, buildDiscussionBody(ctx), log);
    }

    /* 3. Fetch all comments */
    const comments = await fetchComments(pat, repo, disc.number);

    /* 4 & 5. Classify each comment */
    const seen = new Set();
    const toDel = [];
    const toUpd = [];

    for (const c of comments) {
      const imgId = parseImageId(c.body);
      if (!imgId || !expectedIds.has(imgId) || seen.has(imgId)) {
        toDel.push(c.id);
      } else {
        seen.add(imgId);
        if (commentNeedsUpdate(c.body, imgMap[imgId], ctx)) {
          toUpd.push({ id: c.id, body: buildCommentBody(imgMap[imgId], ctx) });
        }
      }
    }

    /* 6. Apply mutations */
    for (const id of toDel) {
      if (stopped) break;
      log.info("[masonry-reactions] Deleting orphan/duplicate comment");
      await apiDeleteComment(pat, id, log);
    }
    for (const u of toUpd) {
      if (stopped) break;
      log.info("[masonry-reactions] Updating comment content");
      await apiUpdateComment(pat, u.id, u.body, log);
    }
    for (const img of images) {
      if (stopped) break;
      if (!seen.has(img.image)) {
        log.info(`[masonry-reactions] Adding comment: ${img.image}`);
        await apiAddComment(pat, disc.id, buildCommentBody(img, ctx), log);
      }
    }

    return !stopped;
  } catch (err) {
    log.error(
      `[masonry-reactions] ${stopped ? "STOPPED" : "ERROR"} ${pagePath}: ${err.message}`
    );
    return false;
  }
}

/* ────────── Hexo integration ────────── */

hexo.extend.filter.register("before_generate", async function () {
  const g = hexo.theme.config?.comment?.config?.giscus;
  if (!g) return;

  const { author_pat: pat, repo, repo_id: repoId, category_id: catId, proxy } = g;
  if (!pat || !repo || !repoId || !catId || !proxy) {
    hexo.log.info("[masonry-reactions] Skipping: incomplete giscus config");
    return;
  }
  if (!hexo.theme.config?.comment?.enable) {
    hexo.log.info("[masonry-reactions] Skipping: comments disabled");
    return;
  }

  rlRemaining = null;
  stopped = false;

  const masonry = hexo.locals.get("data")?.masonry;
  if (!masonry) {
    hexo.log.info("[masonry-reactions] No masonry data");
    return;
  }

  const siteUrl = (hexo.config.url || "").replace(/\/+$/, "");
  const blogTitle =
    hexo.theme.config?.info?.title || hexo.config.title || "Blog";
  const blogAuthor =
    hexo.theme.config?.info?.author || hexo.config.author || "";
  const avif =
    hexo.theme.config?.plugins?.minifier?.imagesOptimize?.AVIF_COMPRESS !==
    false;

  // Collect pages
  const pages = [];
  for (const cat of masonry.filter((c) => c.links_category)) {
    for (const item of cat.list || []) {
      if (!item.images?.length) continue;
      const title = item["page-title"] || item.name;
      const pagePath = `masonry/${title}/`;
      pages.push({
        pagePath,
        images: item.images,
        ctx: {
          pageTitle: title,
          pagePath,
          imageCount: item.images.length,
          siteUrl,
          blogTitle,
          blogAuthor,
          avifEnabled: avif,
        },
      });
    }
  }

  if (!pages.length) {
    hexo.log.info("[masonry-reactions] No masonry pages found");
    return;
  }

  hexo.log.info(`[masonry-reactions] Processing ${pages.length} pages...`);

  // Phase 1: fetch all existing discussions in category
  let discs;
  try {
    discs = await fetchDiscussions(pat, repo, catId);
    hexo.log.info(
      `[masonry-reactions] Found ${Object.keys(discs).length}/${pages.length} discussions`
    );
  } catch (e) {
    hexo.log.error(`[masonry-reactions] Fetch failed: ${e.message}`);
    return;
  }

  // Phase 2: process each page
  let ok = 0;
  for (const p of pages) {
    if (stopped) {
      hexo.log.error("[masonry-reactions] Stopping: rate limit.");
      break;
    }
    const success = await processPage(
      pat, repo, repoId, catId,
      p.pagePath, p.images, discs[p.pagePath] || null, hexo.log, p.ctx
    );
    if (success) {
      ok++;
      hexo.log.info(`[masonry-reactions] ✓ ${p.pagePath}`);
    }
  }

  hexo.log.info(`[masonry-reactions] Done. ${ok}/${pages.length} OK.`);
});
