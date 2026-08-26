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

export function contentSecurityPolicy(nonce: string, opts: { https: boolean }): string {
  const isHttps = opts.https;
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
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  if (isHttps) {
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
    "Permissions-Policy": "publickey-credentials-get=(self)",
  };
  if (opts.https) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}
