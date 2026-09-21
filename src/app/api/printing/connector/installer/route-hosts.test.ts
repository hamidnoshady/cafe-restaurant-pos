import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Host → allowed-origin contract for the one-click connector installer.
 *
 * The generated installer bakes in two origins that were conflated in the
 * original bug: the connector's ALLOWED origin (CORS — which browser origin
 * may print) and its DOWNLOAD URL (where the payload is fetched from). This
 * suite pins the first half: every request-host/ROOT_DOMAIN/routing-state
 * combination the README and runbooks advertise, including the anti-cases
 * (unknown domains, other tenants' hosts) which must refuse rather than echo.
 */

// The tenant resolver needs Postgres; give the route a label set per test so
// the origin-construction rules are what each assertion measures.
vi.mock("@/lib/host-resolution", () => ({
  listBusinessHostLabels: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(async () => ({
      session: { businessId: "biz-1", businessSubdomain: "app" },
      error: null,
    })),
    withTenantScope: <T,>(handler: (request: NextRequest) => Promise<T>) => handler,
  };
});

import { listBusinessHostLabels } from "@/lib/host-resolution";
import { GET } from "./route";

const listLabels = listBusinessHostLabels as unknown as ReturnType<typeof vi.fn>;

function installerRequest(host: string, proto: string): NextRequest {
  if (host.startsWith("http://") || host.startsWith("https://")) host = new URL(host).host;
  return new NextRequest(`${proto}://internal/api/printing/connector/installer`, {
    headers: { host, "x-forwarded-proto": proto },
  });
}

function stubRouting(rootDomain: string, routing: string | null) {
  vi.stubEnv("ROOT_DOMAIN", rootDomain);
  if (routing === null) vi.stubEnv("SUBDOMAIN_ROUTING", "");
  else vi.stubEnv("SUBDOMAIN_ROUTING", routing);
}

function stubLabels(subdomain: string, aliases: string[] = []) {
  listLabels.mockResolvedValue({ subdomain, aliases });
}

function extract(body: string, key: "$allowedOrigin" | "$scriptUrl"): string {
  const match = body.match(new RegExp(`\\${key} = '([^']*)'`));
  expect(match, `${key} line in installer`).toBeTruthy();
  return match![1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  listLabels.mockReset();
});

describe("host → allowed origin (the ten published mappings)", () => {
  it("1. publish-root apex on a non-host-routed install keeps the apex as the origin", async () => {
    // A whole deployment behind one domain — ROOT_DOMAIN unset means this
    // origin IS the tenant, so the request origin is the answer.
    stubRouting("", "off");
    const body = await (await GET(installerRequest("mydomains.com", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://mydomains.com");
  });

  it("2. one-level tenant subdomain → that exact origin", async () => {
    stubRouting("mydomains.com", "on");
    stubLabels("app");
    const body = await (await GET(installerRequest("app.mydomains.com", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://app.mydomains.com");
  });

  it("3. multi-level root (RM1-style) → one label under the deeper root", async () => {
    stubRouting("rm1.mydomains.com", "on");
    stubLabels("tenant");
    const body = await (await GET(installerRequest("tenant.rm1.mydomains.com", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://tenant.rm1.mydomains.com");
  });

  it("4. unknown domain under host routing → refuse, never echo the header", async () => {
    stubRouting("mydomains.com", "on");
    stubLabels("app");
    const response = await GET(installerRequest("example.notconfigured.com", "https"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "installer_wrong_host" });
  });

  it("5. custom domain on a whole-install base (host routing off) → the custom origin", async () => {
    stubRouting("", "off");
    const body = await (await GET(installerRequest("pos.customdomain.com", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://pos.customdomain.com");
  });

  it("6. localhost (no port) → http origin", async () => {
    stubRouting("", "off");
    const body = await (await GET(installerRequest("localhost:3000", "http"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("http://localhost:3000");
  });

  it("7. localhost on a custom PORT preserves it in the origin", async () => {
    stubRouting("", "off");
    const body = await (await GET(installerRequest("localhost:3000", "http"))).text();
    expect(body).toContain("$allowedOrigin = 'http://localhost:3000'");
  });

  it("8. 127.0.0.1 with port → http origin with the port kept", async () => {
    stubRouting("", "off");
    const body = await (await GET(installerRequest("127.0.0.1:3000", "http"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("http://127.0.0.1:3000");
  });

  it("9. a redundant default port in the Host header collapses to the same origin", async () => {
    stubRouting("mydomains.com", "on");
    stubLabels("app");
    const body = await (await GET(installerRequest("app.mydomains.com:443", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://app.mydomains.com");
  });

  it("10. request-URL normalisation: uppercase host, trailing slash, and default port are one origin", async () => {
    // A request Host header never contains a scheme — but when middleware
    // forwards one (or a client spells the origin) the same normalisation
    // must hold: case folds, the slash is not part of an origin, and :443 is
    // HTTPS's default.
    const variants = ["app.mydomains.com", "APP.MYDOMAINS.COM", "app.mydomains.com:443", "app.mydomains.com/"];
    stubRouting("mydomains.com", "on");
    stubLabels("app");
    for (const host of variants) {
      const body = await (await GET(installerRequest(host, "https"))).text();
      expect(extract(body, "$allowedOrigin")).toBe("https://app.mydomains.com");
    }
    expect(new URL("HTTPS://App.MYDOMAINS.COM/").origin).toBe("https://app.mydomains.com");
  });
});

describe("tenant isolation of the allowed-origin set", () => {
  it("another tenant's host is refused, not minted into an installer", async () => {
    stubRouting("app.eshobe.com", "on");
    stubLabels("zaniziba");
    const response = await GET(installerRequest("someone-else.app.eshobe.com", "https"));
    expect(response.status).toBe(403);
  });

  it("the canonical subdomain is the primary origin even when an alias serves the request", async () => {
    stubRouting("app.eshobe.com", "on");
    stubLabels("zaniziba", ["zaniziba-old"]);
    const body = await (await GET(installerRequest("zaniziba-old.app.eshobe.com", "https"))).text();
    expect(extract(body, "$allowedOrigin")).toBe("https://zaniziba.app.eshobe.com");
    // The alias is still a legitimate origin of the business during the rename window.
    expect(body).toContain("https://zaniziba-old.app.eshobe.com");
  });

  it("an attacker-supplied Origin header does not enter the allowed set", async () => {
    stubRouting("app.eshobe.com", "on");
    stubLabels("zaniziba");
    const request = new NextRequest("https://internal/api/printing/connector/installer", {
      headers: {
        host: "zaniziba.app.eshobe.com",
        "x-forwarded-proto": "https",
        origin: "https://evil.example.com",
      },
    });
    const body = await (await GET(request)).text();
    expect(body).not.toContain("evil.example.com");
  });

  it("never fabricates a tenant host from the request: labels come from the database only", async () => {
    stubRouting("app.eshobe.com", "on");
    // The DNS resolver knows this business only as "zaniziba"; a request Host
    // that *implies* another label must not leak into the generated script.
    stubLabels("zaniziba");
    await GET(installerRequest("zaniziba.app.eshobe.com", "https")).then(async (r) => {
      const body = await r.text();
      expect(body).toContain("$allowedOrigin = 'https://zaniziba.app.eshobe.com'");
      expect(body).not.toContain("https://zaniziba-renamed.app.eshobe.com");
    });
  });
});
