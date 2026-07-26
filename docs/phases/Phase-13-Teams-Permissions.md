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

## Open questions

1. Should an invitation email actually be sent, or is a copy-paste invite link enough for v1 (there is no mail transport anywhere in the system today)?
2. Can a business have more than one owner, or is ownership singular with managers beneath it?
3. Should a suspended member's historical rows (orders they opened, entries they posted) remain attributed to them, or be anonymised?
4. Do PIN-only staff need to appear in the team UI at all, or is the existing staff screen the right home for them?
