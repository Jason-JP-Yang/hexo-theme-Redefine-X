/**
 * giscus, rendered in the page instead of in giscus.app's iframe.
 *
 * Same discussions, same sign-in (window.blogAuth's giscus session), same
 * markup and stylesheet as the widget (giscus-view.js, giscus-style.js), in an
 * open shadow root so the blog's CSS cannot reach it. Being part of the page
 * is the point: the light/dark copy (tools/themeMirror.js) mirrors it like any
 * other content, so during a switch the ring splits the live comments — what
 * was typed, opened or loaded included — and nothing is fetched twice.
 *
 * The data and the behaviour follow giscus's hooks: the newest 15 comments and
 * the oldest 15 with "load more" between them, optimistic writes followed by a
 * revalidation, a fresh read when the tab comes back. A reader who is not
 * signed in revalidates at most once a minute, because their reads cost the
 * Worker a request (giscus-data.js).
 */

import { createI18n } from "./giscus-i18n.js";
import { defineMathRenderer } from "./giscus-math.js";
import { h, morphChildren, processCommentBody, handleCommentClick, renderGiscus } from "./giscus-view.js";
import * as api from "./giscus-data.js";
import STYLE from "./giscus-style.js";

const HOSTS = ".giscus[data-giscus]";
const SCROLL_KEY = "giscus-scroll-position";
// Within this distance of the viewport the comments load, as a lazy iframe did.
const MARGIN = "1250px 0px";
// SWR's focus throttle; a reader without a token pays the Worker for each read.
const FRESH_SIGNED_IN = 5000;
const FRESH_ANONYMOUS = 60000;
const RETRIES = 3;

const widgets = new Set();
let sheet = null;
let observer = null;

const schemeName = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
const auth = () => window.blogAuth;

function cleanedLocation() {
  const url = new URL(location.href);
  url.searchParams.delete("giscus");
  url.hash = "";
  return url.toString();
}

function cleanAnchor(origin) {
  let length = origin.length;
  const split = origin.split(/#(?!\/)/);
  if (split.length > 1) length -= split.pop().length + 1;
  return origin.substring(0, length);
}

// The client script's half of giscus's configuration, read off this page.
function pageConfig(raw) {
  const cleaned = cleanedLocation();
  const meta = (property, og) =>
    document.querySelector((og ? `meta[property='og:${property}'],` : "") + `meta[name='${property}']`)?.content || "";
  let term = "";
  let number = 0;
  switch (raw.mapping) {
    case "url":
      term = cleaned;
      break;
    case "title":
      term = document.title;
      break;
    case "og:title":
      term = meta("title", true);
      break;
    case "specific":
      term = raw.term || "";
      break;
    case "number":
      number = +raw.term || 0;
      break;
    default:
      term = location.pathname.length < 2 ? "index" : decodeURIComponent(location.pathname.substring(1).replace(/\.\w+$/, ""));
  }
  return {
    ...raw,
    term,
    number,
    origin: cleaned,
    description: meta("description", true),
    backLink: meta("giscus:backlink") || cleaned,
    strict: !!+raw.strict,
    reactionsEnabled: !!+raw.reactionsEnabled,
  };
}

function updateReactionGroups(groups, reaction) {
  const diff = groups[reaction].viewerHasReacted ? -1 : 1;
  return [{ ...groups, [reaction]: { count: groups[reaction].count + diff, viewerHasReacted: !groups[reaction].viewerHasReacted } }, diff];
}

const reacted = (item, reaction) => ({ ...item, reactions: updateReactionGroups(item.reactions, reaction)[0] });

class Widget {
  constructor(host, raw) {
    this.host = host;
    this.c = pageConfig(raw);
    this.i18n = createI18n(raw.lang || "en", raw.strings || {}, h);
    this.orderBy = raw.defaultCommentOrder === "newest" ? "newest" : "oldest";
    this.token = null;
    this.ready = false;
    this.loaded = false;
    this.backData = null;
    this.frontPages = [];
    this.size = 1;
    this.backError = null;
    this.frontError = null;
    this.loadingMore = false;
    this.fetchedAt = 0;
    this.seq = 0;
    this.retries = 0;
    this.creating = null;
    this.boxes = new Map();
    this.menus = new Map();
    this.replyPages = new Map();
    this.bodies = new Map();

    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [sheet];
    this.main = h("main", { class: "w-full mx-auto", "data-theme": schemeName() });
    root.append(h("div", { id: "gsc-body", dir: this.i18n.dir }, h("div", { id: "__next" }, this.main)));
    this.root = root;
    // Read once; dropping the attribute also tells the light/dark copy this
    // element now has a shadow root to mirror.
    host.removeAttribute("data-giscus");

    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("input", (e) => this.onInput(e));
    root.addEventListener("keydown", (e) => this.onKeydown(e));
    root.addEventListener("toggle", (e) => this.onToggle(e), true);
    for (const type of ["mouseover", "mouseout", "focusin", "focusout"]) root.addEventListener(type, (e) => this.onHover(e));
  }

  get apiBase() {
    return auth()?.apiBase || "";
  }

  get loginUrl() {
    return auth() ? auth().getLoginUrl() : "https://giscus.app";
  }

  box(key) {
    let box = this.boxes.get(key);
    if (!box) {
      box = { key, input: "", lastInput: "", preview: "", isPreview: false, isLoading: false, isSubmitting: false, isReplyOpen: false, isFixedWidth: false, lastHeight: "", focus: false };
      this.boxes.set(key, box);
    }
    return box;
  }

  menu(key) {
    let menu = this.menus.get(key);
    if (!menu) this.menus.set(key, (menu = { isOpen: false, current: null, isSubmitting: false }));
    return menu;
  }

  body(html) {
    let out = this.bodies.get(html);
    if (out == null) this.bodies.set(html, (out = processCommentBody(html)));
    return out;
  }

  /* ─── lifecycle ─────────────────────────────────────────────────────────── */

  async start() {
    if (this.started) return;
    this.started = true;
    defineMathRenderer();
    await this.signIn();
    this.ready = true;
    this.render();
    this.load();
  }

  async signIn() {
    const a = auth();
    this.token = a && a.isAuthenticated ? (await a.getToken()) || null : null;
  }

  dispose() {
    this.seq++;
    clearTimeout(this.retryTimer);
    widgets.delete(this);
  }

  fresh() {
    return Date.now() - this.fetchedAt < (this.token ? FRESH_SIGNED_IN : FRESH_ANONYMOUS);
  }

  /* ─── data (giscus's useFrontBackDiscussion) ────────────────────────────── */

  async read(number) {
    const c = this.c;
    if (this.token) {
      const [back, front] = await api.loadDirect(c, this.token, number);
      const pages = [front];
      for (let i = 1; i < this.size; i++) {
        const info = pages[i - 1].discussion.pageInfo;
        if (!info.hasNextPage) break;
        pages.push(await api.loadDirectPage(c, this.token, number, info.endCursor));
      }
      return [back, pages];
    }
    const base = this.apiBase;
    const back = await api.loadProxied(base, c, number, { last: 15 });
    const pages = [];
    // The oldest window only matters when the newest does not reach the start.
    if (back.discussion?.pageInfo?.hasPreviousPage) {
      pages.push(await api.loadProxied(base, c, number, { first: 15 }));
      for (let i = 1; i < this.size; i++) {
        const info = pages[i - 1].discussion.pageInfo;
        if (!info.hasNextPage) break;
        pages.push(await api.loadProxied(base, c, number, { after: info.endCursor }));
      }
    }
    return [back, pages];
  }

  async load() {
    const seq = ++this.seq;
    clearTimeout(this.retryTimer);
    let number = api.knownNumber(this.c);
    try {
      let result;
      try {
        result = await this.read(number);
      } catch (e) {
        // A remembered number that no longer resolves: find it by term again.
        if (e.status !== 404 || !number || this.c.number) throw e;
        api.rememberNumber(this.c, null);
        number = 0;
        result = await this.read(0);
      }
      if (seq !== this.seq) return;
      [this.backData, this.frontPages] = result;
      this.backError = this.frontError = null;
      this.retries = 0;
      api.rememberNumber(this.c, this.backData.discussion?.url);
    } catch (e) {
      if (seq !== this.seq) return;
      this.backError = e;
      if (e.status === 401) return void this.signOut();
      if (![403, 404, 429].includes(e.status) && this.retries < RETRIES) {
        const delay = 5000 * 2 ** this.retries++;
        this.retryTimer = setTimeout(() => this.load(), delay);
      }
      if (e.status !== 404) console.error(`[giscus] An error occurred. Error message: "${e.message}".`);
    }
    this.fetchedAt = Date.now();
    this.loaded = true;
    this.render();
  }

  async increaseSize() {
    const last = this.frontPages[this.frontPages.length - 1];
    const info = last?.discussion?.pageInfo;
    this.size++;
    if (!info?.hasNextPage) return void this.render();
    this.loadingMore = true;
    this.render();
    const seq = this.seq;
    try {
      const number = api.knownNumber(this.c);
      const page = this.token
        ? await api.loadDirectPage(this.c, this.token, number, info.endCursor)
        : await api.loadProxied(this.apiBase, this.c, number, { after: info.endCursor });
      if (seq === this.seq) this.frontPages = [...this.frontPages, page];
    } catch (e) {
      this.frontError = e;
    }
    this.loadingMore = false;
    this.render();
  }

  derive() {
    const back = this.backData;
    const intersect = back?.discussion?.comments?.[0]?.id;
    const front = this.frontPages.map((page) => {
      let found = false;
      const comments = (page?.discussion?.comments || []).filter((c) => {
        if (c.id === intersect) found = true;
        return !found;
      });
      return { ...page, discussion: { ...page?.discussion, comments, totalReplyCount: comments.reduce((n, c) => n + c.replyCount, 0) } };
    });
    let backComments = back?.discussion?.comments || [];
    let frontComments = front.flatMap((p) => p.discussion.comments || []);
    let backList = "back";
    let frontList = "front";
    if (this.orderBy === "newest") {
      [frontComments, backComments] = [backComments.slice().reverse(), frontComments.slice().reverse()];
      [frontList, backList] = ["back", "front"];
    }
    const error = this.frontError || this.backError;
    const discussion = back?.discussion || {};
    const needsFront = discussion.pageInfo?.hasPreviousPage;
    return {
      backData: back,
      frontComments,
      backComments,
      frontList,
      backList,
      numHidden: discussion.totalCommentCount - discussion.comments?.length - front.reduce((n, g) => n + g.discussion.comments.length, 0),
      reactionCount: discussion.reactionCount,
      totalCommentCount: discussion.totalCommentCount,
      totalReplyCount: (discussion.totalReplyCount || 0) + front.reduce((n, g) => n + g.discussion.totalReplyCount, 0),
      error,
      isLoading: !this.loaded || (!!needsFront && !this.frontPages.length && !error),
      isLoadingMore: this.loadingMore,
      isNotFound: error?.status === 404,
      isRateLimited: error?.status === 429,
      isLocked: discussion.locked,
      discussion,
    };
  }

  /* ─── writes (optimistic, then revalidated, as SWR's mutate does) ───────── */

  pagesOf(list) {
    return list === "back" ? (this.backData ? [this.backData] : []) : this.frontPages;
  }

  setPages(list, pages) {
    if (list === "back") this.backData = pages[0] || null;
    else this.frontPages = pages;
  }

  mapComments(list, fn) {
    this.setPages(
      list,
      this.pagesOf(list).map((page) => ({ ...page, discussion: { ...page.discussion, comments: page.discussion.comments.map(fn) } })),
    );
  }

  addNewComment(comment) {
    api.rememberNumber(this.c, comment.url);
    if (this.backData) {
      const d = this.backData.discussion;
      this.backData = { ...this.backData, discussion: { ...d, comments: [...(d?.comments || []), comment] } };
      this.render();
    }
    this.load();
  }

  addNewReply(list, reply) {
    this.mapComments(list, (c) => (c.id === reply.replyToId ? { ...c, replies: [...c.replies, reply] } : c));
    this.render();
    this.load();
  }

  settle(promise) {
    promise.then(
      () => this.load(),
      (e) => this.fail(e),
    );
  }

  onReact(o, content, promise) {
    if (o.kind === "discussion") {
      if (this.backData) {
        const d = this.backData.discussion;
        const [reactions, diff] = updateReactionGroups(d.reactions, content);
        this.backData = { ...this.backData, discussion: { ...d, reactionCount: d.reactionCount + diff, reactions } };
        this.render();
      }
    } else if (o.kind === "comment") {
      this.mapComments(o.list, (c) => (c.id === o.item.id ? reacted(o.item, content) : c));
      this.render();
    } else {
      this.mapComments(o.list, (c) =>
        c.id === o.item.replyToId ? { ...c, replies: c.replies.map((r) => (r.id === o.item.id ? reacted(o.item, content) : r)) } : c,
      );
      this.render();
    }
    this.settle(promise);
  }

  async createDiscussionRequest() {
    const c = this.c;
    this.creating ||= api.createDiscussion(this.apiBase, this.token, c.repo, {
      repositoryId: c.repoId,
      categoryId: c.categoryId,
      title: c.term,
      body: `# ${c.term}\n\n${c.description || ""}\n\n${cleanAnchor(c.backLink || c.origin)}`,
    });
    const id = await this.creating.catch(() => null);
    if (id && !api.knownNumber(c)) api.rememberNumber(c, await api.discussionUrl(id, this.token).catch(() => null));
    this.load();
    return id;
  }

  async react(o, content) {
    const menu = this.menu(o.key);
    if (menu.isSubmitting || (!o.subjectId && !o.create)) return;
    menu.isSubmitting = !o.subjectId;
    this.render();
    const id = o.subjectId || (await this.createDiscussionRequest());
    const promise = api.toggleReaction(content, id, this.token, !!o.groups?.[content]?.viewerHasReacted).finally(() => {
      menu.isSubmitting = false;
    });
    this.onReact(o, content, promise);
  }

  async submit(f) {
    const box = f.box;
    if (box.isSubmitting || (!f.discussionId && !f.create)) return;
    box.isSubmitting = true;
    this.render();
    const id = f.discussionId || (await this.createDiscussionRequest());
    if (!id) {
      window.alert("Unable to create discussion.");
      box.isSubmitting = false;
      return void this.render();
    }
    try {
      if (f.replyToId) this.addNewReply(f.list, await api.addReply(box.input, id, f.replyToId, this.token));
      else this.addNewComment(await api.addComment(box.input, id, this.token));
      Object.assign(box, { input: "", preview: "", isPreview: false, isSubmitting: false, isReplyOpen: false });
    } catch (e) {
      box.isSubmitting = false;
      this.fail(e);
    }
    this.render();
  }

  preview(box) {
    if (!box.isPreview || box.input === box.lastInput) return;
    if (box.input) {
      box.isLoading = true;
      const input = box.input;
      api.renderMarkdown(input, this.token, this.c.repo).then(
        (html) => {
          box.preview = processCommentBody(html);
          box.isLoading = false;
          this.render();
        },
        () => {
          box.isLoading = false;
          this.render();
        },
      );
    }
    box.lastInput = box.input;
  }

  fail(e) {
    if (e?.status === 401) return void this.signOut();
    console.error(`[giscus] An error occurred. Error message: "${e?.message}".`);
    this.load();
  }

  signOut() {
    auth()?.logout();
  }

  /* ─── events ────────────────────────────────────────────────────────────── */

  actOf(e) {
    for (const el of e.composedPath()) {
      if (el === this.root) break;
      if (el.__act) return [el.__act, el];
    }
    return [null, null];
  }

  onClick(e) {
    const [act, el] = this.actOf(e);
    if (!act) return;
    switch (act.type) {
      case "body":
        return handleCommentClick(e, el);
      case "order":
        this.orderBy = act.order;
        break;
      case "more":
        return void this.increaseSize();
      case "replies":
        this.replyPages.set(act.id, (this.replyPages.get(act.id) || 0) + 1);
        break;
      case "replyOpen":
        act.box.isReplyOpen = true;
        act.box.focus = true;
        break;
      case "replyClose":
        act.box.isReplyOpen = false;
        break;
      case "tab":
        act.box.isPreview = act.preview;
        this.preview(act.box);
        break;
      case "fixed":
        act.box.isFixedWidth = !act.box.isFixedWidth;
        act.box.focus = true;
        break;
      case "signOut":
        return void this.signOut();
      case "signIn":
        try {
          sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ y: scrollY, at: Date.now(), href: this.c.origin }));
        } catch (err) {}
        return;
      case "react":
        return void this.react(act.o, act.content);
      case "pick":
        this.menu(act.o.key).isOpen = false;
        this.react(act.o, act.content);
        break;
      default:
        return;
    }
    this.render();
  }

  onSubmit(e) {
    const [act] = this.actOf(e);
    if (act?.type !== "box") return;
    e.preventDefault();
    this.submit(act);
  }

  onInput(e) {
    const [act, el] = this.actOf(e);
    if (act?.type !== "text") return;
    const box = act.box;
    box.input = el.value;
    // Only resized while nobody has dragged it to a height of their own.
    if (!box.lastHeight || box.lastHeight === el.style.height) {
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 270)}px`;
      box.lastHeight = el.style.height;
    }
    const submit = el.form?.querySelector("button[type=submit]");
    if (submit) submit.disabled = !box.input.trim() || box.isSubmitting;
  }

  onKeydown(e) {
    const [act] = this.actOf(e);
    if (act?.type === "text" && (e.ctrlKey || e.metaKey) && e.key === "Enter") this.submit(act);
  }

  onToggle(e) {
    const [act, el] = this.actOf(e);
    if (act?.type !== "menu" || e.target !== el) return;
    const menu = this.menu(act.o.key);
    if (menu.isOpen === el.open) return;
    menu.isOpen = el.open;
    this.render();
  }

  // React's onMouseEnter/Leave: moving within one emoji button is not leaving it.
  onHover(e) {
    const [act, el] = this.actOf(e);
    if (act?.type !== "pick") return;
    const leaving = e.type === "mouseout" || e.type === "focusout";
    if (leaving && e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    const menu = this.menu(act.o.key);
    const next = leaving ? null : act.content;
    if (menu.current === next) return;
    menu.current = next;
    this.render();
  }

  // A press anywhere outside an open picker closes it.
  onOutside(e) {
    let changed = false;
    const path = e.composedPath();
    for (const el of this.root.querySelectorAll("details.gsc-reactions-menu[open]")) {
      if (path.includes(el)) continue;
      const menu = el.__act && this.menu(el.__act.o.key);
      if (menu?.isOpen) {
        menu.isOpen = false;
        changed = true;
      }
    }
    if (changed) this.render();
  }

  /* ─── render ────────────────────────────────────────────────────────────── */

  render() {
    const next = h("main", null, this.ready && (this.c.term || this.c.number) && this.c.repo ? renderGiscus(this) : null);
    morphChildren(this.main, next);
    for (const area of this.root.querySelectorAll("textarea")) {
      const box = area.__own;
      if (!box) continue;
      if (area.value !== box.input) area.value = box.input;
      if (box.focus) {
        box.focus = false;
        area.focus();
      }
    }
  }
}

/* ─── page wiring ─────────────────────────────────────────────────────────── */

// Back from signing in (blogAuth has taken the session out of the URL): where
// the reader was, as giscus's client restored it.
function restoreScroll() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "null");
    if (!saved) return;
    sessionStorage.removeItem(SCROLL_KEY);
    if (Date.now() - saved.at > 600000 || !auth()?.isAuthenticated || saved.href !== cleanedLocation()) return;
    requestAnimationFrame(() => window.scrollTo({ top: saved.y, behavior: "instant" }));
  } catch (e) {}
}

/** Every page view: widgets of pages left behind go, this page's are made. */
export function init() {
  for (const w of [...widgets]) if (!w.host.isConnected) w.dispose();
  const hosts = document.querySelectorAll(HOSTS);
  if (!hosts.length) return;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
  }
  observer ||= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        for (const w of widgets) if (w.host === entry.target) w.start();
      }
    },
    { rootMargin: MARGIN },
  );
  for (const host of hosts) {
    let raw;
    try {
      raw = JSON.parse(host.getAttribute("data-giscus"));
    } catch (e) {
      continue;
    }
    const w = new Widget(host, raw);
    widgets.add(w);
    w.render();
    observer.observe(host);
  }
  restoreScroll();
}

window.addEventListener("redefine:color-scheme-change", (e) => {
  const name = e.detail?.isDark ? "dark" : "light";
  for (const w of widgets) w.main.setAttribute("data-theme", name);
});

window.addEventListener("blog:auth-change", () => {
  for (const w of widgets) {
    if (!w.started) continue;
    w.signIn().then(() => {
      w.render();
      w.load();
    });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  for (const w of widgets) if (w.loaded && !w.fresh()) w.load();
});

window.addEventListener("online", () => {
  for (const w of widgets) if (w.loaded) w.load();
});

document.addEventListener(
  "click",
  (e) => {
    for (const w of widgets) w.onOutside(e);
  },
  true,
);
