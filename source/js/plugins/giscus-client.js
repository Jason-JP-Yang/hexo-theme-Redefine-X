/**
 * Giscus Client - Self-hosted Version
 *
 * Based on the official giscus client.ts, modified for self-hosting:
 * - Script can be loaded from any domain (not just giscus.app)
 * - The giscus widget iframe still points to giscus.app's server
 * - CSS is inlined locally (no external default.css request)
 * - Supports configurable giscus server origin via data-giscus-origin attribute
 *
 * Build: tsc client-self-hosted.ts --outDir build-client --target ES2020
 * Usage: Load this script with data-* attributes same as official giscus client.js
 */
(function () {
    const GISCUS_SESSION_KEY = 'giscus-session';
    const script = document.currentScript;
    // Self-hosted: giscus server origin is configurable, defaults to giscus.app
    // The iframe widget always loads from the giscus server, not from the script's origin
    const giscusOrigin = script.dataset.giscusOrigin || 'https://giscus.app';
    function formatError(message) {
        return `[giscus] An error occurred. Error message: "${message}".`;
    }
    function getMetaContent(property, og = false) {
        const ogSelector = og ? `meta[property='og:${property}'],` : '';
        const element = document.querySelector(ogSelector + `meta[name='${property}']`);
        return element ? element.content : '';
    }
    // Set up session and clear the session param on load
    const url = new URL(location.href);
    let session = url.searchParams.get('giscus') || '';
    const savedSession = localStorage.getItem(GISCUS_SESSION_KEY);
    url.searchParams.delete('giscus');
    url.hash = '';
    const cleanedLocation = url.toString();
    if (session) {
        localStorage.setItem(GISCUS_SESSION_KEY, JSON.stringify(session));
        history.replaceState(undefined, document.title, cleanedLocation);
    }
    else if (savedSession) {
        try {
            session = JSON.parse(savedSession);
        }
        catch (e) {
            localStorage.removeItem(GISCUS_SESSION_KEY);
            console.warn(`${formatError(e?.message)} Session has been cleared.`);
        }
    }
    const attributes = script.dataset;
    const params = {};
    params.origin = cleanedLocation;
    params.session = session;
    params.theme = attributes.theme;
    params.reactionsEnabled = attributes.reactionsEnabled || '1';
    params.emitMetadata = attributes.emitMetadata || '0';
    params.inputPosition = attributes.inputPosition || 'bottom';
    params.repo = attributes.repo;
    params.repoId = attributes.repoId;
    params.category = attributes.category || '';
    params.categoryId = attributes.categoryId;
    params.strict = attributes.strict || '0';
    params.description = getMetaContent('description', true);
    params.backLink = getMetaContent('giscus:backlink') || cleanedLocation;
    switch (attributes.mapping) {
        case 'url':
            params.term = cleanedLocation;
            break;
        case 'title':
            params.term = document.title;
            break;
        case 'og:title':
            params.term = getMetaContent('title', true);
            break;
        case 'specific':
            params.term = attributes.term;
            break;
        case 'number':
            params.number = attributes.term;
            break;
        case 'pathname':
        default:
            params.term =
                location.pathname.length < 2
                    ? 'index'
                    : decodeURIComponent(location.pathname.substring(1).replace(/\.\w+$/, ''));
            break;
    }
    // Check anchor of the existing container and append it to origin URL
    const existingContainer = document.querySelector('.giscus');
    const id = existingContainer && existingContainer.id;
    if (id) {
        params.origin = `${cleanedLocation}#${id}`;
    }
    // Set up iframe src and loading attribute
    const locale = attributes.lang ? `/${attributes.lang}` : '';
    const src = `${giscusOrigin}${locale}/widget?${new URLSearchParams(params)}`;
    const loading = attributes.loading === 'lazy' ? 'lazy' : undefined;
    // Set up iframe element
    const iframeElement = document.createElement('iframe');
    const iframeAttributes = {
        class: 'giscus-frame giscus-frame--loading',
        title: 'Comments',
        scrolling: 'no',
        allow: 'clipboard-write',
        src,
        loading,
    };
    Object.entries(iframeAttributes).forEach(([key, value]) => value && iframeElement.setAttribute(key, value));
    // Prevent white flash on load
    iframeElement.style.opacity = '0';
    iframeElement.addEventListener('load', () => {
        iframeElement.style.removeProperty('opacity');
        iframeElement.classList.remove('giscus-frame--loading');
    });
    // Self-hosted: inject giscus CSS inline instead of loading from giscus.app
    // This avoids an external CSS request and ensures styling works even offline
    if (!document.getElementById('giscus-css')) {
        const style = document.createElement('style');
        style.id = 'giscus-css';
        style.textContent = '.giscus,.giscus-frame{width:100%;min-height:150px}.giscus-frame{border:none;color-scheme:light dark}.giscus-frame--loading{opacity:0}';
        document.head.prepend(style);
    }
    // Insert iframe element
    if (!existingContainer) {
        const iframeContainer = document.createElement('div');
        iframeContainer.setAttribute('class', 'giscus');
        iframeContainer.appendChild(iframeElement);
        script.insertAdjacentElement('afterend', iframeContainer);
    }
    else {
        while (existingContainer.firstChild)
            existingContainer.firstChild.remove();
        existingContainer.appendChild(iframeElement);
    }
    const suggestion = `Please consider reporting this error at https://github.com/giscus/giscus/issues/new.`;
    function signOut() {
        delete params.session;
        const src = `${giscusOrigin}${locale}/widget?${new URLSearchParams(params)}`;
        iframeElement.src = src; // Force reload
    }
    // Listen to messages
    window.addEventListener('message', (event) => {
        if (event.origin !== giscusOrigin)
            return;
        const { data } = event;
        if (!(typeof data === 'object' && data.giscus))
            return;
        if (data.giscus.resizeHeight) {
            iframeElement.style.height = `${data.giscus.resizeHeight}px`;
        }
        if (data.giscus.signOut) {
            localStorage.removeItem(GISCUS_SESSION_KEY);
            console.log(`[giscus] User has logged out. Session has been cleared.`);
            signOut();
            return;
        }
        if (!data.giscus.error)
            return;
        const message = data.giscus.error;
        if (message.includes('Bad credentials') ||
            message.includes('Invalid state value') ||
            message.includes('State has expired')) {
            // Might be because token is expired or other causes
            if (localStorage.getItem(GISCUS_SESSION_KEY) !== null) {
                localStorage.removeItem(GISCUS_SESSION_KEY);
                console.warn(`${formatError(message)} Session has been cleared.`);
                signOut();
            }
            else if (!savedSession) {
                console.error(`${formatError(message)} No session is stored initially. ${suggestion}`);
            }
        }
        else if (message.includes('Discussion not found')) {
            console.warn(`[giscus] ${message}. A new discussion will be created if a comment/reaction is submitted.`);
        }
        else if (message.includes('API rate limit exceeded')) {
            console.warn(formatError(message));
        }
        else {
            console.error(`${formatError(message)} ${suggestion}`);
        }
    });
    // Self-hosted: expose sendMessage for parent-to-giscus communication
    // This allows theme scripts to update giscus config dynamically
    window.__giscus = {
        signOut,
        setConfig(config) {
            iframeElement.contentWindow?.postMessage({ giscus: { setConfig: config } }, giscusOrigin);
        },
    };
})();
