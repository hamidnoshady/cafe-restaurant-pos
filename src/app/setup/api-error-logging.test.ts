import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./ui";
import { exportClientErrorLog } from "@/lib/error-report";

/**
 * Section 12 follow-up (see error-report.ts's module doc and
 * src/app/dashboard/api-error-logging.test.ts for the same coverage on the
 * dashboard's wrapper): the first-run setup wizard's shared `api()` fetch
 * wrapper also logs a server-side (5xx) failure into the same exportable
 * client-error ring buffer, with no change to the returned result.
 */

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

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setup wizard api() error logging", () => {
  it("logs a 5xx server error without changing the returned result", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }));
    const result = await api("/api/setup/bootstrap", { method: "POST" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(exportClientErrorLog(storage)).toContain("HTTP 500");
  });

  it("does not log an ordinary validation rejection (400)", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "missing_fields" }), { status: 400 }));
    await api("/api/setup/bootstrap", { method: "POST" });
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("does not log a normal 2xx success", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await api("/api/setup/state");
    expect(exportClientErrorLog(storage)).toBe("");
  });
});
