import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canStoreDeviceToken,
  clearDeviceToken,
  DEVICE_TOKEN_STORAGE_KEY,
  readDeviceToken,
  storeDeviceToken,
} from "./device-token";

function storageThat(throws = false): Storage {
  const values = new Map<string, string>();
  const access = <T>(fn: () => T): T => {
    if (throws) throw new Error("storage unavailable");
    return fn();
  };
  return {
    get length() {
      return access(() => values.size);
    },
    clear: () => access(() => values.clear()),
    getItem: (key) => access(() => values.get(key) ?? null),
    key: (index) => access(() => [...values.keys()][index] ?? null),
    removeItem: (key) => access(() => values.delete(key)),
    setItem: (key, value) => access(() => values.set(key, value)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paired device token browser storage", () => {
  it("stores, reads, and clears a token through one shared key", () => {
    const localStorage = storageThat();
    vi.stubGlobal("window", { localStorage });

    expect(canStoreDeviceToken()).toBe(true);
    expect(readDeviceToken()).toBeNull();
    expect(storeDeviceToken("posdev_example")).toBe(true);
    expect(readDeviceToken()).toBe("posdev_example");

    clearDeviceToken();
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBeNull();
    expect(readDeviceToken()).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    vi.stubGlobal("window", { localStorage: storageThat(true) });

    expect(canStoreDeviceToken()).toBe(false);
    expect(readDeviceToken()).toBeNull();
    expect(storeDeviceToken("posdev_example")).toBe(false);
    expect(() => clearDeviceToken()).not.toThrow();
  });
});
