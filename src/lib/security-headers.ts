export type CspMode = "off" | "report-only" | "enforce";

export function cspMode(): CspMode {
  const mode = process.env.CSP_MODE;
  if (mode === "off" || mode === "enforce") {
    return mode;
  }
  return "report-only";
}

export function generateNonce(): string {
  // Use crypto.subtle in a non-blocking/edge way if possible, or just Math.random fallback
  // Wait, edge has crypto.getRandomValues
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The Cafe POS Windows Print Connector is deliberately loopback-only. It is
 * the one cross-origin connection the app itself makes: an HTTPS cloud
 * dashboard has to reach the connector on the cashier's own PC. Keep these
 * origins in CSP or an enforced policy blocks printer discovery and printing
 * before CORS/LNA can even ask the user for permission.
 *
 * A custom URL is accepted only when it is still loopback. The connector is
 * not authenticated and must never be exposed to a LAN or public host.
 */
function connectorConnectSources(rawUrl = process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL): string[] {
  const sources = new Set(["http://127.0.0.1:9123", "http://localhost:9123"]);
  if (!rawUrl) return [...sources];
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) sources.add(url.origin);
  } catch {
    // A malformed override is ignored here. The fetch will fail with the
    // ordinary connector_not_installed result rather than weakening CSP.
  }
  return [...sources];
}

export function contentSecurityPolicy(
  nonce: string,
  opts: { https: boolean; reportOnly?: boolean } = { https: false },
): string {
  const parts = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ws: wss: ${connectorConnectSources().join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  // Browsers explicitly ignore this directive in a report-only policy and
  // emit a warning for every response. Add it only when it can take effect.
  if (opts.https && !opts.reportOnly) {
    parts.push("upgrade-insecure-requests");
  }
  return parts.join("; ");
}

export function staticSecurityHeaders(opts: { https: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    // Camera access is needed by the in-app barcode / QR scanner. The local
    // and loopback entries let a top-level cloud dashboard ask the browser for
    // its one-time Local Network Access permission before calling the Windows
    // print agent. `local-network-access` is the Chrome 142–144 compatibility
    // alias; newer browsers split it into local-network / loopback-network.
    // All remain same-origin document capabilities — embeds get nothing.
    "Permissions-Policy":
      "camera=(self), publickey-credentials-get=(self), local-network=(self), loopback-network=(self), local-network-access=(self)",
  };
  if (opts.https) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}
