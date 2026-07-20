/**
 * Typed access to the key/value `settings` table.
 * location_id NULL = business-wide setting (all wizard settings are business-wide).
 */
import { query } from "./db";

export const SETTING_KEYS = {
  /** { name, currencyDisplay: 'toman'|'rial', language: 'fa', calendar: 'jalali' } */
  businessPrefs: "business.prefs",
  /** { method: 'fifo'|'weighted_average', lockedAt: string|null } */
  costing: "inventory.costing",
  /** { defaultRate: number } — percent, applied to new menu categories */
  tax: "tax.config",
  /** { steps: Record<string, string>, completedAt: string|null } — step → ISO time done */
  wizardProgress: "setup.progress",
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
