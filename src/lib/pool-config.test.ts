import { afterEach, describe, expect, it } from "vitest";
import { poolMax } from "./pool-config";

describe("poolMax", () => {
  const original = process.env.DB_POOL_MAX;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = original;
  });

  it("defaults to 20 when unset", () => {
    delete process.env.DB_POOL_MAX;
    expect(poolMax()).toBe(20);
  });

  it("uses a configured value", () => {
    process.env.DB_POOL_MAX = "40";
    expect(poolMax()).toBe(40);
  });

  it("falls back to the default for garbage, zero, or negative values", () => {
    for (const value of ["not-a-number", "0", "-5", ""]) {
      process.env.DB_POOL_MAX = value;
      expect(poolMax()).toBe(20);
    }
  });

  it("floors a fractional value", () => {
    process.env.DB_POOL_MAX = "15.7";
    expect(poolMax()).toBe(15);
  });
});
