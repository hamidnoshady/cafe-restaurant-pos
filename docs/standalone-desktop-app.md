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
- ✅ **Smoke-tested as an installed app.** The packaged `.exe` builds on a
  real Windows machine (Windows 11, a normal non-elevated account — see the
  `winCodeSign` workaround below), and a headless replay of the first-run
  sequence against the *packaged* resources completes the whole chain:
  `initdb` → Postgres up → all 42 migrations → `derive-runtime-database-url.ts`
  (provisioning `pos_app`) → `server.ts` booting → an HTTP response from the
  app. The project's full 246-test integration suite also passes against the
  bundled Postgres binaries.
- ⚠️ **No self-update yet.** The GHCR-based self-update built for the Docker
  path (see `docs/server-sync.md` "Self-update") doesn't apply here — a new
  version currently means downloading and running a new installer. Electron
  has its own auto-update mechanism (`electron-updater`); wiring that up is
  a follow-up, not part of this pass.
- ⚠️ **Unsigned.** Without a code-signing certificate, Windows SmartScreen
  will warn that the publisher is unknown on first run. Getting a
  certificate is a separate, ongoing cost/process — until then, this is the
  expected (if unfriendly-looking) behavior, not a bug.

## Two packaging constraints that will re-break this if changed

Both of these were live bugs that made the installed app fail on launch, and
both look like harmless cleanups from the outside. They're recorded here
because neither is obvious from reading the config.

**1. `embedded-postgres` must be imported from outside `app.asar`.** It
locates its bundled Postgres binaries relative to its own `import.meta.url`,
and those are `.exe` files Windows has to execute directly. `asarUnpack` puts
them on real disk, but plain module resolution still finds the copy *inside*
the archive, which yields an unspawnable path. `electron/main.js` therefore
imports it explicitly from `app.asar.unpacked/` when packaged. Note that
Electron patches `fs` to read into asar archives transparently, so
`fs.existsSync()` returns `true` for a path that `child_process.spawn()` can
never launch — existence checks will *not* catch a regression here; only
actually spawning the binary will.

**2. The `extraResources` node_modules filter must not use `**/` patterns.**
Exclusion patterns are relative to `../node_modules`, so a bare
`!vitest{,/**}` already scopes to the top-level package. Writing
`!**/typescript{,/**}` instead also strips `next/dist/lib/typescript`, which
Next.js requires at runtime to transpile `next.config.ts` — `server.ts` then
dies with `MODULE_NOT_FOUND`. The root `typescript` package has to ship for
the same reason: if Next can't resolve it at boot it tries to *npm-install*
it, which on a café PC means hanging or crashing.

**3. The cluster must be created with `--encoding=UTF8`.**
`embedded-postgres` passes no encoding to `initdb`, so a fresh cluster
inherits it from the machine's system locale — WIN1256 on a Persian Windows
install, which makes every migration containing a non-ASCII character fail to
apply. `main.js` passes `initdbFlags: ["--encoding=UTF8"]` to match what
`docker-compose`'s `postgres:16` gives us everywhere else. It deliberately
does *not* also pass `--locale=C`: that would make collation identical across
machines, but sorts Persian by raw codepoint rather than alphabetically
(`قهوه` before `چای`), which is wrong for a Persian-first POS.

This flag only affects cluster *creation*. `isDataDirInitialised()` gates on
`pgdata/PG_VERSION`, so an install that already created a WIN1256 cluster
won't be repaired by upgrading — that `pgdata` directory has to be deleted so
the next launch re-initialises it.

## Building the installer

### Option A — CI (recommended, no Windows machine needed)

`.github/workflows/desktop-build.yml` builds it on a `windows-latest`
GitHub Actions runner — so producing the installer never requires owning a
Windows PC.

- Pushing a `v*` tag builds it and attaches the `.exe` to the matching
  GitHub Release — the durable distribution path (release assets don't
  count against the repo's Actions/Packages storage quota).
- A manual run from the Actions tab (`workflow_dispatch`) instead uploads it
  as the `cafe-pos-windows-installer` Actions artifact, kept for 3 days —
  handy for a one-off build without cutting a release.

### Option B — locally, on an actual Windows machine

```powershell
npm install
npm run build          # builds the Next.js app (.next/)
cd electron
npm install
npm run dist            # produces electron/dist/Cafe POS Setup <version>.exe
```

#### The `winCodeSign` extraction workaround

`npm run dist` runs `scripts/prepare-wincodesign-cache.js` first (as a
`predist` step). That script exists to work around a Windows-only
electron-builder failure that otherwise stops the build before it writes any
`.exe` at all:

electron-builder always fetches its `winCodeSign` bundle on Windows — not to
sign anything (with no certificate, signing is correctly skipped), but because
the same archive carries `rcedit`, which stamps the icon, product name and
version onto `Cafe POS.exe`. That archive contains two macOS symlinks, and
creating a symlink on Windows requires a privilege that a normal, non-elevated
account without Developer Mode doesn't hold, so 7-Zip exits non-zero:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : ...\winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

electron-builder treats that as fatal, retries four times and gives up — you
get `electron/dist/win-unpacked/` but no installer. The `darwin/` and `linux/`
trees are only used when signing *from* macOS or Linux, so the script extracts
the archive itself with those excluded and leaves the result where
electron-builder looks for it; electron-builder then finds a populated cache
and skips the download that would have failed.

It's idempotent (a populated cache makes it a silent no-op) and best-effort: if
anything about it fails it warns and returns successfully, leaving
electron-builder to attempt its own download as before. Enabling Windows
Developer Mode, or building from an elevated shell, also avoids the underlying
problem and makes the script a no-op.

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
