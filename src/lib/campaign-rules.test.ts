import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_WEEKDAYS,
  campaignValueLabel,
  campaignWarnings,
  formatWeekdays,
  isValidHm,
  validateCampaignDraft,
} from "./campaign-rules";

/** A campaign that saves cleanly, so each test can break exactly one thing. */
function draft(over: Record<string, unknown> = {}) {
  return { name: "تخفیف عصرگاهی", kind: "percent", value: 20, ...over };
}

describe("validateCampaignDraft", () => {
  it("accepts the ordinary percent campaign", () => {
    expect(validateCampaignDraft(draft())).toEqual([]);
  });

  it("requires a name and a known kind", () => {
    expect(validateCampaignDraft(draft({ name: "   " }))).toContain("نام کمپین را بنویسید.");
    expect(validateCampaignDraft(draft({ kind: "mystery" }))).toEqual(["نوع کمپین نامعتبر است."]);
  });

  it("refuses an empty amount instead of letting the parser throw mid-submit", () => {
    // The form used to call money.parse("") here, which throws — the submit
    // handler died before releasing `busy`, so the button stayed disabled with
    // nothing on screen.
    expect(validateCampaignDraft(draft({ kind: "amount", value: "" }))).toContain(
      "مبلغ کمپین را وارد کنید.",
    );
    expect(validateCampaignDraft(draft({ value: "" }))).toContain("درصد تخفیف را وارد کنید.");
  });

  it("keeps percent inside 0-100 and rejects a fractional one", () => {
    expect(validateCampaignDraft(draft({ value: 120 }))).toContain(
      "درصد تخفیف نمی‌تواند بیشتر از ۱۰۰ باشد.",
    );
    // `value` is a bigint column; 12.5 reached Postgres as a cast error before.
    expect(validateCampaignDraft(draft({ value: 12.5 }))).toContain(
      "درصد تخفیف باید یک عدد صحیح باشد.",
    );
    expect(validateCampaignDraft(draft({ value: -5 }))).toContain("مقدار کمپین نمی‌تواند منفی باشد.");
  });

  it("rejects a zero percent/amount campaign, which would fire and discount nothing", () => {
    expect(validateCampaignDraft(draft({ value: 0 }))).toContain("مقدار کمپین باید بزرگ‌تر از صفر باشد.");
    // A bundle *price* of zero is a giveaway, not a no-op, so it stays legal.
    expect(validateCampaignDraft(draft({ kind: "bundle_price", value: 0 }))).toEqual([]);
  });

  it("requires a positive whole minimum quantity for buy_x_get_y and nothing else", () => {
    // Without it the engine's `minQty <= 0` guard skips the promotion forever:
    // a campaign that looks live and never applies.
    expect(validateCampaignDraft(draft({ kind: "buy_x_get_y", value: 100000 }))).toContain(
      "برای این نوع کمپین، «حداقل تعداد» الزامی است؛ بدون آن کمپین هرگز اعمال نمی‌شود.",
    );
    expect(
      validateCampaignDraft(draft({ kind: "buy_x_get_y", value: 100000, minQuantity: 2.5 })),
    ).toContain("«حداقل تعداد» باید یک عدد صحیح بزرگ‌تر از صفر باشد.");
    expect(
      validateCampaignDraft(draft({ kind: "buy_x_get_y", value: 100000, minQuantity: 3 })),
    ).toEqual([]);
    // Another kind must not inherit the requirement.
    expect(validateCampaignDraft(draft({ kind: "amount", value: 5000 }))).toEqual([]);
  });

  it("rejects a backwards date window rather than saving a campaign that never runs", () => {
    expect(
      validateCampaignDraft(draft({ activeFrom: "2026-09-30", activeTo: "2026-09-01" })),
    ).toContain("«از تاریخ» باید پیش از «تا تاریخ» باشد؛ وگرنه کمپین هیچ‌وقت اجرا نمی‌شود.");
    // One-day window: from == to is inclusive on both ends, so it is valid.
    expect(
      validateCampaignDraft(draft({ activeFrom: "2026-09-01", activeTo: "2026-09-01" })),
    ).toEqual([]);
    expect(validateCampaignDraft(draft({ activeFrom: "2026-13-01" }))).toContain(
      "«از تاریخ» معتبر نیست.",
    );
  });

  it("rejects a time window that crosses midnight, which the engine cannot express", () => {
    // isPromotionActive tests `now >= from && now < to` on one day, so
    // 22:00→02:00 matches no moment at all.
    expect(validateCampaignDraft(draft({ timeFrom: "22:00", timeTo: "02:00" }))).toContain(
      "بازهٔ ساعتی نمی‌تواند از نیمه‌شب رد شود؛ «تا ساعت» باید بعد از «از ساعت» همان روز باشد.",
    );
    expect(validateCampaignDraft(draft({ timeFrom: "12:00", timeTo: "12:00" }))).toContain(
      "«از ساعت» و «تا ساعت» نمی‌توانند یکی باشند.",
    );
    expect(validateCampaignDraft(draft({ timeFrom: "17:00", timeTo: "19:00" }))).toEqual([]);
  });

  it("reports every problem at once, not just the first", () => {
    const problems = validateCampaignDraft({
      name: "",
      kind: "percent",
      value: 400,
      activeFrom: "2026-09-30",
      activeTo: "2026-09-01",
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("validates the weekday set against the stored 0-6 convention", () => {
    expect(validateCampaignDraft(draft({ daysOfWeek: [0, 6] }))).toEqual([]);
    expect(validateCampaignDraft(draft({ daysOfWeek: [7] }))).toContain("روزهای هفته معتبر نیست.");
  });
});

describe("campaignWarnings", () => {
  it("warns that a bundle with no items can never fire", () => {
    // evaluatePromotions requires every member item to be present; with no
    // members the bundle is skipped on every cart while looking «در حال اجرا».
    expect(campaignWarnings({ kind: "bundle_price", itemIds: [] })).toHaveLength(1);
    expect(campaignWarnings({ kind: "bundle_price", itemIds: ["a"] })).toEqual([]);
    expect(campaignWarnings({ kind: "percent" })).toEqual([]);
  });
});

describe("campaignValueLabel", () => {
  it("calls a set price a set price, never a discount", () => {
    // Labelling the bundle's total as «مبلغ تخفیف» is how a 500,000 bundle
    // price gets typed in as a 500,000 discount.
    expect(campaignValueLabel("bundle_price", "تومان")).toBe("قیمت کل ست (تومان)");
    expect(campaignValueLabel("buy_x_get_y", "ریال")).toBe("قیمت ثابت برای کل تعداد (ریال)");
    expect(campaignValueLabel("amount", "تومان")).toBe("مبلغ تخفیف هر قلم (تومان)");
    expect(campaignValueLabel("percent", "تومان")).toBe("درصد تخفیف");
  });
});

describe("isValidHm", () => {
  it("accepts a real wall clock and rejects the rest", () => {
    expect(isValidHm("09:30")).toBe(true);
    expect(isValidHm("23:59")).toBe(true);
    expect(isValidHm("24:00")).toBe(false);
    expect(isValidHm("12:60")).toBe(false);
    expect(isValidHm("")).toBe(false);
  });
});

describe("weekdays", () => {
  it("lists the Persian week from شنبه while keeping the JS day numbers", () => {
    // The column stores Date.getDay(); شنبه is 6, so the display order is not
    // the numeric order and must not be "fixed" into one.
    expect(CAMPAIGN_WEEKDAYS.map((d) => d.value)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(CAMPAIGN_WEEKDAYS[0].label).toBe("شنبه");
  });

  it("says nothing for an empty or complete week — both mean «هر روز»", () => {
    expect(formatWeekdays([])).toBeNull();
    expect(formatWeekdays(null)).toBeNull();
    expect(formatWeekdays([0, 1, 2, 3, 4, 5, 6])).toBeNull();
  });

  it("names the chosen days in calendar order regardless of input order", () => {
    expect(formatWeekdays([1, 6])).toBe("شنبه، دوشنبه");
  });
});
