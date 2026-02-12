/**
 * Masonry Reactions - Giscus Client Extension
 *
 * This is a standalone companion to the standard giscus client.ts.
 * It is NOT a modification of client.ts, but a separate script that:
 * 1. Reads pre-embedded reaction data from the page
 * 2. Creates heart overlays on masonry images
 * 3. Uses giscus session/token for authenticated reactions
 * 4. Calls GitHub GraphQL API for live data and toggling
 *
 * Build: This file is compiled to JS and copied to the theme's js/plugins/ directory.
 * Usage: Included on masonry pages via the masonry.ejs template.
 *
 * The giscus official service (giscus.app) is used for:
 * - OAuth authentication (session → token exchange)
 * - The normal comments iframe (unchanged)
 *
 * This script handles the reactions system independently.
 */
(function () {
    "use strict";
    const GISCUS_SESSION_KEY = "giscus-session";
    const GISCUS_ORIGIN = "https://giscus.app";
    const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";
    const LOCAL_REACTIONS_KEY = "masonry-reactions-viewer";
    /* ==================== Data ==================== */
    const dataEl = document.getElementById("masonry-reactions-data");
    if (!dataEl)
        return;
    let reactionsData;
    try {
        reactionsData = JSON.parse(dataEl.textContent || "");
    }
    catch (e) {
        console.warn("[masonry-reactions] Failed to parse embedded data:", e);
        return;
    }
    if (!reactionsData || !reactionsData.imageReactions)
        return;
    const { repo, repoId, categoryId, discussionTerm, discussionNumber, imageReactions, } = reactionsData;
    const [repoOwner, repoName] = (repo || "").split("/");
    // Local state tracking which comments the viewer has reacted to
    let viewerReactions = loadViewerReactions();
    let userToken = null;
    let isAuthenticated = false;
    function getLocalStorageKey() {
        return `${LOCAL_REACTIONS_KEY}:${discussionNumber}`;
    }
    function loadViewerReactions() {
        try {
            const data = localStorage.getItem(getLocalStorageKey());
            return data ? JSON.parse(data) : {};
        }
        catch {
            return {};
        }
    }
    function saveViewerReactions() {
        try {
            localStorage.setItem(getLocalStorageKey(), JSON.stringify(viewerReactions));
        }
        catch { }
    }
    /* ==================== Token Management ==================== */
    /**
     * Exchange giscus session for a GitHub token.
     * Uses application/x-www-form-urlencoded to make it a "simple" CORS request
     * (no preflight needed).
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
            if (!res.ok) {
                console.warn("[masonry-reactions] Token exchange failed:", res.status);
                return null;
            }
            const data = await res.json();
            return data.token || null;
        }
        catch (err) {
            console.warn("[masonry-reactions] Token exchange error:", err);
            return null;
        }
    }
    /**
     * Fetch live reaction data from GitHub GraphQL API (includes viewerHasReacted)
     */
    async function fetchLiveReactions(token) {
        if (!repoOwner || !repoName || !discussionNumber)
            return null;
        const query = `
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          discussion(number: $number) {
            comments(first: 100) {
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
                    variables: {
                        owner: repoOwner,
                        name: repoName,
                        number: discussionNumber,
                    },
                }),
            });
            if (!res.ok)
                return null;
            const result = await res.json();
            return result.data?.repository?.discussion?.comments?.nodes || null;
        }
        catch (err) {
            console.warn("[masonry-reactions] Live fetch error:", err);
            return null;
        }
    }
    /**
     * Toggle HEART reaction on a comment via GitHub GraphQL
     */
    async function toggleHeartReaction(token, commentId, hasReacted) {
        const mode = hasReacted ? "remove" : "add";
        const query = `
      mutation($content: ReactionContent!, $subjectId: ID!) {
        toggleReaction: ${mode}Reaction(input: {content: $content, subjectId: $subjectId}) {
          reaction { content, id }
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
        catch (err) {
            console.warn("[masonry-reactions] Toggle reaction error:", err);
            return false;
        }
    }
    /**
     * Parse image ID from comment body
     */
    function parseImageIdFromBody(body) {
        if (!body)
            return null;
        const match = body.match(/<!-- masonry-image-id: (.+?) -->/);
        return match ? match[1].trim() : null;
    }
    /* ==================== UI ==================== */
    /**
     * Create heart button element for a masonry image
     */
    function createHeartButton(imageId) {
        const reaction = imageReactions[imageId];
        if (!reaction)
            return null;
        const btn = document.createElement("button");
        btn.className = "masonry-heart-btn";
        btn.dataset.imageId = imageId;
        btn.dataset.commentId = reaction.commentId;
        btn.dataset.reacted = "false";
        btn.disabled = true;
        btn.setAttribute("aria-label", "Like this photo");
        btn.innerHTML = `
      <span class="heart-icon">
        <i class="fa-regular fa-heart heart-outline"></i>
        <i class="fa-solid fa-heart heart-filled"></i>
      </span>
      <span class="heart-count">${reaction.heartCount || 0}</span>
    `;
        if (reaction.heartCount > 0) {
            btn.classList.add("has-count");
        }
        btn.addEventListener("click", handleHeartClick);
        return btn;
    }
    /**
     * Initialize heart buttons on all masonry items.
     * Handles both regular <img> elements and lazyload-transformed
     * <div class="img-preloader" data-src="..."> elements.
     */
    function initializeHeartButtons() {
        const items = document.querySelectorAll(".masonry-item .image-container");
        items.forEach((container) => {
            // Try multiple sources for the image path:
            // 1. img-preloader div (lazyload transformed) - data-src
            // 2. Regular <img> tag - src attribute
            // 3. img-preloader div - check for child img that may be loaded later
            let src = "";
            const preloader = container.querySelector(".img-preloader");
            if (preloader) {
                src = preloader.getAttribute("data-src") || "";
            }
            if (!src) {
                const img = container.querySelector("img");
                if (img) {
                    src = img.getAttribute("data-src") || img.getAttribute("src") || "";
                }
            }
            if (!src)
                return;
            const imageId = findImageIdFromSrc(src);
            if (!imageId)
                return;
            container.dataset.imageId = imageId;
            const heartBtn = createHeartButton(imageId);
            if (heartBtn) {
                container.appendChild(heartBtn);
            }
        });
    }
    /**
     * Match img src to an imageId in the reactions data.
     * Strips file extensions before comparing because images may have been
     * converted to different formats (e.g. .jpeg → .avif) during build.
     */
    function findImageIdFromSrc(src) {
        if (!src)
            return null;
        const cleanSrc = decodeURIComponent(src.split("#")[0].split("?")[0]);
        // Strip extension for comparison (handles .jpeg → .avif conversion)
        const srcBase = cleanSrc.replace(/\.[^.\/]+$/, "");
        for (const imageId of Object.keys(imageReactions)) {
            const idBase = imageId.replace(/\.[^.\/]+$/, "");
            if (srcBase.includes(idBase) || srcBase.endsWith(idBase)) {
                return imageId;
            }
        }
        return null;
    }
    /**
     * Update heart button UI
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
     * Enable all heart buttons (after authentication confirmed)
     */
    function enableHeartButtons() {
        document.querySelectorAll(".masonry-heart-btn").forEach((btn) => {
            btn.disabled = false;
            btn.classList.add("is-enabled");
        });
    }
    /**
     * Handle heart button click
     */
    async function handleHeartClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.disabled || btn.classList.contains("is-loading"))
            return;
        if (!isAuthenticated || !userToken) {
            showLoginPrompt();
            return;
        }
        const imageId = btn.dataset.imageId;
        const commentId = btn.dataset.commentId;
        const currentlyReacted = btn.dataset.reacted === "true";
        // Optimistic update
        btn.classList.add("is-loading");
        const currentCount = parseInt(btn.querySelector(".heart-count")?.textContent || "0") || 0;
        const newCount = currentlyReacted ? Math.max(0, currentCount - 1) : currentCount + 1;
        const newReacted = !currentlyReacted;
        updateHeartButton(imageId, newCount, newReacted);
        // API call
        const success = await toggleHeartReaction(userToken, commentId, currentlyReacted);
        btn.classList.remove("is-loading");
        if (success) {
            viewerReactions[commentId] = newReacted;
            saveViewerReactions();
        }
        else {
            // Revert on failure
            updateHeartButton(imageId, currentCount, currentlyReacted);
        }
    }
    /**
     * Show login prompt toast
     */
    function showLoginPrompt() {
        if (document.querySelector(".masonry-login-prompt"))
            return;
        const prompt = document.createElement("div");
        prompt.className = "masonry-login-prompt";
        prompt.innerHTML = `
      <div class="masonry-login-prompt-content">
        <i class="fa-brands fa-github"></i>
        <span>Sign in with GitHub to like photos</span>
        <button class="masonry-login-prompt-close" aria-label="Close">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;
        document.body.appendChild(prompt);
        const timer = setTimeout(() => {
            prompt.classList.add("is-hiding");
            setTimeout(() => prompt.remove(), 300);
        }, 3000);
        prompt.querySelector(".masonry-login-prompt-close")?.addEventListener("click", () => {
            clearTimeout(timer);
            prompt.classList.add("is-hiding");
            setTimeout(() => prompt.remove(), 300);
        });
        requestAnimationFrame(() => prompt.classList.add("is-visible"));
    }
    /**
     * Apply live reaction data from GitHub
     */
    function applyLiveReactions(comments) {
        for (const comment of comments) {
            const imageId = parseImageIdFromBody(comment.body);
            if (!imageId)
                continue;
            const heartGroup = comment.reactionGroups?.find((g) => g.content === "HEART");
            if (!heartGroup)
                continue;
            const heartCount = heartGroup.users?.totalCount || 0;
            const viewerHasReacted = heartGroup.viewerHasReacted || false;
            if (imageReactions[imageId]) {
                imageReactions[imageId].heartCount = heartCount;
            }
            viewerReactions[comment.id] = viewerHasReacted;
            updateHeartButton(imageId, heartCount, viewerHasReacted);
        }
        saveViewerReactions();
    }
    /**
     * Apply locally cached viewer state (fallback when not authenticated)
     */
    function applyLocalViewerState() {
        for (const [commentId, hasReacted] of Object.entries(viewerReactions)) {
            for (const [imageId, data] of Object.entries(imageReactions)) {
                if (data.commentId === commentId) {
                    const btn = document.querySelector(`.masonry-heart-btn[data-image-id="${CSS.escape(imageId)}"]`);
                    if (btn && hasReacted) {
                        btn.dataset.reacted = "true";
                        btn.classList.add("is-reacted");
                    }
                }
            }
        }
    }
    /* ==================== Init ==================== */
    /**
     * Attempt to authenticate and fetch live data.
     * Called on init and retried once if giscus-client hasn't processed
     * the OAuth callback yet (race condition on first login redirect).
     */
    async function tryAuthenticate(retryCount = 0) {
        try {
            userToken = await getGiscusToken();
            if (userToken) {
                isAuthenticated = true;
                enableHeartButtons();
                // Fetch live data
                const liveComments = await fetchLiveReactions(userToken);
                if (liveComments) {
                    applyLiveReactions(liveComments);
                }
            }
            else if (retryCount === 0) {
                // On first OAuth redirect, giscus-client.js may not have stored
                // the session yet. Wait and retry once.
                const hasGiscusParam = new URLSearchParams(location.search).has("giscus");
                if (hasGiscusParam) {
                    setTimeout(() => tryAuthenticate(1), 2000);
                    return;
                }
                applyLocalViewerState();
            }
            else {
                applyLocalViewerState();
            }
        }
        catch (err) {
            console.warn("[masonry-reactions] Auth error:", err);
            applyLocalViewerState();
        }
    }
    async function init() {
        // 1. Create heart buttons from embedded data
        initializeHeartButtons();
        // 2. Try authentication via giscus session (with retry for OAuth callback race)
        await tryAuthenticate();
    }
    // Listen for storage changes (if giscus-client writes session in another script)
    window.addEventListener("storage", (e) => {
        if (e.key === GISCUS_SESSION_KEY && e.newValue && !isAuthenticated) {
            tryAuthenticate();
        }
    });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    }
    else {
        init();
    }
})();
