/**
 * The double gate in front of Blog Management and the composer.
 *
 * Both pages are for one reader, and neither is published. What is in public/
 * is a probe; the markup lives at the vault prefix as ciphertext, sealed under a
 * key with a fixed identity that only an admin is ever handed — `grantedPosts`
 * gives an admin every row and everyone else only what their own grant names,
 * and nothing in Posts Management offers this one to anybody.
 *
 * So two things have to happen, and neither is sufficient alone:
 *
 *   authorisation   the Worker decides, against the isAdmin claim on the
 *                   session token, whether the key is released at all.
 *   decryption      the blob has to open under it. A key for another post, or
 *                   a tampered blob, yields nothing but a 404.
 *
 * A visitor who fails either gets the ordinary not-found page, exactly as a
 * mistyped encrypted-post slug does, so the page's existence is not confirmed.
 */

import {
  b64urlToBytes,
  importAesKey,
  openText,
  openJSON,
  fetchSealed,
  vaultPrefix,
  siteRoot,
} from "../tools/vaultCrypto.js";

const BLOBS = { console: "b.bin", composer: "e.bin", album: "m.bin" };

let wired = false;

function setState(gate, phase) {
  gate.dataset.adminState = phase;
  gate.querySelector(".admin-gate-probe").hidden = phase !== "probing";
  gate.querySelector(".admin-gate-notfound").hidden = phase !== "denied";
}

/**
 * The two grants this page can be opened with.
 *
 * `console` is the markup, and a collaborator holds it — the console is their
 * page too, showing whichever sections an admin gave them. `admin` is the
 * INVENTORY sealed beside it, which names every post on the site and is
 * therefore the admin's alone. A collaborator gets the first and not the
 * second, and builds their Posts list from the items they were actually given.
 */
async function grants() {
  if (!window.blogAuth) return null;

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return null;

  let data;
  try {
    const res = await fetch(base + "/api/editor/keys", {
      method: "POST",
      headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch (err) {
    return null;
  }

  const open = async (row) => {
    if (!row) return null;
    const raw = b64urlToBytes(row.key);
    return { id: row.id, slug: row.slug, raw, key: await importAesKey(raw) };
  };

  const items = data.items || [];
  const admin = await open(items.find((row) => row.kind === "page"));
  const shared = await open(items.find((row) => row.kind === "console"));

  // The ADMIN key first when this session holds one. It carries the same markup
  // and has since before collaborators existed, so the owner of the blog
  // depends on exactly one key rather than on two and on a build having
  // registered the second. Preferring the other way round is what let a
  // half-applied deploy lock the admin out of the page they would use to find
  // out why.
  const shell = admin || shared;
  if (!shell) return null;
  return { shell, admin, shared };
}

/**
 * Plaintext only this identity may see is in the DOM and the session has gone.
 * `replace`, so Back cannot return to it — the same answer an encrypted post
 * gives, for the same reason.
 */
function wireSignOut() {
  if (wired) return;
  wired = true;
  window.addEventListener("blog:auth-change", async () => {
    const gate = document.querySelector("[data-admin-gate]");
    if (!gate || gate.dataset.adminState !== "open") return;
    const session = window.blogAuth && (await window.blogAuth.getSession());
    if (!session || !session.token) location.replace(siteRoot() + "/");
  });
}

export default async function initAdminGate() {
  const gate = document.querySelector("[data-admin-gate]");
  if (!gate || gate.dataset.adminState === "open") return;
  if (!window.crypto?.subtle) return void setState(gate, "denied");

  wireSignOut();
  setState(gate, "probing");

  const held = await grants();
  if (!held) return void setState(gate, "denied");

  const grant = held.shell;
  const kind = BLOBS[gate.dataset.adminKind] ? gate.dataset.adminKind : "console";
  const host = gate.querySelector(".admin-gate-host");

  /**
   * The blob, under whichever of the two keys this session holds it under.
   *
   * An artifact built before the markup was sealed twice has it under only one
   * of them, and so does a session that holds only one. Trying both is one
   * extra request in the rare case and the difference between a console that
   * opens and a 404 that says nothing about why.
   */
  const other = grant === held.admin ? held.shared : held.admin;
  const fetchUnder = async (name) => {
    for (const key of [grant, other].filter(Boolean)) {
      const sealed = await fetchSealed(`${vaultPrefix()}/${key.slug}/${name}`);
      if (sealed) return { sealed, key: key.key, slug: key.slug };
    }
    return null;
  };

  try {
    const found = await fetchUnder(BLOBS[kind]);
    if (!found) throw new Error("missing");

    if (kind === "composer" || kind === "album") {
      host.innerHTML = await openText(found.key, found.sealed);
      setState(gate, "open");
      const editor = await import(kind === "album" ? "./editor/masonry.js" : "./editor/index.js");
      await (kind === "album" ? editor.initMasonryEditor() : editor.initEditor());
    } else {
      const record = await openJSON(found.key, found.sealed);
      host.innerHTML = String(record.shell || "");
      setState(gate, "open");

      // ── past this line the page is AUTHORISED ─────────────────────────────
      //
      // The key was released and the blob opened under it, which is the whole
      // of the test. Anything that goes wrong while PAINTING is a bug in the
      // console, not a permission — and turning it into "denied" took the
      // markup back off the screen and told the one person who could fix it
      // that they were not allowed in.
      try {
        // The inventory is a second blob under a second key, and its absence is
        // not a failure: it means a collaborator opened the console, and Posts
        // Management builds itself from the items they were given instead.
        let inventory = record.inventory || null;
        if (!inventory && held.admin && held.admin.slug !== found.slug) {
          const book = await fetchSealed(`${vaultPrefix()}/${held.admin.slug}/b.bin`);
          if (book) inventory = (await openJSON(held.admin.key, book)).inventory || null;
        }

        const panel = await import("./blog-management.js");
        // Holding the admin key IS being the admin: the Worker releases it to
        // one identity and to no other. So the console starts from that fact
        // rather than from a request that might not answer, and nothing it
        // learns later can take it away.
        await panel.initBlogManagement(inventory, { admin: !!held.admin });

        // The contents rail is wired on page view, which for markup mounted
        // inside an already-open page has been and gone — the same reason an
        // encrypted article re-runs it after decrypting.
        const toc = await import("../layouts/toc.js");
        toc.initTOC();
      } catch (err) {
        console.error("[blog-management] the console failed to paint", err);
      }
    }

    host.animate(
      [
        { opacity: 0, transform: "translateY(14px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 460, easing: "cubic-bezier(0.16, 0.84, 0.28, 1)", fill: "backwards" }
    );
  } catch (err) {
    setState(gate, "denied");
  }
}
