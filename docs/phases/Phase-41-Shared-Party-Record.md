# Phase 41 — one shared party record (`parties`), scoped views in every app

Before this phase, a person the business dealt with was stored wherever the app that
first needed them happened to put them: customers in `customers`, suppliers in a
per-location `suppliers` table, staff only as `users`, and the ledger's receivable and
payable views each keeping their own opinion of who a counterparty is. Four tables,
four add-forms, four archived flags — and the same «قصابی مرکزی» with two phone numbers
and no single name. This phase makes the record one thing, and makes each app's screen a
*view* of it.

## The product rule

One party row per counterparty per business, with a `role` of `Customer`, `Employee` or
`Supplier`. Apps do not get their own party tables, their own add/edit forms, their own
inactive flag or their own second list of "the suppliers I care about": they mount the
same section with a scope.

| Scope | Host app | Roles listed | Ledger fields | Edit |
|---|---|---|---|---|
| `crm` | CRM | Customer | read-only (code, A/R balance) | yes |
| `accounting` | Accounting | all three | **editable** | yes |
| `operations` | Inventory | Supplier | read-only | yes |
| `team` | Settings → team | Employee | read-only | yes |
| `growth` | Growth | Customer | hidden | no — links to `crm` |
| `sales` | Orders | Customer | hidden | no — links to `crm` |

`src/lib/parties-scopes.ts` is the only place that table exists in code. A scope that
wants to be added is a row there, not a fork of the directory in another app.

## What was built

- **`migrations/0137_parties.sql`** — `customers` → `parties`; `role` (CHECK + default
  `customer`), `person_type` (`real`/`legal`), `accounting_code` (+ per-business partial
  unique, 1–24 trimmed chars) and `accounting_code_mode` with a `parties_manual_code_required`
  CHECK; four jsonb tab documents (`general_info`, `address_info`, `contact_info`,
  `financial_info`) each guarded by a `jsonb_typeof` object CHECK; the identity columns
  `national_id`/`national_id_enc`/`national_id_bidx` and `economic_code`/`economic_code_enc`;
  `employee_user_id → users` (ON DELETE SET NULL, one party per membership per business);
  `category_id → party_categories` (ON DELETE SET NULL) and the new `party_categories`
  table; the `parties`-side stale-ciphertext trigger widened to the new columns; backfills
  for role, person type and the tabs from the old flat columns; and §5, which rewrites the
  stored permission overrides in `users.permissions` and `invitations.permissions` from
  `customers.*` to `parties.*` through two temporary mapping functions that are dropped at
  the end of the same transaction.
- **`src/lib/parties.ts`** — the contract, with no database in it: roles and person types
  with their Persian labels, the caps, the Iranian identity validators (national ID,
  economic code, IBAN mod-97, Luhn card, postal code), the accounting-code prefix and
  allocator, the declarative `PARTY_SCHEMA` the form and the route both validate against,
  `buildPartyPayload` (flat state → nested wire body) and `formStateFromParty` (record →
  state), and `parsePartyRequestBody`, which emits **only the keys the body sent**.
- **`src/lib/parties-service.ts`** — `parties-service.ts` renamed and rewritten around the
  shared row: `listParties`, `searchParties`, `getParty`, `createParty`, `updateParty`,
  `removeParty`, `ensureEmployeeParty` and the category CRUD, with the tab-merge semantics
  and the dual-write encrypted columns. The old `customers*` names remain as thin wrappers
  so the assistant's tools and the two importers keep their call sites.
- **`src/app/api/parties/{route,[id],categories,categories/[id]}.ts`** — the only party
  write path. `/api/customers` is deleted rather than aliased: a second door is how two
  screens end up disagreeing about one person. `GET` answers the paginated directory or
  (with `q` alone) the capped picker search, and returns the list under both `parties` and
  `customers` so no caller has to guess which key is live.
- **`src/app/dashboard/parties/parties-section.tsx` + `party-form.tsx`** — the one screen:
  the scoped list (search, category filter, archived toggle, paging, per-scope columns,
  A/R statement for the members who may see it) and the form (root fields, four tabs,
  inline category creation, draft autosave). Mounted by the CRM's directory, the store's
  supplier tab, the team's personnel card and Accounting's new «طرف‌حساب‌ها» tab.
- **`src/lib/party-drafts.ts`** — per-business localStorage drafts (cap 20, corrupt JSON
  reads as empty, never a crash), so a half-typed party survives a closed tab without
  becoming a database row nobody asked for.

## Decisions

- **The ledger's fields need `ledger.view`.** `accountingCode`, `accountingCodeMode`,
  `general_info.taxPercentage`, `financial_info` and the two identity numbers are gated on
  the *body*, on top of `parties.manage` — which a manager and a cashier both hold. An
  owner who lets the till edit phone numbers must not be silently giving it the invoice's
  VAT rate. A client that only needs to round-trip an unchanged value omits the key.
- **PUT is patch-shaped.** A tab the request does not name is left exactly as stored; `{}`
  means cleared. This is what makes the directory's archive toggle safe to send as
  `{ status: false }`, and what the old form-shaped PUT could not promise.
- **`suppliers` stays, as an alias.** Purchases reference `suppliers.id` (per-location), and
  that row now carries `party_id`; its `name`/`phone` remain for rows that predate the link,
  resolved by one COALESCE in `getInventoryOverview`. `PATCH /api/inventory/suppliers/:id`
  refuses an identity edit on a linked row (`supplier_identity_on_party`): the branch owns
  its note and its active flag, not the counterparty's name.
- **Delete is a decision.** `removeParty` hard-deletes a party with no history and archives
  one with orders, receivables, loyalty points, a branch alias or merge children; the route
  returns which happened so the screen can say it.
- **Categories are PATCH-only.** A category still in use is deactivated rather than
  deleted, and that choice needs the usage count on screen, so the child route has no
  DELETE verb.
- **The assistant's tool vocabulary keeps `customer`.** `find_customers`,
  `get_customer_profile` and the MCP tool names are an external contract and describe the
  *role*, which is still exactly what they resolve; only the endpoints they hit changed.
- **Feature flags and module keys did not move.** `module_customers`, the CRM's `customers`
  section key and the Growth route names stay as they were: renaming a stored flag is a
  migration with no user-visible gain and a real chance of turning an app off.
- **Phone digits are normalized in search, not in storage.** The party write path stores
  what the person typed (as it always did); the search clause compares ASCII digits on both
  sides (`translate` over Persian and Arabic-Indic, separators stripped) and matches a whole
  number on `phone_e164`. Rewriting the stored value would have invalidated every blind
  index already written — a backfill of its own, not something to smuggle into a rename.

## Bugs this phase found

Because the record is now one thing, the tests written against it reached places the
per-app copies never did:

1. `createParty`'s INSERT had 37 columns and 36 placeholders — no party could be created.
2. `PARTY_COLUMNS` selected `p.national_id` and `p.economic_code` without the camelCase
   alias `toParty` reads, so a stored national or economic code was invisible on every
   screen and silently dropped by the next save.
3. `deriveDisplayName` answers `""` for a body that named nobody, and `??` does not fall
   through an empty string: every partial update through the service — the assistant
   appending a note, the store fixing one field — failed with «نام نمایشی الزامی است» on a
   party that had had a name for years.
4. `removeParty`'s history check read `orders.business_id`, a column that does not exist
   (orders are scoped by branch), so the query that decides "archive or delete" threw —
   which is the failure mode where a party with orders could have been hard-deleted by any
   caller that swallowed the error. It now walks `orders → locations` for the tenant.
5. A manual accounting code that collided retried three times and then re-raised the raw
   Postgres 23505 instead of naming the field.
6. `removePartyCategory`'s usage query bound `business_id` to a parameter it never
   referenced (a syntax error at runtime) and did not scope the check to the tenant.

## Verification

`npm test` (225 files), `npm run test:db` including the new
`integration/parties.integration.test.ts` (18 cases: code allocation per role and per
business, manual-code conflicts, national-ID tenancy, tab-merge semantics, role filtering,
archive-on-delete, idempotent employee parties, category deactivation), the new unit tests
in `src/lib/parties.test.ts`, `src/lib/parties-scopes.test.ts` and
`src/lib/party-drafts.test.ts`, and `npm run build`. `/home/user/db-reset.sh` re-applies all
161 migrations from an empty schema, so 0137 is verified as a fresh install and not only as
an upgrade.
