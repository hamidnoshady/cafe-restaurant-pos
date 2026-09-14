# The Accounting workspace — information architecture

This is the map the code implements. It supersedes the note in
`docs/design-system.md` only about *navigation*; the visual canon is unchanged.

## 1. Why this shape

Before this change the product had **two competing main navigations**:

- «حسابداری» opened `/accounting/overview`, which immediately rendered the
  in-page rail titled «فضای کار حسابداری» — twenty-odd ledger sections and
  nothing else. It read as a narrow financial tool.
- Everything a business actually does daily — فروش و فاکتور، خرید و انبار،
  محصولات، گزارش‌ها، عملیات صنفی — stayed in the flat `/dashboard/*` sidebar.

So an accountant who needed a purchase invoice had to leave «حسابداری»
entirely, and the app that should be the business's primary workspace looked
like a folder of the dashboard.

## 2. The canonical map

`/accounting` is **one shell** with one menu. The menu is composed from two
sources, and neither of them is a copy:

| group | source | entries |
| --- | --- | --- |
| میز کار | accounting route | داشبورد حسابداری (`/accounting/overview`) |
| فروش و درآمد | existing `/dashboard/*` pages | سفارش‌ها، صندوق، ارتباط با مشتری |
| خرید و انبار | existing `/dashboard/*` pages | خرید و انبار، انبار، محصولات (+ trade sections)، منو |
| عملیات | existing `/dashboard/*` pages | the trade's own screens — میزها، آشپزخانه، رزروها، ارسال، or the industry manager |
| اشخاص | accounting route | اشخاص (`/accounting/directory`) + مشتریان / تأمین‌کنندگان deep links |
| **فضای کار حسابداری** | accounting routes | تراز آزمایشی، دفتر روزنامه، ثبت سند دستی، سرفصل حساب‌ها، دریافتنی، پرداختنی، دریافت و پرداخت، اقساط، چک‌ها، هزینه‌ها، تطبیق بانکی، دارایی ثابت، دوره‌های مالی، مالیات، حقوق و دستمزد، تنظیمات حسابداری |
| گزارش و تحلیل | accounting + dashboard | گزارش‌های مالی، گزارش‌های کسب‌وکار، رشد و بازاریابی |
| پیکربندی | platform | تنظیمات کسب‌وکار، اتصال‌های فنی، اعتبار و پرداخت‌ها |

«فضای کار حسابداری» is therefore a **named group inside** the complete
Accounting menu, never a competing shell. It is the one collapsible group (it
is the long one), it opens automatically when you are standing in it, and its
open/closed state is remembered per device.

### How the group is drawn

Every group in this menu — plain or collapsible — is rendered by the shared
[`src/app/dashboard/sidebar-nav-group.tsx`](../src/app/dashboard/sidebar-nav-group.tsx),
so the sidebar has one spelling of a group instead of one per menu.

- The ledger group's **disclosure header is a nav row**, not a caption with an
  arrow: `min-h-12 rounded-xl px-3`, its own glyph, the label, and a chevron —
  the same `APP_NAV_BUTTON_CLASS` amber hover/selection skin as the rows it
  opens (docs/design-system.md §Rail navigation, §Colour roles). Before this it
  was a bespoke 11px caption with a small chevron, the only control in the
  menu that shared nothing with the menu.
- Closed **over the page you are on**, the header keeps the selected skin, so
  «you are here» survives collapsing.
- The group has **named sub-groups**, the way every other group has a heading:

  | sub-group | sections |
  | --- | --- |
  | دفتر و اسناد | تراز آزمایشی، دفتر روزنامه، ثبت سند دستی، سرفصل حساب‌ها |
  | دریافتنی و پرداختنی | دریافتنی، پرداختنی، اقساط، چک‌ها |
  | وجوه و هزینه | دریافت و پرداخت، هزینه‌ها، تطبیق بانکی، دارایی ثابت |
  | دوره، مالیات و حقوق | دوره‌های مالی، مالیات، حقوق و دستمزد |
  | پیکربندی حسابداری | تنظیمات حسابداری |

  They are an *arrangement* of `LEDGER_WORKSPACE_SECTION_KEYS`, never a second
  list: the group's flat `entries` are built from the sub-groups, and a test
  asserts the two sets are identical, so a section cannot end up in one and not
  the other.
- At the 4rem icon rail the headings and the chevron hide and the rows stay
  listed — a closed group must never leave the rail empty, because collapsed
  there is no chevron to reopen it with.

Its **in-page rail** — the `SectionNav` that used to list every section in the
app, i.e. a second copy of the whole menu inside the page — is now scoped to
exactly that group. `/accounting/settings` now appears in this rail as the
single «تنظیمات حسابداری» destination; the route and page were moved into the
group rather than copied. On a page outside the group (`/accounting/overview`,
`/accounting/directory`, `/accounting/reports`) there is no rail at all: those
are top-level areas of the workspace and render as plain pages.

### Where the business entries come from

They are **not** re-declared. `workspace-shell.tsx` already builds the
business nav with every module / role / feature / permission filter applied;
that list is handed to the app shell nav (`AppShellNavProps.navItems`) and the
Accounting menu picks the work areas out of it by href
(`src/app/(app)/accounting/accounting-workspace.ts`). A business whose trade
has no انبار simply has no انبار row — the gate is the one that already
existed.

## 3. Legacy URLs

Nothing was moved, so nothing broke:

- every `/dashboard/*` page is still a real page at its own URL;
- `/dashboard/accounting/*` still redirects (middleware `app-routes.ts`);
- `/accounting/customers`, `/accounting/suppliers`, `/accounting/vendors` are
  now **route-level redirects** onto the canonical directory with the matching
  filter, preserving every other query parameter:

  | legacy | canonical |
  | --- | --- |
  | `/accounting/customers` | `/accounting/directory?view=customers` |
  | `/accounting/suppliers` | `/accounting/directory?view=suppliers` |
  | `/accounting/vendors` | `/accounting/directory?view=vendors` |
  | `/accounting/parties` | `/accounting/directory` |

  The old in-page tab addresses forward the same way, with the filter kept:

  | legacy | canonical |
  | --- | --- |
  | `/dashboard/ledger?tab=customers` | `/accounting/directory?view=customers` |
  | `/dashboard/ledger?tab=suppliers` | `/accounting/directory?view=suppliers` |
  | `/dashboard/ledger?tab=vendors&party=X` | `/accounting/directory?view=vendors&party=X` |

  These are real `redirect()` calls in `src/app/(app)/accounting/[section]/page.tsx`,
  not middleware pathname rewrites.

## 4. The people directory

There is **one** directory (`/accounting/directory`) and **one** create/edit
flow (`src/app/dashboard/parties/party-form.tsx`). The directory has views:

`all` · `customers` · `suppliers` · `vendors` (the supplier record under the
other word) · `employees`

A view is a `?view=` filter over the same component, the same
`/api/parties` endpoint and the same `parties` table. Other apps deep-link
into it with `partyDirectoryHref(view)`.

### Multiple roles per person

Migration `0148_party_roles.sql` adds `parties.roles text[]` beside the
existing `parties.role`:

- `role` stays the **primary** role — every existing query, the accounting-code
  prefix scheme (۱/۲/۳), the employee link and every report keep working
  unchanged;
- `roles` is the full set, kept consistent by a trigger so that *any* writer
  (including old ones and importers) ends up with `role = ANY(roles)`;
- listings filter on `roles && ARRAY[…]`, so one person who is both a customer
  and a supplier appears in both views — one record, one balance, one file.

No data is deleted and no schema is merged: `parties` was already the one
table for all three roles (migration 0137).

## 5. Adding to the menu

- **A new accounting section** — add the key to `ACCOUNTING_SECTION_KEYS`, a
  label to `ACCOUNTING_SECTIONS`, a glyph to `ACCOUNTING_SECTION_ICONS`, a home
  to `ACCOUNTING_NAV_GROUPS`, and (if it is a ledger tool) to
  `LEDGER_WORKSPACE_SECTION_KEYS`. `accounting-workspace.test.ts` fails if it
  ends up in no menu group.
- **A business page the workspace should adopt** — add its href to
  `WORKSPACE_GROUP_SLOTS` in `accounting-workspace.ts`. Do **not** re-declare
  the page: the composer picks it out of the nav the shell already gated, so
  the role/module/feature/permission check stays in one place.

## 6. What did *not* change

- The `(app)` route group and the real top-level routes.
- Middleware: no pathname rewrites were added.
- `/dashboard/*` pages, their guards, their APIs.
- Tenant isolation, app availability, feature flags, role gating.
