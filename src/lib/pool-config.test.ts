import { afterEach, describe, expect, it } from "vitest";
import { connectTimeoutMs, poolMax } from "./pool-config";

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

describe("connectTimeoutMs", () => {
  const original = process.env.DB_CONNECT_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_CONNECT_TIMEOUT_MS;
    else process.env.DB_CONNECT_TIMEOUT_MS = original;
  });

  it("defaults to 30s — a bound on a hung lookup, not on a queued request", () => {
    delete process.env.DB_CONNECT_TIMEOUT_MS;
    expect(connectTimeoutMs()).toBe(30_000);
  });

  it("uses a configured value", () => {
    process.env.DB_CONNECT_TIMEOUT_MS = "5000";
    expect(connectTimeoutMs()).toBe(5_000);
  });

  it("falls back to the default rather than ever waiting forever", () => {
    for (const value of ["not-a-number", "0", "-1", ""]) {
      process.env.DB_CONNECT_TIMEOUT_MS = value;
      expect(connectTimeoutMs()).toBe(30_000);
    }
  });
});
