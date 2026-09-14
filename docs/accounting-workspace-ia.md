# The Accounting workspace — information architecture

This is the route and navigation contract for the Accounting workspace. It
supersedes older notes about *navigation* in `docs/design-system.md`; the visual
canon remains unchanged.

## 1. Why this shape

Accounting is the business's primary work menu, not a narrow ledger tool. It
brings together the daily business work (sales, inventory, products, operations
and business reporting) and the ledger as a named group in one app shell. The
previous flat `/dashboard/*` operational URLs made a person leave Accounting to
complete routine work and created competing navigation structures.

`/accounting` is one shell with one menu. The menu composes, rather than copies,
the shell's already-gated business entries with Accounting's own ledger entries.
`workspace-shell.tsx` remains the source of module, role, feature and permission
gating; `accounting-workspace.ts` adopts eligible entries by their canonical
href. A business without a module simply has no corresponding menu entry.

## 2. Canonical work areas

The following operational workspaces have exactly one public destination. Use
`ACCOUNTING_WORKSPACE_HREFS` and `accountingProductsHref()` from
`src/lib/app-routes.ts` in code rather than recreating these strings.

| Work area | Canonical route |
| --- | --- |
| POS / cashier | `/accounting/pos` |
| Inventory | `/accounting/inventory` |
| Products | `/accounting/products` |
| New product | `/accounting/products/new` |
| Product prices | `/accounting/products/prices` |
| Product attributes | `/accounting/products/attributes` |
| Barcode templates | `/accounting/products/barcode-templates` |
| Product reports | `/accounting/products/reports` |
| Cosmetics | `/accounting/cosmetics` |
| Business reports | `/accounting/reports` |
| Floor / tables | `/accounting/floor` |
| Kitchen | `/accounting/kitchen` |
| Reservations | `/accounting/reservations` |
| Delivery | `/accounting/delivery` |

The rest of the workspace has these responsibilities:

| Group | Entries |
| --- | --- |
| میز کار | داشبورد حسابداری (`/accounting/overview`) |
| فروش و درآمد | existing canonical sales entries, including POS and customer work |
| خرید و انبار | inventory, products and industry-specific trade entries |
| عملیات | the industry’s canonical operations screens, such as floor, kitchen, reservations and delivery |
| اشخاص | the one directory (`/accounting/directory`) and its `?view=` links |
| **فضای کار حسابداری** | trial balance, journal, manual entry, chart of accounts, receivables, payables, receipts/payments, instalments, cheques, expenses, bank reconciliation, fixed assets, periods, tax, payroll and accounting settings |
| گزارش و تحلیل | financial reports (`/accounting/financial-reports`), business reports (`/accounting/reports`), growth/marketing |
| پیکربندی | business settings, technical connections, credit and billing |

`/accounting/financial-reports` is the ledger report index. `/accounting/reports`
is the business reporting workspace; they are intentionally different routes.

### Inventory is one door

Every industry enters inventory through `/accounting/inventory`. Hospitality and
retail retain their appropriate stock-record and posting adapters
(`inventory_items` versus the retail `items` stock model), but there is no second
public inventory URL, nav item or route page. The canonical workspace selects the
industry-appropriate data surface after the server-side module guard. Any new
inventory feature must start from this canonical door; do not reintroduce a
`/dashboard/stock` or `/dashboard/inventory` page.

## 3. Retired dashboard URLs and bookmark compatibility

The old route modules have been removed from the Dashboard route tree. They do
not load their former pages. Middleware performs a permanent redirect using
`LEGACY_PREFIX_MAP` in `src/lib/app-routes.ts`, preserving a nested suffix and
query string, so existing bookmarks continue to land on the canonical page.

| Retired URL prefix | Canonical URL prefix |
| --- | --- |
| `/dashboard/pos` | `/accounting/pos` |
| `/dashboard/stock` | `/accounting/inventory` |
| `/dashboard/inventory` | `/accounting/inventory` |
| `/dashboard/products` | `/accounting/products` |
| `/dashboard/cosmetics` | `/accounting/cosmetics` |
| `/dashboard/reports` | `/accounting/reports` |
| `/dashboard/floor` | `/accounting/floor` |
| `/dashboard/kitchen` | `/accounting/kitchen` |
| `/dashboard/reservations` | `/accounting/reservations` |
| `/dashboard/delivery` | `/accounting/delivery` |

For example, `/dashboard/products/new?from=menu` redirects to
`/accounting/products/new?from=menu`. A legacy path is a compatibility input to
the redirect table only. It must never be emitted by new application code or
appear as a live `page.tsx` route.

The directory consolidation is independent and remains in place:

| Former accounting URL | Canonical destination |
| --- | --- |
| `/accounting/customers` | `/accounting/directory?view=customers` |
| `/accounting/suppliers` | `/accounting/directory?view=suppliers` |
| `/accounting/vendors` | `/accounting/directory?view=vendors` |
| `/accounting/parties` | `/accounting/directory` |

Those are real `redirect()` calls in `src/app/(app)/accounting/[section]/page.tsx`,
not middleware pathname rewrites.

## 4. The people directory

There is one directory (`/accounting/directory`) and one create/edit flow
(`src/app/dashboard/parties/party-form.tsx`). The directory views are `all`,
`customers`, `suppliers`, `vendors`, and `employees`; `?view=` filters the same
component, `/api/parties` endpoint and `parties` table. Other workspaces link via
`partyDirectoryHref(view)`.

A person can have several roles. Migration `0148_party_roles.sql` keeps
`parties.role` as the primary accounting-code role and adds `parties.roles` as
the complete set. The trigger and listings keep both representations consistent,
so one person who is both a customer and supplier is still one record, one
balance and one file.

## 5. Adding or moving a route

- **New ledger section:** add its key, label, icon and menu group through the
  Accounting route constants. `accounting-workspace.test.ts` must still prove
  every section has an intended menu home.
- **Business page adopted by Accounting:** add its **canonical** href to
  `WORKSPACE_GROUP_SLOTS`. Do not duplicate its gating; the composer receives
  the shell’s already-filtered nav.
- **Moved page:** create/move the canonical `page.tsx`, remove the old
  `page.tsx`, add the permanent legacy prefix mapping, update every producer and
  document, and extend the route-tree, middleware and navigation tests. A
  redirect is mandatory for existing bookmarks, but it is not permission to
  retain a duplicate live route.

## 6. What did not change

- The `(app)` route group and the real top-level app routes.
- Tenant isolation, app availability, feature flags and role/module gates.
- Inventory’s distinct underlying data models and their posting safeguards.
- Dashboard surfaces that are not in the retirement table, such as
  `/dashboard/orders`.
