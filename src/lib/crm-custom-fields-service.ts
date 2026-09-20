/**
 * Typed custom fields — «فیلدهای دلخواه».
 *
 * ## Why typed, and not a JSON blob
 *
 * The cheap version of this feature is a `jsonb` column on `parties` that the
 * UI renders as key/value text. It takes an afternoon and it is a trap:
 *
 * - **Nothing can filter on it.** «مشتریانی که تاریخ تمدید قراردادشان گذشته»
 *   requires comparing a date to today. Over text, that comparison is either
 *   impossible or a cast — and a cast over user-entered data means one
 *   malformed row turns a segment query into a 500 on somebody else's screen.
 * - **Nothing can validate it.** A «شمارهٔ قرارداد» field that is sometimes
 *   `۱۲۳`, sometimes `123`, and sometimes `قرارداد ۱۲۳` cannot be matched,
 *   grouped or exported usefully.
 * - **Nothing can be renamed.** Once the key is the label, changing the label
 *   orphans every stored value.
 *
 * So a field is a **definition row** with a type, and a value is stored in the
 * canonical `value_text` *plus* a typed shadow column (`value_number`,
 * `value_date`, `value_bool`, `value_list`). The shadow is written by this
 * service after validation, never by a cast inside a query. Segments and
 * reports compare against the shadow; the text is what a human sees and what
 * survives a type change.
 *
 * ## Definitions are archived, never deleted
 *
 * Deleting a field would strand its values: rows that exist, mean something to
 * whoever entered them, and can no longer be explained because the thing that
 * named them is gone. Archiving stops the field being offered while keeping
 * every recorded answer readable.
 */

import { query, withTenantTransaction } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";

export const CUSTOM_FIELD_TARGETS = ["party", "lead", "deal", "case"] as const;
export type CustomFieldTarget = (typeof CUSTOM_FIELD_TARGETS)[number];

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "money",
  "boolean",
  "date",
  "select",
  "multi_select",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "متن",
  number: "عدد",
  money: "مبلغ",
  boolean: "بله / خیر",
  date: "تاریخ",
  select: "انتخاب یکی",
  multi_select: "انتخاب چند مورد",
};

export interface CustomFieldRow extends Record<string, unknown> {
  id: string;
  target: CustomFieldTarget;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  isRequired: boolean;
  helpText: string;
  displayOrder: number;
  archivedAt: string | null;
}

const FIELD_COLUMNS = `id, target, key, label, field_type AS "fieldType", options,
  is_required AS "isRequired", help_text AS "helpText",
  display_order AS "displayOrder", archived_at AS "archivedAt"`;

/**
 * The field definitions for one target.
 *
 * Archived fields are excluded by default because they must not be *offered* —
 * but `includeArchived` exists because a screen rendering a stored value still
 * needs the definition that explains it.
 */
export async function listCustomFields(
  businessId: string,
  target: CustomFieldTarget,
  options: { includeArchived?: boolean } = {},
): Promise<CustomFieldRow[]> {
  const { rows } = await query<CustomFieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM crm_custom_fields
      WHERE business_id = $1 AND target = $2
        ${options.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY display_order, label`,
    [businessId, target],
  );
  return rows.map((row) => ({ ...row, options: normaliseOptions(row.options) }));
}

function normaliseOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export interface SaveCustomFieldInput {
  id?: string;
  target: CustomFieldTarget;
  key?: string;
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  isRequired?: boolean;
  helpText?: string;
  displayOrder?: number;
}

export type SaveCustomFieldResult =
  | { ok: true; field: CustomFieldRow }
  | {
      ok: false;
      error:
        | "not_found"
        | "label_required"
        | "key_invalid"
        | "key_taken"
        | "type_change_blocked"
        | "options_required";
    };

/**
 * A storage key derived from the label, for fields created through the UI.
 *
 * Latin-only and lowercase because the key is an identifier: it appears in CSV
 * headers, API payloads and segment definitions, where a Persian string with
 * RTL marks is a reliable source of encoding bugs. A label of «شمارهٔ قرارداد»
 * therefore produces `field_<n>` rather than a transliteration nobody would
 * recognise — the *label* is what people read; the key just has to be stable
 * and unique.
 */
function deriveKey(label: string, existing: Set<string>): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const base = /^[a-z]/.test(ascii) ? ascii : "";
  if (base && !existing.has(base)) return base;
  let n = 1;
  while (existing.has(`${base || "field"}_${n}`)) n += 1;
  return `${base || "field"}_${n}`;
}

/**
 * Create or update a field definition.
 *
 * **A field's type cannot change once it holds values.** The alternative is
 * reinterpreting stored data: a «متن» field holding «حدود ۵۰۰ هزار» becoming a
 * money field either silently discards that answer or invents a number nobody
 * entered. Archive the field and make a new one — the old answers stay
 * readable and the new ones are honest.
 */
export async function saveCustomField(
  businessId: string,
  input: SaveCustomFieldInput,
  actor: { name: string; userId?: string | null },
): Promise<SaveCustomFieldResult> {
  const label = input.label?.trim();
  if (!label) return { ok: false, error: "label_required" };
  if (!CUSTOM_FIELD_TYPES.includes(input.fieldType)) return { ok: false, error: "key_invalid" };

  const needsOptions = input.fieldType === "select" || input.fieldType === "multi_select";
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (needsOptions && options.length === 0) return { ok: false, error: "options_required" };

  return withTenantTransaction(businessId, async () => {
    if (input.id) {
      if (!isUuid(input.id)) return { ok: false as const, error: "not_found" as const };
      const { rows: existing } = await query<{ field_type: string; key: string }>(
        `SELECT field_type, key FROM crm_custom_fields
          WHERE business_id = $1 AND id = $2 FOR UPDATE`,
        [businessId, input.id],
      );
      if (!existing[0]) return { ok: false as const, error: "not_found" as const };

      if (existing[0].field_type !== input.fieldType) {
        const { rows: used } = await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM crm_custom_field_values
            WHERE business_id = $1 AND field_id = $2`,
          [businessId, input.id],
        );
        if (Number(used[0]?.n ?? 0) > 0) {
          return { ok: false as const, error: "type_change_blocked" as const };
        }
      }

      await query(
        `UPDATE crm_custom_fields
            SET label = $3, field_type = $4, options = $5::jsonb, is_required = $6,
                help_text = $7, display_order = $8, updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          businessId,
          input.id,
          label,
          input.fieldType,
          JSON.stringify(options),
          input.isRequired === true,
          (input.helpText ?? "").trim().slice(0, 300),
          Number.isFinite(input.displayOrder) ? Number(input.displayOrder) : 0,
        ],
      );
      const field = await getCustomField(businessId, input.id);
      return field
        ? { ok: true as const, field }
        : { ok: false as const, error: "not_found" as const };
    }

    const { rows: keyRows } = await query<{ key: string }>(
      `SELECT key FROM crm_custom_fields WHERE business_id = $1 AND target = $2`,
      [businessId, input.target],
    );
    const taken = new Set(keyRows.map((row) => row.key));

    let key = input.key?.trim().toLowerCase() ?? "";
    if (key) {
      if (!/^[a-z][a-z0-9_]{0,48}$/.test(key)) return { ok: false as const, error: "key_invalid" as const };
      if (taken.has(key)) return { ok: false as const, error: "key_taken" as const };
    } else {
      key = deriveKey(label, taken);
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_custom_fields
         (business_id, target, key, label, field_type, options, is_required,
          help_text, display_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING id`,
      [
        businessId,
        input.target,
        key,
        label,
        input.fieldType,
        JSON.stringify(options),
        input.isRequired === true,
        (input.helpText ?? "").trim().slice(0, 300),
        Number.isFinite(input.displayOrder) ? Number(input.displayOrder) : 0,
        actor.name,
      ],
    );

    await recordCrmAudit({
      businessId,
      kind: "custom_field.created",
      entityType: "custom_field",
      entityId: rows[0].id,
      partyId: null,
      summary: `فیلد «${label}» ساخته شد`,
      detail: { target: input.target, key, fieldType: input.fieldType },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    const field = await getCustomField(businessId, rows[0].id);
    return field
      ? { ok: true as const, field }
      : { ok: false as const, error: "not_found" as const };
  });
}

export async function getCustomField(
  businessId: string,
  fieldId: string,
): Promise<CustomFieldRow | null> {
  if (!isUuid(fieldId)) return null;
  const { rows } = await query<CustomFieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM crm_custom_fields WHERE business_id = $1 AND id = $2`,
    [businessId, fieldId],
  );
  const row = rows[0];
  return row ? { ...row, options: normaliseOptions(row.options) } : null;
}

/**
 * Archive a field. Values survive and stay readable; the field stops being
 * offered on forms.
 */
export async function archiveCustomField(
  businessId: string,
  fieldId: string,
  actor: { name: string; userId?: string | null },
): Promise<boolean> {
  if (!isUuid(fieldId)) return false;
  const { rowCount } = await query(
    `UPDATE crm_custom_fields SET archived_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, fieldId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await recordCrmAudit({
    businessId,
    kind: "custom_field.archived",
    entityType: "custom_field",
    entityId: fieldId,
    partyId: null,
    summary: "یک فیلد دلخواه بایگانی شد",
    detail: { fieldId },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface TypedValue {
  text: string;
  number: number | null;
  bool: boolean | null;
  date: string | null;
  list: string[] | null;
}

export type CoerceResult =
  | { ok: true; value: TypedValue }
  | { ok: false; error: "not_a_number" | "not_a_date" | "not_an_option" | "required" };

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/**
 * Persian and Arabic-Indic digits to ASCII.
 *
 * Users type «۱۲۳۴». Postgres does not consider that a number, and neither
 * does `Number()`. Normalising here rather than rejecting is the difference
 * between a field people can use and one that fails on every entry made with
 * a Persian keyboard.
 */
function westernDigits(input: string): string {
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
 * Validate and type one submitted value.
 *
 * Pure and exported: the same rule runs on the server for every write and in
 * the tests without a database. The typed shadows it produces are what gets
 * stored, which is why no query ever needs to cast user input — the cast
 * happens here, once, where a failure is a validation message rather than a
 * 500 on an unrelated screen.
 */
export function coerceCustomValue(
  field: Pick<CustomFieldRow, "fieldType" | "options" | "isRequired">,
  raw: unknown,
): CoerceResult {
  const empty: TypedValue = { text: "", number: null, bool: null, date: null, list: null };

  if (raw === null || raw === undefined || raw === "") {
    if (field.isRequired) return { ok: false, error: "required" };
    return { ok: true, value: empty };
  }

  switch (field.fieldType) {
    case "number":
    case "money": {
      const normalised = westernDigits(String(raw)).replace(/[,٬\s]/g, "");
      const n = Number(normalised);
      if (!Number.isFinite(n)) return { ok: false, error: "not_a_number" };
      // Money is stored as an integer, consistent with every other amount in
      // the system — a fractional Rial does not exist.
      const value = field.fieldType === "money" ? Math.round(n) : n;
      return { ok: true, value: { ...empty, text: String(value), number: value } };
    }
    case "boolean": {
      const truthy = raw === true || raw === "true" || raw === "1" || raw === 1;
      return { ok: true, value: { ...empty, text: truthy ? "true" : "false", bool: truthy } };
    }
    case "date": {
      // ISO only. The UI converts from the Jalali picker before submitting;
      // accepting free text here would mean guessing whether «۰۱/۰۲/۰۳» is a
      // day or a month, and guessing wrong silently.
      const text = westernDigits(String(raw)).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, error: "not_a_date" };
      const parsed = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return { ok: false, error: "not_a_date" };
      // Round-trip check: `2026-02-31` parses to 3 March, which is not what
      // anybody meant and must not be stored as though it were.
      if (parsed.toISOString().slice(0, 10) !== text) return { ok: false, error: "not_a_date" };
      return { ok: true, value: { ...empty, text, date: text } };
    }
    case "select": {
      const text = String(raw).trim();
      if (!field.options.includes(text)) return { ok: false, error: "not_an_option" };
      return { ok: true, value: { ...empty, text, list: [text] } };
    }
    case "multi_select": {
      const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim()).filter(Boolean);
      for (const entry of list) {
        if (!field.options.includes(entry)) return { ok: false, error: "not_an_option" };
      }
      // De-duplicated: the same option twice is not a different answer, and
      // storing it twice would double-count in any grouping.
      const unique = [...new Set(list)];
      return { ok: true, value: { ...empty, text: unique.join("، "), list: unique } };
    }
    default: {
      // Length-capped so one paste of a novel cannot bloat every list query
      // that selects this column.
      const text = String(raw).trim().slice(0, 2000);
      return { ok: true, value: { ...empty, text } };
    }
  }
}

const TARGET_COLUMN: Record<CustomFieldTarget, string> = {
  party: "party_id",
  lead: "lead_id",
  deal: "deal_id",
  case: "case_id",
};

export interface CustomValueRow extends Record<string, unknown> {
  fieldId: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  valueText: string;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: string | null;
  valueList: string[] | null;
}

/** Every custom value recorded against one record, with its definition. */
export async function customValuesFor(
  businessId: string,
  target: CustomFieldTarget,
  recordId: string,
): Promise<CustomValueRow[]> {
  if (!isUuid(recordId)) return [];
  const { rows } = await query<CustomValueRow>(
    // Joined to the definition, and deliberately NOT filtered on archived:
    // a value recorded against a since-archived field is still a fact somebody
    // entered, and hiding it would make the record silently incomplete.
    `SELECT v.field_id AS "fieldId", f.key, f.label, f.field_type AS "fieldType",
            v.value_text AS "valueText", v.value_number AS "valueNumber",
            v.value_bool AS "valueBool", v.value_date::text AS "valueDate",
            v.value_list AS "valueList"
       FROM crm_custom_field_values v
       JOIN crm_custom_fields f ON f.id = v.field_id
      WHERE v.business_id = $1 AND v.${TARGET_COLUMN[target]} = $2
      ORDER BY f.display_order, f.label`,
    [businessId, recordId],
  );
  return rows;
}

export type SetCustomValuesResult =
  | { ok: true; written: number }
  | { ok: false; error: "field_not_found" | "invalid"; failures?: { key: string; error: string }[] };

/**
 * Write a set of custom values for one record.
 *
 * All-or-nothing, in one transaction. A partial write would leave a record
 * half-updated with no indication of which half — and since a required field
 * may be among the rejects, the caller needs to see every failure at once
 * rather than discovering them one round trip at a time.
 */
export async function setCustomValues(
  businessId: string,
  target: CustomFieldTarget,
  recordId: string,
  values: Record<string, unknown>,
  actor: { name: string },
): Promise<SetCustomValuesResult> {
  if (!isUuid(recordId)) return { ok: false, error: "field_not_found" };

  const fields = await listCustomFields(businessId, target);
  const byKey = new Map(fields.map((field) => [field.key, field]));

  const coerced: { field: CustomFieldRow; value: TypedValue }[] = [];
  const failures: { key: string; error: string }[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const field = byKey.get(key);
    // An unknown key is ignored rather than fatal: an older browser tab
    // submitting a field that has since been archived should not block the
    // rest of the form.
    if (!field) continue;
    const result = coerceCustomValue(field, raw);
    if (!result.ok) failures.push({ key, error: result.error });
    else coerced.push({ field, value: result.value });
  }

  // Required fields never submitted at all are as much a failure as ones
  // submitted empty; checking only what arrived would let an omitted key pass.
  for (const field of fields) {
    if (!field.isRequired) continue;
    if (Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    failures.push({ key: field.key, error: "required" });
  }

  if (failures.length > 0) return { ok: false, error: "invalid", failures };

  return withTenantTransaction(businessId, async () => {
    for (const { field, value } of coerced) {
      await query(
        `INSERT INTO crm_custom_field_values
           (business_id, field_id, ${TARGET_COLUMN[target]}, value_text, value_number,
            value_bool, value_date, value_list, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         -- The uniqueness guarantee is a *partial* index (one per target
         -- column, each WHERE that column IS NOT NULL), so the predicate has
         -- to be repeated here for Postgres to match the arbiter.
         ON CONFLICT (field_id, ${TARGET_COLUMN[target]})
           WHERE ${TARGET_COLUMN[target]} IS NOT NULL
           DO UPDATE
           SET value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number,
               value_bool = EXCLUDED.value_bool, value_date = EXCLUDED.value_date,
               value_list = EXCLUDED.value_list, updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [
          businessId,
          field.id,
          recordId,
          value.text,
          value.number,
          value.bool,
          value.date,
          value.list,
          actor.name,
        ],
      );
    }
    return { ok: true as const, written: coerced.length };
  });
}
