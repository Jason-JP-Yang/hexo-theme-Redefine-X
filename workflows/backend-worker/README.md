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
  a deployment succeeds ─┐                     ┌─ notifications      the content, deduped by id
  an admin posts a note ─┼─→ ingestEntries() ──┤
  an admin broadcasts ───┘        │            └─ followers.unread  the inbox, ONE row per reader
                                  │
                                  └─→ NOTIFY_QUEUE.sendBatch()   25 subscriptions per message
                                                 │
                    (a separate invocation)      └─→ consumeBatch()
                                                        └─→ sendWebPush() ×25 in parallel
                                                              → ack | drop the device | re-enqueue
```

Three properties are worth knowing because everything else follows from them:

**Idempotency lives in `notifications.id`.** An entry that already exists is a
no-op. That is what makes a webhook retry, a re-run over the same changelog, and
an edit to an already-announced post all cost nothing and send nothing.

**Fan-out is one UPDATE.** Ingest resolves the audience entirely inside SQLite,
so a broadcast to any number of followers is the same three round trips — and it
writes one un-indexed row per reader, because the inbox lives in
`followers.unread` as JSON rather than in a (notification × reader) table.

**Producing and sending happen in different invocations.** The request path does
no crypto and calls no push service; it hands the payload and the subscription
keys to a queue and returns. The consumer reads no D1 on the happy path, because
the message already carries everything it needs.

## Configuration

Eight values run this Worker and nothing reads a ninth.

| | Location | Use |
| --- | --- | --- |
| `ADMIN_LOGINS` | `wrangler.toml` | Comma-separated GitHub **numeric ids** (immutable — a login name can be released and re-registered by someone else). Decides the `isAdmin` claim. |
| `ALLOWED_ORIGIN` | **dashboard** | CORS allowlist. Deliberately not in `wrangler.toml` so it can be changed without a redeploy. |
| `SITE_URL` | `wrangler.toml` | The site this backend belongs to. The **one** place a URL comes from. |
| `VAPID_PUBLIC_KEY` | `wrangler.toml` | Shipped to every subscribing browser; not a secret. |
| `SESSION_SECRET` | secret | Signs session tokens. |
| `VAPID_PRIVATE_KEY` | secret | The 32-byte P-256 scalar. |
| `GITHUB_WEBHOOK_SECRET` | secret | Authenticates the deployment webhook — **and** is what identifies the deploy repo, since only the repository holding it can produce a valid signature. |
| `VAULT_MASTER` | secret | Unwraps the per-post keys in `vault_posts`. **Must be byte-identical to `VAULT_MASTER` in the site's `.env`** — the build wraps with it, the Worker unwraps with it. Rotating it makes every already-published encrypted post permanently unreadable. |

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

Five tables.

| Table | Holds | Grows with |
| --- | --- | --- |
| `notes` | Instant Notes. A separate feature that happens to share the Worker. | notes written |
| `followers` | One row per GitHub identity that has followed — **and that reader's inbox**: `topics` (comma-separated allowlist, empty means everything), `muted_until`, and the `unread` / `seen` JSON arrays. | readers |
| `push_devices` | Push subscriptions — `endpoint` (the natural key), `p256dh`, `auth`, plus `state` for admin moderation. Several devices may hang off one follower. | readers × devices |
| `notifications` | The notification itself, independent of who receives it. `id` is the dedupe key supplied by the source; `recipients` / `devices` are the fan-out's own counts. | notifications |
| `moderation` | Everything an admin decides ABOUT a reader: `state` (`''` \| `muted` \| `banned`) and `blocked` (topics excluded globally). Only moderated identities have a row. | moderated readers |

Two tables are gone: `deliveries` (one row per notification × follower) and
`outbox` (one per notification × device). D1 bills rows written and charges again
per index touched, so those two made a broadcast to 150 readers cost ~450 writes
before a single push left the building. The inbox now lives in two un-indexed
JSON columns on the reader's own row, and the push queue is Cloudflare Queues,
which costs D1 nothing. A `settings` table is gone for the same reason it was
never needed: the bootstrap guard is stateless — an ingest finding more than ten
*new* entries at once records them and delivers none.

`moderation` is deliberately separate from `followers` rather than a column on
it. Unfollowing deletes the follower row (it is the reader's own privacy switch,
and it has to be a real deletion), so a ban stored there could be shed with one
click.

**Creating vs migrating.** `schema.sql` REBUILDS — it drops and recreates the
notification tables — and is only right for an empty database:

```sh
wrangler d1 execute instant-notes-db --remote --file=./schema.sql
```

A database that already has followers and live push subscriptions is brought
forward with the numbered files in `migrations/` instead, each run once:

```sh
wrangler d1 execute instant-notes-db --remote --file=./migrations/0001-moderation.sql
```

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
  // "topic" | "all" | { "kind": "users", "users": [id|login] }
  //                  | { "kind": "except", "users": [id|login] }
  "audience": { "kind": "topic" }
}
```
→ `201 { "ok": true, "ingested": ["…"], "skipped": [], "recipients": 12,
        "devices": 17, "messages": 1, "counts": [ … ],
        "audience": { "matched": [{ "id": 1, "login": "…" }], "unknown": ["typo"] } }`

`400` if nothing was new — a missing `id`/`title`/`url`, or an id already sent.
An audience id that matches nobody is reported in `audience.unknown` and then
**ignored**; it is never a reason to refuse the send.

#### `GET /api/admin/notifications`
`?type=announcement|post|note` (omit for all) · `?cursor=<offset>`.

```jsonc
{ "items": [{ "id": "…", "type": "post", "topic": "posts", "title": "…",
              "body": "…", "url": "…", "image": "", "tag": "", "silent": 0,
              "audience_json": "{\"kind\":\"topic\"}", "source": "changelog",
              "published_at": "…", "recipients": 12, "devices": 17 }],
  "cursor": 20, "followers": 12, "devices": 17 }
```

`cursor` is `null` on the last page.

#### `PUT /api/admin/notifications/:id`
`{ title, body, url }` — corrects what the in-site inbox shows from here on.
Does **not** re-announce: the copy already in an OS tray cannot be recalled, and
a second buzz for a fixed typo is how a channel teaches people to mute it.
→ `{ "ok": true }`, `404` for an unknown id.

#### `DELETE /api/admin/notifications/:id`
Removes the row and strips the id from every inbox that held it.
→ `{ "ok": true, "inboxes": 12, "removed": 1 }`

A push already handed to the queue still lands: the consumer carries its own
payload and reads no D1, so chasing one would cost a database read on every push
forever to close a race measured in seconds.

#### `POST /api/admin/notifications/:id/resend`
The deliberate override of the dedupe rule. Re-queues every device belonging to
someone already in that notification's inbox — the audience is fixed at ingest,
so a resend cannot widen it. → `{ "ok": true, "queued": 17 }`, `404` for an
unknown id.

### Vault

The Worker holds no encrypted post, no image and no metadata — only a wrapped
key per post and, on each reader's `moderation` row, the ids that reader may
open. Everything else is an opaque blob on the CDN, fetched and decrypted by the
browser.

#### `POST /api/vault/keys`
Any valid session. Body is ignored.

```jsonc
{ "posts": [{ "id": "9f2c…", "slug": "k7m2x9qp4a", "key": "<base64url 32B>" }],
  "admin": false }
```

**One row** for a reader with no grants (a primary-key probe on `moderation`
that short-circuits), **1 + N** for a reader with them, and the whole registry
for an admin. `Cache-Control: no-store` — the body is key material.

CPU: one HMAC session verify plus one AES-GCM unwrap per post, well under a
millisecond for any realistic N.

#### `GET /api/admin/vault`
`?offset=<n>` → `{ "posts": [{ "id", "slug", "created_at", "audience": [{id, login}] }],
"more": bool }`, 20 per page.

#### `POST /api/admin/vault`
`{ "id", "slug", "wrapped" }` — one line of the block the build prints. Upserts,
so re-pasting the same line is an update rather than a duplicate.

#### `DELETE /api/admin/vault/:id`
Revokes a post outright. Stale ids left behind in `moderation.vault` match no
row on the next read; rewriting every grant row here would be a write per reader
in the scarce direction to save nothing.

#### `PUT /api/admin/vault/:id/audience`
`{ "audience": [{ "id": 108601445 }] }` — the **complete** new list. The diff is
computed server-side, so only the identities that actually changed are written.

#### `POST /api/admin/lookup`
`{ "ids": ["Jason-JP-Yang", 108601445] }` — names the identities typed into an
audience or blocklist field.
→ `{ "matched": [{ "id": 108601445, "login": "…", "name": "…", "follower": 1 }],
      "unknown": ["typo"] }`

Resolved against **this blog's own** followers and moderation rows, never
against GitHub. An account the blog has never seen cannot receive a notification
either way, so "unknown here" is the answer that matters — and it costs no
subrequest and no rate limit.

#### `GET /api/admin/followers`
`?cursor=<offset>`. The first page carries everything the management screen
paints once; later pages carry only more followers.

```jsonc
{ "items": [{ "id": 1, "login": "…", "name": "…", "created_at": 1756339200,
              "unread": 3, "state": "", "blocked": "", "is_admin": false,
              "devices": [{ "id": 7, "ua": "…", "device": "laptop",
                            "state": "", "created_at": 1756339200, "tail": "…" }] }],
  "cursor": 20,
  "orphans": [ … ],                        // first page only — devices whose owner left
  "blocklists": { "posts": [], "notes": [], "announcements": [] },
  "totals": { "followers": 12, "devices": 17 } }
```

#### `PUT /api/admin/moderation`
`{ github_id, state }` moderates an identity; `{ device_id, state }` a single
subscription. `state` is `""`, `"muted"` or `"banned"` — three mutually
exclusive positions, because a banned reader is already muted and the pair would
only be a second way to say so.

Both stop delivery. Only `banned` is visible to the reader: their panel is
locked to one page behind a veil, every write route refuses them, and the
subscription cannot be deleted and re-created to escape it. `muted` changes
nothing they can see.

`403` if the target is an admin — enforced inside the statement, so it is a
property of the SQL rather than a check that can be forgotten.

#### `PUT /api/admin/blocklists`
`{ topic, users: [id|login] }` where topic is `posts`, `notes` or
`announcements`. Send the **whole** intended list, not a diff.
→ `{ "ok": true, "topic": "…", "users": [ … ], "unknown": [ … ] }`

Anyone on a topic's list is skipped for that kind of notification, silently and
everywhere, whatever audience an announcement names.

#### `POST /api/admin/notify/ingest`
The same ingest the webhook performs, triggered by hand — which is how the
pipeline is exercised locally, where GitHub has no route to the Worker. Reads
`{ "url": "…" }`, else `SITE_URL/changelog.json`.
→ `{ "ok": true, "url": "…", "ingested": [], "skipped": [], "deliveries": 0, "queued": 0 }`

`"absorbed": true` in the response means more than ten entries were new at once:
they were recorded (and are deduped from now on) but deliberately not delivered.

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

### Retention (cron, 03:40 UTC daily)

One round trip, four statements, in this order because each depends on what the
previous left behind:

1. **Expire inbox entries** — unread after 30 days, read after 14. Guarded by a
   `WHERE EXISTS`, so only rows that actually lost an entry are written.
2. **Delete aged notifications** — older than 60 days, **except announcements**.
   An announcement is the admin's own record and goes only when they delete it,
   so the management list is what the database actually still holds.
3. **Delete unreferenced posts and notes** — once step 1 has taken the last
   inbox entry pointing at one, the row can never be rendered again.
4. **Delete orphan devices** — subscriptions whose owner unfollowed, **except
   banned ones**. Those stay: it is why unfollow leaves them behind, and a sweep
   that removed them would hand back the one-click escape the ban closes.

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
| Queue consumer | **yes** | `wrangler dev` runs the consumer locally against the same process, so a local ingest really does send. |
| Cron sweep | **no** | `wrangler dev` does not fire triggers. Use `wrangler dev --test-scheduled` and hit `/__scheduled`. It is retention only — nothing is sent from it. |
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
Ingest enqueues; `wrangler dev` runs the consumer in the same process, so the
push arrives on its own. Watch the `[notify] push` line in terminal 2.

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
  subscription is gone for good); `429`/`5xx`/network re-enqueues **only the
  endpoints that failed**, once, 60 s later — letting the platform retry the
  whole message instead would re-send to the two dozen devices that already
  succeeded; anything else (`400`, `401`, `403`, `413`) is our fault, not the
  device's, and stops immediately with a `[notify] push` line in the logs.
- **Privacy.** Per follower the Worker stores a GitHub id, login and display
  name, the push endpoint and its two public keys, and the ids of the
  notifications in their inbox. `PUT /api/me/preferences {"follow": false}`
  deletes all of it — except a subscription an admin has banned, which is the
  one thing leaving cannot clear.
- **Cost.** An idle deployment is **one** cron invocation a day. Ingest is three
  D1 round trips regardless of audience size, plus one `sendBatch` per 500
  devices; the consumer costs no D1 at all unless a device has died.
- **Batch sizes** live in `src/notify.js` as `PUSH_PER_MESSAGE` (25) and in
  `wrangler.toml` as `max_batch_size` (1). Both are bounded by the **free**
  plan's 50 subrequests per invocation — which counts D1 and Queues calls, not
  just `fetch()` — rather than by CPU, which measures ~7.2 ms against a tolerant
  10 ms (`dev/queue-cpu-probe`, 482/482 invocations at n=25).
