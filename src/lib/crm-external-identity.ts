/**
 * Identity reconciliation between an external store and the canonical people
 * directory.
 *
 * ## The boundary this restores
 *
 * `APP_DATA_RULES` says `customer_records` are owned by the **CRM**, and that
 * the Website app is a *reader*. The WooCommerce sync did not honour that: it
 * INSERTed and UPDATEd `parties` directly, so a shopper typing a name into a
 * checkout form silently rewrote the shop's own record of that person. Worse,
 * it resolved ambiguous identity with `ORDER BY created_at LIMIT 1` — when two
 * customers shared a phone number, the sync attached the order to whichever
 * record happened to be older, with no signal that a choice had been made at
 * all.
 *
 * The fix is not to forbid the sync from knowing about people. It is to give
 * the external store its **own** surface — `crm_external_profiles` — and make
 * the link between that surface and `parties` an explicit, inspectable,
 * reversible mapping:
 *
 * ```
 *   WooCommerce customer  ──►  crm_external_profiles  ──►  parties
 *        (their data)            (the mirror + mapping)      (ours)
 * ```
 *
 * The mirror is not a duplicate customer table. It holds *what the store said*,
 * which is a different fact from *who this person is* and is genuinely owned by
 * the website side. Nothing reads it as a customer list; the CRM reads through
 * it to `parties`.
 *
 * ## The rules this module enforces
 *
 * 1. **A confident, unambiguous match links automatically.** Exactly one party
 *    matching on a normalised phone (or, failing that, on email) is not a
 *    guess, and making a human confirm thousands of those would guarantee
 *    nobody confirms any of them.
 *
 * 2. **An ambiguous match never picks a winner.** Two or more candidates means
 *    the profile is parked as `needs_review` with every candidate recorded, and
 *    the order is imported *unattributed* until a person decides. An
 *    unattributed order is a visible gap; an order attached to the wrong
 *    customer is an invisible lie, and it propagates into their spend history,
 *    their RFM score and every segment they fall into.
 *
 * 3. **The remote never overwrites a filled local field.** A blank local field
 *    is filled (that is new information); a disagreement is recorded in
 *    `conflicts` for review. The shop's own record of a customer outranks a
 *    checkout form.
 *
 * 4. **Consent is never inferred.** Buying something is not permission to
 *    market to someone. Nothing here writes `sms_consent`,
 *    `marketing_consent`, or a `crm_consent_events` row — not even when the
 *    store sends a marketing opt-in flag, because that flag is the store's
 *    claim and the audit trail has to record who obtained the consent and how.
 *
 * 5. **Creation is still allowed, but it is the CRM's own write.** When nobody
 *    matches, a new party is created *here*, through one function, with
 *    provenance stamped on it (`acquisition_source = 'woocommerce'`) — rather
 *    than by whichever integration happened to need one.
 */

import { query, withTenant, withTenantTransaction } from "./db";
import { phoneE164 } from "./phone";
import { phoneMatchKeys, phoneMatchSql } from "./parties-service";
import { syncCustomerPhone } from "./crm-service";
import { recordCrmAudit } from "./crm-audit-service";

/**
 * How a profile relates to the canonical directory.
 *
 * - `unmapped` — seen, not yet resolved.
 * - `auto_matched` — one unambiguous candidate; linked without a human.
 * - `confirmed` — a person said yes (or confirmed an auto match).
 * - `needs_review` — more than one candidate, or a weak single one. **Not
 *   linked.**
 * - `conflict` — linked, but the remote disagrees with the local record about
 *   a field.
 * - `ignored` — deliberately not a customer of ours (a test order, a bot).
 */
export type ExternalProfileStatus =
  | "unmapped"
  | "auto_matched"
  | "confirmed"
  | "needs_review"
  | "conflict"
  | "ignored";

export interface ExternalIdentityInput {
  businessId: string;
  connectionId: string;
  provider?: string;
  /** The store's own id for this customer. Guests get a synthetic key. */
  remoteId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  /** The raw remote record, kept for the review screen and for debugging. */
  payload?: Record<string, unknown>;
  remoteUpdatedAt?: string | null;
}

export interface MatchCandidate {
  partyId: string;
  name: string;
  matchedOn: "phone" | "email";
  /** Why this candidate surfaced, in Persian, for the review screen. */
  note: string;
}

export interface ReconcileResult {
  profileId: string;
  /** Null whenever the identity is ambiguous — see rule 2. */
  partyId: string | null;
  status: ExternalProfileStatus;
  confidence: number;
  reason: string;
  candidates: MatchCandidate[];
  created: boolean;
}

/** Confidence scores. Named, because a bare 95 in a branch explains nothing. */
const CONFIDENCE = {
  /** Store customer id already mapped — not a match, a fact. */
  existingMapping: 100,
  /** Exactly one party on a normalised phone number. */
  uniquePhone: 95,
  /** Exactly one party on an email address. */
  uniqueEmail: 85,
  /** Created fresh; there is nothing to be confident about. */
  created: 100,
  /** Several candidates. Deliberately below every auto-link threshold. */
  ambiguous: 40,
} as const;

/**
 * Find every party that could be this external customer.
 *
 * Returns **all** matches, not the first. That plural return type is the fix
 * for the original bug: a function that can only return one answer forces its
 * caller to pick one, and `ORDER BY created_at LIMIT 1` is what picking one
 * looks like when nobody decided how.
 */
export async function findIdentityCandidates(
  businessId: string,
  identity: { phone?: string | null; email?: string | null },
): Promise<MatchCandidate[]> {
  const candidates = new Map<string, MatchCandidate>();

  const e164 = phoneE164(identity.phone ?? null);
  if (e164) {
    const keys = await phoneMatchKeys(businessId, identity.phone ?? null);
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND ${phoneMatchSql("", "$2", "$3")}
          AND merged_into_id IS NULL AND is_active
        ORDER BY name
        LIMIT 20`,
      [businessId, keys.bidx, keys.e164],
    );
    for (const row of rows) {
      candidates.set(row.id, {
        partyId: row.id,
        name: row.name,
        matchedOn: "phone",
        note: "شمارهٔ تلفن یکسان",
      });
    }
  }

  const email = identity.email?.trim().toLowerCase() || null;
  if (email) {
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND lower(email) = $2
          AND merged_into_id IS NULL AND is_active
        ORDER BY name
        LIMIT 20`,
      [businessId, email],
    );
    for (const row of rows) {
      // A party already matched on phone stays labelled as a phone match: it is
      // the stronger signal, and showing "phone and email" would be noise when
      // the decision is the same either way.
      if (candidates.has(row.id)) continue;
      candidates.set(row.id, {
        partyId: row.id,
        name: row.name,
        matchedOn: "email",
        note: "نشانی ایمیل یکسان",
      });
    }
  }

  return [...candidates.values()];
}

/** Fields the remote may contribute, in the order the review screen shows them. */
const MIRRORED_FIELDS = ["name", "email", "phone", "address"] as const;
type MirroredField = (typeof MIRRORED_FIELDS)[number];

interface PartySnapshot extends Record<string, unknown> {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

/**
 * Compare the remote snapshot with the canonical record.
 *
 * Returns the fields that are *empty locally* (safe to fill) separately from
 * the fields that *disagree* (never overwritten, recorded for a human). That
 * split is the whole of rule 3, and keeping it in one pure function means the
 * sync path and the review screen cannot apply different definitions of
 * "conflict".
 */
export function diffAgainstParty(
  party: PartySnapshot,
  remote: { name?: string | null; email?: string | null; phone?: string | null; address?: string | null },
): {
  fill: Partial<Record<MirroredField, string>>;
  conflicts: { field: MirroredField; local: string; remote: string }[];
} {
  const fill: Partial<Record<MirroredField, string>> = {};
  const conflicts: { field: MirroredField; local: string; remote: string }[] = [];

  for (const field of MIRRORED_FIELDS) {
    const remoteValue = (remote[field] ?? "").toString().trim();
    if (!remoteValue) continue;
    const localValue = (party[field] ?? "").toString().trim();
    if (!localValue) {
      fill[field] = remoteValue;
      continue;
    }
    // Case and spacing differences are not disagreements; they are the same
    // answer typed differently, and flagging them would bury the real ones.
    const normalise = (value: string) => value.toLocaleLowerCase("fa-IR").replace(/\s+/g, " ").trim();
    if (field === "phone") {
      // Compare phones in canonical form, or «۰۹۱۲…» versus «+98912…» reads as
      // a conflict on every single sync.
      if (phoneE164(localValue) === phoneE164(remoteValue)) continue;
    } else if (normalise(localValue) === normalise(remoteValue)) {
      continue;
    }
    conflicts.push({ field, local: localValue, remote: remoteValue });
  }

  return { fill, conflicts };
}

/**
 * Record what the store knows about a customer, and link it to a party if —
 * and only if — the identity is unambiguous.
 *
 * This is the single entry point the Website app uses. It replaces
 * `upsertCustomerFromWoo`'s direct writes to `parties`.
 *
 * `allowCreate` is false for order import (a guest checkout that matches
 * nobody should not silently manufacture a customer record mid-import; the
 * order carries the name) and true for an explicit customer sync, where
 * creating the person is the point of the operation.
 */
export async function reconcileExternalIdentity(
  input: ExternalIdentityInput,
  options: { allowCreate?: boolean; actor?: string } = {},
): Promise<ReconcileResult> {
  const {
    businessId,
    connectionId,
    remoteId,
    provider = "woocommerce",
  } = input;
  const name = (input.name ?? "").trim();
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const address = input.address?.trim() || null;
  const e164 = phoneE164(phone);

  return withTenant(businessId, async () => {
    // 1. Mirror the remote snapshot. This always happens, even for a profile
    //    we cannot resolve: "we have seen this shopper and could not identify
    //    them" is exactly the fact the reconciliation screen is built on, and
    //    dropping it on the floor is how the old code made the problem
    //    invisible.
    const { rows: profileRows } = await query<{ id: string; party_id: string | null; status: string }>(
      `INSERT INTO crm_external_profiles
         (business_id, connection_id, provider, remote_id, remote_name, remote_email,
          remote_phone, remote_phone_e164, remote_address, remote_payload,
          remote_updated_at, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, now())
       ON CONFLICT (business_id, connection_id, remote_id) DO UPDATE
         SET remote_name = EXCLUDED.remote_name,
             remote_email = EXCLUDED.remote_email,
             remote_phone = EXCLUDED.remote_phone,
             remote_phone_e164 = EXCLUDED.remote_phone_e164,
             remote_address = EXCLUDED.remote_address,
             remote_payload = EXCLUDED.remote_payload,
             remote_updated_at = EXCLUDED.remote_updated_at,
             last_synced_at = now(),
             updated_at = now()
       RETURNING id, party_id, status`,
      [
        businessId,
        connectionId,
        provider,
        remoteId,
        name,
        email,
        phone,
        e164,
        address,
        JSON.stringify(input.payload ?? {}),
        input.remoteUpdatedAt ?? null,
      ],
    );
    const profile = profileRows[0];

    // 2. Already linked? Then this is a data refresh, not an identity question.
    if (profile.party_id) {
      const applied = await applyRemoteToParty(businessId, profile.id, profile.party_id, {
        name,
        email,
        phone,
        address,
      });
      return {
        profileId: profile.id,
        partyId: profile.party_id,
        status: applied.conflicted ? "conflict" : (profile.status as ExternalProfileStatus),
        confidence: CONFIDENCE.existingMapping,
        reason: "already_mapped",
        candidates: [],
        created: false,
      };
    }

    // 3. A profile a human parked stays parked. Re-running a sync must not
    //    quietly undo somebody's decision to review it later, and it must
    //    certainly not re-attempt an auto-match they already declined.
    if (profile.status === "needs_review" || profile.status === "ignored") {
      return {
        profileId: profile.id,
        partyId: null,
        status: profile.status as ExternalProfileStatus,
        confidence: 0,
        reason: "awaiting_human_decision",
        candidates: await readCandidates(businessId, profile.id),
        created: false,
      };
    }

    // 4. Who could this be?
    const candidates = await findIdentityCandidates(businessId, { phone, email });

    if (candidates.length > 1) {
      // THE rule. Several people share this phone or email — a family, a
      // shared work number, a couple using one address. Picking the oldest
      // record (what the old code did) attributes somebody's purchase to their
      // spouse and then reports it in the wrong person's spend history
      // forever. Park it, keep every candidate, and let a person decide.
      await query(
        `UPDATE crm_external_profiles
            SET status = 'needs_review',
                match_confidence = $3,
                match_reason = $4,
                match_candidates = $5::jsonb,
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          businessId,
          profile.id,
          CONFIDENCE.ambiguous,
          `چند مشتری با این مشخصات پیدا شد (${candidates.length} مورد)`,
          JSON.stringify(candidates),
        ],
      );
      return {
        profileId: profile.id,
        partyId: null,
        status: "needs_review",
        confidence: CONFIDENCE.ambiguous,
        reason: "ambiguous_identity",
        candidates,
        created: false,
      };
    }

    if (candidates.length === 1) {
      const candidate = candidates[0];
      const confidence =
        candidate.matchedOn === "phone" ? CONFIDENCE.uniquePhone : CONFIDENCE.uniqueEmail;
      const applied = await applyRemoteToParty(businessId, profile.id, candidate.partyId, {
        name,
        email,
        phone,
        address,
      });
      await query(
        `UPDATE crm_external_profiles
            SET party_id = $3, status = $4, match_confidence = $5,
                match_reason = $6, match_candidates = '[]'::jsonb, updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          businessId,
          profile.id,
          candidate.partyId,
          applied.conflicted ? "conflict" : "auto_matched",
          confidence,
          candidate.note,
        ],
      );
      return {
        profileId: profile.id,
        partyId: candidate.partyId,
        status: applied.conflicted ? "conflict" : "auto_matched",
        confidence,
        reason: candidate.matchedOn === "phone" ? "unique_phone" : "unique_email",
        candidates,
        created: false,
      };
    }

    // 5. Nobody matches.
    if (!options.allowCreate) {
      await query(
        `UPDATE crm_external_profiles
            SET status = 'unmapped', match_confidence = 0,
                match_reason = 'مشتری متناظری پیدا نشد', updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, profile.id],
      );
      return {
        profileId: profile.id,
        partyId: null,
        status: "unmapped",
        confidence: 0,
        reason: "no_match",
        candidates: [],
        created: false,
      };
    }

    // A person with no phone, no email and no name is not somebody this system
    // can identify. Creating a row for them fills the directory with ghosts
    // that can never be matched, deduplicated or contacted.
    if (!e164 && !email && !name) {
      return {
        profileId: profile.id,
        partyId: null,
        status: "unmapped",
        confidence: 0,
        reason: "insufficient_identity",
        candidates: [],
        created: false,
      };
    }

    const partyId = await createPartyFromExternal(businessId, {
      name: name || email || `مشتری فروشگاه #${remoteId}`,
      email,
      phone,
      address,
      provider,
    });
    await query(
      `UPDATE crm_external_profiles
          SET party_id = $3, status = 'confirmed', match_confidence = $4,
              match_reason = 'پروندهٔ تازه از فروشگاه آنلاین ساخته شد', updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, profile.id, partyId, CONFIDENCE.created],
    );

    await recordCrmAudit({
      businessId,
      kind: "external.reconciled",
      entityType: "external_profile",
      entityId: profile.id,
      partyId,
      summary: `پروندهٔ مشتری از ${provider} ساخته شد`,
      detail: { remoteId, provider, reason: "no_match_created" },
      actorName: options.actor ?? "همگام‌سازی",
    });

    return {
      profileId: profile.id,
      partyId,
      status: "confirmed",
      confidence: CONFIDENCE.created,
      reason: "created",
      candidates: [],
      created: true,
    };
  });
}

/**
 * Fill blanks on the canonical record; record disagreements instead of
 * overwriting them.
 *
 * Returns whether anything conflicted, so the caller can mark the profile.
 */
async function applyRemoteToParty(
  businessId: string,
  profileId: string,
  partyId: string,
  remote: { name: string; email: string | null; phone: string | null; address: string | null },
): Promise<{ conflicted: boolean }> {
  const { rows } = await query<PartySnapshot>(
    `SELECT id, name, email, phone, address FROM parties
      WHERE business_id = $1 AND id = $2`,
    [businessId, partyId],
  );
  const party = rows[0];
  if (!party) return { conflicted: false };

  const { fill, conflicts } = diffAgainstParty(party, remote);

  if (Object.keys(fill).length > 0) {
    // COALESCE-style fill only. Every one of these columns was verified empty
    // by diffAgainstParty, so this cannot clobber anything a human entered.
    await query(
      `UPDATE parties
          SET name = COALESCE(NULLIF(name, ''), $3),
              email = COALESCE(email, $4),
              phone = COALESCE(NULLIF(phone, ''), $5),
              address = COALESCE(NULLIF(address, ''), $6),
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, partyId, fill.name ?? null, fill.email ?? null, fill.phone ?? null, fill.address ?? null],
    );
    if (fill.phone) {
      // The 0125 trigger invalidates the ciphertext and derived columns when
      // the plaintext phone changes. Re-derive now: a sync is exactly when a
      // number appears, and the window where the customer cannot be found by
      // phone should not last until the next backfill run.
      await syncCustomerPhone(businessId, partyId, fill.phone);
    }
  }

  await query(
    `UPDATE crm_external_profiles
        SET conflicts = $3::jsonb, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      businessId,
      profileId,
      JSON.stringify(conflicts.map((conflict) => ({ ...conflict, seenAt: new Date().toISOString() }))),
    ],
  );

  return { conflicted: conflicts.length > 0 };
}

/**
 * Create a canonical party for an external customer, with provenance.
 *
 * The one place the website path is allowed to add a person, so the
 * `acquisition_source` stamp cannot be forgotten — and so attribution reporting
 * («how many customers did the online store bring us?») has a real answer
 * rather than a guess based on which records happen to have an email.
 *
 * Consent columns are conspicuously absent: they keep their defaults. See
 * rule 4.
 */
async function createPartyFromExternal(
  businessId: string,
  input: {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    provider: string;
  },
): Promise<string> {
  const e164 = phoneE164(input.phone);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO parties
       (business_id, name, phone, phone_e164, email, address, roles,
        acquisition_source, acquisition_detail, acquisition_at, last_source)
     VALUES ($1, $2, $3, $4, $5, $6, ARRAY['customer']::text[], $7, $8, now(), $7)
     RETURNING id`,
    [businessId, input.name, input.phone, e164, input.email, input.address, input.provider, "sync"],
  );
  const partyId = rows[0].id;
  // INSERT does not fire the invalidation trigger (it is BEFORE UPDATE), so a
  // row created here would have no ciphertext at all until a backfill ran.
  await syncCustomerPhone(businessId, partyId, input.phone);
  return partyId;
}

async function readCandidates(businessId: string, profileId: string): Promise<MatchCandidate[]> {
  const { rows } = await query<{ match_candidates: MatchCandidate[] }>(
    `SELECT match_candidates FROM crm_external_profiles WHERE business_id = $1 AND id = $2`,
    [businessId, profileId],
  );
  return rows[0]?.match_candidates ?? [];
}

/**
 * The party an external customer resolves to, or null when nobody has decided.
 *
 * Null is a real answer here, and callers must treat it as one. An order whose
 * buyer is unresolved is imported without a customer — visible in the
 * reconciliation queue, correctable in one click, and *not* silently
 * attributed to the wrong person.
 */
export async function partyForExternalCustomer(
  businessId: string,
  connectionId: string,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await query<{ party_id: string | null }>(
    `SELECT party_id FROM crm_external_profiles
      WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3`,
    [businessId, connectionId, remoteId],
  );
  return rows[0]?.party_id ?? null;
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export interface ExternalProfileRow extends Record<string, unknown> {
  id: string;
  connectionId: string;
  provider: string;
  remoteId: string;
  remoteName: string;
  remoteEmail: string | null;
  remotePhone: string | null;
  partyId: string | null;
  partyName: string | null;
  status: ExternalProfileStatus;
  matchConfidence: number;
  matchReason: string;
  matchCandidates: MatchCandidate[];
  conflicts: { field: string; local: string; remote: string }[];
  lastSyncedAt: string | null;
}

const PROFILE_COLUMNS = `p.id, p.connection_id AS "connectionId", p.provider,
  p.remote_id AS "remoteId", p.remote_name AS "remoteName",
  p.remote_email AS "remoteEmail", p.remote_phone AS "remotePhone",
  p.party_id AS "partyId", c.name AS "partyName", p.status,
  p.match_confidence AS "matchConfidence", p.match_reason AS "matchReason",
  p.match_candidates AS "matchCandidates", p.conflicts,
  p.last_synced_at AS "lastSyncedAt"`;

/** The reconciliation queue: everything a human still has to decide. */
export async function listExternalProfiles(
  businessId: string,
  options: { status?: ExternalProfileStatus | "pending"; search?: string; limit?: number } = {},
): Promise<ExternalProfileRow[]> {
  const params: unknown[] = [businessId];
  let where = "p.business_id = $1";

  if (options.status === "pending") {
    // The default view: the two states that need a person, and nothing else.
    where += ` AND p.status IN ('needs_review', 'conflict')`;
  } else if (options.status) {
    params.push(options.status);
    where += ` AND p.status = $${params.length}`;
  }

  const search = options.search?.trim();
  if (search) {
    // Same escaping discipline as every other list in the CRM: a customer
    // searching for «100%» must not turn into a wildcard scan.
    params.push(`%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
    where += ` AND (p.remote_name ILIKE $${params.length} ESCAPE '\\'
                 OR p.remote_email ILIKE $${params.length} ESCAPE '\\'
                 OR p.remote_phone ILIKE $${params.length} ESCAPE '\\')`;
  }

  params.push(Math.min(Math.max(Math.trunc(options.limit ?? 100) || 100, 1), 500));

  const { rows } = await query<ExternalProfileRow>(
    `SELECT ${PROFILE_COLUMNS}
       FROM crm_external_profiles p
       LEFT JOIN parties c ON c.id = p.party_id
      WHERE ${where}
      ORDER BY p.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** How many decisions are waiting — the badge on the reconciliation nav item. */
export async function countPendingExternalProfiles(businessId: string): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM crm_external_profiles
      WHERE business_id = $1 AND status IN ('needs_review', 'conflict')`,
    [businessId],
  );
  return rows[0]?.count ?? 0;
}

/**
 * A human resolves an external profile.
 *
 * The only way an ambiguous identity ever becomes a link. Deliberately not
 * exposed to the assistant or to any automation: attributing a stranger's
 * purchases to a named person is a judgement about people, and the audit row
 * has to name whoever made it.
 */
export async function resolveExternalProfile(
  businessId: string,
  profileId: string,
  decision:
    | { action: "link"; partyId: string }
    | { action: "create" }
    | { action: "ignore" }
    | { action: "accept_conflicts" }
    | { action: "reject_conflicts" },
  actor: { name: string; userId?: string | null },
): Promise<ExternalProfileRow | null> {
  // Transactional: the profile is locked, a party may be created, conflicts
  // may be applied and the profile rewritten. Half of that is not a state
  // anybody can make sense of.
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{
      id: string;
      provider: string;
      remote_id: string;
      remote_name: string;
      remote_email: string | null;
      remote_phone: string | null;
      remote_address: string | null;
      party_id: string | null;
      conflicts: { field: string; local: string; remote: string }[];
    }>(
      `SELECT id, provider, remote_id, remote_name, remote_email, remote_phone,
              remote_address, party_id, conflicts
         FROM crm_external_profiles
        WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [businessId, profileId],
    );
    const profile = rows[0];
    if (!profile) return null;

    let partyId = profile.party_id;
    let status: ExternalProfileStatus = "confirmed";
    let summary = "";

    if (decision.action === "ignore") {
      partyId = null;
      status = "ignored";
      summary = "پروندهٔ فروشگاه نادیده گرفته شد";
    } else if (decision.action === "link") {
      // Verify the target is a real, live customer of *this* business. A
      // profile id and a party id both arrive from the browser, and tenancy
      // must be proven here rather than assumed from the session.
      const { rows: target } = await query<{ id: string }>(
        `SELECT id FROM parties
          WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL AND is_active`,
        [businessId, decision.partyId],
      );
      if (!target[0]) return null;
      partyId = decision.partyId;
      status = "confirmed";
      summary = "پروندهٔ فروشگاه به مشتری موجود وصل شد";
    } else if (decision.action === "create") {
      partyId = await createPartyFromExternal(businessId, {
        name: profile.remote_name || profile.remote_email || `مشتری فروشگاه #${profile.remote_id}`,
        email: profile.remote_email,
        phone: profile.remote_phone,
        address: profile.remote_address,
        provider: profile.provider,
      });
      status = "confirmed";
      summary = "برای پروندهٔ فروشگاه، مشتری تازه ساخته شد";
    } else if (decision.action === "accept_conflicts") {
      if (!partyId) return null;
      // The only path on which remote data overwrites a filled local field,
      // and it exists because a person looked at both values and chose.
      for (const conflict of profile.conflicts ?? []) {
        if (!["name", "email", "phone", "address"].includes(conflict.field)) continue;
        await query(
          `UPDATE parties SET ${conflict.field} = $3, updated_at = now()
            WHERE business_id = $1 AND id = $2`,
          [businessId, partyId, conflict.remote],
        );
        if (conflict.field === "phone") await syncCustomerPhone(businessId, partyId, conflict.remote);
      }
      status = "confirmed";
      summary = "مقادیر فروشگاه جایگزین مقادیر محلی شد";
    } else {
      if (!partyId) return null;
      status = "confirmed";
      summary = "مقادیر محلی حفظ شد و اختلاف‌ها بسته شد";
    }

    await query(
      `UPDATE crm_external_profiles
          SET party_id = $3, status = $4, match_candidates = '[]'::jsonb,
              conflicts = '[]'::jsonb, match_confidence = 100,
              reviewed_at = now(), reviewed_by = $5, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, profileId, partyId, status, actor.name.slice(0, 120)],
    );

    await recordCrmAudit({
      businessId,
      kind: "external.conflict_resolved",
      entityType: "external_profile",
      entityId: profileId,
      partyId,
      summary,
      detail: { action: decision.action, provider: profile.provider, remoteId: profile.remote_id },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    const result = await listExternalProfiles(businessId, { limit: 500 });
    return result.find((row) => row.id === profileId) ?? null;
  });
}
