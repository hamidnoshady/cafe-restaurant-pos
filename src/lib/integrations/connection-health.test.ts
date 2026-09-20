import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveTransportHealth, PLUGIN_HEALTH_STALE_MS } from "./connections-service";

const source = readFileSync("src/lib/integrations/connections-service.ts", "utf8");

const base = {
  link_mode: "plugin" as const,
  status: "active" as const,
  last_error: null,
  plugin_site_mismatch_at: null,
};

describe("deriveTransportHealth", () => {
  it("reports plugin never connected", () => {
    const health = deriveTransportHealth({ ...base, last_plugin_seen_at: null }, new Date("2026-09-19T12:00:00Z"));
    expect(health.state).toBe("never_connected");
  });

  it("reports fresh plugin as healthy", () => {
    const health = deriveTransportHealth(
      { ...base, last_plugin_seen_at: "2026-09-19T11:55:00.000Z" },
      new Date("2026-09-19T12:00:00Z"),
    );
    expect(health.state).toBe("healthy");
  });

  it("reports plugin as stale after the configured freshness window", () => {
    const health = deriveTransportHealth(
      { ...base, last_plugin_seen_at: new Date(Date.parse("2026-09-19T12:00:00Z") - PLUGIN_HEALTH_STALE_MS - 1).toISOString() },
      new Date("2026-09-19T12:00:00Z"),
    );
    expect(health.state).toBe("stale");
  });

  it("reports paused separately from stale", () => {
    const health = deriveTransportHealth(
      { ...base, status: "paused", last_plugin_seen_at: "2026-09-01T00:00:00Z" },
      new Date("2026-09-19T12:00:00Z"),
    );
    expect(health.state).toBe("paused");
    expect(health.message).toContain("متوقف");
  });
});

describe("connection audit hygiene", () => {
  it("does not write raw credential update payloads into integration audit logs", () => {
    expect(source).not.toContain('action: "connection.updated", payload: input');
    expect(source).toContain('auditPayload[secretKey] = "[stored]"');
    expect(source).toContain('"consumerSecret"');
    expect(source).toContain('"wpApplicationPassword"');
  });
});
