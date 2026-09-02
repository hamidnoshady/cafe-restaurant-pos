#!/bin/sh
# Container entrypoint for the POS app.
#
# 1. Wait until Postgres accepts connections (the db service may still be
#    starting when this container boots).
# 2. Apply forward-only migrations (safe to run every boot — already-applied
#    files are skipped; nothing to do on an up-to-date schema).
# 3. Derive the connection string the SERVER PROCESS should run with, which is
#    deliberately not always the same as $DATABASE_URL above. Every shipped
#    compose file hands this container one Postgres superuser for both
#    migrating and running — but Phase 12's tenant isolation is Postgres row-
#    level security, which a superuser ignores outright, and the app refuses
#    to start in production against a connection like that (src/lib/db.ts,
#    assertRlsEffective). Rather than require every deployment's compose file
#    to be hand-edited, this provisions the restricted `pos_app` role from the
#    privileged connection and launches the server with that instead — see
#    scripts/derive-runtime-database-url.ts for exactly what it checks before
#    doing so (an explicit RUNTIME_DATABASE_URL, or an already-restricted
#    DATABASE_URL, both skip provisioning).
# 4. Hand off to CMD (the production server) with that connection string, while
#    keeping the privileged one as BACKUP_DATABASE_URL: `pg_dump` (the Phase 10
#    backup) runs with row_security off, which Postgres refuses for a role that
#    can't bypass RLS, so a whole-database dump has to use the owner connection
#    — see dumpDatabaseUrl() in src/lib/backup.ts.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  exit 1
fi

echo "Waiting for Postgres to be ready ..."
# pg_isready understands the same connection string as the app.
i=0
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "FATAL: Postgres did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done
echo "Postgres is ready."

# Resolve the TypeScript runner ONCE, and loudly.
#
# The runner image is built from a tree pruned with `npm prune --omit=dev`
# (Dockerfile, prod-deps stage), so only `dependencies` exist here — anything in `devDependencies`
# is silently absent at runtime. tsx is deliberately in `dependencies`:
# `npm start` runs `tsx server.ts` and both boot steps below are TypeScript
# scripts. When it is missing anyway, the bare shell error ("line 46:
# ./node_modules/.bin/tsx: not found") names neither the cause nor the fix, so
# say both here instead. `npm test` asserts this too
# (src/lib/runtime-dependencies.test.ts), so it fails on a developer's machine
# long before it fails on a café's.
TSX="./node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  if [ -f "./node_modules/tsx/dist/cli.mjs" ]; then
    # The package landed but the bin shim is missing or unlinked — run its CLI
    # directly rather than failing a boot over a missing symlink.
    TSX="node ./node_modules/tsx/dist/cli.mjs"
  else
    echo "FATAL: tsx is not installed in this image." >&2
    echo "       The entrypoint and 'npm start' both run TypeScript, and the" >&2
    echo "       runtime image prunes devDependencies out, so tsx must" >&2
    echo "       be listed in package.json \"dependencies\"." >&2
    exit 1
  fi
fi

echo "Applying database migrations ..."
$TSX scripts/migrate.ts

echo "Resolving the server's runtime database connection ..."
RUNTIME_DATABASE_URL_RESOLVED="$($TSX scripts/derive-runtime-database-url.ts)"
if [ -z "$RUNTIME_DATABASE_URL_RESOLVED" ]; then
  echo "FATAL: could not resolve a runtime database connection (see error above)." >&2
  exit 1
fi
export BACKUP_DATABASE_URL="${BACKUP_DATABASE_URL:-$DATABASE_URL}"
export DATABASE_URL="$RUNTIME_DATABASE_URL_RESOLVED"

# Phase 24: Fix volume permissions and hand off to non-root user
if [ -d "/app/backups" ]; then
  chown -R node:node /app/backups
fi

echo "Starting POS server ..."
exec su-exec node "$@"
