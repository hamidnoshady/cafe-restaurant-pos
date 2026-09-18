# Visual regression — how the approved look is held

The design lints (`npm run test:design`) catch *code* drift: a cool neutral, a
hand-rolled table, a re-derived chip. They cannot catch a screen that uses all
the right primitives and still looks wrong — a card that lost its padding, a
table whose columns collapsed, a dark-mode surface that went white.

That is what this check is for. It renders representative screens of all four
apps and compares them, pixel by pixel, with committed baseline images.

## Running it

```bash
npm run db:dev:start && npm run db:migrate && npm run db:seed   # deterministic data
npm run build && npm start &                                    # or `npm run dev`
npm run test:visual
```

It also runs on every pull request (`.github/workflows/test.yml`, job
`visual-regression`) and is one of the jobs the `required` status check fans in.

## What is covered

| Baseline | App | What it establishes |
| --- | --- | --- |
| `accounting-trial-balance` | Accounting | Table hierarchy, header wash, numeric columns, status pill, amber eyebrow |
| `accounting-trial-balance-dark` | Accounting | The same screen in dark mode — the tokens must flip, nothing hardcoded |
| `accounting-orders` | Accounting | Page header, search + filter chips, order queue, rich empty states |
| `accounting-inventory` | Accounting | Section nav, form card, filters, data table, status badges |
| `crm-overview` | CRM | KPI tiles, section cards |
| `crm-deals` | CRM | Pipeline columns on the shared card skin |
| `growth-overview` | Growth and Marketing | KPI tiles |
| `growth-customers` | Growth and Marketing | Migrated data table |
| `websites-cms` | Website Management (Eshobe CMS) | Manager landing, stacked cards |
| `websites-wp` | Website Management (WP/Woo) | The peer manager — deliberately its own screen, not the CMS's |
| `settings-business` | Settings | Section nav, stacked form cards, selected money-unit control |

## Determinism

A flaky snapshot gets ignored, and an ignored check is not a check. So the
harness pins everything that can move:

- **viewport** 1440×900 at DPR 1, set on the browser context;
- **timezone** `Asia/Tehran` and **locale** `fa-IR`, so Jalali dates and Persian
  digits render identically regardless of the machine;
- **`prefers-reduced-motion: reduce`** — the app honours this globally, which
  parks every transition, skeleton shimmer and staggered entry at its final
  frame instead of photographing it mid-animation;
- **seeded demo data** (`npm run db:seed`), never production data;
- **waits for the loaded state**: every data region in this app renders an
  `aria-busy="true"` skeleton while fetching, so the harness waits for those to
  clear, then for `document.fonts.ready` (Vazirmatn reflows text if it is early).

Per-pixel tolerance is 0.1% of pixels, with a per-channel threshold of 12/255.
That absorbs font antialiasing differences between machines while still failing
on any real change — a wrong colour, a missing border or a shifted card moves
whole percent, not hundredths.

## Reviewing a failure — read this before touching a baseline

When the job fails it writes `docs/design/visual/__diff__/<id>.actual.png` and
`<id>.diff.png` (changed pixels in red) and uploads them as a CI artifact.

**A diff is either a bug you introduced or a design change you can describe.**

1. Open the diff image. Find *what* moved.
2. If it is a regression — fix the code. Do not touch the baseline.
3. If it is an intended design change — say so in the pull request body, in
   words: which screens change, what changes about them, and why. Then
   re-record with `npm run test:visual:update`, and **commit the new images as
   part of that same reviewed change** so a human sees the before and after
   side by side in the diff.

**Never run `--update` to make a red run go green.** A baseline is an approval,
not a cache. Re-recording without reading the diff silently converts a
regression into the new normal, which is exactly the failure mode this check
exists to prevent.

## Adding a screen

Add an entry to `SCREENS` in `scripts/visual-regression.mjs`, run
`npm run test:visual` once to record it, look at the resulting PNG, and commit
it with the change. Prefer screens that are the canonical example of a shared
pattern over screens that merely look good. Keep the list short: this check is
valuable in proportion to how seriously each failure is taken, and a
fifty-screen suite trains people to skim.

## How the harness avoids flake (and how that was verified)

A visual check that fails at random gets ignored, and an ignored check is worse
than none — it costs CI minutes and teaches people to re-record. Four things
were wrong in the first draft, each found by running the suite rather than by
reading it:

1. **`networkidle` never fires.** The app holds an open WebSocket for live sync,
   so every navigation timed out. The harness waits for `domcontentloaded` and
   then for the app's own readiness signals.
2. **`aria-busy` is not enough.** Only *standalone* skeletons set it; a
   `KpiRowSkeleton` composed inside a larger fallback deliberately omits it, so
   a screen could be mid-load with no busy attribute anywhere. The wait also
   requires zero `[data-slot="skeleton"]` nodes, which every skeleton carries.
3. **Loaded is not settled.** A screen whose data arrives in two waves passes
   the condition above during the gap. The harness then waits for the DOM to
   stop changing across three consecutive polls.
4. **The dev server compiles on demand.** Baselines must be recorded against a
   production build; `next dev` races a webpack compile on first visit to each
   route and photographs a half-rendered page.

Before (1)–(4), a 5-run loop produced two failures with diffs up to 42%. After,
**8 consecutive runs passed with zero diffs**. If you change the wait logic,
re-run that loop; one green run proves nothing.

## Deterministic data

`npm run db:seed` seeds only enough to log in, so every table photographs as its
empty state — a baseline that cannot catch a regression in how a row, an amount
or a badge renders. `npm run db:seed:visual` adds a fixed cast on top: four
accounts with two balanced journal entries, three stock items, three parties and
three CRM deals.

Every value in that fixture is hard-coded. No `Math.random`, no `new Date()`, no
faker — a fixture that varies produces a baseline that disagrees with itself on
the next run. It is idempotent (keyed on natural keys), so running it twice
before a re-record does not double the data.

## The browser

CI uses the Chromium pinned by the `playwright` dependency, via
`npx playwright install chromium`. That pin is what keeps baselines comparable:
a different Chromium renders text differently enough to redden every screen.

If you are in an environment that cannot reach Playwright's CDN, set
`VISUAL_CHROMIUM_PATH` to a Chromium binary you obtained another way. The
harness will use it and add `--no-sandbox`. **Do not commit baselines recorded
from a non-pinned browser** — they will not match CI.
