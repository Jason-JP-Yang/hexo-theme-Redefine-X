/**
 * Notifications — entry point.
 *
 * Owns the parts the panel deliberately does not: the service worker, the push
 * subscription, the session token, and the network calls to the backend Worker.
 *
 * Two decoupled things share one bell:
 *
 *   • the INBOX  — a durable per-reader list in D1, which works for anyone
 *                  signed in, including a reader who refuses the OS permission;
 *   • PUSH       — one optional delivery method on top of it.
 *
 * That split is why "follow" is not the same action as "allow notifications":
 * declining the browser prompt costs the reader the buzz, not the feature.
 *
 * Swup note: the navbar is INSIDE #swup and is destroyed on every navigation,
 * so the bell is bound by delegation on document rather than by a direct
 * listener. The panel lives outside #swup and survives untouched.
 */

import { render, setOpen, isOpen, setBadge, getPanel } from "./notifications-inbox.js";

const POLL_MS = 5 * 60 * 1000; // background unread refresh while a tab is open

let config = null;
let state = {
  phase: "loading",
  items: [],
  unread: 0,
  topics: [],
  selected: [],
  pushState: "off",
  needsInstall: false,
  busy: false,
};
let registration = null;
let booted = false;
let pollTimer = null;

// ─── config ──────────────────────────────────────────────────
function readConfig() {
  const theme = window.theme || {};
  const n = theme.notifications;
  if (!n || !n.enable) return null;

  // Resolve THROUGH blogAuth, never straight from the config: on localhost it
  // redirects to `developer.local_api_url`, and the session token we send is
  // only valid at the Worker instance that minted it.
  const base = window.blogAuth
    ? window.blogAuth.resolveApiBase(n.api_url)
    : String(n.api_url || "").replace(/\/+$/, "");
  if (!base) return null;

  return {
    base,
    vapidKey: n.vapid_public_key || "",
    topics: String(n.topics || "posts")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// ─── capability detection ────────────────────────────────────
function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * iOS delivers Web Push only to a site installed to the Home Screen. Detecting
 * "iOS and not standalone" is the difference between a working Follow button
 * and one that silently does nothing on an iPhone.
 */
function needsHomeScreenInstall() {
  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return false;
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return !standalone;
}

function permissionState() {
  // Distinguished from "unsupported" because the fix is completely different and
  // the symptom is identical: on a LAN address over plain http the browser
  // withholds serviceWorker/PushManager, so the feature looks broken rather than
  // blocked. Only localhost and 127.0.0.1 get the secure-context exemption.
  if (window.isSecureContext === false) return "insecure";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted") return "granted";
  return "off";
}

// ─── backend ─────────────────────────────────────────────────
async function token() {
  if (!window.blogAuth) return null;
  try {
    return await window.blogAuth.getSessionToken();
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const auth = await token();
  if (!auth) return null;

  const init = {
    method: options.method || "GET",
    headers: { Authorization: `Bearer ${auth}` },
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  try {
    const res = await fetch(config.base + path, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── service worker ──────────────────────────────────────────
/**
 * Register the worker at the site root.
 *
 * Deliberately NOT through renderJS: that helper rewrites paths to a CDN when
 * `cdn.enable` is true, and a service worker must be served same-origin — a
 * jsDelivr URL here would fail registration outright.
 */
async function ensureRegistration() {
  if (registration) return registration;
  if (!pushSupported()) return null;
  try {
    const root = (window.config && window.config.root) || "/";
    registration = await navigator.serviceWorker.register(`${root}sw.js`.replace(/\/+/g, "/"), {
      scope: root,
    });
    return registration;
  } catch {
    return null;
  }
}

/**
 * Was this subscription created with the VAPID key we are configured to use?
 *
 * Returns true when the browser will not say (older implementations expose no
 * `options`), because forcing a re-subscribe on every load would be worse than
 * the rare stale key it would catch.
 */
function usesKey(sub, keyBytes) {
  const stored = sub.options && sub.options.applicationServerKey;
  if (!stored) return true;
  const a = new Uint8Array(stored);
  if (a.length !== keyBytes.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== keyBytes[i]) return false;
  return true;
}

function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Hand the worker what it needs to re-subscribe on its own. `pushsubscriptionchange`
 * can fire with no page open, so the worker cannot ask for this later.
 */
async function shareConfigWithWorker() {
  const reg = await ensureRegistration();
  if (!reg || !reg.active) return;
  reg.active.postMessage({
    type: "redefine-x:push-config",
    config: { apiBase: config.base, vapidKey: config.vapidKey, token: await token() },
  });
}

async function vapidKey() {
  if (config.vapidKey) return config.vapidKey;
  // Fallback for a site whose theme config has not been filled in yet.
  try {
    const res = await fetch(`${config.base}/api/push/vapid-key`);
    if (!res.ok) return null;
    const data = await res.json();
    config.vapidKey = data.key || "";
    return config.vapidKey || null;
  } catch {
    return null;
  }
}

/** Subscribe this device and register it with the backend. */
async function subscribeDevice() {
  if (!pushSupported()) return false;

  const key = await vapidKey();
  if (!key) return false;

  const reg = await ensureRegistration();
  if (!reg) return false;

  // requestPermission must be reached from a user gesture; every caller of this
  // function is a click handler.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const keyBytes = base64UrlToUint8Array(key);

  let sub = await reg.pushManager.getSubscription();

  // A subscription is bound to the applicationServerKey it was created with. If
  // the VAPID pair has been rotated since, reusing this one means the push
  // service rejects every message with a 403 that nothing surfaces — the
  // subscription looks perfectly healthy from here. Replace it instead.
  if (sub && !usesKey(sub, keyBytes)) {
    try {
      await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    } catch {}
    sub = null;
  }

  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes,
      });
    } catch {
      return false;
    }
  }

  const json = sub.toJSON();
  const result = await api("/api/push/subscribe", {
    method: "POST",
    body: {
      endpoint: sub.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
    },
  });

  await shareConfigWithWorker();
  return !!result;
}

/**
 * Re-register a subscription the push service rotated while we were away. Cheap
 * (one request, only when the endpoint actually changed) and it is what stops a
 * follower going quietly dead.
 */
async function reconcileSubscription() {
  if (permissionState() !== "granted") return;
  const reg = await ensureRegistration();
  if (!reg) return;

  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  // Same rotation check as subscribeDevice(), on the path that runs every page
  // load — so a key change is repaired without waiting for the reader to press
  // Follow again.
  const key = await vapidKey();
  if (key && !usesKey(sub, base64UrlToUint8Array(key))) {
    await subscribeDevice();
    return;
  }

  const json = sub.toJSON();
  await api("/api/push/subscribe", {
    method: "POST",
    body: {
      endpoint: sub.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
    },
  });
  await shareConfigWithWorker();
}

// ─── state ───────────────────────────────────────────────────
function paint() {
  render(state);
}

async function refresh({ quiet = false } = {}) {
  if (!config) return;

  if (!window.blogAuth || !window.blogAuth.isAuthenticated) {
    state = { ...state, phase: "signed-out", items: [], unread: 0, busy: false };
    paint();
    return;
  }

  if (!quiet) {
    state = { ...state, phase: "loading", busy: true };
    paint();
  }

  // ONE call: the inbox endpoint returns the follow state and topic selection
  // alongside the items, because painting the panel always needed both and
  // asking twice cost a second round trip to render the same view.
  const inbox = await api("/api/me/notifications");

  if (!inbox) {
    // A failed call while signed in is a transient backend problem, not a
    // sign-out; keep whatever the panel already shows rather than flashing an
    // empty state at the reader.
    state = { ...state, phase: state.phase === "loading" ? "not-following" : state.phase, busy: false };
    paint();
    return;
  }

  state = {
    ...state,
    phase: inbox.following ? "following" : "not-following",
    items: inbox.items || [],
    unread: inbox.unread || 0,
    topics: config.topics,
    selected: String(inbox.topics || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pushState: permissionState(),
    needsInstall: needsHomeScreenInstall(),
    busy: false,
  };
  paint();
}

// ─── actions ─────────────────────────────────────────────────
async function follow() {
  state = { ...state, busy: true };
  paint();

  // Create the follower row FIRST, so declining the OS prompt still leaves the
  // reader following and receiving the in-site inbox.
  await api("/api/me/preferences", { method: "PUT", body: { topics: "" } });
  if (pushSupported() && !needsHomeScreenInstall()) await subscribeDevice();

  await refresh({ quiet: true });
}

async function unfollow() {
  state = { ...state, busy: true };
  paint();

  if (pushSupported()) {
    const reg = await ensureRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } });
        await sub.unsubscribe().catch(() => {});
      }
    }
  }
  await api("/api/me/preferences", { method: "PUT", body: { follow: false } });

  state = { ...state, items: [], unread: 0, selected: [] };
  await refresh({ quiet: true });
}

async function toggleTopic(topic) {
  const all = config.topics;
  // "" means every topic, so the first deselection has to be expanded into the
  // explicit list before one can be removed from it.
  let selected = state.selected.length === 0 ? all.slice() : state.selected.slice();

  const index = selected.indexOf(topic);
  if (index === -1) selected.push(topic);
  else selected.splice(index, 1);

  // Deselecting everything reads as "stop notifying me", which is unfollow —
  // not a follower subscribed to nothing. Keep the last topic on instead.
  if (selected.length === 0) return;

  state = { ...state, selected, busy: true };
  paint();

  await api("/api/me/preferences", {
    method: "PUT",
    body: { topics: selected.length === all.length ? "" : selected.join(",") },
  });
  await refresh({ quiet: true });
}

async function markAllRead() {
  state = { ...state, unread: 0, items: state.items.map((i) => ({ ...i, read_at: "now" })) };
  paint();
  await api("/api/me/notifications/read", { method: "POST", body: {} });
}

async function markOneRead(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item || item.read_at) return;
  item.read_at = "now";
  state = { ...state, unread: Math.max(0, state.unread - 1) };
  setBadge(state.unread);
  await api("/api/me/notifications/read", { method: "POST", body: { ids: [id] } });
}

// ─── events ──────────────────────────────────────────────────
function togglePanel() {
  const next = !isOpen();
  setOpen(next);
  if (next) refresh();
}

/**
 * One delegated listener on document, bound once. The bell is rebuilt by every
 * Swup navigation, so binding it directly would leak a listener per page view
 * and stop working on the second one.
 */
function wireDelegation() {
  document.addEventListener("click", (event) => {
    const bell = event.target.closest(".notifications-bell");
    if (bell) {
      event.preventDefault();
      togglePanel();
      return;
    }

    const panel = getPanel();
    if (!panel) return;

    if (event.target.closest("#notifications-mask") || event.target.closest(".np-close")) {
      setOpen(false);
      return;
    }

    if (!panel.contains(event.target)) {
      if (isOpen()) setOpen(false);
      return;
    }

    if (event.target.closest(".np-login")) {
      window.blogAuth && window.blogAuth.login();
      return;
    }
    if (event.target.closest(".np-follow")) return void follow();
    if (event.target.closest(".np-unfollow")) return void unfollow();
    if (event.target.closest(".np-enable-push")) {
      subscribeDevice().then(() => refresh({ quiet: true }));
      return;
    }
    if (event.target.closest(".np-mark-read")) return void markAllRead();

    const topic = event.target.closest(".np-topic");
    if (topic) return void toggleTopic(topic.dataset.topic);

    // A click on an item marks it read and then follows the link normally.
    const item = event.target.closest(".np-item");
    if (item) markOneRead(item.dataset.id);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) setOpen(false);
  });

  window.addEventListener("blog:auth-change", () => {
    refresh({ quiet: !isOpen() });
    shareConfigWithWorker();
  });

  // A push received while the tab is open should move the badge without a reload.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "redefine-x:push-received") {
        refresh({ quiet: true });
      }
    });
  }
}

// ─── boot ────────────────────────────────────────────────────
export function initNotifications() {
  config = readConfig();
  if (!config) return;
  if (!getPanel()) return;

  if (!booted) {
    booted = true;
    wireDelegation();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") refresh({ quiet: true });
    }, POLL_MS);

    ensureRegistration().then(() => {
      reconcileSubscription();
      shareConfigWithWorker();
    });
  }

  // Runs on every page view: the bell is new markup and needs its badge back.
  state = { ...state, pushState: permissionState(), needsInstall: needsHomeScreenInstall() };
  setBadge(state.unread);
  refresh({ quiet: true });
}

document.addEventListener("DOMContentLoaded", initNotifications);

try {
  swup.hooks.on("page:view", initNotifications);
} catch (e) {}
