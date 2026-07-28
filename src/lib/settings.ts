/**
 * Typed access to the key/value `settings` table.
 * location_id NULL = business-wide setting (all wizard settings are business-wide).
 */
import { query } from "./db";

export const SETTING_KEYS = {
  /** { name, currencyDisplay: 'toman'|'rial', language: 'fa', calendar: 'jalali' } */
  businessPrefs: "business.prefs",
  /** { legalName, taxId, email, website, receiptFooter } — operational business profile */
  businessProfile: "business.profile",
  /** { method: 'fifo'|'weighted_average', lockedAt: string|null } */
  costing: "inventory.costing",
  /** { defaultRate: number } — percent, applied to new menu categories */
  tax: "tax.config",
  /** { steps: Record<string, string>, completedAt: string|null } — step → ISO time done */
  wizardProgress: "setup.progress",
  /** { centralUrl, token, enabled } — this location's push target (Phase 9) */
  rollupConfig: "rollup.config",
  /** { lastAttemptAt, lastSuccessAt, lastSuccessDay, lastError } — local push status (Phase 9) */
  rollupSyncState: "rollup.sync_state",
  /** { remoteUrl, token, enabled, batchSize } — bidirectional server-to-server sync target (Phase 11) */
  serverSyncConfig: "server_sync.config",
  /** ServerSyncState (src/lib/server-sync.ts) — push/pull high-water marks + status (Phase 11) */
  serverSyncState: "server_sync.state",
  /** BackupConfig (src/lib/backup.ts) — schedule/retention/cloud settings (Phase 10) */
  backupConfig: "backup.config",
  /** AiConfig (src/lib/ai.ts) — provider/model/baseUrl/apiKey for the AI assistant */
  aiConfig: "ai.config",
  /** { defaultMarginPercent: number | null } — cost-plus pricing default, overridable per menu item */
  pricing: "pricing.config",
} as const;

export async function getSetting<T>(businessId: string, key: string): Promise<T | null> {
  const { rows } = await query<{ value: T }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(businessId: string, key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, key, JSON.stringify(value)],
  );
}

export interface WizardProgress {
  steps: Record<string, string>;
  completedAt: string | null;
}

export async function getWizardProgress(businessId: string): Promise<WizardProgress> {
  const p = await getSetting<WizardProgress>(businessId, SETTING_KEYS.wizardProgress);
  return p ?? { steps: {}, completedAt: null };
}

export async function markStepDone(businessId: string, step: string): Promise<WizardProgress> {
  const progress = await getWizardProgress(businessId);
  progress.steps[step] = new Date().toISOString();
  await setSetting(businessId, SETTING_KEYS.wizardProgress, progress);
  return progress;
}
