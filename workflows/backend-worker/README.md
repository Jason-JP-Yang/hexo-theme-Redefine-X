# Redefine-X Backend Worker

A small, **headless** Cloudflare Worker (Hono + D1) that backs the optional
dynamic features of the Redefine-X theme. It serves only JSON / proxy responses —
there is no admin UI or any other front-end in this worker.

## What it does

| Concern | Endpoints | Notes |
| --- | --- | --- |
| **Instant Notes** | `GET /api/notes` (public) · `GET/POST/PUT/DELETE /api/admin/notes[/:id]` (admin) | Banner "Instagram Notes"-style messages, stored in D1. Public read returns the last 5 notes from the past 48h. |
| **Auth** | `POST /api/auth/login` | Verifies a GitHub user token, checks the admin allowlist, and (for admins) mints a short-lived HMAC session token. |
| **Giscus CORS proxy** | `GET /api/discussions` · `GET /api/discussions/categories` · `POST /api/oauth/token` | Forwards giscus.app's API with the blog's CORS headers (giscus.app only allows CORS from its own origin). Powers comments + masonry photo likes. |
| Health | `GET /` | `{ ok: true }` liveness probe. |

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

Admin writes (`/api/admin/*`) are authorized **only** by that HMAC session
token (`Authorization: Bearer <token>`), verified locally with no per-request
GitHub round-trip. Non-admins simply get `{ isAdmin: false }`; comments and
likes keep working for everyone.

## File map

| File | Role |
| --- | --- |
| `src/index.js` | Hono router — all routes above, CORS, and the giscus proxy. |
| `src/auth.js`  | Web Crypto helpers: GitHub token verification, admin-allowlist check, HMAC session sign/verify. |
| `schema.sql`   | D1 schema — the single `notes` table + index. |
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

In your site's theme config (`_config.redefine-x.yml`), point both consumers at
the worker's URL (the same worker serves all three concerns, so one domain is
enough):

```yaml
home_banner:
  instant_notes:
    enable: true
    api_url: https://<your-worker-domain>      # notes + auth

comment:
  config:
    giscus:
      proxy: https://<your-worker-domain>/     # comments + masonry likes
```

Then regenerate the site (`hexo generate`) so the new URL is baked into the
exported `window.config`.

## Local development

```sh
npm run dev            # wrangler dev (uses .dev.vars)
npm run db:init:local  # seed the local D1 database
```

## Notes

- **Secrets never live in committed files.** `SESSION_SECRET` is a Wrangler
  secret in production and a `.dev.vars` entry locally. `wrangler.toml` and
  `.dev.vars` are gitignored; the `*.example` files are the templates.
- Rotating `SESSION_SECRET` simply invalidates existing admin sessions (2-hour
  TTL) — admins just sign in again. No data is affected.
