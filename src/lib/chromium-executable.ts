/**
 * Locate the browser engine used for Persian/RTL receipt rasterisation and PDF
 * export. Windows 11 ships Edge, so the standalone desktop does not need to
 * carry a second Chromium payload; explicit environment overrides remain for
 * managed servers.
 */
import { existsSync } from "node:fs";
import { win32 as winPath } from "node:path";

export function findChromiumExecutable(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const override = env.PRINT_CHROMIUM_PATH || env.PDF_CHROMIUM_PATH;
  if (override) return override;

  const candidates = platform === "win32"
    ? [
        winPath.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        winPath.join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        winPath.join(env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        winPath.join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        winPath.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        winPath.join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : platform === "darwin"
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/opt/pw-browsers/chromium",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/microsoft-edge",
        ];

  for (const candidate of candidates) {
    try {
      if (candidate && exists(candidate)) return candidate;
    } catch {
      // An inaccessible installation path is not a usable browser.
    }
  }
  throw new Error(
    "No supported Chromium browser was found. Windows 11 should provide Microsoft Edge; " +
      "otherwise set PRINT_CHROMIUM_PATH or PDF_CHROMIUM_PATH to a trusted Chrome/Edge executable.",
  );
}

export function chromiumLaunchArgs(platform: NodeJS.Platform = process.platform): string[] {
  // Containerised Linux often has no user-namespace sandbox. Do not weaken
  // the browser sandbox on the Windows desktop where Edge supports it.
  return platform === "linux" ? ["--no-sandbox"] : [];
}
