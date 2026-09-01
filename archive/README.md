# Archive

Files moved out of the repo root during the switch to Runflare as the deployment
target, kept for reference rather than deleted. Nothing here is read by the app,
the build, or `docker-entrypoint.sh` — it is excluded from the Docker build
context (see `.dockerignore`).

## `deploy/`

Compose files and env templates for hosting platforms this app no longer
deploys to (Komodo, ParsPack, srv1) plus their OpenObserve overlays. Each is
still referenced from the relevant doc as a "retired, kept for reference"
recipe:

- `docker-compose.komodo.yml`, `.env.komodo.example` — see
  [`docs/deployment-local-network.md`](../docs/deployment-local-network.md).
- `docker-compose.srv1.yml` — see
  [`docs/server-migration.md`](../docs/server-migration.md) §Platform recipes.
- `docker-compose.parspack.yml`, `.env.parspack.example` — see
  [`docs/parspack-deployment.md`](../docs/parspack-deployment.md).
- `docker-compose.observability.yml`, `docker-compose.observability.local.yml`
  — see [`docs/openobserve.md`](../docs/openobserve.md); for Runflare, that
  doc's §D covers wiring OpenObserve as a second Runflare service instead.

`docker-compose.local.yml` (the on-premise café server stack) and
`docker-compose.yml` (local dev Postgres) are **not** here — both are still
live, documented deployment paths and stay at the repo root.

If any of these is ever pressed back into service, note that
`docker-compose.komodo.yml`'s `build.context` was updated to `../..` to
account for the move — everything else is unchanged from its original,
root-level version.

## `misc/`

Stray files that had accumulated at the repo root with no reference from any
code, script, or doc — left over from other tools/sessions (draft PR
descriptions, a one-off submission script, an empty file, a stale `pnpm`
lockfile from when the project briefly used a different package manager than
the `npm`/`package-lock.json` it uses today). Safe to delete outright if you
want to reclaim the space; kept here rather than deleted outright in case any
of it turns out to matter.
