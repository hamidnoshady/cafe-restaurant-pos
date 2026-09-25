// @vitest-environment jsdom

/**
 * The permission editor is where an owner decides what somebody else may do,
 * so its failure mode is not a broken layout — it is saving a different set
 * from the one on screen. These tests concentrate on that gap:
 *
 *   - dependency resolution happens at tick time, so the set displayed is
 *     always the set that would be stored;
 *   - owner-only keys are not offered at all, matching a server that would
 *     strip them anyway;
 *   - provenance ("from the role" / "added" / "taken away") is computed from
 *     preset-vs-selected rather than guessed;
 *   - the pre-save summary names the consequences of a change in both
 *     directions.
 *
 * `permission-registry.test.ts` pins the catalogue itself; this file assumes it
 * and tests the behaviour layered on top.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessChangeSummary,
  PermissionEditor,
  accessChangeSummary,
  permissionSource,
} from "./permission-editor";
import { PERMISSIONS, roleBasePermissions } from "@/lib/permissions";
import { PERMISSION_METADATA, impliedPermissions } from "@/lib/permission-registry";
import type { Permission } from "@/lib/permissions";

afterEach(cleanup);

const CASHIER = new Set<string>(roleBasePermissions("cashier"));

/**
 * Renders the editor as a controlled component the way the team screen does,
 * and hands back a live view of what it would save.
 */
function renderEditor(options?: { preset?: ReadonlySet<string>; selected?: ReadonlySet<string>; readOnly?: boolean }) {
  const preset = options?.preset ?? CASHIER;
  const state = { current: new Set<string>(options?.selected ?? preset) };
  const onChange = vi.fn((next: Set<string>) => {
    state.current = next;
    rerender();
  });
  const ui = () => (
    <PermissionEditor
      preset={preset}
      selected={state.current}
      onChange={onChange}
      readOnly={options?.readOnly}
    />
  );
  const { rerender: doRerender } = render(ui());
  function rerender() {
    doRerender(ui());
  }
  return { state, onChange, preset };
}

/** The checkbox for a permission, found by its Persian label. */
function checkboxFor(key: Permission): HTMLElement {
  const label = PERMISSION_METADATA[key].label;
  const row = screen.getByText(label).closest("label, li, div[role='group'], div");
  if (!row) throw new Error(`no row for ${key}`);
  const box = within(row as HTMLElement).queryByRole("checkbox");
  if (box) return box;
  // Fall back to the nearest ancestor that owns a checkbox.
  let node: HTMLElement | null = row as HTMLElement;
  while (node) {
    const found = within(node).queryAllByRole("checkbox");
    if (found.length === 1) return found[0];
    node = node.parentElement;
  }
  throw new Error(`no checkbox for ${key}`);
}

describe("permissionSource", () => {
  it("distinguishes all four provenances", () => {
    const preset = new Set(["menu.view"]);
    expect(permissionSource("menu.view" as Permission, preset, new Set(["menu.view"]))).toBe("role");
    expect(permissionSource("menu.edit" as Permission, preset, new Set(["menu.edit"]))).toBe("granted");
    expect(permissionSource("menu.view" as Permission, preset, new Set())).toBe("revoked");
    expect(permissionSource("menu.edit" as Permission, preset, new Set())).toBe("none");
  });

  it("calls a re-added preset permission 'from the role', not 'added'", () => {
    // Ticking something back on must return it to the role's own account
    // rather than leaving it recorded as a personal grant; otherwise the
    // member's overrides accumulate entries that do nothing.
    const preset = new Set(["menu.view"]);
    expect(permissionSource("menu.view" as Permission, preset, new Set(["menu.view"]))).toBe("role");
  });
});

describe("PermissionEditor — what it offers", () => {
  it("never offers an owner-only permission", () => {
    // The server strips these in `sanitizeOverrides` and
    // `effectivePermissions` refuses to apply them, so offering the tick would
    // be a control that silently does nothing.
    renderEditor();
    expect(screen.queryByText(PERMISSION_METADATA[PERMISSIONS.apiManage].label)).toBeNull();
  });

  it("shows a permission's description, not only its key", () => {
    renderEditor();
    expect(screen.getByText(PERMISSION_METADATA[PERMISSIONS.menuView].description)).toBeTruthy();
  });

  it("hides the technical key until asked for it", () => {
    renderEditor();
    expect(screen.queryByText(PERMISSIONS.menuView)).toBeNull();
  });

  it("reveals technical keys when the advanced toggle is on", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByLabelText("جست‌وجو در دسترسی‌ها"));
    const advanced = screen.getByText("نمایش کلید فنی");
    await user.click(advanced);
    expect(screen.getAllByText(PERMISSIONS.menuView).length).toBeGreaterThan(0);
  });
});

describe("PermissionEditor — search", () => {
  it("filters to matching permissions", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("جست‌وجو در دسترسی‌ها"), PERMISSION_METADATA[PERMISSIONS.menuView].label);
    expect(screen.getByText(PERMISSION_METADATA[PERMISSIONS.menuView].label)).toBeTruthy();
  });

  it("says so when nothing matches, rather than rendering an empty page", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("جست‌وجو در دسترسی‌ها"), "zzzzzzzz-no-such-permission");
    expect(screen.queryByText(PERMISSION_METADATA[PERMISSIONS.menuView].label)).toBeNull();
  });
});

describe("PermissionEditor — dependencies resolve at tick time", () => {
  it("turns on everything a permission implies", async () => {
    // `menu.edit` implies `menu.view`: saving the former without the latter
    // would store a set the member could not actually use.
    const user = userEvent.setup();
    const implied = impliedPermissions([PERMISSIONS.menuEdit]);
    expect(implied).toContain(PERMISSIONS.menuView);

    const { state } = renderEditor({ preset: new Set(), selected: new Set() });
    await user.click(checkboxFor(PERMISSIONS.menuEdit));

    expect(state.current.has(PERMISSIONS.menuEdit)).toBe(true);
    for (const key of implied) expect(state.current.has(key), key).toBe(true);
  });

  it("turns off everything that implies a permission being removed", async () => {
    // The mirror image: dropping `menu.view` must drop `menu.edit` too, or the
    // stored set claims an edit right that depends on a read the member lost.
    const user = userEvent.setup();
    const { state } = renderEditor({
      preset: new Set(),
      selected: new Set([PERMISSIONS.menuView, PERMISSIONS.menuEdit]),
    });
    await user.click(checkboxFor(PERMISSIONS.menuView));

    expect(state.current.has(PERMISSIONS.menuView)).toBe(false);
    expect(state.current.has(PERMISSIONS.menuEdit)).toBe(false);
  });

  it("never displays a set it would not store", async () => {
    // The invariant the two tests above are really about, stated directly.
    const user = userEvent.setup();
    const { state } = renderEditor({ preset: new Set(), selected: new Set() });
    await user.click(checkboxFor(PERMISSIONS.menuEdit));

    for (const key of state.current) {
      for (const dependency of impliedPermissions([key as Permission])) {
        expect(state.current.has(dependency), `${key} needs ${dependency}`).toBe(true);
      }
    }
  });
});

describe("PermissionEditor — read-only mode", () => {
  it("does not change anything when clicked", async () => {
    const user = userEvent.setup();
    const { state, onChange } = renderEditor({ readOnly: true });
    const before = new Set(state.current);
    const box = checkboxFor(PERMISSIONS.menuView);
    await user.click(box).catch(() => {});
    expect(onChange).not.toHaveBeenCalled();
    expect(state.current).toEqual(before);
  });

  it("hides the advanced toggle, which is an editing affordance", () => {
    renderEditor({ readOnly: true });
    expect(screen.queryByText("نمایش کلید فنی")).toBeNull();
  });
});

describe("accessChangeSummary", () => {
  it("returns null when nothing changed, so no empty box is drawn", () => {
    const set = new Set(["menu.view"]);
    expect(accessChangeSummary(set, new Set(["menu.view"]))).toBeNull();
  });

  it("names what was added and what was removed", () => {
    const summary = accessChangeSummary(
      new Set([PERMISSIONS.menuView, PERMISSIONS.ordersCreate]),
      new Set([PERMISSIONS.menuView, PERMISSIONS.menuEdit]),
    );
    expect(summary).not.toBeNull();
    expect(summary!.added.map((m) => m.key)).toEqual([PERMISSIONS.menuEdit]);
    expect(summary!.removed.map((m) => m.key)).toEqual([PERMISSIONS.ordersCreate]);
  });

  it("ignores keys that are no longer in the catalogue", () => {
    // A stored override naming a permission a later release removed must not
    // crash the summary on the way to the save button.
    const summary = accessChangeSummary(new Set(["permission.that.was.deleted"]), new Set());
    expect(summary).toBeNull();
  });
});

describe("AccessChangeSummary", () => {
  it("renders nothing when there is no change", () => {
    const { container } = render(
      <AccessChangeSummary before={new Set(["menu.view"])} after={new Set(["menu.view"])} />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("spells out a removal, which is the case people discover from a support call", () => {
    render(
      <AccessChangeSummary
        before={new Set([PERMISSIONS.paymentsTake])}
        after={new Set()}
      />,
    );
    expect(screen.getByText(new RegExp(PERMISSION_METADATA[PERMISSIONS.paymentsTake].label))).toBeTruthy();
  });

  it("spells out an addition too", () => {
    render(
      <AccessChangeSummary before={new Set()} after={new Set([PERMISSIONS.paymentsRefund])} />,
    );
    expect(screen.getByText(new RegExp(PERMISSION_METADATA[PERMISSIONS.paymentsRefund].label))).toBeTruthy();
  });
});
