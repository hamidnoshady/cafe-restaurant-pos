# Test results, visual comparisons and remaining deviations

Deliverable 7. Everything below is a result actually observed on this branch,
with the command that produced it. Where something was **not** verified, it says
so rather than implying it passed.

## Automated suites

| Command | Result | Notes |
| --- | --- | --- |
| `npx tsc --noEmit` | **clean** | Run after every migration step, not just at the end. |
| `npm test` | **324 files / 4759 tests passed** | Includes the four design tests below. |
| `npm run test:design` | **4 files / 34 tests passed** | `design-lint` (14) + app `design-lint` (9) + `primitive-lint` (5) + `loading-coverage` (6). |
| `npm run test:db` | **110 files / 1181 passed, 1 skipped** | Integration suite against the embedded Postgres. |
| `npm run build` | **clean** | Full production build; every route compiled. |
| `npm run test:visual` | **not run here — see below** | No browser is installable in this environment. |

One transient failure is worth recording because the next person will hit it:
`src/app/route-tree.test.ts` → "agrees with the production build" fails against a
**stale `.next` manifest** and passes after `npm run build`. It failed identically
on the unmodified tree (verified by `git stash`), so it is not a regression from
this change.

## Visual regression — status is honest

`npm run test:visual` is **authored and wired into CI but has never been
executed**, and **no baseline images are committed**. The reason is
environmental, not a shortcut: this sandbox cannot obtain a browser.
`npx playwright install chromium` fails at `cdn.playwright.dev`
(`SSL_ERROR_SYSCALL`, HTTP 000), the Azure mirror fails the same way,
`--with-deps` aborts on unavailable Debian font packages, and `apt-get install
chromium` fails even as root.

So the honest state is:

- The harness, its determinism settings and its documentation are reviewable now.
- **The first CI run of `visual-regression` will fail** with "no baseline" for
  all 11 screens. That is intended. A human runs `npm run test:visual:update`
  **once**, looks at each of the 11 PNGs, and commits them as the approved
  baseline. From then on a diff is a real diff.
- Do not let that first run be "fixed" by re-running `--update` later. The rule
  in `docs/design/visual-regression.md` is that a baseline is an approval.

**No claim is made anywhere in this PR that a screen was visually verified
against the six approved screenshots.** The screenshots were visible in the
conversation but were never present on the filesystem (`/home/user/uploads/`
does not exist), so they could not be committed to
`docs/design/reference/` and could not be diffed against. Everything in
`docs/design-system.md`'s reference table is a description transcribed from
looking at them, and the section says so explicitly. To close that gap, place the
six PNGs at the filenames listed in that table and the documentation becomes
checkable.

## Manual verification that *was* done

The dev server was run against the seeded database and each migrated route
fetched with an authenticated session:

| Route | Status |
| --- | --- |
| `/accounting/inventory` | 200 |
| `/accounting/products` | 200 |
| `/accounting/stock` | 200 |
| `/crm` | 200 |
| `/growth` | 200 |
| `/websites/cms` | 200 (unauthenticated redirect 307 → 200 with session) |
| `/settings/business` | 200 |

Note for whoever reads the HTML: the server response for these screens is the
**skeleton** (`aria-busy="true"`); the table hydrates on the client. That is why
the visual harness waits for `aria-busy` to clear before it captures, and why
grepping the SSR HTML for table markup finds nothing.

## Lint enforcement was tested, not assumed

A passing lint proves nothing unless it can fail. The table rule was checked by
planting a probe: a component containing a bare `<thead>` was written to
`src/app/(app)/crm/__probe.tsx` and the lint run. It failed with
`(app)/crm/__probe.tsx:2 <thead> without importing DataTable` — so a *new*
hand-rolled table in an unlisted file is caught, and `TABLE_MIGRATION_BACKLOG`
cannot be silently grown. The probe was deleted.

## Remaining deviations

Stated plainly: **the platform is not fully migrated.** What remains, in the
order it should be done, is the Batch A–E checklist in
[`docs/design/coverage-matrix.md`](coverage-matrix.md). The headline items:

1. **28 files still hand-roll a table** (`TABLE_MIGRATION_BACKLOG`). They are
   named, grouped and ordered; the list can only shrink. Migrate
   `dashboard/reports/report-table.tsx` first — three of the four reports files
   are its consumers.
2. **Six search fields** still position their own magnifier. Each differs from
   `SearchField` in a real way (clear button at a different offset, a combobox,
   a nav filter), so they need the component to grow a prop rather than a
   copy-paste. Left deliberately.
3. **~15 mobile card fallbacks** duplicate each other's shape beside the tables.
   A `DataTableMobileList` would remove them; they are live and each renders
   different fields, so they were not touched blind.
4. **The token conflict is real and unresolved in `globals.css`.** `--primary`
   and `--ring` are defined turquoise (`oklch(0.52 0.1 205)` /
   `oklch(0.75 0.105 200)`) while the approved screenshots and the shipped
   components use amber for selection, and `section-nav.tsx` hardcodes amber
   instead of reading `--primary`. The screenshots win, so `globals.css` should
   change — but changing a root token repaints every surface in the product,
   including the out-of-scope `src/app/platform/**`, so it is not something to
   slip into this PR without a visual baseline to diff against. **This is the
   single most important follow-up**, and it should be the first change made
   *after* the baselines are recorded, precisely so the repaint is reviewable.
5. **`src/app/platform/**` is untouched** by design — a deliberate separate
   identity, out of scope.

## What a reviewer should check first

1. `docs/design/coverage-matrix.md` — the measured per-app numbers and the
   decisions, including which apparent inconsistencies are deliberate IA.
2. `docs/design/removed-legacy-code.md` — the removals and the evidence for
   each, plus the list of things deliberately kept.
3. `src/app/dashboard/primitive-lint.test.ts` — the rules, the exemptions and
   the backlog constant. The exemptions are where a lint like this goes wrong,
   so they carry their reasons inline.
4. The deviations above, and whether item 4 should block or follow.
