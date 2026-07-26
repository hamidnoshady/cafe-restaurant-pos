# Phase 13 — Teams & Permissions

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12
**Goal:** A business owner can build and run their own team — invite people, set what each of them may do, assign them to branches, and remove them — without a developer touching the database.

---

## Scope

- **Invitations** — an owner invites by email (creates or links a `platform_users` identity) or provisions a PIN-only staff member directly. Single-use, expiring invitation tokens.
- **Member management UI** — `/dashboard/team`: list members, their role, their branches, last activity; edit, suspend, reactivate, remove.
- **Permission editor** — the role preset is the starting point; an owner toggles individual permissions per member on top of it, using the catalogue from Phase 12.
- **Branch assignment** — attach a member to one or more `user_locations`, with a default branch.
- **Role coverage** — apply `requirePermission` to the routes where the coarse `requireRole` guard is now too blunt, especially the accounting surfaces.
- **Membership audit** — every invite, role change, permission change and removal lands in `audit_log`.
- **Self-service** — a member can change their own password and PIN; an owner can force-reset either.

## Out of scope

- Fully custom named roles (decided against — presets plus overrides).
- SSO / OAuth identity providers.
- Cross-business permission templates.

## Exit criteria

- An owner can invite a person who already belongs to another business, and that person ends up with two memberships and one login.
- Revoking a permission from a member takes effect on their next request without them re-logging-in.
- An owner cannot revoke their own last owner-level access (no lockout).
- Every membership mutation appears in the audit log with actor, target and before/after.

## Decisions on Phase 13 open questions

1. **Invitation delivery** — **a copy-paste link, no email.** There is no mail transport anywhere in this system, and adding one is a deployment concern (SMTP credentials, deliverability, bounce handling) rather than a product one. `POST /api/team/invitations` returns the URL exactly once; only the token's sha-256 is stored (`migrations/0022`), following the same rule as the Phase 9 rollup tokens, so a database read can never yield a usable invitation. Re-inviting an address revokes the pending invitation and issues a fresh token rather than leaving several live links for one person.
2. **Multiple owners** — **yes.** That turns the anti-lockout rule into a counting rule rather than "the owner is special": `checkLastOwner` refuses to demote, suspend or remove the *last active* owner, and allows any of those once a second active owner exists. A suspended owner deliberately doesn't count as a way back in.
3. **Removed members' history** — **stays attributed.** Every foreign key to `users(id)` is `ON DELETE SET NULL`, so deleting a member would silently orphan "who opened this order" across the ledger and the audit trail. `removeMembership` deactivates the row and strips its credentials (PIN, password, identity link) instead: they can no longer sign in by any route, and the history stays readable. This required relaxing the `users_credentials` constraint from Phase 12 — its intent was that an *active* member must have a way in, which is what it now says.
4. **PIN staff in the team UI** — **yes, in the same screen.** They are members like any other, just with a different credential; splitting them across two screens would mean two answers to "who works here". The team page has a separate card for them because they need a PIN rather than an email, not because they live elsewhere.

**Other decisions made while building:**

- **One creation path, and it fixed a live bug.** `createMembership` is the only place a membership is created. That is not tidiness: Phase 12 moved the login identity into `platform_users`, but the setup wizard's own `INSERT` was left creating a `users` row without one — so **every manager added through the wizard could not log in at all**, because login resolves by identity. `/api/setup/users` now delegates like everything else, and `integration/team.integration.test.ts` asserts the identity exists so it can't regress.
- **`requirePermission` re-reads the database** rather than trusting the token, which is what makes exit criterion 2 true. It costs one indexed lookup per guarded request and also makes deactivation and business suspension take effect immediately instead of at token expiry.
- **Overrides are stored relative to the role preset**, not as an absolute permission list. The editor computes `granted = ticked \ preset` and `revoked = preset \ ticked`, so a member who never customised anything stores `{}` and keeps following the preset when it changes in a later release.
- **Self-service password change requires the current password**; an owner's force-reset does not. Without that, an unlocked screen would be a permanent account takeover rather than a temporary one. Worth noting in the UI eventually: a password lives on the *global* identity, so an owner resetting one changes that person's login in every business they belong to.

## Where each exit criterion is satisfied

All four are covered by `integration/team.integration.test.ts` (18 tests), plus `src/lib/team.test.ts` (26) for the pure rules.

- **Invite someone who already belongs to another business** — "gives one person two memberships and one login": Alpha's owner is invited into Beta as an accountant, ends with two `users` rows against one `platform_users` row, and needs no password because they already have one.
- **Revocation takes effect without re-logging-in** — `requirePermission` (`src/lib/auth.ts`) resolves the membership per request; asserted in "permission changes take effect immediately".
- **No self-lockout** — `checkLastOwner` (`src/lib/team.ts`), enforced in `updateMembership` and `removeMembership`, asserted both as a unit and end-to-end.
- **Every mutation audited** — `auditMembership` writes actor, target and before/after for create, update, remove, PIN and password changes; invitations record issue and acceptance. Asserted in "every membership mutation is auditable".

## Known follow-ups

- `requirePermission` is applied to `/api/team/*` only. The rest of the API still guards with `requireRole`, which is correct but coarse — widening it is worthwhile once Phase 16 gives the `accountant` role something to do.
- Branch assignment is stored and editable through the API, but the UI doesn't expose a branch picker yet: with `getPrimaryLocation` still resolving one branch (Phase 14), there is nothing meaningful to choose between.
