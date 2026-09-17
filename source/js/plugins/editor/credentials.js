/**
 * How long the page is allowed to hold the repository tokens.
 *
 * The editor commits from the browser, so the Gitea and GitHub tokens are handed
 * to this page. Neither carries an expiry — Gitea's tokens have none, and the
 * GitHub PAT is fine-grained but standing — so what bounds the exposure is not a
 * stamp on the credential. It is how long this page keeps it, and that is the
 * whole of this file.
 *
 * Two rules, and the second is what makes the first worth anything:
 *
 *   1. NOTHING PERSISTS. The ticket lives in one module's closure (repo.js) and
 *      is never written to localStorage, sessionStorage, IndexedDB or a cookie —
 *      the same bargain post keys make. The Worker marks its response
 *      `Cache-Control: no-store`, so it is not in the HTTP cache either, and
 *      `repo.forget()` blanks the token on every backend row before releasing
 *      it so a request still in flight cannot read one back out.
 *
 *   2. IT IS ERASED THE MOMENT NOBODY NEEDS IT.
 *
 * ── every case in which the credentials go ──────────────────
 *
 *   leaving the editor    `release()` from deactivate(), which is every exit it
 *                         has: Stop editing, a save that navigates away, and the
 *                         error paths that close the session.
 *   leaving the console    `release()` when the unpublish bar closes. Blog
 *                         Management opens a ticket of its own for that bar.
 *   signing out           `blog:auth-change` leaving no session. The session is
 *                         what minted the ticket, and a credential outliving the
 *                         session that fetched it is the case this exists for.
 *   session refused       a 401 from either backend (repo.js `guard`).
 *   navigating away       swup `visit:start`. Single-page navigation does NOT
 *                         unload this module, so without this the tokens would
 *                         sit in memory behind every page the author reads next.
 *   closing the tab       `pagehide` — which covers close, reload and a
 *                         back-forward-cache freeze alike. `beforeunload` is not
 *                         reliable on mobile and `unload` disqualifies the page
 *                         from that cache, so neither is used.
 *   tab discarded         `freeze`, for a background tab the browser reclaims.
 *   idling                repo.js's own timer. A ticket nobody has touched for
 *                         the session bound is erased rather than merely
 *                         refused — the difference between a stale credential
 *                         and no credential.
 *
 * A refcount rather than a flag: the console and the editor are two surfaces
 * that can each want the ticket, and one of them finishing must not disarm the
 * other. `drop()` ignores the count — an event in the list above is not a
 * negotiation.
 */

import * as repo from "./repo.js";
import { dropAssetCache } from "../../tools/vaultCrypto.js";
import { forgetAssets } from "./assets.js";
import { forgetGrants } from "./session.js";
import { forgetTree } from "./picker.js";

let holders = 0;
let wired = false;

/**
 * Erase now, whatever anybody is holding.
 *
 * The repository tokens are not the only thing this page was lent. The post
 * keys came from the same session, and the picture browser holds a listing of
 * every file in the repository — including the names of the ones an encrypted
 * post withheld. All of it goes at the same moment and for the same reason.
 */
export function drop() {
  holders = 0;
  repo.forget();
  forgetGrants();
  forgetAssets();
  forgetTree();
}

/** This surface needs the credentials. */
export function hold() {
  wire();
  holders += 1;
}

/** This surface is done with them; the last one out erases. */
export function release() {
  holders = Math.max(0, holders - 1);
  if (!holders) drop();
}

function wire() {
  if (wired) return;
  wired = true;

  window.addEventListener("blog:auth-change", async () => {
    let session = null;
    try {
      session = window.blogAuth ? await window.blogAuth.getSession() : null;
    } catch (err) {
      /* unreadable is as good as gone */
    }
    if (session && session.token) return;
    drop();
    // Signed out is not the same as merely finished. `drop` leaves the OPEN
    // DOCUMENT's images alone because the page behind the editor is usually
    // still showing that article — but there is no session to be showing it
    // to any more, and on a page where plugins/vault.js is not loaded nothing
    // else would ever take those bytes back.
    dropAssetCache();
  });

  window.addEventListener("pagehide", drop);
  document.addEventListener("freeze", drop);

  // Following a link out of the editor replaces the page without unloading this
  // module, so it has to be caught here as well as in deactivate().
  try {
    swup.hooks.on("visit:start", drop);
  } catch (err) {
    /* no swup on this page; the listeners above still cover it */
  }
}
