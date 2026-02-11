/**
 * Masonry Reactions - Giscus Client Extension
 *
 * A standalone companion to the giscus comment system that adds per-photo
 * heart reactions on masonry gallery pages.
 *
 * Key design decisions:
 * - NO pre-embedded reaction data from build time. All data is fetched live.
 * - Unauthenticated users can view reaction counts (GitHub API allows 60 req/hr).
 * - OAuth token is synced with the main giscus-client (shared localStorage key).
 * - Clicking the heart button when not logged in redirects to GitHub OAuth.
 * - Swup-compatible: re-initializes on page transitions.
 * - sessionStorage caching to avoid redundant API calls during navigation.
 * - Pagination support: fetches all comments even if >100 per discussion.
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
    // Read config from page data attribute
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
     * Exchange giscus session for a GitHub token.
     * Uses x-www-form-urlencoded for a "simple" CORS request (no preflight).
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
     * Build the GitHub OAuth login URL that giscus uses.
     * After auth, GitHub redirects back with ?giscus=<session> parameter
     * which giscus-client.js processes to store the session.
     */
    function getGiscusLoginUrl() {
        // giscus uses its own OAuth app flow
        const redirectUri = encodeURIComponent(location.href);
        return `${GISCUS_ORIGIN}/api/oauth/authorize?redirect_uri=${redirectUri}`;
    }
    /* ==================== GitHub GraphQL API ==================== */
    /**
     * Make a GitHub GraphQL request.
     * If token is null, uses unauthenticated access (60 req/hr per IP).
     */
    async function graphqlFetch(query, variables, token) {
        const headers = {
            "Content-Type": "application/json",
        };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        const res = await fetch(GITHUB_GRAPHQL_API, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) {
            throw new Error(`GraphQL request failed: ${res.status}`);
        }
        return res.json();
    }
    /**
     * Find the reactions discussion by its title term and fetch all comments
     * with HEART reaction counts. Handles pagination (100 comments per page).
     *
     * For authenticated users, includes viewerHasReacted.
     * For unauthenticated users, viewerHasReacted is always false.
     */
    async function fetchDiscussionData(repo, term, token) {
        const [owner, name] = repo.split("/");
        if (!owner || !name)
            return null;
        // First: search for the discussion by title
        const searchQuery = `"${term}" in:title repo:${repo} is:discussion`;
        const result = await graphqlFetch(`query($q: String!) {
        search(query: $q, type: DISCUSSION, first: 5) {
          nodes {
            ... on Discussion {
              id
              number
              title
              comments(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  body
                  reactionGroups {
                    content
                    users { totalCount }
                    viewerHasReacted
                  }
                }
              }
            }
          }
        }
      }`, { q: searchQuery }, token);
        if (result.errors) {
            console.warn("[masonry-reactions] Search error:", result.errors);
            return null;
        }
        const nodes = result.data?.search?.nodes;
        if (!nodes)
            return null;
        const discussion = nodes.find((n) => n.title === term);
        if (!discussion)
            return null;
        // Collect first page of comments
        let allComments = [
            ...(discussion.comments?.nodes || []),
        ];
        // Paginate if needed
        let pageInfo = discussion.comments?.pageInfo;
        while (pageInfo?.hasNextPage) {
            const pageResult = await graphqlFetch(`query($owner: String!, $name: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $name) {
            discussion(number: $number) {
              comments(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  body
                  reactionGroups {
                    content
                    users { totalCount }
                    viewerHasReacted
                  }
                }
              }
            }
          }
        }`, {
                owner,
                name,
                number: discussion.number,
                after: pageInfo.endCursor,
            }, token);
            if (pageResult.errors)
                break;
            const moreComments = pageResult.data?.repository?.discussion?.comments;
            if (!moreComments)
                break;
            allComments.push(...(moreComments.nodes || []));
            pageInfo = moreComments.pageInfo;
        }
        return {
            discussionNumber: discussion.number,
            comments: allComments,
        };
    }
    /**
     * Toggle HEART reaction on a comment via GitHub GraphQL
     */
    async function toggleHeartReaction(token, commentId, hasReacted) {
        const mode = hasReacted ? "remove" : "add";
        const query = `
      mutation($content: ReactionContent!, $subjectId: ID!) {
        toggleReaction: ${mode}Reaction(input: {content: $content, subjectId: $subjectId}) {
          reaction { content }
        }
      }
    `;
        try {
            const res = await fetch(GITHUB_GRAPHQL_API, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    variables: { content: "HEART", subjectId: commentId },
                }),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    /**
     * Parse image ID from comment body
     */
    function parseImageId(body) {
        if (!body)
            return null;
        const match = body.match(/<!-- masonry-image-id: (.+?) -->/);
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
     * Create heart button element for a masonry image
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
     * Uses the imageIds from the page config to determine which images
     * should have heart buttons.
     */
    function initializeHeartButtons(imageIds) {
        const items = document.querySelectorAll(".masonry-item .image-container");
        const imageIdSet = new Set(imageIds);
        items.forEach((container) => {
            // Skip if already has a heart button
            if (container.querySelector(".masonry-heart-btn"))
                return;
            // Try multiple sources for the image path
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
            const heartBtn = createHeartButton(imageId);
            container.appendChild(heartBtn);
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
     * Apply fetched reaction data to all heart buttons
     */
    function applyReactions(comments) {
        // Reset imageReactions
        imageReactions = {};
        for (const comment of comments) {
            const imageId = parseImageId(comment.body);
            if (!imageId)
                continue;
            const heartGroup = comment.reactionGroups?.find((g) => g.content === "HEART");
            const heartCount = heartGroup?.users?.totalCount || 0;
            const viewerHasReacted = heartGroup?.viewerHasReacted || false;
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
     * If not authenticated → redirect to GitHub OAuth.
     * If authenticated → toggle reaction.
     */
    async function handleHeartClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.classList.contains("is-loading"))
            return;
        // Not authenticated? Redirect to GitHub OAuth login
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
        // Optimistic update
        btn.classList.add("is-loading");
        const newCount = currentlyReacted
            ? Math.max(0, currentCount - 1)
            : currentCount + 1;
        const newReacted = !currentlyReacted;
        reaction.heartCount = newCount;
        reaction.viewerHasReacted = newReacted;
        updateHeartButton(imageId, newCount, newReacted);
        // API call
        const success = await toggleHeartReaction(userToken, reaction.commentId, currentlyReacted);
        btn.classList.remove("is-loading");
        if (success) {
            // Update cache
            const config = getPageConfig();
            if (config) {
                clearCache(config.discussionTerm);
            }
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
            if (userToken) {
                isAuthenticated = true;
            }
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
        // 4. Fetch live data (works for both auth and unauth)
        await fetchAndApplyLive(config);
    }
    /**
     * Fetch live data from GitHub and apply to UI + cache
     */
    async function fetchAndApplyLive(config) {
        try {
            const data = await fetchDiscussionData(config.repo, config.discussionTerm, userToken);
            if (!data)
                return;
            applyReactions(data.comments);
            // Cache the results
            setCache(config.discussionTerm, {
                timestamp: Date.now(),
                imageReactions: { ...imageReactions },
                discussionNumber: data.discussionNumber,
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
     * Re-initialize after swup page transition
     */
    function onPageView() {
        cleanup();
        // Small delay to ensure DOM is ready after swup transition
        requestAnimationFrame(() => {
            init();
        });
    }
    /* ==================== OAuth Sync with Giscus ==================== */
    // Listen for giscus session changes from other scripts/tabs
    window.addEventListener("storage", (e) => {
        if (e.key === GISCUS_SESSION_KEY) {
            if (e.newValue) {
                // User logged in (possibly from another tab or giscus iframe)
                getGiscusToken().then((token) => {
                    if (token) {
                        userToken = token;
                        isAuthenticated = true;
                        // Clear cache to re-fetch with viewerHasReacted
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
                // Reset viewerHasReacted on all buttons
                for (const [imageId, data] of Object.entries(imageReactions)) {
                    data.viewerHasReacted = false;
                    updateHeartButton(imageId, data.heartCount, false);
                }
                const config = getPageConfig();
                if (config)
                    clearCache(config.discussionTerm);
            }
        }
    });
    // Listen for giscus iframe sign-out messages
    window.addEventListener("message", (event) => {
        if (event.origin !== GISCUS_ORIGIN)
            return;
        const { data } = event;
        if (typeof data !== "object" || !data.giscus)
            return;
        if (data.giscus.signOut) {
            // Giscus iframe signaled sign-out
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
    // Register with Swup if available
    try {
        if (typeof window.swup !== "undefined") {
            window.swup.hooks.on("page:view", onPageView);
        }
    }
    catch { }
    // Initial load
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    }
    else {
        init();
    }
})();
