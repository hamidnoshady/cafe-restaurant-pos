// @vitest-environment jsdom

/**
 * The phone filter toolbar.
 *
 * What is worth testing here is not the styling but the three promises the
 * compact layout makes, each of which the stacked layout it replaces broke:
 * that a filter holding a value says so without being opened, that it can be
 * cleared both individually and all at once, and — the important one — that
 * the toolbar is a *view* over filter state it does not own, so opening and
 * closing it cannot drop a sibling filter.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CalendarDaysIcon, LayoutGridIcon } from "lucide-react";
import { FilterChip, FilterToolbar, FilterToolbarButton, FilterToolbarSearch } from "./filters";

afterEach(cleanup);

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

/** Dismisses whichever sheet is open — a sheet is modal, so it must go first. */
function closeSheet() {
  act(() => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

/**
 * Types into a controlled input. React tracks the DOM value to decide whether
 * `change` is a real edit, so assigning `.value` directly is invisible to it;
 * the native setter is what a user's keystroke effectively does.
 */
function type(field: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** A miniature of the orders screen's toolbar: search + two filters. */
function Harness({ onClearAll }: { onClearAll?: boolean } = {}) {
  const [search, setSearch] = useState("");
  const [table, setTable] = useState("all");
  const [date, setDate] = useState("");
  const active = Boolean(search) || table !== "all" || Boolean(date);
  return (
    <>
      <FilterToolbar
        onClearAll={
          onClearAll !== false && active
            ? () => {
                setSearch("");
                setTable("all");
                setDate("");
              }
            : undefined
        }
      >
        <FilterToolbarSearch value={search} onChange={setSearch} label="جستجو" />
        <FilterToolbarButton
          icon={LayoutGridIcon}
          label="میز"
          value={table === "all" ? undefined : table}
          onClear={() => setTable("all")}
        >
          <FilterChip dense selected={table === "میز ۴"} onClick={() => setTable("میز ۴")}>
            میز ۴
          </FilterChip>
        </FilterToolbarButton>
        <FilterToolbarButton
          icon={CalendarDaysIcon}
          label="تاریخ"
          value={date || undefined}
          onClear={() => setDate("")}
        >
          <FilterChip dense selected={date === "۱۴۰۵/۰۵/۲۶"} onClick={() => setDate("۱۴۰۵/۰۵/۲۶")}>
            ۱۴۰۵/۰۵/۲۶
          </FilterChip>
        </FilterToolbarButton>
      </FilterToolbar>
      <output data-testid="state">{`${search}|${table}|${date}`}</output>
    </>
  );
}

const state = () => screen.getByTestId("state").textContent;

describe("FilterToolbar — state is visible without opening anything", () => {
  it("names a filter by itself when it holds nothing", () => {
    render(<Harness />);
    expect(screen.getByLabelText("میز")).toBeTruthy();
  });

  it("puts the value in the accessible name and on the button once it is set", () => {
    render(<Harness />);

    click(screen.getByLabelText("میز"));
    click(screen.getByText("میز ۴"));

    const trigger = screen.getByLabelText("میز: میز ۴");
    expect(trigger.textContent).toContain("میز ۴");
  });

  it("keeps every filter to one row-sized target, so more filters scroll rather than wrap", () => {
    render(<Harness />);
    for (const label of ["جستجو", "میز", "تاریخ"]) {
      expect(screen.getByLabelText(label).className).toContain("shrink-0");
    }
  });
});

describe("FilterToolbar — clearing", () => {
  it("clears one filter from inside its own sheet, leaving the others alone", () => {
    render(<Harness />);

    click(screen.getByLabelText("میز"));
    click(screen.getByText("میز ۴"));
    closeSheet();
    click(screen.getByLabelText("تاریخ"));
    click(screen.getByText("۱۴۰۵/۰۵/۲۶"));
    closeSheet();
    expect(state()).toBe("|میز ۴|۱۴۰۵/۰۵/۲۶");

    click(screen.getByLabelText("میز: میز ۴"));
    click(screen.getByText("حذف این فیلتر"));

    expect(state()).toBe("|all|۱۴۰۵/۰۵/۲۶");
  });

  it("clears everything at once from the toolbar", () => {
    render(<Harness />);

    click(screen.getByLabelText("میز"));
    click(screen.getByText("میز ۴"));
    closeSheet();
    click(screen.getByLabelText("تاریخ"));
    click(screen.getByText("۱۴۰۵/۰۵/۲۶"));
    closeSheet();

    click(screen.getByLabelText("پاک‌کردن همهٔ فیلترها"));

    expect(state()).toBe("|all|");
  });

  it("offers no clear-all while nothing is filtered", () => {
    render(<Harness />);
    expect(screen.queryByLabelText("پاک‌کردن همهٔ فیلترها")).toBeNull();
  });

  it("offers no per-filter clear while that filter holds nothing", () => {
    render(<Harness />);

    click(screen.getByLabelText("میز"));

    expect(screen.queryByText("حذف این فیلتر")).toBeNull();
  });
});

describe("FilterToolbar — it owns no filter state of its own", () => {
  it("does not disturb a sibling filter when one sheet is opened and closed", () => {
    render(<Harness />);

    click(screen.getByLabelText("میز"));
    click(screen.getByText("میز ۴"));
    closeSheet();
    expect(state()).toBe("|میز ۴|");

    // Open the date sheet, change nothing, close it again.
    click(screen.getByLabelText("تاریخ"));
    closeSheet();

    expect(state()).toBe("|میز ۴|");
  });

  it("re-reads its value from the caller, so a filter cleared elsewhere shows as cleared", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterToolbar>
        <FilterToolbarButton icon={LayoutGridIcon} label="میز" value="میز ۴" onClear={onClear}>
          <span>control</span>
        </FilterToolbarButton>
      </FilterToolbar>,
    );
    expect(screen.getByLabelText("میز: میز ۴")).toBeTruthy();

    rerender(
      <FilterToolbar>
        <FilterToolbarButton icon={LayoutGridIcon} label="میز" onClear={onClear}>
          <span>control</span>
        </FilterToolbarButton>
      </FilterToolbar>,
    );

    expect(screen.getByLabelText("میز")).toBeTruthy();
    expect(screen.queryByLabelText("میز: میز ۴")).toBeNull();
  });
});

describe("FilterToolbarSearch", () => {
  it("is an icon until it is tapped, then a field", () => {
    render(<Harness />);

    const icon = screen.getByLabelText("جستجو");
    expect(icon.tagName).toBe("BUTTON");

    click(icon);

    const field = screen.getByLabelText("جستجو");
    expect(field.tagName).toBe("INPUT");
  });

  it("stays expanded while it holds a query, even after losing focus", () => {
    render(<Harness />);

    click(screen.getByLabelText("جستجو"));
    const field = screen.getByLabelText("جستجو") as HTMLInputElement;
    type(field, "۱۰۴");
    act(() => {
      field.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });

    expect(state()).toBe("۱۰۴|all|");
    expect((screen.getByLabelText("جستجو") as HTMLElement).tagName).toBe("INPUT");
  });

  it("collapses back to an icon when its own clear button empties it", () => {
    render(<Harness />);

    click(screen.getByLabelText("جستجو"));
    type(screen.getByLabelText("جستجو") as HTMLInputElement, "۱۰۴");

    click(screen.getByLabelText("پاک‌کردن جستجو"));

    expect(state()).toBe("|all|");
    expect((screen.getByLabelText("جستجو") as HTMLElement).tagName).toBe("BUTTON");
  });
});
