"use strict";

/**
 * Masonry Reactions - Build-time script
 *
 * Pre-creates GitHub Discussions with comments for each masonry page image.
 * Each comment maps to a photo and tracks heart reactions as "likes".
 *
 * This script does NOT store reaction counts at build time.
 * All reaction data is fetched live by the frontend client via giscus.app API.
 *
 * Flow:
 * 1. Batch-search for existing discussions across all masonry pages (single query)
 * 2. Create missing discussions (one per masonry page, 1s interval)
 * 3. Create missing comments (one per image, 1s interval)
 * 4. Update old-format comments to include visible image ID tag (for bodyHTML parsing)
 * 5. Lock discussions to prevent manual comments (reactions still work)
 *
 * Rate limit handling:
 * - 1s delay between all mutation API calls
 * - Secondary rate limit: read Retry-After header, wait accordingly, retry up to 3 times
 * - Primary rate limit (X-RateLimit-Remaining=0): abort all operations with ERROR
 */

const https = require("https");
const path = require("path");

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
const REACTIONS_PREFIX = "[masonry-reactions] ";

// Rate limit state
let rateLimitRemaining = null;
let abortAll = false;

/* ==================== GitHub GraphQL API ==================== */

/**
 * Make a GitHub GraphQL request.
 * Returns { data, headers } so callers can inspect rate limit headers.
 */
function graphqlRequest(pat, query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const url = new URL(GITHUB_GRAPHQL_API);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "User-Agent": "hexo-masonry-reactions",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Track primary rate limit
          const remaining = res.headers["x-ratelimit-remaining"];
          if (remaining !== undefined) {
            rateLimitRemaining = parseInt(remaining, 10);
          }
          resolve({ data: parsed, headers: res.headers });
        } catch (e) {
          reject(new Error(`Failed to parse GitHub API response: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Execute a GraphQL mutation with retry logic.
 * - 1 second delay before each attempt
 * - Reads Retry-After header on secondary rate limits
 * - Max 3 retries per mutation
 * - Aborts all operations if primary rate limit is exhausted
 */
async function executeMutation(pat, query, variables, log, label = "mutation") {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (abortAll) {
      throw new Error("Aborted: primary rate limit reached");
    }

    // Check primary rate limit before attempting
    if (rateLimitRemaining !== null && rateLimitRemaining <= 0) {
      abortAll = true;
      log.error(`[masonry-reactions] PRIMARY RATE LIMIT reached (X-RateLimit-Remaining: 0). Aborting all operations.`);
      throw new Error("Aborted: X-RateLimit-Remaining is 0");
    }

    // 1 second delay before each mutation
    await new Promise((r) => setTimeout(r, 1000));

    let result;
    try {
      result = await graphqlRequest(pat, query, variables);
    } catch (err) {
      if (attempt < 2) {
        log.warn(`[masonry-reactions] Network error on ${label}, retrying (attempt ${attempt + 1}/3): ${err.message}`);
        continue;
      }
      throw err;
    }

    const responseData = result.data;
    const headers = result.headers;

    // Check primary rate limit after response
    if (rateLimitRemaining !== null && rateLimitRemaining <= 0) {
      abortAll = true;
      log.error(`[masonry-reactions] PRIMARY RATE LIMIT reached after ${label}. Aborting all operations.`);
      throw new Error("Aborted: X-RateLimit-Remaining is 0");
    }

    if (responseData.errors) {
      const isSecondaryRateLimit = responseData.errors.some((e) =>
        e.message?.includes("submitted too quickly") ||
        e.message?.includes("abuse") ||
        e.message?.includes("secondary rate limit")
      );

      if (isSecondaryRateLimit && attempt < 2) {
        // Read Retry-After header; fallback to progressive wait
        const retryAfter = headers["retry-after"];
        const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : (attempt + 1) * 5;
        log.warn(`[masonry-reactions] Secondary rate limit on ${label}, waiting ${waitSeconds}s (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }

      // Final attempt failed or non-rate-limit error
      throw new Error(`${label} failed: ${JSON.stringify(responseData.errors)}`);
    }

    return responseData;
  }
}

/* ==================== Discussion Management ==================== */

/**
 * Batch search for existing discussions across all masonry pages
 * in a single GraphQL query using aliases.
 * Groups searches to avoid query complexity limits (max 10 per batch).
 */
async function batchFindDiscussions(pat, repo, pageInfos, log) {
  const BATCH_SIZE = 10;
  const allResults = {};

  for (let i = 0; i < pageInfos.length; i += BATCH_SIZE) {
    if (abortAll) break;

    const batch = pageInfos.slice(i, i + BATCH_SIZE);

    // Build aliased query
    const varDefs = batch.map((_, j) => `$q${j}: String!`).join(", ");
    const searchParts = batch
      .map(
        (_, j) => `
      search${j}: search(query: $q${j}, type: DISCUSSION, first: 5) {
        nodes {
          ... on Discussion {
            id
            number
            title
            body
            locked
            comments(first: 100) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes { id body }
            }
          }
        }
      }`
      )
      .join("\n");

    const fullQuery = `query(${varDefs}) { ${searchParts} }`;
    const variables = {};
    batch.forEach((info, j) => {
      const term = `${REACTIONS_PREFIX}${info.pagePath}`;
      variables[`q${j}`] = `"${term}" in:title repo:${repo} is:discussion`;
    });

    const result = await graphqlRequest(pat, fullQuery, variables);

    if (result.data.errors) {
      log.warn(`[masonry-reactions] Batch search errors: ${JSON.stringify(result.data.errors)}`);
    }

    // Match results to pages
    batch.forEach((info, j) => {
      const searchResult = result.data.data?.[`search${j}`];
      if (searchResult?.nodes) {
        const term = `${REACTIONS_PREFIX}${info.pagePath}`;
        const match = searchResult.nodes.find((n) => n.title === term);
        if (match) {
          allResults[info.pagePath] = match;
        }
      }
    });

    // 1 second delay between batches
    if (i + BATCH_SIZE < pageInfos.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return allResults;
}

/**
 * Fetch remaining comments from a discussion when the initial 100 wasn't enough.
 * Uses cursor-based pagination.
 */
async function fetchRemainingComments(pat, repo, discussionNumber, afterCursor, log) {
  const [owner, name] = repo.split('/');
  const result = await graphqlRequest(pat,
    `query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          comments(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id body }
          }
        }
      }
    }`,
    { owner, name, number: discussionNumber, after: afterCursor }
  );
  return result.data?.data?.repository?.discussion?.comments;
}

/**
 * Update a discussion body.
 */
async function updateDiscussionBody(pat, discussionId, newBody, log) {
  await executeMutation(
    pat,
    `mutation($input: UpdateDiscussionInput!) {
      updateDiscussion(input: $input) {
        discussion { id }
      }
    }`,
    { input: { discussionId, body: newBody } },
    log,
    "update discussion body"
  );
}

/**
 * Create a new reactions discussion with a friendly description.
 */
async function createReactionsDiscussion(pat, repositoryId, categoryId, pagePath, log, context) {
  const term = `${REACTIONS_PREFIX}${pagePath}`;
  const body = buildDiscussionBody(context);

  const result = await executeMutation(
    pat,
    `mutation($input: CreateDiscussionInput!) {
      createDiscussion(input: $input) {
        discussion { id number title }
      }
    }`,
    {
      input: {
        repositoryId,
        categoryId,
        title: term,
        body,
      },
    },
    log,
    `create discussion: ${pagePath}`
  );

  return result?.createDiscussion?.discussion;
}

/**
 * Add a comment for an image with photo display and EXIF info.
 */
async function addImageComment(pat, discussionId, imageData, log, context) {
  const body = buildCommentBody(imageData, context);

  const result = await executeMutation(
    pat,
    `mutation($input: AddDiscussionCommentInput!) {
      addDiscussionComment(input: $input) {
        comment { id }
      }
    }`,
    { input: { discussionId, body } },
    log,
    `add comment: ${imageData.image}`
  );

  return result?.addDiscussionComment?.comment;
}

/**
 * Update an existing comment to add the visible code tag.
 * Migrates old-format comments (HTML comment only) to new format.
 */
async function updateCommentBody(pat, commentId, newBody, log, label) {
  const result = await executeMutation(
    pat,
    `mutation($commentId: ID!, $body: String!) {
      updateDiscussionComment(input: {commentId: $commentId, body: $body}) {
        comment { id }
      }
    }`,
    { commentId, body: newBody },
    log,
    label || `update comment: ${commentId}`
  );

  return result?.updateDiscussionComment?.comment;
}

/**
 * Lock a discussion to prevent new comments (reactions still allowed)
 */
async function lockDiscussion(pat, lockableId, log) {
  await executeMutation(
    pat,
    `mutation($input: LockLockableInput!) {
      lockLockable(input: $input) {
        lockedRecord { locked }
      }
    }`,
    { input: { lockableId } },
    log,
    "lock discussion"
  );
}

/**
 * Unlock a discussion (needed to add new comments)
 */
async function unlockDiscussion(pat, lockableId, log) {
  await executeMutation(
    pat,
    `mutation($input: UnlockLockableInput!) {
      unlockLockable(input: $input) {
        unlockedRecord { locked }
      }
    }`,
    { input: { lockableId } },
    log,
    "unlock discussion"
  );
}

/* ==================== Helpers ==================== */

/**
 * Escape special HTML characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the full image URL, using optimized (AVIF) path when enabled.
 * Mirrors img-optimizer's PathManager.buildOptimizedPath logic.
 */
function buildImageUrl(siteUrl, imageId, avifEnabled) {
  const BITMAP_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(imageId).toLowerCase();
  const isBitmap = BITMAP_EXTS.includes(ext);

  let imagePath = 'masonry/' + imageId;
  if (avifEnabled && isBitmap) {
    const base = path.posix.basename(imageId, ext);
    const dir = path.posix.dirname(imageId);
    const relDir = dir === '.' ? 'masonry' : 'masonry/' + dir;
    imagePath = 'build/' + relDir + '/' + base + '.avif';
  }

  return siteUrl + '/' + encodeURI(imagePath);
}

/**
 * Extract EXIF fields from a masonry.yml image entry.
 * Returns array of {label, value} pairs for non-empty fields.
 */
function extractExifFields(imageData) {
  const FIELD_DEFS = [
    { key: 'make', label: 'Camera' },
    { key: 'model', label: 'Model' },
    { key: 'lensModel', label: 'Lens' },
    { key: 'focalLength', label: 'Focal Length' },
    { key: 'aperture', label: 'Aperture' },
    { key: 'exposureTime', label: 'Shutter' },
    { key: 'ISOSpeedRatings', label: 'ISO' },
    { key: 'exposureProgram', label: 'Exposure Program' },
    { key: 'exposureBias', label: 'Exposure Comp.' },
    { key: 'meteringMode', label: 'Metering' },
    { key: 'flash', label: 'Flash' },
    { key: 'whiteBalance', label: 'White Balance' },
    { key: 'focusMode', label: 'Focus Mode' },
    { key: 'dateTimeOriginal', label: 'Date Taken' },
    { key: 'GPSLatitude', label: 'Latitude' },
    { key: 'GPSLongitude', label: 'Longitude' },
    { key: 'GPSAltitude', label: 'Altitude' },
  ];
  const fields = [];
  for (const { key, label } of FIELD_DEFS) {
    const val = imageData[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      fields.push({ label, value: String(val).trim() });
    }
  }
  return fields;
}

/**
 * Build the friendly discussion body (description).
 */
function buildDiscussionBody(context) {
  const { pageTitle, pagePath, imageCount, siteUrl, blogTitle, blogAuthor } = context;
  const pageUrl = siteUrl + '/' + encodeURI(pagePath);
  const lines = [
    '# ' + pageTitle,
    '',
    'Hey there! This is the reactions tracker for **[' + pageTitle + '](' + pageUrl + ')**.',
    '',
    'This gallery has **' + imageCount + '** photos. Each comment below represents one photo.',
    '',
    'If you see something you like, leave a :heart: **heart reaction** on its comment ' +
      'and it\'ll show up as a like on the [gallery page](' + pageUrl + '). ' +
      'You can also click the heart button directly on the gallery!',
    '',
    '> **Note:** Only :heart: heart reactions are counted as likes. ' +
      'Other emoji reactions, upvotes, or discussion votes won\'t be tracked.',
    '',
    '---',
    '',
    '**' + blogTitle + '** by ' + blogAuthor + ' | [' + siteUrl + '](' + siteUrl + ')',
    '',
    '*Powered by [hexo-theme-redefine-x](https://github.com/EvanNotFound/hexo-theme-redefine) masonry reactions*',
  ];
  return lines.join('\n');
}

/**
 * Build the comment body for a single image.
 * Includes photo preview, optional EXIF table, and masonry-image ID tag.
 */
function buildCommentBody(imageData, context) {
  const { pageTitle, pagePath, siteUrl, avifEnabled } = context;
  const imageId = imageData.image;
  const title = imageData.title || '';
  const description = imageData.description || '';
  const altText = escapeHtml(title || imageId);
  const pageUrl = siteUrl + '/' + encodeURI(pagePath);
  const imageUrl = buildImageUrl(siteUrl, imageId, avifEnabled);

  const exifFields = extractExifFields(imageData);
  const hasExif = exifFields.length > 0;

  const lines = [];

  lines.push('Love this shot? Head over to [' + pageTitle + '](' + pageUrl + ') and drop a heart, or react with :heart: right here!');
  lines.push('');

  if (title) {
    lines.push('### ' + title);
    lines.push('');
  }
  if (description) {
    lines.push('> ' + description);
    lines.push('');
  }

  if (hasExif) {
    lines.push('<table>');
    lines.push('  <tr>');
    lines.push('    <td width="60%" align="center"><img src="' + imageUrl + '" alt="' + altText + '" width="400" /></td>');
    lines.push('    <td width="40%">');
    for (const f of exifFields) {
      lines.push('      <b>' + escapeHtml(f.label) + ':</b> ' + escapeHtml(f.value) + '<br>');
    }
    lines.push('    </td>');
    lines.push('  </tr>');
    lines.push('</table>');
  } else {
    lines.push('<p align="center"><img src="' + imageUrl + '" alt="' + altText + '" width="400" /></p>');
  }

  lines.push('');
  lines.push('`masonry-image:' + imageId + '`');

  return lines.join('\n');
}

/**
 * Parse masonry-image-id from raw comment body.
 * Supports both backtick format and legacy HTML comment format.
 */
function parseImageId(commentBody) {
  if (!commentBody) return null;
  // Try backtick format first: `masonry-image:IMAGE_ID`
  let match = commentBody.match(/`masonry-image:(.+?)`/);
  if (match) return match[1].trim();
  // Fall back to legacy HTML comment: <!-- masonry-image-id: IMAGE_ID -->
  match = commentBody.match(/<!-- masonry-image-id: (.+?) -->/);
  return match ? match[1].trim() : null;
}

/**
 * Check if a comment body has the visible masonry-image code tag
 */
function hasVisibleImageTag(commentBody) {
  return commentBody && commentBody.includes('`masonry-image:');
}

/**
 * Check if a comment body is in the current format (has image display).
 * Old format: just HTML comment + emoji + code tag.
 * Current format: has <img> preview + code tag.
 */
function isCurrentFormat(commentBody) {
  if (!commentBody) return false;
  return commentBody.includes('<img ') && commentBody.includes('`masonry-image:');
}

/* ==================== Page Processing ==================== */

/**
 * Process a single masonry page:
 * 1. Create or update discussion
 * 2. Fetch ALL comments (with pagination)
 * 3. Update outdated-format comments to current format
 * 4. Create comments for new images
 * 5. Lock discussion
 */
async function processPageReactions(pat, repo, repositoryId, categoryId, pagePath, images, discussion, log, context) {
  try {
    if (abortAll) {
      log.error(`[masonry-reactions] Skipping ${pagePath}: operations aborted`);
      return false;
    }

    // Build image lookup by imageId for format updates
    const imageDataMap = {};
    for (const img of images) {
      if (img.image) imageDataMap[img.image] = img;
    }

    // 1. Create discussion if needed
    if (!discussion) {
      log.info(`[masonry-reactions] Creating discussion for: ${pagePath}`);
      discussion = await createReactionsDiscussion(pat, repositoryId, categoryId, pagePath, log, context);
      if (!discussion) {
        log.error(`[masonry-reactions] Failed to create discussion for: ${pagePath}`);
        return false;
      }
      discussion.comments = { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] };
      discussion.locked = false;
    }

    // 1b. Check if discussion body needs updating to new format
    if (discussion.body !== undefined) {
      const hasNewBody = discussion.body && discussion.body.includes('hexo-theme-redefine-x');
      if (!hasNewBody) {
        log.info(`[masonry-reactions] Updating discussion body: ${pagePath}`);
        const newBody = buildDiscussionBody(context);
        await updateDiscussionBody(pat, discussion.id, newBody, log);
      }
    }

    // 2. Fetch ALL comments with pagination
    let allComments = [...(discussion.comments?.nodes || [])];
    let pageInfo = discussion.comments?.pageInfo;

    while (pageInfo?.hasNextPage && pageInfo.endCursor) {
      log.info(`[masonry-reactions] Fetching more comments for: ${pagePath} (have ${allComments.length})`);
      const moreComments = await fetchRemainingComments(pat, repo, discussion.number, pageInfo.endCursor, log);
      if (!moreComments) break;
      allComments.push(...(moreComments.nodes || []));
      pageInfo = moreComments.pageInfo;
    }

    // 3. Parse existing comments
    const existingImageIds = new Set();
    const commentsToUpdate = [];

    for (const comment of allComments) {
      const imageId = parseImageId(comment.body);
      if (imageId) {
        existingImageIds.add(imageId);
        // Check if comment needs format upgrade to current format
        if (!isCurrentFormat(comment.body)) {
          const imgData = imageDataMap[imageId];
          if (imgData) {
            commentsToUpdate.push({ commentId: comment.id, imageId, imgData });
          }
        }
      }
    }

    // 4. Determine what work is needed
    const newImages = images.filter((img) => !existingImageIds.has(img.image));
    const needsMutations = newImages.length > 0 || commentsToUpdate.length > 0;

    if (!needsMutations) {
      if (!discussion.locked) {
        log.info(`[masonry-reactions] Locking discussion: ${pagePath}`);
        await lockDiscussion(pat, discussion.id, log);
      }
      return true;
    }

    // 5. Unlock if locked (we need to modify)
    if (discussion.locked) {
      log.info(`[masonry-reactions] Unlocking discussion: ${pagePath}`);
      await unlockDiscussion(pat, discussion.id, log);
    }

    // 6. Update outdated-format comments to current format
    for (const item of commentsToUpdate) {
      if (abortAll) break;
      log.info(`[masonry-reactions] Updating comment format for: ${item.imageId}`);
      const newBody = buildCommentBody(item.imgData, context);
      await updateCommentBody(pat, item.commentId, newBody, log, `update format: ${item.imageId}`);
    }

    // 7. Add comments for new images
    for (const img of newImages) {
      if (abortAll) break;
      log.info(`[masonry-reactions] Adding comment for: ${img.image}`);
      await addImageComment(pat, discussion.id, img, log, context);
    }

    // 8. Lock discussion
    if (!abortAll) {
      log.info(`[masonry-reactions] Locking discussion: ${pagePath}`);
      await lockDiscussion(pat, discussion.id, log);
    }

    return true;
  } catch (err) {
    if (abortAll) {
      log.error(`[masonry-reactions] ABORTED ${pagePath}: ${err.message}`);
    } else {
      log.error(`[masonry-reactions] ERROR processing ${pagePath}: ${err.message}`);
    }
    return false;
  }
}

/* ==================== Hexo Integration ==================== */

hexo.extend.filter.register("before_generate", async function () {
  const giscusConfig = hexo.theme.config?.comment?.config?.giscus;
  if (!giscusConfig) return;

  const pat = giscusConfig.author_pat;
  const repo = giscusConfig.repo;
  const repositoryId = giscusConfig.repo_id;
  const categoryId = giscusConfig.category_id;
  const commentEnabled = hexo.theme.config?.comment?.enable;

  if (!pat || !repo || !repositoryId || !categoryId) {
    hexo.log.info("[masonry-reactions] Skipping: missing giscus config (repo, repo_id, category_id, or author_pat)");
    return;
  }

  if (!commentEnabled) {
    hexo.log.info("[masonry-reactions] Skipping: comments are disabled");
    return;
  }

  // Reset state for this build
  rateLimitRemaining = null;
  abortAll = false;

  // Load masonry data
  const data = hexo.locals.get("data");
  const masonryData = data?.masonry;
  if (!masonryData) {
    hexo.log.info("[masonry-reactions] Skipping: no masonry data found");
    return;
  }

  const categories = masonryData.filter((item) => item.links_category);

  // Site config for building URLs and discussion bodies
  const siteUrl = (hexo.config.url || '').replace(/\/+$/, '');
  const blogTitle = hexo.theme.config?.info?.title || hexo.config.title || 'Blog';
  const blogAuthor = hexo.theme.config?.info?.author || hexo.config.author || '';
  const avifEnabled = hexo.theme.config?.plugins?.minifier?.imagesOptimize?.AVIF_COMPRESS !== false;

  // Collect all page infos
  const allPageInfos = [];
  for (const category of categories) {
    for (const item of category.list || []) {
      if (!item.images || item.images.length === 0) continue;
      const pageTitle = item["page-title"] || item.name;
      const pagePath = `masonry/${pageTitle}/`;
      allPageInfos.push({
        pagePath,
        images: item.images,
        pageTitle,
        context: {
          pageTitle,
          pagePath,
          imageCount: item.images.length,
          siteUrl,
          blogTitle,
          blogAuthor,
          avifEnabled,
        },
      });
    }
  }

  if (allPageInfos.length === 0) {
    hexo.log.info("[masonry-reactions] No masonry pages with images found");
    return;
  }

  hexo.log.info(`[masonry-reactions] Processing ${allPageInfos.length} masonry pages...`);

  // Phase 1: Batch search for all existing discussions (single query or few batches)
  let existingDiscussions = {};
  try {
    existingDiscussions = await batchFindDiscussions(pat, repo, allPageInfos, hexo.log);
    hexo.log.info(
      `[masonry-reactions] Found ${Object.keys(existingDiscussions).length}/${allPageInfos.length} existing discussions`
    );
  } catch (err) {
    hexo.log.error(`[masonry-reactions] Batch search failed: ${err.message}`);
    return;
  }

  // Phase 2+3: Process each page (create discussions/comments, update old formats)
  let successCount = 0;
  for (const info of allPageInfos) {
    if (abortAll) {
      hexo.log.error(`[masonry-reactions] ABORTING remaining pages due to rate limit.`);
      break;
    }

    const discussion = existingDiscussions[info.pagePath] || null;
    const success = await processPageReactions(
      pat, repo, repositoryId, categoryId,
      info.pagePath, info.images, discussion, hexo.log, info.context
    );

    if (success) {
      successCount++;
      hexo.log.info(`[masonry-reactions] ✓ ${info.pagePath}: ${info.images.length} images`);
    }
  }

  hexo.log.info(
    `[masonry-reactions] Done. ${successCount}/${allPageInfos.length} pages processed successfully.`
  );
});
