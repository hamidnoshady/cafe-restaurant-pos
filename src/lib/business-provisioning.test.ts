import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, validateProvisionBody } from "./business-provisioning";

const VALID = {
  businessName: "کافه نادری",
  ownerName: "مالک",
  email: "Owner@Example.COM",
  password: "correct-horse",
};

describe("validateProvisionBody", () => {
  it("accepts a complete body and normalises it", () => {
    const result = validateProvisionBody({ ...VALID, locationName: "  شعبه یک  ", phone: " 021 " });
    expect(result.error).toBeNull();
    expect(result.input).toMatchObject({
      businessName: "کافه نادری",
      ownerName: "مالک",
      // Lower-cased so it matches the citext identity column consistently.
      email: "owner@example.com",
      locationName: "شعبه یک",
      phone: "021",
    });
  });

  it("leaves locationName undefined so the caller's default applies", () => {
    expect(validateProvisionBody(VALID).input?.locationName).toBeUndefined();
    expect(validateProvisionBody({ ...VALID, locationName: "   " }).input?.locationName).toBeUndefined();
  });

  it("turns blank optional fields into null rather than empty strings", () => {
    const { input } = validateProvisionBody({ ...VALID, address: "  ", phone: "" });
    expect(input?.address).toBeNull();
    expect(input?.phone).toBeNull();
  });

  it("rejects a body missing any required field", () => {
    for (const key of ["businessName", "ownerName", "email", "password"] as const) {
      const body = { ...VALID, [key]: undefined };
      expect(validateProvisionBody(body).error, `missing ${key}`).toBe("missing_fields");
    }
  });

  it("treats whitespace-only required fields as missing", () => {
    expect(validateProvisionBody({ ...VALID, businessName: "   " }).error).toBe("missing_fields");
    expect(validateProvisionBody({ ...VALID, ownerName: "  " }).error).toBe("missing_fields");
  });

  it("rejects a malformed email", () => {
    for (const email of ["nope", "a@b", "a b@example.com", "@example.com", "a@"]) {
      expect(validateProvisionBody({ ...VALID, email }).error, email).toBe("invalid_email");
    }
  });

  it("rejects a password shorter than the minimum", () => {
    expect(validateProvisionBody({ ...VALID, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) }).error).toBe(
      "weak_password",
    );
    expect(validateProvisionBody({ ...VALID, password: "a".repeat(MIN_PASSWORD_LENGTH) }).error).toBeNull();
  });

  it("does not trim the password — leading and trailing spaces are part of it", () => {
    const password = "  spaced  ";
    expect(validateProvisionBody({ ...VALID, password }).input?.password).toBe(password);
  });

  it("defaults industry to food_service when omitted", () => {
    expect(validateProvisionBody(VALID).input?.industry).toBe("food_service");
  });

  it("accepts an explicit, enabled industry", () => {
    for (const industry of ["food_service", "jewelry"]) {
      expect(validateProvisionBody({ ...VALID, industry }).input?.industry, industry).toBe(industry);
    }
  });

  it("rejects an unknown industry value", () => {
    expect(validateProvisionBody({ ...VALID, industry: "bakery" }).error).toBe("invalid_industry");
  });

  it("rejects a real but not-yet-offered industry", () => {
    for (const industry of ["watch", "accessories"]) {
      expect(validateProvisionBody({ ...VALID, industry }).error, industry).toBe(
        "industry_not_available",
      );
    }
  });
});
