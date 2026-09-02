# syntax=docker/dockerfile:1

# Production image for the POS app (Next.js custom server in server.ts).
#
# The app does NOT use `next start`; `npm start` runs `tsx server.ts`, which
# boots Next in production mode AND the `/ws` WebSocket sync channel. So tsx is
# a RUNTIME dependency: it is listed under "dependencies" in package.json,
# because the prod-deps stage below prunes dev dependencies out and a
# devDependency would be dropped from the image at exactly the moment the
# entrypoint calls it. Alongside it the runtime image keeps the source tree,
# `.next` build output, migrations and scripts — the scripts it runs at boot
# are TypeScript too, so anything they import (dotenv, pg) must also be a
# runtime dependency. src/lib/runtime-dependencies.test.ts guards this.
#
# Chromium is intentionally NOT installed here: only the print-agent renders
# receipts, and that runs on the till PC next to the printer — not in this
# container. See docs/deployment-local-network.md.

# ---- deps: install all dependencies (dev deps are needed to build) ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Cache mount keyed on the image's npm cache dir: on a builder that persists
# BuildKit cache between deploys (e.g. registry cache export/import), this
# turns an unchanged package-lock.json into a install from cache instead of a
# full re-download — the biggest single lever on deploy time we don't control
# from inside the Dockerfile alone. Harmless (a plain `docker build` with no
# cache backend just skips it) when it isn't.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- builder: produce the .next production build ----------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build only needs JWT_SECRET to be *set* to satisfy the prod env check;
# pages that read cookies() render dynamically at request time, not at build.
ENV NODE_ENV=production
ENV JWT_SECRET=build-time-placeholder-not-used-at-runtime
# Skips next build's redundant full type-check — see the DOCKER_BUILD doc
# comment in next.config.ts. CI's own `typecheck` job already covers it on
# every push to main before a commit is ever built into an image, here or on
# Runflare (which builds from this same Dockerfile in production).
ENV DOCKER_BUILD=1
RUN npm run build
# The app currently ships no public/ assets (fonts are bundled via the source
# tree), but Next serves public/ when present — make sure the dir exists so the
# runner's COPY always succeeds and future assets are picked up automatically.
RUN mkdir -p public

# ---- prod-deps: strip dev dependencies out of the already-installed tree ----
# Deliberately not a second `npm ci --omit=dev`: that would re-resolve and
# re-download the ~36 production packages a second time for no reason, since
# the `deps` stage already installed them (alongside the 14 dev-only ones
# `npm run build` needed). `npm prune` is a local operation on the tree we
# already have — no registry round trip — so this is strictly a subset of the
# work the old second `npm ci` did.
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---- runner: the image that actually runs in Komodo -------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Which "sha-<short-hash>" tag this image was published as, baked in at build
# time so the running process can report its own version — the self-update check (app-update.ts)
# compares this against what a paired café laptop is running. Defaults to
# "unknown" for a local `docker build` with no --build-arg, which the update
# check treats as "nothing to compare, never offer an update".
ARG GIT_SHA=unknown
ENV APP_IMAGE_SHA=$GIT_SHA

# postgresql-client gives pg_isready / pg_dump / pg_restore. The app's backup
# system (Phase 10) shells out to pg_dump/pg_restore, and the entrypoint uses
# pg_isready to wait for the DB before migrating.
# su-exec is used to drop privileges from root after fixing volume permissions.
RUN apk add --no-cache postgresql16-client su-exec

# Production tree only — dev dependencies pruned out, so dependencies only.
# tsx belongs there (see the note at the top of this file): the entrypoint
# runs TS scripts and `npm start` runs `tsx server.ts`.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/server.ts ./server.ts
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Fail the BUILD, not a café's Monday morning, if tsx ever drops out of the
# production tree again. `npm ci --omit=dev` makes that failure invisible until
# the container boots and the entrypoint cannot find its TypeScript runner —
# so assert it here, where the fix is a one-line package.json change.
RUN test -x ./node_modules/.bin/tsx \
  || { echo "tsx is missing from the production dependency tree: it is required at runtime (entrypoint + 'npm start'), so it belongs in package.json \"dependencies\", not \"devDependencies\"."; exit 1; }

EXPOSE 3000

# The entrypoint waits for Postgres, applies migrations, then starts the server.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
