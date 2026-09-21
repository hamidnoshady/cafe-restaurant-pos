import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSecurePosture } from "./deployment-posture";

const require = createRequire(import.meta.url);
const { desktopServerEnvironment, postgresStartStrategy, pgCtlStartArguments } = require(
  "../../electron/backend-manager.js",
) as {
  desktopServerEnvironment: (
    config: { jwtSecret: string; appPort: number; instanceId: string },
    runtimeUrl: string,
    superuserUrl: string,
  ) => Record<string, string>;
  postgresStartStrategy: (platform?: string) => "pg_ctl" | "embedded";
  pgCtlStartArguments: (dataDir: string, logPath: string, port: number) => string[];
};
const writeSigningStatus = require("../../electron/scripts/write-signing-status.js") as (result: {
  outDir: string;
  artifactPaths: string[];
}) => Promise<void>;
const windowsSigningConfig = require("../../electron/scripts/windows-signing-config.js") as {
  afterAllArtifactBuild?: string;
  artifactBuildCompleted?: string;
};

describe("packaged desktop production posture", () => {
  it("pins a supported Node.js 24 Electron runtime and build target", () => {
    const rootManifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    const desktopManifest = JSON.parse(readFileSync(path.resolve("electron/package.json"), "utf8"));
    const desktopLock = JSON.parse(readFileSync(path.resolve("electron/package-lock.json"), "utf8"));
    const runtimeBuilder = readFileSync(path.resolve("scripts/build-desktop-runtime.mjs"), "utf8");
    const electronVersion = desktopManifest.devDependencies.electron as string;

    expect(rootManifest.engines.node).toBe(">=24");
    expect(desktopManifest.engines.node).toBe(">=24");
    expect(desktopManifest.build.electronLanguages).toEqual(["en-US", "fa"]);
    expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.parseInt(electronVersion.split(".")[0], 10)).toBeGreaterThanOrEqual(44);
    expect(desktopLock.packages["node_modules/electron"].version).toBe(electronVersion);
    expect(desktopManifest.build.extraResources).toContainEqual({
      from: "../.desktop-runtime/node_modules",
      to: "desktop-runtime/node_modules",
      filter: ["**/*"],
    });
    expect(runtimeBuilder).toContain('target: "node24"');
    expect(runtimeBuilder).toContain('engines: { node: ">=24" }');
  });

  it("always launches the internal server as a loopback-only production site", () => {
    const env = desktopServerEnvironment(
      { jwtSecret: "test", appPort: 3042, instanceId: "instance" },
      "postgres://pos_app:test@127.0.0.1:5544/pos",
      "postgres://postgres:test@127.0.0.1:5544/pos",
    );
    expect(env).toMatchObject({
      NODE_ENV: "production",
      DEPLOYMENT_ROLE: "site",
      BIND_ADDR: "127.0.0.1",
      PORT: "3042",
    });
    expect(env.ALLOW_INSECURE_LAN).toBeUndefined();
  });

  it("starts Windows PostgreSQL through pg_ctl's restricted-token path", () => {
    expect(postgresStartStrategy("win32")).toBe("pg_ctl");
    expect(postgresStartStrategy("linux")).toBe("embedded");
    const args = pgCtlStartArguments(
      "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\pgdata",
      "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\logs\\postgres.log",
      5544,
    );
    expect(args).toEqual([
      "start", "-D", "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\pgdata",
      "-l", "C:\\Users\\owner\\AppData\\Roaming\\Business Suite\\logs\\postgres.log",
      "-w", "-t", "90", "-o", "-p 5544 -c listen_addresses=127.0.0.1",
    ]);
    expect(args.join(" ")).not.toContain("0.0.0.0");
    expect(() => pgCtlStartArguments("data", "postgres.log", 0)).toThrow(/Invalid PostgreSQL port/);
  });

  it("writes one package-level signing status from electron-builder's BuildResult", async () => {
    expect(windowsSigningConfig.afterAllArtifactBuild).toBe("scripts/write-signing-status.js");
    expect(windowsSigningConfig.artifactBuildCompleted).toBeUndefined();
    const outDir = mkdtempSync(path.join(os.tmpdir(), "desktop-signing-status-"));
    const prior = process.env.WINDOWS_SIGNING_PROVIDER;
    process.env.WINDOWS_SIGNING_PROVIDER = "unsigned";
    try {
      await writeSigningStatus({
        outDir,
        artifactPaths: [path.join(outDir, "Business Suite Setup.exe"), path.join(outDir, "latest.yml")],
      });
      const report = JSON.parse(readFileSync(path.join(outDir, "windows-signing-status.json"), "utf8"));
      expect(report).toMatchObject({
        status: "UNSIGNED DEVELOPMENT",
        provider: "unsigned",
        artifacts: ["Business Suite Setup.exe", "latest.yml"],
      });
    } finally {
      if (prior === undefined) delete process.env.WINDOWS_SIGNING_PROVIDER;
      else process.env.WINDOWS_SIGNING_PROVIDER = prior;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("passes secure posture without an insecure-LAN bypass", () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(() => assertSecurePosture("site", "127.0.0.1", false)).not.toThrow();
      expect(() => assertSecurePosture("site", "0.0.0.0", false)).toThrow(/Production site deployment/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  });
});
