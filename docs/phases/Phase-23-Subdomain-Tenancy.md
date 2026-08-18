# Phase 23 — Per-Business Subdomains, Environment-Aware Sync & Typable Sync Tokens

Tracked by GitHub issue [#174](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/174).

## Numbering note

The issue calls this "Phase 21". That number was already taken by
[Phase-21-Multi-Industry-Accounting-Platform.md](Phase-21-Multi-Industry-Accounting-Platform.md),
as was 22 by the accounting-standards phase, so the work is filed here as **Phase 23** and the
code comments say Phase 23. Two live "Phase 21"s would have made every `Phase 21` comment in the
codebase ambiguous — a reader hitting one in `host.ts` would look up the multi-industry phase and
find nothing about subdomains.

## Context: what exists today

Four problems, all rooted in the same thing — a business's identity lived in a URL *path*, and the
sync configuration asked the operator for facts the system already knew.

1. **Tenant isolation was a path prefix, not an origin.** `src/middleware.ts` rewrote
   `/{slug}/dashboard/**` → `/dashboard/**` when `session.businessSlug` matched. So one deployment
   served every tenant from one origin: one session cookie (`pos_session`, host-scoped, `path=/`)
   valid for whichever business the JWT named, and every tenant sharing one browser origin, one
   `localStorage`, one service worker, one CSP/CORS boundary. Origin is the browser's only real
   isolation primitive and we were not using it.
2. **The sync settings tab asked for the central server address** even though pairing already knew
   it — `pairing-apply.ts` writes the config the laptop was paired with.
3. **Nothing told an install it was the VPS.** `deployment-mode.ts` only distinguishes `local` vs
   `connected` for *feature* purposes; "am I the central server?" was inferred from the mere
   presence of `REMOTE_SYNC_TOKEN`. So a VPS rendered a "connect me to a central server" form that
   makes no sense there.
4. **The shared token had no format.** `resolveConfigUpdate` checked only `length >= 16`, and the
   UI told the owner to run `openssl rand -hex 32` by hand. A typo, a truncated paste, or a
   Persian-digit paste was indistinguishable from a wrong token and surfaced only as a silent 401
   at the next push.

**No new installations and no migration of business content.** Existing businesses keep their `id`
and their row; only what reaches them changes.

---

## Scope — Wave 1: Typable sync tokens

Self-contained, no routing changes, ships independently.

- **`src/lib/sync-token.ts`** — the format. `SYNC_TOKEN_PREFIX = "POS1"` as a version marker,
  `generateSyncToken()` (32 characters of entropy in 4-character groups plus a 2-character
  checksum), `normalizeSyncToken()`, `parseSyncToken()` returning
  `{ ok: true, canonical }` or `{ ok: false, error }` over
  `bad_prefix | bad_length | bad_charset | bad_checksum`, and `isLegacySyncToken()`.
- **`src/lib/code-alphabet.ts`** — the pairing-code alphabet and the Persian/Arabic-Indic digit
  folding, extracted so both code families share one definition. `pairing-codes.ts` re-exports
  `PAIRING_CODE_ALPHABET`, so every existing importer is unaffected.
- **`src/lib/server-sync-config.ts`** — `parseSyncToken` replaces the length check, the canonical
  form is what gets stored, and `syncTokenFormat()` tells the UI whether a stored token is
  `current` or `legacy`.
- **`src/lib/pairing-service.ts`** — pairing mints a POS1 token instead of
  `randomBytes(32).toString("hex")`. Everything downstream is unchanged: still through
  `setServerSyncConfig`, still SHA-256 in `server_sync_tokens`.
- **`POST /api/server-sync/config/generate-token`** — owner-only, same guard as the config route.
- **`src/app/dashboard/settings/server-sync-settings.tsx`** — a "generate token" button, the value
  shown once in full with a copy button, client-side validation of a pasted value before the save
  round-trip, and a banner on a legacy token. The `openssl rand -hex 32` hint is gone.
- **`src/app/dashboard/ui.tsx`** — Persian strings for the four new codes, plus `invalid_url` and
  `unknown_location`, which predate this phase but fell through to raw English codes.

## Out of scope (this wave)

- **Rotating an existing token automatically.** Generating deliberately does not save: rotating the
  live token before the peer has the new value would break sync between the two calls.
- **Re-canonicalising an incoming bearer token** in `resolveBusinessBySyncToken`. Both sides store
  the canonical form, so the hashes already agree; normalising there would break legacy hex tokens,
  whose case is significant to the hash.

## Decisions

- **A pure arithmetic checksum, and Web Crypto for randomness — not `node:crypto`.** The sync
  settings tab is a client component and validates a pasted token before the save round-trip, so
  everything on that import path has to bundle for the browser. `pairing-codes.ts` imports
  `node:crypto`, which is why the alphabet moved to its own file rather than being imported from
  there directly. The production build passing is the proof.
- **A positional weighted sum mod 32², not a hash truncation.** `sum = sum*31 + index` mod 1024
  detects *every* single-character substitution and every adjacent transposition in the payload —
  31 and 15 are odd and therefore invertible mod 1024 — which are precisely the two mistakes
  someone re-typing a token makes. A truncated SHA-256 would give no such guarantee.
- **No 0→O / 1→I folding, unlike `normalizePairingCode`.** The prefix `POS1` contains a literal
  `1`; that pass would corrupt it. A `0` or `1` in the body is reported as `bad_charset`, which is
  the honest answer — those characters are never issued.
- **Legacy 64-character hex tokens stay valid.** Every laptop paired before this format holds one.
  Rejecting them would break each of those installs on upgrade, so they are accepted verbatim and
  flagged in the UI for rotation instead.

## Where each exit criterion is satisfied (Wave 1)

| Criterion | Where |
|---|---|
| A generated token is grouped and typable | `generateSyncToken`, `src/lib/sync-token.ts` |
| A corrupted token is rejected at the input, not as a later 401 | `parseSyncToken` + the client-side check in `server-sync-settings.tsx` |
| A Persian-digit or lowercase paste still works | `normalizeSyncToken`, covered in `sync-token.test.ts` |
| An already-paired laptop still syncs after upgrade | `isLegacySyncToken`, covered in `server-sync-config.test.ts` |
| The product generates the token | `POST /api/server-sync/config/generate-token` |

## Verification

`npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build` all pass. New
`src/lib/sync-token.test.ts` covers the generate→parse round trip, every rejection path, digit
folding, case/hyphen insensitivity, all 32 single-character substitutions, adjacent transpositions,
and legacy-hex acceptance; `server-sync-config.test.ts` is extended for the new validation and for
canonical-form storage.

---

## Scope — Wave 2: Deployment role & derived sync URL

- **`src/lib/deployment-role.ts`** — `deploymentRole(): "central" | "site"` and
  `platformBaseUrl(): string | null`, with pure `resolveDeploymentRole`/`resolvePlatformBaseUrl`
  underneath for testing, plus `describeDeploymentRole()` for the startup log.
- **`DEPLOYMENT_ROLE=central|site`** — `central` in `docker-compose.komodo.yml` and
  `docker-compose.srv1.yml`, `site` in `docker-compose.local.yml` and the Electron spawn env.
  Documented in all three `.env.*.example` files.
- **`GET /api/server-sync/config`** returns `role`, a derived `resolvedRemoteUrl`, and — on a
  central server — `pairedSite` (token set time and last contact, from `server_sync_tokens` +
  `server_sync_log`).
- **The sync tab renders per role.** Central: no connection form at all, just what it can
  truthfully say about its paired site. Site: the central address is derived read-only text, with
  an override behind a disclosure for the genuinely-moved-VPS case. The status, update, and
  dead-letter panels are shared by both.
- **`PUT /api/server-sync/config` refuses on a central server** with `409 central_server`.

## Out of scope (this wave)

- **Overloading `deployment-mode.ts`.** That answers a different question — how a *business*
  relates to the platform, stored per business in `settings`, written once at first run.
- **Removing `REMOTE_SYNC_TOKEN`.** The legacy shared-secret fallback is untouched; only the
  inference *about* it changed.

## Decisions

- **Unset infers from the environment.** `central` if `REMOTE_SYNC_TOKEN`, `POS_DOMAIN` or
  `ROOT_DOMAIN` is set, else `site`. `ROOT_DOMAIN` joined the list after the Wave 5 cutover, when a
  cloud deployment served per-business subdomains and declared no other central-server hint — before
  that the inference was `REMOTE_SYNC_TOKEN` or `POS_DOMAIN` only. An unrecognised value is treated
  as unset rather than throwing: refusing to boot over a typo'd env var is a worse failure than
  falling back to the behaviour the install already had. `server.ts` logs the decision *and its
  source*, because inference is exactly when an operator needs to see it.
- **`getPairedSite` is singular, not a list.** `server_sync_tokens` is keyed by `business_id`
  (migration 0033), so one paired install per business is the design, and `setServerSyncConfig`
  replaces the row rather than appending. A list would have implied a model the schema does not have.
- **The refusal runs before the body is read.** A malformed body would otherwise 400 first and hide
  the real reason. `api-guards.test.ts` asserts that ordering, not just the presence of the check.
- **`PUT` still accepts `remoteUrl` on a site.** The override path and existing API clients depend
  on it; only the central-server case is refused.

## Where each exit criterion is satisfied (Wave 2)

| Criterion | Where |
|---|---|
| A VPS does not render a "connect me" form | the `role === "central"` branch in `server-sync-settings.tsx` |
| A central server refuses sync-target writes | the `deploymentRole() === "central"` guard in `PUT /api/server-sync/config` |
| A site's central URL is derived, not typed | `resolvedRemoteUrl` in the config `GET` + the read-only field |
| An operator can see the inferred role | `describeDeploymentRole()` logged from `server.ts` |

## Verification

All four checks pass. `deployment-role.test.ts` covers every inference branch including the
explicit-overrides-hint case, blank/unrecognised values, and each `platformBaseUrl` source;
`api-guards.test.ts` gains the central-server refusal assertion.

---

## Scope — Wave 3: Subdomain routing (the security fix)

Everything here is behind **`SUBDOMAIN_ROUTING=on|off`**, off by default. With it off the
path-prefix behaviour is byte-for-byte what it was.

### 3a. Schema and slug rules

- **`migrations/0066_business_subdomains.sql`** — `businesses.subdomain citext` with a unique
  index, backfilled from `slug` then `SET NOT NULL`; and `business_subdomain_aliases`
  (`business_id`, `alias citext UNIQUE`, `created_at`) **with its RLS policy in the same
  migration**.
- **`src/lib/slug.ts`** — `validateSubdomain()` (a DNS label: `^[a-z0-9-]{3,63}$`, no
  leading/trailing hyphen, no `--` at positions 3–4), `subdomainFromBusinessName()`, and
  host-level additions to `RESERVED_SLUGS`.

### 3b. Host resolution

- **`src/lib/host.ts`** — pure, Edge-safe: `parseHost(host, rootDomain)` →
  `{ kind: "apex" | "admin" | "business" | "unknown", label }`, `businessHost()`,
  `subdomainRoutingEnabled()`.
- **`src/middleware.ts`** — the tenant-realm block compares the host label to a new
  **`businessSubdomain` JWT claim**, minted at every session mint site. Mismatch, unknown host, or
  a session without the claim all clear the cookie and redirect to that host's login.
- **`src/lib/host-resolution.ts` + `GET /api/host/resolve`** — the Node-runtime half: label →
  business, following one rename through the alias table.

### 3c. Cookies, login, and the platform realm

- `sessionCookieOptions()` and `platformSessionCookieOptions()` still set **no `domain`**, now with
  comments saying that is load-bearing.
- **`POST /api/auth/directory`** + `src/app/business-directory.tsx` — the apex router.
- **`/platform` is moved to `admin.{root}`** by middleware when reached on any other host.
- **`/{slug}/dashboard` 301s** to the subdomain form for the transition window.
- **`POST /api/auth/switch-business` refuses** with `410 cross_origin_switch_retired`.

### 3d. Platform console

- Subdomain offered at add time (prefilled from the name, live-validated, URL preview) and editable
  afterwards via `PATCH { subdomain }`, guarded by `business.edit` and audited as
  `business.subdomain`. `renameBusinessSubdomain()` does the rename, the alias insert, and the
  stale-alias cleanup in one transaction.
- Businesses still on a backfilled `biz-xxxxxxxx` host are flagged in the list.

### 3e. Traefik

One wildcard router plus explicit `admin.` and apex routers, **all pointing at the same
container** — a new business is a database row, never a redeploy. `docker-compose.srv1.yml`
carries the file-provider equivalent in comments, since that host runs `network_mode: host` and
never reads container labels.

## Out of scope (this wave)

- **Turning it on in production.** That is Wave 4, and it is blocked on the wildcard certificate.
- **Deleting the path-prefix rewrite**, `handleDashboardUrlRewrite`, or the `switch-business`
  handler. All three survive one release; Wave 4 removes them.
- **Migrating sessions across a rename.** A session on the old host is invalidated by design — the
  JWT carries the old subdomain, so the mismatch check does exactly its job. The console warns
  before the rename.
- **Per-business TLS certificates.** One wildcard covers every business origin, which is what makes
  "no redeploy per business" true.

## Decisions

- **`subdomain` is a new column, not a rename of `slug`.** They answer different questions and have
  different lifetimes: `slug` is the stable internal handle every stored reference uses; `subdomain`
  is the mutable public name. Conflating them would make renaming a business break every stored
  reference to it — exactly what the alias table exists to prevent.
- **The isolation check is a JWT claim comparison, not a lookup.** Middleware is Edge runtime and
  cannot query Postgres. Comparing the host's label to a claim written by a Node-runtime login that
  *did* have the database is both sufficient and the only thing available. It fails closed in every
  direction, including for tokens minted before the claim existed.
- **The apex directory asks for a password**, though the issue described an email-only lookup.
  Email-only would be an open account-enumeration oracle on a public origin: type any address,
  learn whether it has memberships and where. `/api/auth/login` already reveals the business list
  only after the password checks out, so email-only would also have been a regression against the
  codebase's own existing decision. It costs the visitor one field they were about to type anyway,
  and still mints no session — which is the part that matters.
- **`parseHost` returns `unknown` for multi-label subdomains and for suffix-shaped impostors.**
  `a.b.{root}` is not covered by a single-level wildcard certificate, and `evilpos.eshobe.com`
  merely *ends with* the root's text — treating it as a subdomain would hand an attacker-controlled
  host a tenant label.
- **A seventh `withoutTenantScope` reason, `host-resolution`.** Once each business has its own
  origin, the host *is* how a tenant gets identified, so this is the same
  identify-the-tenant-first shape as `login` and `server-sync-auth`. One read-only lookup returning
  the business's identity and nothing else.
- **`SUBDOMAIN_ROUTING=on` with no `ROOT_DOMAIN` reads as off.** Every host would parse as
  `unknown` and every request would fail closed — locking a deployment out of its own dashboard on
  a misconfiguration, which is worse than staying on the old behaviour.
- **`switch-business` is refused in Wave 3 and deleted in Wave 4**, matching the treatment of the
  path-prefix rewrite. Deleting the handler while the flag is off would remove a capability that
  still works in the shipped default.

## Where each exit criterion is satisfied (Wave 3)

| Criterion | Where |
|---|---|
| Each business is served from its own origin | `parseHost` + `handleHostIsolation`, `src/middleware.ts` |
| A session does not span subdomains | no `domain` on the cookie (`auth-edge.ts`) + the claim check |
| The console has its own host | the `host.kind !== "admin"` redirect in `handlePlatformAdmin` |
| The super-admin sets each business's English subdomain | the add form and `SubdomainPanel` in `src/app/platform/**` |
| Traefik serves them all from one wildcard router, no per-business deploy | `docker-compose.komodo.yml` labels; `.srv1.yml` file-provider equivalent |
| Existing `biz-*` slugs keep working, flagged for renaming | migration 0066's backfill + `isPlaceholderSubdomain` in the console list |
| An old host keeps resolving after a rename | `business_subdomain_aliases` + `resolveBusinessByLabel` + the redirect in `page.tsx` |
| The aliases table cannot leak across tenants | its RLS policy in migration 0066, asserted by `tenant-isolation.integration.test.ts` |

## Verification

All four checks pass, including `tenant-isolation.integration.test.ts` against the new
tenant-scoped table. `host.test.ts` covers apex/admin/business/unknown parsing, the suffix-shaped
impostor, multi-label rejection, and the routing switch; `slug.test.ts` is extended for DNS-label
validation and host-level reservations.

**Done, in a real browser.** Two businesses were provisioned on one deployment and served over
HTTPS behind a self-signed wildcard certificate, through a proxy setting the same `X-Forwarded-*`
headers Traefik sets — so the origin construction was exercised the way production exercises it,
not just over plain HTTP on one port. Chromium confirmed:

- `pos_session` is stored as `domain="acme.localtest.me"`, host-only, `Secure`, `HttpOnly`. The
  browser sends it to acme and **not** to beta.
- With acme signed in, `beta-new.localtest.me/dashboard` lands on beta's login, while
  `acme.localtest.me/dashboard` still serves. **This is the security fix.**
- Replaying the raw cookie value at beta's host — the case a cookie jar would not prevent —
  returns `307 → /login` with `Set-Cookie: pos_session=; Expires=1970` for a page, and
  `401 {"error":"wrong_origin"}` for an API route. The guarantee does not rest on the jar.
- `/platform` on a tenant origin moves to `admin.…`, and the tenant cookie is never sent there.
- A renamed subdomain's old host forwards to the current one, including on deep paths.

That pass found three defects, fixed in the follow-up below.

### Follow-up fixes (found by the verification pass)

1. **Redirects carried the container's port.** Building a redirect by mutating `request.nextUrl`
   keeps *that* URL's port, which behind a TLS-terminating proxy is the internal one. `/platform`
   on a tenant host pointed at `https://admin.example.com:3000/platform`, where nothing listens —
   so the console was unreachable from a tenant origin. `swapHostLabel()`/`preferredProto()` now
   build redirects from the `Host` header and `x-forwarded-proto` instead. Note the same trap
   bites twice and differently: in *middleware* `request.url` reflects the external origin, but in
   a *route handler* it is the internal one.
2. **The legacy `/{slug}/dashboard` redirect used the slug as the host label.** Slug and subdomain
   agree for every business migration 0066 backfilled and diverge the moment an admin sets a real
   subdomain — the exact split this phase introduced — so `/acme-cafe/dashboard` pointed at
   `acme-cafe.example.com`, which serves nobody. It now translates via the session claim, or via
   the resolver when there is no session.
3. **An alias host only worked at `/`.** Alias resolution lived in `page.tsx`, which runs for `/`
   alone; every deeper path hit the isolation check first and bounced to a login on a host that
   serves nobody — and a login there could never succeed, because the session it mints names the
   *current* subdomain. Since a real bookmark is a deep path, "the old host keeps working" was
   effectively false. New `GET /api/host/redirect` (Node runtime, session-less) resolves an alias
   or a legacy slug and 308s to the canonical host preserving the path; middleware sends both the
   mismatch and the signed-out case there.

None of the three was a hole in the isolation boundary — all failed closed, which is why the
security assertions passed while these were still broken.

Remaining known gap, pre-existing and out of scope: after being forwarded to the right host a
signed-out visitor lands on `/login` rather than the page they bookmarked, because login has no
return-to. The host is now correct, which is what these fixes were for.

---

## Scope — Wave 4: Cutover, docs, close-out

- This document, and its row in [README.md](README.md).
- The README's "Multi-business tenancy" and "On-site deployment" sections: origin-based isolation
  is now part of the tenancy story alongside RLS.
- `CLAUDE.md`: the `src/app/platform/**` note says the console lives on its own host, and the
  tenancy section names subdomain isolation as a second boundary.

## Out of scope (this wave) — the remaining cutover steps

Done in Wave 5 below. They were deliberately **not** done here, because they are operational and
were gated on the wildcard certificate:

- **Flipping `SUBDOMAIN_ROUTING=on` in production**, once the wildcard certificate is confirmed
  issuing.
- **Deleting the transition-window code** — `handleDashboardUrlRewrite`, the legacy 301, the
  `businessSlug` URL logic, and the `switch-business` handler — one release after the flip.

## Prerequisite — wildcard TLS (ops; blocks the production cutover)

`*.{ROOT_DOMAIN}` needs a wildcard certificate, and **Let's Encrypt will not issue one over
HTTP-01**. Traefik's `certresolver` must move to a **DNS-01 challenge**, which needs an API
credential for whoever hosts the zone's DNS. `docker-compose.komodo.yml` declares the
`tls.domains[0].main`/`sans` pair the resolver needs; `.env.komodo.example` says the resolver must
be DNS-01. Local development needs none of this.

If DNS-01 is unavailable, the fallback is a proxy with on-demand per-hostname issuance, which
changes the ops story materially and should be decided before the flip.

## Verification

`npx tsc --noEmit`, `npm test`, `npm run test:db`, and `npm run build` pass on every wave commit —
the same four commands CI's `test` job runs.

---

## Scope — Wave 5: The cutover — one URL scheme, a nested root, a typed subdomain

The deployment now lives at a subdomain of its own (`ac.eshobe.com`), with businesses one label
below it (`biz1.ac.eshobe.com`). Three changes, all of them the other half of Wave 3:

### 5a. `ROOT_DOMAIN` is the switch

`subdomainRoutingEnabled` is on whenever a root domain is configured; `SUBDOMAIN_ROUTING=off`
survives only as an escape hatch for a deployment whose wildcard certificate is not issuing yet.
An install with no root domain — the desktop app, a single-café laptop — is untouched and serves
`/dashboard` with nothing host-scoped.

**A nested root needed no code.** `parseHost` matches the root as a suffix and only limits the
depth *below* it, so `biz1.ac.eshobe.com` against `ROOT_DOMAIN=ac.eshobe.com` was already an
ordinary business host. What the nesting costs is in TLS: the wildcard has to be
`*.ac.eshobe.com`, since one for `*.eshobe.com` does not cover a name a level deeper. `host.test.ts`
pins the nested case so it cannot regress.

### 5b. The path-prefix URL scheme is deleted

- `handleDashboardUrlRewrite` and the `session.businessSlug` branch that called it are gone from
  `src/middleware.ts`.
- `src/app/page.tsx` redirects to `/dashboard`, unconditionally.
- `dashboard-sidebar.tsx`'s `splitDashboardPrefix` is gone — every `NavItem.href` is already the
  canonical path, and there is no longer a prefix to graft back on.
- `welcome/pair-form.tsx` lands a freshly-paired laptop on `/dashboard`.
- The bookmark bridge stays: `/{slug}/dashboard/**` still 301s to the same path on the business's
  own host (or, with no root domain, simply loses its prefix).

### 5c. The subdomain is typed, not generated

- The console's add form no longer prefills the label from the business name; the field is
  required, live-validated, and previews the resulting URL.
- `POST /api/platform/businesses` passes `requireSubdomain: true`, so a console-provisioned
  business without one is a `400 missing_subdomain`.
- `provisionBusiness` takes a requested label **verbatim** and raises `SubdomainTakenError`
  (`409 subdomain_taken`) when it is spoken for, checking live subdomains *and* the alias table.
  Only the name-derived fallback — the first-run wizard and public signup, which have no admin to
  ask — still settles a collision by suffixing.

### 5d. What the cutover exposed

Three things worked only because the flag was off, and are fixed here:

- **`/api/dashboard/**` matched the legacy-URL pattern** (slug `api`), so with routing on every
  dashboard data fetch would have been redirected to the host resolver instead of served.
- **PIN, roster and biometric login could not resolve a business.** `resolveLoginBusinessId`'s
  last fallback is "the only active business", which on a platform holding two is
  `business_required` — no cashier could sign in. It now resolves the origin first, which is both
  the fix and the boundary: a body naming another business cannot reach that business's roster.
- **WebAuthn was bound to one host.** `rpId()` now defaults to `ROOT_DOMAIN` (a browser only
  accepts an RP ID that is a registrable suffix of the page's origin), and `expectedOriginsFor`
  adds the request's own origin when its host parses under the root — the per-business origins
  cannot be enumerated in `WEBAUTHN_ORIGIN` ahead of time, because a new business is a row.

`/api/auth/login` is host-scoped too: on a business host it only ever signs someone into *that*
business, so a person with several memberships is never offered a picker that would mint a cookie
the next request bounces. `/login` on the apex goes to the directory, and on the console host to
`/platform/login`.

## Out of scope (this wave)

- **Deleting `POST /api/auth/switch-business`.** It already refuses (`410`) whenever host routing
  is on, and that is now every deployment with a root domain. On an install *without* one it is
  still the only way to move between memberships, so it stays until that case does.
- **Renaming or backfilling anyone's subdomain.** `biz-xxxxxxxx` hosts from migration 0066's
  backfill keep working and keep their badge in the console list; renaming one is the operator's
  call, and the alias table already covers the consequences.
- **`businesses.slug`.** Still the stable internal handle every stored reference uses. It is no
  longer in any URL the app generates, which is exactly why it can stay stable.

## Decisions

- **Declaring `ROOT_DOMAIN` is the request for per-business origins.** Keeping a separate opt-in
  after the path-prefix scheme is gone would leave one genuinely bad state reachable — root domain
  set, routing off, several tenants sharing one origin with *no* prefix and no boundary. The
  escape hatch is still there, but it now has to be asked for.
- **The bookmark bridge is not transition-window code.** Wave 4 listed the legacy 301 for deletion
  alongside the rewrite, but the two are opposites: the rewrite *generated* prefixed URLs, the 301
  *retires* them. Deleting it would only break printed URLs, so it stays.
- **A typed subdomain that is taken is an error, not an `acme-2`.** The admin leaves the form
  believing they provisioned `acme.$ROOT_DOMAIN` and hands that address to a customer. Silent
  suffixing is fine for a derived label nobody has seen yet, and wrong for one somebody typed.
- **The login host check runs before the password check.** No oracle: which business a hostname
  serves is what DNS and the certificate already announce.
- **A login on the apex or the console host is refused rather than redirected mid-POST.** The page
  request is redirected (`/login` → the directory), but the API answers `wrong_origin`: a cookie
  minted there would be valid on an origin that never uses it.

## Where each exit criterion is satisfied (Wave 5)

| Criterion | Where |
|---|---|
| Businesses are served one label below a nested project subdomain | `parseHost` (unchanged) + the nested-root cases in `host.test.ts` |
| No subdirectory URL is generated anywhere | `src/app/page.tsx`, `dashboard-sidebar.tsx`, `pair-form.tsx`; `handleDashboardUrlRewrite` deleted |
| An old prefixed bookmark still resolves | `handleLegacyPathRedirect` (routed) and the unprefixing 301 (unrouted), `src/middleware.ts` |
| The subdomain is a hand-typed English name | the required, unprefilled field in `src/app/platform/page.tsx` + `requireSubdomain` in `validateProvisionBody` |
| A taken subdomain is refused | `SubdomainTakenError` → `409 subdomain_taken` in `POST /api/platform/businesses` |
| Every login family works per-origin | `resolveLoginBusinessId`'s host branch, `loginHostBusinessId` in `/api/auth/login`, `expectedOriginsFor` |

## Verification

`npx tsc --noEmit`, `npm test`, `npm run test:db` and `npm run build` pass. New unit coverage:
nested-root parsing and the new switch semantics in `host.test.ts`, the typed/required/derived
subdomain rules in `business-provisioning.test.ts`, and `expectedOriginsFor` (including that a
forged `Host` outside the root cannot widen the accepted origins) in `webauthn.test.ts`.

---

## Scope — Wave 6: Running behind a managed platform

Wave 5's cutover was attempted on a PaaS (Runflare) rather than the Traefik stack the compose
files describe, and it failed in a way worth writing down: setting `ROOT_DOMAIN` returned **502 on
every hostname, including the apex that had been serving a second earlier**.

### What actually happened

The app decides tenancy from the real `Host` header, deliberately — a forwarded header is
client-supplied unless a proxy overwrote it, and Traefik passes the original through untouched. A
managed platform does the opposite: it routes by hostname at its edge and hands the container an
internal name, keeping the browser's hostname in `X-Forwarded-Host`. So `Host` named no tenant on
any request, and with `ROOT_DOMAIN` set every request parsed as `unknown` and failed closed.

Failing closed is correct. The 502 came from what failing closed *looked like* in a loop:

1. `/dashboard` with a valid session, unknown host → middleware sends it to `/api/host/redirect`.
2. The resolver cannot name the host either → redirects to the apex `/`.
3. `/` is public, so page.tsx runs, finds a session, and redirects to `/dashboard` — back to (1).

A platform health probe caught in that cycle marks the instance unhealthy, and the edge then
serves 502 for *everything*, which is why the apex went down too.

### The two fixes

- **`TRUST_FORWARDED_HOST=on|off`** (default off, so Traefik deployments are byte-for-byte
  unchanged). On, the tenancy decision reads the first entry of `X-Forwarded-Host`.
  `resolveRequestHost` is the single place that decides, and middleware, `page.tsx`, the login
  family, `/api/host/*` and WebAuthn's origin check all now go through it — a boundary that held
  in one layer and not another would be worse than no boundary at all.
- **The loop terminates at `/`.** Every cycle passes through the root page, so that is where it
  stops: an unknown host under host routing renders an explanation instead of continuing to
  `/dashboard`. A misconfiguration now costs one page, not the deployment.

`GET /api/host/resolve?debug=1` reports both host headers, which one the tenancy decision used,
and how it parsed. Without it this class of problem is close to undiagnosable — every symptom
(a login that never sticks, endless redirects, a 502 from the edge) points somewhere else.

## Decisions

- **Opt-in, not auto-detected.** "Use `X-Forwarded-Host` when `Host` doesn't parse under the root"
  would have made this work with no configuration — and would have meant the boundary silently
  weakens whenever the root domain is misconfigured, which is exactly when nobody is looking. An
  operator naming their platform is a decision that can be reviewed.
- **The cost is stated where it is taken.** Turning it on means a caller who can reach the app
  directly, bypassing the platform, chooses which origin their request appears to be on. That does
  not cross the tenant boundary — rows are scoped by the session JWT's `businessId`, so RLS is
  untouched — but the origin check degrades to what the cookie jar already enforces. Both
  `trustForwardedHost`'s doc comment and `.env.example` say so in those terms.
- **The diagnostic is public.** It echoes the caller's own request headers back to them plus
  `ROOT_DOMAIN`, which is in the URL they typed; the one new fact is the platform's internal
  hostname for the container. Worth it, and gated behind `?debug=1`.
- **The unknown-host page is not a redirect.** Redirecting anywhere is what caused this; a
  terminal page is the only response that cannot participate in a loop.

## Where each exit criterion is satisfied (Wave 6)

| Criterion | Where |
|---|---|
| Per-business origins work behind a Host-rewriting platform | `TRUST_FORWARDED_HOST` + `resolveRequestHost`, `src/lib/host.ts` |
| One definition of "this request's host" | `requestHost` used by middleware, `page.tsx`, the login family, `/api/host/*`, WebAuthn |
| A host misconfiguration cannot loop the deployment down | the `host.kind === "unknown"` branch in `src/app/page.tsx` |
| An operator can see what the app sees | `GET /api/host/resolve?debug=1` |
