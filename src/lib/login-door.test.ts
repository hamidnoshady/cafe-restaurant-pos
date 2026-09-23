import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRememberedLoginDoor,
  readRememberedLoginDoor,
  rememberLoginDoor,
} from "./login-door";

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

describe("login-door remembered choice", () => {
  it("returns null when nothing was ever chosen", () => {
    vi.stubGlobal("window", { localStorage: storageThat() });
    expect(readRememberedLoginDoor()).toBeNull();
  });

  it("remembers a door only when remember=true", () => {
    vi.stubGlobal("window", { localStorage: storageThat() });
    rememberLoginDoor("admin", true);
    expect(readRememberedLoginDoor()).toBe("admin");
  });

  it("does not surface a choice made without remember", () => {
    vi.stubGlobal("window", { localStorage: storageThat() });
    rememberLoginDoor("staff", false);
    expect(readRememberedLoginDoor()).toBeNull();
  });

  it("clears a remembered choice", () => {
    vi.stubGlobal("window", { localStorage: storageThat() });
    rememberLoginDoor("staff", true);
    expect(readRememberedLoginDoor()).toBe("staff");
    clearRememberedLoginDoor();
    expect(readRememberedLoginDoor()).toBeNull();
  });

  it("ignores garbage in storage", () => {
    const localStorage = storageThat();
    vi.stubGlobal("window", { localStorage });
    localStorage.setItem("pos:loginDoor", "{not json");
    expect(readRememberedLoginDoor()).toBeNull();
    localStorage.setItem("pos:loginDoor", JSON.stringify({ door: "hacker", remember: true }));
    expect(readRememberedLoginDoor()).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    vi.stubGlobal("window", { localStorage: storageThat(true) });
    expect(readRememberedLoginDoor()).toBeNull();
    expect(() => rememberLoginDoor("admin", true)).not.toThrow();
    expect(() => clearRememberedLoginDoor()).not.toThrow();
  });
});
