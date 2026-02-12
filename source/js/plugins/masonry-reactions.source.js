/**
 * Masonry Reactions - Giscus Client Extension
 *
 * A standalone companion to the giscus comment system that adds per-photo
 * heart reactions on masonry gallery pages.
 *
 * Architecture:
 * - Fetches reaction data from giscus.app/api/discussions (unauthenticated).
 *   This uses giscus's own GitHub App token — no user rate-limit consumption.
 *   The request NEVER sends an Authorization header to giscus.app (CORS issue).
 * - For logged-in users, fetches viewerHasReacted via GitHub GraphQL API
 *   (GitHub's API properly supports CORS with Authorization headers).
 * - Toggling reactions uses GitHub GraphQL with the user's OAuth token.
 * - OAuth token synced with main giscus-client (shared localStorage key).
 * - Clicking the heart button when not logged in → redirect to GitHub OAuth.
 * - Swup-compatible: registers page:view hook AFTER swup is initialized.
 * - sessionStorage caching to avoid redundant API calls during navigation.
 * - Pagination: fetches all comments (100/page) with minimum requests.
 */
(function () {
    "use strict";
    const GISCUS_SESSION_KEY = "giscus-session";
    const GISCUS_ORIGIN = "https://giscus.app";
    const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
    const CACHE_KEY_PREFIX = "masonry-reactions-cache:";
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    /* ==================== State ==================== */
    let currentPagePath = "";
    let imageReactions = {};
    let userToken = null;
    let isAuthenticated = false;
    let isInitialized = false;
    let swupHooked = false;
    /* ==================== Config ==================== */
    /**
     * Read config from page data attribute embedded by masonry.ejs.
     * Only present on masonry pages with reactions enabled.
     */
    function getPageConfig() {
        const el = document.getElementById("masonry-reactions-data");
        if (!el)
            return null;
        try {
            return JSON.parse(el.textContent || "");
        }
        catch {
            return null;
        }
    }
    /* ==================== Token Management ==================== */
    /**
     * Exchange giscus session for a GitHub OAuth token.
     * Uses x-www-form-urlencoded → "simple" CORS request (no preflight).
     */
    async function getGiscusToken() {
        const raw = localStorage.getItem(GISCUS_SESSION_KEY);
        if (!raw)
            return null;
        let session;
        try {
            session = JSON.parse(raw);
        }
        catch {
            return null;
        }
        if (!session)
            return null;
        try {
            const res = await fetch(`${GISCUS_ORIGIN}/api/oauth/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `session=${encodeURIComponent(session)}`,
            });
            if (!res.ok)
                return null;
            const data = await res.json();
            return data.token || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Build the GitHub OAuth login URL (same as giscus uses).
     */
    function getGiscusLoginUrl() {
        const redirectUri = encodeURIComponent(location.href);
        return `${GISCUS_ORIGIN}/api/oauth/authorize?redirect_uri=${redirectUri}`;
    }
    /* ==================== Giscus API (Unauthenticated) ==================== */
    /**
     * Fetch discussion data from giscus.app API.
     *
     * IMPORTANT: This request NEVER includes an Authorization header.
     * giscus.app's CORS only sets Access-Control-Allow-Origin but does NOT
     * include "authorization" in Access-Control-Allow-Headers. Sending auth
     * would trigger a CORS preflight that gets blocked.
     *
     * giscus.app uses its own GitHub App token for unauthenticated requests,
     * so visitors don't burn their personal GitHub API rate limit.
     */
    async function fetchFromGiscusAPI(repo, term, category, first = 100, after) {
        const params = new URLSearchParams({
            repo,
            term,
            category,
            number: "0",
            strict: "false",
            first: String(first),
        });
        if (after)
            params.set("after", after);
        try {
            // Simple GET — no custom headers — no CORS preflight
            const res = await fetch(`${GISCUS_ORIGIN}/api/discussions?${params}`);
            if (!res.ok) {
                if (res.status === 404)
                    return null;
                console.warn("[masonry-reactions] Giscus API error:", res.status);
                return null;
            }
            return await res.json();
        }
        catch (err) {
            console.warn("[masonry-reactions] Giscus API fetch error:", err);
            return null;
        }
    }
    /**
     * Fetch ALL comments from a masonry-reactions discussion.
     * Uses giscus.app API with pagination (100 comments per request).
     * Returns the adapted giscus comments (bodyHTML, reactions, etc).
     */
    async function fetchAllComments(repo, term, category) {
        const firstPage = await fetchFromGiscusAPI(repo, term, category, 100);
        if (!firstPage?.discussion)
            return null;
        const allComments = [...(firstPage.discussion.comments || [])];
        let pageInfo = firstPage.discussion.pageInfo;
        // Paginate if there are more than 100 comments
        while (pageInfo?.hasNextPage && pageInfo.endCursor) {
            const nextPage = await fetchFromGiscusAPI(repo, term, category, 100, pageInfo.endCursor);
            if (!nextPage?.discussion)
                break;
            allComments.push(...(nextPage.discussion.comments || []));
            pageInfo = nextPage.discussion.pageInfo;
        }
        return allComments;
    }
    /* ==================== GitHub GraphQL (Auth Only) ==================== */
    /**
     * Batch-check viewerHasReacted for multiple comments via GitHub GraphQL.
     * GitHub's API properly supports CORS with Authorization headers.
     * Batches in groups of 50 to avoid query complexity limits.
     */
    async function checkViewerReactions(commentIds, token) {
        if (commentIds.length === 0)
            return {};
        const BATCH = 50;
        const result = {};
        for (let i = 0; i < commentIds.length; i += BATCH) {
            const batch = commentIds.slice(i, i + BATCH);
            const aliases = batch
                .map((id, j) => `c${j}: node(id: "${id}") { ... on DiscussionComment { id reactionGroups { content viewerHasReacted } } }`)
                .join("\n");
            try {
                const res = await fetch(GITHUB_GRAPHQL_API, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ query: `query { ${aliases} }` }),
                });
                if (!res.ok)
                    continue;
                const data = await res.json();
                if (data.errors)
                    continue;
                for (let j = 0; j < batch.length; j++) {
                    const node = data.data?.[`c${j}`];
                    if (node?.reactionGroups) {
                        const heart = node.reactionGroups.find((g) => g.content === "HEART");
                        result[batch[j]] = heart?.viewerHasReacted || false;
                    }
                }
            }
            catch {
                /* continue with remaining batches */
            }
        }
        return result;
    }
    /**
     * Toggle HEART reaction on a comment via GitHub GraphQL.
     * Requires user's OAuth token (authenticated only).
     */
    async function toggleHeartReaction(token, commentId, hasReacted) {
        const mode = hasReacted ? "remove" : "add";
        try {
            const res = await fetch(GITHUB_GRAPHQL_API, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `mutation($content: ReactionContent!, $subjectId: ID!) {
            toggleReaction: ${mode}Reaction(input: {content: $content, subjectId: $subjectId}) {
              reaction { content }
            }
          }`,
                    variables: { content: "HEART", subjectId: commentId },
                }),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    /* ==================== Parsing ==================== */
    /**
     * Parse image ID from giscus-adapted bodyHTML.
     * The build script adds a visible code tag: `masonry-image:IMAGE_ID`
     * which GitHub renders as <code>masonry-image:IMAGE_ID</code>.
     * HTML comments (<!-- -->) are stripped by GitHub's markdown renderer.
     */
    function parseImageId(bodyHTML) {
        if (!bodyHTML)
            return null;
        const match = bodyHTML.match(/<code[^>]*>masonry-image:(.+?)<\/code>/);
        return match ? match[1].trim() : null;
    }
    /* ==================== Cache ==================== */
    function getCacheKey(term) {
        return `${CACHE_KEY_PREFIX}${term}`;
    }
    function getCache(term) {
        try {
            const raw = sessionStorage.getItem(getCacheKey(term));
            if (!raw)
                return null;
            const cached = JSON.parse(raw);
            if (Date.now() - cached.timestamp > CACHE_TTL) {
                sessionStorage.removeItem(getCacheKey(term));
                return null;
            }
            return cached;
        }
        catch {
            return null;
        }
    }
    function setCache(term, data) {
        try {
            sessionStorage.setItem(getCacheKey(term), JSON.stringify(data));
        }
        catch { }
    }
    function clearCache(term) {
        try {
            sessionStorage.removeItem(getCacheKey(term));
        }
        catch { }
    }
    /* ==================== UI ==================== */
    /**
     * Create heart button element for a masonry image.
     * The button is always clickable — for unauthenticated users,
     * clicking it redirects to GitHub OAuth (acts as a login button).
     */
    function createHeartButton(imageId) {
        const btn = document.createElement("button");
        btn.className = "masonry-heart-btn";
        btn.dataset.imageId = imageId;
        btn.setAttribute("aria-label", "Like this photo");
        btn.innerHTML = `
      <span class="heart-icon">
        <i class="fa-regular fa-heart heart-outline"></i>
        <i class="fa-solid fa-heart heart-filled"></i>
      </span>
      <span class="heart-count">0</span>
    `;
        btn.addEventListener("click", handleHeartClick);
        return btn;
    }
    /**
     * Initialize heart buttons on all masonry items.
     * Matches DOM images to imageIds from page config.
     */
    function initializeHeartButtons(imageIds) {
        const items = document.querySelectorAll(".masonry-item .image-container");
        const imageIdSet = new Set(imageIds);
        items.forEach((container) => {
            // Skip if already has a heart button
            if (container.querySelector(".masonry-heart-btn"))
                return;
            // Find image src from preloader or img element
            let src = "";
            const preloader = container.querySelector(".img-preloader");
            if (preloader) {
                src = preloader.getAttribute("data-src") || "";
            }
            if (!src) {
                const img = container.querySelector("img");
                if (img) {
                    src =
                        img.getAttribute("data-src") || img.getAttribute("src") || "";
                }
            }
            if (!src)
                return;
            const imageId = findImageIdFromSrc(src, imageIdSet);
            if (!imageId)
                return;
            container.dataset.imageId = imageId;
            if (!container.classList.contains("masonry-reactions-mode")) {
                container.classList.add("masonry-reactions-mode");
            }
            container.appendChild(createHeartButton(imageId));
        });
    }
    /**
     * Match img src to an imageId.
     * Strips file extensions before comparing (handles .jpeg→.avif conversion).
     */
    function findImageIdFromSrc(src, imageIdSet) {
        if (!src)
            return null;
        const cleanSrc = decodeURIComponent(src.split("#")[0].split("?")[0]);
        const srcBase = cleanSrc.replace(/\.[^.\/]+$/, "");
        for (const imageId of imageIdSet) {
            const idBase = imageId.replace(/\.[^.\/]+$/, "");
            if (srcBase.includes(idBase) || srcBase.endsWith(idBase)) {
                return imageId;
            }
        }
        return null;
    }
    /**
     * Update heart button UI for a specific image
     */
    function updateHeartButton(imageId, heartCount, viewerHasReacted) {
        const btn = document.querySelector(`.masonry-heart-btn[data-image-id="${CSS.escape(imageId)}"]`);
        if (!btn)
            return;
        const countEl = btn.querySelector(".heart-count");
        if (countEl)
            countEl.textContent = String(heartCount);
        btn.dataset.reacted = viewerHasReacted ? "true" : "false";
        btn.classList.toggle("is-reacted", viewerHasReacted);
        btn.classList.toggle("has-count", heartCount > 0);
    }
    /**
     * Apply fetched reaction data from giscus API to all heart buttons.
     * The giscus API returns adapted comments with bodyHTML and reactions map.
     */
    function applyReactions(comments) {
        imageReactions = {};
        for (const comment of comments) {
            const imageId = parseImageId(comment.bodyHTML);
            if (!imageId)
                continue;
            // Giscus adapted format: reactions.HEART.count / .viewerHasReacted
            const heartCount = comment.reactions?.HEART?.count || 0;
            // viewerHasReacted from unauthenticated giscus API is always false
            const viewerHasReacted = comment.reactions?.HEART?.viewerHasReacted || false;
            imageReactions[imageId] = {
                commentId: comment.id,
                heartCount,
                viewerHasReacted,
            };
            updateHeartButton(imageId, heartCount, viewerHasReacted);
        }
    }
    /**
     * Apply cached data to heart buttons
     */
    function applyCachedReactions(cached) {
        imageReactions = { ...cached.imageReactions };
        for (const [imageId, data] of Object.entries(imageReactions)) {
            updateHeartButton(imageId, data.heartCount, data.viewerHasReacted);
        }
    }
    /**
     * Handle heart button click.
     * - Not logged in → redirect to GitHub OAuth (acts as login button).
     * - Logged in → toggle HEART reaction via GitHub GraphQL.
     */
    async function handleHeartClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.classList.contains("is-loading"))
            return;
        // Not authenticated? Redirect to GitHub OAuth
        if (!isAuthenticated || !userToken) {
            window.location.href = getGiscusLoginUrl();
            return;
        }
        const imageId = btn.dataset.imageId;
        const reaction = imageReactions[imageId];
        if (!reaction)
            return;
        const currentlyReacted = reaction.viewerHasReacted;
        const currentCount = reaction.heartCount;
        // Optimistic UI update
        btn.classList.add("is-loading");
        const newCount = currentlyReacted
            ? Math.max(0, currentCount - 1)
            : currentCount + 1;
        const newReacted = !currentlyReacted;
        reaction.heartCount = newCount;
        reaction.viewerHasReacted = newReacted;
        updateHeartButton(imageId, newCount, newReacted);
        // Toggle reaction via GitHub GraphQL
        const success = await toggleHeartReaction(userToken, reaction.commentId, currentlyReacted);
        btn.classList.remove("is-loading");
        if (success) {
            // Invalidate cache
            const config = getPageConfig();
            if (config)
                clearCache(config.discussionTerm);
        }
        else {
            // Revert on failure
            reaction.heartCount = currentCount;
            reaction.viewerHasReacted = currentlyReacted;
            updateHeartButton(imageId, currentCount, currentlyReacted);
        }
    }
    /* ==================== Init / Lifecycle ==================== */
    /**
     * Main initialization: create buttons, fetch data, apply reactions.
     * Only activates on pages with masonry-reactions-data element.
     */
    async function init() {
        const config = getPageConfig();
        if (!config)
            return;
        const newPagePath = config.discussionTerm;
        // Skip if already initialized for this exact page
        if (isInitialized && currentPagePath === newPagePath)
            return;
        currentPagePath = newPagePath;
        isInitialized = true;
        // 1. Create heart buttons from the image list
        initializeHeartButtons(config.imageIds);
        // 2. Try to get auth token (synced with giscus-client)
        try {
            userToken = await getGiscusToken();
            isAuthenticated = !!userToken;
        }
        catch {
            userToken = null;
            isAuthenticated = false;
        }
        // 3. Check cache first
        const cached = getCache(config.discussionTerm);
        if (cached) {
            applyCachedReactions(cached);
            // If authenticated, refresh in background for viewerHasReacted accuracy
            if (isAuthenticated) {
                fetchAndApplyLive(config);
            }
            return;
        }
        // 4. Fetch live data
        await fetchAndApplyLive(config);
    }
    /**
     * Fetch live data and apply to UI + cache.
     *
     * Two-phase approach:
     * 1. Fetch from giscus.app WITHOUT auth → comment IDs + heart counts
     * 2. If authenticated, batch-check viewerHasReacted via GitHub GraphQL
     */
    async function fetchAndApplyLive(config) {
        try {
            // Phase 1: Fetch from giscus.app (unauthenticated, no CORS issues)
            const comments = await fetchAllComments(config.repo, config.discussionTerm, config.category);
            if (!comments)
                return;
            // Apply reaction counts (viewerHasReacted is false from unauth giscus)
            applyReactions(comments);
            // Phase 2: If authenticated, check viewerHasReacted via GitHub GraphQL
            if (isAuthenticated && userToken) {
                const commentIds = Object.values(imageReactions)
                    .map((r) => r.commentId)
                    .filter(Boolean);
                if (commentIds.length > 0) {
                    const viewerReactions = await checkViewerReactions(commentIds, userToken);
                    for (const [imageId, data] of Object.entries(imageReactions)) {
                        if (viewerReactions[data.commentId]) {
                            data.viewerHasReacted = true;
                            updateHeartButton(imageId, data.heartCount, true);
                        }
                    }
                }
            }
            // Cache results
            setCache(config.discussionTerm, {
                timestamp: Date.now(),
                imageReactions: { ...imageReactions },
            });
        }
        catch (err) {
            console.warn("[masonry-reactions] Failed to fetch live data:", err);
        }
    }
    /**
     * Cleanup when leaving a masonry page (swup navigation)
     */
    function cleanup() {
        isInitialized = false;
        currentPagePath = "";
        imageReactions = {};
    }
    /**
     * Re-initialize after swup page transition.
     * Called on every page:view event; only activates on masonry pages.
     */
    function onPageView() {
        cleanup();
        // Small delay to ensure DOM is ready after swup transition
        requestAnimationFrame(() => {
            init();
        });
    }
    /* ==================== Swup Registration ==================== */
    /**
     * Register the page:view hook with Swup.
     *
     * Swup is initialized in swup.ejs which loads AFTER scripts.ejs.
     * So swup is NOT available when this script first runs.
     * We use a deferred approach: try immediately, retry on DOMContentLoaded,
     * and as final fallback poll briefly for swup availability.
     */
    function tryRegisterSwup() {
        if (swupHooked)
            return true;
        try {
            // swup.ejs uses `const swup = new Swup(...)` which creates a
            // global lexical binding, NOT a window property. We must access
            // it directly via `eval` to reach the lexical scope.
            const s = eval("typeof swup !== 'undefined' ? swup : null");
            if (s && s.hooks) {
                s.hooks.on("page:view", onPageView);
                swupHooked = true;
                return true;
            }
        }
        catch { }
        return false;
    }
    /* ==================== OAuth Sync with Giscus ==================== */
    /**
     * Listen for giscus session changes from other scripts/tabs.
     */
    window.addEventListener("storage", (e) => {
        if (e.key !== GISCUS_SESSION_KEY)
            return;
        if (e.newValue) {
            // User logged in
            getGiscusToken().then((token) => {
                if (token) {
                    userToken = token;
                    isAuthenticated = true;
                    const config = getPageConfig();
                    if (config) {
                        clearCache(config.discussionTerm);
                        fetchAndApplyLive(config);
                    }
                }
            });
        }
        else {
            // User logged out
            userToken = null;
            isAuthenticated = false;
            for (const [imageId, data] of Object.entries(imageReactions)) {
                data.viewerHasReacted = false;
                updateHeartButton(imageId, data.heartCount, false);
            }
            const config = getPageConfig();
            if (config)
                clearCache(config.discussionTerm);
        }
    });
    /**
     * Listen for giscus iframe sign-out messages.
     */
    window.addEventListener("message", (event) => {
        if (event.origin !== GISCUS_ORIGIN)
            return;
        const { data } = event;
        if (typeof data !== "object" || !data.giscus)
            return;
        if (data.giscus.signOut) {
            userToken = null;
            isAuthenticated = false;
            for (const [imageId, reaction] of Object.entries(imageReactions)) {
                reaction.viewerHasReacted = false;
                updateHeartButton(imageId, reaction.heartCount, false);
            }
            const config = getPageConfig();
            if (config)
                clearCache(config.discussionTerm);
        }
    });
    /* ==================== Boot ==================== */
    // Try registering Swup now (unlikely to succeed since swup.ejs loads later)
    tryRegisterSwup();
    if (document.readyState === "loading") {
        // Page still loading — wait for DOMContentLoaded
        document.addEventListener("DOMContentLoaded", () => {
            tryRegisterSwup();
            init();
        });
    }
    else {
        // Page already loaded — init immediately
        // But swup might still not be ready (if this script loaded early)
        // Try registering swup and init
        tryRegisterSwup();
        init();
    }
    // Final fallback: poll for swup availability for up to 3 seconds
    // This covers the case where swup initializes after our script
    if (!swupHooked) {
        let attempts = 0;
        const pollInterval = setInterval(() => {
            if (tryRegisterSwup() || ++attempts >= 30) {
                clearInterval(pollInterval);
            }
        }, 100);
    }
})();
