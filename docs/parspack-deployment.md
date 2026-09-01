# Deploying to ParsPack

ParsPack's "ساخت اپلیکیشن" (build application) console is a managed PaaS: it terminates
TLS, routes by hostname itself, and hands your container an internal name (the browser's
real host only survives in `X-Forwarded-Host`). That is exactly the case
[`TRUST_FORWARDED_HOST`](../.env.example) exists for — see the "Multi-business tenancy"
section of [README.md](../README.md). This doc is the walkthrough for that platform
specifically; the other `docker-compose.*.yml` files in the repo root (`komodo`, `srv1`,
`local`) target a self-managed Traefik/DirectAdmin box instead and don't apply here.

## Which app type

Under the **Docker** category, pick **Docker Compose**, not a bare Docker Container: the
app needs its own PostgreSQL 16 alongside it, and Compose lets ParsPack stand both up from
one file. Point it at this repo with `docker-compose.parspack.yml` (added alongside this
doc) as the compose file — it builds the app from the root `Dockerfile` and runs a
`postgres:16-alpine` service next to it on a private network. Don't use ParsPack's
"دیتابیس‌ها" managed-Postgres product for this unless you'd rather manage the connection
string yourself; either works, since all the app needs is a `DATABASE_URL` it can reach —
see "If you'd rather use a managed database" below.

Fill in the ParsPack form:
- **نام اپلیکیشن**: whatever name you like.
- **Node Port**: leave this off/default. It's for exposing a raw TCP port outside HTTP
  routing (databases, custom protocols); this is an ordinary HTTP app that ParsPack's edge
  should proxy to on its normal web port. If ParsPack's own docs say otherwise for Compose
  apps specifically, follow those — this one detail is ParsPack-panel behavior I can't
  verify from inside the repo.
- **دسترسی عمومی به اپلیکیشن (Public access)**: **on** — this is the app your staff and
  customers reach.

## Environment variables (پارامترها و متغیرها)

Add these under "افزودن پارامترها/متغیرها". Required first, then the ones you only need
for specific features.

| Variable | Value | Why |
|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` | Password for the bundled `db` service. |
| `JWT_SECRET` | `openssl rand -hex 32` | Signs session cookies. Never reuse the placeholder in `.env.example`. |
| `TRUST_FORWARDED_HOST` | `on` | **The one setting most likely to be missed.** Without it, every request arrives with ParsPack's internal container hostname in the `Host` header and the app fails closed (see `.env.example`'s note on this var, and `GET /api/host/resolve?debug=1` once deployed if anything 502s). |

That's the minimum for a single business reachable at one domain — leave `ROOT_DOMAIN`
unset and the app serves `/dashboard` unscoped on whatever domain you point at it. Only add
the rest if they apply to you:

| Variable | Value | When you need it |
|---|---|---|
| `WEBAUTHN_ORIGIN` | `https://your-domain` | Only if staff use fingerprint/biometric login (Owner/Manager WebAuthn). Must match the exact origin in the browser's address bar. |
| `SESSION_HOURS` | e.g. `12` | Only to change the default Owner/Manager session length. |
| `ROOT_DOMAIN` / `SUBDOMAIN_ROUTING` | see below | Only if you're hosting **more than one** business off this deployment. |

Don't set `DATABASE_URL` yourself — the compose file below wires it to the bundled `db`
service from `POSTGRES_PASSWORD`. `docker-entrypoint.sh` runs migrations and provisions the
restricted `pos_app` role automatically on every deploy (see the README's tenancy section);
there's no separate migration step to run on ParsPack.

## Single business vs. hosting several (subdomains)

Most café/restaurant deployments are **one business, one domain** — the default above.
Point your domain at the app in ParsPack, and you're done; nothing about `ROOT_DOMAIN` or
wildcard certificates applies.

Only set `ROOT_DOMAIN` (and `SUBDOMAIN_ROUTING=on`) if you intend to run this deployment as
a platform serving **multiple businesses**, each at its own subdomain
(`{business}.yourdomain.com`, super-admin console at `admin.yourdomain.com`). That needs:
- A **wildcard** DNS record and a **wildcard** TLS certificate for `*.yourdomain.com` —
  confirm ParsPack's custom-domain feature can issue/attach a wildcard cert before
  committing to this path; a single-host cert won't cover it.
- `WEBAUTHN_RP_ID` left unset (it defaults to `ROOT_DOMAIN`, which is what per-business
  origins require).

If the wildcard cert isn't ready yet, `SUBDOMAIN_ROUTING=off` keeps the deployment on one
origin without disabling the rest of the app.

## Backups

The app's scheduled backup feature (`BACKUP_DIR`, Phase 10) writes into the `app`
container's filesystem. `docker-compose.parspack.yml` mounts a named volume for it, but
**confirm ParsPack's Compose apps persist named volumes across redeploys** — if a redeploy
gives you a fresh disk, in-container backups disappear with it. Until confirmed, treat
`pg_dump`-based off-box backups (or ParsPack's own database backup product, if you switch to
their managed Postgres) as the durable copy, not this volume.

## If you'd rather use a managed database

You can skip the bundled `db` service and point `DATABASE_URL` at a Postgres instance from
ParsPack's own "دیتابیس‌ها" catalogue (choose version 16) instead — delete the `db` service
from the compose file, drop the `depends_on`, and set `DATABASE_URL` to that instance's
connection string as an app parameter. The entrypoint's automatic `pos_app` role
provisioning (see above) needs the connecting user to be able to `CREATE ROLE`; if
ParsPack's managed Postgres doesn't grant that, run `npm run db:app-role` yourself against
it once and set `DATABASE_URL`/`RUNTIME_DATABASE_URL` to the restricted role instead.
