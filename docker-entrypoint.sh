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
# 4. Hand off to CMD (the production server) with that connection string.
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

echo "Applying database migrations ..."
npm run db:migrate

echo "Resolving the server's runtime database connection ..."
RUNTIME_DATABASE_URL_RESOLVED="$(npx tsx scripts/derive-runtime-database-url.ts)"
if [ -z "$RUNTIME_DATABASE_URL_RESOLVED" ]; then
  echo "FATAL: could not resolve a runtime database connection (see error above)." >&2
  exit 1
fi
export DATABASE_URL="$RUNTIME_DATABASE_URL_RESOLVED"

echo "Starting POS server ..."
exec "$@"
