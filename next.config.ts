import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    const commonHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      { key: "Permissions-Policy", value: "publickey-credentials-get=(self)" },
    ];
    return [
      {
        source: "/(.*)",
        headers: commonHeaders,
      },
      {
        source: "/(.*)",
        has: [
          {
            type: "header",
            key: "x-forwarded-proto",
            value: "https",
          },
        ],
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
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
