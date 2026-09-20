# Windows standalone Business Suite

The supported on-site deployment is a Windows 11 Electron installer for the
complete Business Suite: Accounting, CRM, Growth/Marketing, Website Management,
POS and supporting capabilities. It requires no preinstalled Docker, Node.js or
PostgreSQL.

## Packaged architecture

```text
Business Suite.exe
├── Electron shell
│   ├── single-instance/startup orchestration
│   ├── persistent secrets and instance identity
│   ├── local certificate authority and HTTPS/WSS gateway
│   ├── optional scoped Windows Firewall integration
│   └── graceful application/database shutdown
├── desktop-runtime/                 positive production staging
│   ├── bin/server.cjs               bundled custom Next/WS server
│   ├── bin/migrate.cjs
│   ├── bin/derive-runtime-database-url.cjs
│   ├── .next/                       production output; no build cache
│   ├── node_modules/                traced runtime dependencies only
│   ├── migrations/
│   └── public/
└── one Windows embedded PostgreSQL 16 payload (outside ASAR)
```

The staged runtime is produced by `scripts/build-desktop-runtime.mjs`. It starts
from the Next standalone trace and copies an allowlisted set of executables,
migrations and public assets. It rejects top-level TypeScript, test/build
tooling, caches, development packages and unexpected source files instead of
trying to prune a copied development checkout with broad exclusion globs.

## Network boundaries

- Next.js binds to `127.0.0.1` by default.
- The Electron `BrowserWindow` always uses that loopback origin.
- Embedded PostgreSQL listens on loopback only.
- The print connector remains `127.0.0.1:9123`.
- Phones/tablets use the dedicated HTTPS gateway. It terminates TLS and proxies
  both HTTP and WebSocket traffic to the internal server.
- The gateway exposes neither PostgreSQL nor the print connector.

The Owner's **Settings → Connections → Local Devices** panel selects a valid
Private LAN adapter, enables/disables the gateway, displays the HTTPS address
and QR code, and provides the local root certificate for device onboarding.
Optional firewall creation is limited to the selected gateway TCP port and the
Private profile; it is the only action allowed to request elevation.

Normal production authentication still uses Secure cookies. The proxy forwards
the original host/protocol information needed by the server's existing host,
origin, CSRF and WebSocket checks. The gateway does not enable
`ALLOW_INSECURE_LAN` or bypass tenant/RLS controls.

## Persistent state

Installation resources are immutable. The following remain beneath Electron
`userData` so they survive app updates and reinstall/uninstall by default:

- PostgreSQL data directory
- generated database password and restricted runtime-role URL
- JWT and application master keys
- desktop instance identity
- local CA/server certificates
- gateway configuration
- application/Electron logs

The NSIS package is per-user by default. Ordinary install and startup therefore
do not need administrator rights. The uninstaller deliberately does not delete
application data.

## Startup and shutdown

`electron/main.js` coordinates focused modules rather than implementing every
service directly:

1. Acquire the single-instance lock.
2. Load or create protected persistent configuration.
3. Start embedded PostgreSQL and wait for readiness.
4. Apply forward-only migrations.
5. Derive the restricted `pos_app` runtime database URL.
6. choose a free loopback application port and start the staged server.
7. Verify identity-aware `/api/health` before opening the window.
8. Restore the configured HTTPS gateway where possible.

If another process owns a required resource, startup fails with a diagnostic
rather than attaching to an unrelated service. Shutdown stops the gateway,
drains the Node server and then stops PostgreSQL; logs remain available for
support.

## Pairing and offline operation

First launch either bootstraps a new local owner or redeems a short-lived code
issued for an explicitly selected cloud location. Every redemption creates a
separate site-device identity and credential. Pairing snapshot v2 seeds the
currently classified bootstrap data; supported ongoing sync events remain a
smaller explicit catalog documented in [server-sync.md](server-sync.md).

Loss of Internet does not make the local server unavailable. Browser mutations
that encounter transient local-server failures can queue in IndexedDB for
supported routes, while cloud synchronization retries separately. The UI
reports local-server, Internet and cloud/service states independently rather
than treating `navigator.onLine` as proof that the local service is reachable.

## Build and verification

From the repository root:

```bash
npm ci
npm run build
npm run desktop:runtime
cd electron
npm ci
npm run verify:runtime
npm run dist
```

The Windows workflow additionally:

- verifies exactly one Windows embedded-PostgreSQL payload and no Linux/macOS
  payloads;
- rejects root development-tree leakage;
- checks staged, unpacked and installer size budgets;
- parses the shipped PowerShell print connector;
- launches the actual unpacked executable twice against the same `userData`;
- requires health, first-run behavior, persistence and clean shutdown.

`npm run desktop:size` (or the Electron `size` script after packaging) writes a
Markdown report with component and largest-path measurements.

## Backups, printing, and updates

The existing backup UI and print connector remain product capabilities.
However, a packaged release must include PostgreSQL 16-compatible `pg_dump` and
`pg_restore` plus their required DLLs before packaged physical backup/restore
can be claimed. Do not substitute old PostgreSQL 13/14 clients or download an
unverified archive during CI.

Desktop updates are manual in this release. Removed Docker-era update paths
must not be restored, and no downloaded executable/image may run without a
signed, integrity-verified update design with backup and rollback.

## Uninstall and recovery

Use Windows **Installed apps** to uninstall. App data remains by default. To
perform an intentional destructive reset, first create and verify a compatible
backup, uninstall, and remove the Business Suite `userData` directory manually.
Never delete the data directory as part of a routine upgrade or reinstall.
