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
| `npm run test:visual` | **14/14 screens match** | Baselines recorded, reviewed and committed. |

One transient failure is worth recording because the next person will hit it:
`src/app/route-tree.test.ts` → "agrees with the production build" fails against a
**stale `.next` manifest** and passes after `npm run build`. It failed identically
on the unmodified tree (verified by `git stash`), so it is not a regression from
this change.

## Visual regression — run, reviewed, committed

The harness runs. All 14 baselines in `docs/design/visual/` were recorded
against a **production build** with the deterministic fixture, opened and looked
at one by one, and committed as approvals.

**The last three exist because the first eleven proved nothing about the table
migration.** After the migration landed, the suite reported "11 screens match"
— byte-identical. Reading that as a pass would have been wrong: going through
the screen list showed that *not one of the eleven rendered a migrated table*,
so the green run was over untouched code. Three ledger registers were added —
`accounting-chart-of-accounts`, `accounting-expenses`, `accounting-receivables`
— and two of them then photographed **empty states**, which would have frozen
nothing either. `scripts/seed-visual-fixture.ts` was extended with three
expenses and two receivable-raising cheques, and the two baselines re-recorded.
That extension also added accounts `1200` and `5020`, which legitimately changed
the two `accounting-trial-balance` baselines (one extra row, still balanced);
both were re-read before being re-approved.

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

That gap is now **guarded rather than merely disclosed**:
`src/app/reference-screenshots.test.ts` (part of `npm run test:design`, so it
runs in the CI `design-checks` job) asserts that the availability note in
`docs/design-system.md` and the actual contents of `docs/design/reference/`
agree in *both* directions. It fails if the images land and the "they are
missing" note survives — the canon would then be misinforming every future
reader — and it fails if the note is deleted while the images are still absent,
which would imply a pixel-comparison nobody performed.

Both failure directions were verified by probe rather than assumed. Copying a
single PNG into `docs/design/reference/` turned it red with *"1 of 6 approved
screenshots are now present"*; blanking the note turned it red with *"Restore
the note, or add the files"*. `docs/design-system.md` was restored
byte-identical afterwards. When the six originals arrive the test states the
follow-up work: compare each against its baseline in `docs/design/visual/`,
record the outcome and any accepted deviation here, then retire the note and the
test together.

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

## CI status: blocked by account billing, not by this branch

**No CI run exists for the current head, and none can be produced from here.**
This was re-checked rather than assumed, and the evidence is specific:

- The last four `test` runs (`35401522160`, `35402509339`, `35403441324`,
  `35403573105`) all report `failure`. Pulling the annotation for the `type
  check` job of the newest one gives the actual reason, which the run summary
  does not show:

  > The job was not started because recent account payments have failed or your
  > spending limit needs to be increased. Please check the 'Billing & plans'
  > section in your settings

  The job lasted **2 seconds** (22:54:49 → 22:54:51) — it never started. All six
  jobs failed identically and simultaneously.
- The same workflow **succeeded** earlier the same day (run `35358960754`,
  14:52), so the workflow file itself is executable. The block began between
  14:52 and 22:26 and is account-wide, not branch-specific.
- Pushes after `7500402` produced **no run at all**, and `gh pr view
  --json statusCheckRollup` returns empty for head `85490d1`: GitHub has stopped
  scheduling runs entirely.
- `gh run rerun` → "cannot be rerun"; `gh workflow run` → **HTTP 403 Resource
  not accessible by integration**. The available token cannot dispatch
  workflows, so it cannot force the question either.

Only the repository owner can clear this, in **Billing & plans**. Until then
every result in this document is from a local run, and the workflow is
*unexercised* rather than *passing* — those are not the same claim.

### What was verified instead, statically

Since the jobs cannot run, the parts most likely to fail on the first real run
were checked by parsing the workflow rather than by trusting it:

- All five workflow files parse as YAML; `test.yml` defines **7 jobs**.
- `required` fans in all six real jobs, there are **no dangling `needs`**, and
  **no job escapes the gate**.
- **No job anywhere passes `--update`** to the visual harness, so CI can never
  auto-accept a baseline — the standing rule is enforced by the file, not by
  convention.
- `JWT_SECRET` is set at both workflow and job scope to a real 56-character
  value. This matters: the one failure that broke the *local* run was a
  placeholder `JWT_SECRET`, which makes `/api/auth/login` return 500 and the
  harness abort with a message blaming the database. CI is already immune.
- The `visual-regression` job's steps mirror the locally validated recipe
  (`db:dev:start` → migrate → seed → `seed:visual` → `db:app-role` → build →
  start on `BIND_ADDR` → `test:visual`), including the health-poll loop and the
  diff-artifact upload.

## The first real CI run — both failures, and what caused them

Adding the `pull_request` trigger did something this repository had never done:
it ran these jobs automatically. The workflow was **`workflow_dispatch`-only**
before this change ("Manual only — nothing runs on a push or a pull request"),
so the four pre-existing Windows jobs had only ever run when somebody started
them by hand.

First run on PR #672 (run `35401522160`):

| Job | Result |
| --- | --- |
| design checks | **pass** (31s) |
| type check | **pass** (2m14s) |
| unit tests (windows-latest) | **fail** (3m4s) |
| visual regression (ubuntu-latest) | **fail** (6m1s) |
| production build | pass |
| integration tests | pass |

Both failures have since been read and fixed. A note on method, because it
cost real time: `gh run view --log` and `gh run download` are **unusable from
this sandbox** — the log and artifact endpoints time out with `EOF`. The route
that works is the check-run annotations API:

```
gh api repos/<owner>/<repo>/check-runs/<jobId>/annotations
```

That returns the actual failing file, line and assertion text.

### Failure 1 — visual regression: the browser was the wrong Chromium

Every step of the visual job was green — Chromium install, Postgres, migrations,
app role, build, server start — and only the comparison step failed, with a
1.9 MB `visual-diffs` artifact. So the screens rendered correctly and were
compared; they simply did not match. All eleven were over tolerance, which is
the signature of a global rendering change rather than a real regression.

The cause was mine. Playwright's browser CDN is unreachable from this sandbox,
so the baselines were recorded with a Chromium obtained from npm
(`@sparticuz/chromium@153`) — **Chromium 153**. CI runs
`npx playwright install chromium`, which fetches the build pinned by
`playwright@1.56.0`: **141.0.7390.37**. Text rasterises differently between
Chromium majors, so every screen drifted past `MAX_DIFF_RATIO`.

Three different Chromium versions exist in this repo, and conflating them is
the trap:

| Source | Version | What it is for |
| --- | --- | --- |
| `playwright` devDependency, now pinned **exactly** `1.56.0` | 141.0.7390.37 | **the visual baselines** |
| `playwright-core` runtime dependency `^1.61.1` | 149.x | PDF and receipt rendering (`src/lib/pdf-render.ts`, `src/lib/system-print/render.ts`) — a real product code path, deliberately left alone |
| ad-hoc npm `@sparticuz/chromium` | whatever you asked for | local convenience only |

Three things changed as a result:

1. `playwright` is pinned to an exact version. A caret range here silently
   re-pins the browser and invalidates every baseline.
2. `scripts/visual-regression.mjs` declares `EXPECTED_CHROMIUM_VERSION` and
   throws after launch if `browser.version()`'s major differs — **including
   under `--update`**, so a wrong-browser baseline cannot be recorded in the
   first place. The guard was tested by pointing the harness at the 153 binary;
   it refused.
3. All 11 baselines were re-recorded against Chromium **141.0.7390.0**
   (`@sparticuz/chromium@141.0.0`, same major as CI) on a fresh production
   build, then verified with a **6-run loop: 6 pass, 0 fail**. The re-recorded
   images were opened and compared with the old ones — the content is
   identical, including Persian digits and RTL layout. Nothing was accepted to
   make a failure go away; the pixels the check compares are the same pixels,
   drawn by the browser CI actually uses.

Upgrading `playwright` from now on means re-recording all baselines and bumping
`EXPECTED_CHROMIUM_VERSION` in the same commit. That rule is written down in
`docs/design/visual-regression.md`.

### Failure 2 — unit tests: a pre-existing Windows timeout

The annotation named it exactly:

```
src/lib/system-print/discovery.test.ts:78 — Test timed out in 5000ms
```

The `listSystemPrinters` test shells out to `powershell.exe Get-Printer` for
real. The implementation itself allows that call **15 seconds**
(`src/lib/system-print/discovery.ts:50`), but the test relied on vitest's
**5-second** default — so on a cold Windows runner the implementation is still
within its own budget when the test has already given up. The sibling
`scanLanPrinters` test in the same file already carries an explicit `20_000`,
which is the tell that this was an oversight rather than a design.

This is **not** caused by this branch. The file was last touched in the base
commit `6ba5931`; it only became visible because the workflow was manual-only
until this PR added the `pull_request` trigger. It is fixed here anyway, since
this PR is what made it run: the test now gets `20_000` with a comment
explaining the relationship to the implementation's own timeout.
`npx vitest run src/lib/system-print/discovery.test.ts` passes 5/5.

The rest of the suite was swept for the same pattern — tests that await a real
subprocess with the default timeout. `src/app/api/print/scan/route.test.ts`,
`src/app/api/print/system-printers/route.test.ts`, `src/lib/print-agent-client.test.ts`
and `src/lib/system-print/service.test.ts` all mock the transport layer, so
`discovery.test.ts` was the only one.

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

Beyond the status codes, all 14 baseline screenshots were opened and read —
which is how the two bugs above, the two empty-state baselines and the expenses
column clipping were found.

## Lint enforcement was tested, not assumed

A passing lint proves nothing unless it can fail. The table rule was checked by
planting a probe: a component containing a bare `<thead>` was written to
`src/app/(app)/crm/__probe.tsx` and the lint run. It failed with
`(app)/crm/__probe.tsx:2 <thead> without importing DataTable` — so a *new*
hand-rolled table in an unlisted file is caught, and `TABLE_MIGRATION_BACKLOG`
cannot be silently grown. The probe was deleted.

## Remaining deviations

**The table migration is finished.** Every hand-rolled table in the four tenant
apps composes `DataTable`, across 35 tables in 28 files. The
`TABLE_MIGRATION_BACKLOG` exception list was **deleted rather than shortened**:
the lint rule is now unconditional, so any new `<thead>` in a non-operational
tenant file fails immediately. That was re-verified after the constant was
removed by reintroducing a hand-rolled `<thead>` and watching the rule name the
file and line.

What still deviates, in the order it should be done, is in
[`docs/design/coverage-matrix.md`](coverage-matrix.md):

1. **The expenses register clips its amount column at 1440px.** Its table sets
   `tableClassName="min-w-[56rem]"` inside a content column narrower than that,
   so `DataTable`'s `overflow-x-auto` kicks in and the right-hand money column
   scrolls out of frame — visible in the `accounting-expenses` baseline. This is
   pre-existing (the `min-w` came over unchanged from the hand-rolled table; the
   migration did not introduce it) and it is a real horizontal scroll, not a
   broken layout. Fixing it means deciding which of its seven columns collapses
   first, which is a content decision, so it was not changed blind. Recorded
   here rather than hidden by re-framing the screenshot.
2. **Six search fields** still position their own magnifier. Each differs from
   `SearchField` in a real way (clear button at a different offset, a combobox,
   a nav filter), so they need the component to grow a prop rather than a
   copy-paste. Left deliberately.
3. **~15 mobile card fallbacks** duplicate each other's shape beside the tables.
   A `DataTableMobileList` would remove them; they are live and each renders
   different fields, so they were not touched blind. Note that migrating the
   tables did *not* touch these: keeping the two halves separate is what made
   the table diffs reviewable.
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
4. The deviations above, and whether item 5 should block or follow.
