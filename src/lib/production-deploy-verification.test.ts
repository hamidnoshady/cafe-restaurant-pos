import { describe, expect, it, vi } from "vitest";
import {
  DeploymentVerificationError,
  PROTECTED_PATHS,
  deploymentUrls,
  parseOptions,
  verifyDeployment,
} from "../../scripts/verify-production-deploy.mjs";

const BASE = "https://cafe.example.test";
const SHA = "2fe770d";

function response(body: string, init: ResponseInit): Response {
  return new Response(body, init);
}

describe("production deployment verification", () => {
  it("accepts a bare origin or the health endpoint, but rejects a misleading path prefix", () => {
    expect(deploymentUrls(BASE).healthUrl.href).toBe(`${BASE}/api/health`);
    expect(deploymentUrls(`${BASE}/api/health`).baseUrl.href).toBe(`${BASE}/`);
    expect(() => deploymentUrls(`${BASE}/anything-else`)).toThrow(
      "bare origin or end exactly in /api/health",
    );
  });

  it("requires an explicit health URL and image SHA instead of accepting an unverified target", () => {
    const env = { NODE_ENV: "test" } as const;
    expect(() => parseOptions([], env)).toThrow("Both --health-url and --expected-sha are required");
    expect(() =>
      parseOptions(["--health-url", BASE, "--expected-sha", "not-a-sha"], env),
    ).toThrow("must be a Git SHA");
  });

  it("rejects an old-but-healthy image before it can be mistaken for a deployed route fix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(JSON.stringify({ ok: true, version: "16379b3" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      verifyDeployment(
        {
          ...deploymentUrls(BASE),
          expectedSha: SHA,
          attempts: 1,
          delayMs: 0,
        },
        { fetchImpl, log: vi.fn() },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DeploymentVerificationError>>({
        name: "DeploymentVerificationError",
        message: expect.stringContaining("APP_IMAGE_SHA=16379b3, expected 2fe770d"),
      }),
    );

    // No route verdict is meaningful until the actual image is known.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL(`${BASE}/api/health`));
  });

  it("requires every affected canonical URL to take the normal signed-out login bounce", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") {
        return response(JSON.stringify({ ok: true, version: SHA }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return response("", {
        status: 307,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname)}` },
      });
    });

    const result = await verifyDeployment(
      {
        ...deploymentUrls(`${BASE}/api/health`),
        expectedSha: SHA,
        attempts: 1,
        delayMs: 0,
      },
      { fetchImpl, log: vi.fn() },
    );

    expect(result.health.version).toBe(SHA);
    expect(result.routes).toEqual(PROTECTED_PATHS);
  });

  it("fails if a top-level route has been rewritten to its retired /dashboard address", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") {
        return response(JSON.stringify({ ok: true, version: SHA }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/accounting/overview") {
        return response("", {
          status: 307,
          headers: { Location: "/login?next=%2Fdashboard%2Faccounting" },
        });
      }
      return response("", {
        status: 307,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname)}` },
      });
    });

    await expect(
      verifyDeployment(
        {
          ...deploymentUrls(BASE),
          expectedSha: SHA,
          attempts: 1,
          delayMs: 0,
        },
        { fetchImpl, log: vi.fn() },
      ),
    ).rejects.toThrow(
      "/accounting/overview: expected Location https://cafe.example.test/login?next=%2Faccounting%2Foverview, got https://cafe.example.test/login?next=%2Fdashboard%2Faccounting",
    );
  });
});
