# AGENTS.md

Guidance for every AI coding agent working in this repository — Claude, Codex, Cursor,
Copilot, or anything else.

**Read [CLAUDE.md](CLAUDE.md) first.** It is this repo's full agent guidance (testing gate,
multi-business tenancy, the business day, payment ways, dashboard UI rules, phase layout,
prompt vocabulary) and applies to you whatever tool you run in. Two things cause the most
damage when missed:

- **The only quality gate is the local checklist** in CLAUDE.md — `npx tsc --noEmit`,
  `npm test`, `npm run test:db` (needs the Docker Postgres), `npm run build` — run in full
  before a change is "done". There is no CI; nobody else runs it for you. Say which steps
  you actually ran.
- **Tenancy**: a new tenant-scoped table needs an RLS policy in the same migration, and
  `withoutTenantScope()` is a documented, countable hole — never add one without matching an
  already-justified shape in `src/lib/db.ts`.
- **Shamsi-only dates**: every date shown to a user — in every function and every screen (the
  user/dashboard section and the super-admin/platform section alike), in accounting, loyalty,
  marketing, AI, reports, exports, receipts and notifications — MUST be **Shamsi (Jalali)**.
  Gregorian is only ever internal storage (`timestamptz`/`date`) and the wire/API. Never render a
  raw ISO/Gregorian date to a user, never show a date in a Gregorian calendar, and never use the
  native `<input type="date">` (it opens a Gregorian calendar) — use `JalaliDatePicker`
  (`src/app/dashboard/jalali-date-picker.tsx`). Format every displayed date through
  `src/lib/jalali.ts` (`formatJalali`, `formatShiftWindow`, `jalaliToIsoDate`, `todayJalali`) or
  `Intl.DateTimeFormat` with the `fa-IR` locale (which resolves to the Persian/Shamsi calendar).
  Read the "Shamsi-only dates" section of CLAUDE.md before touching any date.

## Prompt vocabulary

**Product identity rule:** this is a multi-industry platform with exactly four standalone business apps: Accounting, Growth & Marketing, CRM, and Website Management. Sales/POS, operations, inventory, reporting and settings are work areas or shared utilities, not additional apps. The AI assistant is the platform home. Never present the platform as only a café/restaurant POS; hospitality wording belongs in hospitality features. See [docs/app-boundaries.md](docs/app-boundaries.md).

How the user names things in prompts — full version in the "Prompt vocabulary" section of
CLAUDE.md. Don't assume the everyday English sense:

- **Platform** = this whole repo / product. Not `src/app/platform/**` (that's the
  super-admin console) unless they also say super-admin / platform console.
- **App** = one of the four registry keys in `src/lib/apps.ts`: `accounting`, `growth`, `crm`, `website`. Sales/POS and operations belong inside Accounting; settings, connections and AI are shared platform surfaces. The Next.js application, Electron desktop client, WordPress plugin and the two website managers are not extra platform apps.
- **Section** = a menu item / page **inside** an app (loyalty inside Growth; products
  inside the WP manager; deals inside CRM) — never the app itself. When the user says
  "section" they mean those **items in apps**. App availability / enable-and-disable in
  the super-admin console (migration 0128) is **per app**, never per section; a section
  follows its owning app's state. Don't add a per-section enable/disable table.
- **AI assistant** = the platform's main page: `/dashboard` (workspace on) and
  `/dashboard/ai`. Not MCP, coworker jobs, or autopilot unless those are named.
- **Website management** = **both** website systems inside the single `website` app: Eshobe CMS (`/websites/cms`) and WP / Woo management (`/websites/wp`). They are peer managers behind one app door; never fold one into the other, and don't default “website management” to only the CMS.

## Accounting is the primary workspace

«حسابداری» is the business's main work menu, not a ledger tool: its sidebar
holds the business's own work areas (فروش، خرید و انبار، محصولات، عملیات،
گزارش‌ها، تنظیمات) **plus** the ledger as one named group, «فضای کار حسابداری».

Two rules when you touch that menu:

- The business entries are **adopted**, never re-declared. The composer
  (`src/app/(app)/accounting/accounting-workspace.ts`) picks them out of the
  nav the shell already built and already gated, by href. Adding a page to the
  menu is one href in `WORKSPACE_GROUP_SLOTS` — writing a second role/module
  check is the bug this design exists to prevent.
- There is **one** people directory: `/accounting/directory`.
  «مشتریان»، «تأمین‌کنندگان»، «فروشندگان» are `?view=` filters of it
  (`src/lib/party-directory.ts`), over one `parties` table, one `/api/parties`
  endpoint and one add/edit form. A person holds a **set** of roles
  (`parties.roles`, migration 0148) with `parties.role` as the primary one that
  decides the accounting-code prefix — so never add a per-role party screen,
  and never assume one person has one role.

Route/nav map and the legacy-URL table: [`docs/accounting-workspace-ia.md`](docs/accounting-workspace-ia.md).

### Canonical route migration rule

When a business workspace route is moved, **only its new canonical route may be
used by application code, navigation, tests, and documentation**. Move the
`page.tsx` out of the old route tree in the same change so the old URL cannot
render the old app page. Preserve existing bookmarks only through the central
permanent redirect table in `src/lib/app-routes.ts`; never leave a duplicate
legacy page, link to the legacy URL, or add a new legacy URL. In particular,
the operational Accounting workspaces use `/accounting/{section}` — not
`/dashboard/{section}`. Reuse `ACCOUNTING_WORKSPACE_HREFS` and
`accountingProductsHref()` instead of spelling former dashboard work-area URLs.

## Design system

**The visual canon is [`docs/design-system.md`](docs/design-system.md), backed by the
reference screenshots in [`docs/design/reference/`](design/reference/).** Read it before
building or restyling any screen. The short form:

- Dashboard pages/panels compose the primitives in `src/app/dashboard/page-chrome.tsx`
  (`PageShell`, `PageHeader`, `SectionCard`/`cardClass`, `TabBar`/`TabPanel`, `EmptyState`,
  `StatusBadge`) plus `<Button>` and `ui.tsx`'s `inputClass`/`Field`/`ErrorBox`/`InfoBox` —
  never re-derive their classes by hand.
- Warm `stone-*` neutrals on a canvas slightly darker than white cards; 1px warm hairlines;
  the one warm card shadow (`0 1px 2px rgb(41 37 36/0.035)`); `rounded-2xl` cards,
  `rounded-xl` pills, `rounded-lg` controls.
- **Amber = selection** (active nav/tabs/chips, warnings); **teal = brand** (filled buttons,
  links) and the **form focus ring**; emerald/red only for success/danger. Numbers: Persian
  digits are display-only; money uses the business-selected display unit via `formatMoneyText`/`useMoney` (Toman or Rial). Never hard-code a user-facing currency label or divide by 10 directly. Storage, calculations, journal lines, and internal API contracts remain integer Rial; every user input must be converted from the selected unit at the UI/API boundary and every displayed amount must be formatted with the selected unit. If the user selects Rial, inputs, labels, totals, exports, and display text must say Rial; if Toman, they must say Toman.
- Hovers are quiet washes (`hover:bg-stone-50`); motion is 150–650 ms ease-out, skeletons
  instead of spinners, and `prefers-reduced-motion` is respected.
- When prose and a screenshot disagree, the screenshot wins.
