import { describe, expect, it } from "vitest";
import { isPublicPath } from "./middleware";

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
