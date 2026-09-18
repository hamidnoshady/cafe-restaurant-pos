# One design system across the four tenant apps

Five commits on `arena/01a0b61c-cafe-restaurant-pos`, 91 files, +2489/−915.

## Why

Accounting, CRM, Growth & Marketing and Website Management shared a palette but
not a language. `cardClass`/`SectionCard` adoption was already high — the gap
was everything *above and inside* the card: page headers, section navigation,
tables, filter chips and KPI tiles, each re-derived per screen. Three separate
local `StatCard` definitions, three spellings of a filter chip, and thirty
hand-built tables is how two screens of the same product come to look like two
products.

## What changed

**Shared components and tokens.** New `data-table.tsx` (`DataTable`, `Th`,
`Td numeric|muted`) and `filters.tsx` (`FilterChip` with a `dense` prop,
`FilterChipRow`, `SearchField`); `KpiCard`/`KpiRow` and `CardEyebrow` added to
`page-chrome.tsx`. 79 files moved off hardcoded `stone-*` onto theme tokens —
the hardcoded form did not flip in dark mode, which was the actual bug.

**Migrated screens** in all four apps: five tables onto `DataTable`, twelve chip
sites onto `FilterChip`, four search fields onto `SearchField`, three KPI grids
onto `KpiRow`.

**Enforcement that can actually fail.** `primitive-lint.test.ts` is syntax-aware
— it walks the JSX rather than grepping text, because a naive substring rule
flags an amber `aria-pressed` tab strip as a stray chip. Operational surfaces
are exempt by path with the reason written down. The 28 unmigrated tables are an
explicit, ordered, named constant that only shrinks; a new hand-rolled table in
any other file fails, which was verified by planting a probe and watching it go
red. CI gets a `pull_request` trigger plus `design-checks` and
`visual-regression` jobs, both required.

**Removals with evidence** — `docs/design/removed-legacy-code.md` — including
the things deliberately *kept* and why, so this is not re-litigated. Nothing was
removed on the strength of a filename or an import grep; the sweep counts every
mention, so re-exports and dynamic use count as consumers. That is how the six
`.ops-*` CSS animations were caught as live-but-single-consumer rather than dead.

**Docs**: a decision guide (need → component) in `docs/design-system.md`, an
explicit boundary on when the POS's density is allowed, plus coverage matrix,
visual-regression procedure and test results. `AGENTS.md`, `CLAUDE.md` and
`docs/ui-conventions.md` updated to match, so there is one definition of the
approved design rather than two.

## Two things to read before approving

**No visual verification against the six approved screenshots was performed.**
They were visible in the conversation but never present on the filesystem, so
they could not be committed or diffed. The reference table in
`docs/design-system.md` is a transcription and says so. Placing the six PNGs at
the listed filenames makes it checkable — and the 11 committed baselines now
give something concrete to compare them against.

**The visual check runs and its baselines are committed.** All 11 were recorded
against a production build with a deterministic fixture, opened and reviewed one
by one. Running it end to end is what found the two bugs below, and forced four
fixes to the harness itself: a 5-run loop went from two failures (diffs up to
42%) to 8/8 clean. The check was also proven able to *fail* — after the Jalali
fix it went red on exactly the one affected screen (0.24%) and stayed green on
the other ten.

## Two bugs the pixels found

Both had passed every text-based test in the repo:

- **Latin digits in Jalali dates.** `formatJalali` returned ASCII, so 42 of its
  193 call sites rendered `1404/12/24` beside Persian numerals in the same table
  row — a direct violation of the Persian-digits requirement. Fixed at the
  source, with a test asserting the idempotence that made that safe.
- **An eternal skeleton** on Website Management → WP: a failed load left the
  state `null`, so a business without that manager saw a shimmer forever with no
  message and no retry. Now a proper `EmptyState`.

## Not done, on purpose

The platform is **not** fully migrated. 28 tables, six search fields and ~15
mobile card fallbacks remain, ordered as Batch A–E in
`docs/design/coverage-matrix.md`.

An earlier pass in this work flagged a "token conflict" — `globals.css` defining
`--primary` as teal while the screenshots use amber — and proposed repainting the
root token. **Measuring the baselines disproved it.** Teal is *brand* (filled
buttons, links, focus ring) and amber is *selection* (active nav, tabs, chips);
sampling `crm-deals.png` shows the CTA at `rgb(0,121,132)` and the active nav row
at `rgb(254,243,198)`, coexisting correctly on one screen. Had it been "fixed",
every filled button in the product would have turned amber. The reasoning is
recorded in `docs/design/test-results.md` rather than dropped.

## Gate

`tsc --noEmit` clean · `npm test` 4760/4760 · `npm run test:db` 1181 passed, 1
skipped · `npm run build` clean · `npm run test:design` 34/34 ·
`npm run test:visual` 11/11, clean on 8 consecutive runs · migrated routes
verified 200 with an authenticated session.
