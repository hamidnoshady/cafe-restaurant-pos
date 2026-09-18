# Phase 20 — Employee Secure Identity, Biometric Authentication & Audit Security

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 13 (Teams & Permissions — the `users`/role/permission model this phase
extends), Phase 14 (multiple branches per business — session/device scoping needs a location).
**Goal:** Replace the shared-device PIN pad's implicit trust (any 4-digit match on a business is
"good enough") with a real per-employee identity: a persisted, revocable session instead of a
bare stateless JWT, a credential model that can grow past PIN into biometric/WebAuthn without a
schema change, and — starting in a later wave — every sensitive POS action attributable to one
person with a queryable audit trail. Tracked by GitHub issue #107, staged as eight waves; this
phase's exit criteria are met as of Wave 8 (see that wave's own section below).

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

## Scope — Wave 4: Device Binding & Security

- **`pos_devices`** (`migrations/0044_pos_devices.sql`) — a registered POS terminal identity,
  modeled on `employee_sessions`: a bearer token, hash-only storage (`src/lib/device.ts`'s
  `generateDeviceToken`/`hashDeviceToken`, prefix `posdev_`), revocable. Paired once from an
  already-authenticated owner/manager dashboard session (`POST /api/devices`,
  `PERMISSIONS.settingsManage` — the same gate as printers/menu/tax), bound to whichever branch
  the pairing caller is currently scoped to (`resolveActiveLocation`). The plaintext token is
  returned exactly once and the client stores it in `localStorage` (`pos:deviceToken`) — same
  origin as `/login`, so the same browser reads it back there after logging out.
- **`employee_credentials.device_id` and `employee_sessions.device_id`** (both added by the same
  migration) — resolves Wave 3's first open question. A webauthn credential registered while a
  device token is present (`completeWebauthnRegistration`'s new `deviceId` parameter) is bound to
  that terminal; a session opened while one is present (`createSession`'s new `deviceId`) records
  which terminal it came from. Both are nullable and default to unbound — see Decisions below for
  why that's the correct default, not a gap.
- **`src/lib/device-service.ts`** — `pairDevice`, `listDevices`, `revokeDevice` (see Decisions for
  what revoking a device does and does not cascade to), and `resolveDeviceId(token, businessId)`,
  the read path every public route below calls with whatever `deviceToken` the client sent.
  Deliberately needs no `withoutTenantScope` bypass: pairing always runs inside an authenticated
  session's own tenant scope, and resolving a token during login runs inside the `withTenant`
  block `resolveLoginBusinessId` (the existing `"login"` reason) already opened once the business
  was identified some other way (slug/`businessId`) — the device token itself never has to name
  its own business.
- **Narrowing, wired through every place Wave 2/3 offered a biometric option**:
  `loginRoster`'s `hasWebauthn`, `beginWebauthnAuthentication`'s offered credentials, and
  `completeWebauthnRegistration`'s stored `device_id` all take an optional `deviceId` resolved by
  the route from a `deviceToken` the client sent (`pin-login/roster`'s query string;
  `pin-login`/`webauthn/login/options`/`webauthn/login/verify`/`webauthn/register/verify`'s JSON
  bodies). The one function deliberately **not** device-filtered is
  `completeWebauthnAuthentication` — see Decisions.
- **`src/app/(app)/settings/device-settings.tsx`** ("دستگاه‌های ثبت‌شده" tab, added to
  `settings-tabs.ts` next to the other `settingsManage`-gated tabs) — pairs the browser it is
  opened in and lists, renames, or revokes every device paired for the business, across branches.
- **`src/lib/device-token.ts`** owns the shared `pos:deviceToken` browser storage contract, used
  by the Settings screen, `src/app/login/login-form.tsx`, and `biometric-settings.tsx`; absent on
  every terminal that was never paired, it is passed along on roster/login/registration calls.

## Out of scope (this wave)

- **Pairing is not itself an authentication ceremony.** A device token proves "this browser was
  shown a `settingsManage`-gated screen once", not an employee's identity — see Decisions on why
  it deliberately isn't treated as one anywhere in the request path.
- **No pairing-code / remote-exchange flow.** A terminal is paired by an already-authenticated
  admin sitting at it, the same trust model the printer/tax/menu settings tabs already use for
  "configure this branch's hardware" — a QR-code or short-code flow for pairing a terminal
  someone isn't physically at wasn't needed for this wave's goal and would be a second, riskier
  mechanism to reach the same `pos_devices` row.
- **Shift tracking and the audit log UI** (Waves 5–7) — untouched; `employee_sessions.device_id`
  and `pos_devices` exist for Wave 6/7 to read from, not yet surfaced anywhere but the new
  Settings tab.
- **Revoking a device does not revoke the webauthn credentials registered from it** — see
  Decisions.

## Decisions

- **A device token narrows a public UI's choices; it is never a security boundary.** Every other
  credential/session in this phase (PIN, webauthn, `employee_sessions`) proves *who* is acting.
  `pos_devices` proves nothing about a person — it only lets the login picker prefer the roughly
  right subset of webauthn credentials to *offer*. This is why `completeWebauthnAuthentication`
  (Wave 3, unchanged) is deliberately not device-filtered: the authenticator's signature over the
  challenge is the entire security boundary at that step, and second-guessing an already-verified
  cryptographic proof against a bookkeeping column would be worse than not checking it at all. It
  is also why a leaked/guessed device token's worst case is "the login picker shows a biometric
  button that will fail, falling back to the PIN pad" — never an authentication bypass.
- **Never-widening: an unresolvable or absent device token degrades to Wave 3's behaviour, not an
  error.** `resolveDeviceId` returns `null` for a missing, unrecognised, or revoked token, and
  every SQL filter downstream (`$n::uuid IS NULL OR device_id = $n OR device_id IS NULL`) treats
  `null` as "apply no filter" — so a business that never pairs a single device sees zero change
  from this wave, and a credential registered before Wave 4 (`device_id IS NULL`) stays visible on
  every terminal exactly as it always was. Narrowing only ever kicks in for a credential that was
  *itself* bound to a *specific, still-valid* paired device.
- **Revoking a device cascades to its sessions, not to its credentials.** A compromised or
  decommissioned terminal should immediately stop being able to act as anyone who was signed in on
  it — the same "revocation takes effect immediately" property Wave 2 gave `employee_sessions`
  itself — so `revokeDevice` also revokes every still-active session with a matching `device_id`.
  It does not touch `employee_credentials`: losing the device record doesn't leak or weaken the
  authenticator's private key (never held by the server), so the employee's registered biometric
  credential is exactly as safe as it was before, and forcing them to re-register on a replacement
  terminal for no cryptographic reason would just be friction. An admin who genuinely suspects a
  specific credential is compromised still has `DELETE /api/auth/webauthn/credentials/[id]`
  (Wave 3) for that.
- **Pairing is owner/manager-gated (`settingsManage`), not self-service.** Unlike a PIN or a
  webauthn credential — which belong to the employee using them — a device identity belongs to
  the *terminal*, a piece of business hardware, matching printers/tax/menu's existing gate rather
  than the employee-scoped biometric panel's.

## Verification

`npx tsc --noEmit`, `npm test` (815 tests, including new `device.test.ts` coverage of
`generateDeviceToken`/`hashDeviceToken` mirroring `employee.test.ts`'s session-token tests, and an
updated `settings-tabs.test.ts` for the new tab), `npm run test:db` (246 tests — `pos_devices`
picked up automatically by `tenant-isolation.integration.test.ts`'s live-schema RLS scan, no test
file changes needed), and `npm run build` all pass. Exercised end-to-end against a live dev server
and a seeded business: paired two devices from Settings → دستگاه‌های ثبت‌شده (one via `curl`
against the raw API, one through the actual UI in a headless browser, confirming the token lands
in `localStorage` and the paired/revoked list renders correctly); inserted a webauthn credential
bound to the first device and confirmed `pin-login/roster`'s `hasWebauthn` and
`webauthn/login/options` correctly include it when queried with that device's token, exclude it
when queried with the second device's token, and include it (unnarrowed) when queried with no
token at all; PIN-logged in with the first device's token and confirmed the resulting
`employee_sessions` row was stamped with that `device_id`; revoked the device as owner and
confirmed the session was immediately revoked (`/api/auth/me` returned 401) while the webauthn
credential stayed active, exactly as designed.

## Scope — Wave 5: Shift Tracking

- **`employee_shifts`** (`migrations/0045_employee_shifts.sql`) — the real till/clock-in entity
  Phase 8's `v_shift_reconciliation` never had (see that view's own comment: "a proxy... there's no
  till/clock-in entity in the schema yet"). An employee opens a shift, optionally counting a
  starting cash float, and closes it later, optionally counting the drawer — the same self-service
  shape Wave 2 gave sessions and Wave 3 gave biometric credentials. `location_id`/`device_id` are
  copied from the `employee_sessions` row open at the moment the shift starts (Wave 1's session,
  carrying Wave 4's device binding since last wave) rather than re-resolved from a device token —
  resolving this doc's own Wave 4 open question 2 without introducing any new device-token
  plumbing into the already-authenticated dashboard routes this wave adds. A partial unique index
  enforces at most one open shift per employee at a time.
- **`src/lib/shift.ts`/`shift-service.ts`** — the same pure/DB-touching split every earlier wave
  used. `shift.ts` owns `shiftStatus` (open ⇔ no `ended_at`, the same "timestamp instead of an
  enum" shape orders/table_sessions already use) and `reconcileCash` (expected cash = opening float
  + cash sales; variance = counted − expected), unit-tested in `shift.test.ts`.
  `shift-service.ts` owns `openShift`/`closeOwnShift`/`closeShiftById`/`listShifts` and
  `shiftCashSummary` — the last one reads a shift's sales back on demand by joining
  `orders.closed_by`/`closed_at` against the shift's own `[started_at, ended_at]` window, exactly
  the join `v_shift_reconciliation` already does per business-day, just narrowed to one shift's
  actual window instead of a whole calendar day. No new column on `orders`, no change to
  `order-service.ts` — see Decisions below for why that's deliberate.
- **Self-service clock-in/out** — `POST /api/shifts/start`, `POST /api/shifts/end`,
  `GET /api/shifts/active`, guarded the same way the lock screen and biometric-settings panel are
  (`requireRole("cashier", "waiter", "kitchen")`, always acting on `session.sub`). A new sidebar
  button (`src/app/dashboard/shift-panel.tsx`'s `ShiftButton`, next to the biometric/lock buttons)
  shows "شروع شیفت"/"پایان شیفت" and a small modal for the optional float.
- **Admin review** — `GET /api/shifts` (shift history, most recent first) and
  `POST /api/shifts/[id]/close` (force-closing a shift an employee left open), gated on
  `team.manage` — the same permission `PUT /api/team/[id]/credentials` already requires to act on
  someone else's PIN, since reviewing or force-closing a shift is the same kind of "act on this
  employee's own security state" action. A new Settings tab, **"شیفت‌ها"** (`shift-history-settings.tsx`,
  `settings-tabs.ts`), lists every shift and lets an owner/manager close a stuck-open one.
- **`removeMembership` closes an open shift.** Extending the same "strip everything active"
  transaction Wave 2 gave `employee_credentials`/`employee_sessions`: a removed member's still-open
  shift would otherwise stay open forever now that nothing else about their access is still live.

## Out of scope (this wave)

- **No new column on `orders`, no change to `order-service.ts`.** A shift's sales are read back on
  demand (see `shiftCashSummary` above) rather than stamped onto each order as it's created/closed
  — the single riskiest, most heavily regression-tested surface in the codebase
  (`order-concurrency.integration.test.ts`) stays untouched by this wave, exactly the isolation
  Wave 1 kept for `employee_sessions` and Wave 4 kept for `pos_devices`.
- **`v_shift_reconciliation` (Phase 8) is untouched.** The Phase 8 doc already flagged that this
  view "will need a real `shift_id` join if [a real shift entity] ever lands, but the report itself
  doesn't change shape" — true, but rewriting a report view that's been live since Phase 8 is a
  separate, independently reviewable change from adding the entity itself, not required to make
  clock-in/out work today. Deferred rather than folded into this diff.
- **No hard shift-length limit, forced auto-close, or idle timeout.** A shift stays open until the
  employee ends it or an admin force-closes it — no cron, no expiry. The same territory Wave 2
  explicitly left to "Waves 4/7... if the product ever needs it" for the lock screen; nothing so far
  has needed it for shifts either.
- **Waiter/kitchen shifts track no cash float by design choice, not by restriction.** Any PIN role
  may open a shift with `openingFloat` omitted — the API and UI never require one — so a shift is
  as much "I am on the floor right now" as it is a till count; only a cashier who chooses to count
  in gets a reconciliation at close time.
- **The audit log and admin security center** (Waves 6/7) — a shift's `shift.opened`/`shift.closed`
  audit rows exist (this wave writes them, matching every other identity table's pattern) but
  nothing surfaces them anywhere but the raw `audit_log` table yet.

## Decisions

- **A shift's location/device come from its opening session, not a re-resolved device token.**
  Every other narrowing in this phase (Wave 3's `hasWebauthn`, Wave 4's credential/session
  filtering) is a *public, pre-authentication* route reading `pos:deviceToken` from `localStorage`
  because no session exists yet to ask instead. Clock-in/out routes are the opposite: always
  already-authenticated, so the session's own `device_id` (stamped at login by Wave 4) is strictly
  more trustworthy than a token the browser might present again, and needs zero new plumbing.
- **Cash sales are joined on demand, not stamped onto orders.** See "Out of scope" above — the
  alternative (an `orders.shift_id` column, populated by `order-service.ts` at order-open/close
  time) would give a shift its sales "for free" at the cost of touching the codebase's most
  carefully concurrency-tested module for a wave whose actual goal is clock-in/out, not order
  attribution. `shiftCashSummary`'s join is read-only and gets the same answer
  `v_shift_reconciliation` already trusts for its own per-business-day version of this question.
- **Force-close is `team.manage`, not `settings.manage`.** Device pairing (Wave 4) is
  `settings.manage` because a device belongs to the business's hardware, not to any one employee.
  A shift belongs to the employee who opened it — force-closing one is an action *on that
  employee*, the same shape `PUT /api/team/[id]/credentials`'s force-reset already has, so it gets
  the same gate.
- **A shift's own state is `ended_at IS NULL`, not an enum column.** Matches `orders`/
  `table_sessions`'s existing `opened_at`/`closed_at` shape rather than introducing a `status`
  column and a second source of truth for the same fact.

## Where each exit criterion is satisfied (Wave 5 only)

- Shift/clock-in tracking, cash float reconciliation — `migrations/0045_employee_shifts.sql`,
  `src/lib/shift.ts`, `src/lib/shift-service.ts`.
- Self-service clock-in/out — `src/app/api/shifts/start/route.ts`, `.../end/route.ts`,
  `.../active/route.ts`, `src/app/dashboard/shift-panel.tsx`.
- Admin review and force-close — `src/app/api/shifts/route.ts`, `.../[id]/close/route.ts`,
  `src/app/dashboard/settings/shift-history-settings.tsx`.
- Removed members lose their open shift immediately, same as their credentials/sessions —
  `src/lib/team-service.ts` (`removeMembership`).
- No damage to the current POS flow — `orders`, `order-service.ts`, `payments`, and every existing
  login/session/credential/device path are untouched; `npx tsc --noEmit`, `npm test` (829 tests,
  including new `shift.test.ts` coverage of `shiftStatus`/`isValidCashFloat`/`reconcileCash`), and
  `npm run test:db` (246 tests — `employee_shifts` picked up automatically by
  `tenant-isolation.integration.test.ts`'s live-schema RLS scan, same as `pos_devices` in Wave 4, no
  test file changes needed) all pass.

## Verification

`npx tsc --noEmit`, `npm test`, `npm run test:db`, and `npm run build` all pass (see exit-criteria
counts above). Exercised end-to-end against a live dev server and a seeded business: a cashier
clocked in with a ۳۰۰,۰۰۰ toman opening float from the new sidebar button; a cash-paid order closed
during the shift; the running `/api/shifts/active` cash summary reflected it immediately; clocking
out with a matching closing count produced zero variance, and a deliberately short/long count
produced the correct positive/negative variance. Starting a second shift while one was already open
correctly returned `shift_already_open` (409). As owner: the new "شیفت‌ها" settings tab listed every
shift with floats and status; force-closing a still-open shift with no float produced
`reconciliation: null` (no baseline to compare against) exactly as designed; a cashier's `GET
/api/shifts` request correctly returned `forbidden` (403). Removing a member with a still-open
shift closed it in the same transaction as their credentials/sessions, confirmed against the raw
`employee_shifts` row.

## Scope — Wave 6: Audit Trail

- **`audit_log` (Phase 0) finally gets a reader.** Every wave of this phase — and
  `team-service.ts`/`branch-service.ts` from earlier phases — has been writing to this table since
  before Phase 20 started; nothing had ever read it back for a human until this wave. No migration
  is needed: the table and its RLS policy (migration 0021) already exist and already cover every
  business, so this wave is purely additive — a reader plus one new writer (below).
- **`employee_sessions` creation is now itself audited.** Every earlier wave only audited
  *revocation* (`employee.session_revoked`) — a successful login never produced a row at all.
  `createSession` (`employee-service.ts`) now writes an `employee.session_created` row alongside the
  session itself, with `{ sessionId, credentialId, deviceId }` in its payload — the same two ids
  `pin-login`/`webauthn/login/verify` already pass into `createSession`, just carried one step
  further into the audit trail instead of being dropped.
- **`src/lib/audit.ts`/`audit-service.ts`** — the same pure/DB-touching split every wave of this
  phase uses. `audit.ts` owns Persian labels for known `action`/`entity` strings (falling back to
  the raw value for anything it doesn't recognise — the same tolerant-of-unknowns posture
  `effectivePermissions` already takes for a permission key a later release removed) and
  `credentialKindFromId`, unit-tested in `audit.test.ts`. `audit-service.ts` owns `listAuditLog` —
  business-wide, most recent first, optionally filtered by `entity`/`actorId`/a `before` cursor.
- **Resolving this doc's own Wave 5 open question 1.** `listAuditLog`'s query joins
  `employee_credentials`/`pos_devices` live, keyed off the `credentialId`/`deviceId` embedded in an
  `employee.session_created` row's payload, and returns `credentialType`/`deviceLabel` alongside
  every entry — resolved at *read* time rather than duplicated into the payload at write time, the
  same "read back on demand, don't duplicate" choice Wave 5 made for a shift's cash summary. A
  credential that's since been revoked or a device that's since been renamed is reflected correctly
  because nothing was ever copied.
- **`GET /api/audit-log`** — gated on `team.manage`, the same permission Wave 5's shift-history
  review tab uses, since reviewing every employee/session/device/shift security event is the same
  kind of "act on this business's security state" concern as force-closing a shift or resetting
  someone else's PIN. Business-wide across every branch, like `/api/devices` and `/api/shifts`
  already are.
- **A new Settings tab, "گزارش حسابرسی"** (`audit-log-settings.tsx`, `settings-tabs.ts`) — lists
  recent events with an entity filter (employee/team/device/shift/location), the actor's name, a
  Persian action label, and — for a login event — which credential kind and, if the terminal was
  paired (Wave 4), which device's label.

## Out of scope (this wave)

- **Only Wave 5's first open question is resolved.** Open questions 2 (a cheaper per-row cash
  summary for shift history) and 3 (per-order shift attribution) are unrelated to the audit trail
  and are carried forward to Wave 7 below, unaddressed.
- **No failed-login logging.** Only a successful `createSession` call produces an
  `employee.session_created` row; a wrong PIN or a failed biometric assertion writes nothing. Wave
  3's rate limiter (`AUTH_RATE_LIMITED_PATHS`) already bounds brute-force attempts at the HTTP
  layer — surfacing failed attempts *as audit history* (for an admin security center to flag, say, a
  terminal with repeated failures) is a distinct, bigger feature than "read back what's already
  written," and is left to Wave 7 if the product needs it.
- **No pagination UI, only a `before` cursor in the API.** `listAuditLog` accepts one so a later
  wave's admin security center can page through a long history without changing the read path again;
  this wave's Settings tab only ever requests the most recent page (default 50, max 200), matching
  how thin Wave 5's own shift-history tab was kept.
- **The admin security center itself** (Wave 7) — this wave is a read-only log, not a dashboard;
  active-session listing (`listActiveSessions` in `employee-service.ts`, written in Wave 1 but still
  unreachable through any route) and any at-a-glance security summary stay Wave 7's job.

## Decisions

- **A write-side audit call, not a read-side reconstruction.** The alternative to instrumenting
  `createSession` would have been inferring "a login happened" from `employee_sessions.issued_at`
  directly rather than adding an `audit_log` row for it — rejected because every other security
  fact in this phase (credential issuance/revocation, session revocation, device pairing, shift
  open/close) already goes through `audit_log`, and a login is exactly as security-relevant as a
  session's *revocation* already was. One table, one query, one place `listAuditLog` has to look.
- **Credential kind and device label are resolved live, not stored at write time.** See Scope above
  — storing a denormalized `credentialType`/`deviceLabel` string in the payload at login time would
  drift the moment that credential was revoked or that device relabeled/repaired, the same staleness
  risk Wave 5 avoided by reading a shift's cash summary back from `orders`/`payments` on demand
  instead of stamping it onto the shift row.
- **`team.manage`, not a new permission.** A dedicated `audit.view` permission was considered and
  rejected: every action this wave's log surfaces was already produced by a `team.manage`-gated
  action (PIN reset, force-close, device pairing under `settings.manage`) or by the login path
  itself, so the audience able to review this history is already exactly the audience Wave 5 already
  gated shift review to. Introducing a second, overlapping permission for the same reviewers would
  be configuration surface with no real access-control benefit.
- **Unknown actions/entities degrade to their raw string, never hidden.** `auditActionLabel`/
  `auditEntityLabel` fall back to the value itself rather than throwing or omitting the row — a
  business on an older or newer app version than whoever last touched this file must still see every
  row, just with a less-polished label, matching `effectivePermissions`'s existing tolerance for an
  override naming a permission that no longer exists.
- **No new `withoutTenantScope` bypass.** `audit_log` (and the two tables `listAuditLog` joins
  against) were already tenant-scoped tables before this wave; every read runs inside the caller's
  own `withTenantScope`/`requirePermission` session, the same as `/api/shifts` and `/api/devices`.

## Where each exit criterion is satisfied (Wave 6 only)

- Audit trail, readable — `src/lib/audit.ts`, `src/lib/audit-service.ts`,
  `src/app/api/audit-log/route.ts`, `src/app/dashboard/settings/audit-log-settings.tsx`.
- Login events are now part of the audit trail, not just revocation — `src/lib/employee-service.ts`
  (`createSession`).
- Wave 5's first open question resolved (which credential kind and device opened a session) —
  `src/lib/audit-service.ts`'s `listAuditLog` join.
- No damage to the current POS flow — no schema change, `pin-login`/`webauthn` login routes
  unchanged in shape (`createSession`'s existing inputs are simply also audited now); `npx tsc
  --noEmit`, `npm test` (838 tests, including new `audit.test.ts` coverage of the action/entity
  label fallback and `credentialKindFromId`), and `npm run test:db` (246 tests, unchanged — no new
  tenant-scoped table, so `tenant-isolation.integration.test.ts` needed no update) all pass.

## Verification

`npx tsc --noEmit`, `npm test`, `npm run test:db`, and `npm run build` all pass (see exit-criteria
counts above). Exercised end-to-end against a live dev server and a seeded business: a cashier's PIN
login produced an `employee.session_created` row that the new "گزارش حسابرسی" Settings tab showed as
"با پین" with no device; pairing a device and inserting a webauthn-credentialed session showed the
same event as "با بیومتریک از دستگاه «صندوق ۱»", confirming the live join resolves both
`credentialType` and `deviceLabel` correctly; filtering the tab to "دستگاه" correctly narrowed the
list to just the device-pairing event; a cashier's own `GET /api/audit-log` request correctly
returned `forbidden` (403), matching the same `team.manage` gate shift history already has.

## Scope — Wave 7: Admin Security Center (sessions & failed logins)

The issue frames Waves 7–8 together as "the admin security center." This wave builds its core —
everything an owner/manager needs to see and act on *right now* — by resolving three of Wave 6's
four open questions; the fourth (per-order shift attribution) was never part of the security
center and stays carried forward below, unaddressed by design (see that question's own wording).

- **Business-wide active-session review, with revoke.** Resolves open question 4:
  `listActiveSessions` (`employee-service.ts`, Wave 1) has existed since Wave 1 but was never
  reachable through any route. `listActiveSessionsForBusiness` (`employee-service.ts`) is its
  business-wide counterpart — every employee currently signed in, on which device, most recent
  first — joined the same way `listShifts`/`listAuditLog` already are. `GET /api/sessions` and
  `DELETE /api/sessions/[id]` expose it, `team.manage`-gated like every other "act on this
  business's security state" surface this phase has added (shift force-close, audit review,
  device pairing). The `DELETE` reuses `revokeSession` (Wave 1/2) unchanged — it already revokes
  by `(sessionId, businessId)` with no owner check, the correct shape for an admin acting on
  someone else's session, and `employee_sessions` is only ever minted for PIN-role members, so
  there's no owner/manager session here an admin could accidentally revoke out from under
  themselves.
- **Failed login attempts are now audited.** Resolves open question 3: `auditLoginFailure`
  (`employee-service.ts`) writes an `employee.login_failed` row — no actor (nothing was
  authenticated), `entity_id` set to the attempted `employeeId` when the caller named one (the
  Wave 2 picker or a webauthn ceremony always does; a bare legacy PIN scan may not) — called from
  `pin-login/route.ts`'s `!user` branch and `webauthn/login/verify/route.ts`'s two failure
  branches (a failed assertion; a verified assertion for an employee who's since gone inactive).
  Both routes already run inside their own `withTenant(businessId, …)` block, so this needs no new
  `withoutTenantScope` reason — same as every other write this phase has added.
- **`listAuditLog` gained two small, general read-side capabilities** rather than one
  narrow one, since both were nearly free given the existing join shape: an `action` filter (so
  the security center's failed-attempts list doesn't have to pull the whole `entity = 'employee'`
  stream and filter client-side), and an `entityName`, resolved live off `entity_id` the same way
  `credentialType`/`deviceLabel` are already resolved off `payload` — the only way to say *whose*
  failed attempt one was, since `employee.login_failed` rows carry no actor.
- **A new Settings tab, "مرکز امنیت"** (`security-center-settings.tsx`, `settings-tabs.ts`,
  `team.manage`-gated) — active sessions with an "پایان نشست" button, and the twenty most recent
  failed attempts. Deliberately not a replacement for the "گزارش حسابرسی" tab (Wave 6): that one
  is the full, filterable history of every security event including these same sessions' own
  creation/revocation; this one is the actionable subset an owner actually needs to glance at.
- **Shift cash variance, pre-aggregated.** Resolves open question 1 (carried since Wave 5):
  `listShifts` (`shift-service.ts`) now computes each row's cash summary via a `LEFT JOIN LATERAL`
  bounded by that row's own `[started_at, coalesce(ended_at, now())]` window, instead of the
  settings tab making one `shiftCashSummary` round trip per shift. The aggregate columns
  themselves are factored into a shared `CASH_SUMMARY_COLUMNS` SQL fragment so `shiftCashSummary`
  (a single shift's own window, still used by `closeShiftRow` and `/api/shifts/active`) and the
  new LATERAL join compute the exact same rule from one place rather than two copies drifting
  apart. `shift-history-settings.tsx` now shows each closed shift's variance inline.

## Out of scope (this wave)

- **Per-order shift attribution (Wave 5's second open question) is still not addressed** — it was
  never part of "the admin security center" the issue describes; it's a separately-scoped change
  to `order-service.ts` if a concrete need for it ever comes up, and stays carried forward,
  unaddressed, below.
- **No automated response to repeated failed attempts** — no lockout, no rate-limit escalation
  beyond Wave 3's existing HTTP-layer bucket, no alerting/notification. This wave makes failures
  *visible*; deciding whether the product wants to *act* on a pattern of them is a Wave 8
  decision, not assumed here.
- **The security center is a Settings tab, like every other admin surface this phase has added**,
  not a dedicated top-level page. Whether Waves 7–8's output should eventually be promoted to its
  own `/dashboard/security` page combining sessions, failed logins, shift history, and the audit
  log in one view — rather than four separate Settings tabs — is a product decision for Wave 8,
  not assumed here.
- **No new migration.** `employee_sessions`, `pos_devices`, and `audit_log` already carry
  everything this wave reads or writes; `listShifts`'s LATERAL join reads `orders`/`payments` the
  same way `shiftCashSummary` always has. Purely additive, the same shape Wave 6 had.

## Decisions

- **`revokeSession` needed no change for admin use.** It already takes `(sessionId, businessId,
  actorId)` with no ownership check — the correct shape for `logout` (self) and now `/api/sessions/
  [id]` (admin) alike, since the only thing that would need an ownership guard is a *self-service*
  revoke a caller could point at someone else's row (the reason `revokeCredential` grew an optional
  `ownerEmployeeId` in Wave 3). An admin route is trusted with any session in its own tenant by
  definition.
- **Failed-attempt visibility, not failed-attempt policy.** Recording `employee.login_failed` was
  scoped deliberately narrowly to "make this visible to an admin," matching Wave 6's own audit
  writes — no threshold, no lockout, no notification. Wave 3's rate limiter already bounds the
  actual risk (brute-force volume); this wave's job was closing the *visibility* gap Wave 6 left
  open, not building a second defense on top of the first.
- **`entityName` resolved live, not stored at write time.** Same reasoning Wave 6 gave
  `credentialType`/`deviceLabel`: a name captured at write time would go stale if the employee were
  later renamed or removed; resolving it live via a join (itself RLS-scoped, so it can never
  resolve a name outside the caller's own business regardless of what `entity_id` an attacker-
  controlled failed-login attempt might have named) costs nothing extra since `listAuditLog` was
  already joining on other ids.
- **One shared SQL fragment for the cash-summary columns, not two independent queries.** The
  alternative — writing the LATERAL join's aggregate columns out by hand — would have been a
  second, likely-to-drift copy of `shiftCashSummary`'s own SELECT list; `CASH_SUMMARY_COLUMNS`
  keeps `reconcileCash`'s two callers (a single shift's own window at close time, every shift's own
  window at list time) computing an identical rule.
- **No new `withoutTenantScope` bypass.** `auditLoginFailure` runs inside the same
  `withTenant(businessId, …)` block `pin-login`/`webauthn/login/verify` already open for every
  other write on the request; `/api/sessions` and `/api/sessions/[id]` are ordinary authenticated
  dashboard routes, same as `/api/shifts` and `/api/audit-log`.

## Where each exit criterion is satisfied (Wave 7 only)

- Admin visibility into who is currently signed in, with the ability to end a session —
  `src/lib/employee-service.ts` (`listActiveSessionsForBusiness`), `src/app/api/sessions/route.ts`,
  `.../[id]/route.ts`, `src/app/dashboard/settings/security-center-settings.tsx`.
- Failed login attempts are now part of the audit trail — `src/lib/employee-service.ts`
  (`auditLoginFailure`), `src/app/api/auth/pin-login/route.ts`,
  `.../webauthn/login/verify/route.ts`.
- Shift cash variance shown without an N+1 query — `src/lib/shift-service.ts` (`listShifts`'s
  `CASH_SUMMARY_COLUMNS`/`LATERAL` join), `src/app/dashboard/settings/shift-history-settings.tsx`.
- No damage to the current POS flow — no schema change; `pin-login`/`webauthn` login routes
  unchanged in shape for a successful attempt (only the failure branches gained a write);
  `shiftCashSummary`'s own callers (`closeShiftRow`, `/api/shifts/active`) untouched; `npx tsc
  --noEmit`, `npm test` (840 tests, including a new `employee.login_failed` label case in
  `audit.test.ts`), `npm run test:db` (246 tests, unchanged — no new tenant-scoped table, so
  `tenant-isolation.integration.test.ts` needed no update), and `npm run build` all pass.

## Verification

`npx tsc --noEmit`, `npm test` (840 tests), `npm run test:db` (246 tests), and `npm run build` all
pass. Exercised end-to-end against a live dev server and a seeded business: a deliberately wrong
PIN against the seeded cashier produced an `employee.login_failed` row that
`GET /api/audit-log?action=employee.login_failed` (and the new "مرکز امنیت" tab) correctly
resolved back to the cashier's name via `entityName`, despite the row carrying no actor; the
following successful PIN login showed up in "نشست‌های فعال" as "پین · <user-agent> · آخرین
فعالیت: …"; ending that session as the owner via the tab's "پایان نشست" button (`DELETE
/api/sessions/[id]`) immediately 401'd the cashier's next `/api/auth/me` call and removed the row
from the list — confirmed both over `curl` and in a headless-Chromium screenshot of the rendered
tab. A cashier shift opened with a ۳۰۰,۰۰۰ toman float and closed with a deliberately short
۲۵۰,۰۰۰ count showed "تطبیق: ۵٬۰۰۰ تومان کسری" in the "شیفت‌ها" tab's list — computed by
`listShifts`'s own LATERAL join, without a per-row API round trip, and matching the figure
`closeShiftRow`'s independent `shiftCashSummary` call had already returned for the same shift.
The webauthn failure-audit branches were verified by type-check and code review against Wave 3/4's
existing ceremony routes rather than a live authenticator ceremony (unlike Wave 3's own CDP virtual-
authenticator run) — they follow the exact same shape as `pin-login`'s already-live-tested failure
path.

## Open questions for Wave 8

1. Carried over from Wave 5, still unresolved and still out of the security center's scope:
   `employee_shifts` has no link back to the individual orders it covers; if a real audit/security
   need for per-order shift attribution ever comes up, that's a separately-scoped change to
   `order-service.ts`, not an extension of this table.
2. Should a pattern of failed attempts (e.g. N wrong PINs for one employee within a window, or on
   one device) trigger anything beyond being visible in the security center — a temporary lockout,
   an admin notification, a forced device re-pairing? Wave 7 deliberately only closed the
   visibility gap; Wave 8 is where the product decides whether visibility alone is enough.
3. Should Waves 7–8's several Settings tabs (shifts, audit log, security center, devices) be
   consolidated into one dedicated security/admin page instead of four separate tabs under
   Settings, now that the admin security center the issue asked for has more than one surface?
4. This phase's own exit criteria are only met once Wave 8 ships (per this doc's opening
   paragraph) — Wave 8 should close out whichever of the above the product actually wants, then
   mark the phase complete.

## Scope — Wave 8: Automatic Lockout & Phase Close-out

The issue frames Waves 7–8 together as "the admin security center." Wave 7 built everything an
owner/manager needs to see and act on; this wave closes out the three open questions Wave 7 left
above and, with them, the phase itself.

- **Repeated failed logins now lock the account, not just show up in the log.** Resolves open
  question 2. `lockoutStatus` (`src/lib/employee.ts`) is a pure function over an employee's
  `employee.login_failed` / `employee.session_created` / `employee.login_unlocked` `audit_log` rows,
  most recent first: a leading, unbroken run of `LOGIN_LOCKOUT_THRESHOLD` (5) failed attempts — with
  no success or manual clear in between — locks the employee out of PIN and biometric login alike
  until `LOGIN_LOCKOUT_WINDOW_MINUTES` (15) after the newest failure in that run. No new table: the
  same rows Wave 6/7 already write are read back on demand, the same choice this phase already made
  for a shift's cash summary and a session's credential/device label.
- **`employee-service.ts` gained three functions around that rule**: `checkLoginLockout` (one
  employee, the `audit_log` rows fed straight to `lockoutStatus`) — called by
  `pin-login/route.ts` and `webauthn/login/verify/route.ts` before a credential is even checked
  when the caller already names an `employeeId` (the Wave 2 picker's normal case), or right after a
  legacy bare-PIN scan finds its match (the one case where the employee isn't known until then); a
  locked attempt gets `423 { error: "account_locked", lockedUntil }` instead of the usual 401,
  and — since nothing was actually attempted against a live credential — writes no additional
  `employee.login_failed` row. `listLockedEmployees` is the security center's business-wide
  counterpart, computing the identical rule with one window-function query instead of one
  `checkLoginLockout` round trip per employee — the same N+1 Wave 7 already fixed for shift cash
  variance (`listShifts`'s `LATERAL` join). `clearLoginLockout` is the admin override, writing an
  `employee.login_unlocked` row that breaks the streak for both of the above.
- **A fourth section on the security center tab, "کارمندان قفل‌شده"** — every currently locked
  employee, their failed-attempt count, and when the lockout lifts, with a "رفع قفل" button
  (`DELETE /api/security/lockouts/[employeeId]`, `team.manage`-gated like every other admin action
  this phase has added) for an owner/manager to end it early rather than wait out the window.
  `GET /api/security/lockouts` backs the list.
- **The login page surfaces the lockout with a wait time**, not the generic "wrong PIN" text — both
  the PIN pad and the biometric button's failure path (`src/app/login/page.tsx`) recognise the 423
  and show how many minutes remain.
- **Open question 3 (tab consolidation): decided against, for this phase.** Shifts, the audit log,
  the security center, and devices stay four separate Settings tabs rather than being folded into
  one dedicated `/dashboard/security` page. Each already has its own permission gate and was scoped,
  reviewed, and shipped independently (Waves 4–7); merging them is a UI reorganisation with no
  behavioural change and no dependency on anything this phase's exit criteria require. Nothing about
  today's four-tabs shape blocks doing that reorganisation later if the product wants it — see
  Decisions below.
- **Open question 1 (per-order shift attribution): still not addressed, and not carried forward
  again.** No concrete need for it has come up since Wave 5 first noted the gap. It was never part
  of the security center the issue asked for, and remains exactly what Wave 5 said it would be if
  the need ever materialises: a separately-scoped change to `order-service.ts`, independent of this
  phase.
- **This closes out the phase.** Every wave's exit criteria are now satisfied; see below.

## Out of scope (this wave)

- **No lockout notification (email/SMS/push) to the employee or an admin.** The security center tab
  (this wave) and the audit log (Wave 6) are the notification surface — an owner has to look, the
  same as every other security signal this phase has added. A push/email alert is a distinct,
  bigger feature with its own delivery-channel questions, not required to close the visibility→action
  gap Wave 7 identified.
- **No forced device re-pairing.** A lockout blocks the *employee*, not the *terminal* — Wave 4
  already drew the line that a device token narrows a public UI's choices and is never itself a
  security boundary; nothing about repeated failed attempts against one employee's credential
  implicates the device they were attempted from.
- **The lockout threshold/window (5 attempts / 15 minutes) are constants, not a per-business
  setting.** No product requirement for a configurable policy has surfaced; every other numeric
  threshold this phase introduced (`EMPLOYEE_SESSION_TTL_HOURS`, `AUTH_IP_LIMIT`) is a constant for
  the same reason. Easy to promote to a `businesses` column later if a concrete need appears.
- **No new migration.** The lockout rule reads only `audit_log` rows this phase already writes;
  `employee.login_unlocked` is a new *action* string, not a schema change.

## Decisions

- **A read-on-demand rule over `audit_log`, not a `locked_until` column on `users`/`employees`.**
  Storing a materialized lockout column would need its own write path (set on the Nth failure, clear
  on success/expiry/manual override) that's just a cache of exactly what `lockoutStatus` already
  computes from data this phase writes anyway — the same "computed on demand" choice already made
  three times over in this phase (a shift's cash summary, a session's credential/device label, a
  failed attempt's `entityName`). A column would only pay for itself if this read path were ever
  measured as a bottleneck, which login (an already-latency-tolerant, human-paced action) is not.
- **A picker-narrowed request checks lockout before touching a credential at all; a legacy bare-PIN
  scan checks it right after finding its match.** The former is the common case since Wave 2 and
  costs nothing extra to check first; the latter genuinely doesn't know *which* employee until the
  bcrypt loop finds one, so it's the earliest point that scan can check without restructuring it.
  Either way, a blocked attempt never reaches `createSession`.
- **A blocked attempt writes no additional `employee.login_failed` row.** The failures that caused
  the lockout are already in the log; repeatedly hitting a locked account would just pad the count
  and push `lockedUntil` without a genuine new credential attempt ever having been checked. This also
  keeps the rule's own read (`checkLoginLockout`) from being able to extend its own window via
  blocked attempts.
- **`listLockedEmployees` is one window-function query, not `checkLoginLockout` called once per
  employee.** Matches Wave 7's own reasoning for `listShifts`'s `LATERAL` join: a per-row round trip
  is the kind of N+1 this phase has consistently avoided once a business-wide admin list needs the
  same rule a single-row check already has. The SQL is written to implement the identical rule
  `lockoutStatus` does (a leading, unbroken run bounded by `LOGIN_LOCKOUT_THRESHOLD`, still within
  `LOGIN_LOCKOUT_WINDOW_MINUTES`), rather than being a second, drifting definition of "locked."
- **`employee.login_unlocked` breaks the streak the same way a successful login does.** Both are, in
  `lockoutStatus`'s terms, "something that isn't a failed attempt" — no special case was needed
  beyond adding the action string to the set `checkLoginLockout`/`listLockedEmployees` scan for.
- **Settings tabs stay four, not one.** See "Out of scope" above. If a later phase does want a
  unified `/dashboard/security` page, nothing this wave did makes that harder — each tab's data
  fetch is already an independent, tab-scoped component (`security-center-settings.tsx`,
  `audit-log-settings.tsx`, `shift-history-settings.tsx`, `device-settings.tsx`); consolidating them
  would be a presentation-layer change, not a rework of any service function this phase built.
- **No new `withoutTenantScope` bypass.** Every lockout read/write runs inside the same
  `withTenant`/tenant-scoped-session boundary `pin-login`, `webauthn/login/verify`, and the other
  `team.manage` admin routes this phase added already open — `checkLoginLockout` and
  `clearLoginLockout` take `businessId` explicitly and filter every query by it, matching this
  phase's existing belt-and-suspenders style on top of RLS.

## Where each exit criterion is satisfied (Wave 8 only)

- Automatic response to repeated failed logins, resolving Wave 7's second open question —
  `src/lib/employee.ts` (`lockoutStatus`), `src/lib/employee-service.ts` (`checkLoginLockout`,
  `listLockedEmployees`, `clearLoginLockout`), `src/app/api/auth/pin-login/route.ts`,
  `src/app/api/auth/webauthn/login/verify/route.ts`.
- Admin visibility into, and control over, an active lockout —
  `src/app/api/security/lockouts/route.ts`, `.../[employeeId]/route.ts`,
  `src/app/dashboard/settings/security-center-settings.tsx`.
- Wave 7's third open question (tab consolidation) explicitly decided, not left hanging — see
  Decisions above.
- Wave 5's second open question (per-order shift attribution) explicitly closed out as
  not-addressed-by-this-phase, not silently dropped — see Scope above.
- No damage to the current POS flow — a picker-narrowed PIN/biometric login is unchanged in shape
  for every caller not currently locked out (the added check is a cheap read before the existing
  logic); `npx tsc --noEmit`, `npm test` (848 tests, including new `lockoutStatus` coverage in
  `employee.test.ts` for the threshold boundary, the window expiring, and both kinds of streak break),
  `npm run test:db` (246 tests, unchanged — no new tenant-scoped table, so
  `tenant-isolation.integration.test.ts` needed no update), and `npm run build` all pass.

## Verification

`npx tsc --noEmit`, `npm test` (848 tests), `npm run test:db` (246 tests), and `npm run build` all
pass. Exercised end-to-end against a live dev server and a seeded business: five deliberately wrong
PINs against the seeded cashier (picker-narrowed, `employeeId` sent each time) each returned `401`
as before; a sixth attempt — this time with the *correct* PIN — returned `423 { error:
"account_locked", lockedUntil }` instead of succeeding, confirming the lock blocks a valid credential
too, not just repeats of an invalid one. As owner: `GET /api/security/lockouts` listed the cashier
with `failedCount: 5` and the correct `lockedUntil`; the new "کارمندان قفل‌شده" section of the
"مرکز امنیت" tab rendered the same entry with a "رفع قفل" button in a headless-Chromium screenshot;
clicking it called `DELETE /api/security/lockouts/[employeeId]`, showed "قفل ورود برداشته شد.", and
the section correctly emptied to "هیچ کارمندی قفل نیست." on reload. Logging in again with the
correct PIN immediately after succeeded (confirmed both over `curl` and that the login page's PIN
pad, driven headlessly, displayed the Persian wait-time message — "…؛ ۱۴ دقیقه دیگر دوباره تلاش
کنید." — when still locked, before the manual clear). The audit log correctly showed the
`employee.login_unlocked` row (labelled "رفع قفل ورود") breaking the streak.

## Status: complete — all eight waves shipped; this phase's exit criteria (see opening paragraph) are met
