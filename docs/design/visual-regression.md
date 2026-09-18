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
