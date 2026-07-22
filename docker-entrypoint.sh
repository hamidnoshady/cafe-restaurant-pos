#!/bin/sh
# Container entrypoint for the POS app.
#
# 1. Wait until Postgres accepts connections (the db service may still be
#    starting when this container boots).
# 2. Apply forward-only migrations (safe to run every boot — already-applied
#    files are skipped; nothing to do on an up-to-date schema).
# 3. Hand off to CMD (the production server).
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

echo "Starting POS server ..."
exec "$@"
