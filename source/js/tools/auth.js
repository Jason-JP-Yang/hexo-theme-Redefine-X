/**
 * window.blogAuth — the blog's single GitHub-OAuth identity component.
 *
 * Identity is rooted in the giscus sign-in (localStorage "giscus-session"),
 * the same login that powers comments and masonry likes. This component owns
 * ALL of that logic in ONE place so consumers don't duplicate it:
 *
 *   • masonry-reactions  → uses getToken() to like photos via GitHub GraphQL.
 *   • instant-notes admin → uses getSession()/getSessionToken() to write notes.
 *   • (future) a unified "signed in as …" UI.
 *
 * It exchanges the giscus session for a GitHub user token (via the merged
 * Worker's /api/oauth/token proxy), and asks the Worker /api/auth/login "who am
 * I + am I admin?". Admins receive a short-lived HMAC session token used for
 * admin writes. Non-admins simply get isAdmin:false — comments and likes keep
 * working unchanged.
 *
 * Loaded as a CLASSIC script (see scripts.ejs) BEFORE masonry-reactions so the
 * global is ready and the OAuth-callback session sync runs synchronously.
 * Emits a "blog:auth-change" window event whenever auth state changes.
 *
 * No bundler: integration surface is the window.blogAuth global, not imports.
 */
(function () {
  "use strict";
  if (window.blogAuth) return; // idempotent across swup / double-loads

  var GISCUS_SESSION_KEY = "giscus-session";
  var GISCUS_ORIGIN = "https://giscus.app";
  var SESSION_CACHE_KEY = "blog-auth-session"; // sessionStorage: {login,avatar,isAdmin,token,exp}

  // ─── state ───────────────────────────────────────────────
  var tokenCache = null; // { session, token } — giscus session → GitHub token
  var cachedSession = null; // { login, avatar, isAdmin, token, exp }
  var sessionPromise = null; // in-flight getSession()

  // ─── config / base URL ───────────────────────────────────
  function strip(u) {
    return String(u).replace(/\/+$/, "");
  }
  function getMasonryConfig() {
    var el = document.getElementById("masonry-reactions-data");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "");
    } catch (e) {
      return null;
    }
  }
  /**
   * Resolve the merged-Worker base URL. Both custom domains route to the same
   * Worker, so either works for /api/oauth/token and /api/auth/login.
   * Prefer the masonry page's giscusProxy (keeps likes on their usual domain),
   * else the globally-exported instant_notes.api_url.
   */
  function getApiBase() {
    var mc = getMasonryConfig();
    if (mc && mc.giscusProxy) return strip(mc.giscusProxy);
    var t =
      window.theme &&
      window.theme.home_banner &&
      window.theme.home_banner.instant_notes &&
      window.theme.home_banner.instant_notes.api_url;
    if (t) return strip(t);
    return null;
  }

  function readGiscusSession() {
    var raw = localStorage.getItem(GISCUS_SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) || null;
    } catch (e) {
      return null;
    }
  }

  // ─── session cache (avoid re-verifying on every page load) ─
  function persist(data) {
    try {
      if (data) sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(data));
      else sessionStorage.removeItem(SESSION_CACHE_KEY);
    } catch (e) {}
  }
  function hydrate() {
    if (!readGiscusSession()) {
      persist(null);
      return;
    }
    try {
      var raw = sessionStorage.getItem(SESSION_CACHE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && (!data.exp || Date.now() < data.exp)) cachedSession = data;
      else persist(null);
    } catch (e) {}
  }

  // ─── token exchange: giscus session → GitHub OAuth token ──
  function getToken() {
    var session = readGiscusSession();
    if (!session) {
      tokenCache = null;
      return Promise.resolve(null);
    }
    if (tokenCache && tokenCache.session === session && tokenCache.token) {
      return Promise.resolve(tokenCache.token);
    }
    var base = getApiBase() || GISCUS_ORIGIN; // proxy required (GISCUS_ORIGIN is a last resort)
    return fetch(base + "/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "session=" + encodeURIComponent(session),
    })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        var token = (data && data.token) || null;
        tokenCache = token ? { session: session, token: token } : null;
        return token;
      })
      .catch(function () {
        return null;
      });
  }

  // ─── identity + admin check (Worker /api/auth/login) ──────
  function getSession(force) {
    if (
      !force &&
      cachedSession &&
      (!cachedSession.exp || Date.now() < cachedSession.exp)
    ) {
      return Promise.resolve(cachedSession);
    }
    if (!force && sessionPromise) return sessionPromise;

    sessionPromise = getToken()
      .then(function (token) {
        if (!token) {
          cachedSession = null;
          persist(null);
          return null;
        }
        var base = getApiBase();
        if (!base) {
          cachedSession = null;
          return null;
        }
        return fetch(base + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ githubToken: token }),
        })
          .then(function (res) {
            if (!res.ok) return null;
            return res.json();
          })
          .then(function (data) {
            cachedSession = data || null; // { login, avatar, isAdmin, token, exp }
            persist(cachedSession);
            return cachedSession;
          });
      })
      .catch(function () {
        cachedSession = null;
        return null;
      })
      .then(function (result) {
        sessionPromise = null;
        return result;
      });
    return sessionPromise;
  }

  function getSessionToken() {
    return getSession().then(function (s) {
      return (s && s.token) || null;
    });
  }

  // ─── login / logout ──────────────────────────────────────
  function getLoginUrl() {
    return (
      GISCUS_ORIGIN +
      "/api/oauth/authorize?redirect_uri=" +
      encodeURIComponent(location.href)
    );
  }
  function login() {
    window.location.href = getLoginUrl();
  }
  function logout() {
    try {
      localStorage.removeItem(GISCUS_SESSION_KEY);
    } catch (e) {}
    tokenCache = null;
    cachedSession = null;
    persist(null);
    emit();
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent("blog:auth-change"));
    } catch (e) {}
  }

  // ─── react to giscus session changes (login/out, other tabs/iframe) ──
  function handleSessionChange(loggedIn) {
    tokenCache = null;
    cachedSession = null;
    persist(null);
    if (loggedIn) {
      getSession(true).then(emit);
    } else {
      // Definitive sign-out: clear the giscus session ourselves so getToken()
      // reliably returns null before we emit. removeItem fires no storage event
      // in-tab (no loop); harmless if already cleared (cross-tab) or removed twice.
      try {
        localStorage.removeItem(GISCUS_SESSION_KEY);
      } catch (e) {}
      emit();
    }
  }

  window.addEventListener("storage", function (e) {
    if (e.key !== GISCUS_SESSION_KEY) return;
    handleSessionChange(!!e.newValue);
  });
  window.addEventListener("message", function (event) {
    if (event.origin !== GISCUS_ORIGIN) return;
    var d = event.data;
    if (!d || typeof d !== "object" || !d.giscus) return;
    if (d.giscus.signOut) handleSessionChange(false);
  });
  // client-self-hosted.ts dispatches this after it saves a new session.
  window.addEventListener("giscus:session-change", function () {
    handleSessionChange(true);
  });

  // ─── public API ──────────────────────────────────────────
  window.blogAuth = {
    getToken: getToken,
    getSession: getSession,
    getSessionToken: getSessionToken,
    getLoginUrl: getLoginUrl,
    login: login,
    logout: logout,
    get isAuthenticated() {
      return !!readGiscusSession();
    },
    get isAdmin() {
      return !!(cachedSession && cachedSession.isAdmin);
    },
    get user() {
      return cachedSession
        ? { login: cachedSession.login, avatar: cachedSession.avatar }
        : null;
    },
  };

  // ─── boot ────────────────────────────────────────────────
  // OAuth callback: when returning from GitHub, the URL carries ?giscus=SESSION.
  // Persist it FIRST (same key/format as client-self-hosted.ts) so getToken()
  // works immediately. Don't strip the param — giscus-client still needs it.
  (function syncOAuthSession() {
    try {
      var giscusParam = new URL(location.href).searchParams.get("giscus");
      if (giscusParam)
        localStorage.setItem(GISCUS_SESSION_KEY, JSON.stringify(giscusParam));
    } catch (e) {}
  })();

  hydrate();

  // Warm the identity cache in the background so window.blogAuth.isAdmin is
  // populated soon after load. Consumers PULL via getSession()/getToken() on
  // their own init; blog:auth-change is only fired on real changes afterwards
  // (login/logout/iframe sign-out) — see handleSessionChange().
  if (readGiscusSession() && !cachedSession) {
    getSession(false);
  }
})();
