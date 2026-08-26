/**
 * Phase 26 (issue #125) Wave 2 — Holoo row → app-domain mapping.
 *
 * The pure half of the adapter: turns a canonical Holoo row (already column-
 * mapped by the matched schema profile) into the app's domain shape, with the
 * two conversions that are easy to get wrong done here and nowhere else —
 * money into integer Rial (holoo-money.ts) and dates into ISO (jalali.ts).
 *
 * Framework-free and unit-tested; no DB, no network.
 */
import { holooAmountToRial, type HolooCurrencyUnit } from "./holoo-money";
import { jalaliToIsoDate } from "../../jalali";

// ---------------------------------------------------------------------------
// Dates — Holoo stores either Gregorian datetimes or Jalali (as "yyyy/mm/dd"
// strings or packed integers). One function normalises all three to ISO.
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const SLASH_RE = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/;

/** Convert a Holoo date value to an ISO calendar date (YYYY-MM-DD), or null. */
export function holooDateToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === "number") {
    // A packed Jalali integer (e.g. 14030112). 8 digits, year in the Jalali range.
    const text = String(Math.trunc(value));
    if (/^\d{8}$/.test(text)) return jalaliToIso(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const iso = ISO_RE.exec(text);
    if (iso) {
      const year = Number(iso[1]);
      // Years ≤ 1500 are Jalali; Holoo never stores a Gregorian year that low.
      if (year <= 1500) {
        const m = SLASH_RE.exec(text);
        if (m) return jalaliToIso(year, Number(m[2]), Number(m[3]));
      }
      return text.slice(0, 10);
    }
    const slash = SLASH_RE.exec(text);
    if (slash) return jalaliToIso(Number(slash[1]), Number(slash[2]), Number(slash[3]));
  }

  return null;
}

function jalaliToIso(jy: number, jm: number, jd: number): string | null {
  try {
    return jalaliToIsoDate(jy, jm, jd);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Goods — the canonical Holoo goods row.
// ---------------------------------------------------------------------------

export interface HolooGoodsRow {
  id: string;
  name: string;
  sku?: string | null;
  /** Price in the connection's currency unit. */
  price?: number | string | null;
  unit?: string | null;
}

export interface MappedGoods {
  remoteId: string;
  name: string;
  sku: string | null;
  /** Shelf price in integer Rial, or null when unpriced. */
  priceRial: bigint | null;
  unit: string | null;
}

export function mapGoods(row: HolooGoodsRow, unit: HolooCurrencyUnit): MappedGoods {
  return {
    remoteId: row.id,
    name: row.name,
    sku: row.sku?.trim() || null,
    priceRial: row.price === null || row.price === undefined || row.price === ""
      ? null
      : holooAmountToRial(row.price, unit),
    unit: row.unit?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Persons — customer or supplier.
// ---------------------------------------------------------------------------

export interface HolooPersonRow {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  /** Whether this person is a supplier rather than a customer. */
  isSupplier?: boolean;
}

export interface MappedPerson {
  remoteId: string;
  name: string;
  phone: string | null;
  address: string | null;
  isSupplier: boolean;
}

export function mapPerson(row: HolooPersonRow): MappedPerson {
  return {
    remoteId: row.id,
    name: row.name.trim(),
    phone: row.phone?.trim() || null,
    address: row.address?.trim() || null,
    isSupplier: Boolean(row.isSupplier),
  };
}

// ---------------------------------------------------------------------------
// Accounts — the Holoo account-coding row.
// ---------------------------------------------------------------------------

export interface HolooAccountRow {
  id: string;
  code: string;
  name: string;
  /** Debit/credit nature, when Holoo records it. */
  nature?: string | null;
  parentCode?: string | null;
}

export interface MappedAccount {
  remoteId: string;
  code: string;
  name: string;
  nature: string | null;
  parentCode: string | null;
}

export function mapAccount(row: HolooAccountRow): MappedAccount {
  return {
    remoteId: row.id,
    code: row.code.trim(),
    name: row.name.trim(),
    nature: row.nature?.trim() || null,
    parentCode: row.parentCode?.trim() || null,
  };
}
