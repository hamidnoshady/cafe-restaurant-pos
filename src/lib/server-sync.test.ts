import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { legacySyncTokenAllowed } from "./server-sync";

describe("server-sync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("legacySyncTokenAllowed() defaults to false", () => {
    delete process.env.ALLOW_LEGACY_SYNC_TOKEN;
    expect(legacySyncTokenAllowed()).toBe(false);

    process.env.ALLOW_LEGACY_SYNC_TOKEN = "0";
    expect(legacySyncTokenAllowed()).toBe(false);

    process.env.ALLOW_LEGACY_SYNC_TOKEN = "1";
    expect(legacySyncTokenAllowed()).toBe(true);
  });
});
