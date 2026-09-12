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
  pageId,
} from "../tools/vaultCrypto.js";

const BLOBS = { console: "b.bin", composer: "e.bin" };

let wired = false;

function setState(gate, phase) {
  gate.dataset.adminState = phase;
  gate.querySelector(".admin-gate-probe").hidden = phase !== "probing";
  gate.querySelector(".admin-gate-notfound").hidden = phase !== "denied";
}

/** The grant that opens the admin surface, or null. */
async function adminGrant() {
  if (!window.blogAuth) return null;

  const session = await window.blogAuth.getSession();
  const base = window.blogAuth.resolveApiBase();
  if (!session || !session.token || !base) return null;

  let data;
  try {
    const res = await fetch(base + "/api/vault/keys", {
      method: "POST",
      headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch (err) {
    return null;
  }

  const wanted = await pageId("admin");
  const row = (data.posts || []).find((p) => p.id === wanted);
  if (!row) return null;

  const raw = b64urlToBytes(row.key);
  return { id: row.id, slug: row.slug, raw, key: await importAesKey(raw) };
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

  const grant = await adminGrant();
  if (!grant) return void setState(gate, "denied");

  const kind = gate.dataset.adminKind === "composer" ? "composer" : "console";
  const host = gate.querySelector(".admin-gate-host");

  try {
    const sealed = await fetchSealed(`${vaultPrefix()}/${grant.slug}/${BLOBS[kind]}`);
    if (!sealed) throw new Error("missing");

    if (kind === "composer") {
      host.innerHTML = await openText(grant.key, sealed);
      setState(gate, "open");
      const editor = await import("./editor/index.js");
      await editor.initEditor();
    } else {
      const record = await openJSON(grant.key, sealed);
      host.innerHTML = String(record.shell || "");
      setState(gate, "open");
      const panel = await import("./blog-management.js");
      await panel.initBlogManagement(record.inventory || { items: [] });

      // The contents rail is wired on page view, which for markup mounted
      // inside an already-open page has been and gone — the same reason an
      // encrypted article re-runs it after decrypting.
      const toc = await import("../layouts/toc.js");
      toc.initTOC();
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
