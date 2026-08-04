/**
 * How this install relates to the online platform.
 *
 * Written once, at first run: the local path of the /welcome wizard stamps
 * 'local', the pairing path stamps 'connected'. It is deliberately not
 * changeable from the UI afterwards — upgrading a local install to a connected
 * one means merging two datasets, which is out of scope.
 *
 * An install that predates this setting reads as 'connected', so every
 * existing VPS deployment and every already-paired laptop keeps exactly the
 * behaviour it has today with no backfill migration.
 */
import { getSetting, SETTING_KEYS } from "./settings";

export type DeploymentModeName = "local" | "connected";

export interface DeploymentMode {
  mode: DeploymentModeName;
  /** ISO time the pairing completed; null for a local install. */
  pairedAt: string | null;
}

/**
 * Features a local-only install cannot deliver, seeded as `business_features`
 * "off" overrides at local bootstrap. Each is off because it depends on the
 * platform, not because it is unfinished:
 *
 *   - ai_assistant   — credits and billing live on the platform (Phase 18)
 *   - multi_location — rollup across branches is a platform function
 *   - offline_mode   — gates server-sync and rollup, meaningless standalone
 *
 * They stay individually flippable from the platform console afterwards.
 */
export const LOCAL_DISABLED_FEATURES: readonly string[] = [
  "ai_assistant",
  "multi_location",
  "offline_mode",
] as const;

/** Pure: turn whatever is stored (possibly nothing, possibly junk) into a usable mode. */
export function resolveDeploymentMode(stored: unknown): DeploymentMode {
  const fallback: DeploymentMode = { mode: "connected", pairedAt: null };
  if (typeof stored !== "object" || stored === null) return fallback;
  const raw = stored as { mode?: unknown; pairedAt?: unknown };
  if (raw.mode !== "local" && raw.mode !== "connected") return fallback;
  return {
    mode: raw.mode,
    pairedAt: typeof raw.pairedAt === "string" ? raw.pairedAt : null,
  };
}

export async function readDeploymentMode(businessId: string): Promise<DeploymentMode> {
  return resolveDeploymentMode(await getSetting<unknown>(businessId, SETTING_KEYS.deploymentMode));
}

export async function isLocalOnly(businessId: string): Promise<boolean> {
  return (await readDeploymentMode(businessId)).mode === "local";
}
