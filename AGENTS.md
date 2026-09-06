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

How the user names things in prompts — full version in the "Prompt vocabulary" section of
CLAUDE.md. Don't assume the everyday English sense:

- **Platform** = this whole repo / product. Not `src/app/platform/**` (that's the
  super-admin console) unless they also say super-admin / platform console.
- **App** = a dashboard app from `src/lib/apps.ts` (accounting, growth, CRM, sales,
  operations, website, WP manager, …). Not the Next.js app, not the Electron desktop
  app, not the WordPress plugin. The AI assistant is not an app.
- **Section** = a menu item / page **inside** an app (loyalty inside Growth; products
  inside the WP manager; deals inside CRM) — never the app itself. When the user says
  "section" they mean those **items in apps**. App availability / enable-and-disable in
  the super-admin console (migration 0128) is **per app**, never per section; a section
  follows its owning app's state. Don't add a per-section enable/disable table.
- **AI assistant** = the platform's main page: `/dashboard` (workspace on) and
  `/dashboard/ai`. Not MCP, coworker jobs, or autopilot unless those are named.
- **Website management** = **both** website systems: Eshobe CMS (`website` app,
  `/dashboard/website`) **and** WP / Woo management (`wp` app, `/dashboard/wp`). They
  are peers; never fold one into the other, and don't default "website management" to
  only the CMS.

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
  digits are display-only; money is Toman text via `formatMoneyText`.
- Hovers are quiet washes (`hover:bg-stone-50`); motion is 150–650 ms ease-out, skeletons
  instead of spinners, and `prefers-reduced-motion` is respected.
- When prose and a screenshot disagree, the screenshot wins.
