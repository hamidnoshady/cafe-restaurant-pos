/**
 * The workspace rail launches exactly the four apps — nothing else.
 *
 * The assistant is not a launcher any more: it IS the rail's home
 * («دستیار هوشمند» opens the dashboard chat it sits on), so an `ai` launcher
 * beside «حسابداری» would be a door into the room you are already standing in.
 * The «اتصال‌های فنی» technical hub is not one either: it is a shell utility
 * whose door is the platform user menu, not the app rail. What remains in
 * `WORKSPACE_APP_LAUNCHERS` is the four products — حسابداری، ارتباط با مشتری،
 * رشد و بازاریابی، مدیریت وب‌سایت — each keyed by a real `AppKey`, so app
 * availability can badge every one of them.
 *
 * AI-rebuild Part 1: the rail carries NO chat navigation. The old
 * «گفت‌وگوی جدید» entry (a duplicate of the chat header's control) is gone,
 * and the retired «نخ‌های اخیر» widget moved to the chat page's own left
 * sidebar as «گفتگوهای اخیر» (ai-conversations-sidebar.tsx) with search,
 * rename, delete and continue. These source greps pin that regression: the
 * rail must not grow a second «new chat» door or a second history list.
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

/** The rail's own function block, isolated so the greps describe the rail alone. */
function railBlock(): string {
  const start = SIDEBAR_SOURCE.indexOf("function WorkspaceRail");
  expect(start, "WorkspaceRail not found in dashboard-sidebar.tsx").toBeGreaterThan(-1);
  const end = SIDEBAR_SOURCE.indexOf("\nfunction SidebarBrand", start);
  expect(end, "could not find the end of WorkspaceRail").toBeGreaterThan(start);
  return SIDEBAR_SOURCE.slice(start, end);
}

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
    expect(keys).toEqual(["accounting", "crm", "growth", "website"]);
    // No assistant launcher: the assistant IS the rail's chat home, and its
    // old `/ai` address redirects there.
    expect(block).not.toContain('key: "ai"');
    expect(block).not.toContain('"/ai"');
    expect(block).not.toContain("دستیار هوشمند");
  });

  it("anchors the assistant (info, not a chat CTA) and projects in the rail's own «میز کار» group", () => {
    expect(SIDEBAR_SOURCE).toContain("دستیار هوشمند");
    expect(SIDEBAR_SOURCE).toContain("پروژه‌ها");
  });

  it("keeps chat navigation out of the rail — one «new chat» control, history on the chat page", () => {
    const rail = railBlock();
    // «گفت‌وگوی جدید» lives ONLY in the chat surfaces' headers (the hub header
    // and the floating window header); the rail must not duplicate it.
    expect(rail).not.toContain("گفت‌وگوی جدید");
    // The retired rail history widget is gone from the rail; its replacement
    // is the chat page's own sidebar component.
    expect(rail).not.toContain("AiRecentConversations");
    expect(rail).not.toContain("نخ‌های اخیر");
    expect(rail).toContain("دستیار هوشمند");
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
