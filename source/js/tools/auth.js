/**
 * window.blogAuth — the blog's single GitHub-OAuth identity component.
 *
 * Identity is rooted in the giscus sign-in (localStorage "giscus-session"),
 * the same login that powers comments and masonry likes. This component owns
 * ALL of that logic in ONE place so consumers don't duplicate it:
 *
 *   • masonry-reactions  → uses getToken() to like photos via GitHub GraphQL.
 *   • instant-notes admin → uses getSession()/getSessionToken() to write notes.
 *   • notifications       → uses getSessionToken() to follow the blog, register
 *                           a push device, and read its own inbox.
 *   • (future) a unified "signed in as …" UI.
 *
 * It exchanges the giscus session for a GitHub user token (via the merged
 * Worker's /api/oauth/token proxy), and asks the Worker /api/auth/login "who am
 * I + am I admin?". EVERY verified user receives a short-lived HMAC session
 * token; the isAdmin claim inside it is what admin writes require. A reader who
 * is not an admin still holds a usable token — that is what lets them follow the
 * blog — and comments and likes keep working unchanged either way.
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
  var GISCUS_PARAM = "giscus";
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
  // ─── backend selection ───────────────────────────────────
  // EXACTLY three combinations are permitted; nothing else can be expressed:
  //
  //   A  localhost page  → local Worker        developer.backend: local
  //   B  localhost page  → production Worker   developer.backend: production
  //   C  production page → production Worker   (forced, config is ignored)
  //
  // The fourth combination — a deployed page talking to a local Worker — is
  // rejected in code, not by convention, so a stray `backend: local` committed
  // by accident degrades to C instead of shipping a broken or leaky site.
  //
  // The selection must sit at the BASE and apply to EVERY consumer at once: a
  // session token is HMAC-signed with the Worker's SESSION_SECRET, and
  // `wrangler dev` reads a different one from .dev.vars than production does.
  // Minting a token at one instance and spending it at the other is a guaranteed
  // 403 — which is precisely what a half-applied override used to cause.

  /**
   * Is this host somewhere only a developer can reach?
   *
   * Broader than "localhost" on purpose: testing push on a phone means loading
   * the dev site over the LAN, so the private ranges count too. All of these are
   * unroutable from the public internet, which is the property that matters —
   * a host on this list cannot be a deployed site.
   *
   *   localhost, *.localhost, *.local (mDNS)
   *   127.0.0.0/8, ::1
   *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
   */
  function isPrivateHost(host) {
    var h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1") return true;
    if (/(^|\.)localhost$/.test(h) || /\.local$/.test(h)) return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    var m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
    if (m) {
      var second = parseInt(m[1], 10);
      return second >= 16 && second <= 31;
    }
    return false;
  }

  function isLocalhostPage() {
    return isPrivateHost(location.hostname);
  }

  /**
   * Push and service workers require a SECURE CONTEXT. Browsers grant that to
   * localhost and 127.0.0.1 over plain http, but NOT to a LAN address — so
   * http://192.168.1.50:4000 can select the local backend and use the in-site
   * inbox, yet can never receive a push. Nothing in this codebase can change
   * that; it needs https (a tunnel, or a locally-trusted certificate).
   */
  function isSecureDevContext() {
    return typeof window.isSecureContext === "boolean" ? window.isSecureContext : true;
  }

  /**
   * A local Worker URL is only accepted if it points somewhere private. Without
   * this the developer hook would be a general-purpose redirect for every
   * authenticated API call — a place to point the blog's session tokens at
   * somebody else's host by editing one line of config.
   */
  function isLoopbackUrl(raw) {
    try {
      var u = new URL(raw, location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return isPrivateHost(u.hostname);
    } catch (e) {
      return false;
    }
  }

  var devBaseResolved = false;
  var devBase = null;

  function getDevBase() {
    if (devBaseResolved) return devBase;
    devBaseResolved = true;
    devBase = null;

    var d = (window.theme && window.theme.developer) || {};
    if (String(d.backend || "production") !== "local") return devBase;

    if (!isLocalhostPage()) {
      warn(
        "developer.backend is 'local' but " +
          location.hostname +
          " is not a private host (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, *.local) — " +
          "ignoring it and using the production backend."
      );
      return devBase;
    }
    if (!d.local_api_url || !isLoopbackUrl(d.local_api_url)) {
      warn(
        "developer.local_api_url must be a localhost/127.0.0.1 URL — " +
          "ignoring it and using the production backend."
      );
      return devBase;
    }

    devBase = strip(d.local_api_url);
    return devBase;
  }

  function warn(message) {
    try {
      console.warn("[blogAuth] " + message);
    } catch (e) {}
  }

  /**
   * Resolve the merged-Worker base URL. Both custom domains route to the same
   * Worker, so either works for /api/oauth/token and /api/auth/login.
   * The selected backend wins; otherwise the masonry page's giscusProxy (keeps
   * likes on their usual domain), else the exported instant_notes.api_url.
   */
  function getApiBase() {
    var dev = getDevBase();
    if (dev) return dev;
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

  /**
   * Resolve a Worker base for any other consumer.
   *
   * EVERY module that talks to the Worker must go through this — instant notes,
   * notifications, anything later. Reading `api_url` straight from the config
   * is what produced the split brain this replaced: notes posting to production
   * with a token the local Worker had signed.
   */
  function resolveApiBase(fallback) {
    return getDevBase() || (fallback ? strip(fallback) : getApiBase());
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
            // 401 is GitHub itself refusing the token behind this giscus
            // session — spent, revoked, or expired. Keeping it would leave every
            // consumer looking signed in and able to do nothing, which is the
            // state that reads as "the site is broken". Drop it and say so, the
            // same conclusion giscus-client reaches from its own widget error.
            if (res.status === 401) {
              warn("the stored giscus session is no longer valid — signing out");
              try {
                localStorage.removeItem(GISCUS_SESSION_KEY);
              } catch (e) {}
              tokenCache = null;
              setTimeout(emit, 0);
              return null;
            }
            if (!res.ok) {
              warn("identity check failed (" + res.status + ")");
              return null;
            }
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
  /**
   * This page's URL with any OAuth session (and hash) taken out of it.
   *
   * Load-bearing in two places, for the same reason: `?giscus=` is a ONE-TIME
   * credential, and a URL that still carries a spent one is a trap. As a
   * `redirect_uri` it comes back as `?giscus=SPENT&giscus=FRESH`, where the
   * first value — the dead one — is what `searchParams.get()` returns.
   */
  function cleanHref() {
    try {
      var u = new URL(location.href);
      u.searchParams.delete(GISCUS_PARAM);
      u.hash = "";
      return u.toString();
    } catch (e) {
      return location.href;
    }
  }

  function getLoginUrl() {
    return (
      GISCUS_ORIGIN +
      "/api/oauth/authorize?redirect_uri=" +
      encodeURIComponent(cleanHref())
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
    resolveApiBase: resolveApiBase,
    get apiBase() {
      return getApiBase();
    },
    // "local" or "production" — which of the three permitted combinations is
    // actually in force, after the guards above have had their say.
    get backend() {
      return getDevBase() ? "local" : "production";
    },
    get isLocalDev() {
      return !!getDevBase();
    },
    get isAuthenticated() {
      return !!readGiscusSession();
    },
    get isAdmin() {
      return !!(cachedSession && cachedSession.isAdmin);
    },
    // The GitHub NUMERIC id — stable across a username change, which is why the
    // backend keys followers by it rather than by login.
    get githubId() {
      return (cachedSession && cachedSession.id) || null;
    },
    get user() {
      return cachedSession
        ? {
            id: cachedSession.id || null,
            login: cachedSession.login,
            avatar: cachedSession.avatar,
          }
        : null;
    },
  };

  // ─── boot ────────────────────────────────────────────────
  /**
   * OAuth callback: when returning from GitHub the URL carries ?giscus=SESSION.
   * Persist it FIRST (same key/format as client-self-hosted.ts) so getToken()
   * works immediately — this script runs before giscus-client — and then TAKE IT
   * OUT OF THE URL.
   *
   * Stripping it is not tidying. The session is single-use, and this ran on
   * every load: any later visit to a URL that still carried one — a reload, a
   * bookmark, an entry picked out of history — overwrote the reader's good,
   * current session with the spent one. Everything then failed at once and in
   * unrelated-looking ways: the bell fell back to a Follow button that did
   * nothing, and the comment widget reported "Bad credentials" and signed the
   * reader out. giscus-client does strip it, but it is only loaded on pages that
   * have a comment widget, so the home page kept one indefinitely.
   *
   * The LAST value, not the first: a redirect_uri that still carried a spent
   * session comes back with two of them, oldest first.
   */
  (function syncOAuthSession() {
    try {
      var sessions = new URL(location.href).searchParams.getAll(GISCUS_PARAM);
      if (!sessions.length) return;
      localStorage.setItem(
        GISCUS_SESSION_KEY,
        JSON.stringify(sessions[sessions.length - 1])
      );
      history.replaceState(undefined, document.title, cleanHref());
    } catch (e) {}
  })();

  // Say which backend is in force, once, on localhost only. Every consumer
  // shares this base, so getting it wrong breaks notes, likes and notifications
  // together and in ways that read as unrelated bugs — worth one console line.
  if (isLocalhostPage()) {
    try {
      console.info(
        "[blogAuth] backend: " +
          (getDevBase() ? "LOCAL" : "PRODUCTION") +
          " → " +
          (getApiBase() || "(none configured)")
      );
      // The failure this prevents is silent and very confusing: on a LAN address
      // over http the browser withholds serviceWorker entirely, so Follow
      // "works", the inbox fills up, and no push ever arrives.
      if (!isSecureDevContext()) {
        warn(
          location.origin +
            " is not a secure context, so push notifications CANNOT work here " +
            "(the in-site inbox still does). Use http://localhost:4000, or serve " +
            "the dev site over https."
        );
      }
    } catch (e) {}
  }

  hydrate();

  // Warm the identity cache in the background so window.blogAuth.isAdmin is
  // populated soon after load. Consumers PULL via getSession()/getToken() on
  // their own init, but this also has to ANNOUNCE its result: the OAuth return
  // used to be announced by giscus-client's `giscus:session-change`, and that
  // now never fires here because the param is consumed and stripped above.
  if (readGiscusSession() && !cachedSession) {
    getSession(false).then(emit);
  }
})();
