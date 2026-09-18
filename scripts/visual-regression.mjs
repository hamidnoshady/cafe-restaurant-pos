/**
 * Visual regression for the approved design system.
 *
 * Renders a short, deliberately-chosen list of screens — at least one per app,
 * including both Website Management managers — in a pinned Chromium and
 * compares each against a committed PNG baseline.
 *
 * Determinism is the whole game here; a flaky snapshot gets ignored, and an
 * ignored check is not a check. So:
 *
 *  - one viewport (1440×900, DPR 1) and one timezone (Asia/Tehran), set on the
 *    browser context rather than inherited from the machine;
 *  - `prefers-reduced-motion: reduce`, which the app already honours globally —
 *    this parks every transition, skeleton shimmer and staggered entry at its
 *    final frame instead of photographing them mid-animation;
 *  - the seeded demo business, never production data;
 *  - each shot waits for the page's loading skeletons to disappear, so a
 *    snapshot is of the loaded state rather than a race with it.
 *
 * Baselines live next to this harness's output in docs/design/visual/. They are
 * reviewed as images in the PR. **Never re-record a baseline to clear a failing
 * run** — read docs/design/visual-regression.md first; a diff is either a bug
 * you introduced or a design change you can describe in the PR body.
 *
 * Usage:
 *   node scripts/visual-regression.mjs            # compare against baselines
 *   node scripts/visual-regression.mjs --update   # re-record (deliberate only)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_DIR = join(ROOT, "docs", "design", "visual");
const DIFF_DIR = join(BASELINE_DIR, "__diff__");

const BASE_URL = process.env.VISUAL_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const UPDATE = process.argv.includes("--update");

/**
 * Per-pixel tolerance. Text antialiasing differs by a hair between machines
 * even with the same browser build, so an exact match would be permanently
 * red; 0.1% of pixels is far below any real visual change (a wrong colour, a
 * missing border, a shifted card all move percent, not hundredths).
 */
const MAX_DIFF_RATIO = 0.001;

/**
 * The screens under watch — one or more per app, chosen because each is the
 * canonical example of a shared pattern rather than because it is pretty.
 *
 * `theme` covers the language's two surfaces; `state` names a non-default
 * interaction worth freezing (an empty list, a focused control).
 */
const SCREENS = [
  // — Accounting — the reference trial balance: table hierarchy + status pill.
  { id: "accounting-trial-balance", path: "/accounting/ledger", theme: "light" },
  { id: "accounting-trial-balance-dark", path: "/accounting/ledger", theme: "dark" },
  // — Accounting — the orders queue: filter chips, search, rich empty state.
  { id: "accounting-orders", path: "/accounting/orders", theme: "light" },
  // — Accounting — inventory: section nav, form card, filters, data table.
  { id: "accounting-inventory", path: "/accounting/inventory", theme: "light" },
  // — CRM —
  { id: "crm-overview", path: "/crm/overview", theme: "light" },
  { id: "crm-deals", path: "/crm/deals", theme: "light" },
  // — Growth and Marketing —
  { id: "growth-overview", path: "/growth/overview", theme: "light" },
  { id: "growth-customers", path: "/growth/customers", theme: "light" },
  // — Website Management: both peer managers —
  { id: "websites-cms", path: "/websites/cms", theme: "light" },
  { id: "websites-wp", path: "/websites/wp", theme: "light" },
  // — Business settings: the selected money-unit control —
  { id: "settings-business", path: "/settings", theme: "light" },
];

function comparePng(actualBuf, expectedBuf) {
  const a = PNG.sync.read(actualBuf);
  const b = PNG.sync.read(expectedBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { mismatch: 1, reason: `size ${a.width}×${a.height} vs ${b.width}×${b.height}`, diff: null };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    // A small per-channel delta is antialiasing, not a design change.
    const differs = dr > 12 || dg > 12 || db > 12;
    if (differs) changed++;
    diff.data[i] = differs ? 255 : a.data[i];
    diff.data[i + 1] = differs ? 0 : a.data[i + 1];
    diff.data[i + 2] = differs ? 0 : a.data[i + 2];
    diff.data[i + 3] = 255;
  }
  return { mismatch: changed / (a.width * a.height), reason: null, diff: PNG.sync.write(diff) };
}

async function main() {
  mkdirSync(BASELINE_DIR, { recursive: true });
  rmSync(DIFF_DIR, { recursive: true, force: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    // The app kills every animation under this, so shots are of final frames.
    reducedMotion: "reduce",
  });

  const page = await context.newPage();

  // Log in once; the session cookie carries to every screen.
  const login = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`login failed (${login.status()}) — is the seeded database up?`);
  }

  const failures = [];
  const recorded = [];

  for (const screen of SCREENS) {
    await context.addCookies([
      {
        name: "theme",
        value: screen.theme,
        url: BASE_URL,
      },
    ]);
    await page.emulateMedia({ colorScheme: screen.theme });
    await page.goto(`${BASE_URL}${screen.path}`, { waitUntil: "networkidle" });

    // The loaded state, not a race with it: every data region in this app
    // renders a role=status skeleton while fetching.
    await page
      .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, {
        timeout: 20_000,
      })
      .catch(() => {
        /* A screen with a permanently busy region still gets photographed. */
      });
    // Fonts settled — Vazirmatn loads via next/font and reflows text if early.
    await page.evaluate(() => document.fonts.ready);

    const actual = await page.screenshot({ fullPage: false });
    const baselinePath = join(BASELINE_DIR, `${screen.id}.png`);

    if (UPDATE || !existsSync(baselinePath)) {
      writeFileSync(baselinePath, actual);
      recorded.push(screen.id);
      continue;
    }

    const { mismatch, reason, diff } = comparePng(actual, readFileSync(baselinePath));
    if (mismatch > MAX_DIFF_RATIO) {
      mkdirSync(DIFF_DIR, { recursive: true });
      writeFileSync(join(DIFF_DIR, `${screen.id}.actual.png`), actual);
      if (diff) writeFileSync(join(DIFF_DIR, `${screen.id}.diff.png`), diff);
      failures.push(
        `${screen.id}: ${reason ?? `${(mismatch * 100).toFixed(2)}% of pixels changed`}`,
      );
    }
  }

  await browser.close();

  if (recorded.length > 0) {
    console.log(`Recorded ${recorded.length} baseline(s): ${recorded.join(", ")}`);
    console.log("Review each image before committing — a baseline is an approval.");
  }
  if (failures.length > 0) {
    console.error("\nVisual regressions:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    console.error(
      "\nDiffs written to docs/design/visual/__diff__/." +
        "\nDo NOT re-record to clear this. Read docs/design/visual-regression.md:" +
        "\na diff is either a bug you introduced or a design change to describe.",
    );
    process.exit(1);
  }
  console.log(`Visual regression: ${SCREENS.length} screen(s) match their baselines.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
