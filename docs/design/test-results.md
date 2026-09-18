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
| `npm run test:visual` | **11/11 screens match; 8 consecutive runs clean** | Baselines recorded, reviewed and committed. |

One transient failure is worth recording because the next person will hit it:
`src/app/route-tree.test.ts` → "agrees with the production build" fails against a
**stale `.next` manifest** and passes after `npm run build`. It failed identically
on the unmodified tree (verified by `git stash`), so it is not a regression from
this change.

## Visual regression — run, reviewed, committed

The harness runs. All 11 baselines in `docs/design/visual/` were recorded
against a **production build** with the deterministic fixture, opened and looked
at one by one, and committed as approvals.

A browser was obtained by extracting the Chromium that ships inside the
`@sparticuz/chromium` npm package (Playwright's own CDN and the Azure mirror are
both unreachable from this sandbox, and there is no `chromium` apt package).
That is a local workaround only — CI installs the Chromium pinned by the
`playwright` dependency, and `VISUAL_CHROMIUM_PATH` exists so the two paths do
not diverge silently.

### The check was proven to fail, not just to pass

A green suite proves nothing on its own. After fixing the Jalali digit bug, the
suite was re-run against the **existing** baselines and went red on exactly one
screen — `accounting-inventory`, 0.24% of pixels, the date cell and the column
reflow it caused — while the other ten stayed green. That is the behaviour you
want: sensitive to a real change, silent on everything else.

### Determinism was measured, not assumed

The first version of the harness was flaky: a 5-run loop produced two failures
with diffs up to 42%. Four causes, all found by running it:

| Cause | Fix |
| --- | --- |
| `networkidle` never fires — the app holds a sync WebSocket | wait for `domcontentloaded` + the app's own signals |
| `aria-busy` is set only by *standalone* skeletons | also require zero `[data-slot="skeleton"]` |
| "loaded" ≠ "settled" — data arriving in two waves | wait for the DOM to stop changing across three polls |
| `next dev` compiles routes on demand | record against a production build |

After those: **8 consecutive runs, zero diffs.** If you touch the wait logic,
re-run that loop — one green run is not evidence.

### Data determinism

`npm run db:seed` only seeds enough to log in, so the first baselines caught
every table in its empty state — unable to catch a regression in how a row, an
amount or a badge renders. `scripts/seed-visual-fixture.ts` adds a fixed,
idempotent cast (4 accounts, 2 balanced entries, 3 stock items, 3 parties,
3 deals) with no `Math.random` and no `new Date()`.

### Still not verified against the six approved screenshots

**No claim is made that any screen was compared against the user's six
screenshots.** They were visible in the conversation but never present on the
filesystem, so they could not be committed or diffed. The reference table in
`docs/design-system.md` is a transcription and says so. Placing the six PNGs at
the filenames listed there makes that checkable; the baselines now committed
give something concrete to compare them against.

## Bugs the screenshots found

Looking at the rendered output caught two defects that every text-based test in
the repo had passed over:

1. **Latin digits in Jalali dates.** `formatJalali` returned ASCII, so 42 of its
   193 call sites rendered `1404/12/24` beside Persian numerals *in the same
   table row*. The other 151 wrapped it in `toPersianDigits`. Fixed at the
   source rather than per-call-site: it is a display formatter and every caller
   is user-facing text. `toPersianDigits` only rewrites `[0-9]`, so it is
   idempotent and the callers that already wrap it are unaffected — there is now
   a test asserting exactly that, so the reasoning is checked rather than
   trusted. This directly violated the "Persian display digits" requirement.
2. **An eternal skeleton on Website Management → WP.** `overview-section.tsx`
   left `connections` as `null` when the request failed, so a business without
   that manager enabled saw a shimmer forever — no message, no retry. The
   harness flagged it on its own ("still loading when photographed") before a
   human noticed. It now ends the loading state and renders an `EmptyState`
   with the reason and a retry button.

## The first real CI run — and an honest unknown

Adding the `pull_request` trigger did something this repository had never done:
it ran these jobs automatically. The workflow was **`workflow_dispatch`-only**
before this change ("Manual only — nothing runs on a push or a pull request"),
so the four pre-existing Windows jobs had only ever run when somebody started
them by hand.

First run on PR #672:

| Job | Result |
| --- | --- |
| design checks | **pass** (31s) |
| type check | **pass** (2m14s) |
| unit tests (windows-latest) | **fail** (3m4s) |
| visual regression (ubuntu-latest) | **fail** (6m1s) |
| production build | did not finish before the token expired |
| integration tests | did not finish before the token expired |

**I could not read either failure log.** The GitHub token expired partway
through watching the run (`HTTP 401: Bad credentials`), and it has not been
possible to fetch the job output since. So the following is stated as an
open question, not a diagnosis:

- **`npm test` passes locally**, 324 files / 4760 tests, on this exact commit
  with a clean tree — including under `TZ=UTC`, `TZ=America/Los_Angeles` and
  `TZ=Europe/London`, and the two suites that touch the changed `formatJalali`
  (`jalali.test.ts`, `parties-directory-regressions.test.ts`) pass in all of
  them. The CI job is `windows-latest` with no `TZ` set, which is the most
  obvious difference, but that hypothesis was tested and did not reproduce.
- Because the trigger is new, **the Windows unit-test failure may well predate
  this branch** — there is no previous automatic run to compare against. That is
  a real possibility, not an excuse, and it is why this section exists instead
  of a claim that everything is green.
- The visual job's most likely cause is environmental (browser install, the
  production server failing to boot, or the new app-role step), so that job now
  redirects the server's output to `server.log` and prints it on failure, and
  the health poll prints the log when it times out. The next run will say what
  happened instead of just failing.

**What a reviewer should do:** open the two failing jobs on PR #672 and read
them. If the Windows unit-test failure reproduces on `main` with a manual run,
it is pre-existing and should be fixed separately; if it does not, it is from
this branch and I have not found it.

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
**skeleton**; the table hydrates on the client. That is why the visual harness
waits for the skeletons to disappear *and* for the DOM to settle before it
captures, and why grepping the SSR HTML for table markup finds nothing.

Beyond the status codes, all 11 baseline screenshots were opened and read —
which is how the two bugs above were found.

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
4. **The "token conflict" was a misdiagnosis — resolved, no change needed.**
   An earlier pass in this work flagged `globals.css` defining `--primary` and
   `--ring` as teal (`oklch(0.52 0.1 205)`) while the screenshots and
   `section-nav.tsx` use amber, and concluded that `globals.css` had to be
   repainted. **That was wrong, and it is worth recording why rather than
   quietly dropping it.** Teal and amber are two *different roles* in this
   language, exactly as `docs/design-system.md` § Colour roles states: teal is
   **brand** (filled buttons, links, the form focus ring), amber is
   **selection** (active nav, tabs, chips). `section-nav.tsx` hardcodes amber
   because an active nav item is selection, not brand — it should not read
   `--primary`.

   This was settled by measuring the committed baselines rather than by
   re-reading the prose. Sampling `crm-deals.png`: the «معاملهٔ جدید» filled CTA
   is `rgb(0, 121, 132)` — teal, i.e. `--primary` as defined — and the active
   «قیف فروش» sidebar row is `rgb(254, 243, 198)` — amber-100. Both are correct
   and they coexist on one screen, which is the design, not drift.

   Had this been "fixed", every filled button in the product would have turned
   amber and the two-accents-per-screen rule would have collapsed into one. It
   is a good illustration of why a visual baseline is worth having: the
   conflict was invisible to every text-based check and was only disproved by
   looking at pixels.

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
