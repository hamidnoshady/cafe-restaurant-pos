/**
 * CSV parsing and formatting for CRM import/export.
 *
 * Pure string work, no database, so the awkward parts are unit-testable
 * without fixtures. The awkward parts are real:
 *
 * - **Quoted fields containing commas, quotes and newlines.** A customer named
 *   `شرکت الف، شعبهٔ ۲` breaks a `split(",")` parser, and an address spanning
 *   two lines breaks a line-by-line one. Both appear in real data.
 * - **The BOM.** Excel writes `\uFEFF` at the start of a UTF-8 CSV, and
 *   without stripping it the first column header is never recognised — which
 *   presents to the user as "the file is wrong" when the file is fine.
 * - **Persian digits.** Phone numbers arrive as «۰۹۱۲…». Anything comparing
 *   them to stored data has to normalise first or every row looks new.
 * - **Formula injection on export.** A cell starting `=`, `+`, `-` or `@` is
 *   executed by Excel when the file is opened. A customer name of
 *   `=HYPERLINK(...)` turns our export into an attack on whoever opens it.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian/Arabic-Indic digits to ASCII, leaving everything else alone. */
export function westernDigits(input: string): string {
  let out = "";
  for (const char of input) {
    const p = PERSIAN_DIGITS.indexOf(char);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(char);
    out += a >= 0 ? String(a) : char;
  }
  return out;
}

/**
 * Parse CSV text into rows of cells.
 *
 * A real state machine rather than a regex or a split, because quoting is not
 * expressible in either. Handles `""` as an escaped quote inside a quoted
 * field, bare newlines inside quoted fields, and CRLF.
 */
export function parseCsv(text: string): string[][] {
  // Excel's BOM. Left in place it becomes part of the first header name.
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // "" inside a quoted field is one literal quote.
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  // Whatever is in hand at EOF is a final row, unless the file ended on a
  // newline and there is genuinely nothing left.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // Drop trailing blank lines — a file ending in "\n\n" is not a row of one
  // empty cell, and importing it as a customer named "" is nobody's intent.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Quote one cell for output.
 *
 * The leading apostrophe on formula-looking cells is the important part: Excel
 * evaluates a cell beginning `=`, `+`, `-` or `@`, so an exported customer
 * name of `=cmd|...` runs on the machine of whoever opens the file. Prefixing
 * makes it inert text and is the standard mitigation.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * Render rows as a CSV document.
 *
 * Emits the BOM, because the overwhelmingly common consumer is Excel on
 * Windows, which otherwise reads UTF-8 Persian as mojibake. CRLF for the same
 * reason.
 */
export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * Map a parsed sheet onto named columns.
 *
 * Matching is case-insensitive and whitespace-tolerant, and accepts a set of
 * aliases per field, because the file comes from a human: «تلفن», «موبایل»,
 * `phone` and `Phone ` all mean the same column and rejecting three of them
 * would be pedantry the user experiences as a broken importer.
 */
export function mapHeaders(
  header: readonly string[],
  aliases: Record<string, readonly string[]>,
): Record<string, number> {
  const normalised = header.map((h) => westernDigits(h).trim().toLowerCase());
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const index = normalised.findIndex((h) => names.some((n) => n.toLowerCase() === h));
    if (index >= 0) out[field] = index;
  }
  return out;
}
