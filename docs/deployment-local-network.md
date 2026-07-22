# Deploying on a local network (Komodo + Traefik)

How to run the POS on an always-on server managed by [Komodo](https://komo.do),
published over HTTPS through Traefik, so the cashier, waiter/garson phones, and
kitchen display all connect to it from the cafe's WiFi.

## The shape of the deployment

One always-on **server** runs the "brain": the Next.js app (which also serves
the `/ws` live-sync WebSocket) plus its PostgreSQL database. Everything else is
just a **browser** pointed at your HTTPS subdomain:

```
                       ┌─────────────────────────────────────────┐
                       │  Server (Docker + Komodo)                │
   cafe WiFi / LAN     │                                          │
                       │   Traefik ──TLS──►  app (Next.js + /ws)   │
  ┌───────────┐        │                         │                │
  │ Cashier   │──HTTPS─┼────────────────────────►│                │
  │ (till PC) │        │                     Postgres 16          │
  └───────────┘        │                                          │
  ┌───────────┐        └─────────────────────────────────────────┘
  │ Waiter    │──HTTPS──►  https://pos.example.com/dashboard/waiter
  │ phones    │
  └───────────┘
  ┌───────────┐
  │ Kitchen   │──HTTPS──►  https://pos.example.com/dashboard/kitchen
  │ display   │
  └───────────┘
```

- The app container is **not** published to the host. The only way in is the
  HTTPS subdomain Traefik serves — Traefik terminates TLS and forwards to the
  app on its internal port 3000.
- Live sync needs nothing special: the browser connects to
  `wss://<your-domain>/ws` automatically when the page is HTTPS
  (`src/app/dashboard/use-realtime.ts`), and Traefik forwards the WebSocket
  upgrade transparently.
- Because the browser talks HTTPS, the `Secure` session cookie works correctly.
  (Serving the app over plain `http://` — no TLS — would break login, since a
  production `Secure` cookie is only sent over HTTPS. Traefik solves that.)

## What's in the repo for this

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build; runtime runs the custom server (`npm start` → `tsx server.ts`), the same as local. |
| `docker-entrypoint.sh` | Waits for Postgres, applies migrations, then starts the server. Runs on every deploy. |
| `docker-compose.komodo.yml` | The stack: `app` + `db`, wired to Traefik via labels. |
| `.env.komodo.example` | The variables the stack needs. |
| `.dockerignore` | Keeps secrets and local state out of the image. |

## Steps

### 1. DNS + Traefik cert

Point your subdomain (e.g. `pos.example.com`) at the server, and make sure your
Traefik certresolver can issue a cert for it (a public DNS name with Let's
Encrypt, or your own resolver). Note the **name of Traefik's Docker network**
and the **certresolver name** from your Traefik static config — you'll need both.

### 2. Create the Stack in Komodo

Point a Komodo **Stack** at this repo and set the compose file to
`docker-compose.komodo.yml`. In the Stack's **Environment**, paste the values
from `.env.komodo.example` and fill them in. At minimum:

- `POS_DOMAIN` — your subdomain
- `JWT_SECRET` — `openssl rand -hex 32`
- `POSTGRES_PASSWORD` — a strong password
- `TRAEFIK_NETWORK` — the name of Traefik's existing external network
- `TRAEFIK_CERTRESOLVER` — your certresolver name (e.g. `letsencrypt`)

### 3. Deploy

Komodo builds the image and starts the stack. On first boot the entrypoint
creates the schema (runs all migrations) and starts the server. Watch the `app`
logs for `Postgres is ready` → `Applying database migrations` →
`Ready on http://localhost:3000`.

### 4. First run

Open `https://pos.example.com`. On an empty database it routes to `/welcome` to
create the business + first Owner, then the 8-step setup wizard (see the README).
To skip the wizard with demo data instead, run a one-off `npm run db:seed`
inside the app container (Komodo terminal / exec).

### 5. Connect the phones and displays

- **Waiter / garson:** open `https://pos.example.com/login` in the phone
  browser → **PIN tab** → 4-digit PIN → they land on their waiter board (only
  the floor sections assigned to them). "Add to Home Screen" makes it feel like
  a native app.
- **Kitchen display:** open `https://pos.example.com/dashboard/kitchen` on the
  KDS screen and log in with the kitchen PIN.
- **Cashier / till:** open `https://pos.example.com/dashboard/pos`.

All screens refetch on the relevant WebSocket event, so a new order appears on
the KDS and the waiter board instantly — no refresh, no polling.

## The receipt printer / cash drawer

The **print agent is separate from this container on purpose.** It runs on the
machine physically attached to the receipt printer / cash drawer (the till PC),
and the dashboard's browser talks to it directly on `127.0.0.1:9123` — it does
**not** go through the server or Traefik. It also needs a real Chromium to shape
Persian/RTL receipts correctly, which is why it isn't baked into the server
image.

On the till PC:

```bash
# On the machine with the printer plugged in:
npm install
PRINT_AGENT_CHROMIUM_PATH=/path/to/chromium npm run print-agent
```

Set `NEXT_PUBLIC_PRINT_AGENT_URL` only if you change the agent's port from the
`http://127.0.0.1:9123` default. See the print-agent notes in `.env.example`.

## Backups

Scheduled backups (Phase 10) write to `/app/backups` inside the app container,
which the stack keeps on the `pos-backups` volume. For off-machine safety,
configure the Owner dashboard's cloud (S3) target and/or mount a
`BACKUP_SECONDARY_DIR` (USB/NAS). Restore runbook: `docs/backup-restore.md`.

## Operating notes

- **Everything depends on the router.** Phones reach the server over the cafe
  WiFi; if the router or server is down, the clients can't sync. Keep the server
  and router on a UPS if you can.
- **Updating:** push to your branch, then redeploy the Stack in Komodo — the
  image rebuilds and the entrypoint re-runs migrations (already-applied ones are
  skipped).
- **Migrations are forward-only.** A deploy never rewrites history; it only
  applies new `migrations/NNNN_*.sql` files.
