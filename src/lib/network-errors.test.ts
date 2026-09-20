import { describe, expect, it } from "vitest";
import { describeNetworkError, isBenignNetworkError } from "./network-errors";

describe("isBenignNetworkError", () => {
  it("recognises the production crash signature", () => {
    // The exact shape from the deploy log: [Error: aborted] { code: 'ECONNRESET' }
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    expect(isBenignNetworkError(err)).toBe(true);
  });

  it("recognises an abort with no code", () => {
    expect(isBenignNetworkError(new Error("aborted"))).toBe(true);
  });

  it("recognises EPIPE and premature close", () => {
    expect(isBenignNetworkError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(
      isBenignNetworkError(Object.assign(new Error("x"), { code: "ERR_STREAM_PREMATURE_CLOSE" })),
    ).toBe(true);
  });

  it("follows causes and aggregates", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isBenignNetworkError(new Error("wrapped", { cause: inner }))).toBe(true);
    expect(isBenignNetworkError(new AggregateError([inner, inner]))).toBe(true);
    expect(isBenignNetworkError(new AggregateError([inner, new TypeError("boom")]))).toBe(false);
  });

  it("keeps real bugs fatal", () => {
    expect(isBenignNetworkError(new TypeError("x is not a function"))).toBe(false);
    expect(isBenignNetworkError(Object.assign(new Error("db"), { code: "42P01" }))).toBe(false);
    expect(isBenignNetworkError(undefined)).toBe(false);
    expect(isBenignNetworkError("ECONNRESET")).toBe(false);
  });

  it("describes errors on one line", () => {
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    expect(describeNetworkError(err)).toBe("aborted (ECONNRESET)");
  });
});
