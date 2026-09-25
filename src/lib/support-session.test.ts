import { describe, expect, it } from "vitest";
import type { SessionPayload } from "./auth-edge";
import { supportMutationAllowed, validSupportReason } from "./support-session";

const session = (mode?: "read_only" | "controlled" | "full"): SessionPayload => ({
  sub: "user", role: "owner", businessId: "business", locationId: null, fullName: "Test",
  ...(mode ? { imp: { grantId: "grant", adminId: "admin", mode, allowedCapabilities: ["printer.test"] } } : {}),
});

describe("support session policy", () => {
  it("requires a meaningful normalized reason", () => {
    expect(validSupportReason("          ")).toBe(false);
    expect(validSupportReason("short")).toBe(false);
    expect(validSupportReason("بررسی مشکل چاپگر فروشگاه")).toBe(true);
  });

  it("denies every write in read-only mode", () => {
    expect(supportMutationAllowed(session("read_only"), "/api/printing/jobs")).toBe(false);
  });

  it("allows only explicitly granted technical actions in controlled mode", () => {
    expect(supportMutationAllowed(session("controlled"), "/api/printing/jobs")).toBe(true);
    expect(supportMutationAllowed(session("controlled"), "/api/orders/123")).toBe(false);
  });

  it("does not restrict normal tenant sessions or full support", () => {
    expect(supportMutationAllowed(session(), "/api/orders")).toBe(true);
    expect(supportMutationAllowed(session("full"), "/api/orders")).toBe(true);
  });
});
