# Bidirectional Server-to-Server Sync (Phase 11)

This document explains how to set up the café laptop as an on-site server that
syncs bidirectionally with the VPS (`pos.eshobe.com`), so the café keeps
working during internet outages and catches up automatically on reconnect.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  Café LAN                            │
                    │                                      │
  Waiter phones ────┤                                      │
  Kitchen display ──┤──► Laptop (on-site server)          │
  Cashier ──────────┤     Next.js + Postgres               │
                    │     http://192.168.1.50:3000         │
                    │          │                           │
                    └──────────┼───────────────────────────┘
                               │ (when internet is up)
                               ▼
                         VPS (pos.eshobe.com)
                         sync / backup / remote access
```

- **Laptop = live brain.** All café devices connect to it by LAN IP. No
  internet needed for day-to-day operation.
- **VPS = cloud layer.** Receives pushes from the laptop; owner can view
  reports and make config changes remotely.
- **Internet drops:** café keeps running 100% on the LAN. Nothing is lost.
- **Internet returns:** laptop syncs accumulated changes to the VPS within
  30 seconds (one sync tick).

## How sync works

The sync engine reuses the same idempotency infrastructure as the client
offline queue (Phase 5):

1. Every order mutation on the laptop is recorded in `sync_events` with
   `origin = 'local'`.
2. Every 30 seconds the laptop's background tick (`server-sync-service.ts`):
   - **Push:** fetches unsynced `sync_events` rows (origin=local, applied,
     no error) and POSTs them to `POST /api/server-sync/push` on the VPS.
   - **Pull:** calls `GET /api/server-sync/pull?after=<last_id>` on the VPS
     and replays any events the VPS accepted from other sources (e.g. owner
     made a menu change remotely) through the local `applySyncEvent()` engine.
3. The VPS marks pulled events as `origin = 'remote'` so they are never
   bounced back to the laptop on the next push.
4. Conflict resolution is identical to the client queue:
   - Duplicate `client_event_id` → silently ignored (idempotent).
   - Legal status transition → applied.
   - Illegal transition (two devices raced) → flagged as conflict, not
     silently overwritten.

## Setup

### Step 1 — Generate a shared token

```bash
openssl rand -hex 32
# e.g. a3f8c2d1e4b5...
```

This token is the shared secret between the laptop and the VPS. Keep it safe.

### Step 2 — Configure the VPS

Add `REMOTE_SYNC_TOKEN=<your-token>` to the VPS environment (Komodo Stack
Environment, or `.env`). This guards the VPS's `/api/server-sync/push` and
`/api/server-sync/pull` endpoints.

Redeploy the VPS stack so the new env var takes effect.

### Step 3 — Set up the café laptop

1. Install Docker on the laptop.
2. Give the laptop a **fixed LAN IP** (set a DHCP reservation in the router,
   or configure a static IP in the OS).
3. Get `docker-compose.local.yml`, `.env.local.example`, and the `windows/`
   folder onto the laptop (a full clone works, but only these are needed —
   the stack runs a prebuilt image, not a local build) and copy the env file:
   ```bash
   cp .env.local.example .env
   ```
4. Edit `.env` and fill in:
   - `POSTGRES_PASSWORD` — a strong password
   - `JWT_SECRET` — `openssl rand -hex 32`
   - `REMOTE_SYNC_TOKEN` — the same token from Step 1
5. One-time login and pull (the image is private — see "Self-update" below
   for why, and for why this is the only time this is needed):
   ```bash
   docker login ghcr.io -u <your-username> -p <a-token-that-can-read-this-package>
   docker compose -f docker-compose.local.yml pull
   docker compose -f docker-compose.local.yml up -d
   ```
6. On first boot the entrypoint runs all migrations automatically.

### Step 4 — Configure sync in the Owner dashboard

1. Open `http://<laptop-lan-ip>:3000` and log in as Owner.
2. Go to **Settings → همگام‌سازی با سرور راه دور** (or call `PUT /api/server-sync/config`).
3. Set:
   - **Remote URL:** `https://pos.eshobe.com`
   - **Token:** the same token from Step 1
   - **Enabled:** true
4. Save. The first sync tick runs within 20 seconds of server start.

### Step 5 — Point café devices at the laptop

All café devices (waiter phones, kitchen display, cashier) should open
`http://<laptop-lan-ip>:3000` instead of `https://pos.eshobe.com`. The VPS
URL still works for remote access (owner from home, etc.).

## Local TLS (recommended for production)

Plain `http://` works for a quick trial, but for production you should use
HTTPS so the session cookie's `Secure` flag works correctly and the WebSocket
uses `wss://`. Options:

### Option A — Caddy reverse proxy (easiest)

Install Caddy on the laptop and add a `Caddyfile`:

```
:443 {
  tls internal
  reverse_proxy localhost:3000
}
```

`tls internal` generates a self-signed cert. Trust it on each device:
- Android: Settings → Security → Install certificate
- iOS: Settings → General → VPN & Device Management
- Windows: certmgr.msc → Trusted Root Certification Authorities

### Option B — Local hostname + mDNS

Give the laptop a hostname (e.g. `pos-local`) and configure mDNS so devices
resolve it. Then use a self-signed cert for that hostname.

### Option C — Split DNS

If you control the router's DNS, add an entry so `pos.eshobe.com` resolves to
the laptop's LAN IP inside the café. Then the same Let's Encrypt cert the VPS
uses is valid for the laptop too — no self-signed cert needed.

## Self-update

The café laptop keeps itself up to date using the *same* authenticated
pairing as ordinary sync — no separate credential ever lives on the laptop,
and no manual login is ever needed after the very first install.

### Why this exists

`docker-compose.local.yml` runs a **prebuilt image from GHCR**, not a local
build — a café laptop shouldn't need the source tree or a build toolchain,
just Docker. That image is **private** (this is a closed-source product, not
something to publish for anyone to download), which means pulling it needs a
credential. The options for where that credential lives, and why this one was
chosen over the alternatives:

- **Baked into the installer/laptop as a static secret** — rejected. A
  credential distributed to every café is not actually private: anyone who
  receives the installer can extract and reuse it, and a leak means rotating
  it across every laptop that ever ran it.
- **A shared, long-lived token every laptop uses to pull directly** — same
  problem, just centralized: one leak compromises every deployment at once,
  with no way to tell which laptop leaked it.
- **What's implemented instead**: the only long-lived secret (a GitHub App
  private key) stays on the VPS, which you administer and never hand to a
  café. Each laptop already has its own per-business sync token (set up once,
  by the Owner, in the dashboard). That token is reused to ask the VPS for a
  **short-lived (~1h), read-only-scoped pull credential**, minted fresh on
  every request and never stored anywhere. A leaked one expires within the
  hour on its own; it was never durable enough to be worth stealing.

### Architecture

```
Laptop (café)                              VPS (pos.eshobe.com)
─────────────                              ────────────────────
GET /api/server-sync/update-check  ──────► reports its own running version
  (per-business sync token)                (no GitHub API call — cheap,
                                             polled every 30s for dashboard
                                             visibility only)

GET /api/server-sync/update-token  ──────► mints a fresh ~1h GHCR pull token
  (same token, only called right           via a GitHub App installation
   before an actual pull)                  token, scoped to read-only
                                             packages (src/lib/github-app-
                                             token.ts) — never cached
```

- `src/lib/app-update.ts` — both sides of this: `buildUpdateCheckResponse` /
  `buildUpdateTokenResponse` (remote), `refreshAppUpdateStatus` /
  `fetchUpdatePullCredential` (local).
- `scripts/check-app-update.ts` — run inside the container via
  `docker compose exec` by the Windows launcher, right before deciding
  whether to pull. Never runs over the network — `docker exec` only needs
  Docker control on the box already running it, so there's no new endpoint
  exposed on the café LAN (which `docker-compose.local.yml` otherwise
  publishes to every device in the building).
- `windows/Start-CafePOS.bat` — after the current container answers ready,
  runs the check, and if an update is available, `docker login` with the
  short-lived token (piped via stdin, never written to disk), pulls, and
  restarts before opening the app window. Any failure here is non-fatal —
  the laptop just keeps running its current version.

### One-time setup on the VPS (a human does this once, in GitHub's UI)

There is no API for registering a GitHub App, so this step can't be
automated:

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Repository permissions → **Packages: Read-only**. No other permissions.
3. Install the app on this repository only.
4. Generate a private key (downloads a `.pem`) and note the **App ID** and
   the **installation ID** (visible in the installed-app's URL).
5. Set on the VPS (Komodo Stack Environment, or `.env`), never on any laptop:
   - `GHCR_APP_ID`
   - `GHCR_APP_INSTALLATION_ID`
   - `GHCR_APP_PRIVATE_KEY` — the `.pem` contents (literal `\n` line breaks
     are fine; they're normalized back to real newlines)

If these aren't set, `update-check` still works (laptops see their current
version, no error), but `update-token` returns `not_configured` — self-update
is simply unavailable until this is done, it doesn't break anything else.

### First-time bootstrap (still manual — this is the one unavoidable step)

Self-update needs an already-running container to check *from* (the CLI
script above runs via `docker exec`, which needs a container to exec into).
So the very first install on a new laptop still needs one manual,
authenticated pull:

```powershell
docker login ghcr.io -u <your-username> -p <a-token-that-can-read-this-package>
docker compose -f docker-compose.local.yml pull
docker compose -f docker-compose.local.yml up -d
```

After that, every subsequent update is fully automatic on boot — no login,
no token, no manual step, ever again.

## Monitoring sync status

The Owner dashboard's **Settings → همگام‌سازی با سرور راه دور** page shows:
- Last push/pull attempt and success timestamps
- Last error (if any)
- Recent dead letters — pulled events that failed to apply (see
  `server_sync_dead_letters`); the pull still advances past them so they
  don't block later events, so this list is the only place they're visible
- A notice if incoming requests are still authenticating via the shared
  `REMOTE_SYNC_TOKEN` fallback instead of this business's own per-business
  token, with the last time it happened — otherwise a deployment could stay
  on the weaker shared-secret path indefinitely with nothing to notice

You can also query the API directly:
```bash
curl -H "Cookie: pos_session=<token>" http://<laptop-ip>:3000/api/server-sync/config
```

The `server_sync_log` table records every push/pull attempt for debugging.

## What syncs and what doesn't

| Data | Syncs? | Notes |
|---|---|---|
| Orders (create, add items) | ✅ | Via sync_events push/pull |
| Order item status (kitchen bumps) | ✅ | Via sync_events push/pull |
| Menu items / categories | ❌ | Not yet — make changes on one server |
| Tables / floor plan | ❌ | Not yet — make changes on one server |
| Users / staff | ❌ | Not yet — manage on one server |
| Reports / rollup | ✅ | Via existing Phase 9 rollup push |
| Backups | ✅ | Via existing Phase 10 backup/cloud |

Menu and config changes are not yet synced bidirectionally. The recommended
workflow is: make menu/config changes on the VPS (accessible from anywhere),
then manually export/import if needed on the laptop. A future phase can extend
the sync engine to cover these.

## Troubleshooting

**Sync shows "unreachable" error:**
- Check that the VPS is reachable from the laptop: `curl https://pos.eshobe.com/api/server-sync/pull?after=0`
- Verify `REMOTE_SYNC_TOKEN` matches on both sides.
- Check the VPS logs for 401 errors.

**Events not appearing on VPS after reconnect:**
- Check `server_sync_log` on the laptop for push errors.
- Verify the laptop's sync config has `enabled: true` and the correct `remoteUrl`.

**Duplicate orders after reconnect:**
- This should not happen — the `UNIQUE(location_id, client_event_id)` constraint
  prevents it. If you see duplicates, check that `client_event_id` values are
  truly unique UUIDs (they are generated by `crypto.randomUUID()` on the client).
