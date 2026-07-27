/**
 * Menu import — parses CSV (or rows extracted from Excel) into items ready
 * for insertion. The onboarding wizard uses its basic columns; Settings also
 * accepts tax and modifier columns for a full operational import.
 */
import { toLatinDigits } from "./digits";
import { tomanToRial, type Rial } from "./money";

export interface ImportedModifier {
  name: string;
  /** stored unit: Rial */
  priceDelta: Rial;
}

export interface ImportedItem {
  category: string;
  name: string;
  /** stored unit: Rial */
  price: Rial;
  description?: string;
  sku?: string;
  /** percent, per category (0–100) */
  taxRate?: number;
  modifierGroup?: string;
  modifierMinSelect?: number;
  modifierMaxSelect?: number;
  modifiers?: ImportedModifier[];
}

export interface ImportResult {
  items: ImportedItem[];
  categories: string[];
  /** Persian, row-numbered messages for rows that were skipped */
  errors: string[];
}

interface RawRow {
  category?: string;
  name?: string;
  price?: string;
  description?: string;
  sku?: string;
  taxRate?: string;
  modifierGroup?: string;
  modifierMinSelect?: string;
  modifierMaxSelect?: string;
  modifiers?: string;
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
  tax: "taxRate",
  "tax rate": "taxRate",
  "مالیات": "taxRate",
  "نرخ مالیات": "taxRate",
  "درصد مالیات": "taxRate",
  "گروه افزودنی": "modifierGroup",
  "افزودنی گروه": "modifierGroup",
  "modifier group": "modifierGroup",
  "حداقل انتخاب": "modifierMinSelect",
  "minimum selection": "modifierMinSelect",
  "min select": "modifierMinSelect",
  "حداکثر انتخاب": "modifierMaxSelect",
  "maximum selection": "modifierMaxSelect",
  "max select": "modifierMaxSelect",
  "افزودنی‌ها": "modifiers",
  "افزودنی ها": "modifiers",
  modifiers: "modifiers",
};

/** Split CSV text into rows of fields. Handles quotes, CRLF, BOM, and , ; or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const delimiter = [",", ";", "\t"]
    .map((item) => ({ item, count: firstLine.split(item).length }))
    .sort((a, b) => b.count - a.count)[0].item;

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
    if (row.some((item) => item.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < src.length; index++) {
    const char = src[index];
    if (inQuotes) {
      if (char === '"') {
        if (src[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function mapHeader(cells: string[]): (keyof RawRow | null)[] {
  return cells.map((cell) => {
    const header = cell.trim();
    return HEADER_ALIASES[header.toLowerCase()] ?? HEADER_ALIASES[header] ?? null;
  });
}

/** Parse a price in Toman (Persian/Latin digits, separators) → integer Rial. */
export function parsePriceToman(input: string): Rial | null {
  const cleaned = toLatinDigits(String(input)).replace(/[٬,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) return null;
  return tomanToRial(value);
}

function parseTaxRate(input: string): number | null {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "").replace("٫", ".");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function parseSelection(input: string): number | null {
  const cleaned = toLatinDigits(input).replace(/[٬,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

function parseModifiers(input: string): ImportedModifier[] | null {
  const entries = input.split(/[|؛;]/).map((item) => item.trim()).filter(Boolean);
  const modifiers: ImportedModifier[] = [];
  for (const entry of entries) {
    const separator = Math.max(entry.lastIndexOf(":"), entry.lastIndexOf("："));
    if (separator < 1) return null;
    const name = entry.slice(0, separator).trim();
    const priceDelta = parsePriceToman(entry.slice(separator + 1));
    if (!name || priceDelta === null) return null;
    modifiers.push({ name, priceDelta });
  }
  return modifiers;
}

/** Turn raw rows (first row = header) into validated import items. */
export function rowsToImport(rows: string[][]): ImportResult {
  const errors: string[] = [];
  if (rows.length === 0) return { items: [], categories: [], errors: ["فایل خالی است."] };

  const header = mapHeader(rows[0]);
  if (!header.includes("category") || !header.includes("name") || !header.includes("price")) {
    return { items: [], categories: [], errors: ["ستون‌های الزامی پیدا نشد. سطر اول باید شامل «دسته»، «نام» و «قیمت» باشد."] };
  }

  const items: ImportedItem[] = [];
  const categories: string[] = [];
  const seenCategories = new Set<string>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const raw: RawRow = {};
    rows[rowIndex].forEach((cell, column) => {
      const key = header[column];
      if (key) raw[key] = cell.trim();
    });
    const rowNo = rowIndex + 1;
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
    let taxRate: number | undefined;
    if (raw.taxRate) {
      const parsedTaxRate = parseTaxRate(raw.taxRate);
      if (parsedTaxRate === null) {
        errors.push(`سطر ${rowNo}: نرخ مالیات معتبر نیست.`);
        continue;
      }
      taxRate = parsedTaxRate;
    }
    if (raw.modifiers && !raw.modifierGroup) {
      errors.push(`سطر ${rowNo}: برای افزودنی‌ها نام گروه افزودنی لازم است.`);
      continue;
    }
    const modifiers = raw.modifiers ? parseModifiers(raw.modifiers) : undefined;
    if (raw.modifiers && modifiers === null) {
      errors.push(`سطر ${rowNo}: قالب افزودنی‌ها معتبر نیست. از «نام:مبلغ | نام:مبلغ» استفاده کنید.`);
      continue;
    }
    const minSelect = raw.modifierMinSelect ? parseSelection(raw.modifierMinSelect) : undefined;
    const maxSelect = raw.modifierMaxSelect ? parseSelection(raw.modifierMaxSelect) : undefined;
    if ((raw.modifierMinSelect && minSelect === null) || (raw.modifierMaxSelect && maxSelect === null)) {
      errors.push(`سطر ${rowNo}: حداقل و حداکثر انتخاب باید عدد صحیح باشند.`);
      continue;
    }
    const resolvedMin = minSelect ?? 0;
    const resolvedMax = maxSelect ?? Math.max(1, modifiers?.length ?? 1);
    if (raw.modifierGroup && (resolvedMin > resolvedMax || resolvedMax < 1)) {
      errors.push(`سطر ${rowNo}: محدودهٔ انتخاب افزودنی معتبر نیست.`);
      continue;
    }

    if (!seenCategories.has(raw.category)) {
      seenCategories.add(raw.category);
      categories.push(raw.category);
    }
    const item: ImportedItem = { category: raw.category, name: raw.name, price };
    if (raw.description) item.description = raw.description;
    if (raw.sku) item.sku = raw.sku;
    if (taxRate !== undefined) item.taxRate = taxRate;
    if (raw.modifierGroup) {
      item.modifierGroup = raw.modifierGroup;
      item.modifierMinSelect = resolvedMin;
      item.modifierMaxSelect = resolvedMax;
      if (modifiers) item.modifiers = modifiers;
    }
    items.push(item);
  }
  return { items, categories, errors };
}

export function parseMenuCsv(text: string): ImportResult {
  return rowsToImport(parseCsv(text));
}

/** Basic sample offered by the onboarding wizard. */
export const SAMPLE_CSV = "\uFEFF" + [
  "دسته,نام,قیمت,توضیحات,کد",
  "نوشیدنی گرم,اسپرسو,85000,تک شات,ESP-1",
  "نوشیدنی گرم,کاپوچینو,120000,,CAP-1",
  "نوشیدنی سرد,آیس لاته,140000,,",
  "غذا,پاستا آلفردو,320000,با مرغ گریل,",
].join("\r\n");

/** Extended sample offered by Settings. Price columns are all in Toman. */
export const SETTINGS_SAMPLE_CSV = "\uFEFF" + [
  "دسته,نام,قیمت,توضیحات,کد,مالیات,گروه افزودنی,حداقل انتخاب,حداکثر انتخاب,افزودنی‌ها",
  "نوشیدنی گرم,لاته,140000,دو شات,LT-1,10,نوع شیر,1,1,شیر معمولی:0 | شیر بادام:25000 | شیر سویا:20000",
  "نوشیدنی گرم,کاپوچینو,135000,,CAP-1,10,,,,",
  "صبحانه,املت,180000,با نان تازه,OML-1,0,افزودنی صبحانه,0,2,پنیر:30000 | قارچ:25000",
].join("\r\n");
