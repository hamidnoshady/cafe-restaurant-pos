import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The RTL and structural rules the Accounting menu and the party form have to
 * keep.
 *
 * This suite greps the sources — the approach `design-lint.test.ts` and
 * `app-shell-nav-doors.test.ts` already use — because the repo's vitest runs in
 * Node with no jsdom and no `@testing-library`, so a client component cannot be
 * mounted here. Grepping is not as good as rendering, but it holds the exact
 * lines that broke before: a physical `left`/`right` inset that mirrors wrongly
 * in Persian, a chevron that points the wrong way, a group heading that is a
 * `<div>` with no expanded state, a dialog whose only exit discards a filled
 * form without asking.
 */

const NAV_SOURCE = readFileSync(
  fileURLToPath(new URL("./accounting-app-nav.tsx", import.meta.url)),
  "utf8",
);
/**
 * The groups themselves are drawn by the shared component now, so the rules
 * about indentation, chevrons and disclosure state are checked there — the
 * menu file only composes it.
 */
const GROUP_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/sidebar-nav-group.tsx", import.meta.url)),
  "utf8",
);
const FORM_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/parties/party-form.tsx", import.meta.url)),
  "utf8",
);
const SECTION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/parties/parties-section.tsx", import.meta.url)),
  "utf8",
);

/** Physical-direction utilities, which mirror wrongly under `dir="rtl"`. */
const PHYSICAL_CLASSES =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;

/** The same idea for the bare positional ones. */
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalClassesIn(source: string): string[] {
  return [...(source.match(PHYSICAL_CLASSES) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

describe("the Accounting menu is written for RTL", () => {
  it("uses logical insets, never physical left/right ones", () => {
    // `ms`/`me`/`ps`/`pe`/`border-s`/`text-start` flip with the document
    // direction; `ml`/`pr`/`text-left` do not, and are how a Persian sidebar
    // ends up with its rule on the wrong edge.
    expect(physicalClassesIn(NAV_SOURCE)).toEqual([]);
    expect(physicalClassesIn(GROUP_SOURCE)).toEqual([]);
  });

  it("ties a group's children to their heading with a start-side rule", () => {
    expect(GROUP_SOURCE).toMatch(/border-s\b/);
    expect(GROUP_SOURCE).toMatch(/\bms-4\b/);
  });

  it("flips the disclosure chevron for RTL", () => {
    // Closed, the chevron must point toward the inline start — which is the
    // left here, so the LTR rotation needs an `rtl:` counterpart.
    expect(GROUP_SOURCE).toMatch(/-rotate-90 rtl:rotate-90/);
    // The «بازگشت» arrow too: an arrow drawn for LTR points the wrong way.
    expect(NAV_SOURCE).toMatch(/rtl:rotate-180/);
  });

  it("labels every entry in text, never by glyph alone", () => {
    // A core operation hidden behind an ambiguous icon is not discoverable.
    // Both the label span and the collapsed-rail tooltip carry the words.
    expect(GROUP_SOURCE).toMatch(/tooltip=\{entry\.label\}/);
    expect(GROUP_SOURCE).toMatch(/\{entry\.label\}/);
    // The collapsible group's header carries its name in words too.
    expect(GROUP_SOURCE).toMatch(/\{group\.label\}/);
  });

  it("makes each group a real disclosure a screen reader can follow", () => {
    expect(GROUP_SOURCE).toMatch(/aria-expanded=\{open\}/);
    expect(GROUP_SOURCE).toMatch(/aria-controls=\{panelId\}/);
    // And the menu names itself, so a screen reader announces which nav it is.
    expect(NAV_SOURCE).toMatch(/aria-label="منوی حسابداری"/);
  });

  it("marks the current page for assistive tech, not only in colour", () => {
    expect(GROUP_SOURCE).toMatch(/aria-current=\{active \? "page" : undefined\}/);
  });

  it("draws the group toggle as a menu row, not a bespoke caption", () => {
    // The bug this replaced: a 40px, 11px-bold heading with a small chevron —
    // a control sharing nothing with the 48px amber rows it opened. It is a
    // SidebarMenuButton in the shared nav skin now, so its size, radius,
    // hover, selection and focus ring come from the design system.
    expect(GROUP_SOURCE).toMatch(/<SidebarMenuButton[\s\S]{0,400}APP_NAV_BUTTON_CLASS/);
    // No hand-rolled <button> skin left in the group component.
    expect(GROUP_SOURCE).not.toMatch(/<button\b/);
  });

  it("keeps the group heading in the shared metadata type, not a new spelling", () => {
    expect(GROUP_SOURCE).toMatch(/text-\[11px\] font-semibold tracking-wide text-muted-foreground/);
  });

  it("keeps «you are here» on a group that is closed over the current page", () => {
    expect(GROUP_SOURCE).toMatch(/isActive=\{holdsCurrentPage && !open\}/);
  });

  it("hides labels, not entries, when the rail collapses to icons", () => {
    expect(GROUP_SOURCE).toMatch(/group-data-\[state=collapsed\]\/sidebar:hidden/);
    // A closed group must still list its rows at 4rem: there is no chevron
    // there to reopen it with, so hiding them would empty the rail.
    expect(GROUP_SOURCE).toMatch(/hidden group-data-\[state=collapsed\]\/sidebar:block/);
  });
});

describe("the party form is accessible and hard to lose work in", () => {
  it("protects unsaved changes on the way out", () => {
    // Both exits: the dialog's own close (Escape, the backdrop, «انصراف») and
    // the browser's (refresh, closed tab).
    expect(FORM_SOURCE).toMatch(/requestClose/);
    expect(FORM_SOURCE).toMatch(/partyFormHasUnsavedChanges/);
    expect(FORM_SOURCE).toMatch(/beforeunload/);
    expect(FORM_SOURCE).not.toMatch(/onClick=\{onClose\}/);
  });

  it("sends a validation error to its tab and focuses the field", () => {
    expect(FORM_SOURCE).toMatch(/setTab\(tabForField\(first\)\)/);
    expect(FORM_SOURCE).toMatch(/setFocusField\(first\)/);
    expect(FORM_SOURCE).toMatch(/data-field=/);
  });

  it("offers roles as a multi-select group, not a single-value picker", () => {
    expect(FORM_SOURCE).toMatch(/role="checkbox"/);
    expect(FORM_SOURCE).toMatch(/aria-checked=\{checked\}/);
    expect(FORM_SOURCE).toMatch(/togglePartyRole/);
    // The old single-role `<select>` must not come back.
    expect(FORM_SOURCE).not.toMatch(/value=\{state\.role\}[\s\S]{0,200}<option/);
  });

  it("names the role group for a screen reader", () => {
    expect(FORM_SOURCE).toMatch(/role="group"/);
    expect(FORM_SOURCE).toMatch(/aria-label="نقش‌های این شخص"/);
  });

  it("uses logical insets throughout", () => {
    expect(physicalClassesIn(FORM_SOURCE)).toEqual([]);
  });
});

describe("the directory is one screen with filters", () => {
  it("drives its list from the view, not from a per-role scope", () => {
    expect(SECTION_SOURCE).toMatch(/partyDirectoryView/);
    expect(SECTION_SOURCE).toMatch(/listedRoles/);
    // The roles asked of the API are the *narrowed* set, so a hand-typed
    // `?view=` cannot widen what a scope is allowed to list.
    expect(SECTION_SOURCE).toMatch(/params\.set\("roles", listedRoles\.join\(","\)\)/);
  });

  it("draws the views with the shared tab primitive, not a bespoke strip", () => {
    expect(SECTION_SOURCE).toMatch(/<TabBar/);
  });

  it("opens a new person with the current view's role ticked", () => {
    expect(SECTION_SOURCE).toMatch(/defaultRoles=\{activeView\.defaultRoles\}/);
  });

  it("uses logical insets throughout", () => {
    expect(physicalClassesIn(SECTION_SOURCE)).toEqual([]);
  });
});
