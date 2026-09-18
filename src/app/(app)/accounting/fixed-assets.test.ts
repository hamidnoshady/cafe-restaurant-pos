import { describe, expect, it } from "vitest";
import { errorMessageOrRaw } from "@/app/dashboard/ui";

describe("Fixed assets error translation and resolution", () => {
  it("translates all fixed asset specific error codes correctly", () => {
    expect(errorMessageOrRaw("fixed_asset_not_found")).toBe("دارایی ثابت پیدا نشد.");
    expect(errorMessageOrRaw("fixed_asset_has_depreciation")).toBe("برای این دارایی استهلاک ثبت شده و قابل حذف نیست.");
    expect(errorMessageOrRaw("period_already_depreciated")).toBe("استهلاک این دوره قبلاً برای این دارایی ثبت شده است.");
    expect(errorMessageOrRaw("fully_depreciated")).toBe("این دارایی به‌طور کامل مستهلک شده است.");
    expect(errorMessageOrRaw("salvage_value_invalid")).toBe("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
    expect(errorMessageOrRaw("period_label_required")).toBe("عنوان دوره الزامی است.");
  });

  it("passes through raw Persian strings if already formatted", () => {
    const rawPersian = "ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.";
    expect(errorMessageOrRaw(rawPersian)).toBe(rawPersian);
  });
});

describe("Fixed asset calculations and progress metrics", () => {
  it("calculates progress percentage and remaining book value accurately", () => {
    const cost = 120_000_000;
    const salvageValue = 20_000_000;
    const usefulLifeMonths = 60;
    const depreciableBase = cost - salvageValue; // 100,000,000
    const monthly = Math.round(depreciableBase / usefulLifeMonths); // 1,666,667

    // After 12 months
    const accumulated = monthly * 12; // 20,000,004
    const bookValue = cost - accumulated; // 99,999,996
    const percent = Math.min(100, Math.round((accumulated / depreciableBase) * 100)); // 20%

    expect(percent).toBe(20);
    expect(bookValue).toBe(99_999_996);
  });

  it("determines fully depreciated status correctly", () => {
    const cost = 50_000_000;
    const salvageValue = 5_000_000;
    const depreciableBase = cost - salvageValue;

    // Not fully depreciated
    const acc1 = 40_000_000;
    const bookValue1 = cost - acc1;
    const isFullyDepreciated1 = bookValue1 <= salvageValue || acc1 >= depreciableBase;
    expect(isFullyDepreciated1).toBe(false);

    // Fully depreciated
    const acc2 = 45_000_000;
    const bookValue2 = cost - acc2;
    const isFullyDepreciated2 = bookValue2 <= salvageValue || acc2 >= depreciableBase;
    expect(isFullyDepreciated2).toBe(true);
  });
});
