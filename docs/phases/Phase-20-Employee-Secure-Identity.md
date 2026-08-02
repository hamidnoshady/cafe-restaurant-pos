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
are met") is not fully satisfied here: Phase 19 is still in progress (Wave 1 merged, Wave 2 open
for review as of this wave's start) rather than complete. Issue #107 explicitly requested Phase
20 work now, and this wave was scoped to avoid any dependency on Phase 19 finishing —
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

## Open questions for Wave 2

1. Does the redesigned login mint an `employee_sessions` row *instead of* the JWT, or *alongside*
   it (JWT stays the bearer credential in the cookie; the DB row exists purely so it can be
   listed/revoked, checked on each request the way impersonation grants are)? The "alongside"
   shape is cheaper to land incrementally and matches the impersonation-grant precedent
   (`checkImpersonation()` in `src/lib/auth.ts`) most closely.
2. Should `removeMembership` (team-service.ts) revoke `employee_credentials`/`employee_sessions`
   as part of its existing deactivation transaction ahead of Wave 2, or is it acceptable to land
   alongside Wave 2's login wiring since nothing consults these tables for authentication until
   then? Leaning toward landing it with Wave 2, in the same PR that first makes these tables
   security-relevant.

## Status: in progress — Wave 1 (employee identity foundation) submitted for review
