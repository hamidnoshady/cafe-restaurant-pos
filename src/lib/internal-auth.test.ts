/**
 * Phase 24 Wave 5 — the credential that keeps `/api/internal/rate-limit` from
 * being an open endpoint.
 *
 * The route writes caller-supplied keys into a shared counter table and has no
 * session to check (it is called *for* requests that have none), so this
 * secret is the only thing standing between a stranger and the brute-force
 * limiter: without it, anyone able to reach the app could spend another IP's
 * login bucket to lock them out, or reset their own to walk straight past it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalAuthToken, isInternalCall, timingSafeEqualHex } from "./internal-auth";

const REAL_SECRET = "a".repeat(48);

describe("internal-auth", () => {
  const original = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = REAL_SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  it("derives a stable token, and a different one per secret", async () => {
    const first = await internalAuthToken();
    const second = await internalAuthToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Both sides of the call derive it independently, so it must not drift.
    expect(second).toBe(first);

    process.env.JWT_SECRET = "b".repeat(48);
    expect(await internalAuthToken()).not.toBe(first);
  });

  it("is not the signing secret itself", async () => {
    // It is derived from JWT_SECRET rather than being it, so leaking the
    // header cannot hand anyone the key that signs sessions.
    expect(await internalAuthToken()).not.toBe(REAL_SECRET);
  });

  it("refuses to mint a token without a real secret", async () => {
    // Falling back to a fixed value would make the credential public.
    delete process.env.JWT_SECRET;
    expect(await internalAuthToken()).toBeNull();

    process.env.JWT_SECRET = "change-me-in-production";
    expect(await internalAuthToken()).toBeNull();
  });

  it("accepts the real token and rejects everything else", async () => {
    const token = (await internalAuthToken())!;
    expect(await isInternalCall(new Headers({ "x-internal-auth": token }))).toBe(true);

    expect(await isInternalCall(new Headers())).toBe(false);
    expect(await isInternalCall(new Headers({ "x-internal-auth": "" }))).toBe(false);
    expect(await isInternalCall(new Headers({ "x-internal-auth": "not-the-token" }))).toBe(false);
    // One flipped nibble.
    const nudged = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(await isInternalCall(new Headers({ "x-internal-auth": nudged }))).toBe(false);
    // A prefix of the real token must not pass.
    expect(await isInternalCall(new Headers({ "x-internal-auth": token.slice(0, 32) }))).toBe(false);
  });

  it("fails closed when the server has no usable secret", async () => {
    // Otherwise an install with a placeholder JWT_SECRET would accept any
    // header at all, which is worse than accepting none.
    delete process.env.JWT_SECRET;
    expect(await isInternalCall(new Headers({ "x-internal-auth": "anything" }))).toBe(false);
  });

  it("compares without an early exit", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
    // Differing at the first byte, not the last — both must be rejected the
    // same way, and neither may throw.
    expect(timingSafeEqualHex("zbc123", "abc123")).toBe(false);
    expect(timingSafeEqualHex("abc", "abc123")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
