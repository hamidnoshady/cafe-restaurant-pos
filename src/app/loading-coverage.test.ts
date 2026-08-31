/**
 * Route transitions must never fall back to a blank document while server or
 * client data resolves. Keep one loading boundary for the root and one for
 * each visual realm whose chrome differs from it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("./", import.meta.url));

const BOUNDARIES = [
  { path: "loading.tsx", primitive: "Skeleton" },
  { path: "dashboard/loading.tsx", primitive: "DashboardPageSkeleton" },
  { path: "platform/loading.tsx", primitive: "PlatformPageSkeleton" },
  { path: "setup/loading.tsx", primitive: "Skeleton" },
] as const;

describe("route-level skeleton coverage", () => {
  for (const boundary of BOUNDARIES) {
    it(`${boundary.path} renders its realm's structural fallback`, () => {
      const path = `${APP_DIR}/${boundary.path}`;
      expect(existsSync(path), `${boundary.path} is missing`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(boundary.primitive);
    });
  }
});
