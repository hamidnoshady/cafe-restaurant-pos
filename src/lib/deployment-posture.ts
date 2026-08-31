/**
 * VPN-only / Secure Default Boot Policy
 */

export function assertSecurePosture(
  role: string | null,
  bindHost: string,
  allowInsecure: boolean
): void {
  // Phase 24 Wave 4: refuse to boot a production site deployment on a non-loopback bind
  // if ALLOW_INSECURE_LAN is not explicitly set, since it should be served via TLS over VPN/Caddy.
  if (
    process.env.NODE_ENV === "production" &&
    role === "site" &&
    bindHost !== "127.0.0.1" &&
    bindHost !== "localhost" &&
    !allowInsecure
  ) {
    throw new Error(
      "FATAL: Production site deployment must bind to localhost or a VPN interface, or be fronted by TLS. " +
      "If you are knowingly running plain HTTP on a public or LAN interface, set ALLOW_INSECURE_LAN=1."
    );
  }
}
