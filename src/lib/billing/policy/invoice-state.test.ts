import { describe, expect, it } from "vitest";
import { applyPayment, markOverdue, outstandingRial, voidInvoice, InvoiceStateError } from "./invoice-state";

const open = {
  status: "open" as const,
  totalRial: 1000,
  paidRial: 0,
  dueAt: "2026-10-01T00:00:00.000Z",
};

describe("invoice state", () => {
  it("applies a partial payment and a completing payment", () => {
    const partial = applyPayment(open, 400, "2026-09-01T00:00:00.000Z");
    expect(partial.status).toBe("partially_paid");
    expect(outstandingRial(partial)).toBe(600);
    const paid = applyPayment(partial, 600, "2026-09-01T00:00:00.000Z");
    expect(paid.status).toBe("paid");
    expect(outstandingRial(paid)).toBe(0);
  });

  it("keeps an already-due partial payment overdue", () => {
    const due = { ...open, dueAt: "2026-08-01T00:00:00.000Z" };
    const partial = applyPayment(due, 100, "2026-09-01T00:00:00.000Z");
    expect(partial.status).toBe("overdue");
  });

  it("refuses overpayment and payment of a void invoice", () => {
    expect(() => applyPayment(open, 1001, "2026-09-01T00:00:00.000Z")).toThrow(InvoiceStateError);
    expect(() => applyPayment({ ...open, status: "void" }, 100, "2026-09-01T00:00:00.000Z")).toThrow(InvoiceStateError);
  });

  it("voids an unpaid invoice and refuses a paid one", () => {
    expect(voidInvoice(open).status).toBe("void");
    expect(() => voidInvoice({ ...open, status: "partially_paid", paidRial: 1 })).toThrow(InvoiceStateError);
  });

  it("marks an open invoice overdue only after the due date", () => {
    expect(markOverdue(open, "2026-09-01T00:00:00.000Z").status).toBe("open");
    expect(markOverdue(open, "2026-10-02T00:00:00.000Z").status).toBe("overdue");
  });
});
