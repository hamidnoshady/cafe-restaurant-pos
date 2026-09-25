import type { SessionPayload } from "./auth-edge";

const CONTROLLED_MUTATION_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/settings\/printers(?:\/|$)/, "printer.test"],
  [/^\/api\/printing(?:\/|$)/, "printer.test"],
  [/^\/api\/integrations\/.+\/test(?:\/|$)/, "integration.test"],
  [/^\/api\/sync\/.+\/retry(?:\/|$)/, "sync.retry"],
];

export const MIN_SUPPORT_REASON_LENGTH = 10;

export function validSupportReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.trim().length >= MIN_SUPPORT_REASON_LENGTH;
}

/** Central transport-independent support-session mutation decision. */
export function supportMutationAllowed(session: SessionPayload, path: string): boolean {
  if (!session.imp || session.imp.mode === "full" || session.imp.mode === "emergency") return true;
  if (session.imp.mode === "read_only") return false;
  const required = CONTROLLED_MUTATION_PATHS.find(([pattern]) => pattern.test(path))?.[1];
  return Boolean(required && session.imp.allowedCapabilities?.includes(required));
}
