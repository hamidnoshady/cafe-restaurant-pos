# Phase 20 — Employee Secure Identity, Biometric Authentication & Audit Security

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 13 (Teams & Permissions — the `users`/role/permission model this phase
extends), Phase 14 (multiple branches per business — session/device scoping needs a location).
**Goal:** Replace the shared-device PIN pad's implicit trust (any 4-digit match on a business is
"good enough") with a real per-employee identity: a persisted, revocable session instead of a
bare stateless JWT, a credential model that can grow past PIN into biometric/WebAuthn without a
schema change, and — starting in a later wave — every sensitive POS action attributable to one
person with a queryable audit trail. Tracked by GitHub issue #107, staged as eight waves; this
phase's exit criteria are only met once Wave 8 ships.

## Ordering note

CLAUDE.md's phase-sequencing rule ("don't start a phase until the previous one's exit criteria
are met") is not fully satisfied here: Phase 19 is still in progress (Waves 1–2 merged; Waves
3–5 not started as of this wave's start) rather than complete. Issue #107 explicitly requested
Phase 20 work now, and this wave was scoped to avoid any dependency on Phase 19 finishing —
`employees`/`employee_credentials`/`employee_sessions` share no code, schema, route, or subject
matter with the public-API work, so there is no ordering hazard between the two beyond both
being open at once. Later Phase 20 waves that do turn out to depend on Phase 19 landing first
should say so explicitly when scoped, rather than assuming this note still applies.

## Context: what exists today

Staff sign in one of two ways (`src/lib/team.ts`'s `PASSWORD_ROLES`/`PIN_ROLES` split):
password roles (`owner`, `manager`, `accountant`) authenticate through the global
`platform_users` table; floor roles (`cashier`, `waiter`, `kitchen`) authenticate with a 4-digit
PIN checked against `users.pin_hash` (`src/app/api/auth/pin-login/route.ts`). Both paths mint the
same stateless `pos_session` JWT (`src/lib/auth-edge.ts`) — there is no server-side session
record at all today, so a session can't be individually revoked; the only way to end one early is
to let it expire (`SESSION_HOURS`, default 12h) or rotate `JWT_SECRET` for everyone at once.

PINs are already personal per membership (bcrypt-hashed, one per `users` row, uniqueness
enforced per-business since Phase 12) — there is no literal *shared* PIN in the code today, aside
from convenience seed data (`1234`). What's actually missing is the infrastructure the later
waves need: a credential model with room for more than one credential type per person, and a
session record that can be looked up, listed, and revoked server-side. Building that
infrastructure without disturbing the live login path is this wave's whole job.

## Scope — Wave 1: Employee Identity Foundation

- **`employees`** — a 1:1 profile extension of `users` (`employees.id = users.id`), created
  lazily by `ensureEmployeeProfile()` rather than backfilled in the migration, so this ships with
  zero data migration risk. Carries the profile fields `users` never had room for:
  `employee_code`, `phone`, `photo_url`, `hired_at`, `notes`. Role, name, business/branch, and
  active-flag stay on `users` — Wave 1 does not move or duplicate them.
- **`employee_credentials`** — a proper child table for credentials, modeled on Phase 19's
  `api_keys` (hash-only storage, no plaintext ever persisted, `status`/`revoked_at`, an
  `employee_credential_type` enum already carrying `'pin' | 'password' | 'webauthn'` so later
  waves don't need another migration to add a type). Only `'pin'` is issuable through
  `employee-service.ts` in Wave 1 (`ISSUABLE_CREDENTIAL_TYPES` in `src/lib/employee.ts`); a
  partial unique index enforces at most one *active* credential per (employee, type) — issuing a
  new PIN revokes the old one first.
- **`employee_sessions`** — the first persisted, revocable session record in the codebase.
  Token-hash storage and the "resolve, then conditionally update on use" pattern mirror
  `src/lib/api-auth.ts`'s `authenticateApiKey`. Supports listing an employee's active sessions and
  revoking one by id.
- **Service layer** — `src/lib/employee.ts` (pure: session-token generation/hashing, expiry,
  `sessionStatus`, the credential-type catalogue; unit-tested in `employee.test.ts`) and
  `src/lib/employee-service.ts` (DB-touching CRUD for all three tables, unexported-pattern-tested
  per repo convention — no direct test file, same as `team-service.ts`).

## Out of scope (this wave)

- **Wiring into the live login path.** `src/app/api/auth/pin-login/route.ts` and
  `auth-edge.ts`'s JWT session keep working completely unchanged. `employee_sessions` is not yet
  consulted by any route — that is Wave 2 (Login Experience Redesign), which is also where a
  `withoutTenantScope("employee-session-auth", ...)` bypass point (if the redesigned login
  resolves a session by bearer token before a tenant is chosen, the same shape as
  `api-key-auth`) would first be introduced and documented in the three places CLAUDE.md
  requires (`db.ts`, `tenant-context.ts`, CLAUDE.md itself) — not before it's actually needed.
- **Biometric/WebAuthn** (Wave 3). The credential-type enum reserves the slot; no WebAuthn
  dependency, registration ceremony, or device-credential storage exists yet.
- **Device binding, shift tracking, and the audit log UI** (Waves 4–7) — all depend on sessions
  actually being minted through this table first.
- **`team-service.ts`'s `removeMembership`** stripping `employee_credentials`/`employee_sessions`
  on deactivation, the way it already strips `pin_hash`/`password_hash`/`platform_user_id`. Since
  nothing reads these tables for authentication yet, a removed member's still-`active` credential
  row is inert today — but this must land before or alongside Wave 2's login wiring, not after.
  Tracked as a Wave 2 prerequisite below, not fixed in this wave to keep its diff isolated to new
  tables plus one new service module.

## Decisions

- **`employees` is an extension table, not a replacement.** The issue's entity list
  (`employees`, `employee_credentials`, `employee_sessions`) could be read as "replace `users`."
  Given `users` is referenced by dozens of FKs across every module (orders, ledger, audit log,
  invitations…), a rename/replace is a repo-wide migration with a blast radius far past one wave
  and no clear benefit yet — the new tables can supply everything the later waves need as a
  supplement. Revisit only if a concrete later wave needs `employees` to exist independently of a
  `users` row (none currently do).
- **Lazy creation over backfill.** A migration that inserts one `employees` row per existing
  `users` row would work, but ties this wave's correctness to every current deployment's data
  shape for no immediate benefit (nothing reads `employees` yet). `ensureEmployeeProfile()` is
  idempotent and cheap enough to call from every write path Wave 2 adds instead.
- **PIN validation stays owned by `team.ts`.** `employee-service.ts` imports `isValidPin` from
  `team.ts` rather than duplicating the four-digit rule — one rule, one place, even though it now
  has two calling modules.

## Where each exit criterion is satisfied (Wave 1 only — the phase's own exit criteria are Wave 8)

- Employee identity model, profile, credential management, session design — `migrations/0042_employee_identity.sql`,
  `src/lib/employee.ts`, `src/lib/employee-service.ts`.
- Roles and permissions — intentionally reused unchanged from Phase 13 (`src/lib/auth-edge.ts`'s
  `Role`, `src/lib/permissions.ts`); Wave 1 introduces no new role or permission.
- No damage to the current POS flow — verified by leaving `pin-login/route.ts`, `auth-edge.ts`,
  and `team-service.ts` untouched; `npm test`, `npm run test:db`, and `npx tsc --noEmit` all pass
  with the existing suite plus `employee.test.ts`.

## Scope — Wave 2: Login Experience Redesign

- **Name-then-PIN login.** `GET /api/auth/pin-login/roster` (public, business-scoped the same way
  `pin-login` itself resolves a business) lists the eligible cashier/waiter/kitchen members —
  name, role, and `employees.photo_url`, nothing else — for a new picker step in
  `src/app/login/page.tsx`; picking a name narrows the subsequent `POST /api/auth/pin-login` to
  that one row (`employeeId` in the body) instead of the previous bcrypt scan over every PIN-role
  member. A `PinPad` component (`src/components/auth/pin-pad.tsx`) is shared between this flow and
  the new lock screen (below). "Last used on this device" is a `localStorage` list
  (`pos:lastEmployees`) that only reorders the picker grid — device-local, never synced, not a
  security control.
- **`employee_sessions` actually gets minted.** Resolving Wave 1's open question 1: *alongside*,
  not *instead of*, the JWT. `pin-login/route.ts` now calls `ensureEmployeeProfile` +
  `createSession` (`employee-service.ts`) on every successful PIN match and carries the new
  row's id as `employeeSessionId` on the session payload (`auth-edge.ts`). `checkEmployeeSession`
  (`auth.ts`), structured exactly like `checkImpersonation`, re-checks that row on every request
  in `getSession()` and invalidates the session the moment it's revoked or expired — the JWT's own
  12-hour expiry is no longer the only way a PIN login ends. `logout/route.ts` revokes the row
  (best-effort) alongside clearing the cookie.
- **A sixth `withoutTenantScope` reason: `employee-session-auth`.** `checkEmployeeSession` runs
  before `enterTenantScope` in `getSession()`, the same timing constraint `checkImpersonation`'s
  `activeGrant` lookup already has — documented in `db.ts`, `tenant-context.ts`, and CLAUDE.md per
  the tenancy rules.
- **`removeMembership` revokes `employee_credentials`/`employee_sessions`.** Resolving Wave 1's
  open question 2: landed with Wave 2, in the same transaction that already strips
  `pin_hash`/`password_hash`. Before this wave the row was inert (nothing consulted it); now that
  `employee_sessions` is security-relevant, a removed member's still-active session/credential row
  would otherwise outlive their access.
- **Lock screen.** `POST /api/auth/verify-pin` (self-guarding, `src/app/api/api-guards.test.ts`)
  re-checks the *already-authenticated* caller's own PIN; `src/app/dashboard/lock-screen.tsx`
  (`LockProvider`/`LockButton`) shows a full-screen `PinPad` overlay for PIN-role members,
  gated by a per-tab `sessionStorage` flag. This is a client-side convenience — the underlying
  `pos_session` cookie never stops being valid while locked — not a new session boundary; see
  "Out of scope" below.

## Out of scope (this wave)

- **PIN verification still reads `users.pin_hash` directly**, not `employee_credentials`.
  Wave 1's credential table exists and is reachable through `employee-service.ts`, but nothing
  writes a real employee's PIN into it yet — migrating (or dual-writing) PIN storage into
  `employee_credentials` is deferred; it wasn't needed to make sessions revocable, which was this
  wave's actual goal, and folding a credential-storage migration into the same diff would have
  mixed two different kinds of risk.
- **The lock screen is not a security boundary.** No new session is minted or ended by locking —
  it only hides the screen behind a PIN prompt. A hard per-terminal timeout, forced re-auth after
  N minutes idle, or failed-attempt lockout is Waves 4/7 territory (Device Binding & Security,
  Admin Security Center) if the product ever needs it.
- **Biometric/WebAuthn** (Wave 3) and **device binding** (Wave 4) — untouched; the picker/PIN pad
  UI has room for a biometric prompt to slot in later, but nothing here calls WebAuthn.

## Decisions

- **"Alongside", not "instead of."** Cheaper to land incrementally and keeps `pin-login`'s
  existing JWT contract (and every downstream `getSession()` caller) unchanged in shape — only
  `employeeSessionId` is new, and it's optional so old tokens keep verifying.
- **PIN verification stays on `users.pin_hash`.** See "Out of scope" — switching the verification
  source is a separate, later change, not required for revocable sessions.
- **The employee picker is public, like `pin-login` itself already was.** It returns strictly
  name/role/photo — the same information a physical badge or a locker nameplate would show at a
  shared POS terminal — never a PIN or anything else from `employees`.

## Where each exit criterion is satisfied (Wave 2 only)

- Login experience redesign (name selection, PIN entry, last-used, employee photo, quick login) —
  `src/app/login/page.tsx`, `src/components/auth/pin-pad.tsx`,
  `src/app/api/auth/pin-login/roster/route.ts`.
- Secure lock screen — `src/app/dashboard/lock-screen.tsx`, `src/app/api/auth/verify-pin/route.ts`.
- Sessions are now genuinely revocable, not just schema — `src/app/api/auth/pin-login/route.ts`,
  `src/lib/auth.ts` (`checkEmployeeSession`), `src/app/api/auth/logout/route.ts`.
- Removed members lose employee credentials/sessions immediately — `src/lib/team-service.ts`
  (`removeMembership`).
- No damage to the current POS flow — the password-login path (`auth/login`) is untouched;
  `pin-login` stays backward compatible for any caller that still only sends a `pin` (no
  `employeeId`); `npm test` (794 tests), `npm run test:db` (246 tests, including
  `tenant-isolation.integration.test.ts`), `npx tsc --noEmit`, and `npm run build` all pass; the
  full picker → PIN → dashboard → lock → unlock flow was exercised in a browser against a seeded
  database.

## Scope — Wave 3: Biometric Authentication (WebAuthn)

- **`@simplewebauthn/server` (`src/lib/webauthn.ts`) and `@simplewebauthn/browser`** (login page,
  the new dashboard biometric panel) — the standard library pair for a WebAuthn relying party;
  hand-rolling attestation/assertion verification was never in scope. `webauthn.ts` wraps it the
  same way `team.ts` wraps `bcrypt`: no database access of its own, called into by
  `employee-service.ts`. It owns three things: RP ID/name/origin resolution (`WEBAUTHN_RP_ID`,
  `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` — one deployment is one domain, so one triple covers every
  business, the same reasoning `auth-edge.ts` already applies to sharing one `JWT_SECRET`),
  building registration/authentication options, and verifying what comes back.
- **Ceremony challenges are a signed token, not a table.** Every other credential/session in this
  phase gets a server-side row because it needs to be listable and revocable; a WebAuthn
  challenge is used within seconds and is worthless the moment it's consumed or its 2-minute TTL
  passes. `signChallenge`/`verifyChallenge` (`webauthn.ts`) sign it into a short-lived JWT (same
  `JWT_SECRET`, same `jose` machinery as `auth-edge.ts`'s session token, with its own `purpose`
  claim so a login challenge can't complete a registration or vice versa) that the caller hands
  back unmodified on the ceremony's second step — no new table, no new tenancy bypass.
- **`migrations/0043_employee_webauthn_credentials.sql`** adds what Wave 1's `secret_hash` column
  can't hold — `webauthn_credential_id`, `webauthn_public_key`, `webauthn_sign_count`,
  `webauthn_transports` — plus a type-shape check constraint (a `'webauthn'` row has no
  `secret_hash`; every other type still requires one) and narrows Wave 1's "one active credential
  per (employee, type)" index to exclude `'webauthn'` (see Decisions below).
- **`employee-service.ts`'s new WebAuthn section** (`beginWebauthnRegistration`/
  `completeWebauthnRegistration`, `beginWebauthnAuthentication`/`completeWebauthnAuthentication`,
  `listWebauthnCredentials`) — a parallel path alongside `issueCredential`/`verifyCredential`, not
  a caller of them (see the Decisions entry below on why). `revokeCredential` gained an optional
  `ownerEmployeeId` so a self-service revoke can't be pointed at another employee's credential id.
- **Registration — self-service, authenticated.** `POST /api/auth/webauthn/register/options` and
  `.../verify`, `GET /api/auth/webauthn/credentials`, `DELETE /api/auth/webauthn/credentials/[id]`
  — all guarded to the caller's own PIN-role session (`cashier`/`waiter`/`kitchen`, the same
  audience as the Wave 2 lock screen), always operating on `session.sub`. A new sidebar panel
  (`src/app/dashboard/biometric-settings.tsx`, "ورود بیومتریک") lists an employee's registered
  authenticators and lets them add or remove one — deliberately not under `/dashboard/settings`,
  whose tabs are all owner/manager-permission-gated (`settings-tabs.ts`); this is each employee
  managing their own credential.
- **Login — public, mirrors `pin-login`.** `POST /api/auth/webauthn/login/options` and
  `.../verify` take the same `employeeId` the Wave 2 picker already resolves before offering PIN,
  so this never needs an unscoped, discoverable-credential ("usernameless") WebAuthn flow. A
  successful assertion mints an `employee_sessions` row and the same `pos_session` JWT
  `pin-login` would (`employeeSessionId` included, `checkEmployeeSession` re-checks it exactly as
  it does for a PIN login) — biometric is a different way to prove identity, not a different kind
  of session. `loginRoster` now returns a `hasWebauthn` flag per employee so the login page only
  offers the biometric button where it can succeed; `pin-login/roster`'s "name/role/photo only"
  boundary now includes this one extra boolean, still nothing about which secret is behind it.
  Added to `middleware.ts`'s `PUBLIC_PATHS` and `AUTH_RATE_LIMITED_PATHS` the same way
  `pin-login`/`pin-login/roster` already are.

## Out of scope (this wave)

- **PIN verification is untouched.** `users.pin_hash` stays the credential for PIN login; Wave 3
  neither dual-writes a PIN into `employee_credentials` nor migrates it there (see Decisions —
  this resolves Wave 2's first open question).
- **Device binding** (Wave 4) — the login picker still has no server-side notion of "this
  terminal"; `hasWebauthn` is per-employee, not per-device, so a terminal without that employee's
  registered authenticator still offers the biometric button (and the ceremony simply fails,
  falling back to the PIN pad) rather than hiding it. Narrowing that is still Wave 4's job.
- **Shift tracking and the audit log UI** (Waves 5–7) — untouched.
- **Owner/manager/accountant self-service biometric.** Registration and the biometric login
  button are both scoped to PIN roles only, matching the lock screen's existing boundary — a
  password-role member's login flow is untouched.

## Decisions

- **A parallel path, not a shared one, alongside `issueCredential`/`verifyCredential`.** Those
  two are built around a bcrypt-hashed shared secret: the caller presents the same value back,
  it's compared with `bcrypt.compare`. A WebAuthn credential is an asymmetric keypair — nothing
  secret is ever presented back, a signed challenge is instead verified against a stored *public*
  key — so it doesn't fit that shape at all, not even by relaxing `ISSUABLE_CREDENTIAL_TYPES`.
  Reusing the table (via new nullable columns) while giving WebAuthn its own
  begin/complete functions was cheaper and clearer than bending the bcrypt-shaped functions to
  cover a case they were never designed for.
- **`'webauthn'` rows only; PIN stays on `users.pin_hash` indefinitely — Wave 2's first open
  question, resolved.** Dual-writing a PIN into `employee_credentials` alongside `users.pin_hash`
  was the other option Wave 2 left open; it wasn't needed to make biometric login work, and
  mixing "migrate PIN storage" into this wave's diff would have mixed two different kinds of risk
  the same way Wave 2 declined to for the identical reason. Revisit only if a concrete later wave
  actually needs `employee_credentials` to be PIN's system of record.
- **Multiple concurrent active `'webauthn'` credentials per employee, unlike PIN's "one active at
  a time."** Wave 1's uniqueness index applied to the whole `credential_type` enum, which is right
  for a single shared PIN but wrong here: a POS runs on several shared terminals per branch, and
  an employee who works more than one needs a separate registered authenticator (that terminal's
  own fingerprint/face reader) per terminal, live at once. Migration 0043 narrows the index to
  exclude `'webauthn'` rather than carrying the one-PIN-at-a-time constraint over by accident.
- **A signed challenge token, not a challenge table.** See Scope above — nothing later needs to
  list or revoke an in-flight ceremony, so giving it a row would have been infrastructure with no
  caller. The existing `JWT_SECRET`/`jose` machinery already does exactly what's needed (signed,
  time-limited, tamper-evident) with a `purpose` claim standing in for `auth-edge.ts`'s `realm`
  claim to keep a login challenge from completing a registration.
- **No new `withoutTenantScope` bypass.** Both login-ceremony routes resolve the business through
  `resolveLoginBusinessId` (Wave 2's existing `"login"` reason) before doing anything else, the
  same as `pin-login` itself — every WebAuthn query then runs inside the resulting `withTenant`,
  same as `pin-login`'s own DB work. Nothing here reads or writes before a tenant is chosen.

## Verification

`npx tsc --noEmit`, `npm test` (810 tests, including new `webauthn.test.ts` coverage of the
ceremony-challenge token's sign/verify round trip, purpose/employee/business mismatch rejection,
and TTL boundary), `npm run test:db` (246 tests, unchanged — no new tenant-scoped table, so
`tenant-isolation.integration.test.ts` needed no update), and `npm run build` all pass. The full
flow was exercised against a live dev server and a real (CTAP2) authenticator: Chrome DevTools
Protocol's virtual-authenticator support drove an actual `navigator.credentials.create`/`.get`
ceremony (real challenge, real signature, real server-side verification — not a mocked response)
through the seeded cashier — PIN login, registering a biometric credential from the new dashboard
panel, logging out, and logging back in with only the biometric prompt, no PIN.

## Open questions for Wave 4

1. The employee picker still has no server-side awareness of "this device" beyond the
   business/location query params — Wave 4 (Device Binding) will presumably want a registered
   device identity the picker can use to narrow the roster further, rather than showing every
   PIN-role member's biometric option at every terminal regardless of which terminal actually
   holds their registered authenticator.
2. `employee_sessions.credential_id` now sometimes points at a `'webauthn'` row instead of a
   `'pin'` one (`createSession`'s `credentialId` input, wired through the new login route) — Wave
   6/7's audit trail and admin security center should surface *which kind* of credential opened a
   session, not just that one did.

## Status: in progress — Wave 3 (biometric authentication) submitted for review
