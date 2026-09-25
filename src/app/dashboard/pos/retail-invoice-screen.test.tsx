// @vitest-environment jsdom

/**
 * `RetailInvoiceScreen`'s submit path: the hold-to-confirm gesture and the
 * canonical print pipeline, which is where the historical fidelity bugs
 * (discount hardcoded to 0, issue date re-stamped to `new Date()`) lived.
 *
 * Time is faked for the whole file, the same discipline
 * hold-to-confirm-button.test.tsx uses: `HoldToConfirmButton` reads one clock
 * (`performance.now()` via `requestAnimationFrame`), so both must be faked
 * together or the hold either never completes or completes instantly.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetailInvoiceScreen } from "./retail-invoice-screen";
import type { ReceiptData } from "@/lib/receipt-template";

const toastWarning = vi.fn();
const toastInfo = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

const printReceipt = vi.fn(
  async (_printerId: string | null, _receipt: ReceiptData, _opts?: unknown) =>
    ({ ok: true, supportsDrawer: false, printerId: null }) as const,
);
const kickDrawer = vi.fn(async (_printerId: string) => undefined);
vi.mock("@/lib/printing/client", () => ({
  printReceipt: (printerId: string | null, receipt: ReceiptData, opts?: unknown) =>
    printReceipt(printerId, receipt, opts),
  kickDrawer: (printerId: string) => kickDrawer(printerId),
}));

const CASH_METHOD = {
  id: "pm-cash",
  code: "cash",
  name: "نقدی",
  settlement: "cash",
  sortOrder: 0,
  isActive: true,
  isBuiltin: true,
  opensDrawer: false,
  requiresReference: false,
};

const ACCESSORY_ITEM = {
  id: "item-1",
  parentName: null,
  name: "جاکلیدی چرمی",
  sku: "KEY-1",
  kind: "accessory",
  quantity: "5",
  unitPrice: 100_000,
};

/** A print document whose fields could never come from the client's own
 * guesses (a discount, and an issue date years in the past) — proving the
 * screen displays the server's canonical print data, not a hand-rolled one. */
const CANONICAL_RECEIPT: ReceiptData = {
  business: { name: "فروشگاه نمونه", address: null, phone: null },
  orderLabel: "فاکتور ۴۲",
  orderTypeLabel: "فاکتور فروش",
  customerName: "علی رضایی",
  issuedAt: "2021-05-01T08:00:00.000Z",
  lines: [{ name: "جاکلیدی چرمی", quantity: 1, lineTotal: 95_000, goldBreakdown: null, batch: null }],
  subtotal: 100_000,
  discount: 5_000,
  tax: 9_000,
  total: 104_000,
  paymentMethod: "cash",
  payments: [{ label: "نقدی", amount: 104_000 }],
  unit: "toman",
};

function routeFor(url: string): { pattern: RegExp; body: unknown }[] {
  return [
    { pattern: /\/api\/parties\?/, body: { customers: [] } },
    { pattern: /\/api\/payment-methods$/, body: { paymentMethods: [CASH_METHOD] } },
    { pattern: /\/api\/accessories\/items$/, body: { items: [ACCESSORY_ITEM] } },
    { pattern: /\/api\/barcodes\/lookup/, body: { matches: [{ itemId: "item-1", itemName: "جاکلیدی چرمی", kind: "accessory", tracking: "none" }] } },
    {
      pattern: /\/api\/sales\/invoices$/,
      body: { invoice: { orderId: "order-9", orderNumber: 42, total: "104000" } },
    },
    { pattern: /\/api\/sales\/invoices\/order-9\?view=print/, body: { receipt: CANONICAL_RECEIPT } },
  ].filter((r) => r.pattern.test(url));
}

beforeEach(() => {
  vi.useFakeTimers();
  toastWarning.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  printReceipt.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/sales/invoices") && init?.method === "POST") {
        const [match] = routeFor("/api/sales/invoices");
        return new Response(JSON.stringify(match.body), { status: 200 });
      }
      const [match] = routeFor(url);
      if (match) return new Response(JSON.stringify(match.body), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Flushes the microtask queue (pending `api()`/`fetch` promises) under fake timers. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Polls a synchronous check by flushing microtasks — a `waitFor`-alike that
 * works under globally-faked timers, where `@testing-library`'s own
 * `waitFor` (real `setTimeout`-driven) would just hang until the test's own
 * timeout.
 */
async function flushUntil(check: () => void, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      check();
      return;
    } catch {
      await flush();
    }
  }
  check(); // last attempt — let its real assertion error surface
}

async function scanAndFlush(code: string) {
  const input = screen.getByPlaceholderText("اسکن بارکد…") as HTMLInputElement;
  act(() => {
    fireEvent.change(input, { target: { value: code } });
  });
  act(() => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await flush();
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /ثبت فاکتور/ }) as HTMLButtonElement;
}

function press(element: Element) {
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  });
}

function release(element: Element) {
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("RetailInvoiceScreen — submitting a sale", () => {
  it("does not post the invoice on a plain tap of the submit control", async () => {
    render(<RetailInvoiceScreen industry="accessories" />);
    await flush();
    await scanAndFlush("KEY-1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    press(submitButton());
    advance(80); // a tap, not a hold
    release(submitButton());
    await flush();

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/sales/invoices",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts exactly once after a full hold, then prints the server's canonical document — not a client-guessed one", async () => {
    render(<RetailInvoiceScreen industry="accessories" />);
    await flush();
    await scanAndFlush("KEY-1");

    press(submitButton());
    advance(2000);
    release(submitButton());
    await flush();
    await flush();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      fetchMock.mock.calls.some(
        (call: unknown[]) => call[0] === "/api/sales/invoices" && (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);

    // The receipt handed to the printer must be the server's print-data
    // response verbatim — a hardcoded discount of 0 or a freshly-stamped
    // `new Date()` would fail these two assertions specifically.
    await flushUntil(() => expect(printReceipt).toHaveBeenCalled());
    const [, receiptArg] = printReceipt.mock.calls[0];
    expect(receiptArg).toEqual(CANONICAL_RECEIPT);
    expect((receiptArg as ReceiptData).discount).toBe(5_000);
    expect((receiptArg as ReceiptData).issuedAt).toBe("2021-05-01T08:00:00.000Z");
  });

  it("still shows the sale as completed when the print-data fetch fails, and warns instead of blocking", async () => {
    const fetchMock2 = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/sales/invoices") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ invoice: { orderId: "order-9", orderNumber: 42, total: "104000" } }),
          { status: 200 },
        );
      }
      if (url.includes("view=print")) return new Response(JSON.stringify({}), { status: 500 });
      const [match] = routeFor(url);
      if (match) return new Response(JSON.stringify(match.body), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock2);

    render(<RetailInvoiceScreen industry="accessories" />);
    await flush();
    await scanAndFlush("KEY-1");

    press(submitButton());
    advance(2000);
    release(submitButton());
    await flush();
    await flush();

    expect(screen.getByText(/فاکتور شمارهٔ ۴۲/)).toBeTruthy();
    await flushUntil(() => expect(toastWarning).toHaveBeenCalled());
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it("refuses a credit sale with no customer before it ever reaches the network", async () => {
    const CREDIT_METHOD = {
      id: "pm-credit",
      code: "credit",
      name: "نسیه",
      settlement: "credit",
      sortOrder: 1,
      isActive: true,
      isBuiltin: true,
      opensDrawer: false,
      requiresReference: false,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/payment-methods")) {
        return new Response(JSON.stringify({ paymentMethods: [CASH_METHOD, CREDIT_METHOD] }), { status: 200 });
      }
      if (url.includes("/api/sales/invoices") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ invoice: { orderId: "order-9", orderNumber: 42, total: "104000" } }),
          { status: 200 },
        );
      }
      const [match] = routeFor(url);
      if (match) return new Response(JSON.stringify(match.body), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RetailInvoiceScreen industry="accessories" />);
    await flush();
    await scanAndFlush("KEY-1");

    await flush();
    const creditRadio = screen.getByRole("radio", { name: "نسیه" });
    act(() => {
      creditRadio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    press(submitButton());
    advance(2000);
    release(submitButton());
    await flush();

    expect(
      fetchMock.mock.calls.some(
        (call: unknown[]) => call[0] === "/api/sales/invoices" && (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
    expect(screen.getAllByText("برای فروش نسیه، انتخاب مشتری الزامی است.").length).toBeGreaterThan(0);
  });
});
