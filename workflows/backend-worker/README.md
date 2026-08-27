# Redefine-X Backend Worker

A headless Cloudflare Worker (Hono + D1) backing the Redefine-X theme. It has no
front-end of its own — it serves JSON and proxies, and the theme talks to it.

Four concerns, one Worker, one custom domain:

| Structure| Information|
| --- | --- |
| **Instant Notes** | D1-backed notes on the home banner. Public read, admin CRUD. |
| **Auth** | Verifies a giscus-derived GitHub token and mints a short-lived HMAC session. Every verified reader gets one; only allowlisted ids get `isAdmin`. |
| **Giscus proxy** | giscus.app allows CORS only from its own origin, so comments and masonry likes are forwarded through here. |
| **Notifications** | Follow, Web Push, an in-site inbox, and the deployment webhook that turns a published post into a notification. |

## How a notification travels

```
  a deployment succeeds ─┐
  an admin posts a note ─┼─→ ingestEntries()  ─→ notifications  (the content, deduped by id)
  an admin broadcasts ───┘         │              deliveries    (the in-site inbox, per reader)
                                   │              outbox        (the push queue, per device)
                                   │
                                   ├─→ drainOutbox(6)     immediately, after the response
                                   └─→ drainOutbox(12)    every 5 minutes, from the cron
                                              │
                                              └─→ sendWebPush() → sent | retried | dead
```

Two properties are worth knowing because everything else follows from them:

**Idempotency lives in `notifications.id`.** An entry that already exists is a
no-op. That is what makes a webhook retry, a re-run over the same changelog, and
an edit to an already-announced post all cost nothing and send nothing.

**Fan-out and sending are separate.** Ingest resolves the audience entirely
inside SQLite (`INSERT … SELECT`), so a broadcast to any number of followers is
the same two round trips. Sending is one subrequest and one round of public-key
crypto per device, so it is bounded: ingest sends the first six itself and the
cron carries the rest. A fan-out therefore cannot exceed the per-invocation CPU
or subrequest ceiling however many followers there are.

## Configuration

Seven values run this Worker and nothing reads an eighth.

| | Location | Use |
| --- | --- | --- |
| `ADMIN_LOGINS` | `wrangler.toml` | Comma-separated GitHub **numeric ids** (immutable — a login name can be released and re-registered by someone else). Decides the `isAdmin` claim. |
| `ALLOWED_ORIGIN` | **dashboard** | CORS allowlist. Deliberately not in `wrangler.toml` so it can be changed without a redeploy. |
| `SITE_URL` | `wrangler.toml` | The site this backend belongs to. The **one** place a URL comes from. |
| `VAPID_PUBLIC_KEY` | `wrangler.toml` | Shipped to every subscribing browser; not a secret. |
| `SESSION_SECRET` | secret | Signs session tokens. |
| `VAPID_PRIVATE_KEY` | secret | The 32-byte P-256 scalar. |
| `GITHUB_WEBHOOK_SECRET` | secret | Authenticates the deployment webhook — **and** is what identifies the deploy repo, since only the repository holding it can produce a valid signature. |

`SITE_URL` is used for the changelog fallback source, the click target of a note
notification and of a test push, the VAPID `sub` claim, and the fallback CORS
origin. Nothing else supplies a URL.

There are no feature flags. A flag whose only correct value is "on" is not
configuration — it is a second code path that nobody exercises. What used to be
`ALLOW_LOCALHOST_ADMIN`, `NOTIFY_ON_NOTE`, `NOTIFY_SELF`, `NOTIFY_DRY_RUN`,
`NOTIFY_GRACE_SEC`, `DEPLOY_REPO`, `DEPLOY_BRANCH`, `VAPID_SUBJECT`,
`NOTE_TITLE` and `GITHUB_READ_TOKEN` is now simply how the Worker behaves.

### ALLOWED_ORIGIN

Comma-separated **domains**. Scheme and port are ignored, so
`blog.example.com` covers https, http and every port.

| Entry | Matches |
| --- | --- |
| `blog.example.com` | that host |
| `*.example.com` | any single-label subdomain — `*` never crosses a dot |
| `local` | any private address: `localhost`, `127.x`, `10.x`, `172.16–31.x`, `192.168.x`, `*.local` |
| `192.168.*.*` | one LAN range (an octet is a label) |
| `*` | everything — not recommended |

Unset, it falls back to the `SITE_URL` domain. **With both unset it allows
nobody.** A blank allowlist fails closed, because a wildcard produced by a
configuration mistake is exactly the wildcard nobody chose.

Be clear about what this buys, though. CORS is enforced by the browser and
governs which web origins may *read* a response; it is not authentication. Any
non-browser client can send whatever `Origin` header it likes and ignore the
answer, which is why every privileged route is gated on the Bearer session token
instead. The allowlist earns its keep through least privilege and honesty.

## Database

Six tables. `wrangler d1 execute <db> --remote --file=./schema.sql` creates them
and is safe to re-run.

| Table | Holds | Grows with |
| --- | --- | --- |
| `notes` | Instant Notes. A separate feature that happens to share the Worker. | notes written |
| `followers` | One row per GitHub identity that has followed: `topics` (comma-separated allowlist, empty means everything) and `muted_until`. | readers |
| `push_devices` | Push subscriptions — `endpoint` (the natural key), `p256dh`, `auth`, `fail_count`. Several devices may hang off one follower. | readers × devices |
| `notifications` | The notification itself, independent of who receives it. `id` is the dedupe key supplied by the source. | notifications |
| `deliveries` | The in-site inbox: one row per (notification, follower), carrying `read_at`. Written even for a follower with no push device, which is what lets the bell work for someone who declined the OS prompt. | notifications × readers |
| `outbox` | The push queue: one row per (notification, device), carrying `state`, `attempts` and `not_before`. Pruned after 90 days. | notifications × devices |

A seventh table, `settings`, is dropped by `schema.sql`. It held `dry_run` and
`bootstrap_at` — a hand-flipped guard against a fresh database announcing the
entire back catalogue — and `last_push_sha`, which nothing read. The guard is now
stateless: an ingest that finds more than ten *new* entries at once records them
and delivers none, because a burst that size is never news. It needs no
migration, cannot be left in the wrong position, and keeps working on a database
that is years old.

## API reference

Base URL is the Worker's custom domain. All responses are JSON.

Authentication is `Authorization: Bearer <token>`, where the token comes from
`POST /api/auth/login` and is verified locally by HMAC — no GitHub round trip per
request. **Reader** routes take any valid session; **admin** routes additionally
require the `isAdmin` claim. Reader routes are scoped to the token's own GitHub
id in every query, so a valid token grants access to that identity only.

Failures are `{ "error": "…" }` with `400` (bad request), `401` (missing or
unverifiable credential), `403` (valid credential, insufficient), `404`, `422`,
`500` or `502`.

### Public

#### `GET /`
Liveness probe. → `{ "service": "redefine-x backend worker", "ok": true }`

#### `GET /api/notes`
The last 5 notes from the past 48 hours, newest first.

```json
[{ "id": 12, "text": "…", "emoji": "🎧", "color": "default", "created_at": "2026-08-27T09:14:02Z" }]
```

#### `GET /api/push/vapid-key`
The application server public key, so the front-end works even before the theme
config is filled in. → `{ "key": "BAwX…" | null }`

### Giscus proxy

Forwarded verbatim to `https://giscus.app` with this Worker's CORS headers.
Nothing is stored and nothing is authenticated here — the giscus session in the
request body *is* the credential.

| | |
| --- | --- |
| `GET /api/discussions` | comments, masonry like counts |
| `GET /api/discussions/categories` | |
| `POST /api/oauth/token` | giscus session → GitHub user token |

### Auth

#### `POST /api/auth/login`
The only route that talks to GitHub. Verifies the token by asking GitHub who it
belongs to, then mints a 2-hour session.

```jsonc
// request
{ "githubToken": "ghu_…" }   // from POST /api/oauth/token
// response
{ "id": 108601445, "login": "…", "avatar": "https://…", "isAdmin": true,
  "token": "<session>", "exp": 1787000000000 }
```

Every verified user gets a token, not just admins — following the blog is a
per-reader action, so an ordinary reader needs a credential to register a device
and read their own inbox. The allowlist decides only the `isAdmin` claim inside
it, which is the only thing `/api/admin/*` accepts.

### Reader

#### `GET /api/me/notifications`
Everything the notification panel paints, in one round trip.

```jsonc
{
  "items": [{ "id": "post:2026/08/22/Title", "type": "post", "topic": "posts",
              "title": "…", "body": "…", "url": "https://…", "image": "",
              "published_at": "2026-08-22T10:00:00Z", "read_at": null }],
  "unread": 3,
  "devices": 2,          // push devices registered for this reader
  "following": true,
  "topics": "",          // "" means every topic
  "muted_until": null
}
```

Capped at 30 items, newest first.

#### `POST /api/me/notifications/read`
`{}` marks everything read. `{ "ids": ["post:…"] }` marks just those (max 90).
→ `{ "ok": true }`

#### `GET /api/me/preferences`
The settings view: adds the device list and the follow date that the inbox
response leaves out.

```jsonc
{ "following": true, "topics": "posts,notes", "muted_until": null,
  "since": "2026-06-01T08:00:00Z",
  "devices": [{ "id": 4, "ua": "Mozilla/5.0…", "created_at": "…", "last_ok_at": "…" }] }
```

#### `PUT /api/me/preferences`
| Body | Effect |
| --- | --- |
| `{ "topics": "posts,notes" }` | set the topic allowlist (`""` = all) |
| `{ "muted_until": "2026-09-01T00:00:00Z" }` | mute; `null` unmutes |
| `{ "follow": false }` | **leave** — deletes devices, inbox rows and the follower record |

`follow: false` is a real erasure, not a flag: it removes the whole of what this
Worker holds about a reader.

#### `POST /api/push/subscribe`
Registers a device and creates the follower row in the same round trip, so
following and subscribing cannot get out of sync. Accepts either the flat shape
or a raw `PushSubscription#toJSON()`.

```jsonc
{ "endpoint": "https://fcm.googleapis.com/…",
  "keys": { "p256dh": "…", "auth": "…" },
  "topics": "posts" }                        // optional
```
→ `{ "ok": true, "following": true }`

The endpoint is the identity of a subscription, so re-subscribing the same
browser rewrites the keys and clears the failure count rather than adding a
second row that will never work.

#### `DELETE /api/push/subscribe`
`{ "endpoint": "…" }` removes one device; an empty body removes all of this
reader's devices. The follower row and the inbox survive — leaving entirely is
`PUT /api/me/preferences { "follow": false }`.

### Admin

#### `GET /api/admin/notes`
All notes, newest first, capped at 50 — not just the 48-hour public window.

#### `POST /api/admin/notes`
```jsonc
{ "text": "…", "emoji": "🎧", "color": "default", "notify": true }
```
→ `201 { "ok": true, "id": 13, "notification": { … } }`

Creating a note announces it on the `notes` topic; `"notify": false` opts one
note out. Editing never announces — a correction is not news, and re-alerting for
a typo fix is how a channel teaches people to mute it. All notes share one tray
tag, so an unread note is replaced by the next rather than stacking.

#### `PUT /api/admin/notes/:id` · `DELETE /api/admin/notes/:id`
→ `{ "ok": true }`

#### `POST /api/admin/notifications`
Broadcast by hand. One entry, or `{ "entries": [ … ] }` for several.

```jsonc
{
  "id": "announce:2026-maintenance",   // required — the dedupe key, forever
  "title": "…",                        // required
  "url": "https://…",                  // required
  "body": "", "type": "announcement", "topic": "announcements",
  "image": "", "tag": "announcements", "silent": false,
  "audience": { "kind": "topic" }      // "topic" | "all" | { "kind": "users", "users": [id|login] }
}
```
→ `201 { "ok": true, "ingested": ["…"], "skipped": [], "deliveries": 12, "queued": 17 }`

`400` if nothing was new — a missing `id`/`title`/`url`, or an id already sent.

#### `GET /api/admin/notifications`
History and delivery stats for the last 50, plus totals.

```jsonc
{ "items": [{ "id": "…", "type": "post", "topic": "posts", "title": "…", "url": "…",
              "source": "changelog", "published_at": "…",
              "recipients": 12, "read": 5, "pushed": 17, "pending": 0, "failed": 1 }],
  "followers": 12, "devices": 17 }
```

#### `POST /api/admin/notifications/:id/resend`
The deliberate override of the dedupe rule. Re-queues every device belonging to
someone already in that notification's inbox — the audience is fixed at ingest,
so a resend cannot widen it. → `{ "ok": true, "queued": 17 }`, `404` for an
unknown id.

#### `POST /api/admin/notify/ingest`
The same ingest the webhook performs, triggered by hand — which is how the
pipeline is exercised locally, where GitHub has no route to the Worker. Reads
`{ "url": "…" }`, else `SITE_URL/changelog.json`.
→ `{ "ok": true, "url": "…", "ingested": [], "skipped": [], "deliveries": 0, "queued": 0 }`

`"absorbed": true` in the response means more than ten entries were new at once:
they were recorded (and are deduped from now on) but deliberately not delivered.

#### `POST /api/admin/notify/drain`
Sends one batch now instead of waiting for the next cron tick.
→ `{ "ok": true, "sent": 12, "dropped": 0, "retried": 0, "dead": 0, "remaining": 5 }`

#### `POST /api/admin/notify/test`
Sends a test push straight to your own devices, bypassing ingest — so it proves
the VAPID pair and the `aes128gcm` encryption in isolation, before any of the
pipeline depends on them. `404` if you have no device registered *in this
database*.

#### `GET /api/admin/notify/diagnose`
One request that answers the question the pipeline makes hard: a push that never
arrives looks identical whether the keys are wrong, the queue is empty, or
nothing drained it.

```jsonc
{ "worker": { "site_url": "…", "allowed_origin": "…", "request_origin": "…" },
  "vapid": { "ok": true, "publicKey": "valid", "privateKey": "valid", "pair": "matched" },
  "you": { "github_id": 108601445, "login": "…", "following": true, "topics": "(all)", "devices": 2 },
  "totals": { "followers": 12, "devices": 17, "notifications": 40,
              "sent": 300, "dead": 2, "pendingDue": 0, "pendingLater": 0 },
  "last_error": null,
  "blockers": [],
  "verdict": "pipeline looks clear" }
```

`blockers` lists everything that would stop a push reaching **you**, in the order
it would bite. Empty means the problem is elsewhere — browser permission, or the
notification simply not created yet.

### Webhook

#### `POST /api/hooks/github`
Not reachable from a browser (no CORS), authenticated by HMAC over the raw body.

Event: **`deployment_status`**, acted on only when `state` is `success` and the
environment is production. `ping` answers `{ "ok": true, "pong": true }`;
anything else answers `{ "ok": true, "ignored": "…" }`.

`deployment_status` rather than `push` is the whole design. A push means the
deploy repo has new commits, which is *not* the moment the site is readable; a
successful deployment is. Announcing on `push` meant holding every notification
behind a fixed grace period, guessing at how long the host would take.

The changelog is then read at the deployed **commit SHA**
(`raw.githubusercontent.com/<repo>/<sha>/changelog.json`), falling back to
`SITE_URL/changelog.json`. Reading at the SHA is what makes a rebuild or a
rollback mid-flight unable to change what we ingest.

The response goes out as soon as the durable writes land — GitHub abandons a
delivery after ten seconds, which is not a budget worth spending on push traffic.

## Deploy from scratch

```sh
# 1. Install deps
npm install

# 2. Create your local config from the templates
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars

# 3. Create the D1 database; paste the returned id into wrangler.toml
npx wrangler d1 create instant-notes-db

# 4. Create the tables
npm run db:init

# 5. Generate the VAPID key pair
npm run vapid:keygen
#    public  → wrangler.toml [vars] VAPID_PUBLIC_KEY *and* the theme config
#    private → step 6
#    The two must match byte for byte, and rotating them invalidates every
#    existing subscription.

# 6. Set the secrets (never committed)
npx wrangler secret put SESSION_SECRET
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# 7. Fill in wrangler.toml [vars]: ADMIN_LOGINS, SITE_URL, VAPID_PUBLIC_KEY

# 8. Set ALLOWED_ORIGIN in the Cloudflare dashboard (NOT in wrangler.toml)
#    Workers & Pages → <worker> → Settings → Variables and Secrets

# 9. Deploy. This also provisions the custom domain + DNS (zone must be on
#    Cloudflare) and registers the cron trigger.
npm run deploy
```

### Wire the theme to the Worker

```yaml
# _config.redefine-x.yml
home_banner:
  instant_notes:
    api_url: https://backend.example.com
notifications:
  enable: true
  api_url: https://backend.example.com
  vapid_public_key: <the public half from step 5>
  changelog: true
  topics: posts, announcements, notes
```

### Add the webhook

On the **deploy** repo (the one `public/` is a submodule of, not the source
repo): Settings → Webhooks → Add webhook

| | |
| --- | --- |
| Payload URL | `https://<worker-domain>/api/hooks/github` |
| Content type | `application/json` |
| Secret | the value from step 6 |
| Events | *Let me select individual events* → **Deployment statuses** |

GitHub sends a ping immediately; a `200` with `{"pong": true}` means it is wired.


## Local development

```sh
npm run dev            # wrangler dev on :8787 (uses .dev.vars)
npm run db:init:local  # create the tables in the LOCAL D1 database
npm run vapid:keygen   # print a fresh VAPID key pair
```

### Choosing a backend — three permitted combinations

`developer.backend` in the theme config selects it. Exactly three pairings can be
expressed; the fourth is rejected in code rather than by convention.

| | Front-end | Backend | `developer.backend` | Reachable | When |
| --- | --- | --- | --- | --- | --- |
| **A** | `localhost:4000` | `localhost:8787` | `local` | yes — `.dev.vars` sets `ALLOWED_ORIGIN=local` | Full-stack work. Everything writes to the **local** D1. |
| **B** | `localhost:4000` | production | `production` *(default)* | only if `local` is added to the production `ALLOWED_ORIGIN` | Theme work against real data. |
| **C** | deployed site | production | ignored — forced | yes | Live. | 

Two guards make that enforceable:

- **`backend: local` only applies on a localhost page, and only to a loopback
  URL.** A stray `backend: local` committed by accident degrades a deployed site
  to C instead of breaking it, and `local_api_url` cannot be repointed at an
  arbitrary host — otherwise one config line would turn the developer hook into
  a redirect for every authenticated API call, session token included.
- **`ALLOWED_ORIGIN` is authoritative.** No origin is special-cased, localhost
  included.

⚠️ **Mode B has no guard rail.** The production Worker used to refuse admin
writes from a localhost origin; that check is gone. A dev build looks exactly
like the live site, so in mode B one careless click posts to the live banner or
pushes to real followers — and a delivered push has no undo. Prefer mode A.

The selection is all-or-nothing by design. A session token is HMAC-signed with
the Worker's `SESSION_SECRET`, and `wrangler dev` reads a different one from
`.dev.vars` than production does; a front-end that minted its token at one
instance and spent it at the other gets a 403 on every privileged route. Every
consumer — instant notes, notifications, auth — therefore resolves its base
through `blogAuth.resolveApiBase()`, never from `api_url` directly.
`tools/auth.js` prints the choice once on localhost:

```
[blogAuth] backend: LOCAL → http://localhost:8787
```

Switching means editing one line in `_config.redefine-x.yml` and restarting
`hexo server` — the value is baked into `window.theme` at generate time. Confirm
with `blogAuth.backend` in the console.

### What works on localhost, and what does not

| | Mode A | Why |
| --- | --- | --- |
| Service worker + push | **yes** | `http://localhost` is a secure context, so no TLS is needed. A LAN address (`192.168.x`) is **not** — the browser withholds `serviceWorker` entirely there, so Follow "works", the inbox fills, and no push ever arrives. |
| CORS | **yes** | `.dev.vars` sets `ALLOWED_ORIGIN=local`. There is no built-in localhost exception. |
| Instant notes admin | **yes** | Writes land in the local D1. |
| Masonry likes | **yes**, via production | They only use the stateless giscus proxy, so they stay on the deployed Worker. Nothing is written there. |
| Cron drain | **no** | `wrangler dev` does not fire triggers. Use `POST /api/admin/notify/drain`, or `wrangler dev --test-scheduled` and hit `/__scheduled`. Ingest still sends its own first batch. |
| GitHub webhook | **no** | GitHub cannot reach localhost. `POST /api/admin/notify/ingest` runs the same ingest. |

### A full local round trip

```sh
# terminal 1 — the site
npm run server                    # from the repo root; http://localhost:4000

# terminal 2 — the worker
npm run db:init:local && npm run dev
```

In the browser at `http://localhost:4000`: sign in from the bell, follow, accept
the notification prompt. Then:

```sh
# ingest the changelog hexo is serving (no webhook needed)
curl -X POST -H "Authorization: Bearer <admin token>" \
     http://localhost:8787/api/admin/notify/ingest
```

Grab `<admin token>` from the console with `await blogAuth.getSessionToken()`.
Ingest sends its own first batch, so a small local audience needs no drain call;
add `POST /api/admin/notify/drain` if more was queued than that.

## Operating notes

- **Secrets never live in committed files.** `SESSION_SECRET`,
  `VAPID_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` are Wrangler secrets in
  production and `.dev.vars` entries locally. `wrangler.toml` and `.dev.vars` are
  gitignored; the `*.example` files are the templates.
- Rotating `SESSION_SECRET` simply invalidates existing sessions (2-hour TTL) —
  people sign in again. No data is affected.
- Rotating the **VAPID pair is not** so cheap: every existing push subscription
  becomes undeliverable and each follower has to enable push again. The inbox
  survives, so nothing is lost, but treat the pair as permanent once deployed.
- **Failure handling.** `404`/`410` from a push service deletes the device (the
  subscription is gone for good); `429`/`5xx`/network retries with exponential
  backoff (60s → 3h, five attempts); `413` retries once with no payload so the
  service worker can show a generic notification; anything else is our fault, not
  the device's, and stops immediately.
- **Privacy.** Per follower the Worker stores a GitHub id and login, the push
  endpoint and its two public keys, and which notifications they were sent.
  `PUT /api/me/preferences {"follow": false}` deletes all of it.
- **Cost.** An idle deployment is 288 cron invocations a day, each one indexed
  `SELECT` against an empty queue. Ingest is two D1 round trips regardless of
  audience size; a drain is two more regardless of batch size.
- **Batch sizes** live in `src/notify.js` as `DRAIN_BATCH` (12) and
  `INLINE_BATCH` (6), sized for the Workers **free** plan — 50 subrequests but
  only 10ms of CPU per invocation, and a single push costs an ECDH key pair, an
  ECDH agreement, three HKDF chains and an AES-GCM seal. On the paid plan
  (30s CPU) `DRAIN_BATCH` can go to ~45 before the subrequest ceiling matters.
