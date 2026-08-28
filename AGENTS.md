# AGENTS.md

Guidance for every AI coding agent working in this repository — Claude, Codex, Cursor,
Copilot, or anything else.

**Read [CLAUDE.md](CLAUDE.md) first.** It is this repo's full agent guidance (testing gate,
multi-business tenancy, the business day, payment ways, dashboard UI rules, phase layout)
and applies to you whatever tool you run in. Two things cause the most damage when missed:

- **The only quality gate is the local checklist** in CLAUDE.md — `npx tsc --noEmit`,
  `npm test`, `npm run test:db` (needs the Docker Postgres), `npm run build` — run in full
  before a change is "done". There is no CI; nobody else runs it for you. Say which steps
  you actually ran.
- **Tenancy**: a new tenant-scoped table needs an RLS policy in the same migration, and
  `withoutTenantScope()` is a documented, countable hole — never add one without matching an
  already-justified shape in `src/lib/db.ts`.

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
