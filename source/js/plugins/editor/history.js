/**
 * Undo and redo, as whole-document snapshots.
 *
 * ── Why snapshots and not a command log ─────────────────────────────────────
 *
 * Every mutation in this editor already funnels through `markDirty`, and every
 * one of them leaves the document in a state `docToMarkdown` can emit. A command
 * log would need an inverse for each of the fifteen ways a post can change, and
 * an inverse that is subtly wrong rewrites the file it was meant to protect. A
 * snapshot cannot be subtly wrong: it either IS the document as it stood or it
 * is not.
 *
 * Memory is paid once rather than two hundred times: a snapshot SHARES every
 * block object with the snapshot before it and clones only the blocks whose
 * signature changed.
 *
 * ── A step is at most ten characters ────────────────────────────────────────
 *
 * Typing is recorded in bursts, and consecutive bursts with the same target
 * MERGE into the step already on top — until the merged step would hand back
 * more than `PACK_MAX` characters, at which point the next burst starts a step
 * of its own. So undo gives back a word or a phrase, never one letter and never
 * a paragraph. The count is a real character diff of the two snapshot digests,
 * not a count of bursts: how fast somebody types must not change how much one
 * press of Ctrl-Z takes back.
 *
 * A structural change — inserting, deleting, converting, reordering, a staged
 * rename — is always a step of its own.
 *
 * ── Where the change was ────────────────────────────────────────────────────
 *
 * `aim` diffs the two snapshots rather than trusting a label recorded at edit
 * time, and says HOW the block differs — edited, arrived, left, moved — because
 * those want four different things drawn on screen.
 */

import { emitBlock, parseFrontMatter } from "./markdown.js";

const LIMIT = 200;     // how far back one editing session remembers
const PACK_MAX = 10;   // characters one step hands back, at most
const IDLE_MS = 160;   // quiet that ends a typing burst
const HOLD_MS = 320;   // ...and the longest a burst is ever held unrecorded
const RUN_MS = 1500;   // a gap this long always starts a new step
const FOLD_MS = 2000;  // how long a requested fold stays on offer

/** The kinds that are typing; everything else is structural and never merges. */
const LIVE = new Set(["text", "front"]);

const COVER = new Set(["cover", "banner", "thumbnail"]);

// Separators for the comparison keys below. Control characters, because the
// things being joined are a post's own text and there is no printable string a
// post cannot contain.
const UNIT = String.fromCharCode(1);
const PART = String.fromCharCode(2);
const PAIR = String.fromCharCode(3);

/* ─── values ───────────────────────────────────────────────────────────────── */

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key in value) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}

/**
 * The span of characters two strings differ over: everything they share at the
 * front, everything they share at the back, and what is left in the middle.
 *
 * Two jobs, one pass. It sizes a typing burst — which is what caps a step at ten
 * characters — and, run over the rendered text of one block, it is the range the
 * editor lights up, so what is measured and what is shown can never disagree.
 */
export function charSpan(a, b) {
  const one = String(a == null ? "" : a);
  const two = String(b == null ? "" : b);
  const max = Math.min(one.length, two.length);

  let head = 0;
  while (head < max && one.charCodeAt(head) === two.charCodeAt(head)) head += 1;

  let tail = 0;
  while (
    tail < max - head &&
    one.charCodeAt(one.length - 1 - tail) === two.charCodeAt(two.length - 1 - tail)
  ) {
    tail += 1;
  }

  return { head, endA: one.length - tail, endB: two.length - tail };
}

function changedChars(a, b) {
  const span = charSpan(a, b);
  return Math.max(span.endA - span.head, span.endB - span.head);
}

/**
 * Signatures are cached for STORED blocks only.
 *
 * A stored block is a copy nothing writes to again; a live block is rewritten by
 * `view.read()` on every pass. Keying the cache on object identity keeps the two
 * apart without needing a flag.
 */
const SIGS = new WeakMap();

export function signature(block) {
  const held = SIGS.get(block);
  if (held) return held;
  return [
    block.type,
    block.dirty ? "1" : "0",
    block.dirty ? emitBlock(block) : block.src || "",
    block.after == null ? "\n\n" : block.after,
  ].join(UNIT);
}

/** Clone only what changed; everything else is the previous snapshot's copy. */
function hold(blocks, prev) {
  const held = new Map();
  if (prev) for (const block of prev) held.set(block.id + PAIR + signature(block), block);

  return blocks.map((block) => {
    const sig = signature(block);
    const reuse = held.get(block.id + PAIR + sig);
    if (reuse) return reuse;
    const copy = cloneValue(block);
    SIGS.set(copy, sig);
    return copy;
  });
}

/** One string per snapshot: "did anything move?" and "by how much?" both read it. */
function digest(snap) {
  return [
    snap.front,
    snap.frontDirty ? "1" : "0",
    snap.lead,
    snap.blocks.map((block) => block.id + PAIR + signature(block)).join(UNIT),
    snap.moves.map((move) => move.from + PAIR + move.to + PAIR + (move.noted ? "1" : "0")).join(UNIT),
    snap.folders.join(UNIT),
    snap.pending.map((asset) => asset.path).join(UNIT),
  ].join(PART);
}

/* ─── where two snapshots differ ───────────────────────────────────────────── */

function frontKey(from, to) {
  const a = parseFrontMatter(from);
  const b = parseFrontMatter(to);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key] == null ? "" : String(a[key]);
    const y = b[key] == null ? "" : String(b[key]);
    if (x !== y) return key;
  }
  return "";
}

/**
 * A staged rename, move or new folder: something done IN the picture browser.
 *
 * Kept apart from `pending` on purpose. Staged moves and folders only ever come
 * from the browser, so a step carrying one belongs there and should open it;
 * `pending` grows whenever a picture is dropped or pasted into the article,
 * which is a block edit that happens to upload a file, and opening a file
 * manager over that would be answering a question nobody asked.
 */
function filedPath(from, to) {
  const steps = Math.max(from.moves.length, to.moves.length);
  for (let i = 0; i < steps; i++) {
    const a = from.moves[i];
    const b = to.moves[i];
    if (a && b && a.from === b.from && a.to === b.to) continue;
    // Where the file will BE once the step has landed — which for an undo of a
    // rename is the name it had before it, not the name being taken away. The
    // browser is opened on the answer, so it has to be the destination and not
    // the place the file is leaving.
    return { path: b ? b.to : (a ? a.from : ""), was: a ? a.to : (b ? b.from : "") };
  }

  const had = new Set(from.folders);
  for (const path of to.folders) if (!had.has(path)) return { path, was: path };
  const has = new Set(to.folders);
  for (const path of from.folders) if (!has.has(path)) return { path, was: path };
  return null;
}

/**
 * Which block MOVED, when the two lists hold the same blocks in a different
 * order.
 *
 * "The first position they differ at" is the obvious answer and the wrong one:
 * dragging the first paragraph to the end makes position zero differ, and what
 * is standing there is the paragraph that did NOT move. The one that moved is
 * the one whose removal leaves the two orders identical.
 */
function movedId(from, to) {
  const a = from.map((block) => block.id);
  const b = to.map((block) => block.id);
  const without = (id) => {
    const x = a.filter((held) => held !== id);
    const y = b.filter((held) => held !== id);
    return x.length === y.length && x.every((held, i) => held === y[i]);
  };

  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue;
    if (without(b[i])) return b[i];
    if (a[i] && without(a[i])) return a[i];
    return b[i];
  }
  return "";
}

const PROPS = ["exifTitle", "alt", "autoExif"];

/** The first property two versions of a picture disagree on, or "" when none does. */
export function propsKey(a, b) {
  for (const key of PROPS) {
    const x = key === "autoExif" ? a[key] !== false : a[key] || "";
    const y = key === "autoExif" ? b[key] !== false : b[key] || "";
    if (x !== y) return key;
  }
  const one = a.exif || {};
  const two = b.exif || {};
  for (const key of new Set([...Object.keys(one), ...Object.keys(two)])) {
    if ((one[key] || "") !== (two[key] || "")) return key;
  }
  return "";
}

function uploadPath(from, to) {
  const before = new Set(from.pending.map((asset) => asset.path));
  for (const asset of to.pending) if (!before.has(asset.path)) return asset.path;
  const after = new Set(to.pending.map((asset) => asset.path));
  for (const asset of from.pending) if (!after.has(asset.path)) return asset.path;
  return "";
}

/**
 * What a step is about, and what shape it has.
 *
 * `how` is the whole point of this being four answers rather than one. A block
 * that was EDITED wants the characters that changed lit up; one that ARRIVED or
 * MOVED wants the block itself, because the block is the change; and one that
 * LEFT has nothing left to light — lighting its neighbour instead says the
 * neighbour changed, which is the misleading thing this used to do. That case
 * becomes a `seam`: the gap it left, marked between the two blocks that remain.
 *
 * The picture browser is read FIRST, before any of that. Renaming a picture and
 * then choosing it is one step — see `fold` — and that step changes a staged
 * move AND the block that points at it. Naming the block would take the author
 * to a paragraph whose address changed for a reason they could not see; naming
 * the file opens the browser on the file they renamed, which is where the work
 * actually happened.
 */
function decide(from, to, cause) {
  const filed = filedPath(from, to);
  if (filed) return { kind: "asset", path: filed.path, was: filed.was };

  const now = new Map(from.blocks.map((block) => [block.id, block]));
  const want = new Map(to.blocks.map((block) => [block.id, block]));

  // What the author actually DID, taken from the edit that made the step rather
  // than worked out from its result.
  //
  // Two orderings of the same blocks cannot say which block was dragged. Given a
  // heading and a paragraph swapped, removing EITHER leaves the other in the
  // same order, so the diff has no way to prefer one — and it kept naming the
  // heading, which is the block that stood still. The drag knew; it said so at
  // the time; this is simply reading it back.
  const named = cause && cause.target ? String(cause.target) : "";
  if (cause && cause.kind === "move" && named && want.has(named)) {
    return { kind: "block", id: named, how: "move" };
  }

  // A picture's properties, changed in the sheet: the step goes back to the
  // sheet, on the field that changed, rather than to a caption on the canvas.
  if (cause && cause.kind === "props" && want.has(named) && now.has(named)) {
    const key = propsKey(now.get(named), want.get(named));
    if (key) return { kind: "props", id: named, key };
  }

  // A picture ADDED to the repository. It is not a block edit even though a
  // block usually points at it a moment later — the two are separate steps (see
  // `pickImage`), and this one happened in the browser, on a file, which is
  // where it has to be shown.
  if (cause && cause.kind === "assets") {
    const added = uploadPath(from, to);
    if (added) return { kind: "asset", path: added, was: added };
  }

  for (const block of to.blocks) {
    const here = now.get(block.id);
    if (here && signature(here) !== signature(block)) return { kind: "block", id: block.id, how: "edit" };
  }
  for (const block of to.blocks) if (!now.has(block.id)) return { kind: "block", id: block.id, how: "add" };

  for (let i = 0; i < from.blocks.length; i++) {
    if (want.has(from.blocks[i].id)) continue;
    let above = "";
    for (let j = i - 1; j >= 0; j--) {
      if (want.has(from.blocks[j].id)) {
        above = from.blocks[j].id;
        break;
      }
    }
    let below = "";
    for (let j = i + 1; j < from.blocks.length; j++) {
      if (want.has(from.blocks[j].id)) {
        below = from.blocks[j].id;
        break;
      }
    }
    return { kind: "seam", above, below };
  }

  const moved = movedId(from.blocks, to.blocks);
  if (moved) return { kind: "block", id: moved, how: "move" };

  if (from.front !== to.front || from.frontDirty !== to.frontDirty) {
    const key = frontKey(from.front, to.front);
    if (key === "title") return { kind: "title", key };
    return COVER.has(key) ? { kind: "cover", key } : { kind: "front", key };
  }

  const path = uploadPath(from, to);
  if (path) return { kind: "asset", path, was: path };
  return { kind: "canvas" };
}

/**
 * The same answer, plus the block the author had hold of.
 *
 * A block dragged INTO a note leaves the document's list entirely — it is a
 * slice of the note's body now — so every answer above rightly names the note,
 * which is the thing whose text changed. But the note may be a screen tall, and
 * "go to the note" is how the block that actually moved ended up off screen with
 * the page scrolled to something that had not visibly changed. `lead` is what the
 * canvas still calls that block, for the travel that happens before the step.
 */
function aim(from, to, cause) {
  const spot = decide(from, to, cause);
  const named = cause && cause.kind === "move" && cause.target ? String(cause.target) : "";
  if (named && !(spot.kind === "block" && spot.id === named)) spot.lead = named;
  return spot;
}

/* ─── the store ────────────────────────────────────────────────────────────── */

/**
 * @param {object} ctx
 *   read()      pull the canvas into the document model, the way a stash does
 *   doc()       the open document
 *   stage()     the staged picture tidy-up, or null
 *   pending()   the assets queued for the next commit
 *   apply(plan) put the document back; `plan.target` says where to look
 *   changed()   the step count moved — repaint whatever reports it
 */
export function createHistory(ctx) {
  let stack = [];
  let index = -1;
  let base = -1;      // the step the committed file is at
  let run = null;     // { kind, target, at }
  let want = null;    // { kind, target } waiting to be recorded
  let timer = 0;
  let since = 0;
  let shut = false;   // a restore, or a read, is in progress
  let revision = 0;   // bumped on every step PUSHED, never on a merge
  let foldUntil = 0;  // the next push is invited to merge instead
  let queue = 0;      // steps still owed, so the buttons can be hammered
  let running = false;

  /**
   * @param {boolean} read  false for the opening snapshot ONLY.
   *
   * Reading pulls the canvas into the model, and reading a NESTED box writes it
   * back into the component holding it — which sets that block's `dirty` flag.
   * On a post that has just been parsed there is nothing on the canvas the model
   * does not already hold, so reading it would buy nothing and would cost the
   * round-trip law: a post with a large note in it would come out of the editor
   * re-emitted rather than byte-identical, having been opened and closed without
   * a key being pressed.
   */
  function take(prev, read) {
    const was = shut;
    shut = true;
    try {
      if (read !== false) ctx.read();

      const doc = ctx.doc();
      const stage = ctx.stage();
      const snap = {
        front: doc.front || "",
        frontRaw: doc.frontRaw || "",
        frontDirty: !!doc.frontDirty,
        lead: doc.lead || "",
        blocks: hold(doc.blocks || [], prev && prev.blocks),
        moves: (stage ? stage.moves : []).map((move) => ({ from: move.from, to: move.to, noted: !!move.noted })),
        folders: stage ? Array.from(stage.folders) : [],
        pending: (ctx.pending() || []).slice(),
      };
      snap.key = digest(snap);
      return snap;
    } finally {
      shut = was;
    }
  }

  function plan(snap, target) {
    return {
      front: snap.front,
      frontRaw: snap.frontRaw,
      frontDirty: snap.frontDirty,
      lead: snap.lead,
      blocks: snap.blocks.map(cloneValue),
      moves: snap.moves.map((move) => ({ from: move.from, to: move.to, noted: move.noted })),
      folders: snap.folders.slice(),
      pending: snap.pending.slice(),
      target,
    };
  }

  function flush() {
    clearTimeout(timer);
    timer = 0;
    since = 0;
    const asked = want;
    want = null;
    if (!asked || index < 0 || shut) return;

    const snap = take(stack[index]);
    // Nothing moved. A repaint, a nested box writing itself back unchanged, a
    // picture browser closed without a decision — all of them reach `markDirty`,
    // and none of them is a step anybody would ask for back.
    if (stack[index].key === snap.key) return;

    const now = Date.now();
    const folding = foldUntil > now;
    const merge =
      index > 0 &&
      (folding ||
        (run &&
          LIVE.has(asked.kind) &&
          run.kind === asked.kind &&
          run.target === asked.target &&
          now - run.at < RUN_MS &&
          changedChars(stack[index - 1].key, snap.key) <= PACK_MAX));

    foldUntil = 0;

    // What made this step, kept with it. `aim` reads it back when the shape of
    // the change cannot say on its own which block the author acted on.
    snap.by = { kind: asked.kind, target: asked.target };

    if (merge) {
      stack[index] = snap;
      run = { kind: asked.kind, target: asked.target, at: now };
    } else {
      stack.length = index + 1;
      stack.push(snap);
      if (stack.length > LIMIT) {
        stack.shift();
        base = base > 0 ? base - 1 : -1;
      }
      index = stack.length - 1;
      revision += 1;
      run = { kind: asked.kind, target: asked.target, at: now };
    }
    ctx.changed();
  }

  function record(kind, target) {
    if (shut || index < 0) return;
    want = { kind: kind || "text", target: target == null ? "" : String(target) };

    if (!LIVE.has(want.kind)) return void flush();

    if (!since) since = Date.now();
    clearTimeout(timer);
    // Quiet ends a burst; a typist who never goes quiet still gets checkpoints.
    timer = setTimeout(flush, Math.max(0, Math.min(IDLE_MS, since + HOLD_MS - Date.now())));
  }

  /**
   * Work the queue down.
   *
   * The buttons and the shortcut can both be hammered, and a step takes a few
   * hundred milliseconds to animate — so presses are COUNTED rather than
   * dropped, and every step but the last is applied without its animation. The
   * alternative was an editor that ignores four presses out of five and then
   * jumps somewhere unexpected.
   */
  async function pump() {
    running = true;
    try {
      while (queue !== 0) {
        const dir = queue > 0 ? 1 : -1;
        const to = index + dir;
        if (to < 0 || to >= stack.length) {
          queue = 0;
          break;
        }
        queue -= dir;

        // Undoing takes back the edit that made the step we are ON; redoing
        // re-applies the one that made the step we are going TO.
        const cause = dir < 0 ? stack[index].by : stack[to].by;
        const job = plan(stack[to], aim(stack[index], stack[to], cause));
        job.quick = queue !== 0;
        shut = true;
        try {
          await ctx.apply(job);
          index = to;
        } finally {
          shut = false;
          run = null;
        }
        ctx.changed();
      }
    } finally {
      running = false;
    }
    return true;
  }

  function drive(dir) {
    flush();
    // A fold that was offered and never taken must not attach itself to the next
    // thing the author does after stepping.
    foldUntil = 0;
    if (index < 0) return Promise.resolve(false);
    queue += dir;
    if (running) return Promise.resolve(true);
    return pump();
  }

  return {
    /**
     * The document as opened becomes step zero; nothing before it is offered.
     *
     * `clean` is false when what is on screen is already ahead of the committed
     * file — a recovered local copy — and then there is no baseline here at all:
     * stepping back to step zero would land on unsaved work, so the unsaved
     * marker stays somebody else's to decide.
     */
    start(clean) {
      clearTimeout(timer);
      timer = 0;
      since = 0;
      run = null;
      want = null;
      shut = false;
      queue = 0;
      running = false;
      foldUntil = 0;
      revision = 0;
      index = -1;
      stack = [take(null, false)];
      index = 0;
      base = clean === false ? -1 : 0;
      ctx.changed();
    },
    reset() {
      clearTimeout(timer);
      timer = 0;
      since = 0;
      stack = [];
      index = -1;
      base = -1;
      run = null;
      want = null;
      shut = false;
      queue = 0;
      running = false;
      foldUntil = 0;
      ctx.changed();
    },
    record,
    /** Record whatever is waiting, now — before a step, and before a save. */
    flush,
    undo: () => drive(-1),
    redo: () => drive(1),
    can() {
      return { undo: index + queue > 0, redo: index >= 0 && index + queue < stack.length - 1 };
    },
    /** A number that changes whenever a step is PUSHED. */
    mark: () => revision,
    /**
     * The next change belongs to the step already on top.
     *
     * Renaming a picture in the browser and then choosing it are one decision —
     * it is the same picture either way — so the block that now points at the
     * new name folds into the rename rather than standing as a step of its own.
     * Without this, undo put the old address back and left the rename staged,
     * which is a state the author never created.
     */
    fold() {
      if (index > 0) foldUntil = Date.now() + FOLD_MS;
    },
    /**
     * Whether the document differs from what is committed, or null when there is
     * no baseline to compare against. Stepping all the way back to where the
     * post was opened has to clear the unsaved marker, not merely stop adding to
     * it.
     */
    dirtyState() {
      if (index < 0 || base < 0 || !stack[index] || !stack[base]) return null;
      return stack[index].key !== stack[base].key;
    },
    /**
     * The commit landed. Every step still on the stack describes a document
     * whose pictures are already in the repository, so undoing one must not
     * queue those bytes for a second commit nor re-ask for a rename the build
     * has been told about — and THIS step is now the clean one.
     */
    settle() {
      for (const snap of stack) {
        snap.pending = [];
        snap.moves = snap.moves.map((move) => ({ from: move.from, to: move.to, noted: true }));
        snap.key = digest(snap);
      }
      base = index;
      ctx.changed();
    },
  };
}
