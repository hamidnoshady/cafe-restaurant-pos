/**
 * Customers — business-wide (like the chart of accounts; a customer may show
 * up at any branch). Originally just a lookup for the AR subledger's
 * credit-payment picker (`searchCustomers`/`createCustomer`); this also backs
 * the standalone customer-directory page (list/edit/deactivate/delete).
 * DB-touching, so per repo convention it has no direct unit test.
 */
import { getBusinessDek } from "./business-keys";
import { query } from "./db";
import { decryptOptional, encryptOptional, phoneBlindIndex } from "./field-crypto";

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

/** The encrypted twins for a phone value: `[ciphertext, blind index]`, both null when there is no key. */
function phoneCiphertext(phone: string | null, dek: Buffer | null): [Buffer | null, string | null] {
  if (!dek) return [null, null];
  return [encryptOptional(phone, dek), phone ? phoneBlindIndex(phone, dek) : null];
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
  // Three ways to match, and they are not interchangeable. `name ILIKE` and
  // `phone ILIKE` are the substring search that exists today; `phone_bidx =`
  // is an exact match on the canonical number, which is the only phone search
  // that will survive step 3 of the migration. A cashier typing the last four
  // digits still finds the customer today and will not once the plaintext
  // column is dropped — the accepted loss recorded in the phase doc.
  const bidx = dek ? phoneBlindIndex(term, dek) : null;
  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `SELECT id, name, phone, phone_enc AS "phoneEnc" FROM customers
      WHERE business_id = $1 AND is_active
        AND (name ILIKE $2 OR phone ILIKE $2 OR ($3::text IS NOT NULL AND phone_bidx = $3))
      ORDER BY created_at DESC LIMIT 20`,
    [businessId, `%${term}%`, bidx],
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
    params.push(`%${term}%`);
    const like = params.length;
    params.push(dek ? phoneBlindIndex(term, dek) : null);
    conditions.push(
      `(name ILIKE $${like} OR phone ILIKE $${like} OR ($${params.length}::text IS NOT NULL AND phone_bidx = $${params.length}))`,
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
  const [phoneEnc, phoneBidx] = phoneCiphertext(phone, dek);

  const { rows } = await query<Customer & EncryptedCustomerRow>(
    `INSERT INTO customers (business_id, name, phone, address, notes, email, birthday, tags, marketing_consent, sms_consent,
                            phone_enc, phone_bidx, address_enc, notes_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14)
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
      phoneEnc,
      phoneBidx,
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
    const [phoneEnc, phoneBidx] = phoneCiphertext(phone, dek);
    add("phone", phone);
    add("phone_enc", phoneEnc);
    add("phone_bidx", phoneBidx);
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
