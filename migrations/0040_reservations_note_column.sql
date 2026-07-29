-- reservations.notes was created in migration 0001 but every reader/writer
-- (src/app/api/reservations/route.ts, src/app/api/reservations/[id]/route.ts)
-- has always queried/set `note` (singular) instead — a column that never
-- existed. Every reservations GET/POST/PATCH request has been throwing an
-- uncaught Postgres "column does not exist" error, surfacing to users as the
-- generic "unexpected error" message. Renaming to match the column name the
-- application has always used, rather than touching the four call sites, so
-- the schema now agrees with the code that has been live all along.

ALTER TABLE reservations RENAME COLUMN notes TO note;
