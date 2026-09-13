import { describe, expect, it } from "vitest";
import {
  MAX_BRANCH_ADDRESS,
  MAX_BRANCH_NAME,
  MAX_BRANCH_PHONE,
  branchAddressError,
  branchFieldsError,
  branchNameError,
  branchNameKey,
  branchPhoneError,
  branchTimezoneError,
  isSameBranchName,
  isSupportedTimezone,
  normalizeBranchName,
  normalizeOptionalText,
} from "./branch-input";

describe("normalizeBranchName", () => {
  it("trims and collapses inner whitespace", () => {
    expect(normalizeBranchName("  شعبهٔ   مرکزی  ")).toBe("شعبهٔ مرکزی");
    expect(normalizeBranchName("شعبه\n\tشمال")).toBe("شعبه شمال");
  });

  it("turns a whitespace-only name into the empty string", () => {
    expect(normalizeBranchName("   ")).toBe("");
    expect(normalizeBranchName("\t\n")).toBe("");
  });
});

describe("normalizeOptionalText", () => {
  it("keeps null/undefined distinct from a blank string only in what it returns", () => {
    expect(normalizeOptionalText(null)).toBeNull();
    expect(normalizeOptionalText(undefined)).toBeNull();
    expect(normalizeOptionalText("   ")).toBeNull();
    expect(normalizeOptionalText("  خیابان آزادی ")).toBe("خیابان آزادی");
  });
});

describe("branchNameError", () => {
  it("rejects an absent or whitespace-only name", () => {
    // The bug this covers: `updateBranch` used to fold a blank name into
    // coalesce($3, name), silently keeping the old one and reporting success.
    expect(branchNameError("")).toBe("missing_fields");
    expect(branchNameError("   ")).toBe("missing_fields");
    expect(branchNameError(undefined)).toBe("missing_fields");
    expect(branchNameError(null)).toBe("missing_fields");
  });

  it("rejects a name past the column's sane display length", () => {
    expect(branchNameError("ش".repeat(MAX_BRANCH_NAME))).toBeNull();
    expect(branchNameError("ش".repeat(MAX_BRANCH_NAME + 1))).toBe("name_too_long");
  });

  it("measures the normalized name, not the raw input", () => {
    const padded = `  ${"ش".repeat(MAX_BRANCH_NAME)}  `;
    expect(branchNameError(padded)).toBeNull();
  });
});

describe("branchAddressError / branchPhoneError", () => {
  it("treats an absent optional field as fine", () => {
    expect(branchAddressError(undefined)).toBeNull();
    expect(branchAddressError(null)).toBeNull();
    expect(branchAddressError("  ")).toBeNull();
    expect(branchPhoneError(undefined)).toBeNull();
  });

  it("rejects over-long values", () => {
    expect(branchAddressError("x".repeat(MAX_BRANCH_ADDRESS + 1))).toBe("address_too_long");
    expect(branchPhoneError("۰".repeat(MAX_BRANCH_PHONE + 1))).toBe("phone_too_long");
  });
});

describe("isSupportedTimezone / branchTimezoneError", () => {
  it("accepts zones the runtime knows", () => {
    expect(isSupportedTimezone("Asia/Tehran")).toBe(true);
    expect(isSupportedTimezone("UTC")).toBe(true);
    expect(isSupportedTimezone("  Europe/Berlin  ")).toBe(true);
  });

  it("rejects anything Postgres would also refuse", () => {
    // A bad zone here used to reach locations.timezone and make every
    // app_business_date() call for that branch raise — permanently, since
    // there was no update path for the column.
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
    expect(isSupportedTimezone("")).toBe(false);
    expect(isSupportedTimezone("   ")).toBe(false);
    expect(isSupportedTimezone(null)).toBe(false);
    expect(isSupportedTimezone(42)).toBe(false);
  });

  it("treats an absent timezone as 'not being set', not as invalid", () => {
    expect(branchTimezoneError(undefined)).toBeNull();
    expect(branchTimezoneError(null)).toBeNull();
    expect(branchTimezoneError("Nowhere/Nothing")).toBe("invalid_timezone");
  });
});

describe("branchNameKey", () => {
  it("collapses the spellings a person would read identically", () => {
    expect(branchNameKey("شعبه ۲")).toBe(branchNameKey("شعبه 2"));
    // Arabic yeh/kaf vs Persian ones — different code points, same word.
    expect(branchNameKey("شعبه مرکزي")).toBe(branchNameKey("شعبه مرکزی"));
    expect(branchNameKey("شعبك")).toBe(branchNameKey("شعبک"));
    expect(branchNameKey("Main  Branch")).toBe(branchNameKey("main branch"));
  });

  it("keeps genuinely different names apart", () => {
    expect(branchNameKey("شعبه شمال")).not.toBe(branchNameKey("شعبه جنوب"));
    expect(branchNameKey("شعبه ۲")).not.toBe(branchNameKey("شعبه ۳"));
  });
});

describe("isSameBranchName", () => {
  it("is the duplicate rule the service enforces", () => {
    expect(isSameBranchName("شعبهٔ  مرکزی", "شعبهٔ مرکزی")).toBe(true);
    expect(isSameBranchName("Karaj", "karaj")).toBe(true);
    expect(isSameBranchName("شعبه ۱", "شعبه ۲")).toBe(false);
  });
});

describe("branchFieldsError", () => {
  it("passes a partial edit that touches nothing invalid", () => {
    expect(branchFieldsError({})).toBeNull();
    expect(branchFieldsError({ name: "شعبه شمال" })).toBeNull();
    // An explicit null clears the field — it is not a validation failure.
    expect(branchFieldsError({ address: null, phone: null })).toBeNull();
  });

  it("reports the first offending field", () => {
    expect(branchFieldsError({ name: "  " })).toBe("missing_fields");
    expect(branchFieldsError({ name: "ok", address: "x".repeat(MAX_BRANCH_ADDRESS + 1) })).toBe(
      "address_too_long",
    );
    expect(branchFieldsError({ timezone: "Nope/Nope" })).toBe("invalid_timezone");
  });

  it("refuses to clear the timezone, which has no meaningful empty value", () => {
    expect(branchFieldsError({ timezone: null })).toBe("invalid_timezone");
    expect(branchFieldsError({ timezone: "" })).toBe("invalid_timezone");
  });

  it("distinguishes an absent field from a blank one", () => {
    // undefined = "not being changed"; blank = "changed to nothing", which is
    // only legal for address/phone.
    expect(branchFieldsError({ name: undefined })).toBeNull();
    expect(branchFieldsError({ address: "" })).toBeNull();
    expect(branchFieldsError({ name: "" })).toBe("missing_fields");
  });
});
