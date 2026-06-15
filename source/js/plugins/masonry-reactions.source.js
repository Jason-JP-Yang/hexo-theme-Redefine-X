/**
 * Masonry Reactions - Giscus Client Extension
 *
 * A standalone companion to the giscus comment system that adds per-photo
 * heart reactions on masonry gallery pages.
 *
 * Architecture:
 * - Fetches reaction data from giscus.app/api/discussions via CORS proxy.
 *   giscus.app blocks cross-origin API requests (CORS whitelist: giscus.app only).
 *   A Cloudflare Worker proxy forwards requests with proper CORS headers.
 *   This uses giscus's own GitHub App token — no user rate-limit consumption.
 * - For logged-in users, fetches viewerHasReacted via GitHub GraphQL API
 *   (GitHub's API properly supports CORS with Authorization headers).
 * - Toggling reactions uses GitHub GraphQL with the user's OAuth token.
 * - Identity (GitHub OAuth token, login URL, session sync) is delegated to the
 *   shared window.blogAuth component (source/js/tools/auth.js). This script
 *   only reacts to its "blog:auth-change" event — no duplicated token/session
 *   logic. blogAuth loads first (classic script) and handles the ?giscus= OAuth
 *   callback, so window.blogAuth.getToken() is ready when init() runs.
 * - Clicking the heart button when not logged in → redirect to GitHub OAuth.
 *   Scroll position and the clicked heart are saved; after login callback,
 *   scroll is restored and the pending heart is auto-clicked.
 * - Swup-compatible: registers page:view hook AFTER swup is initialized.
 * - sessionStorage caching to avoid redundant API calls during navigation.
 * - Pagination: fetches all comments (100/page) with minimum requests.
 *
 * Build Steps (from project root):
 *   cd dev/giscus
 *   npx tsc -p tsconfig.client.json
 *   npx terser build-client/masonry-reactions-client.js -o build-client/masonry-reactions-client.min.js --compress --mangle
 *   copy build-client\masonry-reactions-client.min.js ..\..\themes\redefine-x\source\js\plugins\masonry-reactions.js
 *   copy build-client\masonry-reactions-client.js ..\..\themes\redefine-x\source\js\plugins\masonry-reactions.source.js
 *   cd ..\..\themes\redefine-x && npm run build
 */
(function () {
    "use strict";
    const GISCUS_ORIGIN = "https://giscus.app";
    const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
    const CACHE_KEY_PREFIX = "masonry-reactions-cache:";
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    const MASONRY_SCROLL_KEY = "masonry-scroll-position";
    const PENDING_HEART_KEY = "masonry-pending-heart";
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
    /**
     * Get the API base URL for giscus requests.
     * Uses the CORS proxy if configured, otherwise falls back to giscus.app directly.
     * The proxy is needed because giscus.app only allows CORS from giscus.app origin.
     */
    function getGiscusApiBase() {
        const config = getPageConfig();
        return config?.giscusProxy || GISCUS_ORIGIN;
    }
    /* ==================== Token Management ==================== */
    // Token exchange, login URL and OAuth-callback session sync live in the
    // shared window.blogAuth component — see init()/handleHeartClick below.
    /* ==================== Giscus API (via CORS Proxy) ==================== */
    /**
     * Fetch discussion data from giscus.app API via CORS proxy.
     *
     * giscus.app blocks cross-origin requests (only allows giscus.app origin).
     * The CORS proxy (Cloudflare Worker) forwards the request and adds proper
     * Access-Control-Allow-Origin headers for our blog domain.
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
            // Route through CORS proxy to bypass giscus.app's restrictive CORS
            const apiBase = getGiscusApiBase();
            const res = await fetch(`${apiBase}/api/discussions?${params}`);
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
    function parseImageId(body) {
        if (!body)
            return null;
        // Raw markdown code format: `masonry-image:IMAGE_ID`
        let match = body.match(/`masonry-image:(.+?)`/);
        if (match)
            return match[1].trim();
        // HTML comment format: <!-- masonry-image:IMAGE_ID -->
        match = body.match(/<!--\s*masonry-image:(.+?)\s*-->/);
        if (match)
            return match[1].trim();
        // Legacy HTML comment format
        match = body.match(/<!--\s*masonry-image-id:\s*(.+?)\s*-->/);
        if (match)
            return match[1].trim();
        // Legacy visible code tag format
        match = body.match(/<code[^>]*>masonry-image:(.+?)<\/code>/);
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
        const previous = imageReactions;
        imageReactions = {};
        for (const comment of comments) {
            const rawBody = comment.body || comment.bodyHTML || "";
            const imageId = parseImageId(rawBody);
            if (!imageId)
                continue;
            // Giscus adapted format: reactions.HEART.count / .viewerHasReacted
            const heartCount = comment.reactions?.HEART?.count || 0;
            // viewerHasReacted from unauthenticated giscus API is always false
            const viewerHasReacted = comment.reactions?.HEART?.viewerHasReacted || false;
            const preservedViewerHasReacted = previous[imageId]?.viewerHasReacted || viewerHasReacted;
            const existing = imageReactions[imageId];
            if (existing && existing.heartCount >= heartCount) {
                continue;
            }
            imageReactions[imageId] = {
                commentId: comment.id,
                heartCount,
                viewerHasReacted: preservedViewerHasReacted,
            };
            updateHeartButton(imageId, heartCount, preservedViewerHasReacted);
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
        // Not authenticated? Save state and redirect to GitHub OAuth
        if (!isAuthenticated || !userToken) {
            // Save scroll position for restoration after OAuth callback
            sessionStorage.setItem(MASONRY_SCROLL_KEY, String(window.scrollY));
            // Save the clicked heart's imageId to auto-click after login
            const clickedImageId = btn.dataset.imageId;
            if (clickedImageId) {
                sessionStorage.setItem(PENDING_HEART_KEY, clickedImageId);
            }
            if (window.blogAuth)
                window.blogAuth.login();
            else
                window.location.href = `${GISCUS_ORIGIN}/api/oauth/authorize?redirect_uri=${encodeURIComponent(location.href)}`;
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
        // Check for OAuth callback state (scroll + pending heart)
        // Read and remove immediately to prevent re-triggering on subsequent inits
        const pendingHeart = sessionStorage.getItem(PENDING_HEART_KEY);
        if (pendingHeart)
            sessionStorage.removeItem(PENDING_HEART_KEY);
        const savedScroll = sessionStorage.getItem(MASONRY_SCROLL_KEY);
        if (savedScroll)
            sessionStorage.removeItem(MASONRY_SCROLL_KEY);
        // 1. Create heart buttons from the image list
        initializeHeartButtons(config.imageIds);
        // 2. Restore scroll position (saved before OAuth redirect)
        if (savedScroll) {
            const scrollY = parseInt(savedScroll, 10);
            if (!isNaN(scrollY) && scrollY > 0) {
                requestAnimationFrame(() => {
                    window.scrollTo({ top: scrollY, behavior: 'instant' });
                });
            }
        }
        // 3. Try to get auth token (from the shared window.blogAuth component)
        try {
            userToken = window.blogAuth ? await window.blogAuth.getToken() : null;
            isAuthenticated = !!userToken;
        }
        catch {
            userToken = null;
            isAuthenticated = false;
        }
        // 4. Check cache first
        const cached = getCache(config.discussionTerm);
        if (cached) {
            applyCachedReactions(cached);
            // If authenticated, refresh in background for viewerHasReacted accuracy
            if (isAuthenticated) {
                fetchAndApplyLive(config);
            }
            // Auto-click pending heart after reactions are applied
            if (pendingHeart && isAuthenticated) {
                handlePendingHeart(pendingHeart);
            }
            return;
        }
        // 5. Fetch live data
        await fetchAndApplyLive(config);
        // 6. Auto-click pending heart after reactions are applied
        if (pendingHeart && isAuthenticated) {
            handlePendingHeart(pendingHeart);
        }
    }
    /**
     * Auto-click a pending heart button after OAuth callback.
     * Only clicks if the user hasn't already reacted to this image.
     */
    function handlePendingHeart(imageId) {
        setTimeout(() => {
            const btn = document.querySelector(`.masonry-heart-btn[data-image-id="${CSS.escape(imageId)}"]`);
            if (btn && !btn.classList.contains("is-reacted")) {
                btn.click();
            }
        }, 500);
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
    /* ==================== Auth Sync (via window.blogAuth) ==================== */
    /**
     * React to identity changes broadcast by the shared window.blogAuth
     * component (login, logout, cross-tab/iframe sign-out, OAuth callback).
     * blogAuth owns the giscus session/token/sync logic; we only refresh our
     * reaction state to match.
     */
    async function onAuthChange() {
        userToken = window.blogAuth ? await window.blogAuth.getToken() : null;
        isAuthenticated = !!userToken;
        const config = getPageConfig();
        if (config)
            clearCache(config.discussionTerm);
        if (isAuthenticated) {
            if (config)
                fetchAndApplyLive(config);
        }
        else {
            // Logged out — clear the per-viewer "reacted" highlight.
            for (const [imageId, data] of Object.entries(imageReactions)) {
                data.viewerHasReacted = false;
                updateHeartButton(imageId, data.heartCount, false);
            }
        }
    }
    window.addEventListener("blog:auth-change", () => {
        onAuthChange();
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
