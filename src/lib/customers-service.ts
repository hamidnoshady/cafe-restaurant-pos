/**
 * Customers — business-wide (like the chart of accounts; a customer may show
 * up at any branch). Originally just a lookup for the AR subledger's
 * credit-payment picker (`searchCustomers`/`createCustomer`); this also backs
 * the standalone customer-directory page (list/edit/deactivate/delete).
 * DB-touching, so per repo convention it has no direct unit test.
 */
import { getBusinessDek } from "./business-keys";
import { query } from "./db";
import { decryptOptional, encryptOptional, phoneBlindIndex, phoneKind, phoneLast4 } from "./field-crypto";
import { phoneDigits, phoneE164 } from "./phone";

/** Server-side length caps mirrored by the directory form's `maxLength`s — see directory-section.tsx. */
export const MAX_CUSTOMER_NAME = 200;
export const MAX_CUSTOMER_PHONE = 32;
export const MAX_CUSTOMER_ADDRESS = 500;
export const MAX_CUSTOMER_NOTES = 2000;

export interface Customer extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  address?: string | null;
  notes?: string | null;
  email?: string | null;
  birthday?: string | null;
  tags?: string[];
  marketingConsent?: boolean;
  smsConsent?: boolean;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const DIRECTORY_COLUMNS = `id, name, phone, address, notes, email,
       phone_enc AS "phoneEnc", address_enc AS "addressEnc", notes_enc AS "notesEnc",
       birthday::text AS "birthday", tags, marketing_consent AS "marketingConsent",
       sms_consent AS "smsConsent",
       is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Phase 24 Wave 3 — field-level encryption lives here, at the service layer,
 * never in db.ts: a transparent database layer cannot know which column is
 * which and would silently encrypt the wrong things.
 *
 * During the transition window every write is a dual write (plaintext twin +
 * `*_enc` + `*_bidx`) and every read prefers the ciphertext, falling back to
 * the plaintext twin for rows the backfill has not reached yet. On an install
 * with no master key configured, `getBusinessDek` returns null and all of this
 * collapses to exactly the behaviour that shipped before the wave.
 */
interface EncryptedCustomerRow {
  phoneEnc?: unknown;
  addressEnc?: unknown;
  notesEnc?: unknown;
}

/** Replaces the plaintext fields with their decrypted values and drops the ciphertext from the result. */
function decryptCustomerRow(row: Customer & EncryptedCustomerRow, dek: Buffer | null): Customer {
  const { phoneEnc, addressEnc, notesEnc, ...rest } = row;
  const customer: Customer = rest;
  if ("phone" in row) customer.phone = decryptOptional(phoneEnc, dek, row.phone ?? null);
  if ("address" in row) customer.address = decryptOptional(addressEnc, dek, row.address ?? null);
  if ("notes" in row) customer.notes = decryptOptional(notesEnc, dek, row.notes ?? null);
  return customer;
}

/**
 * Everything derived from a typed phone number, written together as one set.
 *
 *  - `phone_enc` / `phone_bidx` — the ciphertext and its equality index; null
 *    on an install with no master key.
 *  - `phone_e164` — the canonical +98… form. It was **not** being maintained
 *    on this path at all before Phase 24 Wave 3: `crm-service.syncCustomerPhone`
 *    exists for exactly this and has never had a caller, so a customer created
 *    or edited from the dashboard was invisible to duplicate detection, to
 *    segment resolution and to the SMS-reachable count until somebody ran
 *    `npm run db:normalize-phones` by hand. Writing it here, beside the blind
 *    index that will replace it, fixes that and keeps the two canonical forms
 *    from drifting apart.
 */
interface PhoneColumns {
  enc: Buffer | null;
  bidx: string | null;
  e164: string | null;
  last4: string | null;
  kind: string | null;
}

function phoneColumns(phone: string | null, dek: Buffer | null): PhoneColumns {
  return {
    enc: dek ? encryptOptional(phone, dek) : null,
    bidx: dek && phone ? phoneBlindIndex(phone, dek) : null,
    e164: phone ? phoneE164(phone) : null,
    // Written unconditionally, key or no key: these are the plaintext remnants
    // that keep last-four search and SMS-reachability alive after step 3, and
    // a business that enables encryption later should not have to re-derive
    // them.
    last4: phoneLast4(phone),
    kind: phoneKind(phone),
  };
}

/**
 * The two keys a *lookup* needs to find the customer holding a given number,
 * whichever state the row is in. Exported because three callers outside this
 * file do exactly this lookup — `ai-tools.ts`'s customer search and
 * `integrations/sync-service.ts`'s two "is this shopper already here" probes —
 * and they must agree with the writes above, or an integration sync quietly
 * creates a second copy of a customer it failed to recognise.
 */
export interface PhoneMatchKeys {
  bidx: string | null;
  e164: string | null;
  last4: string | null;
}

export async function phoneMatchKeys(businessId: string, phone: string | null): Promise<PhoneMatchKeys> {
  const dek = await getBusinessDek(businessId);
  return {
    bidx: dek && phone ? phoneBlindIndex(phone, dek) : null,
    e164: phone ? phoneE164(phone) : null,
    last4: phoneLast4(phone),
  };
}

/**
 * SQL for "this row holds that number", true in either state.
 *
 * Prefer the blind index; fall back to the canonical plaintext **only for a
 * row that has no blind index yet**. That asymmetry is deliberate and differs
 * from the `coalesce(...) = coalesce(...)` used by the duplicate self-joins: a
 * self-join compares two rows that are almost always in the same state, and a
 * transient miss there costs one delayed suggestion. A lookup compares a typed
 * number against a row mid-backfill, and a miss there makes the caller decide
 * the customer does not exist — which, in the WooCommerce sync, means creating
 * a duplicate person.
 */
export function phoneMatchSql(alias: string, bidxParam: string, e164Param: string): string {
  const a = alias ? `${alias}.` : "";
  return (
    `((${bidxParam}::text IS NOT NULL AND ${a}phone_bidx = ${bidxParam})` +
    ` OR (${a}phone_bidx IS NULL AND ${e164Param}::text IS NOT NULL AND ${a}phone_e164 = ${e164Param}))`
  );
}

/** Row-to-row key, for the duplicate self-joins. Collapses to `phone_bidx` at step 3. */
export function phonePairKeySql(alias: string): string {
  const a = alias ? `${alias}.` : "";
  return `coalesce(${a}phone_bidx, ${a}phone_e164)`;
}

/**
 * "Can this number actually receive an SMS."
 *
 * Not `phone_e164 IS NOT NULL`, which is what the CRM counted before and means
 * merely "parses as an Iranian number" — a landline included. Reads
 * `phone_kind` where the row has been classified and falls back to the shape
 * of the canonical number where it has not: an Iranian mobile is `+989` plus
 * nine digits, which is the same rule `phone.ts` applies. Yields NULL for a
 * customer with no phone, which `count(*) FILTER` correctly declines to count.
 */
export function mobileReachableSql(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return (
    `(CASE WHEN ${a}phone_kind IS NOT NULL THEN ${a}phone_kind = 'mobile'` +
    ` ELSE ${a}phone_e164 LIKE '+989%' AND length(${a}phone_e164) = 13 END)`
  );
}

/**
 * How a typed search term matches a phone, in the order the columns will
 * outlive each other:
 *
 *   1. `phone_bidx` — an exact match on the whole number, and the only phone
 *      search that survives step 3 intact.
 *   2. `phone_last4` — the till workflow: four or more digits that are not a
 *      whole number are read as "the last four I can see".
 *   3. `phone ILIKE '%…%'` — arbitrary substring, alive only while the
 *      plaintext column is.
 */
interface PhoneSearchKeys {
  bidx: string | null;
  last4: string | null;
}

function phoneSearchKeys(term: string, dek: Buffer | null): PhoneSearchKeys {
  const digits = phoneDigits(term);
  if (!digits) return { bidx: null, last4: null };
  const whole = phoneE164(term) !== null;
  return {
    bidx: dek ? phoneBlindIndex(term, dek) : null,
    last4: !whole && digits.length >= 4 ? digits.slice(-4) : null,
  };
}

/** Name/phone search for the checkout picker, active customers only, newest first, capped at 20. */
export async function searchCustomers(businessId: string, q: string): Promise<Customer[]> {
  const term = q.trim();
  const dek = await getBusinessDek(businessId);
  if (!term) {
    const { rows } = await query<Customer & EncryptedCustomerRow>(
      `SELECT id, name, phone, phone_enc AS "phoneEnc" FROM customers
        WHERE business_id = $1 AND is_active ORDER BY created_at DESC LIMIT 20`,
      [businessId],
    );
    return rows.map((row) => decryptCustomerRow(row, dek));
  }
  const keys = phoneSearchKeys(term, dek);
  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `SELECT id, name, phone, phone_enc AS "phoneEnc" FROM customers
      WHERE business_id = $1 AND is_active
        AND (name ILIKE $2 OR phone ILIKE $2
             OR ($3::text IS NOT NULL AND phone_bidx = $3)
             OR ($4::text IS NOT NULL AND phone_last4 = $4))
      ORDER BY created_at DESC LIMIT 20`,
    [businessId, `%${term}%`, keys.bidx, keys.last4],
  );
  return rows.map((row) => decryptCustomerRow(row, dek));
}

export interface CustomerListResult {
  customers: Customer[];
  total: number;
}

/** Paginated directory listing for the customers management page. */
export async function listCustomers(
  businessId: string,
  options: { q?: string; includeInactive?: boolean; page?: number; pageSize?: number },
): Promise<CustomerListResult> {
  const term = options.q?.trim() ?? "";
  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const dek = await getBusinessDek(businessId);
  const conditions = ["business_id = $1"];
  const params: unknown[] = [businessId];
  if (!options.includeInactive) conditions.push("is_active");
  if (term) {
    const keys = phoneSearchKeys(term, dek);
    params.push(`%${term}%`);
    const like = params.length;
    params.push(keys.bidx);
    const bidx = params.length;
    params.push(keys.last4);
    const last4 = params.length;
    conditions.push(
      `(name ILIKE $${like} OR phone ILIKE $${like}` +
        ` OR ($${bidx}::text IS NOT NULL AND phone_bidx = $${bidx})` +
        ` OR ($${last4}::text IS NOT NULL AND phone_last4 = $${last4}))`,
    );
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT count(*) FROM customers WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0]?.count ?? 0);

  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `SELECT ${DIRECTORY_COLUMNS} FROM customers WHERE ${where}
      ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  return { customers: rows.map((row) => decryptCustomerRow(row, dek)), total };
}

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  email?: string | null;
  birthday?: string | null;
  tags?: string[];
  marketingConsent?: boolean;
  smsConsent?: boolean;
}

export async function createCustomer(businessId: string, input: CreateCustomerInput): Promise<Customer> {
  const dek = await getBusinessDek(businessId);
  const phone = input.phone?.trim() || null;
  const address = input.address?.trim() || null;
  const notes = input.notes?.trim() || null;
  const phoneCols = phoneColumns(phone, dek);

  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `INSERT INTO customers (business_id, name, phone, address, notes, email, birthday, tags, marketing_consent, sms_consent,
                            phone_enc, phone_bidx, phone_e164, phone_last4, phone_kind, address_enc, notes_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${DIRECTORY_COLUMNS}`,
    [
      businessId,
      input.name.trim(),
      phone,
      address,
      notes,
      input.email?.trim() || null,
      input.birthday ?? null,
      input.tags ?? [],
      input.marketingConsent ?? false,
      input.smsConsent ?? false,
      phoneCols.enc,
      phoneCols.bidx,
      phoneCols.e164,
      phoneCols.last4,
      phoneCols.kind,
      dek ? encryptOptional(address, dek) : null,
      dek ? encryptOptional(notes, dek) : null,
    ],
  );
  return decryptCustomerRow(rows[0], dek);
}

export async function getCustomer(businessId: string, id: string): Promise<Customer | null> {
  const dek = await getBusinessDek(businessId);
  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `SELECT ${DIRECTORY_COLUMNS} FROM customers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? decryptCustomerRow(rows[0], dek) : null;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  email?: string | null;
  birthday?: string | null;
  tags?: string[];
  marketingConsent?: boolean;
  smsConsent?: boolean;
  isActive?: boolean;
}

/** Edits a customer's own fields. Returns null if it doesn't exist in this business. */
export async function updateCustomer(
  businessId: string,
  id: string,
  input: UpdateCustomerInput,
): Promise<Customer | null> {
  const dek = await getBusinessDek(businessId);
  const sets: string[] = [];
  const params: unknown[] = [businessId, id];

  function add(column: string, value: unknown) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  if (input.name !== undefined) add("name", input.name.trim());
  // Each encrypted field is written as a set: plaintext twin, ciphertext, and
  // (phone only) blind index. Writing the plaintext without the ciphertext
  // would leave a row the next reader silently reads from the stale `_enc`
  // value, which is the one failure mode of a dual-write window.
  if (input.phone !== undefined) {
    const phone = input.phone?.trim() || null;
    const cols = phoneColumns(phone, dek);
    add("phone", phone);
    add("phone_enc", cols.enc);
    add("phone_bidx", cols.bidx);
    add("phone_e164", cols.e164);
    add("phone_last4", cols.last4);
    add("phone_kind", cols.kind);
  }
  if (input.address !== undefined) {
    const address = input.address?.trim() || null;
    add("address", address);
    add("address_enc", dek ? encryptOptional(address, dek) : null);
  }
  if (input.notes !== undefined) {
    const notes = input.notes?.trim() || null;
    add("notes", notes);
    add("notes_enc", dek ? encryptOptional(notes, dek) : null);
  }
  if (input.email !== undefined) add("email", input.email?.trim() || null);
  if (input.birthday !== undefined) add("birthday", input.birthday ?? null);
  if (input.tags !== undefined) add("tags", input.tags);
  if (input.marketingConsent !== undefined) add("marketing_consent", input.marketingConsent);
  if (input.smsConsent !== undefined) add("sms_consent", input.smsConsent);
  if (input.isActive !== undefined) add("is_active", input.isActive);
  if (sets.length === 0) return getCustomer(businessId, id);

  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `UPDATE customers SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING ${DIRECTORY_COLUMNS}`,
    params,
  );
  return rows[0] ? decryptCustomerRow(rows[0], dek) : null;
}

export type RemoveCustomerResult = "deleted" | "archived" | "not_found";

/**
 * Removes a customer from the directory. A customer with financial history
 * (an order or an AR receipt referencing them) can never be hard-deleted —
 * ar_receipts.customer_id is ON DELETE RESTRICT for exactly this reason, and
 * an order silently losing its customer attribution would corrupt the AR
 * subledger's "always agrees with the control account" guarantee. Such a
 * customer is archived (is_active = false) instead: they disappear from the
 * checkout picker and default listings but their statement stays intact.
 * A customer with no history at all (e.g. a duplicate/test entry) is hard-deleted.
 */
export async function removeCustomer(businessId: string, id: string): Promise<RemoveCustomerResult> {
  const { rows: existsRows } = await query<{ id: string }>(
    `SELECT id FROM customers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  if (!existsRows[0]) return "not_found";

  const { rows: refRows } = await query<{ has_orders: boolean; has_receipts: boolean; has_points: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM orders WHERE business_id = $1 AND customer_id = $2) AS has_orders,
       EXISTS (SELECT 1 FROM ar_receipts WHERE business_id = $1 AND customer_id = $2) AS has_receipts,
       EXISTS (SELECT 1 FROM customer_points WHERE business_id = $1 AND customer_id = $2) AS has_points`,
    [businessId, id],
  );
  // A customer with points (or store credit, which is only ever created for a
  // customer with points history) must be archived, never hard-deleted — the
  // same ON DELETE RESTRICT discipline ar_receipts has.
  const hasHistory = refRows[0]?.has_orders || refRows[0]?.has_receipts || refRows[0]?.has_points;

  if (hasHistory) {
    await query(`UPDATE customers SET is_active = false, updated_at = now() WHERE business_id = $1 AND id = $2`, [
      businessId,
      id,
    ]);
    return "archived";
  }

  await query(`DELETE FROM customers WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return "deleted";
}
