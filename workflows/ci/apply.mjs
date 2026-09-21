/**
 * Open one save and write it into the source tree — or refuse the whole of it.
 *
 * verify-receipt.mjs has already established WHO asked and WHAT they were
 * cleared for. This is the other half: whether the payload actually stays
 * inside that clearance. The two are separate because only this one can answer
 * it — deciding which albums a masonry.yml changed needs the file it is
 * replacing, and that lives in the private repository, which nothing may clone
 * until the receipt has been checked.
 *
 * ── Nothing is written until everything has been checked ────────────────────
 *
 * A payload that fails half way through would leave the tree in a state nobody
 * asked for and the build would publish it. So the whole set is validated
 * first, in memory, and applied only if every operation in it passed.
 *
 * Usage:
 *   node ci/apply.mjs --payload <file> --wrapped <b64url> --ids <csv> --admin <bool> --src <dir>
 *
 * The key arrives WRAPPED, straight off the commit message, and is unwrapped
 * here. It is never a workflow output and never a file: a run log is public on
 * a public repository, and so is a workflow artifact.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { open, postId, master, unwrapSubmission, fromB64url } from "./lib/vault.mjs";
import { merge as mergeAlbums } from "./lib/masonry.mjs";

/* ─── what may be written at all ───────────────────────────────────────────── */

// The client-side list is a courtesy; this one is the control. Everything an
// editing session must never reach is here, and the first rule is the one that
// matters most: a submodule URL is a code path, and pointing `themes/redefine-x`
// somewhere else would run that repository's scripts on a runner holding
// VAULT_MASTER.
const FORBIDDEN = [
  /^\.github\//,
  /^\.gitea\//,
  /^themes\//,
  /^bin\//,
  /^ci\//,
  /^package(-lock)?\.json$/,
  /^_config[^/]*\.yml$/,
  /^\.gitmodules$/,
  /(^|\/)\.\.(\/|$)/,
  /^\/|\\/,
];

const POST = /^source\/_posts\/[^/]+\.md$/;
const DRAFT = /\.draft\.md$/;

/**
 * Does the incoming body say it is a draft? The FRONT MATTER, not the name.
 *
 * A brand-new article is saved as a draft at its future published path; only a
 * draft standing in front of an already-published article has the `.draft.md`
 * suffix. Reading the suffix alone called every new draft a publish, which is
 * what refused a collaborator the one thing the Worker had just issued them a
 * claim row for — creating something of their own.
 */
function draftBody(data) {
  let text = "";
  try {
    text = Buffer.from(String(data || ""), "base64").toString("utf8");
  } catch {
    return false;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!front && /^draft:\s*(true|yes|on|1)\s*$/im.test(front[1]);
}
const MASONRY = "source/_data/masonry.yml";
const KEYRING = ".vault/keys.enc";
const JOURNAL = "source/_data/image-moves.json";
const ASSET = /^source\/(images|masonry)\/.+\.[a-z0-9]+$/i;

/* ─── arguments ────────────────────────────────────────────────────────────── */

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[String(process.argv[i]).replace(/^--/, "")] = process.argv[i + 1];
}

const src = path.resolve(args.src || ".");
const admin = String(args.admin) === "true";
const allowed = new Set(String(args.ids || "").split(",").filter(Boolean));

function refuse(why) {
  process.stderr.write(`::error::${why}\n`);
  process.exit(1);
}

/* ─── open the payload ─────────────────────────────────────────────────────── */

let key;
try {
  key = unwrapSubmission(String(args.wrapped || "").trim());
} catch {
  refuse("the submission key was not issued by this deployment");
}

let payload;
try {
  payload = JSON.parse(open(key, fs.readFileSync(args.payload)).toString("utf8"));
} catch {
  refuse("the payload does not open under the key the receipt issued");
}
if (payload.v !== 1) refuse(`unknown payload version ${payload.v}`);

const files = Array.isArray(payload.files) ? payload.files : [];
if (!files.length) refuse("the payload changes nothing");
if (files.length > 500) refuse("the payload changes too many files at once");

/* ─── who owns each path ───────────────────────────────────────────────────── */

const yaml = createRequire(path.join(src, "package.json"))("js-yaml");

function readSource(rel) {
  try {
    return fs.readFileSync(path.join(src, rel));
  } catch {
    return null;
  }
}

/* ─── validate ─────────────────────────────────────────────────────────────── */

const writes = [];
const deletes = [];
const owners = new Set();

for (const file of files) {
  const rel = String(file.path || "").replace(/^\/+/, "");
  const op = String(file.op || "write");

  if (!rel) refuse("an operation carries no path");
  if (FORBIDDEN.some((re) => re.test(rel))) refuse(`${rel} is protected`);
  if (op !== "write" && op !== "delete" && op !== "append") refuse(`${rel}: unknown operation ${op}`);

  // ── the picture-move journal ─────────────────────────────────────────────
  //
  // Appended, never replaced. The editor cannot read it — it is not published —
  // so a save that wrote the whole file would drop whatever another save had
  // already put there. It carries no owner because it is build bookkeeping
  // rather than content: the moves it records belong to pictures whose
  // permission was checked where those pictures were written.
  if (rel === JOURNAL) {
    if (op !== "append") refuse("the picture-move journal may only be appended to");
    let notes;
    try {
      notes = JSON.parse(Buffer.from(String(file.data || ""), "base64").toString("utf8"));
    } catch {
      refuse("the picture-move notes are not readable");
    }
    if (!Array.isArray(notes) || notes.length > 2000) refuse("the picture-move notes are malformed");

    let held = [];
    const current = readSource(rel);
    if (current) {
      try {
        held = JSON.parse(current.toString("utf8")) || [];
      } catch {
        held = [];
      }
    }
    const clean = notes
      .filter((n) => n && typeof n.from === "string" && typeof n.to === "string")
      .filter((n) => !FORBIDDEN.some((re) => re.test(n.from) || re.test(n.to)));
    writes.push({
      rel,
      bytes: Buffer.from(JSON.stringify(held.concat(clean), null, 2) + "\n", "utf8"),
    });
    continue;
  }

  if (op === "append") refuse(`${rel} cannot be appended to`);

  // ── the keyring ──────────────────────────────────────────────────────────
  // Not owned by anything, and authorised by the only thing that could have
  // produced it: it opens under VAULT_MASTER. A newly minted post key exists
  // nowhere else, so refusing this would orphan every article the editor
  // creates.
  if (rel === KEYRING) {
    if (op !== "write") refuse("the keyring may not be deleted");
    const bytes = Buffer.from(String(file.data || ""), "base64");
    try {
      JSON.parse(open(master(), fromB64url(bytes.toString("utf8").trim())).toString("utf8"));
    } catch {
      refuse("the keyring does not open under this VAULT_MASTER");
    }
    writes.push({ rel, bytes });
    continue;
  }

  // ── masonry.yml ──────────────────────────────────────────────────────────
  //
  // Merged rather than replaced. What the sender saw may have been the file
  // with every encrypted and draft album taken out of it, so what comes back
  // cannot be trusted to be the whole of it — see lib/masonry.mjs.
  if (rel === MASONRY) {
    if (op !== "write") refuse("masonry.yml may not be deleted");
    const before = readSource(rel);
    if (!before) refuse("masonry.yml is missing from the source tree");

    let merged;
    try {
      merged = mergeAlbums(
        yaml,
        before.toString("utf8"),
        Buffer.from(String(file.data || ""), "base64").toString("utf8"),
        allowed,
        admin
      );
    } catch (err) {
      refuse(err.message);
    }
    if (!merged.touched.length) refuse("masonry.yml is unchanged");
    for (const id of merged.touched) owners.add(id);
    writes.push({ rel, bytes: Buffer.from(merged.text, "utf8") });
    continue;
  }

  // ── an article ───────────────────────────────────────────────────────────
  if (POST.test(rel)) {
    const id = postId(rel);
    if (!allowed.has(id)) refuse(`${rel} is not one this save was cleared for`);
    owners.add(id);

    const exists = !!readSource(rel);
    if (!admin && !DRAFT.test(rel)) {
      // Editing a published article you are an editor of is ordinary work.
      // Creating one, or removing one, is publishing, and publishing is the
      // admin's decision — refused here as well as at the Worker, so the rule
      // does not depend on which client asked. A new article whose OWN front
      // matter says `draft: true` is not published by being created, though,
      // and refusing it was the hole that made a collaborator unable to start
      // anything at all.
      if (op === "delete") refuse(`only an admin may unpublish ${rel}`);
      if (!exists && !draftBody(file.data)) refuse(`only an admin may publish a new article (${rel})`);
    }

    if (op === "delete") deletes.push({ rel });
    else writes.push({ rel, bytes: Buffer.from(String(file.data || ""), "base64") });
    continue;
  }

  // ── a picture ────────────────────────────────────────────────────────────
  // An asset belongs to whatever is being edited, and the receipt already
  // proves write permission on that. There is no second question to ask: a
  // photograph under `source/images/` is content-addressed and shared, and one
  // under `source/masonry/` belongs to an album this save is cleared for.
  if (ASSET.test(rel)) {
    const id = String(file.owner || "");
    if (!allowed.has(id)) refuse(`${rel} names an owner this save was not cleared for`);
    owners.add(id);
    if (op === "delete") deletes.push({ rel });
    else writes.push({ rel, bytes: Buffer.from(String(file.data || ""), "base64") });
    continue;
  }

  refuse(`${rel} is outside the editable tree`);
}

// Every id the receipt named has to have been used. A save cleared for three
// items that touches one is not wrong, but a save that names an item it never
// changes is a receipt being kept warm, and there is no reason to allow it.
for (const id of owners) {
  if (!allowed.has(id)) refuse(`internal: ${id} slipped past the owner check`);
}

/* ─── apply ────────────────────────────────────────────────────────────────── */

for (const { rel, bytes } of writes) {
  const target = path.join(src, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

for (const { rel } of deletes) {
  try {
    fs.unlinkSync(path.join(src, rel));
  } catch {
    /* already gone is the state that was wanted */
  }
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    wrote: writes.length,
    removed: deletes.length,
    items: Array.from(owners),
    message: String(payload.message || "").slice(0, 200),
  }) + "\n"
);
