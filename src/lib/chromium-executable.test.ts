import { describe, expect, it } from "vitest";
import { chromiumLaunchArgs, findChromiumExecutable } from "./chromium-executable";

describe("desktop Chromium discovery", () => {
  it("prefers Windows 11 Edge without requiring a second browser payload", () => {
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(
      findChromiumExecutable(
        { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" },
        "win32",
        (candidate) => candidate === edge,
      ),
    ).toBe(edge);
  });

  it("honours an explicit trusted executable before probing defaults", () => {
    expect(
      findChromiumExecutable({ PRINT_CHROMIUM_PATH: "D:\\Browser\\chrome.exe" }, "win32", () => false),
    ).toBe("D:\\Browser\\chrome.exe");
  });

  it("fails clearly instead of silently depending on a nonexistent browser", () => {
    expect(() => findChromiumExecutable({}, "win32", () => false)).toThrow(/No supported Chromium browser/);
  });

  it("keeps no-sandbox limited to container-oriented Linux launches", () => {
    expect(chromiumLaunchArgs("linux")).toEqual(["--no-sandbox"]);
    expect(chromiumLaunchArgs("win32")).toEqual([]);
  });
});
