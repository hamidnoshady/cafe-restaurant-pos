/**
 * Origin and download-base resolution for the Windows Print Connector
 * installer — the heart of the first-install fix. These tests pin the two
 * rules that the zaniziba.app.eshobe.com failure violated:
 *
 *  1. the connector's allowed origin is the *actual* tenant frontend origin,
 *     normalised — never manufactured;
 *  2. the connector payload download is resolved independently, and prefers a
 *     stable platform address over the tenant's own hostname whenever one is
 *     configured.
 */
import { describe, expect, it } from "vitest";
import {
  buildConnectorDownloadUrl,
  CONNECTOR_ASSET_PATH,
  CONNECTOR_PROTOCOL_VERSION,
  connectorMinVersion,
  mergeAllowedOrigins,
  normalizeOrigin,
  resolveConnectorDownloadBase,
  type ConnectorReleaseEnv,
} from "./connector-release";

describe("normalizeOrigin", () => {
  it("standard tenant domain", () => {
    expect(normalizeOrigin("https://cafe.example.com")).toBe("https://cafe.example.com");
  });

  it("tenant subdomain", () => {
    expect(normalizeOrigin("https://zaniziba.pos.example.com")).toBe("https://zaniziba.pos.example.com");
  });

  it("custom domain", () => {
    expect(normalizeOrigin("https://pos.my-cafe.ir")).toBe("https://pos.my-cafe.ir");
  });

  it("localhost with port", () => {
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("keeps an https origin https", () => {
    expect(normalizeOrigin("https://cafe.example.com/")).toBe("https://cafe.example.com");
  });

  it("strips a trailing slash and any path", () => {
    expect(normalizeOrigin("https://cafe.example.com/")).toBe("https://cafe.example.com");
    expect(normalizeOrigin("https://cafe.example.com/dashboard/settings?tab=printers")).toBe("https://cafe.example.com");
  });

  it("normalises casing and drops the default port", () => {
    expect(normalizeOrigin("HTTPS://CAFE.Example.COM:443")).toBe("https://cafe.example.com");
    expect(normalizeOrigin("http://cafe.example.com:80/")).toBe("http://cafe.example.com");
    expect(normalizeOrigin("https://cafe.example.com:8443")).toBe("https://cafe.example.com:8443");
  });

  it("rejects malformed hostnames", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin("http://")).toBeNull();
  });

  it("rejects non-web schemes", () => {
    expect(normalizeOrigin("file:///tmp/app")).toBeNull();
    expect(normalizeOrigin("ftp://cafe.example.com")).toBeNull();
  });
});

describe("resolveConnectorDownloadBase", () => {
  const noConfig: ConnectorReleaseEnv = {};

  it("uses the request origin when no platform configuration exists (localhost, development)", () => {
    expect(resolveConnectorDownloadBase(noConfig, "http://cafe.localtest.me:3000")).toEqual({
      base: "http://cafe.localtest.me:3000",
      source: "request-origin",
    });
  });

  it("uses the request origin for a custom-domain single-origin deployment", () => {
    expect(resolveConnectorDownloadBase({ PLATFORM_BASE_URL: "https://central.example.com" }, "https://pos.my-cafe.ir")).toEqual({
      base: "https://central.example.com",
      source: "platform",
    });
  });

  it("prefers the platform apex over the tenant hostname on an HTTPS host-routed deployment", () => {
    const env: ConnectorReleaseEnv = { ROOT_DOMAIN: "pos.example.com" };
    // The whole point: the tenant host zaniziba.pos.example.com is NOT where
    // the payload is fetched from when a stable platform name exists.
    const resolved = resolveConnectorDownloadBase(env, "https://zaniziba.pos.example.com");
    expect(resolved).toEqual({ base: "https://pos.example.com", source: "platform" });
  });

  it("uses a staging platform base for a staging tenant", () => {
    const env: ConnectorReleaseEnv = { PLATFORM_BASE_URL: "https://pos.staging.example.com" };
    expect(resolveConnectorDownloadBase(env, "https://zaniziba.staging.example.com")).toEqual({
      base: "https://pos.staging.example.com",
      source: "platform",
    });
  });

  it("does not send a plain-HTTP tenant to an HTTPS apex that answers nothing (local development)", () => {
    // ROOT_DOMAIN=localtest.me is the documented dev setting: https://localtest.me
    // on 443 has no server, so the request origin itself must be the base.
    const env: ConnectorReleaseEnv = { ROOT_DOMAIN: "localtest.me" };
    expect(resolveConnectorDownloadBase(env, "http://zaniziba.localtest.me:3000")).toEqual({
      base: "http://zaniziba.localtest.me:3000",
      source: "request-origin",
    });
  });

  it("honours an explicit CONNECTOR_DOWNLOAD_BASE_URL, including a path prefix", () => {
    const env: ConnectorReleaseEnv = {
      CONNECTOR_DOWNLOAD_BASE_URL: "https://downloads.example.com/cafe-pos/",
      ROOT_DOMAIN: "pos.example.com",
    };
    expect(resolveConnectorDownloadBase(env, "https://zaniziba.pos.example.com")).toEqual({
      base: "https://downloads.example.com/cafe-pos",
      source: "explicit",
    });
  });

  it("an explicit base also wins on plain-HTTP deployments", () => {
    const env: ConnectorReleaseEnv = { CONNECTOR_DOWNLOAD_BASE_URL: "http://192.168.1.10/pos" };
    expect(resolveConnectorDownloadBase(env, "http://pos.lan:3000")).toEqual({
      base: "http://192.168.1.10/pos",
      source: "explicit",
    });
  });

  it("missing domain config falls back to the request origin", () => {
    expect(resolveConnectorDownloadBase({}, "https://everything-else-unset.example.com")).toEqual({
      base: "https://everything-else-unset.example.com",
      source: "request-origin",
    });
  });

  it("an invalid explicit base is a configuration error, not a silent fallback", () => {
    expect(resolveConnectorDownloadBase({ CONNECTOR_DOWNLOAD_BASE_URL: "not-a-url" }, "https://cafe.example.com")).toBeNull();
    expect(resolveConnectorDownloadBase({ CONNECTOR_DOWNLOAD_BASE_URL: "ftp://files.example.com" }, "https://cafe.example.com")).toBeNull();
  });

  it("a malformed request origin resolves nothing", () => {
    expect(resolveConnectorDownloadBase(noConfig, "not an origin")).toBeNull();
  });
});

describe("buildConnectorDownloadUrl", () => {
  it("appends the canonical payload path to the base", () => {
    expect(buildConnectorDownloadUrl("https://pos.example.com")).toBe(`https://pos.example.com${CONNECTOR_ASSET_PATH}`);
    expect(buildConnectorDownloadUrl("https://downloads.example.com/cafe-pos")).toBe(
      `https://downloads.example.com/cafe-pos${CONNECTOR_ASSET_PATH}`,
    );
  });

  it("is generated independently of the tenant origin", () => {
    // If the tenant host were ever concatenated in, this URL would contain it.
    const url = buildConnectorDownloadUrl("https://pos.example.com");
    expect(url).not.toContain("zaniziba");
  });

  it("rejects an unusable base", () => {
    expect(() => buildConnectorDownloadUrl("javascript:alert(1)")).toThrow("invalid_connector_download_base");
  });
});

describe("mergeAllowedOrigins", () => {
  it("puts the request origin first and deduplicates the rest", () => {
    expect(
      mergeAllowedOrigins("https://zaniziba.pos.example.com", [
        "https://zaniziba.pos.example.com/",
        "https://zaniziba-old.pos.example.com",
      ]),
    ).toEqual(["https://zaniziba.pos.example.com", "https://zaniziba-old.pos.example.com"]);
  });

  it("normalises every entry the same way the connector does", () => {
    expect(mergeAllowedOrigins("HTTPS://Zaniziba.POS.Example.COM:443/", ["http://192.168.1.10:3000/"])).toEqual([
      "https://zaniziba.pos.example.com",
      "http://192.168.1.10:3000",
    ]);
  });

  it("drops entries that are not origins at all", () => {
    expect(mergeAllowedOrigins("https://cafe.example.com", ["not-a-url", "", null, undefined])).toEqual([
      "https://cafe.example.com",
    ]);
  });

  it("refuses a primary origin it cannot normalise", () => {
    expect(() => mergeAllowedOrigins("garbage")).toThrow("unsupported_installer_origin");
  });
});

describe("connectorMinVersion", () => {
  it("defaults to the protocol version the client speaks", () => {
    expect(connectorMinVersion({})).toBe(CONNECTOR_PROTOCOL_VERSION);
  });

  it("honours CONNECTOR_MIN_VERSION when it is a usable integer", () => {
    expect(connectorMinVersion({ CONNECTOR_MIN_VERSION: "2" })).toBe(2);
  });

  it("ignores junk rather than breaking printing", () => {
    expect(connectorMinVersion({ CONNECTOR_MIN_VERSION: "soon" })).toBe(CONNECTOR_PROTOCOL_VERSION);
    expect(connectorMinVersion({ CONNECTOR_MIN_VERSION: "0" })).toBe(CONNECTOR_PROTOCOL_VERSION);
  });
});
