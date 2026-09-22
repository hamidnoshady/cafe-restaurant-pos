import { describe, expect, it, vi } from "vitest";
import {
  buildTechnicalReport,
  exportClientErrorLog,
  generateErrorId,
  recordClientError,
  redactSecrets,
} from "./error-report";

describe("generateErrorId", () => {
  it("has the ERR-XXXX-XXXX shape in the confusion-free base32 alphabet", () => {
    const id = generateErrorId("boom", 1700000000000);
    expect(id).toMatch(/^ERR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("is deterministic for the same seed and timestamp", () => {
    expect(generateErrorId("boom", 42)).toBe(generateErrorId("boom", 42));
  });

  it("differs for a different seed or timestamp", () => {
    expect(generateErrorId("boom", 42)).not.toBe(generateErrorId("bang", 42));
    expect(generateErrorId("boom", 42)).not.toBe(generateErrorId("boom", 43));
  });
});

describe("redactSecrets", () => {
  it("redacts a Postgres connection string's password", () => {
    expect(redactSecrets("failed: postgres://app:hunter2@db:5432/pos")).toBe(
      "failed: postgres://app:[REDACTED]@db:5432/pos",
    );
  });

  it("redacts a bearer token", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts a labelled secret/token/password/passphrase", () => {
    expect(redactSecrets("jwt_secret=super-secret-value end")).toBe("jwt_secret=[REDACTED] end");
    expect(redactSecrets("password: hunter2, more")).toBe("password: [REDACTED], more");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("order 42 failed to save")).toBe("order 42 failed to save");
  });
});

describe("buildTechnicalReport", () => {
  it("includes the error id, message and stack, omitting absent optional fields", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "boom",
      stack: "at foo (bar.ts:1:1)",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(report).toContain("Error ID: ERR-AAAA-BBBB");
    expect(report).toContain("Occurred at: 2026-01-01T00:00:00.000Z");
    expect(report).toContain("Message: boom");
    expect(report).toContain("Stack:");
    expect(report).toContain("at foo (bar.ts:1:1)");
    expect(report).not.toContain("Server digest");
    expect(report).not.toContain("App version");
  });

  it("redacts secrets in both message and stack", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "connect failed: postgres://app:hunter2@db/pos",
      stack: "password=hunter2\nat connect",
    });
    expect(report).not.toContain("hunter2");
  });

  it("includes digest/appVersion/url/userAgent when present", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "boom",
      digest: "abc123",
      appVersion: "1.0.5",
      url: "https://pos.example.com/dashboard",
      userAgent: "TestAgent/1.0",
    });
    expect(report).toContain("Server digest: abc123");
    expect(report).toContain("App version: 1.0.5");
    expect(report).toContain("URL: https://pos.example.com/dashboard");
    expect(report).toContain("User agent: TestAgent/1.0");
  });
});

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("recordClientError / exportClientErrorLog", () => {
  it("round-trips a single entry", () => {
    const storage = fakeStorage();
    recordClientError({ errorId: "ERR-0001-AAAA", occurredAt: "2026-01-01T00:00:00.000Z", report: "report one" }, storage);
    expect(exportClientErrorLog(storage)).toBe("report one");
  });

  it("joins multiple entries with a separator, oldest first", () => {
    const storage = fakeStorage();
    recordClientError({ errorId: "ERR-0001-AAAA", occurredAt: "t1", report: "first" }, storage);
    recordClientError({ errorId: "ERR-0002-BBBB", occurredAt: "t2", report: "second" }, storage);
    const exported = exportClientErrorLog(storage);
    expect(exported.indexOf("first")).toBeLessThan(exported.indexOf("second"));
    expect(exported).toContain("====");
  });

  it("caps the ring buffer instead of growing unbounded", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 60; i += 1) {
      recordClientError({ errorId: `ERR-${i}`, occurredAt: String(i), report: `report ${i}` }, storage);
    }
    const exported = exportClientErrorLog(storage);
    expect(exported).not.toContain("report 0\n");
    expect(exported).toContain("report 59");
    // 50-cap: entries 10..59 survive.
    expect(exported).not.toContain("report 9\n");
    expect(exported).toContain("report 10");
  });

  it("returns an empty string and never throws when storage is unavailable", () => {
    expect(exportClientErrorLog(undefined)).toBe("");
    expect(() => recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, undefined)).not.toThrow();
  });

  it("tolerates a storage whose setItem throws (quota exceeded)", () => {
    const storage = fakeStorage();
    const spy = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, storage),
    ).not.toThrow();
    spy.mockRestore();
  });

  it("tolerates corrupted JSON already in storage", () => {
    const storage = fakeStorage();
    storage.setItem("pos:clientErrorLog", "{not json");
    expect(exportClientErrorLog(storage)).toBe("");
    expect(() =>
      recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, storage),
    ).not.toThrow();
  });
});
