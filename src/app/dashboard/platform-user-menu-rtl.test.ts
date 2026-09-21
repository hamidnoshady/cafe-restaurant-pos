/**
 * The platform user menu is an RTL-correct Radix dropdown.
 *
 * The document is Persian (`<html dir="rtl">`), but nothing wraps the app in
 * Radix's `DirectionProvider`, so an unconfigured Radix dropdown computes its
 * popper geometry and arrow-key mapping as LTR. In the right-edge sidebar
 * that misreads `align="end"` as a physical edge and can project the panel
 * past the viewport's right side, besides flipping the submenu arrows. The
 * fixes live in `platform-user-menu.tsx`: an explicit `dir` on the root and on
 * the portaled content, and the logical alignment chosen for RTL (`start`),
 * not the alignment that happened to look right under LTR math.
 *
 * This greps the source (the same source-of-truth approach
 * `app-shell-nav-doors.test.ts` uses): the behaviour contracts that matter —
 * Radix stays, route-change closing stays, the dir/alignment pair is exact —
 * are all statically checkable without mounting the menu.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAW_SOURCE = readFileSync(
  fileURLToPath(new URL("./platform-user-menu.tsx", import.meta.url)),
  "utf8",
);

/** The code, with block/line comments blanked — alignment and markup are asserted on what renders, not on what a comment explains. */
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the platform user menu in RTL Persian", () => {
  it("tells Radix the document is right-to-left — on the root and on the portaled content", () => {
    // The root dir feeds the popper's logical alignment and the roving-focus
    // arrow keys…
    expect(SOURCE).toMatch(/<DropdownMenu\s+dir="rtl"/);
    // …and the portaled panel restates it, so the content is right-reading
    // Persian wherever the portal mounts it.
    const content = SOURCE.match(/<DropdownMenuContent[\s\S]*?>/);
    expect(content, "DropdownMenuContent not found").not.toBeNull();
    expect(content![0]).toContain('dir="rtl"');
  });

  it("aligns by the logical start edge, never blindly `end`", () => {
    // With dir="rtl" and the rail on the viewport's right edge, `start` IS
    // the physical right: the panel sits flush with the rail and opens
    // leftward into the screen, so nothing overflows the right edge.
    expect(SOURCE).toContain('align="start"');
    expect(SOURCE).not.toContain('align="end"');
    // Collision padding keeps the flipped/floating panel off the viewport
    // edge on narrow screens.
    expect(SOURCE).toMatch(/collisionPadding/);
  });

  it("renders Persian text right-aligned", () => {
    const content = SOURCE.match(/<DropdownMenuContent[\s\S]*?>/);
    expect(content![0]).toMatch(/text-right/);
  });

  it("stays on the Radix primitive rather than a hand-rolled menu", () => {
    expect(SOURCE).toContain("@/components/ui/dropdown-menu");
    expect(SOURCE).toContain("DropdownMenuContent");
    expect(SOURCE).toContain("DropdownMenuItem");
    // No second implementation of positioning: banned absolute-dropup markup.
    expect(SOURCE).not.toMatch(/bottom-full/);
  });

  it("keeps the keyboard/close behaviours the menu already had", () => {
    // Controlled open state + Radix's built-in Escape/outside-click handling…
    expect(SOURCE).toContain("onOpenChange={setOpen}");
    // …plus closing when the route changes underneath (back button, a
    // redirect from the page below), which Radix does not do on its own.
    expect(SOURCE).toContain("usePathname");
    expect(SOURCE).toMatch(/useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[pathname\]\)/);
  });
});
