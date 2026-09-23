import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./ui";
import { exportClientErrorLog } from "@/lib/error-report";

/**
 * Section 12 follow-up (see error-report.ts's module doc): the dashboard's
 * shared `api()` fetch wrapper — used by essentially every dashboard/POS
 * screen — silently logs a server-side (5xx) or transport failure into the
 * same exportable client-error ring buffer a render-error boundary uses,
 * with no change to what the caller sees on screen. This is what closes the
 * audit's documented gap that only `error.tsx`/`global-error.tsx` got the
 * full error-ID/log treatment, not the API/fetch error surface.
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

describe("dashboard api() error logging", () => {
  it("logs a 5xx server error without changing the returned result", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }));
    const result = await api("/api/orders", { method: "POST" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(exportClientErrorLog(storage)).toContain("HTTP 500");
    expect(exportClientErrorLog(storage)).toContain("POST /api/orders");
  });

  it("logs a dropped connection (fetch throws) as a transport failure", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await api("/api/menu");
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: "network_error" });
    expect(exportClientErrorLog(storage)).toContain("(no response)");
  });

  it("does not log an ordinary validation rejection (400)", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "missing_fields" }), { status: 400 }));
    await api("/api/orders", { method: "POST" });
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("does not log a deliberate abort", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const controller = new AbortController();
    controller.abort();
    mockFetch(() => {
      throw new DOMException("aborted", "AbortError");
    });
    const result = await api("/api/orders", { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("does not log a normal 2xx success", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await api("/api/orders");
    expect(exportClientErrorLog(storage)).toBe("");
  });
});
