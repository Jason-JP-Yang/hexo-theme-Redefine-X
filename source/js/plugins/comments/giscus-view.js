/**
 * giscus's widget markup (components/*.tsx in dev/giscus), rendered from a
 * widget's state and patched onto the live tree, so a reply being typed, an
 * open picker or a focused field survive every update the way they do in
 * giscus's own tree. What a press does rides on the element as `__act`;
 * plugins/comments/giscus.js handles it.
 */

const SVG = "http://www.w3.org/2000/svg";

export const REACTIONS = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

const ICONS = {
  "arrow-up":
    "M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z",
  "kebab-horizontal":
    "M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  markdown:
    "M14.85 3c.63 0 1.15.52 1.14 1.15v7.7c0 .63-.51 1.15-1.15 1.15H1.15C.52 13 0 12.48 0 11.84V4.15C0 3.52.52 3 1.15 3ZM9 11V5H7L5.5 7 4 5H2v6h2V8l1.5 1.92L7 8v3Zm2.99.5L14.5 8H13V5h-2v3H9.5Z",
  "mark-github":
    "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z",
  "sign-out":
    "M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 2 13.25Zm10.44 4.5-1.97-1.97a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.97-1.97H6.75a.75.75 0 0 1 0-1.5Z",
  typography:
    "M6.71 10H2.332l-.874 2.498a.75.75 0 0 1-1.415-.496l3.39-9.688a1.217 1.217 0 0 1 2.302.018l3.227 9.681a.75.75 0 0 1-1.423.474Zm3.13-4.358C10.53 4.374 11.87 4 13 4c1.5 0 3 .939 3 2.601v5.649a.75.75 0 0 1-1.448.275C13.995 12.82 13.3 13 12.5 13c-.77 0-1.514-.231-2.078-.709-.577-.488-.922-1.199-.922-2.041 0-.694.265-1.411.887-1.944C11 7.78 11.88 7.5 13 7.5h1.5v-.899c0-.54-.5-1.101-1.5-1.101-.869 0-1.528.282-1.84.858a.75.75 0 1 1-1.32-.716ZM6.21 8.5 4.574 3.594 2.857 8.5Zm8.29.5H13c-.881 0-1.375.22-1.637.444-.253.217-.363.5-.363.806 0 .408.155.697.39.896.249.21.63.354 1.11.354.732 0 1.26-.209 1.588-.449.35-.257.412-.495.412-.551Z",
  smiley:
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.82 1.636a.75.75 0 0 1 1.038.175l.007.009c.103.118.22.222.35.31.264.178.683.37 1.285.37.602 0 1.02-.192 1.285-.371.13-.088.247-.192.35-.31l.007-.008a.75.75 0 0 1 1.222.87l-.022-.015c.02.013.021.015.021.015v.001l-.001.002-.002.003-.005.007-.014.019a2.066 2.066 0 0 1-.184.213c-.16.166-.338.316-.53.445-.63.418-1.37.638-2.127.629-.946 0-1.652-.308-2.126-.63a3.331 3.331 0 0 1-.715-.657l-.014-.02-.005-.006-.002-.003v-.002h-.001l.613-.432-.614.43a.75.75 0 0 1 .183-1.044ZM12 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM5 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm5.25 2.25.592.416a97.71 97.71 0 0 0-.592-.416Z",
};

const COPY_BUTTON_HTML = `
<div class="zeroclipboard-container position-absolute right-0 top-0">
  <button aria-label="Copy" class="ClipboardButton btn js-clipboard-copy m-2 p-0 tooltipped-no-delay" data-copy-feedback="Copied!" tabindex="0" role="button">
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-copy js-clipboard-copy-icon m-2">
      <path fill-rule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"></path><path fill-rule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"></path>
    </svg>
    <svg aria-hidden="true" viewBox="0 0 16 16" version="1.1" height="16" width="16" class="octicon octicon-check js-clipboard-check-icon color-text-success d-none m-2">
      <path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path>
    </svg>
  </button>
</div>`;

/* ─── elements ────────────────────────────────────────────────────────────── */

export function h(tag, props, ...kids) {
  const el = tag === "svg" || tag === "path" ? document.createElementNS(SVG, tag) : document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "key") el.__key = v;
      else if (k === "act") el.__act = v;
      else if (k === "html") el.__html = v;
      else if (k === "own") el.__own = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(typeof kid === "object" ? kid : String(kid));
  }
  if (el.__html != null) el.innerHTML = el.__html;
  return el;
}

function octicon(name, className = "") {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      focusable: "false",
      class: `octicon octicon-${name} ${className}`.trim(),
      viewBox: "0 0 16 16",
      width: "16",
      height: "16",
      fill: "currentColor",
      display: "inline-block",
      overflow: "visible",
      style: "vertical-align: text-bottom;",
    },
    h("path", { d: ICONS[name] }),
  );
}

/* ─── patching ────────────────────────────────────────────────────────────── */

// Makes `live` look like `next`, keeping every element that can stay.
export function morph(live, next) {
  if (live.nodeType !== next.nodeType || live.nodeName !== next.nodeName || live.__key !== next.__key) {
    live.replaceWith(next);
    return next;
  }
  if (live.nodeType !== 1) {
    if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue;
    return live;
  }
  // A text field owns its value and the height it was dragged to.
  const owned = next.__own;
  for (const name of live.getAttributeNames()) {
    if (!next.hasAttribute(name) && !(owned && name === "style")) live.removeAttribute(name);
  }
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name);
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  }
  live.__act = next.__act;
  live.__own = owned;
  if (owned) return live;
  if (next.__html != null) {
    if (live.__html !== next.__html) {
      live.innerHTML = next.__html;
      live.__html = next.__html;
    }
    return live;
  }
  live.__html = null;
  morphChildren(live, next);
  return live;
}

export function morphChildren(parent, next) {
  const pool = new Map();
  for (let c = parent.firstChild; c; c = c.nextSibling) if (c.__key != null) pool.set(c.__key, c);
  let pos = parent.firstChild;
  for (const want of [...next.childNodes]) {
    let have = null;
    if (want.__key != null) {
      have = pool.get(want.__key) || null;
      pool.delete(want.__key);
    } else {
      let c = pos;
      while (c && c.__key != null) c = c.nextSibling;
      if (c && c.nodeName === want.nodeName) have = c;
    }
    if (have && have === pos) pos = pos.nextSibling;
    const node = have ? morph(have, want) : want;
    if (node.parentNode !== parent || node.nextSibling !== pos) parent.insertBefore(node, pos);
  }
  while (pos) {
    const n = pos.nextSibling;
    pos.remove();
    pos = n;
  }
}

/* ─── comment bodies (lib/adapter.ts) ─────────────────────────────────────── */

const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "noscript", "template"]);
const URLISH = /^(href|src|xlink:href|action|formaction|poster|background)$/i;

// GitHub's HTML is sanitized already; a second pass for running in this origin.
function sanitize(root) {
  for (const el of root.querySelectorAll("*")) {
    if (DROP.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || (URLISH.test(name) && /^\s*(javascript|vbscript|data):/i.test(value) && !/^\s*data:image\//i.test(value))) {
        el.removeAttribute(name);
      }
    }
  }
}

export function processCommentBody(bodyHTML) {
  const template = document.createElement("template");
  template.innerHTML = bodyHTML;
  const content = template.content;
  sanitize(content);
  content.querySelectorAll(":not(.email-hidden-toggle) > a").forEach((a) => {
    // An anchor into this page stays one.
    if ((a.getAttribute("href") || "").startsWith("#")) return;
    a.rel = "noopener noreferrer nofollow";
    a.target = "_top";
  });
  content.querySelectorAll("a.commit-tease-sha").forEach((a) => (a.href = "https://github.com" + a.pathname));
  content.querySelectorAll(".snippet-clipboard-content, .highlight:not(.js-file-line-container)").forEach((div) => {
    div.classList.add("position-relative");
    div.classList.remove("overflow-auto");
    const copy = document.createElement("template");
    copy.innerHTML = COPY_BUTTON_HTML.trim();
    div.appendChild(copy.content.firstChild);
  });
  return template.innerHTML;
}

export function handleCommentClick(event, box) {
  const target = event.composedPath()[0];
  if (!(target instanceof Element)) return;
  const toggle = target.closest(".email-hidden-toggle a");
  if (toggle && box.contains(toggle)) {
    event.preventDefault();
    target.closest("div")?.querySelector(".email-hidden-reply")?.classList.toggle("expanded");
  }
  const container = target.closest(".snippet-clipboard-content, .highlight");
  const button = target.closest("button.ClipboardButton");
  if (container && button && box.contains(button)) {
    event.preventDefault();
    const text = container.dataset.snippetClipboardCopyContent || container.querySelector("pre")?.textContent || "";
    navigator.clipboard.writeText(text).then(() => {
      const copyIcon = button.querySelector("svg.js-clipboard-copy-icon");
      const checkIcon = button.querySelector("svg.js-clipboard-check-icon");
      copyIcon.classList.add("d-none");
      checkIcon.classList.remove("d-none");
      setTimeout(() => {
        copyIcon.classList.remove("d-none");
        checkIcon.classList.add("d-none");
      }, 2000);
    });
  }
}

/* ─── components ──────────────────────────────────────────────────────────── */

const external = { rel: "nofollow noopener noreferrer", target: "_blank" };

function popupInfo(w, menu) {
  const { t } = w.i18n;
  if (menu.isSubmitting) return h("p", { class: "m-2" }, t("pleaseWait"));
  if (!w.token) {
    return h(
      "p",
      { class: "m-2" },
      w.i18n.trans("signInToAddYourReaction", {
        a: (text) => h("a", { href: w.loginUrl, class: "color-text-link", target: "_top", act: { type: "signIn" } }, text),
      }),
    );
  }
  return h("p", { class: "overflow-hidden text-ellipsis whitespace-nowrap m-2" }, menu.current ? t(menu.current) : t("pickYourReaction"));
}

function reactButtons(w, o) {
  const { t } = w.i18n;
  const token = w.token;
  const menu = w.menu(o.key);
  const groups = o.groups || {};
  const position = o.popoverPosition || "bottom";
  const direct = Object.entries(groups)
    .filter(([, g]) => g.count > 0)
    .map(([key, { count, viewerHasReacted }]) => {
      const people = t("peopleReactedWith", { count, reaction: t(key), emoji: t("emoji") });
      return h(
        "button",
        {
          key,
          class: `gsc-direct-reaction-button gsc-social-reaction-summary-item ${viewerHasReacted ? "has-reacted" : ""}${!token ? " cursor-not-allowed" : ""}`,
          disabled: !token,
          "aria-label": token ? t("addTheReaction", { reaction: t(key) }) : t("youMustBeSignedInToAddReactions"),
          title: token ? people : t("youMustBeSignedInToAddReactions"),
          act: { type: "react", o, content: key },
        },
        h("span", { class: "gsc-direct-reaction-button-emoji" }, REACTIONS[key]),
        h("span", { class: "gsc-social-reaction-summary-item-count", title: people }, count),
      );
    });
  return [
    h(
      "details",
      { class: "gsc-reactions-menu", open: menu.isOpen, act: { type: "menu", o } },
      h("summary", { "aria-label": t("addReactions"), class: "link-secondary gsc-reactions-button gsc-social-reaction-summary-item " }, octicon("smiley")),
      h(
        "div",
        { class: `color-border-primary color-text-secondary color-bg-overlay gsc-reactions-popover ${position} ${menu.isOpen ? " open" : ""} left` },
        popupInfo(w, menu),
        h("div", { class: "color-border-primary my-2 border-t" }),
        h(
          "div",
          { class: "m-2" },
          Object.entries(REACTIONS).map(([key, emoji]) => {
            const hasReacted = groups[key]?.viewerHasReacted;
            return h(
              "button",
              {
                key,
                "aria-label": t(hasReacted ? "removeTheReaction" : "addTheReaction", { reaction: t(key) }),
                type: "button",
                class: `gsc-emoji-button${hasReacted ? " has-reacted color-bg-info color-border-tertiary" : ""}${!token ? " no-token" : ""}`,
                disabled: !token,
                act: { type: "pick", o, content: key },
              },
              h("span", { class: "gsc-emoji" }, emoji),
            );
          }),
        ),
      ),
    ),
    h("div", { class: "gsc-direct-reaction-buttons" }, direct),
  ];
}

function commentBox(w, box, f) {
  const { t } = w.i18n;
  const token = w.token;
  const isReply = !!f.replyToId;
  if (isReply && !box.isReplyOpen) {
    return h(
      "div",
      { class: "color-bg-tertiary gsc-reply-box" },
      h(
        "button",
        {
          class: "form-control color-text-secondary color-border-primary w-full cursor-text rounded border px-2 py-1 text-left focus:border-transparent",
          type: "button",
          act: { type: "replyOpen", box },
        },
        t("writeAReply"),
      ),
    );
  }
  const tab = (preview, extra) =>
    h(
      "button",
      {
        class: `${extra}rounded-t border border-b-0 px-4 py-2 ${box.isPreview === preview ? "color-text-primary color-bg-canvas color-border-primary" : "color-text-secondary border-transparent"}`,
        type: "button",
        act: { type: "tab", box, preview },
      },
      t(preview ? "preview" : "write"),
    );
  return h(
    "form",
    { class: `color-bg-primary color-border-primary gsc-comment-box ${isReply ? "gsc-comment-box-is-reply" : ""} `, act: { type: "box", box, ...f } },
    h(
      "div",
      { class: "color-bg-tertiary color-border-primary gsc-comment-box-tabs" },
      h("div", { class: "mx-2 mb-[-1px] mt-2" }, tab(false, ""), tab(true, "ml-1 ")),
      !box.isPreview
        ? h(
            "div",
            { class: "gsc-comment-box-md-toolbar" },
            h(
              "button",
              {
                class: "gsc-toolbar-item",
                type: "button",
                title: box.isFixedWidth ? t("disableFixedWidth") : t("enableFixedWidth"),
                tabindex: "-1",
                act: { type: "fixed", box },
              },
              octicon("typography"),
            ),
          )
        : null,
    ),
    h(
      "div",
      { class: "gsc-comment-box-main" },
      box.isPreview
        ? h(
            "div",
            {
              class: "markdown color-border-primary gsc-comment-box-preview",
              html: box.isLoading ? null : box.preview || t("nothingToPreview"),
              act: { type: "body" },
            },
            box.isLoading ? t("loadingPreview") : null,
          )
        : h(
            "div",
            { class: "gsc-comment-box-write" },
            h("textarea", {
              class: `form-control input-contrast gsc-comment-box-textarea ${box.isFixedWidth ? "gsc-is-fixed-width" : ""}`,
              dir: "auto",
              placeholder: token ? (isReply ? t("writeAReply") : t("writeAComment")) : t("signInToComment"),
              disabled: !token || box.isSubmitting,
              own: box,
              act: { type: "text", box, ...f },
            }),
            h(
              "div",
              { class: "form-control input-contrast gsc-comment-box-textarea-extras" },
              h(
                "a",
                {
                  class: "link-secondary gsc-comment-box-markdown-hint flex gap-2",
                  ...external,
                  href: "https://guides.github.com/features/mastering-markdown/",
                  title: t("stylingWithMarkdownIsSupported"),
                },
                octicon("markdown", "mr-1"),
              ),
            ),
          ),
    ),
    h(
      "div",
      { class: "gsc-comment-box-bottom" },
      token && !isReply
        ? h("button", { type: "button", class: "link-secondary text-sm", act: { type: "signOut" } }, octicon("sign-out", "mr-2"), t("signOut"))
        : null,
      h(
        "div",
        { class: "gsc-comment-box-buttons" },
        isReply ? h("button", { class: "btn ml-1 rounded-md border", type: "button", act: { type: "replyClose", box } }, t("cancel")) : null,
        token
          ? h(
              "button",
              { class: "btn btn-primary items-center ml-1 rounded-md border", type: "submit", disabled: !box.input.trim() || box.isSubmitting },
              isReply ? t("reply") : t("comment"),
            )
          : h(
              "a",
              {
                class: "btn btn-primary inline-flex items-center ml-1 rounded-md border hover:no-underline",
                target: "_top",
                href: w.loginUrl,
                act: { type: "signIn" },
              },
              octicon("mark-github", "mr-2"),
              " ",
              t("signInWithGitHub"),
            ),
      ),
    ),
  );
}

function reply(w, r, list) {
  const { t, formatDate, formatRelative } = w.i18n;
  const hidden = r.deletedAt || r.isMinimized;
  return h(
    "div",
    { class: "gsc-reply", key: r.id },
    h("div", { class: "gsc-tl-line" }),
    h(
      "div",
      { class: `flex ${hidden ? "items-center" : ""}` },
      h(
        "div",
        { class: "gsc-reply-author-avatar" },
        h(
          "a",
          { ...external, href: r.author.url, class: "flex items-center" },
          h("img", { class: "rounded-full", src: r.author.avatarUrl, width: "30", height: "30", alt: `@${r.author.login}`, loading: "lazy" }),
        ),
      ),
      h(
        "div",
        { class: "w-full min-w-0 ml-2" },
        !hidden
          ? h(
              "div",
              { class: "gsc-reply-header" },
              h(
                "div",
                { class: "gsc-reply-author" },
                h(
                  "a",
                  { ...external, href: r.author.url, class: "flex min-w-0 items-center" },
                  h("span", { class: "link-primary overflow-hidden text-ellipsis font-semibold" }, r.author.login),
                ),
                h(
                  "a",
                  { ...external, href: r.url, class: "link-secondary overflow-hidden text-ellipsis" },
                  h("time", { class: "whitespace-nowrap", title: formatDate(r.createdAt), datetime: r.createdAt }, formatRelative(r.createdAt)),
                ),
                r.authorAssociation !== "NONE"
                  ? h(
                      "div",
                      { class: "hidden text-xs leading-[18px] sm:inline-flex" },
                      h("span", { class: "color-box-border-info font-medium capitalize rounded-xl border px-[7px]" }, t(r.authorAssociation)),
                    )
                  : null,
              ),
              r.lastEditedAt
                ? h("button", { class: "color-text-secondary gsc-reply-edited", title: t("lastEditedAt", { date: r.lastEditedAt }) }, t("edited"))
                : null,
            )
          : null,
        h(
          "div",
          { dir: "auto", class: `markdown gsc-reply-content ${hidden ? " not-shown" : ""}`, html: hidden ? null : w.body(r.bodyHTML), act: { type: "body" } },
          hidden ? h("em", { class: "color-text-secondary" }, r.deletedAt ? t("thisCommentWasDeleted") : t("thisCommentWasHidden")) : null,
        ),
        !hidden
          ? h(
              "div",
              { class: "gsc-reply-footer" },
              h(
                "div",
                { class: "gsc-reply-reactions" },
                reactButtons(w, { key: r.id, subjectId: r.id, groups: r.reactions, kind: "reply", list, item: r, popoverPosition: "top" }),
              ),
            )
          : null,
      ),
    ),
  );
}

function comment(w, c, list, canReply, discussionId) {
  const { t, formatDate, formatRelative } = w.i18n;
  const backPage = w.replyPages.get(c.id) || 0;
  const replies = c.replies.slice(-5 - backPage * 50);
  const remaining = c.replyCount - replies.length;
  const hasNextPage = replies.length < c.replies.length;
  const hasUnfetched = !hasNextPage && remaining > 0;
  const hidden = !!c.deletedAt || c.isMinimized;
  const replyBox = canReply ? commentBox(w, w.box(c.id), { discussionId, replyToId: c.id, list }) : null;
  return h(
    "div",
    { class: "gsc-comment", key: c.id },
    h(
      "div",
      { class: `color-bg-primary w-full min-w-0 rounded-md border ${c.viewerDidAuthor ? "color-box-border-info" : "color-border-primary"}` },
      !c.isMinimized
        ? h(
            "div",
            { class: "gsc-comment-header" },
            h(
              "div",
              { class: "gsc-comment-author" },
              h(
                "a",
                { ...external, href: c.author.url, class: "gsc-comment-author-avatar" },
                h("img", { class: "mr-2 rounded-full", src: c.author.avatarUrl, width: "30", height: "30", alt: `@${c.author.login}`, loading: "lazy" }),
                h("span", { class: "link-primary overflow-hidden text-ellipsis font-semibold" }, c.author.login),
              ),
              h(
                "a",
                { ...external, href: c.url, class: "link-secondary overflow-hidden text-ellipsis" },
                h("time", { class: "whitespace-nowrap", title: formatDate(c.createdAt), datetime: c.createdAt }, formatRelative(c.createdAt)),
              ),
              c.authorAssociation !== "NONE"
                ? h(
                    "div",
                    { class: "hidden text-xs leading-[18px] sm:inline-flex" },
                    h("span", { class: "color-box-border-info font-medium capitalize ml-1 rounded-xl border px-[7px]" }, t(c.authorAssociation)),
                  )
                : null,
            ),
            c.lastEditedAt
              ? h("button", { class: "color-text-secondary gsc-comment-edited", title: t("lastEditedAt", { date: formatDate(c.lastEditedAt) }) }, t("edited"))
              : null,
          )
        : null,
      h(
        "div",
        {
          dir: "auto",
          class: `markdown gsc-comment-content${c.isMinimized ? " minimized color-bg-tertiary border-color-primary" : ""}`,
          html: hidden ? null : w.body(c.bodyHTML),
          act: { type: "body" },
        },
        hidden ? h("em", { class: "color-text-secondary" }, c.deletedAt ? t("thisCommentWasDeleted") : t("thisCommentWasMinimized")) : null,
      ),
      !c.isMinimized
        ? h(
            "div",
            { class: "gsc-comment-footer" },
            h(
              "div",
              { class: "gsc-comment-reactions" },
              // Disabled in giscus until GitHub allows upvotes with app-issued tokens.
              h(
                "button",
                {
                  type: "button",
                  class: `gsc-upvote-button gsc-social-reaction-summary-item ${c.viewerHasUpvoted ? "has-reacted" : ""}`,
                  disabled: true,
                  "aria-label": w.token ? t("upvote") : t("youMustBeSignedInToUpvote"),
                  title: w.token ? t("upvotes", { count: c.upvoteCount }) : t("youMustBeSignedInToUpvote"),
                },
                octicon("arrow-up", "gsc-direct-reaction-button-emoji"),
                h("span", { class: "gsc-social-reaction-summary-item-count", title: t("upvotes", { count: c.upvoteCount }) }, c.upvoteCount),
              ),
              !hidden
                ? reactButtons(w, { key: c.id, subjectId: c.id, groups: c.reactions, kind: "comment", list, item: c, popoverPosition: "top" })
                : null,
            ),
            h("div", { class: "gsc-comment-replies-count" }, h("span", { class: "color-text-tertiary text-xs" }, t("replies", { count: c.replyCount, plus: "" }))),
          )
        : null,
      c.replies.length > 0
        ? h(
            "div",
            { class: `color-bg-inset color-border-primary gsc-replies ${!replyBox || hidden ? "rounded-b-md" : ""}` },
            hasNextPage || hasUnfetched
              ? h(
                  "div",
                  { class: "flex h-8 items-center mb-2 pl-4" },
                  h("div", { class: "flex w-[29px] shrink-0 content-center mr-[9px]" }, octicon("kebab-horizontal", "w-full rotate-90 fill-[var(--color-border-muted)]")),
                  hasNextPage
                    ? h("button", { class: "color-text-link underline", act: { type: "replies", id: c.id } }, t("showPreviousReplies", { count: remaining }))
                    : null,
                  hasUnfetched
                    ? h("a", { href: c.url, class: "color-text-link underline", ...external }, t("seePreviousRepliesOnGitHub", { count: remaining }))
                    : null,
                )
              : null,
            replies.map((r) => reply(w, r, list)),
          )
        : null,
      !c.isMinimized && replyBox ? replyBox : null,
    ),
  );
}

/** What giscus's <Giscus> renders inside <main> for the widget's state. */
export function renderGiscus(w) {
  const { t } = w.i18n;
  const d = w.derive();
  if (d.isLoading) {
    return h(
      "div",
      { class: "gsc-loading" },
      h("div", { class: "gsc-loading-image" }),
      h("span", { class: "gsc-loading-text color-fg-muted" }, t("loadingComments")),
    );
  }
  const number = w.c.number;
  const shouldCreateDiscussion = d.isNotFound && !number;
  const shouldShowReplyCount = !d.error && !d.isNotFound && !d.isLoading && d.totalReplyCount > 0;
  const shouldShowCommentBox = (d.isRateLimited && !w.token) || (!d.isLoading && !d.isLocked && (!d.error || (d.isNotFound && !number)));
  const canReply = !!w.token && !d.isLocked;
  const id = d.discussion.id;
  const mainBox = commentBox(w, w.box("main"), { discussionId: id, create: true });
  const count = (key, n) =>
    h("a", { href: d.discussion.url, target: "_blank", rel: "noreferrer noopener nofollow", class: `color-text-primary${key === "comments" ? " underline" : ""}` }, t(key, { count: n }));

  return h(
    "div",
    { class: "color-text-primary gsc-main" },
    w.c.reactionsEnabled && (shouldCreateDiscussion || !d.error)
      ? h(
          "div",
          { class: "gsc-reactions" },
          h("h4", { class: "gsc-reactions-count" }, shouldCreateDiscussion && !d.reactionCount ? t("reactions", { count: 0 }) : count("reactions", d.reactionCount || 0)),
          h(
            "div",
            { class: "flex flex-auto items-center justify-center gap-2 text-sm mt-2" },
            reactButtons(w, { key: "discussion", subjectId: id, groups: d.discussion.reactions, kind: "discussion", create: true }),
          ),
        )
      : null,
    h(
      "div",
      { class: "gsc-comments" },
      h(
        "div",
        { class: "gsc-header" },
        h(
          "div",
          { class: "gsc-left-header" },
          h(
            "h4",
            { class: "gsc-comments-count" },
            shouldCreateDiscussion && !d.totalCommentCount
              ? t("comments", { count: 0 })
              : d.error && !d.backData
                ? t("genericError", { message: d.error?.message || "" })
                : count("comments", d.totalCommentCount),
          ),
          shouldShowReplyCount
            ? [
                h("h4", { class: "gsc-comments-count-separator" }, "·"),
                h("h4", { class: "gsc-replies-count" }, t("replies", { count: d.totalReplyCount, plus: d.numHidden > 0 ? "+" : "" })),
              ]
            : null,
          d.discussion.url
            ? h(
                "em",
                { class: "color-text-secondary text-sm" },
                w.i18n.trans("poweredBy", {
                  a: (text) => h("a", { href: "https://giscus.app", target: "_blank", rel: "noreferrer noopener nofollow", class: "link-secondary" }, text),
                }),
              )
            : null,
        ),
        d.totalCommentCount > 0
          ? h(
              "ul",
              { class: "gsc-right-header BtnGroup" },
              ["oldest", "newest"].map((order) =>
                h(
                  "li",
                  { class: `BtnGroup-item ${w.orderBy === order ? "BtnGroup-item--selected" : ""}`, "aria-current": String(w.orderBy === order) },
                  h("button", { class: "btn", act: { type: "order", order } }, t(order)),
                ),
              ),
            )
          : null,
      ),
      shouldShowCommentBox && w.c.inputPosition === "top" ? mainBox : null,
      h(
        "div",
        { class: `gsc-timeline ${!d.totalCommentCount ? "hidden" : ""}` },
        d.frontComments.map((c) => comment(w, c, d.frontList, canReply, id)),
        d.numHidden > 0
          ? h(
              "div",
              { class: "pagination-loader-container gsc-pagination" },
              h(
                "button",
                { class: "gsc-pagination-button color-border-primary", disabled: d.isLoadingMore, act: { type: "more" } },
                h("span", { class: "color-text-secondary" }, t("hiddenItems", { count: d.numHidden })),
                h("span", { class: "color-text-link font-semibold" }, `${d.isLoadingMore ? t("loading") : t("loadMore")}…`),
              ),
            )
          : null,
        d.backComments.map((c) => comment(w, c, d.backList, canReply, id)),
      ),
      shouldShowCommentBox && w.c.inputPosition !== "top" ? mainBox : null,
    ),
  );
}
