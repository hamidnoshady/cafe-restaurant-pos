/**
 * The AI Workspace must be a first-class launcher in the workspace rail.
 *
 * Phase I closed a real navigation gap: `/ai` was excluded from the flat
 * business nav in the workspace shell (its module is filtered out — the AI
 * Workspace is a product launched from the rail, like Growth, not a page of the
 * accounting suite), but no rail launcher had ever replaced that flat entry, so
 * the whole workspace — chat, agents, coworkers, automations, activity,
 * knowledge, usage — was reachable only by typing the address bar.
 *
 * `WORKSPACE_APP_LAUNCHERS` in `dashboard-sidebar.tsx` is the rail's launcher
 * list; a launcher resolves its href by finding one of its candidate routes
 * among the nav's hrefs, so the door only appears if BOTH the launcher lists a
 * route (`/ai`) AND the flat nav still carries that href (it does — see the
 * `دستیار هوشمند` entry in `workspace-shell.tsx`, kept because `ai_assistant`
 * is a lockable feature).
 *
 * This greps the two source files (the same source-of-truth approach
 * `app-shell-nav-doors.test.ts` and `design-lint.test.ts` use) rather than
 * importing the client component, which pulls React and the sidebar context in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SIDEBAR_SOURCE = readFileSync(
  fileURLToPath(new URL("./dashboard-sidebar.tsx", import.meta.url)),
  "utf8",
);
const WORKSPACE_SHELL_SOURCE = readFileSync(
  fileURLToPath(new URL("./workspace-shell.tsx", import.meta.url)),
  "utf8",
);

/** The launcher-list block, isolated so we grep the launchers and nothing else. */
function launcherBlock(): string {
  const start = SIDEBAR_SOURCE.indexOf("WORKSPACE_APP_LAUNCHERS");
  expect(start, "WORKSPACE_APP_LAUNCHERS not found in dashboard-sidebar.tsx").toBeGreaterThan(-1);
  // The array literal ends at the first `];` after the declaration.
  const end = SIDEBAR_SOURCE.indexOf("\n];", start);
  expect(end, "could not find the end of WORKSPACE_APP_LAUNCHERS").toBeGreaterThan(start);
  return SIDEBAR_SOURCE.slice(start, end);
}

describe("the AI Workspace launcher in the rail", () => {
  it("lists an `ai` launcher whose href is the workspace root", () => {
    const block = launcherBlock();
    expect(block).toContain('key: "ai"');
    // The launcher opens the workspace shell at its chat home, not a nested
    // section: `/ai` is where the sub-nav (agents, coworkers, …) is reachable.
    expect(block).toMatch(/hrefs:\s*\[\s*"\/ai"\s*\]/);
  });

  it("keeps the `/ai` flat-nav href the launcher resolves against", () => {
    // A launcher only surfaces if the flat nav still carries the href it looks
    // for. If the `دستیار هوشمند` door ever left `workspace-shell.tsx`, the
    // launcher would silently match nothing and the workspace would vanish
    // from the rail — exactly the bug this test guards.
    expect(WORKSPACE_SHELL_SOURCE).toContain('href: "/ai"');
  });
});
