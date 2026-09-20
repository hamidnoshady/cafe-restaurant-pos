import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { assertSecurePosture } from "./deployment-posture";

const require = createRequire(import.meta.url);
const { desktopServerEnvironment } = require("../../electron/backend-manager.js") as {
  desktopServerEnvironment: (
    config: { jwtSecret: string; appPort: number; instanceId: string },
    runtimeUrl: string,
    superuserUrl: string,
  ) => Record<string, string>;
};

describe("packaged desktop production posture", () => {
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
