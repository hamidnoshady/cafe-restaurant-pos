/**
 * Eshobe CMS — configuration resolution.
 *
 * Split from the client so the env contract lives in one place:
 *
 * - `ESHOBE_CMS_URL` — the CMS control-plane origin (no trailing slash).
 * - `ESHOBE_CMS_PLATFORM_API_KEY` — optional `role: "platform"` key used by
 *   the operator console (provision sites, issue site keys).
 * - `ESHOBE_CMS_WEBHOOK_SECRET` — the CMS's `PAYLOAD_SECRET`; verifies the
 *   HMAC on `POST /api/cms/revalidate`.
 *
 * Per-business site keys are NOT env vars: they are stored encrypted in
 * `eshobe_cms_connections` (see ./connections.ts) and decrypted on the way
 * out, which is how a customer website's credential stays inside its tenant.
 */
import type { CmsConfig } from "./client";
import { normalizeCmsBaseUrl } from "./client";

export interface CmsEnvConfig {
  baseUrl: string;
  platformApiKey?: string;
  webhookSecret?: string;
}

export function cmsConfigFromEnv(env: Record<string, string | undefined>): CmsConfig {
  const baseUrl = env.ESHOBE_CMS_URL?.trim();
  if (!baseUrl) {
    throw new Error("ESHOBE_CMS_URL is not set — see docs/eshobe-cms-integration.md");
  }
  return {
    baseUrl: normalizeCmsBaseUrl(baseUrl),
    apiKey: env.ESHOBE_CMS_PLATFORM_API_KEY?.trim() || undefined,
  };
}

/** The secret that authenticates publish webhooks from the CMS. */
export function cmsWebhookSecret(env: Record<string, string | undefined>): string | null {
  const secret = env.ESHOBE_CMS_WEBHOOK_SECRET?.trim();
  return secret || null;
}

/**
 * The platform-level config (provisioning + key lifecycle). Returns `null`
 * when either required variable is missing, so a route can answer
 * `cms_not_configured` instead of the whole app failing to boot — a business
 * never gets to provision its site before the operator has deployed a key.
 */
export function cmsPlatformConfig(env: Record<string, string | undefined>): CmsConfig | null {
  const baseUrl = env.ESHOBE_CMS_URL?.trim();
  const apiKey = env.ESHOBE_CMS_PLATFORM_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: normalizeCmsBaseUrl(baseUrl), apiKey };
}
