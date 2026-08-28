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

import {
  render,
  setOpen,
  isOpen,
  setBadge,
  setBusy,
  setPanelBusy,
  setPage,
  getPage,
  fitViewport,
  confirmStep,
  disarmConfirm,
  getPanel,
  t,
} from "./notifications-inbox.js";

const POLL_MS = 5 * 60 * 1000; // background unread refresh while a tab is open
// Read by the inline script in head.ejs, which has to choose between the bell
// and the Follow button before the first paint.
const FOLLOW_KEY = "blog-following";
// Set only when the reader turns push OFF from the management page. Logging out
// also unregisters this browser, and signing back in restores it silently —
// which would undo a deliberate "no push here" unless something remembered it.
// Per-browser by nature, so localStorage is the right home for it and the only
// one: the backend must not carry a preference that is about one device.
const PUSH_OPTOUT_KEY = "blog-push-optout";

// How much of an endpoint identifies it in the device list. Must match
// ENDPOINT_TAIL in the Worker, which is what it compares against.
const ENDPOINT_TAIL = 18;

let config = null;
let state = {
  phase: "loading",
  items: [],
  unread: 0,
  topics: [],
  selected: [],
  devices: [],
  endpointTail: "",
  pushState: "off",
  pushHere: false,
  needsInstall: false,
  busy: false,
};
let registration = null;
let booted = false;
let pollTimer = null;
let resizeFrame = 0;
// One silent re-subscribe per session. Without the guard a browser that cannot
// subscribe (offline, a push service refusing) would try again on every poll.
let restoreTried = false;

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

/**
 * What kind of machine this is, decided once at subscribe time and stored with
 * the subscription, because nothing about it can be recovered later: a laptop
 * and a tower send byte-identical User-Agent strings, and the device list is
 * read from another browser entirely.
 *
 * Mobile and tablet are read off the UA, which is reliable for both. The
 * laptop/desktop split is not decidable at all, so it is decided by the two
 * signals that at least correlate: a Mac that is not an iPad is overwhelmingly
 * a MacBook, and a Windows or Linux machine with a touchscreen is a portable one.
 */
function deviceClass() {
  const ua = navigator.userAgent || "";
  const data = navigator.userAgentData;

  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
  if (data && data.mobile === true) return "mobile";
  if (/iPhone|iPod|Mobile/.test(ua)) return "mobile";
  if (/Mac OS X|Macintosh/.test(ua)) return "laptop";
  if ((navigator.maxTouchPoints || 0) > 0) return "laptop";
  return "desktop";
}

function optedOutOfPush() {
  try {
    return localStorage.getItem(PUSH_OPTOUT_KEY) === "1";
  } catch {
    return false;
  }
}

function setPushOptOut(on) {
  try {
    if (on) localStorage.setItem(PUSH_OPTOUT_KEY, "1");
    else localStorage.removeItem(PUSH_OPTOUT_KEY);
  } catch {}
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

/**
 * One authenticated call to the Worker.
 *
 * A rejected credential is RECOVERED FROM rather than reported as a failure.
 * The session token lives two hours and is cached per tab, so a tab left open
 * across that boundary — or one held through a redeploy that rotated the
 * signing secret — arrives here holding a token the Worker will refuse. Left
 * alone that surfaced as "you are not following this blog", with a Follow
 * button that pressed into the same 403. One forced re-mint fixes it silently.
 */
async function api(path, options = {}, retry = true) {
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
    if ((res.status === 401 || res.status === 403) && retry && window.blogAuth) {
      await window.blogAuth.getSession(true);
      return api(path, options, false);
    }
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

/** This browser's own push endpoint, or null when it has none. */
async function localSubscription() {
  if (!pushSupported() || permissionState() !== "granted") return null;
  const reg = await ensureRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe this device and register it with the backend.
 *
 * @param {boolean} prompt whether the OS permission dialog may be raised. False
 *        on the silent restore path, which runs outside a user gesture and must
 *        do nothing at all rather than ask.
 */
async function subscribeDevice({ prompt = true } = {}) {
  if (!pushSupported()) return false;

  const key = await vapidKey();
  if (!key) return false;

  const reg = await ensureRegistration();
  if (!reg) return false;

  if (Notification.permission !== "granted") {
    if (!prompt) return false;
    // requestPermission must be reached from a user gesture; every caller that
    // passes prompt:true is a click handler.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
  }

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
      device: deviceClass(),
    },
  });

  await shareConfigWithWorker();
  return !!result;
}

/** Drop this browser's subscription, at the backend and in the browser. */
async function unsubscribeDevice() {
  const sub = await localSubscription();
  if (!sub) return;
  await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } });
  try {
    await sub.unsubscribe();
  } catch {}
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
    await subscribeDevice({ prompt: false });
    return;
  }

  const json = sub.toJSON();
  await api("/api/push/subscribe", {
    method: "POST",
    body: {
      endpoint: sub.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
      device: deviceClass(),
    },
  });
  await shareConfigWithWorker();
}

// ─── state ───────────────────────────────────────────────────
function paint() {
  render(state);
  syncControls();
}

/**
 * The bell is the inbox, so it only means anything to a reader who follows.
 * Everyone else gets the Follow button in its place.
 */
function syncControls() {
  // "error" means we do not KNOW the follow state, so nothing here may claim
  // one. Leaving the controls as the page was painted keeps a follower's bell
  // instead of demoting them to a stranger over one failed request.
  if (state.phase === "loading" || state.phase === "error") return;
  const following = state.phase === "following";

  document.documentElement.classList.toggle("blog-following", following);
  try {
    localStorage.setItem(FOLLOW_KEY, following ? "1" : "0");
  } catch {}

  document.querySelectorAll(".follow-cta").forEach((cta) => {
    cta.classList.toggle("is-following", following);
    const label = cta.querySelector(".follow-label");
    if (label) label.textContent = following ? t("following", "Following") : t("follow_blog", "Follow the Blog");
  });
  // Whatever a Follow press left spinning is finished the moment the state it
  // was waiting for has arrived.
  if (!state.busy) {
    document.querySelectorAll(".follow-trigger").forEach((btn) => setBusy(btn, false));
  }
}

/** The topic list to store: "" when every configured topic is on. */
function topicsToSend(selected) {
  const all = config.topics;
  const kept = all.filter((topic) => selected.indexOf(topic) !== -1);
  return kept.length === all.length ? "" : kept.join(",");
}

async function refresh({ quiet = false } = {}) {
  if (!config) return;

  if (!window.blogAuth || !window.blogAuth.isAuthenticated) {
    state = { ...state, phase: "signed-out", items: [], unread: 0, devices: [], busy: false };
    paint();
    return;
  }

  // The spinner belongs to a panel with nothing in it yet. Once the reader has
  // seen a list, re-opening replaces it in place — flashing it away to load the
  // same rows again is a worse view of the same data.
  if (!quiet && state.phase === "loading") {
    state = { ...state, busy: true };
    paint();
  }

  // ONE call: the inbox endpoint returns the follow state, the topic selection
  // and the reader's devices alongside the items, because both pages of the
  // panel always needed all of it and asking twice cost a second round trip to
  // render the same card.
  const inbox = await api("/api/me/notifications");

  if (!inbox) {
    // A failed call while signed in is a backend or network problem, and it must
    // NOT be reported as "you do not follow this blog". That is what it used to
    // do on a cold panel, and the result was the worst possible state: the bell
    // replaced by a Follow button whose press ran straight into the same failed
    // call and did nothing visible at all. Say what actually happened, keep the
    // follow state the page was painted with, and offer to try again.
    state = {
      ...state,
      phase: state.phase === "loading" || state.phase === "signed-out" ? "error" : state.phase,
      busy: false,
    };
    paint();
    return;
  }

  const sub = await localSubscription();
  const tail = sub ? sub.endpoint.slice(-ENDPOINT_TAIL) : "";
  const devices = inbox.devices || [];

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
    devices,
    endpointTail: tail,
    pushState: permissionState(),
    pushHere: !!tail && devices.some((d) => d.tail === tail),
    needsInstall: needsHomeScreenInstall(),
    busy: false,
  };
  paint();

  await restorePush();
}

/**
 * Put this browser's push registration back after a sign-out, silently.
 *
 * Logging out unregisters the device, which is what makes "log out" mean
 * something; signing back in should not cost the reader a second permission
 * dance for a permission the browser has already granted. So when the OS says
 * yes and the reader has not said no, the subscription is simply recreated —
 * no prompt, no button, nothing on screen.
 */
async function restorePush() {
  if (restoreTried) return;
  if (state.phase !== "following" || state.pushHere) return;
  if (permissionState() !== "granted" || needsHomeScreenInstall()) return;
  if (optedOutOfPush()) return;

  restoreTried = true;
  if (await subscribeDevice({ prompt: false })) await refresh({ quiet: true });
}

// ─── actions ─────────────────────────────────────────────────
// Every action below marks its own control busy and dims the card, but none of
// them repaints before the round trip: the control is inside the markup a
// repaint replaces, and a spinner that is destroyed on the frame it appears is
// worse than no spinner at all.
async function follow(trigger) {
  setBusy(trigger, true);
  setPanelBusy(true);

  // Create the follower row FIRST, so declining the OS prompt still leaves the
  // reader following and receiving the in-site inbox.
  await api("/api/me/preferences", { method: "PUT", body: { topics: "" } });
  setPushOptOut(false);
  if (pushSupported() && !needsHomeScreenInstall()) await subscribeDevice();

  await refresh({ quiet: true });
}

async function unfollow(trigger) {
  setBusy(trigger, true);
  setPanelBusy(true);

  await unsubscribeDevice();
  await api("/api/me/preferences", { method: "PUT", body: { follow: false } });

  state = { ...state, items: [], unread: 0, selected: [], devices: [], pushHere: false };
  setPage("inbox");
  await refresh({ quiet: true });
}

/**
 * Sign this browser out.
 *
 * The push registration goes with the session, so that "logged out" is not a
 * state in which notifications keep arriving. refresh() puts it back on the way
 * in — see restorePush().
 */
async function logoutHere(trigger) {
  setBusy(trigger, true);
  setPanelBusy(true);
  await unsubscribeDevice();
  restoreTried = false;
  setOpen(false);
  if (window.blogAuth) window.blogAuth.logout();
}

async function toggleTopic(topic, control) {
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

  // Flipped here and not after the round trip: the switch is the reader's own
  // choice, and a control that waits for a server before it moves feels broken.
  if (control) {
    control.classList.toggle("is-on", index === -1);
    control.setAttribute("aria-checked", index === -1 ? "true" : "false");
    setBusy(control, true);
  }
  state = { ...state, selected };

  await api("/api/me/preferences", {
    method: "PUT",
    body: { topics: topicsToSend(selected) },
  });
  await refresh({ quiet: true });
}

async function togglePush(control) {
  const turningOn = !state.pushHere;
  if (control) {
    control.classList.toggle("is-on", turningOn);
    control.setAttribute("aria-checked", turningOn ? "true" : "false");
    setBusy(control, true);
  }

  if (turningOn) {
    setPushOptOut(false);
    await subscribeDevice();
  } else {
    setPushOptOut(true);
    await unsubscribeDevice();
  }
  await refresh({ quiet: true });
}

async function removeDevice(id, trigger) {
  setBusy(trigger, true);
  await api("/api/push/subscribe", { method: "DELETE", body: { id: Number(id) } });

  // Revoking the row this browser is registered under also revokes the browser's
  // own subscription — otherwise the endpoint stays live and the next reconcile
  // quietly puts the row back.
  const removed = (state.devices || []).find((d) => String(d.id) === String(id));
  if (removed && removed.tail && removed.tail === state.endpointTail) {
    setPushOptOut(true);
    const sub = await localSubscription();
    if (sub) await sub.unsubscribe().catch(() => {});
  }
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

    // Straight to the outcome: sign in, or follow. Opening a panel to press one
    // more button is a step that buys the reader nothing.
    const trigger = event.target.closest(".follow-trigger");
    if (trigger) {
      event.preventDefault();
      if (!window.blogAuth) return;
      if (!window.blogAuth.isAuthenticated) window.blogAuth.login();
      // Not knowing the state is not a reason to act on a guess. Open the panel,
      // which says what went wrong and offers the retry.
      else if (state.phase === "following" || state.phase === "error") togglePanel();
      else follow(trigger);
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

    if (event.target.closest(".np-back") || event.target.closest(".np-to-inbox")) {
      setPage("inbox");
      return;
    }
    if (event.target.closest(".np-to-manage")) {
      setPage("manage");
      return;
    }

    const login = event.target.closest(".np-login");
    if (login) {
      setBusy(login, true);
      window.blogAuth && window.blogAuth.login();
      return;
    }

    const again = event.target.closest(".np-retry");
    if (again) {
      setBusy(again, true);
      // Force a fresh identity too: the most likely reason a signed-in reader
      // got here is a session token the Worker would not accept.
      const done = () => refresh({ quiet: true });
      if (window.blogAuth) window.blogAuth.getSession(true).then(done, done);
      else done();
      return;
    }

    const follows = event.target.closest(".np-follow");
    if (follows) return void follow(follows);

    const logout = event.target.closest(".np-logout");
    if (logout) {
      if (confirmStep(logout, "logout", t("logout_confirm", "Press again to log out"))) {
        logoutHere(logout);
      }
      return;
    }

    const leave = event.target.closest(".np-unfollow");
    if (leave) {
      if (confirmStep(leave, "unfollow", t("unfollow_confirm", "Press again to unfollow"))) {
        unfollow(leave);
      }
      return;
    }

    const remove = event.target.closest(".np-device-remove");
    if (remove) {
      const id = remove.dataset.device;
      if (confirmStep(remove, `device:${id}`, "")) removeDevice(id, remove);
      return;
    }

    // Anything else pressed inside the panel takes back what was armed, so a
    // confirmation never outlives the reader's attention on it.
    disarmConfirm();

    if (event.target.closest(".np-mark-read")) return void markAllRead();

    const control = event.target.closest(".np-switch");
    if (control) {
      const key = control.dataset.switch;
      if (key === "push") return void togglePush(control);
      if (key === "posts" || key === "notes") return void toggleTopic(key, control);
      return;
    }

    // A click on an item marks it read and then follows the link normally.
    //
    // And gets out of the way. The panel used to survive the navigation it had
    // just caused, sitting over the page the reader had asked for — with the
    // link they clicked still holding focus inside a card now marked
    // aria-hidden. Focus goes with them rather than back to the bell, because
    // they are leaving, not returning.
    const item = event.target.closest(".np-item");
    if (item) {
      markOneRead(item.dataset.id);
      setOpen(false, { returnFocus: false });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    // Escape backs out one step at a time: settings first, then the panel.
    if (getPage() === "manage") setPage("inbox");
    else setOpen(false);
  });

  // The card's height is capped against the viewport, so a window that changes
  // size changes the cap — and a panel already at it has to be re-fitted.
  window.addEventListener(
    "resize",
    () => {
      if (resizeFrame || !isOpen()) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        fitViewport(false);
      });
    },
    { passive: true }
  );

  window.addEventListener("blog:auth-change", () => {
    restoreTried = false;
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

  // Runs on every page view: the navbar is new markup and needs its state back.
  state = { ...state, pushState: permissionState(), needsInstall: needsHomeScreenInstall() };
  setBadge(state.unread);
  syncControls();
  refresh({ quiet: true });
}

document.addEventListener("DOMContentLoaded", initNotifications);

try {
  swup.hooks.on("page:view", initNotifications);
} catch (e) {}
