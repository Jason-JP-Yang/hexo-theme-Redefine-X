/**
 * Redefine-X service worker — notifications only.
 *
 * Deliberately NOT a caching worker. Swup already owns navigation and the theme
 * ships its own asset pipeline; a cache layer here would fight both and make
 * every deploy a cache-invalidation problem. This file exists for the one thing
 * a page cannot do on its own: receive a push while the site is closed.
 *
 * ES5 ONLY. scripts/filters/js-optimizer.js minifies everything under public/
 * with uglify-js, which cannot parse ES6 — an arrow function or a `const` here
 * does not fail the build, it silently ships the file UNMINIFIED, or breaks it.
 *
 * Config problem, and why the cache: `pushsubscriptionchange` can fire with no
 * page open, so the worker cannot ask the page where the API is. The page posts
 * its config in once and we keep it in Cache Storage, which is the only
 * durable, synchronously-openable storage a service worker has.
 */
/* eslint-env serviceworker */
"use strict";

var CONFIG_CACHE = "redefine-x-push-config";
var CONFIG_KEY = "https://redefine-x.invalid/push-config";

// ─── config persistence ──────────────────────────────────────
function saveConfig(config) {
  return caches.open(CONFIG_CACHE).then(function (cache) {
    return cache.put(
      CONFIG_KEY,
      new Response(JSON.stringify(config), {
        headers: { "Content-Type": "application/json" }
      })
    );
  });
}

function loadConfig() {
  return caches
    .open(CONFIG_CACHE)
    .then(function (cache) {
      return cache.match(CONFIG_KEY);
    })
    .then(function (res) {
      return res ? res.json() : null;
    })
    .catch(function () {
      return null;
    });
}

// ─── lifecycle ───────────────────────────────────────────────
// Take over immediately: a reader who just granted permission should not have to
// close every tab before the worker that receives their first push is active.
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (event) {
  var data = event.data;
  if (!data || data.type !== "redefine-x:push-config") return;
  event.waitUntil(saveConfig(data.config || {}));
});

// ─── push ────────────────────────────────────────────────────
self.addEventListener("push", function (event) {
  var payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      // A push with an unencryptable or oversized body arrives with no data. It
      // still means "something happened", so show the generic form rather than
      // dropping it — see the 413 fallback in the Worker's drain loop.
      payload = { title: "New on the blog", body: event.data.text() };
    }
  }
  if (!payload) payload = { title: "New on the blog", body: "" };

  var title = payload.title || "New on the blog";
  var options = {
    body: payload.body || "",
    tag: payload.tag || "posts",
    // Never re-alert for a replaced notification. A second note landing on top
    // of an unread one updates it silently instead of buzzing twice.
    renotify: false,
    silent: !!payload.silent,
    timestamp: Date.now(),
    data: { url: payload.url || "/", id: payload.id || "" }
  };
  if (payload.image) options.icon = payload.image;

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── click ───────────────────────────────────────────────────
self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  var target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        // Reuse a tab already on the site rather than opening a duplicate: the
        // reader almost always has one, and Swup makes the in-place navigation
        // cheaper than a cold load.
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return undefined;
      })
  );
});

// ─── subscription rotation ───────────────────────────────────
// Push services rotate endpoints without warning. If we do not re-register, the
// reader silently stops receiving anything and has no way to notice.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    loadConfig().then(function (config) {
      if (!config || !config.apiBase || !config.vapidKey || !config.token) return;

      return self.registration.pushManager
        .subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(config.vapidKey)
        })
        .then(function (sub) {
          var json = sub.toJSON();
          return fetch(config.apiBase + "/api/push/subscribe", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + config.token
            },
            body: JSON.stringify({
              endpoint: sub.endpoint,
              p256dh: json.keys && json.keys.p256dh,
              auth: json.keys && json.keys.auth
            })
          });
        })
        .catch(function () {
          // The session token in the cached config expires after two hours, so a
          // rotation while the reader is away cannot always be repaired here.
          // notifications.js re-checks the live subscription on every page load
          // and re-registers then; this path is the best-effort fast route.
        });
    })
  );
});

function base64UrlToUint8Array(base64Url) {
  var padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  var base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  var raw = self.atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
