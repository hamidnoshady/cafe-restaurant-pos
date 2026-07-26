/**
 * Customers — business-wide (like the chart of accounts; a customer may show
 * up at any branch), used today by the AR subledger to attribute a credit
 * order to somebody. DB-touching, so per repo convention it has no direct
 * unit test.
 */
import { query } from "./db";

export interface Customer extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
}

/** Name/phone search for the checkout picker, newest first, capped at 20. */
export async function searchCustomers(businessId: string, q: string): Promise<Customer[]> {
  const term = q.trim();
  if (!term) {
    const { rows } = await query<Customer>(
      `SELECT id, name, phone FROM customers WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [businessId],
    );
    return rows;
  }
  const { rows } = await query<Customer>(
    `SELECT id, name, phone FROM customers
      WHERE business_id = $1 AND (name ILIKE $2 OR phone ILIKE $2)
      ORDER BY created_at DESC LIMIT 20`,
    [businessId, `%${term}%`],
  );
  return rows;
}

export async function createCustomer(
  businessId: string,
  input: { name: string; phone?: string | null },
): Promise<Customer> {
  const { rows } = await query<Customer>(
    `INSERT INTO customers (business_id, name, phone) VALUES ($1, $2, $3) RETURNING id, name, phone`,
    [businessId, input.name.trim(), input.phone?.trim() || null],
  );
  return rows[0];
}

export async function getCustomer(businessId: string, id: string): Promise<Customer | null> {
  const { rows } = await query<Customer>(
    `SELECT id, name, phone FROM customers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
}
