/**
 * Customers — business-wide (like the chart of accounts; a customer may show
 * up at any branch). Originally just a lookup for the AR subledger's
 * credit-payment picker (`searchCustomers`/`createCustomer`); this also backs
 * the standalone customer-directory page (list/edit/deactivate/delete).
 * DB-touching, so per repo convention it has no direct unit test.
 */
import { query } from "./db";

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
       birthday::text AS "birthday", tags, marketing_consent AS "marketingConsent",
       sms_consent AS "smsConsent",
       is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Name/phone search for the checkout picker, active customers only, newest first, capped at 20. */
export async function searchCustomers(businessId: string, q: string): Promise<Customer[]> {
  const term = q.trim();
  if (!term) {
    const { rows } = await query<Customer>(
      `SELECT id, name, phone FROM customers WHERE business_id = $1 AND is_active ORDER BY created_at DESC LIMIT 20`,
      [businessId],
    );
    return rows;
  }
  const { rows } = await query<Customer>(
    `SELECT id, name, phone FROM customers
      WHERE business_id = $1 AND is_active AND (name ILIKE $2 OR phone ILIKE $2)
      ORDER BY created_at DESC LIMIT 20`,
    [businessId, `%${term}%`],
  );
  return rows;
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

  const conditions = ["business_id = $1"];
  const params: unknown[] = [businessId];
  if (!options.includeInactive) conditions.push("is_active");
  if (term) {
    params.push(`%${term}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT count(*) FROM customers WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0]?.count ?? 0);

  const { rows } = await query<Customer>(
    `SELECT ${DIRECTORY_COLUMNS} FROM customers WHERE ${where}
      ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  return { customers: rows, total };
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
  const { rows } = await query<Customer>(
    `INSERT INTO customers (business_id, name, phone, address, notes, email, birthday, tags, marketing_consent, sms_consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)
     RETURNING ${DIRECTORY_COLUMNS}`,
    [
      businessId,
      input.name.trim(),
      input.phone?.trim() || null,
      input.address?.trim() || null,
      input.notes?.trim() || null,
      input.email?.trim() || null,
      input.birthday ?? null,
      input.tags ?? [],
      input.marketingConsent ?? false,
      input.smsConsent ?? false,
    ],
  );
  return rows[0];
}

export async function getCustomer(businessId: string, id: string): Promise<Customer | null> {
  const { rows } = await query<Customer>(
    `SELECT ${DIRECTORY_COLUMNS} FROM customers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
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
  const sets: string[] = [];
  const params: unknown[] = [businessId, id];

  function add(column: string, value: unknown) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  if (input.name !== undefined) add("name", input.name.trim());
  if (input.phone !== undefined) add("phone", input.phone?.trim() || null);
  if (input.address !== undefined) add("address", input.address?.trim() || null);
  if (input.notes !== undefined) add("notes", input.notes?.trim() || null);
  if (input.email !== undefined) add("email", input.email?.trim() || null);
  if (input.birthday !== undefined) add("birthday", input.birthday ?? null);
  if (input.tags !== undefined) add("tags", input.tags);
  if (input.marketingConsent !== undefined) add("marketing_consent", input.marketingConsent);
  if (input.smsConsent !== undefined) add("sms_consent", input.smsConsent);
  if (input.isActive !== undefined) add("is_active", input.isActive);
  if (sets.length === 0) return getCustomer(businessId, id);

  const { rows } = await query<Customer>(
    `UPDATE customers SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING ${DIRECTORY_COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
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
