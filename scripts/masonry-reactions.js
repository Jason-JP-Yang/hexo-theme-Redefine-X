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
            locked
            comments(first: 100) {
              totalCount
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
 * Create a new reactions discussion
 */
async function createReactionsDiscussion(pat, repositoryId, categoryId, pagePath, log) {
  const term = `${REACTIONS_PREFIX}${pagePath}`;

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
        body: [
          `This discussion is auto-generated for tracking photo reactions on the masonry page: \`${pagePath}\``,
          "",
          "⚠️ Please do not delete or modify this discussion. Comments here are mapped to individual photos.",
          "",
          "---",
          "*Generated by hexo-masonry-reactions*",
        ].join("\n"),
      },
    },
    log,
    `create discussion: ${pagePath}`
  );

  return result?.createDiscussion?.discussion;
}

/**
 * Add a comment for a specific image.
 * Body includes:
 * - HTML comment tag (for build-time raw body parsing)
 * - Visible code tag (for frontend bodyHTML parsing via giscus API)
 */
async function addImageComment(pat, discussionId, imageId, imageTitle, log) {
  const displayTitle = imageTitle || imageId;
  const body = `<!-- masonry-image-id: ${imageId} -->\n📷 **${displayTitle}**\n\n\`masonry-image:${imageId}\``;

  const result = await executeMutation(
    pat,
    `mutation($input: AddDiscussionCommentInput!) {
      addDiscussionComment(input: $input) {
        comment { id }
      }
    }`,
    { input: { discussionId, body } },
    log,
    `add comment: ${imageId}`
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
 * Parse masonry-image-id from raw comment body
 */
function parseImageId(commentBody) {
  if (!commentBody) return null;
  const match = commentBody.match(/<!-- masonry-image-id: (.+?) -->/);
  return match ? match[1].trim() : null;
}

/**
 * Check if a comment body already has the new visible code tag
 */
function hasVisibleImageTag(commentBody) {
  return commentBody && commentBody.includes("`masonry-image:");
}

/* ==================== Page Processing ==================== */

/**
 * Process a single masonry page:
 * 1. Create discussion if missing
 * 2. Update old-format comments (add visible code tag)
 * 3. Create comments for new images
 * 4. Lock discussion
 */
async function processPageReactions(pat, repo, repositoryId, categoryId, pagePath, images, discussion, log) {
  try {
    if (abortAll) {
      log.error(`[masonry-reactions] Skipping ${pagePath}: operations aborted`);
      return false;
    }

    // 1. Create discussion if needed
    if (!discussion) {
      log.info(`[masonry-reactions] Creating discussion for: ${pagePath}`);
      discussion = await createReactionsDiscussion(pat, repositoryId, categoryId, pagePath, log);
      if (!discussion) {
        log.error(`[masonry-reactions] Failed to create discussion for: ${pagePath}`);
        return false;
      }
      discussion.comments = { totalCount: 0, nodes: [] };
      discussion.locked = false;
    }

    // 2. Parse existing comments
    const existingComments = discussion.comments?.nodes || [];
    const existingImageIds = new Set();
    const commentsToUpdate = [];

    for (const comment of existingComments) {
      const imageId = parseImageId(comment.body);
      if (imageId) {
        existingImageIds.add(imageId);
        // Check if comment needs format upgrade
        if (!hasVisibleImageTag(comment.body)) {
          commentsToUpdate.push({
            commentId: comment.id,
            imageId,
            oldBody: comment.body,
          });
        }
      }
    }

    // 3. Determine what work is needed
    const newImages = images.filter((img) => !existingImageIds.has(img.image));
    const needsMutations = newImages.length > 0 || commentsToUpdate.length > 0;

    if (!needsMutations) {
      // Ensure discussion is locked, nothing else to do
      if (!discussion.locked) {
        log.info(`[masonry-reactions] Locking discussion: ${pagePath}`);
        await lockDiscussion(pat, discussion.id, log);
      }
      return true;
    }

    // 4. Unlock if locked (we need to modify comments)
    if (discussion.locked) {
      log.info(`[masonry-reactions] Unlocking discussion: ${pagePath}`);
      await unlockDiscussion(pat, discussion.id, log);
    }

    // 5. Update old-format comments
    for (const item of commentsToUpdate) {
      if (abortAll) break;
      log.info(`[masonry-reactions] Updating comment format for: ${item.imageId}`);
      const newBody = `${item.oldBody}\n\n\`masonry-image:${item.imageId}\``;
      await updateCommentBody(pat, item.commentId, newBody, log, `update format: ${item.imageId}`);
    }

    // 6. Add comments for new images
    for (const img of newImages) {
      if (abortAll) break;
      log.info(`[masonry-reactions] Adding comment for: ${img.image}`);
      await addImageComment(pat, discussion.id, img.image, img.title, log);
    }

    // 7. Lock discussion
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

  // Collect all page infos
  const allPageInfos = [];
  for (const category of categories) {
    for (const item of category.list || []) {
      if (!item.images || item.images.length === 0) continue;
      const pageTitle = item["page-title"] || item.name;
      const pagePath = `masonry/${pageTitle}/`;
      allPageInfos.push({ pagePath, images: item.images, pageTitle });
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
      info.pagePath, info.images, discussion, hexo.log
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
