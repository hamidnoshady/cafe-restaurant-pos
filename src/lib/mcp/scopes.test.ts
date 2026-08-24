import { describe, expect, it } from "vitest";
import {
  ALL_MCP_SCOPES,
  MCP_SCOPES,
  formatMcpScopeString,
  grantableScopes,
  isMcpScope,
  isMcpWriteMode,
  parseMcpScopeString,
  parseMcpScopes,
} from "./scopes";

describe("parseMcpScopes", () => {
  it("drops anything this release does not recognise", () => {
    // A removed or misspelled historical scope must never widen a connection.
    expect(parseMcpScopes(["pos.read", "pos.admin", "orders.write"])).toEqual(["pos.read"]);
  });

  it("deduplicates and returns the canonical order, not the caller's", () => {
    // Two connections granted the same access must compare and render
    // identically however the request happened to spell it.
    expect(parseMcpScopes(["pos.write", "pos.read", "pos.write"])).toEqual([
      "pos.read",
      "pos.write",
    ]);
  });

  it("treats a non-array as no grant at all", () => {
    for (const value of [null, undefined, "pos.read", 5, {}]) {
      expect(parseMcpScopes(value)).toEqual([]);
    }
  });
});

describe("parseMcpScopeString", () => {
  it("reads the space-delimited OAuth wire form", () => {
    expect(parseMcpScopeString("pos.read pos.write")).toEqual(["pos.read", "pos.write"]);
  });

  it("ignores scopes from other vocabularies instead of failing the request", () => {
    // A client asking for `openid profile pos.read` must get a working
    // pos.read grant; the response's own `scope` field tells it what it got.
    expect(parseMcpScopeString("openid profile pos.read")).toEqual(["pos.read"]);
  });

  it("survives odd whitespace and non-strings", () => {
    expect(parseMcpScopeString("  pos.read   pos.write  ")).toEqual(["pos.read", "pos.write"]);
    expect(parseMcpScopeString(null)).toEqual([]);
  });

  it("round-trips through formatMcpScopeString", () => {
    expect(parseMcpScopeString(formatMcpScopeString(ALL_MCP_SCOPES))).toEqual(ALL_MCP_SCOPES);
  });
});

describe("grantableScopes", () => {
  it("intersects: the owner can only ever narrow what was asked for", () => {
    expect(grantableScopes([MCP_SCOPES.read, MCP_SCOPES.write], [MCP_SCOPES.read])).toEqual([
      "pos.read",
    ]);
  });

  it("never grants a scope the owner did not tick, however loudly it was requested", () => {
    expect(grantableScopes([MCP_SCOPES.write], [MCP_SCOPES.read])).toEqual([]);
  });

  it("never grants a scope the client did not request, however much the owner approved", () => {
    expect(grantableScopes([MCP_SCOPES.read], ALL_MCP_SCOPES)).toEqual(["pos.read"]);
  });

  it("treats an empty request as a request to read", () => {
    // "Add this connector" with no scope parameter is the normal case for a
    // client that has never seen this server, and must not be an error.
    expect(grantableScopes([], [MCP_SCOPES.read, MCP_SCOPES.write])).toEqual(["pos.read"]);
  });
});

describe("value guards", () => {
  it("recognises exactly the two scopes", () => {
    expect(ALL_MCP_SCOPES).toEqual(["pos.read", "pos.write"]);
    expect(isMcpScope("pos.read")).toBe(true);
    expect(isMcpScope("pos.readwrite")).toBe(false);
    expect(isMcpScope(null)).toBe(false);
  });

  it("recognises exactly the two write modes", () => {
    expect(isMcpWriteMode("apply")).toBe(true);
    expect(isMcpWriteMode("approve")).toBe(true);
    expect(isMcpWriteMode("auto")).toBe(false);
    expect(isMcpWriteMode(undefined)).toBe(false);
  });
});
