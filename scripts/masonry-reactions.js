"use strict";

/**
 * Masonry Reactions - Build-time script
 *
 * Pre-creates GitHub Discussions with comments for each masonry page image.
 * Uses GraphQL aliases to batch operations in single requests.
 * Does NOT store like counts - the client fetches live data at runtime.
 *
 * Flow:
 * 1. Batch-search all masonry page discussions in one request
 * 2. Batch-create missing discussions
 * 3. For each discussion, batch-create missing comments (up to ~20 per request)
 * 4. Lock discussions to prevent user comments (reactions still work)
 * 5. Store only discussion numbers + image→commentId mappings for the client
 */

const https = require("https");

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
const REACTIONS_PREFIX = "[masonry-reactions] ";

// Maximum comments per batch mutation (GitHub has ~500KB body limit)
const BATCH_COMMENT_SIZE = 20;

/* ==================== GitHub GraphQL API ==================== */

let rateLimitRemaining = null;
let rateLimitResetAt = null;

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
      // Track rate limit from response headers
      const remaining = res.headers["x-ratelimit-remaining"];
      const resetAt = res.headers["x-ratelimit-reset"];
      if (remaining !== undefined) rateLimitRemaining = parseInt(remaining, 10);
      if (resetAt !== undefined) rateLimitResetAt = parseInt(resetAt, 10);

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
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
 * Check rate limit before making a request. If too low, abort.
 */
function checkRateLimit(log) {
  if (rateLimitRemaining !== null && rateLimitRemaining < 5) {
    const resetTime = rateLimitResetAt
      ? new Date(rateLimitResetAt * 1000).toISOString()
      : "unknown";
    log.error(
      `[masonry-reactions] Rate limit nearly exhausted (${rateLimitRemaining} remaining). Resets at ${resetTime}. Aborting.`
    );
    return false;
  }
  return true;
}

/* ==================== Batch Discussion Search ==================== */

/**
 * Sanitize alias name for GraphQL (only alphanumeric + underscore, must start with letter)
 */
function toAlias(str, idx) {
  return "d_" + idx;
}

/**
 * Batch-search for existing discussions by title using GraphQL aliases.
 * Each page gets its own aliased search query in a single request.
 * Returns: { [pagePath]: discussion | null }
 */
async function batchFindDiscussions(pat, repo, pagePaths, log) {
  if (pagePaths.length === 0) return {};

  const results = {};

  // Build aliased queries - each alias searches for one discussion
  const aliasFragments = [];
  const aliasMap = {}; // alias → pagePath

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const alias = toAlias(pagePath, i);
    aliasMap[alias] = pagePath;
    const term = `${REACTIONS_PREFIX}${pagePath}`;
    // Escape double quotes in search query for inline GraphQL
    const searchQuery = `"${term}" in:title repo:${repo} is:discussion`.replace(
      /\\/g,
      "\\\\"
    ).replace(/"/g, '\\"');
    aliasFragments.push(
      `${alias}: search(query: "${searchQuery}", type: DISCUSSION, first: 5) {
        nodes {
          ... on Discussion {
            id
            number
            title
            locked
            comments(first: 100) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                body
              }
            }
          }
        }
      }`
    );
  }

  const query = `query { ${aliasFragments.join("\n")} }`;

  if (!checkRateLimit(log)) return null;

  const result = await graphqlRequest(pat, query);

  if (result.errors) {
    log.error(
      `[masonry-reactions] Batch search error: ${JSON.stringify(result.errors)}`
    );
    return null;
  }

  for (const [alias, pagePath] of Object.entries(aliasMap)) {
    const searchResult = result.data?.[alias];
    if (!searchResult?.nodes) {
      results[pagePath] = null;
      continue;
    }

    const term = `${REACTIONS_PREFIX}${pagePath}`;
    const found = searchResult.nodes.find((n) => n.title === term);
    results[pagePath] = found || null;
  }

  return results;
}

/**
 * If a discussion has >100 comments, fetch remaining pages.
 * Returns all comment nodes.
 */
async function fetchAllComments(
  pat,
  repoOwner,
  repoName,
  discussionNumber,
  existingNodes,
  pageInfo,
  log
) {
  const allNodes = [...existingNodes];
  let cursor = pageInfo.endCursor;
  let hasNext = pageInfo.hasNextPage;

  while (hasNext) {
    if (!checkRateLimit(log)) break;

    const query = `
      query($owner: String!, $name: String!, $number: Int!, $after: String!) {
        repository(owner: $owner, name: $name) {
          discussion(number: $number) {
            comments(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                body
              }
            }
          }
        }
      }
    `;

    const result = await graphqlRequest(pat, query, {
      owner: repoOwner,
      name: repoName,
      number: discussionNumber,
      after: cursor,
    });

    if (result.errors) {
      log.error(
        `[masonry-reactions] Error fetching comments page: ${JSON.stringify(
          result.errors
        )}`
      );
      break;
    }

    const comments = result.data?.repository?.discussion?.comments;
    if (!comments) break;

    allNodes.push(...(comments.nodes || []));
    cursor = comments.pageInfo.endCursor;
    hasNext = comments.pageInfo.hasNextPage;
  }

  return allNodes;
}

/* ==================== Batch Discussion Creation ==================== */

/**
 * Batch-create multiple discussions in a single mutation using aliases.
 * Returns: { [pagePath]: { id, number, title } | null }
 */
async function batchCreateDiscussions(
  pat,
  repositoryId,
  categoryId,
  pagePaths,
  log
) {
  if (pagePaths.length === 0) return {};
  if (!checkRateLimit(log)) return null;

  const results = {};
  const aliasFragments = [];
  const aliasMap = {};

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i];
    const alias = `create_${i}`;
    aliasMap[alias] = pagePath;
    const term = `${REACTIONS_PREFIX}${pagePath}`;
    const body = `This discussion is auto-generated for tracking photo reactions on the masonry page: \`${pagePath}\`\n\n⚠️ Please do not delete or modify this discussion. Comments here are mapped to individual photos.\n\n---\n*Generated by hexo-masonry-reactions*`;

    aliasFragments.push(
      `${alias}: createDiscussion(input: {
        repositoryId: "${repositoryId}",
        categoryId: "${categoryId}",
        title: "${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",
        body: "${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
      }) {
        discussion {
          id
          number
          title
        }
      }`
    );
  }

  const query = `mutation { ${aliasFragments.join("\n")} }`;
  const result = await graphqlRequest(pat, query);

  if (result.errors) {
    log.error(
      `[masonry-reactions] Batch discussion creation error: ${JSON.stringify(
        result.errors
      )}`
    );
    return null;
  }

  for (const [alias, pagePath] of Object.entries(aliasMap)) {
    const discussion = result.data?.[alias]?.discussion;
    if (discussion) {
      results[pagePath] = discussion;
      log.info(
        `[masonry-reactions] Created discussion #${discussion.number} for: ${pagePath}`
      );
    } else {
      results[pagePath] = null;
      log.warn(
        `[masonry-reactions] Failed to create discussion for: ${pagePath}`
      );
    }
  }

  return results;
}

/* ==================== Batch Comment Creation ==================== */

/**
 * Batch-add comments for images using GraphQL aliases.
 * Processes in chunks of BATCH_COMMENT_SIZE to stay within limits.
 * Returns: { [imageId]: commentId }
 */
async function batchAddComments(pat, discussionId, images, log) {
  if (images.length === 0) return {};

  const allResults = {};

  // Process in chunks
  for (let start = 0; start < images.length; start += BATCH_COMMENT_SIZE) {
    const chunk = images.slice(start, start + BATCH_COMMENT_SIZE);

    if (!checkRateLimit(log)) return null;

    const aliasFragments = [];
    const aliasMap = {};

    for (let i = 0; i < chunk.length; i++) {
      const img = chunk[i];
      const alias = `comment_${i}`;
      aliasMap[alias] = img.image;
      const title = (img.title || img.image)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      const imageId = img.image
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      const body = `<!-- masonry-image-id: ${imageId} -->\\n📷 **${title}**`;

      aliasFragments.push(
        `${alias}: addDiscussionComment(input: {
          discussionId: "${discussionId}",
          body: "${body}"
        }) {
          comment {
            id
          }
        }`
      );
    }

    const query = `mutation { ${aliasFragments.join("\n")} }`;
    const result = await graphqlRequest(pat, query);

    if (result.errors) {
      log.error(
        `[masonry-reactions] Batch comment creation error: ${JSON.stringify(
          result.errors
        )}`
      );
      return null;
    }

    for (const [alias, imageId] of Object.entries(aliasMap)) {
      const comment = result.data?.[alias]?.comment;
      if (comment) {
        allResults[imageId] = comment.id;
      } else {
        log.warn(
          `[masonry-reactions] Failed to create comment for image: ${imageId}`
        );
      }
    }

    log.info(
      `[masonry-reactions] Created ${
        Object.keys(aliasMap).length
      } comments (batch ${Math.floor(start / BATCH_COMMENT_SIZE) + 1})`
    );
  }

  return allResults;
}

/* ==================== Lock/Unlock ==================== */

async function unlockDiscussion(pat, lockableId, log) {
  if (!checkRateLimit(log)) return;
  const query = `
    mutation($input: UnlockLockableInput!) {
      unlockLockable(input: $input) {
        unlockedRecord { locked }
      }
    }
  `;
  await graphqlRequest(pat, query, { input: { lockableId } });
}

/**
 * Batch lock multiple discussions in a single mutation
 */
async function batchLockDiscussions(pat, discussionIds, log) {
  if (discussionIds.length === 0) return;
  if (!checkRateLimit(log)) return;

  const aliasFragments = discussionIds.map(
    (id, i) =>
      `lock_${i}: lockLockable(input: { lockableId: "${id}" }) {
      lockedRecord { locked }
    }`
  );

  const query = `mutation { ${aliasFragments.join("\n")} }`;
  const result = await graphqlRequest(pat, query);

  if (result.errors) {
    log.warn(
      `[masonry-reactions] Batch lock warning: ${JSON.stringify(result.errors)}`
    );
  }
}

/* ==================== Helpers ==================== */

function parseImageId(commentBody) {
  if (!commentBody) return null;
  const match = commentBody.match(/<!-- masonry-image-id: (.+?) -->/);
  return match ? match[1].trim() : null;
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
    hexo.log.info(
      "[masonry-reactions] Skipping: missing giscus config (repo, repo_id, category_id, or author_pat)"
    );
    return;
  }

  if (!commentEnabled) {
    hexo.log.info("[masonry-reactions] Skipping: comments are disabled");
    return;
  }

  // Load masonry data
  const data = hexo.locals.get("data");
  const masonryData = data?.masonry;
  if (!masonryData) {
    hexo.log.info("[masonry-reactions] Skipping: no masonry data found");
    return;
  }

  const [repoOwner, repoName] = repo.split("/");
  const categories = masonryData.filter((item) => item.links_category);
  const allReactions = {};

  hexo.log.info("[masonry-reactions] Processing masonry page reactions...");

  // ── Step 1: Collect all page paths and their images ──
  const pageMap = new Map(); // pagePath → { images, item }
  for (const category of categories) {
    for (const item of category.list || []) {
      if (!item.images || item.images.length === 0) continue;
      const pageTitle = item["page-title"] || item.name;
      const pagePath = `masonry/${pageTitle}/`;
      pageMap.set(pagePath, { images: item.images, item });
    }
  }

  if (pageMap.size === 0) {
    hexo.log.info("[masonry-reactions] No masonry pages with images found.");
    return;
  }

  const allPagePaths = Array.from(pageMap.keys());
  hexo.log.info(
    `[masonry-reactions] Found ${allPagePaths.length} masonry pages to process.`
  );

  // ── Step 2: Batch-search for existing discussions ──
  const existingDiscussions = await batchFindDiscussions(
    pat,
    repo,
    allPagePaths,
    hexo.log
  );
  if (existingDiscussions === null) {
    hexo.log.error(
      "[masonry-reactions] Aborting: batch search failed (rate limit or error)."
    );
    return;
  }

  if (rateLimitRemaining !== null) {
    hexo.log.info(
      `[masonry-reactions] Rate limit remaining: ${rateLimitRemaining}`
    );
  }

  // ── Step 3: Create missing discussions ──
  const missingPaths = allPagePaths.filter((p) => !existingDiscussions[p]);
  let createdDiscussions = {};

  if (missingPaths.length > 0) {
    hexo.log.info(
      `[masonry-reactions] Creating ${missingPaths.length} new discussions...`
    );
    createdDiscussions = await batchCreateDiscussions(
      pat,
      repositoryId,
      categoryId,
      missingPaths,
      hexo.log
    );
    if (createdDiscussions === null) {
      hexo.log.error(
        "[masonry-reactions] Aborting: discussion creation failed (rate limit or error)."
      );
      return;
    }
  }

  // ── Step 4: For each page, find missing comments and batch-create them ──
  const discussionsToLock = []; // discussion IDs that need locking

  for (const pagePath of allPagePaths) {
    const { images } = pageMap.get(pagePath);
    let discussion = existingDiscussions[pagePath];

    // If newly created, build a minimal discussion object
    if (!discussion && createdDiscussions[pagePath]) {
      discussion = {
        ...createdDiscussions[pagePath],
        locked: false,
        comments: {
          totalCount: 0,
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      };
    }

    if (!discussion) {
      hexo.log.warn(
        `[masonry-reactions] No discussion for ${pagePath}, skipping.`
      );
      continue;
    }

    // Fetch all comments if paginated (>100)
    let allCommentNodes = discussion.comments?.nodes || [];
    if (discussion.comments?.pageInfo?.hasNextPage) {
      hexo.log.info(
        `[masonry-reactions] ${pagePath}: fetching additional comment pages...`
      );
      allCommentNodes = await fetchAllComments(
        pat,
        repoOwner,
        repoName,
        discussion.number,
        allCommentNodes,
        discussion.comments.pageInfo,
        hexo.log
      );
    }

    // Parse existing comments → imageId mapping
    const imageCommentMap = {};
    const existingImageIds = new Set();

    for (const comment of allCommentNodes) {
      const imageId = parseImageId(comment.body);
      if (imageId) {
        existingImageIds.add(imageId);
        imageCommentMap[imageId] = comment.id;
      }
    }

    // Find images that need new comments
    const newImages = images.filter((img) => !existingImageIds.has(img.image));

    if (newImages.length > 0) {
      hexo.log.info(
        `[masonry-reactions] ${pagePath}: creating ${newImages.length} new comments...`
      );

      // Unlock if locked
      if (discussion.locked) {
        await unlockDiscussion(pat, discussion.id, hexo.log);
      }

      const newCommentIds = await batchAddComments(
        pat,
        discussion.id,
        newImages,
        hexo.log
      );
      if (newCommentIds === null) {
        hexo.log.error(
          `[masonry-reactions] Failed to create comments for ${pagePath}`
        );
      } else {
        for (const [imageId, commentId] of Object.entries(newCommentIds)) {
          imageCommentMap[imageId] = commentId;
        }
      }

      // Need to lock after adding comments
      discussionsToLock.push(discussion.id);
    } else if (!discussion.locked) {
      // No new comments but not locked
      discussionsToLock.push(discussion.id);
    }

    // Store results - NO heartCount, client fetches live data
    allReactions[pagePath] = {
      discussionNumber: discussion.number,
      imageCommentMap, // { imageId: commentId }
    };

    hexo.log.info(
      `[masonry-reactions] ${pagePath}: ${
        Object.keys(imageCommentMap).length
      } images tracked`
    );
  }

  // ── Step 5: Batch-lock all discussions that need locking ──
  if (discussionsToLock.length > 0) {
    hexo.log.info(
      `[masonry-reactions] Locking ${discussionsToLock.length} discussions...`
    );
    await batchLockDiscussions(pat, discussionsToLock, hexo.log);
  }

  // Store for the masonry generator to pick up
  hexo._masonryReactions = allReactions;

  if (rateLimitRemaining !== null) {
    hexo.log.info(
      `[masonry-reactions] Done. ${
        Object.keys(allReactions).length
      } pages processed. Rate limit remaining: ${rateLimitRemaining}`
    );
  } else {
    hexo.log.info(
      `[masonry-reactions] Done. ${
        Object.keys(allReactions).length
      } pages processed.`
    );
  }
});
