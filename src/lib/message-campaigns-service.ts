/**
 * Phase 37 Wave 2 — templates and campaigns, and the send-time audience
 * snapshot that turns a dynamic segment into a frozen recipient list.
 *
 * The audience comes from ONLY the Phase 36d bridge
 * (`audienceForSegment` → `resolveSegment` with the channel's consent purpose),
 * which is what excludes an unconsented member even when they are in the
 * segment. This module never builds a member list another way, and the
 * `message_recipients` snapshot means a segment that changes after the send
 * never rewrites who was told.
 *
 * Sending itself is *not* done here: launching a campaign writes the recipients
 * and queues an outbox row per recipient; only the outbox tick drains them.
 */
import { getPool, query } from "./db";
import { audienceForSegment, type CampaignAudience } from "./campaign-audience";
import type { CampaignChannel, AudienceMember } from "./campaign-channels";
import { contactFor } from "./campaign-channels";
import {
  renderMessageTemplate,
  templateVariableTokens,
  unknownTemplateVariables,
  type MessageTemplateValues,
} from "./message-template";
import { formatTomanText } from "./money";
import { toPersianDigits } from "./digits";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface MessageVariablesSource {
  name: string;
  shopName: string;
  /** Integer loyalty points, when known. */
  points?: number | null;
  /** Rial amount, when known (formatted with formatTomanText → Persian toman). */
  creditRial?: number | null;
  discountCode?: string | null;
}

/** Assemble the closed variable map from a member and its data source. */
export function buildMessageVariables(source: MessageVariablesSource): MessageTemplateValues {
  const values: MessageTemplateValues = { نام: source.name, نام_فروشگاه: source.shopName };
  if (typeof source.points === "number") values["امتیاز"] = toPersianDigits(source.points);
  if (typeof source.creditRial === "number") values["اعتبار"] = formatTomanText(String(source.creditRial));
  if (typeof source.discountCode === "string" && source.discountCode.length > 0) {
    values["کد_تخفیف"] = source.discountCode;
  }
  return values;
}

/**
 * Variables the body uses but the data source could not supply. A known-but-
 * unresolved variable is a *send-blocking* error (not a silent empty string) —
 * the closed set plus "every used variable has data" is what keeps a recipient
 * from getting "سلام ، ..." with a hole where their name should be.
 */
export function unresolvedTemplateVariables(
  body: string,
  values: MessageTemplateValues,
): string[] {
  return templateVariableTokens(body).filter((v) => values[v as keyof MessageTemplateValues] === undefined);
}

/** Render one recipient line; throws listing unresolved used variables. */
export function renderRecipientBody(body: string, values: MessageTemplateValues): string {
  const missing = unresolvedTemplateVariables(body, values);
  if (missing.length > 0) {
    throw new Error(`message_variable_missing:${missing.join(",")}`);
  }
  return renderMessageTemplate(body, values);
}

/** One sendable recipient: the frozen address plus the rendered text. */
export interface MessageRecipientInput {
  customerId: string;
  address: string;
  subject: string;
  body: string;
}

/**
 * The address a member is reachable on for a channel. Consent has already been
 * applied by the audience resolver; this only picks the channel's address
 * column and rejects a member who somehow slipped through with none.
 */
export function recipientAddressFor(member: AudienceMember, channel: CampaignChannel): string | null {
  const address = contactFor(member, channel);
  return address && address.trim().length > 0 ? address.trim() : null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface MessageTemplateRecord {
  id: string;
  businessId: string;
  channel: CampaignChannel;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
}

export interface SaveTemplateInput {
  channel: CampaignChannel;
  name: string;
  subject?: string;
  body: string;
}

export function validateTemplateBody(body: string): string[] {
  return unknownTemplateVariables(body);
}

export async function listMessageTemplates(
  businessId: string,
  channel?: CampaignChannel,
): Promise<MessageTemplateRecord[]> {
  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, business_id, channel, name, subject, body, created_at
       FROM message_templates
      WHERE business_id = $1 AND ($2::text IS NULL OR channel = $2)
      ORDER BY created_at DESC`,
    [businessId, channel ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    channel: r.channel as CampaignChannel,
    name: r.name,
    subject: r.subject,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function getMessageTemplate(businessId: string, id: string): Promise<MessageTemplateRecord | null> {
  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, business_id, channel, name, subject, body, created_at
       FROM message_templates WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  const r = rows[0];
  return r
    ? { id: r.id, businessId: r.business_id, channel: r.channel as CampaignChannel, name: r.name, subject: r.subject, body: r.body, createdAt: r.created_at }
    : null;
}

export async function saveMessageTemplate(
  businessId: string,
  input: SaveTemplateInput,
): Promise<MessageTemplateRecord> {
  const body = input.body.trim();
  if (!body) throw new Error("invalid_template_body");
  const unknown = validateTemplateBody(body);
  if (unknown.length > 0) throw new Error(`unknown_template_variable:${unknown.join(",")}`);
  const subject = input.channel === "email" ? (input.subject ?? "").trim() : "";
  const name = input.name.trim();
  if (!name) throw new Error("invalid_template_name");

  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `INSERT INTO message_templates (business_id, channel, name, subject, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, business_id, channel, name, subject, body, created_at`,
    [businessId, input.channel, name, subject, body],
  );
  const r = rows[0];
  return { id: r.id, businessId: r.business_id, channel: r.channel as CampaignChannel, name: r.name, subject: r.subject, body: r.body, createdAt: r.created_at };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  id: string;
  businessId: string;
  channel: CampaignChannel;
  name: string;
  templateId: string | null;
  segmentId: string | null;
  projectId: string | null;
  status: string;
  triggeredBy: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const CAMPAIGN_COLUMNS = `id, business_id AS "businessId", channel, name,
  template_id AS "templateId", segment_id AS "segmentId", project_id AS "projectId",
  status, triggered_by AS "triggeredBy", total_recipients AS "totalRecipients",
  sent_count AS "sentCount", delivered_count AS "deliveredCount",
  failed_count AS "failedCount", created_at AS "createdAt",
  started_at AS "startedAt", completed_at AS "completedAt"`;

function toCampaign(r: {
  id: string;
  businessId: string;
  channel: string;
  name: string;
  templateId: string | null;
  segmentId: string | null;
  projectId: string | null;
  status: string;
  triggeredBy: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}): CampaignSummary {
  return {
    id: r.id,
    businessId: r.businessId,
    channel: r.channel as CampaignChannel,
    name: r.name,
    templateId: r.templateId,
    segmentId: r.segmentId,
    projectId: r.projectId,
    status: r.status,
    triggeredBy: r.triggeredBy,
    totalRecipients: r.totalRecipients,
    sentCount: r.sentCount,
    deliveredCount: r.deliveredCount,
    failedCount: r.failedCount,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

export async function listMessageCampaigns(businessId: string): Promise<CampaignSummary[]> {
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM message_campaigns
      WHERE business_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [businessId],
  );
  return rows.map(toCampaign);
}

export async function getMessageCampaign(businessId: string, id: string): Promise<CampaignSummary | null> {
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM message_campaigns WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toCampaign(rows[0]) : null;
}

export interface CreateCampaignInput {
  channel: CampaignChannel;
  name: string;
  templateId: string;
  segmentId: string | null;
  projectId?: string | null;
  scheduledAt?: string | null;
  triggeredBy?: string;
}

export async function createMessageCampaign(
  businessId: string,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  const name = input.name.trim();
  if (!name) throw new Error("invalid_campaign_name");
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `INSERT INTO message_campaigns
       (business_id, channel, name, template_id, segment_id, project_id, scheduled_at, triggered_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
     RETURNING ${CAMPAIGN_COLUMNS}`,
    [
      businessId,
      input.channel,
      name,
      input.templateId,
      input.segmentId,
      input.projectId ?? null,
      input.scheduledAt ?? null,
      input.triggeredBy ?? "",
    ],
  );
  return toCampaign(rows[0]);
}

export interface LaunchResult {
  campaignId: string;
  total: number;
  excluded: number;
  audience: CampaignAudience | null;
}

/**
 * Resolve the segment's reachable audience, render each member's frozen line
 * and queue it. This is the moment "send" means something, and the snapshot is
 * taken here — not in the tick, which only drains what is already queued.
 */
export async function launchMessageCampaign(
  businessId: string,
  campaignId: string,
  options: { creditRial?: number; discountCode?: string } = {},
): Promise<LaunchResult> {
  const campaign = await getMessageCampaign(businessId, campaignId);
  if (!campaign) throw new Error("not_found");
  if (!campaign.segmentId) throw new Error("campaign_needs_segment");
  if (campaign.status === "sending" || campaign.status === "completed") {
    throw new Error("campaign_already_launched");
  }

  const template = await getMessageTemplate(businessId, campaign.templateId ?? "");
  if (!template) throw new Error("template_not_found");

  const audience = await audienceForSegment(businessId, campaign.segmentId, campaign.channel);
  const businessRow = await query<{ name: string }>(
    "SELECT name FROM businesses WHERE id = $1",
    [businessId],
  );
  const shopName = businessRow.rows[0]?.name ?? "";

  // Every used variable must have a data path before we write a single row: a
  // template that names a variable no one can resolve is a blocked launch, not
  // a body with holes. `credit`/`discount` only exist when the launcher said so.
  const used = templateVariableTokens(template.body);
  const blocked: string[] = [];
  if (used.includes("اعتبار") && options.creditRial === undefined) blocked.push("اعتبار");
  if (used.includes("کد_تخفیف") && !options.discountCode) blocked.push("کد_تخفیف");
  if (blocked.length > 0) throw new Error(`message_variable_missing:${blocked.join(",")}`);

  // Points are read once for the whole audience (only when actually used).
  const needsPoints = used.includes("امتیاز");
  const pointsByCustomer = needsPoints
    ? await loadPointsMap(businessId, audience.members.map((m) => m.id))
    : new Map<string, number>();

  const recipients: MessageRecipientInput[] = [];
  let skippedForAddress = 0;
  for (const member of audience.members) {
    const address = recipientAddressFor(member, campaign.channel);
    if (!address) {
      skippedForAddress += 1;
      continue;
    }
    const values = buildMessageVariables({
      name: member.name,
      shopName,
      points: pointsByCustomer.get(member.id) ?? 0,
      creditRial: options.creditRial,
      discountCode: options.discountCode,
    });
    recipients.push({
      customerId: member.id,
      address,
      subject:
        template.channel === "email"
          ? renderMessageTemplate(template.subject, values)
          : "",
      body: renderRecipientBody(template.body, values),
    });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE message_campaigns
          SET status = 'sending', started_at = now(), total_recipients = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, campaignId, recipients.length],
    );
    for (const r of recipients) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO message_recipients (business_id, campaign_id, customer_id, channel, address, subject, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [businessId, campaignId, r.customerId, campaign.channel, r.address, r.subject, r.body],
      );
      await client.query(
        `INSERT INTO message_outbox (business_id, recipient_id, campaign_id, status, next_attempt_at)
         VALUES ($1, $2, $3, 'queued', now())`,
        [businessId, rows[0].id, campaignId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    campaignId,
    total: recipients.length,
    excluded: audience.matched - audience.reachable + skippedForAddress,
    audience,
  };
}

async function loadPointsMap(businessId: string, customerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (customerIds.length === 0) return map;
  const { rows } = await query<{ customer_id: string; points: string | number }>(
    `SELECT customer_id, coalesce(sum(points), 0) AS points
       FROM customer_points
      WHERE business_id = $1 AND customer_id = ANY($2::uuid[])
      GROUP BY customer_id`,
    [businessId, customerIds],
  );
  for (const r of rows) map.set(r.customer_id, Number(r.points));
  return map;
}

/** Pause a campaign mid-flight: nothing else is sent; queued rows stay queued. */
export async function pauseMessageCampaign(businessId: string, campaignId: string): Promise<void> {
  await query(
    `UPDATE message_campaigns SET status = 'paused', updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'sending'`,
    [businessId, campaignId],
  );
}
