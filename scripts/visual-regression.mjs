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
  { id: "accounting-trial-balance", path: "/accounting/trial-balance", theme: "light" },
  { id: "accounting-trial-balance-dark", path: "/accounting/trial-balance", theme: "dark" },
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

  // `VISUAL_CHROMIUM_PATH` lets a sandbox that cannot reach Playwright's CDN
  // point at a Chromium it obtained another way. CI leaves it unset and uses
  // the pinned browser `npx playwright install chromium` downloads, which is
  // what keeps the baselines comparable run to run.
  const executablePath = process.env.VISUAL_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    // Needed only for the unprivileged-container case above; harmless in CI.
    args: executablePath ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });
  /** Identical for every screen — the determinism contract lives here. */
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    // The app kills every animation under this, so shots are of final frames.
    reducedMotion: "reduce",
  };

  // Log in once and keep the session, so each screen can still get a *fresh*
  // context. A fresh context per screen matters: init scripts accumulate on a
  // page, so reusing one context would leave every previous screen's theme
  // script attached and make the result depend on iteration order.
  const authContext = await browser.newContext(contextOptions);
  const login = await authContext.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`login failed (${login.status()}) — is the seeded database up?`);
  }
  const storageState = await authContext.storageState();
  await authContext.close();

  const failures = [];
  const recorded = [];
  /** Screens still showing a loading region when photographed — reported, not hidden. */
  const busyAtCapture = [];
  /** Screens whose DOM never stopped changing — the other flake source. */
  const unsettled = [];

  for (const screen of SCREENS) {
    const context = await browser.newContext({
      ...contextOptions,
      storageState,
      colorScheme: screen.theme,
    });
    // next-themes persists the choice in localStorage under "theme" (not a
    // cookie), and the provider is `defaultTheme="system" enableSystem`. Set
    // both: the storage key pins the explicit choice, and `colorScheme` makes
    // the `system` path resolve the same way if storage is ever cleared. It
    // must be an init script so the value is present before the provider's
    // blocking script runs, otherwise the first paint is the wrong theme.
    await context.addInitScript(
      (theme) => window.localStorage.setItem("theme", theme),
      screen.theme,
    );
    const page = await context.newPage();
    // NOT `networkidle`: this app holds an open WebSocket for live sync, so
    // the network is never idle and every navigation would time out. Wait for
    // the document, then for the app's own "finished loading" signal below.
    await page.goto(`${BASE_URL}${screen.path}`, { waitUntil: "domcontentloaded" });

    // The loaded state, not a race with it: every data region in this app
    // renders a role=status skeleton while fetching.
    // Three conditions, because any one alone is a lie:
    //  - a page that has not yet rendered its skeletons also reports zero
    //    busy regions, so require the shell to exist first;
    //  - `aria-busy` is only set by *standalone* skeletons — a `KpiRowSkeleton`
    //    composed inside a larger fallback deliberately omits it, so a screen
    //    can be mid-load with no busy attribute anywhere. Every skeleton,
    //    standalone or not, carries `data-slot="skeleton"`; that is the
    //    reliable signal.
    //  - and the DOM must then hold still, so we do not photograph the frame
    //    between "skeleton removed" and "content painted".
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll("main, [data-page-shell]").length > 0 &&
          document.querySelectorAll('[aria-busy="true"]').length === 0 &&
          document.querySelectorAll('[data-slot="skeleton"]').length === 0,
        null,
        { timeout: 45_000 },
      )
      .catch(() => {
        busyAtCapture.push(screen.id);
      });

    // Settled, not merely loaded. Without this the suite is ~10% flaky: a
    // screen whose data arrives in two waves briefly shows content, so the
    // condition above passes, and the shot lands before the second render.
    await page.waitForFunction(
      () => {
        const w = window;
        const now = document.body.innerHTML.length;
        const stable = w.__vrLast === now ? (w.__vrStable ?? 0) + 1 : 0;
        w.__vrLast = now;
        w.__vrStable = stable;
        return stable >= 3;
      },
      null,
      { timeout: 20_000, polling: 150 },
    ).catch(() => {
      unsettled.push(screen.id);
    });

    // Fonts settled — Vazirmatn loads via next/font and reflows text if early.
    await page.evaluate(() => document.fonts.ready);

    // Assert the theme actually applied, rather than trusting it. A dark
    // baseline recorded from a light render is worse than no baseline.
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (isDark !== (screen.theme === "dark")) {
      throw new Error(
        `${screen.id}: expected the ${screen.theme} theme but the page rendered ` +
          `${isDark ? "dark" : "light"}. Refusing to record a mislabelled baseline.`,
      );
    }

    const actual = await page.screenshot({ fullPage: false });
    await context.close();
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

  if (unsettled.length > 0) {
    console.warn(
      `\nDOM never settled before capture: ${unsettled.join(", ")}.` +
        "\nThat screen re-renders indefinitely (a polling timer, an animation the" +
        "\nreduced-motion rule misses). Its baseline will be flaky until that stops.",
    );
  }
  if (busyAtCapture.length > 0) {
    console.warn(
      `\nStill loading when photographed: ${busyAtCapture.join(", ")}.` +
        "\nThat baseline captures a skeleton, which will be unstable. Fix the wait" +
        "\nor the screen before trusting it.",
    );
  }
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
