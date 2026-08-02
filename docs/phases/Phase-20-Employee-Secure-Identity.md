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

## Open questions for Wave 3

1. Biometric/WebAuthn registration needs a real credential to attach to — does it dual-write into
   `employee_credentials` alongside `users.pin_hash` (finally giving that table a live PIN row
   too), or only ever store `'webauthn'` rows there while PIN stays on `users` indefinitely?
2. The employee picker currently has no server-side awareness of "this device" beyond the
   business/location query params — Wave 4 (Device Binding) will presumably want a registered
   device identity the picker can use to narrow the roster further, rather than showing every
   PIN-role member at every terminal.

## Status: in progress — Wave 2 (login experience redesign) submitted for review
