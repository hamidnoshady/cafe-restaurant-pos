/**
 * Product deployment profile.
 *
 * This is deliberately separate from `deployment-role.ts`: a profile answers
 * where this business is operated and whether it participates in Eshobe Cloud;
 * a runtime role answers whether this process is a central or site process.
 * Connectivity is neither of those things and lives in `connection-state.ts`.
 *
 * Older installations stored `{ mode: "local" | "connected" }` under
 * `deployment.mode`. The adapter below is the single compatibility boundary:
 * `connected` means hybrid on a site process and cloud on a central process.
 * New writes use `deployment.profile` and never write the ambiguous value.
 */
import { deploymentRole, type DeploymentRole } from "./deployment-role";
import { getSetting, SETTING_KEYS } from "./settings";

export const DEPLOYMENT_PROFILES = ["cloud", "hybrid", "local"] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

/** @deprecated Input-only compatibility spelling used by pre-0172 callers. */
export type LegacyDeploymentModeName = "local" | "connected";
/** @deprecated Use DeploymentProfile. Kept as a source-compatible alias during migration. */
export type DeploymentModeName = LegacyDeploymentModeName | DeploymentProfile;

export interface DeploymentProfileRecord {
  profile: DeploymentProfile;
  pairedAt: string | null;
  /** Makes diagnostics explicit when an old value was adapted. */
  source: "profile" | "legacy" | "inferred";
}

/** @deprecated Use DeploymentProfileRecord. */
export interface DeploymentMode {
  mode: LegacyDeploymentModeName;
  pairedAt: string | null;
}

/**
 * Cloud-dependent entitlements disabled when provisioning a Local-only tenant.
 * `site_cloud_sync` names the product capability; "offline" is reserved for a
 * transient runtime state. Migration 0172 copies existing overrides.
 */
export const LOCAL_DISABLED_FEATURES: readonly string[] = [
  "ai_assistant",
  "multi_location",
  "site_cloud_sync",
  "integrations",
] as const;

export function isDeploymentProfile(value: unknown): value is DeploymentProfile {
  return typeof value === "string" && (DEPLOYMENT_PROFILES as readonly string[]).includes(value);
}

/** Pure compatibility resolver. Invalid/missing state is inferred from process role. */
export function resolveDeploymentProfile(
  stored: unknown,
  role: DeploymentRole,
): DeploymentProfileRecord {
  const inferred: DeploymentProfileRecord = {
    profile: role === "central" ? "cloud" : "local",
    pairedAt: null,
    source: "inferred",
  };
  if (typeof stored !== "object" || stored === null) return inferred;
  const raw = stored as { profile?: unknown; mode?: unknown; pairedAt?: unknown };
  const pairedAt = typeof raw.pairedAt === "string" ? raw.pairedAt : null;
  if (isDeploymentProfile(raw.profile)) {
    return { profile: raw.profile, pairedAt, source: "profile" };
  }
  // Accept profile-shaped data accidentally written to the old key too.
  if (isDeploymentProfile(raw.mode)) {
    return { profile: raw.mode, pairedAt, source: "profile" };
  }
  if (raw.mode === "local") return { profile: "local", pairedAt, source: "legacy" };
  if (raw.mode === "connected") {
    return { profile: role === "central" ? "cloud" : "hybrid", pairedAt, source: "legacy" };
  }
  return inferred;
}

/**
 * Legacy pure API retained for old tests/callers. It intentionally preserves
 * its historical fallback; all new architecture must use
 * `resolveDeploymentProfile` instead.
 */
export function resolveDeploymentMode(stored: unknown): DeploymentMode {
  const raw = stored as { mode?: unknown; pairedAt?: unknown } | null;
  return {
    mode: raw?.mode === "local" ? "local" : "connected",
    pairedAt: typeof raw?.pairedAt === "string" ? raw.pairedAt : null,
  };
}

export async function readDeploymentProfile(
  businessId: string,
  role: DeploymentRole = deploymentRole(),
): Promise<DeploymentProfileRecord> {
  const current = await getSetting<unknown>(businessId, SETTING_KEYS.deploymentProfile);
  if (current) return resolveDeploymentProfile(current, role);
  return resolveDeploymentProfile(
    await getSetting<unknown>(businessId, SETTING_KEYS.deploymentMode),
    role,
  );
}

/** @deprecated Prefer readDeploymentProfile. */
export async function readDeploymentMode(businessId: string): Promise<DeploymentMode> {
  const resolved = await readDeploymentProfile(businessId);
  return {
    mode: resolved.profile === "local" ? "local" : "connected",
    pairedAt: resolved.pairedAt,
  };
}

export async function isLocalOnly(businessId: string): Promise<boolean> {
  return (await readDeploymentProfile(businessId)).profile === "local";
}
