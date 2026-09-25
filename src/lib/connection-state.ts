/** Shared vocabulary for runtime connectivity. Never call all of it "offline". */
export type ConnectionStatus =
  | "connected"
  | "unreachable"
  | "unknown"
  | "connecting"
  | "paused"
  | "not_configured"
  | "attention_required"
  | "not_applicable";

export interface PlatformConnectionState {
  localServer: ConnectionStatus;
  lanGateway: ConnectionStatus;
  internet: ConnectionStatus;
  cloud: ConnectionStatus;
  sync: ConnectionStatus;
  externalServices: ConnectionStatus;
  outboundPending: number;
  inboundPending: number;
  conflicts: number;
  deadLetters: number;
  lastSuccessfulSyncAt: string | null;
}

export type SyncFailureClass = "temporary" | "needs_attention" | "configuration_fatal";

export function classifySyncFailure(code: string | null | undefined): SyncFailureClass {
  if (!code || ["remote_unreachable", "timeout", "internet_unavailable", "rate_limited"].includes(code)) return "temporary";
  if (["dependency_conflict", "merge_conflict", "invalid_relationship"].includes(code)) return "needs_attention";
  return "configuration_fatal";
}
