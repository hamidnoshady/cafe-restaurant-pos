# Tenant authorization architecture

## Decision flow

Tenant requests use this order:

1. verify the tenant-realm JWT;
2. revalidate an impersonation grant or employee session when present;
3. load the current `users` membership and linked platform identity;
4. require an active membership and active business;
5. compare the current platform `token_version` (password identities);
6. resolve the built-in role preset;
7. apply individual grants and then revocations (deny wins);
8. enforce app availability, feature entitlement and industry module availability;
9. enforce explicit `location_scope` and tenant-owned location IDs;
10. enforce project/resource policy where the feature has one;
11. allow or deny.

JWT role and permissions are never authorization authority. Role and permission changes take effect on the next request.

Platform administration is a separate JWT realm and capability system. Tenant Owner does not imply platform access.

## Identities and memberships

`platform_users` is a global login identity. `users` is a tenant membership. One platform identity may link to multiple memberships with different roles. PIN-only employees intentionally keep `platform_user_id = NULL` and use revocable `employee_sessions`.

Membership lifecycle values are `invited`, `active`, `suspended`, `locked`, `inactive`, and `offboarded`. Offboarding preserves the membership row and historical attribution while revoking credentials and sessions.

## Roles and effective permissions

Roles are presets. `owner` is an irreducible system rule; `admin` receives every delegatable capability; `manager` is an operational preset. Existing accountant, cashier, waiter and kitchen presets remain supported.

Effective permissions are:

`preset + valid individual grants - individual revocations`

Unknown stored keys are ignored. Revocation wins. `ownerOnly`/non-delegable keys are removed from override input and cannot be granted to Admin or custom member overrides.

The canonical catalogue and risk metadata are in `src/lib/permissions.ts`. API routes use `requirePermission` or `requirePermissions`. Error bodies use stable codes such as `MISSING_PERMISSION`.

## Location scope

`users.location_scope` is explicit:

- `all`: every active location belonging to the tenant;
- `selected`: intersection with `user_locations`;
- `home`: only `users.location_id`;
- `none`: no location access.

Owner is tenant-wide. Client location IDs are validated against the membership tenant before writes. Migration 0170 preserves legacy effective access while making the inferred policy explicit.

## Workspace projects

Tenant `workspace.*` permission is evaluated first. A `workspace_members` project role can narrow that permission for one project but can never grant a tenant capability the member lacks.

## Applications

An application is usable only when tenant entitlement, feature/module support, runtime availability, and member permission all allow it. Navigation uses the same effective permission set used by API routes.

## Remaining semantic role gates

The following role identity checks are intentional:

- WebAuthn employee credential routes: restricted to local/PIN employee categories because the credential belongs to the shared-terminal employee authentication model.
- Waiter board: restricted to cashier/waiter identities because it is the assigned-table shared-terminal workflow, not a general business capability.
- Owner target protection in team routes/UI: a delegated team manager cannot modify, demote, suspend, or offboard an Owner; final-active-owner protection is transactional.
- AI autonomous `auto` approval mode: Owner is the accountable security authority for unattended execution.
- Platform roles and impersonation: separate platform realm with its own capabilities.

All ordinary API domain gates were migrated away from `requireRole` to effective permissions. Sync event definitions also carry permission keys rather than role allowlists.

## Invitations

Invitation plaintext tokens are random, stored only as SHA-256 hashes, tenant-bound, expiring, revocable and single-use. Invitations carry role, member overrides and validated tenant location assignments. Acceptance links an existing global identity when possible instead of duplicating it.

## Auditing and offboarding

Team mutations write tenant-scoped before/after audit records. Offboarding disables the membership, marks it `offboarded`, sets location access to `none`, revokes credentials and employee sessions, closes open shifts, and keeps historical foreign-key attribution.

High-risk and critical permissions are identified in canonical permission metadata for warning, reason and audit behavior.
