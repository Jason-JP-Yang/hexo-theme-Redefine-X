/**
 * giscus's data, fetched the way its widget fetches it (services/ and lib/
 * adapter.ts in dev/giscus), without the widget.
 *
 * A reader who is signed in asks GitHub directly with the token giscus issued
 * them: both comment windows in ONE query, and every write, so the Worker never
 * sees them. A reader who is not signed in has no token GitHub accepts, so the
 * read goes through the Worker's giscus proxy to giscus.app, which signs it with
 * its app token: one request for the newest window, a second only when the
 * thread is longer than it. Once found, a discussion is asked for by number,
 * which skips GitHub's search and its indexing delay.
 */

const GRAPHQL = "https://api.github.com/graphql";
const MARKDOWN = "https://api.github.com/markdown";
const NUMBER_KEY = "giscus-number:";

// GitHub replaces deleted users with @ghost on the website but returns null.
const GHOST = {
  avatarUrl: "https://avatars.githubusercontent.com/u/10137?s=64&v=4",
  login: "ghost",
  url: "https://github.com/ghost",
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/* ─── queries ─────────────────────────────────────────────────────────────── */

const USER = "avatarUrl login url";
const GROUPS = "reactionGroups { content users { totalCount } viewerHasReacted }";
const REPLY = `id author { ${USER} } viewerDidAuthor createdAt url authorAssociation lastEditedAt deletedAt isMinimized bodyHTML ${GROUPS} replyTo { id }`;
const COMMENT = `id upvoteCount viewerHasUpvoted viewerCanUpvote author { ${USER} } viewerDidAuthor createdAt url authorAssociation lastEditedAt deletedAt isMinimized bodyHTML ${GROUPS} replies(last: 100) { totalCount nodes { ${REPLY} } }`;
const windowOf = (alias, args) =>
  `${alias}: comments(${args}) { totalCount pageInfo { startCursor hasNextPage hasPreviousPage endCursor } nodes { ${COMMENT} } }`;

function discussionQuery(byNumber, windows, paged) {
  const vars = [byNumber ? "$owner: String! $name: String! $number: Int!" : "$query: String!"];
  if (paged) vars.push("$after: String");
  const fields = `id url locked repository { nameWithOwner } reactions { totalCount } ${GROUPS} ${windows}`;
  const body = byNumber
    ? `repository(owner: $owner, name: $name) { discussion(number: $number) { ${fields} } }`
    : `search(type: DISCUSSION last: 1 query: $query) { discussionCount nodes { ... on Discussion { ${fields} } } }`;
  return `query(${vars.join(" ")}) { viewer { ${USER} } ${body} }`;
}

const ADD_COMMENT = `mutation($body: String!, $discussionId: ID!) {
  addDiscussionComment(input: {body: $body, discussionId: $discussionId}) {
    comment { id upvoteCount viewerHasUpvoted viewerCanUpvote author { ${USER} } viewerDidAuthor createdAt url authorAssociation lastEditedAt deletedAt isMinimized bodyHTML ${GROUPS}
      replies(first: 100) { totalCount nodes { id author { ${USER} } createdAt url authorAssociation lastEditedAt deletedAt isMinimized bodyHTML ${GROUPS} } } }
  }
}`;

const ADD_REPLY = `mutation($body: String!, $discussionId: ID!, $replyToId: ID!) {
  addDiscussionReply: addDiscussionComment(input: {body: $body, discussionId: $discussionId, replyToId: $replyToId}) {
    reply: comment { ${REPLY} }
  }
}`;

const TOGGLE_REACTION = (mode) => `mutation($content: ReactionContent!, $subjectId: ID!) {
  toggleReaction: ${mode}Reaction(input: {content: $content, subjectId: $subjectId}) { reaction { content id } }
}`;

const TOGGLE_UPVOTE = (mode) => `mutation($upvoteInput: ${mode}UpvoteInput!) {
  toggleUpvote: ${mode.toLowerCase()}Upvote(input: $upvoteInput) { subject { upvoteCount } }
}`;

/* ─── adapter (lib/adapter.ts) ────────────────────────────────────────────── */

function adaptReactionGroups(groups) {
  const out = {};
  for (const g of groups || []) out[g.content] = { count: g.users.totalCount, viewerHasReacted: g.viewerHasReacted };
  return out;
}

export function adaptReply(reply) {
  const { reactionGroups, replyTo, author, ...rest } = reply;
  return { ...rest, author: author || GHOST, reactions: adaptReactionGroups(reactionGroups), replyToId: replyTo && replyTo.id };
}

export function adaptComment(comment) {
  const { replies, reactionGroups, author, ...rest } = comment;
  return {
    ...rest,
    author: author || GHOST,
    replyCount: replies.totalCount,
    reactions: adaptReactionGroups(reactionGroups),
    replies: replies.nodes.map(adaptReply),
  };
}

function adaptDiscussion(viewer, discussion) {
  if (!discussion) return { viewer, discussion: null };
  const { comments, reactions, reactionGroups, ...rest } = discussion;
  const { pageInfo, totalCount, nodes } = comments;
  return {
    viewer,
    discussion: {
      totalCommentCount: totalCount,
      totalReplyCount: nodes.reduce((sum, c) => sum + c.replies.totalCount, 0),
      pageInfo,
      reactionCount: reactions.totalCount,
      reactions: adaptReactionGroups(reactionGroups),
      comments: nodes.map(adaptComment),
      ...rest,
    },
  };
}

/* ─── reads ───────────────────────────────────────────────────────────────── */

async function sha1(text) {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isEmpty = (v) => v === null || v === undefined || v === "" || Number.isNaN(v);
const cleanParams = (params) => Object.fromEntries(Object.entries(params).filter(([, v]) => !isEmpty(v)));

const numberKey = (c) => `${NUMBER_KEY}${c.repo.toLowerCase()}:${c.strict ? "s:" : ""}${c.term}`;

/** The discussion this page found before, by number; 0 when not known. */
export function knownNumber(c) {
  if (c.number) return c.number;
  try {
    return +localStorage.getItem(numberKey(c)) || 0;
  } catch (e) {
    return 0;
  }
}

export function rememberNumber(c, url) {
  if (c.number) return;
  const n = +((/\/discussions\/(\d+)/.exec(url || "") || [])[1] || 0);
  try {
    if (n) localStorage.setItem(numberKey(c), String(n));
    else localStorage.removeItem(numberKey(c));
  } catch (e) {}
}

async function graphql(query, variables, token) {
  let res;
  try {
    res = await fetch(GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new ApiError("Failed to fetch", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || /Bad credentials/.test(json.message || "")) throw new ApiError(json.message || "Bad credentials", 401);
  if (!res.ok && !json.data) throw new ApiError(json.message || res.statusText, res.status);
  return json;
}

// A number whose discussion was deleted is a NOT_FOUND error, not an empty answer.
const GONE = /Could not resolve to a Discussion/;

// The answer, as giscus's /api/discussions would have shaped it.
function readDiscussion(json, repo, signedIn) {
  if (json.errors) {
    const first = json.errors[0];
    if (first?.message?.includes("API rate limit exceeded")) {
      throw new ApiError(`API rate limit exceeded for ${repo}${signedIn ? "" : ". Sign in to increase the rate limit"}`, 429);
    }
    const message = json.errors.map((e) => e.message).join(". ") || "Unknown error";
    throw new ApiError(message, json.errors.some((e) => e.type === "NOT_FOUND" || GONE.test(e.message || "")) ? 404 : 500);
  }
  const { viewer } = json.data;
  const found = json.data.search
    ? json.data.search.discussionCount > 0
      ? json.data.search.nodes[0]
      : null
    : json.data.repository?.discussion;
  if (!found) throw new ApiError("Discussion not found", 404);
  return { viewer, found };
}

async function directVariables(c, number) {
  if (number) {
    const [owner, name] = c.repo.toLowerCase().split("/");
    return { owner, name, number };
  }
  const term = c.strict ? await sha1(c.term) : c.term;
  const category = c.category ? `category:${JSON.stringify(c.category)}` : "";
  return { query: `repo:${c.repo.toLowerCase()} ${category} ${c.strict ? "in:body" : "in:title"} ${JSON.stringify(term)}` };
}

/**
 * Signed in: the newest 15 comments and the oldest 15, as giscus's two windows,
 * in one query. Returns [back, front].
 */
export async function loadDirect(c, token, number) {
  const windows = `${windowOf("back", "last: 15")} ${windowOf("front", "first: 15")}`;
  const json = await graphql(discussionQuery(!!number, windows, false), await directVariables(c, number), token);
  const { viewer, found } = readDiscussion(json, c.repo, true);
  const { back, front, ...rest } = found;
  return [adaptDiscussion(viewer, { ...rest, comments: back }), adaptDiscussion(viewer, { ...rest, comments: front })];
}

/** Signed in: the next page of the oldest window (giscus asks for 20). */
export async function loadDirectPage(c, token, number, after) {
  const vars = { ...(await directVariables(c, number)), after };
  const json = await graphql(discussionQuery(!!number, windowOf("comments", "first: 20 after: $after"), true), vars, token);
  const { viewer, found } = readDiscussion(json, c.repo, true);
  return adaptDiscussion(viewer, found);
}

/** Not signed in: one window through the Worker, giscus.app's own answer. */
export async function loadProxied(base, c, number, pagination) {
  const params = new URLSearchParams(
    cleanParams({ repo: c.repo, term: c.term, category: c.category, number, strict: c.strict, ...pagination }),
  );
  let res;
  try {
    res = await fetch(`${base}/api/discussions?${params}`);
  } catch (e) {
    throw new ApiError("Failed to fetch", 0);
  }
  const data = await res.json().catch(() => null);
  // giscus.app answers a deleted number with a 500 carrying GitHub's message.
  if (!res.ok) throw new ApiError(data?.error || res.statusText, GONE.test(data?.error || "") ? 404 : res.status);
  return data;
}

/* ─── writes ──────────────────────────────────────────────────────────────── */

async function mutate(query, variables, token) {
  const json = await graphql(query, variables, token);
  if (json.errors && !json.data) throw new ApiError(json.errors.map((e) => e.message).join(". "), 500);
  return json.data;
}

export const addComment = (body, discussionId, token) =>
  mutate(ADD_COMMENT, { body, discussionId }, token).then((d) => adaptComment(d.addDiscussionComment.comment));

export const addReply = (body, discussionId, replyToId, token) =>
  mutate(ADD_REPLY, { body, discussionId, replyToId }, token).then((d) => adaptReply(d.addDiscussionReply.reply));

export const toggleReaction = (content, subjectId, token, hasReacted) =>
  mutate(TOGGLE_REACTION(hasReacted ? "remove" : "add"), { content, subjectId }, token);

export const toggleUpvote = (subjectId, token, hasUpvoted) =>
  mutate(TOGGLE_UPVOTE(hasUpvoted ? "Remove" : "Add"), { upvoteInput: { subjectId } }, token);

/** A new discussion's address, so it is asked for by number before search has indexed it. */
export async function discussionUrl(id, token) {
  const json = await graphql("query($id: ID!) { node(id: $id) { ... on Discussion { url } } }", { id }, token);
  return json.data?.node?.url || null;
}

/** giscus.app creates the discussion with its app token; the reader's proves who asked. */
export async function createDiscussion(base, token, repo, input) {
  const res = await fetch(`${base}/api/discussions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo, input }),
  });
  const data = await res.json().catch(() => ({}));
  return data.id;
}

export function renderMarkdown(text, token, context) {
  return fetch(MARKDOWN, {
    method: "POST",
    headers: token ? { Authorization: `token ${token}` } : {},
    body: JSON.stringify({ mode: "gfm", text, ...(context ? { context } : {}) }),
  }).then((r) => r.text());
}
