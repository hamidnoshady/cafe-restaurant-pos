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
the listed filenames makes it checkable.

**The first `visual-regression` CI run will fail** with "no baseline" for all 11
screens — no baselines are committed, because no browser is installable in the
authoring environment (`cdn.playwright.dev` unreachable; details in
`docs/design/test-results.md`). Someone must run `test:visual:update` once, *look
at* the 11 images, and commit them as an approval. Never `--update` again to
clear a red run.

## Not done, on purpose

The platform is **not** fully migrated. 28 tables, six search fields and ~15
mobile card fallbacks remain, ordered as Batch A–E in
`docs/design/coverage-matrix.md`.

The most important follow-up is the unresolved token conflict: `globals.css`
defines `--primary`/`--ring` as turquoise while the approved screenshots and the
shipped components use amber for selection. The screenshots win, so `globals.css`
should change — but repainting a root token touches every surface including the
out-of-scope platform console, so it should be the first change made *after* the
baselines exist, precisely so the repaint is reviewable.

## Gate

`tsc --noEmit` clean · `npm test` 4759/4759 · `npm run test:db` 1181 passed, 1
skipped · `npm run build` clean · `npm run test:design` 34/34 · migrated routes
verified 200 with an authenticated session.
