import { describe, expect, it } from "vitest";
import { renderRepairEstimate } from "./repair-estimate";

describe("renderRepairEstimate", () => {
  it("renders a signable estimate with the ticket number and amount", () => {
    const text = renderRepairEstimate({
      ticketNumber: 42,
      itemDescription: "ساعت مچی",
      reportedIssue: "باطری تمام شده",
      laborCharge: 900_000,
      partsCharge: 600_000,
      estimatedTotalRial: 1_500_000,
      todayIso: "2026-08-16",
      customerName: "مشتری نمونه",
    });
    expect(text).toContain("شماره: ۴۲");
    expect(text).toContain("ساعت مچی");
    expect(text).toContain("باطری تمام شده");
    expect(text).toContain("مشتری نمونه");
    expect(text).toContain("امضای تأیید مشتری");
  });

  it("breaks the estimate into labour and parts", () => {
    const text = renderRepairEstimate({
      ticketNumber: 7,
      itemDescription: "دستبند",
      reportedIssue: null,
      laborCharge: 2_000_000,
      partsCharge: 500_000,
      estimatedTotalRial: 2_500_000,
      todayIso: "2026-08-16",
    });
    expect(text).toContain("اجرت");
    expect(text).toContain("قطعات");
    expect(text).toContain("برآورد کل");
  });
});
