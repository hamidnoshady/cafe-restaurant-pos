import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Phase 34 — the OAuth discovery documents live at `/.well-known/…`, which is
   * where RFC 8414 and RFC 9728 say to look and where every MCP client goes
   * first. Next's app router will not serve a dot-prefixed route folder, so the
   * handlers live under `/api/well-known/*` and are rewritten into place here.
   *
   * Each document is exposed twice on purpose. RFC 9728 specifies the
   * *path-inserted* form for a resource that is not at the site root — for
   * `/api/mcp` that is `/.well-known/oauth-protected-resource/api/mcp` — while
   * many clients try the bare path. A 404 on either is indistinguishable from
   * "this server does not support OAuth", after which a connector fails to add
   * with no error anyone can see, so both are answered.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/well-known/oauth-protected-resource/:path*",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/well-known/oauth-authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/well-known/oauth-authorization-server/:path*",
      },
    ];
  },
};

export default nextConfig;
