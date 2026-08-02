import { describe, expect, it } from "vitest";
import { auditActionLabel, auditEntityLabel, credentialKindFromId, credentialKindLabel } from "./audit";

describe("auditActionLabel", () => {
  it("labels a known action", () => {
    expect(auditActionLabel("shift.opened")).toBe("شروع شیفت");
    expect(auditActionLabel("employee.session_created")).toBe("ورود به سیستم");
    expect(auditActionLabel("employee.login_failed")).toBe("تلاش ورود ناموفق");
  });

  it("falls back to the raw action for an unrecognised value", () => {
    expect(auditActionLabel("future.thing_happened")).toBe("future.thing_happened");
  });
});

describe("auditEntityLabel", () => {
  it("labels a known entity", () => {
    expect(auditEntityLabel("shift")).toBe("شیفت");
  });

  it("falls back to a dash when entity is null", () => {
    expect(auditEntityLabel(null)).toBe("—");
  });

  it("falls back to the raw entity for an unrecognised value", () => {
    expect(auditEntityLabel("widget")).toBe("widget");
  });
});

describe("credentialKindFromId", () => {
  it("is pin when no credential id is present", () => {
    expect(credentialKindFromId(null)).toBe("pin");
    expect(credentialKindFromId(undefined)).toBe("pin");
  });

  it("is webauthn when a credential id is present", () => {
    expect(credentialKindFromId("11111111-1111-1111-1111-111111111111")).toBe("webauthn");
  });
});

describe("credentialKindLabel", () => {
  it("labels each kind in Persian", () => {
    expect(credentialKindLabel("pin")).toBe("پین");
    expect(credentialKindLabel("webauthn")).toBe("بیومتریک");
  });
});
