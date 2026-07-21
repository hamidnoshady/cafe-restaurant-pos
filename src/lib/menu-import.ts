/**
 * Menu import — parses a CSV (or rows extracted from an Excel sheet) into
 * categories + items ready for insertion.
 *
 * Expected columns (header row required; Persian or English aliases):
 *   دسته / category      — category name (required)
 *   نام / name           — item name (required)
 *   قیمت / price         — price in TOMAN (required; Persian digits and
 *                          thousands separators accepted)
 *   توضیحات / description — optional
 *   کد / sku             — optional
 */
import { toLatinDigits } from "./digits";
import { tomanToRial, type Rial } from "./money";

export interface ImportedItem {
  category: string;
  name: string;
  /** stored unit: Rial */
  price: Rial;
  description?: string;
  sku?: string;
}

export interface ImportResult {
  items: ImportedItem[];
  categories: string[];
  /** Persian, row-numbered messages for rows that were skipped */
  errors: string[];
}

const HEADER_ALIASES: Record<string, keyof RawRow> = {
  category: "category",
  "دسته": "category",
  "دسته‌بندی": "category",
  "گروه": "category",
  name: "name",
  "نام": "name",
  "کالا": "name",
  "آیتم": "name",
  price: "price",
  "قیمت": "price",
  "قیمت (تومان)": "price",
  description: "description",
  "توضیحات": "description",
  "توضیح": "description",
  sku: "sku",
  "کد": "sku",
  "کد کالا": "sku",
};

interface RawRow {
  category?: string;
  name?: string;
  price?: string;
  description?: string;
  sku?: string;
}

/** Split CSV text into rows of fields. Handles quotes, CRLF, BOM, and , ; or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");

  // Pick the delimiter that appears most in the first non-empty line (outside quotes is
  // close enough for a header line).
  const firstLine = src.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const delimiter = [",", ";", "\t"]
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function mapHeader(cells: string[]): (keyof RawRow | null)[] {
  return cells.map((c) => HEADER_ALIASES[c.trim().toLowerCase()] ?? HEADER_ALIASES[c.trim()] ?? null);
}

/** Parse a price in Toman (Persian/Latin digits, separators) → integer Rial. */
export function parsePriceToman(input: string): Rial | null {
  const cleaned = toLatinDigits(String(input)).replace(/[٬,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isSafeInteger(n)) return null;
  return tomanToRial(n);
}

/** Turn raw rows (first row = header) into validated import items. */
export function rowsToImport(rows: string[][]): ImportResult {
  const errors: string[] = [];
  if (rows.length === 0) {
    return { items: [], categories: [], errors: ["فایل خالی است."] };
  }

  const header = mapHeader(rows[0]);
  if (!header.includes("category") || !header.includes("name") || !header.includes("price")) {
    return {
      items: [],
      categories: [],
      errors: ["ستون‌های الزامی پیدا نشد. سطر اول باید شامل «دسته»، «نام» و «قیمت» باشد."],
    };
  }

  const items: ImportedItem[] = [];
  const categories: string[] = [];
  const seenCategory = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const raw: RawRow = {};
    rows[r].forEach((cell, i) => {
      const key = header[i];
      if (key) raw[key] = cell.trim();
    });

    const rowNo = r + 1;
    if (!raw.category) {
      errors.push(`سطر ${rowNo}: دسته خالی است.`);
      continue;
    }
    if (!raw.name) {
      errors.push(`سطر ${rowNo}: نام خالی است.`);
      continue;
    }
    const price = parsePriceToman(raw.price ?? "");
    if (price === null) {
      errors.push(`سطر ${rowNo}: قیمت «${raw.price ?? ""}» معتبر نیست.`);
      continue;
    }

    if (!seenCategory.has(raw.category)) {
      seenCategory.add(raw.category);
      categories.push(raw.category);
    }
    items.push({
      category: raw.category,
      name: raw.name,
      price,
      description: raw.description || undefined,
      sku: raw.sku || undefined,
    });
  }

  return { items, categories, errors };
}

export function parseMenuCsv(text: string): ImportResult {
  return rowsToImport(parseCsv(text));
}

/** Sample CSV offered as a downloadable template in the wizard. */
export const SAMPLE_CSV =
  "\uFEFF" +
  [
    "دسته,نام,قیمت,توضیحات,کد",
    "نوشیدنی گرم,اسپرسو,85000,تک شات,ESP-1",
    "نوشیدنی گرم,کاپوچینو,120000,,CAP-1",
    "نوشیدنی سرد,آیس لاته,140000,,",
    "غذا,پاستا آلفردو,320000,با مرغ گریل,",
  ].join("\r\n");
