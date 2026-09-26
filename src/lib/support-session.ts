import type { SessionPayload } from "./auth-edge";

const CONTROLLED_MUTATION_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/settings\/printers(?:\/|$)/, "printer.test"],
  [/^\/api\/printing(?:\/|$)/, "printer.test"],
  [/^\/api\/integrations\/.+\/test(?:\/|$)/, "integration.test"],
  [/^\/api\/sync\/.+\/retry(?:\/|$)/, "sync.retry"],
];

export const MIN_SUPPORT_REASON_LENGTH = 10;

/**
 * The one endpoint that ends a support session from inside the tenant app.
 * `DELETE` on it is how the operator leaves, so every support-mode mutation
 * guard (middleware and `withTenantScope`) must let exactly this through —
 * a read-only session that cannot end itself is the bug this constant fixes.
 */
export const SUPPORT_SESSION_EXIT_PATH = "/api/support-access";

export function validSupportReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.trim().length >= MIN_SUPPORT_REASON_LENGTH;
}

/** Ending your own support session only ever removes access, so no mode may refuse it. */
export function isSupportSessionExitRequest(method: string, path: string): boolean {
  return method === "DELETE" && path === SUPPORT_SESSION_EXIT_PATH;
}

/** Central transport-independent support-session mutation decision. */
export function supportMutationAllowed(session: SessionPayload, method: string, path: string): boolean {
  if (!session.imp || session.imp.mode === "full" || session.imp.mode === "emergency") return true;
  if (isSupportSessionExitRequest(method, path)) return true;
  if (session.imp.mode === "read_only") return false;
  const required = CONTROLLED_MUTATION_PATHS.find(([pattern]) => pattern.test(path))?.[1];
  return Boolean(required && session.imp.allowedCapabilities?.includes(required));
}

/** Where an operator lands once their support session is over: the business's support tab in the console. */
export function supportSessionReturnPath(businessId: string): string {
  return `/platform/businesses/${encodeURIComponent(businessId)}/support`;
}

/** Request metadata recorded on a support-session close, in the shape the start already records. */
export function supportCloseMeta(headers: Headers, channel: string) {
  return {
    channel,
    ipAddress: headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: headers.get("user-agent"),
  };
}

export type SupportSessionCloseStatus = "ended" | "revoked" | "expired" | "not_active";

/** `DELETE /api/support-access` when the caller is the support operator. */
export interface SupportSessionEndResponse {
  ok: true;
  sessionId: string;
  /** `not_active` = it was already over (ended elsewhere, revoked, expired); the cookie is cleared regardless. */
  status: SupportSessionCloseStatus;
  redirectTo: string;
}

/**
 * Milliseconds left in a session, measured on the server's clock.
 *
 * `serverNow` is the server's time when the page rendered and `renderedAt`
 * the browser's time at that same moment, so a laptop whose clock is five
 * minutes off still counts down to the instant the server will refuse it.
 */
export function supportSessionRemainingMs(
  expiresAt: string,
  serverNow: string,
  renderedAt: number,
  clientNow: number,
): number {
  const skew = new Date(serverNow).getTime() - renderedAt;
  return Math.max(0, new Date(expiresAt).getTime() - (clientNow + skew));
}
