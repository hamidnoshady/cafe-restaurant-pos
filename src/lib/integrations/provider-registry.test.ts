import { describe, expect, it } from "vitest";
import { assertSupportedProvider, isHoloo, isWooCommerce, providerIdFor, PROVIDER_HOLOO, PROVIDER_WOOCOMMERCE } from "./provider-registry";

const conn = (provider: string) => ({ provider });

describe("providerIdFor", () => {
  it("maps holoo and everything else (woocommerce) to typed ids", () => {
    expect(providerIdFor("holoo")).toBe(PROVIDER_HOLOO);
    expect(providerIdFor("woocommerce")).toBe(PROVIDER_WOOCOMMERCE);
    expect(providerIdFor("")).toBe(PROVIDER_WOOCOMMERCE);
  });
});

describe("isWooCommerce / isHoloo", () => {
  it("distinguishes the two providers", () => {
    expect(isWooCommerce(conn("woocommerce"))).toBe(true);
    expect(isWooCommerce(conn("holoo"))).toBe(false);
    expect(isHoloo(conn("holoo"))).toBe(true);
    expect(isHoloo(conn("woocommerce"))).toBe(false);
  });
});

describe("assertSupportedProvider", () => {
  it("accepts the two known providers and rejects anything else", () => {
    expect(assertSupportedProvider("woocommerce")).toBe(PROVIDER_WOOCOMMERCE);
    expect(assertSupportedProvider("holoo")).toBe(PROVIDER_HOLOO);
    expect(() => assertSupportedProvider("sepidar")).toThrow(/unsupported_provider/);
  });
});
