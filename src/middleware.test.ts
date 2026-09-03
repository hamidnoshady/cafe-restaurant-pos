import { describe, expect, it } from "vitest";
import { isPeerBackupPath, isPublicPath } from "./middleware";

describe("isPublicPath", () => {
  it("lets the root path through so it can choose between login and the wizard", () => {
    // The regression this guards: `/` used to be gated here, so an
    // unauthenticated visitor was redirected to /login before src/app/page.tsx
    // could ask whether the install has any users. A fresh desktop install
    // opens exactly `/`, so the first-run wizard was unreachable.
    expect(isPublicPath("/")).toBe(true);
  });

  it("keeps the first-run wizard and its state endpoint session-less", () => {
    expect(isPublicPath("/welcome")).toBe(true);
    expect(isPublicPath("/api/setup/state")).toBe(true);
    expect(isPublicPath("/api/setup/pair")).toBe(true);
  });

  it("still gates everything that is not declared public", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/dashboard/backup")).toBe(false);
    expect(isPublicPath("/api/orders")).toBe(false);
    expect(isPublicPath("/setup")).toBe(false);
  });

  it("matches a public path's subtree but not a path that merely shares its prefix", () => {
    expect(isPublicPath("/api/v1/orders")).toBe(true);
    expect(isPublicPath("/logindecoy")).toBe(false);
  });
});

describe("public paths — Phase 23 host resolution", () => {
  it("keeps both host-resolution routes session-less", () => {
    // They exist precisely for callers whose session is absent or belongs to
    // another origin, so requiring one would make them unreachable exactly
    // when they are needed.
    expect(isPublicPath("/api/host/resolve")).toBe(true);
    expect(isPublicPath("/api/host/redirect")).toBe(true);
  });

  it("does not open anything else that merely starts with the same text", () => {
    expect(isPublicPath("/api/hostile")).toBe(false);
  });
});

describe("the backup-serving channel — migration 0132", () => {
  it("leaves the two peer endpoints session-less, because the caller is another server", () => {
    // A machine being migrated onto this one has no cookie to present; it has a
    // bearer token from the super-admin console, which the handlers verify. The
    // public entry is what makes the route reachable at all — an operator who
    // forgot it gets a redirect to /login in response to a POST, which reads as
    // a broken token rather than a missing rule.
    expect(isPublicPath("/api/peer/backup/manifest")).toBe(true);
    expect(isPublicPath("/api/peer/backup/download")).toBe(true);
  });

  it("does not open a path that only shares the prefix", () => {
    expect(isPublicPath("/api/peer/backupfoo")).toBe(false);
    expect(isPublicPath("/api/peer")).toBe(false);
    expect(isPublicPath("/api/peer/other/route")).toBe(false);
  });

  it("rate-limits the whole channel per token, so a retrying peer cannot hammer it", () => {
    // The download is one request and the manifest is polled, so bucketing by
    // prefix bounds *attempts* — which is what a runaway migration produces.
    expect(isPeerBackupPath("/api/peer/backup/manifest")).toBe(true);
    expect(isPeerBackupPath("/api/peer/backup/download")).toBe(true);
    expect(isPeerBackupPath("/api/peer/backupfoo")).toBe(false);
    expect(isPeerBackupPath("/api/peer/backup")).toBe(true);
    // and nothing unrelated joins the bucket
    expect(isPeerBackupPath("/api/server-sync/pull")).toBe(false);
    expect(isPeerBackupPath("/api/auth/login")).toBe(false);
  });
});
