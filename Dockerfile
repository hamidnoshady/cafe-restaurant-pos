# syntax=docker/dockerfile:1

# Production image for the POS app (Next.js custom server in server.ts).
#
# The app does NOT use `next start`; `npm start` runs `tsx server.ts`, which
# boots Next in production mode AND the `/ws` WebSocket sync channel. So the
# runtime image keeps the full dependency tree (tsx is a devDependency) plus
# the source tree, `.next` build output, migrations and scripts.
#
# Chromium is intentionally NOT installed here: only the print-agent renders
# receipts, and that runs on the till PC next to the printer — not in this
# container. See docs/deployment-local-network.md.

# ---- deps: install all dependencies (dev deps are needed to build) ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the .next production build ----------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build only needs JWT_SECRET to be *set* to satisfy the prod env check;
# pages that read cookies() render dynamically at request time, not at build.
ENV NODE_ENV=production
ENV JWT_SECRET=build-time-placeholder-not-used-at-runtime
RUN npm run build
# The app currently ships no public/ assets (fonts are bundled via the source
# tree), but Next serves public/ when present — make sure the dir exists so the
# runner's COPY always succeeds and future assets are picked up automatically.
RUN mkdir -p public

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

# Full dependency tree (tsx + next + runtime libs) and the built app.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
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

EXPOSE 3000

# The entrypoint waits for Postgres, applies migrations, then starts the server.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
