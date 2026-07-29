# Standalone desktop installer (no Docker)

A second way to run the POS on a café PC, alongside the Docker-based option in
[docs/windows-desktop-app.md](windows-desktop-app.md) and
[docs/server-sync.md](server-sync.md). This one needs **nothing pre-installed**
on the café PC at all — no Docker Desktop, no Docker login, no manual database
setup, no PowerShell. Download one installer, double-click it, done.

## Why this exists

The Docker-based install is solid, but every one of its steps assumes some
comfort with technical tools: installing Docker Desktop (a real piece of
infrastructure with its own updates and, for larger businesses, licensing),
running `docker login`/`docker compose` from PowerShell, and understanding
what a container even is. This installer removes all of that by bundling
everything the app needs into one `.exe`:

- **[Electron](https://www.electronjs.org/)** provides the app window and a
  bundled Node.js runtime — nothing else to install for that.
- **A real PostgreSQL 16** (via [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres),
  the *actual* Postgres binary, not a reimplementation) runs as a plain
  background process, not a container. This was verified before building
  anything: the project's full migration set and its whole integration test
  suite (246 tests, including row-level-security tenant isolation) pass
  unmodified against it.
- The app's own **`server.ts`** and **`scripts/migrate.ts`** run completely
  unmodified — same code that runs in Docker and on the VPS.

## Architecture

```
electron/main.js  (Electron main process)
  │
  ├─ generates + persists a Postgres password and JWT secret,
  │    once, into the OS's per-user app-data folder — nothing typed by anyone
  │
  ├─ starts a bundled PostgreSQL 16 (embedded-postgres) as a background
  │    process, data stored in that same app-data folder
  │
  ├─ runs scripts/migrate.ts (unmodified) against it
  │
  ├─ runs scripts/derive-runtime-database-url.ts (unmodified) — the same
  │    step Docker's entrypoint uses to provision the restricted `pos_app`
  │    role, since server.ts refuses to run against a superuser connection
  │    (Phase 12's tenant isolation is Postgres row-level security, which a
  │    superuser silently ignores)
  │
  ├─ starts server.ts (unmodified) as a child process, using Electron's own
  │    bundled Node runtime (no separate Node.js install needed either)
  │
  └─ opens a plain window pointed at http://127.0.0.1:3000
```

Every subsequent launch skips straight to "start Postgres, start the server,
open the window" — the secrets and the database already exist.

## Current status — read before relying on this

This is a first pass, validated as far as this development environment
allows:

- ✅ The core mechanism (embedded Postgres + real migrations + the real
  server booting and answering requests) was proven end-to-end, running as a
  normal non-root/non-admin user account.
- ⚠️ **Not yet tested as an actual packaged Windows installer on a real
  Windows machine.** Building and running the final `.exe` needs to happen
  on Windows (or via the CI workflow below) and be smoke-tested there before
  handing it to a café.
- ⚠️ **No self-update yet.** The GHCR-based self-update built for the Docker
  path (see `docs/server-sync.md` "Self-update") doesn't apply here — a new
  version currently means downloading and running a new installer. Electron
  has its own auto-update mechanism (`electron-updater`); wiring that up is
  a follow-up, not part of this pass.
- ⚠️ **Unsigned.** Without a code-signing certificate, Windows SmartScreen
  will warn that the publisher is unknown on first run. Getting a
  certificate is a separate, ongoing cost/process — until then, this is the
  expected (if unfriendly-looking) behavior, not a bug.

## Building the installer

### Option A — CI (recommended, no Windows machine needed)

`.github/workflows/desktop-build.yml` builds it on a `windows-latest`
GitHub Actions runner — so producing the installer never requires owning a
Windows PC. Trigger it either automatically (push a `v*` tag) or manually
from the Actions tab (`workflow_dispatch`), then download the
`cafe-pos-windows-installer` artifact.

### Option B — locally, on an actual Windows machine

```powershell
npm install
npm run build          # builds the Next.js app (.next/)
cd electron
npm install
npm run dist            # produces electron/dist/Cafe POS Setup <version>.exe
```

## Installing on a café PC

1. Get the `.exe` onto the café PC (from the CI artifact above, or however
   you distribute it).
2. Double-click it. If Windows SmartScreen warns about an unknown publisher
   (see "Unsigned" above), choose **More info → Run anyway**.
3. The installer creates a desktop icon and Start-menu entry (per-user
   install, no admin rights required) and finishes in seconds — it's just
   copying files, no Docker image to build or pull.
4. Launch **Cafe POS** from the desktop icon. The **first** launch takes a
   little longer (initializing the database); every launch after that is
   fast.
5. The app opens in its own window at `http://127.0.0.1:3000`, ready for the
   **[Setup Wizard](../README.md#first-run--the-setup-wizard-phase-1)**
   (business info, chart of accounts, roles, menu, etc.) exactly like any
   other fresh install.

Where things live (all per-user, no admin folder involved):

| What | Where |
|---|---|
| Database files | `%APPDATA%\cafe-pos-desktop\pgdata` |
| Generated secrets (Postgres password, JWT secret) | `%APPDATA%\cafe-pos-desktop\config.json` |

## Uninstalling

Use Windows' normal "Add or remove programs" — this removes the app itself.
The database and generated secrets are left in `%APPDATA%\cafe-pos-desktop`
so reinstalling doesn't lose data; delete that folder yourself if you
genuinely want a clean slate.

## Relationship to the Docker-based option

Both installers exist side by side — pick whichever fits:

- **This one** — the easiest possible install experience today; no
  self-update yet, not yet validated on a real Windows machine.
- **Docker-based** (`docs/windows-desktop-app.md`) — more moving parts to
  install once, but mature: proven self-update, bidirectional VPS sync
  already wired through the Owner dashboard.

Both run the exact same application code — nothing about the POS itself
differs between them.
