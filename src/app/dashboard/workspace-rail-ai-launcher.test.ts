/**
 * The workspace rail launches exactly the four apps — nothing else.
 *
 * The assistant is not a launcher any more: it IS the rail's home («گفت‌وگوی
 * جدید» opens the dashboard chat it sits on), so an `ai` launcher beside
 * «حسابداری» would be a door into the room you are already standing in. The
 * «اتصال‌های فنی» technical hub is not one either: it is a shell utility whose
 * door is the platform user menu, not the app rail. What remains in
 * `WORKSPACE_APP_LAUNCHERS` is the four products — حسابداری، رشد و بازاریابی،
 * ارتباط با مشتری، مدیریت وب‌سایت — each keyed by a real `AppKey`, so app
 * availability can badge every one of them.
 *
 * The rail's «میز کار» group (گفت‌وگوی جدید و پروژه‌ها) anchors the assistant
 * and its project workspaces instead, and the flat `دستیار هوشمند` nav entry
 * is gone from `workspace-shell.tsx` for the same reason.
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

describe("the workspace rail's app launchers", () => {
  it("lists exactly the four apps — the assistant is home, not an app", () => {
    const block = launcherBlock();
    // The four products, in rail order.
    const keys = [...block.matchAll(/key: "(\w+)"/g)].map((match) => match[1]);
    expect(keys).toEqual(["accounting", "growth", "crm", "website"]);
    // No assistant launcher: the assistant IS the rail's chat home, and its
    // old `/ai` address redirects there.
    expect(block).not.toContain('key: "ai"');
    expect(block).not.toContain('"/ai"');
    expect(block).not.toContain("دستیار هوشمند");
  });

  it("anchors the assistant and projects in the rail's own «میز کار» group", () => {
    expect(SIDEBAR_SOURCE).toContain("گفت‌وگوی جدید");
    expect(SIDEBAR_SOURCE).toContain("پروژه‌ها");
  });

  it("keeps the technical-connections hub and the assistant out of the rail and the flat nav", () => {
    // No PlugIcon hub row in the rail — «اتصال‌های فنی» opens from the
    // platform user menu instead (its feature at `/settings/connections` is
    // untouched), and no second door appears here. (The words may still live
    // in comments explaining the move; code is what is asserted.)
    expect(SIDEBAR_SOURCE).not.toContain("PlugIcon");
    expect(SIDEBAR_SOURCE).not.toMatch(/href=\{?"\/settings\/connections/);
    // Neither retired surface is a flat-nav entry any more: the old dashboard
    // was replaced by the chat home, and the assistant by the same chat home.
    expect(WORKSPACE_SHELL_SOURCE).not.toContain('href: "/ai"');
    expect(WORKSPACE_SHELL_SOURCE).not.toContain('href: "/overview"');
    expect(WORKSPACE_SHELL_SOURCE).not.toContain('label: "دستیار هوشمند"');
    expect(WORKSPACE_SHELL_SOURCE).not.toContain('label: "اتصال‌های فنی"');
  });
});
