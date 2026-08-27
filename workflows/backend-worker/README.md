# Redefine-X Backend Worker

A small, **headless** Cloudflare Worker (Hono + D1) that backs the optional
dynamic features of the Redefine-X theme. It serves only JSON / proxy responses —
there is no admin UI or any other front-end in this worker.

## What it does

| Concern | Endpoints | Notes |
| --- | --- | --- |
| **Instant Notes** | `GET /api/notes` (public) · `GET/POST/PUT/DELETE /api/admin/notes[/:id]` (admin) | Banner "Instagram Notes"-style messages, stored in D1. Public read returns the last 5 notes from the past 48h. |
| **Auth** | `POST /api/auth/login` | Verifies a GitHub user token, checks the admin allowlist, and mints a short-lived HMAC session token for **every** verified user (the `isAdmin` claim inside it is what admin routes require). |
| **Giscus CORS proxy** | `GET /api/discussions` · `GET /api/discussions/categories` · `POST /api/oauth/token` | Forwards giscus.app's API with the blog's CORS headers (giscus.app only allows CORS from its own origin). Powers comments + masonry photo likes. |
| **Notifications** | `GET /api/push/vapid-key` (public) · `POST/DELETE /api/push/subscribe` · `GET/POST /api/me/notifications[/read]` · `GET/PUT /api/me/preferences` (signed-in) · `/api/admin/notifications*`, `/api/admin/notify/*` (admin) · `POST /api/hooks/github` (HMAC) | Follow the blog, receive Web Push, and read an in-site inbox. Fan-out is queued at ingest and sent by a **cron trigger**, so a broadcast never exceeds the per-invocation subrequest cap. |
| Health | `GET /` | `{ ok: true }` liveness probe. |

### How a notification travels

```
push to deploy repo → GitHub webhook → read changelog.json at that SHA
                                            ↓
                            INSERT OR IGNORE into notifications
                                            ↓
                    ┌───────────────────────┴──────────────────────┐
              deliveries rows                                 outbox rows
            (the in-site inbox,                          (the push queue, only
          written for every follower)                    for followers with a device)
                                                                  ↓
                                                cron "* * * * *" → drain in batches of 40
```

Two properties fall out of that shape and are worth keeping in mind:

- **`notifications.id` is the idempotency anchor.** Ingest is `INSERT OR IGNORE`,
  so webhook retries, a re-run over the same changelog, and edits to an entry
  that already went out all cost nothing. A deliberate repeat is
  `POST /api/admin/notifications/:id/resend`.
- **Inbox and push are separate.** A reader who declines the browser permission
  still accumulates inbox rows and sees the bell badge. Push is one delivery
  method on top, not the feature itself.

### What triggers one

| Source | Entry point | Topic | Notes |
| --- | --- | --- | --- |
| A new post, or a hand-written changelog entry | `POST /api/hooks/github` | `posts` / as written | Only entries present in `changelog.json`. A post opts out with `notify: false` in its front matter. |
| A new Instant Note | `POST /api/admin/notes` | `notes` | On by default (`NOTIFY_ON_NOTE`); `{"notify": false}` in the request opts one note out. **Editing** a note never notifies — a correction is not news, and re-alerting for a typo fix is how a channel teaches people to mute it. |
| Manual broadcast | `POST /api/admin/notifications` | as given | |

**You are not notified about your own actions.** Whoever's session triggered a
notification is removed from its audience: being told about something you just
did is noise, and worse, it is indistinguishable from the feature misfiring —
you cannot tell "the push worked" from "it went to everyone including me by
mistake". `NOTIFY_SELF = "true"` puts them back in, and `.dev.vars` sets it,
because with one follower in the local database, excluding yourself would mean
nothing observable ever happens.

### Identity & admin flow

There is no password. Identity is rooted in the **giscus GitHub sign-in** (the
same login used for comments), centralized on the front-end in
`window.blogAuth` (`themes/redefine-x/source/js/tools/auth.js`):

```
giscus session ──> /api/oauth/token (proxy) ──> GitHub user token
                                                       │
                           POST /api/auth/login <──────┘
                                   │
            verify token w/ GitHub · check ADMIN_LOGINS allowlist
                                   │
                 admin? ──> mint HMAC session token (SESSION_SECRET)
```

Admin writes (`/api/admin/*`) are authorized **only** by an `isAdmin` HMAC session
token (`Authorization: Bearer <token>`), verified locally with no per-request
GitHub round-trip. Every other verified user gets a token too, with
`isAdmin: false` — that is what lets an ordinary reader follow the blog and read
their own inbox. Follower routes (`/api/me/*`, `/api/push/*`) accept any valid
token and scope every query to the id inside it. Comments and likes keep working
for everyone regardless.

## File map

| File | Role |
| --- | --- |
| `src/index.js`  | Hono router — all routes above, CORS, the giscus proxy, and the cron entry point. |
| `src/auth.js`   | Web Crypto helpers: GitHub token verification, admin-allowlist check, HMAC session sign/verify, base64url. |
| `src/webpush.js`| RFC 8291 `aes128gcm` payload encryption + RFC 8292 VAPID. Pure Web Crypto — the `web-push` npm package assumes Node's crypto and does not run on Workers. |
| `src/notify.js` | The pipeline: ingest → dedupe → resolve audience → inbox + queue; then the batched drain and its failure classification. |
| `src/hooks.js`  | GitHub webhook signature verification and changelog retrieval. |
| `schema.sql`    | D1 schema — `notes`, plus the six notification tables. Idempotent; safe to re-run on a live database. |
| `scripts/vapid-keygen.mjs` | Generates a VAPID key pair with Node's Web Crypto. No dependencies. |
| `wrangler.toml.example` / `.dev.vars.example` | Templates — copy to the real (gitignored) files and fill in. |

## Deploy from scratch

Prerequisites: a Cloudflare account (Workers free tier is plenty), Node.js, and
the Wrangler CLI (`npm i -g wrangler`, then `wrangler login`).

```sh
# 1. Install deps
npm install

# 2. Create your local config from the templates
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars            # only needed for local `wrangler dev`

# 3. Create the D1 database and paste the returned id into wrangler.toml
wrangler d1 create your-notes-db          # → copy database_id

# 4. Create the table
npm run db:init                           # wrangler d1 execute … --remote --file=./schema.sql

# 5. Set non-secret vars in wrangler.toml
#    ALLOWED_ORIGIN  = your blog origin (e.g. https://blog.example.com)
#    ADMIN_LOGINS    = your GitHub numeric id (find it at https://api.github.com/users/<you>)

# 6. Set the session-signing secret (never committed)
wrangler secret put SESSION_SECRET        # paste a random 32+ byte value

# 7. Deploy. If you set the [[routes]] custom_domain block, the domain + DNS
#    are provisioned automatically (the zone must be on Cloudflare).
npm run deploy
```

### Wire the theme to the worker

In your site's theme config (`_config.redefine-x.yml`), point every consumer at
the worker's URL (one worker serves all four concerns, so one domain is enough):

```yaml
home_banner:
  instant_notes:
    enable: true
    api_url: https://<your-worker-domain>      # notes + auth

comment:
  config:
    giscus:
      proxy: https://<your-worker-domain>/     # comments + masonry likes

notifications:
  enable: true
  api_url: https://<your-worker-domain>        # follow + push + inbox
  vapid_public_key: <the public key from npm run vapid:keygen>
```

Then regenerate the site (`hexo generate`) so the new URL is baked into the
exported `window.config`.

## Enabling notifications

Everything above deploys the worker. Notifications need four extra things: a
VAPID key pair, a cron trigger, a webhook, and one careful first run.

```sh
# 1. Add the notification tables (idempotent — existing notes are untouched)
npm run db:init

# 2. Generate the VAPID key pair
npm run vapid:keygen
#    → public  : wrangler.toml [vars] VAPID_PUBLIC_KEY *and* the theme config
#    → private : the secret in step 4
#    Both values must match, and rotating them invalidates every subscription.

# 3. Fill in wrangler.toml
#    [triggers] crons = ["* * * * *"]     ← required; this is what SENDS
#    VAPID_PUBLIC_KEY, VAPID_SUBJECT, SITE_URL, DEPLOY_REPO, DEPLOY_BRANCH

# 4. Set the two new secrets
wrangler secret put VAPID_PRIVATE_KEY       # the private half from step 2
wrangler secret put GITHUB_WEBHOOK_SECRET   # any long random value; reused in step 6

# 5. Deploy (this is also what registers the cron trigger)
npm run deploy

# 6. Add the webhook on the DEPLOY repo:
#    Settings → Webhooks → Add webhook
#      Payload URL  https://<your-worker-domain>/api/hooks/github
#      Content type application/json
#      Secret       the value from step 4
#      Events       Just the push event
#    GitHub sends a ping immediately; a 200 with {"pong":true} means it is wired.
```

### The first run is a dry run — on purpose

The first push a fresh database sees carries a changelog describing your **whole
back catalogue**, and nobody asked to be told about all of it at once. So the
first webhook automatically records every entry as already-delivered *without
sending anything*, stamps `bootstrap_at`, and only then goes live.

Verify it did what you expect before trusting it:

```sh
# What the pipeline thinks its state is
curl -H "Authorization: Bearer <admin token>" \
     https://<your-worker-domain>/api/admin/notifications

# Force a dry run back on at any time (e.g. before importing a big changelog)
curl -X PUT -H "Authorization: Bearer <admin token>" \
     -H "Content-Type: application/json" -d '{"dry_run":true}' \
     https://<your-worker-domain>/api/admin/notify/settings
```

`NOTIFY_DRY_RUN = "true"` in `wrangler.toml` does the same thing and outranks the
database setting — useful while developing.

### Nothing arrives — what to check

A push that never shows up looks identical whichever link in the chain broke.
One endpoint checks them all and names the ones actually blocking delivery:

```sh
curl -H "Authorization: Bearer <admin token>" \
     https://<your-worker-domain>/api/admin/notify/diagnose
```

It reports the VAPID pair (including whether the two halves belong to each
other — the commonest silent failure), whether *you* are a follower with a
device **in that Worker's database**, dry-run state, the queue split into "due"
and "not due yet", the last delivery error, and a `blockers` array. An empty
`blockers` means the pipeline is clear and the problem is downstream — browser
permission, or no notification created yet.

The five that account for nearly every case:

| Symptom | Cause |
| --- | --- |
| Queue has due rows, nothing sends | `wrangler dev` **does not fire cron**. Call `POST /api/admin/notify/drain`. |
| `configError` from drain, or a 500 from the test push | `VAPID_PRIVATE_KEY` unset or not the partner of `VAPID_PUBLIC_KEY`. |
| `you.following: false` or `you.devices: 0` | You followed on the site pointed at the **other** Worker. Followers and devices live in that Worker's database, not this one. |
| Notification exists, zero recipients | `NOTIFY_SELF=false` and you are the only follower — you are excluded from what you trigger. |
| Creating a note returns 403 | Mode B: production refuses admin writes from a localhost origin (`ALLOW_LOCALHOST_ADMIN=false`). |

### Proving push works before anything depends on it

The encryption is the only part that can fail silently. Test it in isolation:
follow the blog from your own browser, then

```sh
curl -X POST -H "Authorization: Bearer <admin token>" \
     https://<your-worker-domain>/api/admin/notify/test
```

A notification should appear within a second or two. If it does not, the response
body carries the push service's status code — `401`/`403` means the VAPID pair is
mismatched, `404`/`410` means the stored subscription is stale.

## Local development

```sh
npm run dev            # wrangler dev on :8787 (uses .dev.vars)
npm run db:init:local  # create the tables in the LOCAL D1 database
npm run vapid:keygen   # print a fresh VAPID key pair
```

### Choosing a backend — three permitted combinations

`developer.backend` in the theme config selects it. Exactly three pairings are
allowed; the fourth is rejected in code rather than by convention.

| | Front-end | Backend | `developer.backend` | Reachable at all | Admin writes | When |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | `localhost:4000` | `localhost:8787` (`wrangler dev`) | `local` | yes — `.dev.vars` sets `ALLOWED_ORIGIN=http://localhost:*` | **allowed** (`ALLOW_LOCALHOST_ADMIN=true` locally) | Full-stack work: notes admin, notifications, schema changes. Everything writes to the **local** D1. |
| **B** | `localhost:4000` | `backend-blog.jason-yang.top` | `production` *(default)* | **only if** you add `http://localhost:*` to the production `ALLOWED_ORIGIN` and redeploy | **refused, 403** | Theme/CSS work against real data. Off by default — the stricter setting, and unnecessary when the Worker also runs locally. |
| **C** | `blog.jason-yang.top` | `backend-blog.jason-yang.top` | ignored — forced | yes | allowed | Live. |
| ~~D~~ | `blog.jason-yang.top` | `localhost:8787` | — | — | — | **Impossible.** A deployed page ignores `backend: local` entirely. |

Three guards make that table enforceable rather than aspirational:

- **`backend: local` only applies on a localhost page, and only to a loopback
  URL.** Committing a stray `backend: local` degrades a deployed site to C
  instead of breaking it, and `local_api_url` cannot be repointed at an
  arbitrary host — otherwise one config line would turn the developer hook into
  a redirect for every authenticated API call, session token included.
- **`ALLOWED_ORIGIN` is authoritative.** No origin is special-cased, localhost
  included. `*` inside an entry stands for one label — a port
  (`http://localhost:*`) or one subdomain (`https://*.example.com`) — and never
  crosses a dot, so a pattern cannot be widened by a host somebody else
  registers.
- **The production Worker refuses admin writes from a localhost origin**
  (`ALLOW_LOCALHOST_ADMIN = "false"`). The hazard here is not an attacker, it is
  you: a dev build looks exactly like the live site, and one careless click
  there posts to the live banner or pushes to real followers — and a delivered
  push has no undo.

Be clear about what CORS is doing here, though. It is enforced by the browser
and governs which web origins may *read* a response; it is not authentication.
Any non-browser client can send whatever `Origin` header it likes and ignore the
answer, which is why every privileged route is gated on the Bearer session token
instead. The allowlist earns its keep through least privilege and honesty — it
should mean exactly what it says — not because it is holding attackers off.

Whichever mode is in force, `tools/auth.js` prints it once on localhost:

```
[blogAuth] backend: LOCAL → http://localhost:8787
```

The selection is all-or-nothing by design. A session token is HMAC-signed with
the Worker's `SESSION_SECRET`, and `wrangler dev` reads a different one from
`.dev.vars` than production does; a front-end that minted its token at one
instance and spent it at the other gets a 403 on every privileged route. Every
consumer — instant notes, notifications, auth — therefore resolves its base
through `blogAuth.resolveApiBase()`, never from `api_url` directly.

### Switching between A and B

Edit one line in `_config.redefine-x.yml`, then restart `hexo server` (the value
is baked into the exported `window.theme` at generate time):

```yaml
developer:
  backend: local        # A — full stack local
  # backend: production # B — local page, real data, no admin writes
```

Confirm in the browser console with `blogAuth.backend`.

### What works on localhost, and what does not

In mode **A**:

| | localhost | Why |
| --- | --- | --- |
| Service worker + push | **yes** | `http://localhost` is a secure context, so no TLS is needed. Pushes still travel through the real FCM/Mozilla endpoints. |
| CORS | **yes** | `resolveOrigin()` always allows localhost and 127.0.0.1, whatever `ALLOWED_ORIGIN` says. |
| Instant notes admin | **yes** | The local Worker sets `ALLOW_LOCALHOST_ADMIN=true`; writes land in the local D1. |
| Masonry likes | **yes**, via production | They only use the stateless giscus proxy (`/api/discussions`), so they stay on the deployed Worker. Nothing is written there. |
| Cron drain | **no**, not automatically | `wrangler dev` does not fire triggers. Use `POST /api/admin/notify/drain`, or run `wrangler dev --test-scheduled` and hit `http://localhost:8787/__scheduled`. |
| GitHub webhook | **no** | GitHub cannot reach localhost. Use `POST /api/admin/notify/ingest`, which runs the same ingest against `SITE_URL/changelog.json`. |

### A full local round trip

```sh
# terminal 1 — the site
npm run server                    # from the repo root; http://localhost:4000

# terminal 2 — the worker
npm run db:init:local && npm run dev
```

Then, in the browser at `http://localhost:4000`: sign in from the bell, follow,
accept the notification prompt. After that:

```sh
# ingest the changelog hexo is serving (no webhook needed)
curl -X POST -H "Authorization: Bearer <admin token>" \
     http://localhost:8787/api/admin/notify/ingest

# send what that queued (no cron in dev)
curl -X POST -H "Authorization: Bearer <admin token>" \
     http://localhost:8787/api/admin/notify/drain
```

Grab `<admin token>` from the browser console with
`await blogAuth.getSessionToken()`.

`NOTIFY_GRACE_SEC=0` in `.dev.vars` is what makes that second call send anything:
in production ingest queues each push 120 seconds out so a notification cannot
outrun the deploy, and locally there is no deploy to wait for.

## Notes

- **Secrets never live in committed files.** `SESSION_SECRET`,
  `VAPID_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` are Wrangler secrets in
  production and `.dev.vars` entries locally. `wrangler.toml` and `.dev.vars` are
  gitignored; the `*.example` files are the templates.
- Rotating `SESSION_SECRET` simply invalidates existing sessions (2-hour TTL) —
  people just sign in again. No data is affected.
- Rotating the **VAPID pair is not** so cheap: every existing push subscription
  becomes undeliverable and each follower has to enable push again. The inbox
  survives, so nothing is lost, but treat the pair as permanent once deployed.
- **Privacy.** Per follower the worker stores a GitHub id, login and avatar URL,
  the push endpoint and its two public keys, and which notifications they were
  sent. `PUT /api/me/preferences {"follow": false}` deletes all of it —
  devices, inbox rows and the follower record — which is why unfollowing is a
  real erasure rather than a flag.
- **Cost.** The cron runs every minute and does one indexed `SELECT` against an
  empty table when there is nothing to send, so an idle deployment stays inside
  the free plan comfortably.
