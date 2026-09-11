/**
 * Phase 37 Wave 4 — the marketing-expense document, posted by the engine.
 *
 * When a campaign finishes sending, its real-send cost becomes ONE journal
 * document (never one per SMS) through the posting engine's domain-event path —
 * not a hand-written journal INSERT and not a bespoke ledger function. The rule
 * is the same "a programme adds a posting rule" shape as every other phase.
 *
 *   Debit  `5600  هزینهٔ تبلیغات و بازاریابی`
 *   Credit `2455  پرداختنی به پلتفرم (اعتبار پیام)`   (the account that
 *          represents message credits actually consumed)
 *
 * Timing is the three explicit decisions from #376:
 *   1. the cost is recognised at real-send time — for what actually went;
 *   2. one document per *completed* campaign, not per message;
 *   3. the entry date is the branch's business day, not the calendar date.
 * A locked fiscal period does not stop a real spend being recognised: the
 * engine's exact posting path routes it to the human-approval queue exactly as
 * Phase 16 does for every auto-posted entry.
 */
import { accountIdsByCode } from "./ledger-service";
import { query } from "./db";
import {
  registerPostingRule,
  type PostingResult,
} from "./posting-engine";
import { getPool } from "./db";
import type { RialText } from "./inventory-exact";
import { WELL_KNOWN_CODES } from "./coa-template";
import { resolveMessageConfig } from "./messaging-billing";
import { messageCostRial } from "./messaging-billing-pure";

interface CampaignCostPayload {
  amount: RialText;
  /** The branch's business day (YYYY-MM-DD), computed by the caller. */
  entryDate?: string;
  /** A project belongs to the same business as the campaign (verified below). */
  projectId?: string | null;
  postingKind?: string;
}

registerPostingRule("message.campaign_cost", async (event, client): Promise<PostingResult | null> => {
  const { amount, entryDate, projectId } = event.payload as unknown as CampaignCostPayload;
  if (!amount || Number(amount) <= 0) return null;
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.marketingExpense,
    WELL_KNOWN_CODES.platformMessageCreditPayable,
  ]);
  const zero = "0" as RialText;
  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.marketingExpense)!, debit: amount, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.platformMessageCreditPayable)!, debit: zero, credit: amount },
    ],
    entryDate,
    projectId: projectId ?? null,
    memo: "هزینهٔ کمپین پیام (اعتبار پلتفرم)",
    postingKind: "marketing_campaign_cost",
  };
});

/**
 * The business's trading day for an entry, per the repo's `app_business_date`
 * convention (a café trading past midnight files the send under the previous
 * working day). Falls back to null (the engine's "today") when there is no
 * branch row.
 */
export async function campaignBusinessDay(businessId: string): Promise<string | null> {
  const { rows } = await query<{ d: string }>(
    `SELECT app_business_date(
               now(),
               coalesce(l.timezone, 'Asia/Tehran'),
               coalesce(l.business_day_start_minutes, 0)
             )::text AS d
       FROM locations l
      WHERE l.business_id = $1 AND l.is_active
      ORDER BY l.created_at
      LIMIT 1`,
    [businessId],
  );
  return rows[0]?.d ?? null;
}

/** Sum of Rial actually spent on a completed campaign's *sent* messages. */
async function campaignSpentRial(businessId: string, campaignId: string): Promise<number> {
  const config = await resolveMessageConfig();
  const { rows } = await query<{ channel: string; body: string }>(
    `SELECT r.channel, r.body
       FROM message_outbox o
       JOIN message_recipients r ON r.id = o.recipient_id
      WHERE o.business_id = $1 AND o.campaign_id = $2 AND o.status = 'sent'`,
    [businessId, campaignId],
  );
  return rows.reduce(
    (sum, r) => sum + messageCostRial(r.channel as "sms" | "email", r.body, config.rate),
    0,
  );
}

/**
 * Post (exactly once) the marketing-expense document for a completed campaign.
 * Called by the outbox tick the moment a campaign drains to zero queued rows.
 * Importing this module registers the posting rule; calling this function emits
 * the domain event and lets the engine post it.
 */
export async function postCompletedCampaignCost(
  businessId: string,
  campaignId: string,
): Promise<string | null> {
  // The campaign-to-project relationship needs an application-level affinity
  // check: the FK proves the UUID exists but cannot prove it is this tenant's.
  const { rows: campaignRows } = await query<{ project_id: string | null }>(
    `SELECT c.project_id
       FROM message_campaigns c
       LEFT JOIN ai_projects p ON p.id = c.project_id AND p.business_id = c.business_id
      WHERE c.business_id = $1 AND c.id = $2
        AND (c.project_id IS NULL OR p.id IS NOT NULL)`,
    [businessId, campaignId],
  );
  const campaign = campaignRows[0];
  if (!campaign) return null;

  const claim = await query<{ id: string }>(
    `UPDATE message_campaigns
        SET cost_posted = true, updated_at = now()
      WHERE business_id = $1 AND id = $2 AND cost_posted = false
      RETURNING id`,
    [businessId, campaignId],
  );
  if (!claim.rows[0]) return null; // already posted (or not ours)

  const spent = await campaignSpentRial(businessId, campaignId);
  if (spent <= 0) return null;

  // Imported lazily to register the rule before dispatch in the same module
  // graph as the outbox (which already imports this file at the top, so the
  // rule is registered by the time a campaign can complete).
  const { emitDomainEvent } = await import("./posting-engine");

  const entryDate = (await campaignBusinessDay(businessId)) ?? undefined;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await emitDomainEvent(client, {
      businessId,
      eventType: "message.campaign_cost",
      payload: { amount: String(spent) as RialText, entryDate, projectId: campaign.project_id },
      sourceType: "message_campaign",
      sourceId: campaignId,
    });
    await client.query("COMMIT");
    if (out.entryId) {
      await query(
        `UPDATE message_campaigns SET cost_posted_entry_id = $2 WHERE business_id = $1 AND id = $3`,
        [businessId, out.entryId, campaignId],
      );
    }
    return out.entryId;
  } catch (error) {
    await client.query("ROLLBACK");
    // Re-open the claim so a later tick retries rather than losing the cost.
    await query(
      `UPDATE message_campaigns SET cost_posted = false WHERE business_id = $1 AND id = $2`,
      [businessId, campaignId],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
