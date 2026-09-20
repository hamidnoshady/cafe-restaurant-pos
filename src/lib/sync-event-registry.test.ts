import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifySyncDomainError } from "./sync-events";
import { SyncPayloadError } from "./sync-domain-handlers";
import {
  publicSyncEventRegistry,
  SYNC_EVENT_REGISTRY,
  syncEventDefinition,
  type SyncEventDefinition,
} from "./sync-event-registry";

describe("authoritative sync event registry", () => {
  it("has unique exact-version keys and no implicit version fallback", () => {
    const keys = SYNC_EVENT_REGISTRY.map((entry) => `${entry.type}@${entry.schemaVersion}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SYNC_EVENT_REGISTRY) {
      expect(syncEventDefinition(entry.type, entry.schemaVersion)?.handler).toBe(entry.handler);
      expect(syncEventDefinition(entry.type, entry.schemaVersion + 1000)).toBeNull();
      expect(entry.roles.length).toBeGreaterThan(0);
      expect(entry.payloadFields).not.toContain("businessId");
      expect(entry.payloadFields).not.toContain("locationId");
    }
  });

  it("has one implemented switch handler for every and only transactional definition", () => {
    const source = readFileSync(path.resolve("src/lib/sync-domain-handlers.ts"), "utf8");
    const implemented = [...source.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]).sort();
    const registered = SYNC_EVENT_REGISTRY.filter((entry) => !("legacy" in entry && entry.legacy)).map((entry) => entry.handler).sort();
    expect(implemented).toEqual(registered);
  });

  it("publishes operational metadata without handlers or dependency internals", () => {
    const published = publicSyncEventRegistry();
    expect(published.events).toHaveLength(SYNC_EVENT_REGISTRY.length);
    expect(JSON.stringify(published)).not.toContain("handler");
    expect(JSON.stringify(published)).not.toContain("dependencyErrors");
    expect(published.events.every((event) => {
      const source = SYNC_EVENT_REGISTRY.find(
        (entry) => entry.type === event.type && entry.schemaVersion === event.schemaVersion,
      );
      const legacy = Boolean(source && "legacy" in source && source.legacy);
      return event.transactionalDomainEffect === !legacy;
    })).toBe(true);
  });

  it("requires business-scoped transfer rules only for transfer effects", () => {
    for (const entry of SYNC_EVENT_REGISTRY) {
      expect(entry.locationRule === "business_transfer").toBe(entry.effectClass === "transfer");
    }
  });
});

describe("sync domain failure classification", () => {
  const payment = syncEventDefinition("order.payment.completed", 1) as SyncEventDefinition;

  it("defers declared prerequisites and terminally rejects payload/domain violations", () => {
    expect(classifySyncDomainError(new Error("order_not_found"), payment)).toBe("deferred");
    expect(classifySyncDomainError(new SyncPayloadError("invalid_method"), payment)).toBe("terminal");
    expect(classifySyncDomainError(new Error("refund_exceeds_payment"), payment)).toBe("terminal");
  });

  it("keeps SQL, network, injected and unexpected programming failures retryable", () => {
    expect(classifySyncDomainError(Object.assign(new Error("serialization"), { code: "40001" }), payment)).toBe("transient");
    expect(classifySyncDomainError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), payment)).toBe("transient");
    expect(classifySyncDomainError(new Error("injected_sync_failure_after_domain_effect"), payment)).toBe("transient");
    expect(classifySyncDomainError(new TypeError("cannot read property"), payment)).toBe("transient");
  });
});
