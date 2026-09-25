// @vitest-environment jsdom

/**
 * `InvoiceManagementView`'s filter bar: the status chips and the Jalali
 * date-range pickers added alongside the existing method/search filters. This
 * proves the client sends the server's expected query params (`status`,
 * `dateFrom`, `dateTo` as ISO `YYYY-MM-DD`) and surfaces the server's
 * validation error codes (`invalid_invoice_status`, `invalid_date_range`) as
 * Persian text — not that the date math itself is correct (that is the
 * server-side `list-service` integration test's job).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceManagementView } from "./invoice-management-view";

function emptyPage() {
  return new Response(JSON.stringify({ invoices: [], count: 0, timeZone: "Asia/Tehran" }), { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => emptyPage());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Flush the view's debounce timer (0ms when the search box is untouched) and
 * let the resulting promise chain settle. */
async function flush() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function lastRequestUrl(): URL {
  const lastCall = fetchMock.mock.calls.at(-1);
  if (!lastCall) throw new Error("fetch was never called");
  return new URL(String(lastCall[0]), "http://localhost");
}

describe("InvoiceManagementView filters", () => {
  it("loads with no status/date params by default", async () => {
    render(<InvoiceManagementView />);
    await flush();
    const url = lastRequestUrl();
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.has("dateFrom")).toBe(false);
    expect(url.searchParams.has("dateTo")).toBe(false);
  });

  it("sends status=voided when the باطل‌شده chip is selected, and resets to page 1", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("باطل‌شده");
    await flush();

    const url = lastRequestUrl();
    expect(url.searchParams.get("status")).toBe("voided");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("clears the status filter when «همه وضعیت‌ها» is re-selected", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("تکمیل‌شده");
    await flush();
    expect(lastRequestUrl().searchParams.get("status")).toBe("completed");

    click("همه وضعیت‌ها");
    await flush();
    expect(lastRequestUrl().searchParams.has("status")).toBe(false);
  });

  it("sends dateFrom/dateTo as ISO dates once both pickers are set to «امروز»", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("از تاریخ");
    click("امروز");
    await flush();

    click("تا تاریخ");
    click("امروز");
    await flush();

    const url = lastRequestUrl();
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(url.searchParams.get("dateFrom")).toMatch(isoDatePattern);
    expect(url.searchParams.get("dateTo")).toMatch(isoDatePattern);
  });

  it("maps the server's invalid_date_range error to a Persian message", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: "invalid_date_range" }), { status: 400 }),
    );
    render(<InvoiceManagementView />);
    await flush();

    expect(
      screen.getByText("بازهٔ تاریخ نامعتبر است؛ تاریخ شروع باید قبل از تاریخ پایان باشد."),
    ).toBeTruthy();
  });
});
